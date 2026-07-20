// src/carplay/carActions.ts
//
// CarPlay-standalone Wave 3 — the head unit's own ACTIONS, fully headless
// (module scope, no React, works when the phone app was never opened):
//
//   • Destination SEARCH from the car (CPSearchTemplate → Google Places v1 →
//     fetchRoutes → cold nav start through the Wave-2 banner/voice engine)
//   • ONE-TAP police report at the driver's position (Jeff's call: instant,
//     Waze-style — no confirm sheet) + hazard-style "Reported ✓" toast
//   • End route from the car
//
// SURFACE CHOICE (deep-dive verified): buttons drawn on the app's own map
// WINDOW never receive taps (CarPlay doesn't deliver touches to the app-drawn
// base view), and the round CPMapButtons don't render on this app's head unit
// (covered by the RN surface — native fix queued for the next build). But the
// map template's NAVIGATION-BAR chrome demonstrably renders (the iOS-26 crash
// happened while CarPlay drew its own nav-bar share button), and bar buttons
// are wired end-to-end in the installed react-native-carplay (barButtonPressed
// → onBarButtonPressed). So Wave 3 rides nav-bar buttons + pushed templates —
// native template UI that CarPlay itself renders and taps.
//
// Phone hand-off: when a route is started from the car, we persist
// { dest, startedAt } under CAR_NAV_KEY (navNotification owns the key; its
// stopNavBanner clears it) and emit onCarNavStarted — map.tsx adopts the
// session either live (bus, phone open) or on next open (persisted key).

import { api, GOOGLE_MAPS_KEY } from '../api';
import { getSettings } from '../settings';
import { fetchRoutes, type NavRoute } from '../nav';
import { startNavBanner, stopNavBanner, CAR_NAV_KEY } from '../navNotification';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { getCarState, setCarState, setCarHazards, subscribeCarState, emitCarGesture } from './carStore';
import { CAR_ICON_POLICE, CAR_ICON_MIC, CAR_ICON_BLANK, CAR_ICON_HOME, CAR_ICON_WORK, CAR_ICON_SAVED } from './carButtonIcons';
import { ensureSavedPlacesLoaded, getSavedPlaces, type SavedPlace } from '../savedPlaces';

// ── lazy react-native-carplay access (same guard style as carPlayBootstrap) ──
function getLib(): any | null {
  if (Platform.OS !== 'ios') return null;
  if (!(NativeModules as any).RNCarPlay) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-carplay');
  } catch {
    return null;
  }
}

// Visible confirmation on the head unit.
//
// WAS: `CarPlay.bridge.toast(msg, 2.5)` — a method that DOES NOT EXIST ON iOS.
// `toast` is declared in the library's TypeScript surface and implemented ONLY
// in the Android CarPlayModule (grep: ZERO occurrences in ios/RNCarPlay.m), and
// the `?.` + try/catch swallowed the miss silently. Every confirmation below was
// therefore dropped on the floor, which made a WORKING nav-bar button
// indistinguishable from a dead one — the actual root of the long-running
// "CarPlay is completely touch-inert" report (deep-dive 2026-07-19). getLib()
// also returns null off-iOS, so this was dead on BOTH platforms.
//
// NOW: CPAlertTemplate — real native template UI that CarPlay itself renders and
// taps (RNCarPlay.m:394 builds it, :603 presentTemplate, :616 dismissTemplate,
// :1333 emits alertActionPressed). This restores feedback for every call site AND
// doubles as an HONEST probe that the interfaceController/template layer is alive
// (the old toast-based probe could never have fired on iOS).
// NOTE: RCTTiming pauses setTimeout while the phone is locked, so the auto-dismiss
// may not fire cold — the OK action is the always-available way out.
let _alertTimer: any = null;
export function carAlert(msg: string): void {
  const lib = getLib();
  if (!lib) return;
  const CarPlay = lib.CarPlay, AlertTemplate = lib.AlertTemplate;
  if (!CarPlay?.presentTemplate || !AlertTemplate) return;
  try {
    // Never stack alerts — dismiss any in-flight one first.
    if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; try { CarPlay.dismissTemplate(false); } catch {} }
    const alert = new AlertTemplate({
      titleVariants: [msg],
      actions: [{ id: 'ok', title: 'OK' }],
      onActionButtonPressed: () => {
        if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
        try { CarPlay.dismissTemplate(true); } catch {}
      },
    });
    CarPlay.presentTemplate(alert, true);
    _alertTimer = setTimeout(() => { _alertTimer = null; try { CarPlay.dismissTemplate(true); } catch {} }, 2600);
  } catch {}
}
// Back-compat alias for this file's existing confirmation call sites.
const toast = carAlert;

// ── 5s-ago position ring buffer (parity with the phone's getPos5SecAgo) ─────
// The phone anchors police pins ~5s behind the car (you report what you just
// passed). Headless has no posHistoryRef, so keep a tiny ring off carStore
// position ticks. Falls back to the live fix when history is thin.
const POS_RING_MAX = 12;
const _posRing: { lat: number; lng: number; ts: number }[] = [];
let _ringArmed = false;
function armPosRing(): void {
  if (_ringArmed) return;
  _ringArmed = true;
  let lastLat: number | null = null;
  let lastLng: number | null = null;
  subscribeCarState((s) => {
    if (typeof s.selfLat !== 'number' || typeof s.selfLng !== 'number') return;
    if (s.selfLat === lastLat && s.selfLng === lastLng) return;
    lastLat = s.selfLat; lastLng = s.selfLng;
    _posRing.push({ lat: s.selfLat, lng: s.selfLng, ts: Date.now() });
    if (_posRing.length > POS_RING_MAX) _posRing.shift();
  });
}
function pos5SecAgo(): { lat: number; lng: number } | null {
  const s = getCarState();
  const live = typeof s.selfLat === 'number' && typeof s.selfLng === 'number'
    ? { lat: s.selfLat, lng: s.selfLng } : null;
  if (!_posRing.length) return live;
  const target = Date.now() - 5000;
  return _posRing.reduce((best, p) =>
    Math.abs(p.ts - target) < Math.abs(best.ts - target) ? p : best);
}

// ── one-tap police report ────────────────────────────────────────────────────
// Exactly the phone's reportAlert('police') wire call: POST /hazards with
// kind/lat/lng/note. reporter_handle + expires_at are SERVER-derived from the
// bearer token (api's interceptor reads getToken() headlessly), and the backend
// fans the new hazard out to every driver (WS + Supabase Realtime) — receivers
// can't tell a car report from a phone report. No client-side cooldown (phone
// has none either); id-dedupe on the receive side absorbs our own echo.
let _reportInFlight = false;
export async function reportPoliceFromCar(): Promise<void> {
  if (_reportInFlight) return; // debounce a double-tap while the POST runs
  const pos = pos5SecAgo();
  if (!pos) { toast('No GPS fix yet'); return; }
  _reportInFlight = true;
  try {
    const { data } = await api.post('/hazards', { kind: 'police', lat: pos.lat, lng: pos.lng, note: '' });
    // Optimistic pin on the car map (same id-dedupe the phone applies). Goes
    // through the 'service' gate — if the phone mirror is live it will echo the
    // same hazard via WS within a beat anyway.
    if (data && data.id) {
      const cur = getCarState().hazards || [];
      if (!cur.some((h) => h.id === data.id)) {
        setCarHazards([{ id: data.id, kind: data.kind || 'police', lat: data.lat, lng: data.lng, confirms: data.confirms, disputes: data.disputes }, ...cur], 'service');
      }
    }
    toast('Police reported ✓');
  } catch {
    toast('Report failed — no connection');
  } finally {
    _reportInFlight = false;
  }
}

// ── destination search (Google Places API v1 — the New API; the legacy
//    place/* endpoints REQUEST_DENIED on this key) ──────────────────────────
type CarSearchResult = { placeId: string; description: string };
let _lastResults: CarSearchResult[] = [];

async function placesAutocomplete(input: string): Promise<CarSearchResult[]> {
  const s = getCarState();
  const body: any = { input };
  if (typeof s.selfLat === 'number' && typeof s.selfLng === 'number') {
    body.locationBias = { circle: { center: { latitude: s.selfLat, longitude: s.selfLng }, radius: 50000.0 } };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.suggestions || [])
    .filter((x: any) => x.placePrediction)
    .slice(0, 8)
    .map((x: any) => ({ placeId: x.placePrediction.placeId, description: x.placePrediction.text?.text ?? '' }))
    .filter((x: CarSearchResult) => x.placeId && x.description);
}

async function placeDetails(placeId: string): Promise<{ lat: number; lng: number; label?: string } | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,displayName,formattedAddress' },
  });
  const data = await res.json();
  if (typeof data?.location?.latitude !== 'number') return null;
  return { lat: data.location.latitude, lng: data.location.longitude, label: data.displayName?.text || data.formattedAddress || undefined };
}

// ── start / end navigation from the car ──────────────────────────────────────
// startCarNav drives the ENTIRE Wave-2 cold engine: fetchRoutes headless →
// fastest route → startNavBanner (persists the slim route + polyline, arms the
// bg-location TBT tick → car banner, ETA, Nova voice) → carStore so the ribbon
// draws immediately. The phone adopts via CAR_NAV_KEY / the bus below.
type CarNavListener = (e: { dest: { lat: number; lng: number; label?: string } }) => void;
const _navListeners = new Set<CarNavListener>();
export function onCarNavStarted(fn: CarNavListener): () => void {
  _navListeners.add(fn);
  return () => { _navListeners.delete(fn); };
}

let _navStartInFlight = false;
export async function startCarNav(dest: { lat: number; lng: number; label?: string }): Promise<boolean> {
  if (_navStartInFlight) return false;
  const s = getCarState();
  if (typeof s.selfLat !== 'number' || typeof s.selfLng !== 'number') { toast('No GPS fix yet'); return false; }
  _navStartInFlight = true;
  try {
    const st = getSettings();
    const routes = await fetchRoutes(
      { lat: s.selfLat, lng: s.selfLng },
      { lat: dest.lat, lng: dest.lng },
      { tolls: st.avoidTolls, highways: st.avoidHighways, ferries: st.avoidFerries },
    );
    if (!routes.length) { toast('No route found'); return false; }
    // Fastest first — same traffic-aware ordering the phone applies.
    routes.sort((a, b) => (a.duration_in_traffic_s ?? a.duration_s) - (b.duration_in_traffic_s ?? b.duration_s));
    const best: NavRoute = routes[0];
    // Persist the hand-off BEFORE starting the banner so a crash between the two
    // can't leave guidance running with no adoptable session.
    try { await AsyncStorage.setItem(CAR_NAV_KEY, JSON.stringify({ dest, startedAt: Date.now() })); } catch {}
    await startNavBanner(best, dest.label);
    // Immediate car-map state (startNavBanner already wrote routePolyline; add
    // the rest so the first frame after the tap is fully dressed).
    setCarState({
      navigating: true,
      destinationLabel: dest.label || '',
      routePolyline: best.polyline || '',
      routeCoordinates: (best as any).coordinates || undefined,
      routeCongestion: (best as any).congestion || undefined,
      routes: [],
    });
    _navListeners.forEach((l) => { try { l({ dest }); } catch {} });
    toast(dest.label ? `Routing to ${dest.label}` : 'Route started');
    return true;
  } catch {
    toast('Routing failed');
    return false;
  } finally {
    _navStartInFlight = false;
  }
}

export async function endCarNav(): Promise<void> {
  if (!getCarState().navigating) { toast('No active route'); return; }
  try { await stopNavBanner(); } catch {} // also clears CAR_NAV_KEY (owner: navNotification)
  setCarState({
    navigating: false,
    routePolyline: '',
    instruction: '',
    distanceToTurn: '',
    distanceToTurnM: 0,
    eta: '',
    distanceRemaining: '',
    distanceRemainingM: 0,
    etaSeconds: 0,
    destinationLabel: '',
    maneuverIcon: undefined,
    routeCoordinates: undefined,
    routeCongestion: undefined,
    routes: [],
  });
  toast('Route ended');
}

// ── the CarPlay Search template (pushed from the map's nav-bar button) ──────
let _searchTemplate: any | null = null;
// Which list the search template is currently showing. onItemSelect gets only an
// INDEX, so without this the driver tapping "Home" would open whatever Places result
// happened to sit at index 0.
let _listMode: 'saved' | 'results' = 'saved';
let _savedShown: SavedPlace[] = [];

// Home first, then Work, then custom places newest-first — the phone's own ordering.
function savedPlaceRows(): { text: string; detailText?: string; image: unknown }[] {
  const rank = (k: SavedPlace['kind']) => (k === 'home' ? 0 : k === 'work' ? 1 : 2);
  _savedShown = getSavedPlaces()
    .slice()
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt);
  return _savedShown.map((p) => ({
    text: p.label,
    detailText: p.address || undefined,
    image: p.kind === 'home' ? CAR_ICON_HOME : p.kind === 'work' ? CAR_ICON_WORK : CAR_ICON_SAVED,
  }));
}
function getSearchTemplate(): any | null {
  if (_searchTemplate) return _searchTemplate;
  const lib = getLib();
  if (!lib?.SearchTemplate) return null;
  try {
    _searchTemplate = new lib.SearchTemplate({
      id: 'convoy-car-search',
      // Called per keystroke; return ListItem[] to render. (CarPlay only offers
      // the keyboard while parked — an OS rule, same as Waze.)
      // EMPTY QUERY -> the driver's SAVED PLACES, so the search screen is useful the
      // moment it opens instead of an empty list behind a keyboard. Same rows and the
      // same Ionicons the phone's search screen shows (NavSearchScreen.tsx), and
      // savedPlaces is AsyncStorage-backed so this works on a COLD connect too.
      onSearch: async (query: string) => {
        const q = (query || '').trim();
        if (q.length < 2) {
          _listMode = 'saved';
          try { await ensureSavedPlacesLoaded(); } catch {}
          return savedPlaceRows();
        }
        _listMode = 'results';
        try {
          _lastResults = await placesAutocomplete(q);
        } catch {
          _lastResults = [];
        }
        return _lastResults.map((r) => ({ text: r.description }));
      },
      onItemSelect: async ({ index }: { index: number }) => {
        // The list is EITHER saved places or Places results — index means different
        // things in each, so route on the mode the last onSearch left behind.
        if (_listMode === 'saved') {
          const p = _savedShown[index];
          if (!p) return;
          const ok = await startCarNav({ lat: p.lat, lng: p.lng, label: p.label });
          if (ok) { try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {} }
          return;
        }
        const picked = _lastResults[index];
        if (!picked) return;
        const dest = await placeDetails(picked.placeId).catch(() => null);
        if (!dest) { toast('Could not load that place'); return; }
        const ok = await startCarNav({ ...dest, label: dest.label || picked.description });
        if (ok) {
          try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
        }
      },
      onSearchButtonPressed: () => {},
    });
  } catch {
    _searchTemplate = null;
  }
  return _searchTemplate;
}

// ── nav-bar buttons shared by BOTH map roots (cold idle + warm) ─────────────
// automaticallyHidesNavigationBar:false keeps them visible; text buttons need
// no image assets on the head unit.
export const CAR_BAR_BUTTON_CONFIG = {
  automaticallyHidesNavigationBar: false,
  // Nav bar is TRAILING-ONLY (2026-07-20). Police moved OFF the nav bar to a round
  // map button (it is a one-tap driving action, so it belongs under the thumb, not
  // in the chrome), and Search took its place — which also empties the leading side
  // so the top-left of the car screen is free for our own Scout mic + compass.
  leadingNavigationBarButtons: [],
  trailingNavigationBarButtons: [
    { id: 'car-search', type: 'text' as const, title: 'Search' },
    { id: 'car-end', type: 'text' as const, title: 'End' },
  ],
};

// ── Round CPMapButtons — POLICE + SCOUT MIC, in OUR artwork ──────────────────
// SHARED BY BOTH ROOTS (cold idle + warm). They used to declare different button
// sets with different ids, which is how "the mic works but the others don't"
// bugs kept appearing — one source of truth now.
//
// 2026-07-20 changes:
//  • Zoom ± REMOVED. They occupied two of the (max 4) map-button slots on the
//    right edge, crowding our own nav stack, and the head unit reported them as
//    doing nothing. Pinch-to-zoom still works via the CPMapTemplate zoom gesture
//    (onDidBegin/Update/EndZoomGesture -> the gesture bus), which is unaffected.
//  • Police PROMOTED from the nav bar to a round map button (one-tap driving
//    action), and both glyphs are now OUR OWN artwork instead of SF Symbols.
//
// The `systemImage` key (our build-65 native patch) is deliberately NOT used
// here: it takes precedence over `image` in RCTConvert+RNCarPlay.m, so leaving it
// in would mask our art. See carButtonIcons.ts for why a data URI is bridge-free
// and OTA-able.
export const CAR_MAP_BUTTON_CONFIG = {
  mapButtons: [
    { id: 'car-police', image: CAR_ICON_POLICE, focusedImage: CAR_ICON_POLICE },
    { id: 'car-mic', image: CAR_ICON_MIC, focusedImage: CAR_ICON_MIC },
    // ── INVISIBLE LAYOUT SPACERS (2026-07-20, sim-verified) ──────────────────
    // CarPlay renders mapButtons at the "trailing BOTTOM corner" and stacks them
    // UPWARD (CPMapTemplate.h:71-75), so it is the LAST entries that own the
    // bottom-right — exactly where our ETA + maneuver banner live. Dropping from
    // 4 buttons to 2 therefore moved police/mic DOWN onto the banner rather than
    // leaving them where zoom +/- used to sit.
    //
    // There is no position API (CPMapButton has only image/focusedImage/enabled/
    // hidden), so the only lever is WHICH SLOT a button occupies. These two
    // fully-transparent, disabled buttons hold the bottom two slots and lift the
    // real pair back into the upper ones.
    //
    // `hidden: true` does NOT work — sim-verified, the buttons still drew (all
    // four glyphs visible). A transparent image does, because CarPlay draws no
    // circular chrome of its own: only the glyph. `disabled` stops the dead slot
    // from swallowing a tap as a no-op press.
    //
    // 4 is the documented MAXIMUM (extra entries are ignored), so 2 real + 2
    // spacers is the highest the real buttons can possibly sit. Bonus: in panning
    // mode the system hides map buttons "beginning from the END of the array"
    // (CPMapTemplate.h:135-137) — i.e. it drops the spacers first and keeps
    // police + mic. Keep the spacers LAST.
    { id: 'car-spacer-1', image: CAR_ICON_BLANK, focusedImage: CAR_ICON_BLANK, disabled: true },
    { id: 'car-spacer-2', image: CAR_ICON_BLANK, focusedImage: CAR_ICON_BLANK, disabled: true },
  ],
};

// Map-button handler for the COLD root (no phone app in the foreground). The warm
// root intercepts these same ids first and routes them to its live refs; anything
// it does not claim falls through to here, so the two roots behave identically.
export function handleCarMapButton(id: string): void {
  if (id === 'car-police') { armPosRing(); void reportPoliceFromCar(); return; }
  if (id === 'car-mic') {
    // Same bus event the RN-surface experiment used — map.tsx already
    // subscribes and toggles the Scout voice agent.
    emitCarGesture({ kind: 'scoutMic' });
    return;
  }
}

export function handleCarBarButton(id: string): void {
  armPosRing(); // idempotent — make sure the 5s-ago buffer is running
  // 'car-police' is no longer a NAV-BAR button (it moved to a round map button in
  // CAR_MAP_BUTTON_CONFIG), but keep the branch: an older cached template on a
  // head unit can still deliver it, and dropping it would silently no-op.
  if (id === 'car-police') { void reportPoliceFromCar(); return; }
  if (id === 'car-end') { void endCarNav(); return; }
  if (id === 'car-search') {
    // Prime the cache BEFORE the template appears — the first updatedSearchText can
    // arrive before an await would have resolved.
    void ensureSavedPlacesLoaded().catch(() => {});
    const t = getSearchTemplate();
    if (!t) return;
    try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch {}
  }
}

// Arm the position ring at module load (cheap; subscription only buffers).
armPosRing();
