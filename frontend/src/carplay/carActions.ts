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
import { getDepartureBearing, orderRoutesForward } from '../departureBearing';
import { CAR_ICON_MIC, CAR_ICON_CREW, CAR_ICON_COMPASS, CAR_ICON_HOME, CAR_ICON_WORK, CAR_ICON_SAVED } from './carButtonIcons';
import { toggleCarComms } from './carComms';
import { logEvent } from '../crashBreadcrumb';
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
    // Dismissal must NOT depend on setTimeout alone. iOS suspends JS timers while
    // the phone is locked — a phone in a mount — so the 2600ms fallback below
    // provably never fires on a drive, and a presented alert then covers the map
    // and kills every CarPlay button for the rest of the trip (root-caused
    // 2026-07-24 in the CarPlay sim: the control run logged "Requesting present
    // template <CPAlertTemplate>" and only dismissed because the sim was
    // foregrounded and unlocked). carStore position ticks keep flowing when locked
    // — that is what the background location feed exists for — so they, not a
    // timer, are the reliable clock here. Nothing calls carAlert today; this makes
    // it safe to call again.
    const deadline = Date.now() + 2600;
    const off = subscribeCarState(() => {
      if (Date.now() < deadline) return;
      try { off(); } catch {}
      if (_alertTimer) { clearTimeout(_alertTimer); _alertTimer = null; }
      try { CarPlay.dismissTemplate(true); } catch {}
    });
    _alertTimer = setTimeout(() => {
      _alertTimer = null;
      try { off(); } catch {}
      try { CarPlay.dismissTemplate(true); } catch {}
    }, 2600);
  } catch {}
}
// ── ROUTINE FEEDBACK IS NON-BLOCKING (2026-07-24) ────────────────────────────
// `toast()` used to be carAlert -> CPAlertTemplate -> CarPlay.presentTemplate, i.e.
// a MODAL over the map. Two consequences, both fatal to a driver:
//   • a presented template makes EVERY map button unreachable by design, and
//   • carAlert's auto-dismiss is a setTimeout — and iOS PAUSES JS TIMERS WHILE THE
//     PHONE IS LOCKED, which is exactly the state a phone is in while driving.
// So one tap that produced any message (e.g. the comms mic returning "Allow the
// microphone on your phone first") left a modal on screen that could not time out,
// and every CarPlay button went dead until the phone was unlocked. That is Jeff's
// "THE CARPLAY BUTTONS WERE NOT WORKING AGAIN" on 2026-07-24 — and it violated the
// rule written into CARPLAY.md the same morning.
// Routine feedback now goes to the car surface's own status pill: never covers a
// button, and it expires by TIMESTAMP COMPARISON at render, so a paused timer
// cannot strand it. carAlert is kept for genuine decisions only (nothing uses it
// today) — never for informational messages.
const TOAST_MS = 3000;
function toast(msg: string): void {
  try { setCarState({ carToast: msg, carToastUntil: Date.now() + TOAST_MS }); } catch {}
}

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
    // FOUR-SURFACE PARITY (2026-07-30). This is the route start for a search made on
    // CarPlay AND on Android Auto, and it used to sort on ETA alone while the phone
    // had already learned to prefer a route that departs the way the car is pointing.
    // Same destination, same car, but a U-turn from the head unit and not from the
    // phone. One shared ranker now, so they cannot drift apart again — see
    // src/departureBearing.ts for why the Directions `bearings` parameter is NOT the
    // fix. Falls back to plain fastest-first when the facing is unknown.
    const facing = await getDepartureBearing();
    const ordered = orderRoutesForward(routes, facing ?? undefined);
    const best: NavRoute = ordered[0];
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
// Is the search template currently on top of the CarPlay stack? Tracked via the
// template's own didAppear/didDisappear so it survives a system-back cancel too.
// Two jobs: (a) refuse a DOUBLE-PUSH — pushing the same memoised template instance
// that is already on the interface-controller stack corrupts CarPlay's navigation
// stack, which is exactly the "keyboard up, nothing touchable, no buttons work"
// freeze Jeff hit; (b) let the motion watcher know when to auto-dismiss.
let _searchPresented = false;
// Auto-dismiss search the moment the car is genuinely MOVING. CarPlay gates the
// keyboard by drive-state, so a pushed search template while driving is a dead
// modal that hides the map's own buttons — the driver is trapped and the HUD
// looks frozen (Jeff, 2026-07-24: "when i stopped the keyboard popped up and
// nothing was touchable ... none of the carplay buttons were working"). Popping
// to the map root returns every button to life. You search parked; you drive on
// the map. 2.5 m/s ≈ 9 km/h clears creep/GPS-jitter; require it sustained one tick
// so a single stationary blip can't yank a parked search away.
const _SEARCH_POP_SPEED_MS = 2.5;
let _searchMotionArmed = false;
let _movingTicks = 0;
function armSearchAutoDismiss(): void {
  if (_searchMotionArmed) return;
  _searchMotionArmed = true;
  subscribeCarState((st) => {
    if (!_searchPresented) { _movingTicks = 0; return; }
    if ((st.speedMs || 0) > _SEARCH_POP_SPEED_MS) {
      _movingTicks += 1;
      if (_movingTicks >= 2) {                 // ~2 position ticks of real motion
        _movingTicks = 0;
        try { getLib()?.CarPlay?.popToRootTemplate?.(true); } catch {}
        // _searchPresented flips false from the template's didDisappear.
      }
    } else {
      _movingTicks = 0;
    }
  });
}
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
      onDidAppear: () => { _searchPresented = true; _movingTicks = 0; },
      onDidDisappear: () => { _searchPresented = false; _movingTicks = 0; },
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
  // TOP-LEFT: the crew-comms mic (tap-to-toggle transmit — carComms.ts). An IMAGE
  // bar button with our own mic glyph; CarPlay renders its own glass chrome around
  // bar buttons natively on iOS 26 (the "Liquid Glass" look is the system's).
  leadingNavigationBarButtons: [
    { id: 'car-comms', type: 'image' as const, image: CAR_ICON_MIC },
  ],
  // TOP-RIGHT: Search then End at the far corner. NOTE the array is REVERSED vs
  // the visual order — head-unit photo evidence: config [search, end] rendered as
  // "End Search" left-to-right, so array[0] lands RIGHT-most.
  trailingNavigationBarButtons: [
    { id: 'car-end', type: 'text' as const, title: 'End', buttonStyle: 'rounded' as const },
    { id: 'car-search', type: 'text' as const, title: 'Search', buttonStyle: 'rounded' as const },
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
  // SPACERS REMOVED FOR GOOD (2026-07-23, second head-unit confirmation): iOS 26
  // draws its glass circle behind ANY CPMapButton — transparent image AND
  // hidden:true both failed on the real unit (hidden was also a no-op on the 18.6
  // sim). The 4-slot trick is dead on iOS 26. Crew + compass now live in the two
  // bottom-trailing slots CarPlay gives a 2-button array, and the banner stack sits
  // BESIDE the column (CAR_RIGHT_INSET) instead of underneath phantom circles.
  mapButtons: [
    { id: 'car-crew', image: CAR_ICON_CREW, focusedImage: CAR_ICON_CREW },
    { id: 'car-compass', image: CAR_ICON_COMPASS, focusedImage: CAR_ICON_COMPASS },
  ],
};

// ── ANDROID AUTO BUTTONS (2026-07-30) ────────────────────────────────────────
// Jeff: "next on the list is getting the touch buttons on AA like CarPlay."
//
// AA had NO buttons at all, for two reasons that both had to be fixed:
//
//  1. WE SENT iOS-ONLY KEYS. androidx reads `actions` (-> ActionStrip, the button
//     row) and `mapButtons` (-> MapActionStrip via MapController). We were sending
//     leadingNavigationBarButtons / trailingNavigationBarButtons, which Android
//     never looks at — and our mapButtons entries used the iOS `image` key, while
//     RCTTemplate.parseAction reads `icon`. An Action with neither a title nor an
//     icon is an IllegalStateException in androidx, so sending the iOS shape was
//     at best ignored and at worst fatal to the screen. Android now gets ONLY the
//     Android-shaped keys.
//  2. THE PRESS HAD NOWHERE TO LAND. parseAction wires
//     setOnClickListener { eventEmitter.buttonPressed(id) }, but MapTemplate's JS
//     eventMap had no `buttonPressed` entry, so every press was dropped before it
//     reached a handler. Fixed in the react-native-carplay patch (src/, so OTA-able)
//     — the same omission that once made pinch-to-zoom dead.
//
// SAME IDS as CarPlay on purpose: the existing handlers below take them unchanged,
// so the two car surfaces cannot drift apart in behaviour.
//
// androidx caps each strip at 4 and requires every Action to carry a title or an
// icon. Our glyphs are data URIs (see carButtonIcons.ts), which Fresco decodes
// through ImageSource just as [RCTConvert UIImage:] does on iOS — one artwork set,
// both platforms.
// ── WHY 'persistent' (2026-07-31) ────────────────────────────────────────────
// Jeff, off Say Phin's 07:48 photo: "where is his crew button and compass?" They
// were rendering fine — his OWN tap receipts at 07:36, twelve minutes earlier,
// show car-crew / car-compass / car-search all reaching JS from platform=android.
// By 07:48 the strips had FADED OUT: androidx dims and removes an ActionStrip
// during navigation once the driver stops interacting, and Action.FLAG_IS_PERSISTENT
// is the documented opt-out ("this action will not fade in/out inside an
// ActionStrip"). react-native-carplay exposes it as visibility: 'persistent'
// (RCTTemplate.parseAction).
//
// Verified safe before shipping, because a template that fails to build is the
// androidx "unexpected error" card and there is no way to test that locally:
// FLAG_IS_PERSISTENT appears in exactly ONE class across androidx.car.app 1.4.0
// (Action.class) — no ActionsConstraints validator inspects it, so it cannot throw
// the way an over-long strip or an icon-less action can. A host that ignores the
// flag simply behaves as it does today; there is no downside case.
const AA_PERSISTENT = 'persistent' as const;
export const AA_ACTION_STRIP = [
  { id: 'car-comms', icon: CAR_ICON_MIC, visibility: AA_PERSISTENT },
  { id: 'car-search', title: 'Search', visibility: AA_PERSISTENT },
  { id: 'car-end', title: 'End', visibility: AA_PERSISTENT },
];
export const AA_MAP_BUTTONS = [
  { id: 'car-crew', icon: CAR_ICON_CREW, visibility: AA_PERSISTENT },
  { id: 'car-compass', icon: CAR_ICON_COMPASS, visibility: AA_PERSISTENT },
];

// One dispatcher for an Android Auto press. The ids are shared with CarPlay, so this
// just picks whichever existing handler owns each id — no duplicated behaviour.
export function handleAaButton(id?: string): void {
  if (!id) return;
  if (id === 'car-crew' || id === 'car-compass' || id === 'car-mic') { handleCarMapButton(id); return; }
  handleCarBarButton(id);
}

// Map-button handler for the COLD root (no phone app in the foreground). The warm
// root intercepts these same ids first and routes them to its live refs; anything
// it does not claim falls through to here, so the two roots behave identically.
// Every CarPlay press logs a receipt (screen + crash_reports). See logEvent's
// comment: this is what splits "the tap never reached JS" from "the tap reached JS
// and the action did nothing" — the fork that three rounds of code-reading could
// not settle for the recurring dead-buttons report.
const TAP_LABEL: Record<string, string> = {
  'car-crew': 'Crew', 'car-compass': 'Compass', 'car-comms': 'Comms',
  'car-mic': 'Scout', 'car-search': 'Search', 'car-end': 'End',
};
export function carTap(id: string): void {
  if (!id) return;
  try { logEvent(`carplay-tap:${id}`); } catch {}
  try {
    setCarState({
      carTapEcho: id,
      carTapEchoAt: Date.now(),
      // Visible receipt in the same non-blocking slot. Jeff can now tell the two
      // failure modes apart AT A GLANCE mid-drive, without waiting on a query:
      // pill appears but nothing happens = the action is broken (our JS, OTA-able);
      // pill never appears = the press never reached JS at all (native template
      // layer, needs a build). Any real message from the action overwrites this
      // a moment later, which is the correct ordering.
      carToast: `${TAP_LABEL[id] || id} ✓`,
      carToastUntil: Date.now() + 1600,
    });
  } catch {}
}

export function handleCarMapButton(id: string): void {
  carTap(id);
  if (id === 'car-crew') { emitCarGesture({ kind: 'crewFit' }); return; }
  if (id === 'car-compass') { emitCarGesture({ kind: 'compass' }); return; }
  // Stale-template tolerance: an older cached template can still deliver these.
  if (id === 'car-police') { armPosRing(); void reportPoliceFromCar(); return; }
  if (id === 'car-mic') { emitCarGesture({ kind: 'scoutMic' }); return; }
}

export function handleCarBarButton(id: string): void {
  carTap(id);
  armPosRing(); // idempotent — make sure the 5s-ago buffer is running
  if (id === 'car-comms') {
    void toggleCarComms().then((msg) => { if (msg) toast(msg); });
    return;
  }
  // 'car-police' is no longer a NAV-BAR button (it moved to a round map button in
  // CAR_MAP_BUTTON_CONFIG), but keep the branch: an older cached template on a
  // head unit can still deliver it, and dropping it would silently no-op.
  if (id === 'car-police') { void reportPoliceFromCar(); return; }
  if (id === 'car-end') { void endCarNav(); return; }
  if (id === 'car-search') {
    // Already showing? Do NOT push it again — a second push of the same instance
    // corrupts the CarPlay stack (the freeze). A stray re-tap is a no-op.
    if (_searchPresented) return;
    // Prime the cache BEFORE the template appears — the first updatedSearchText can
    // arrive before an await would have resolved.
    void ensureSavedPlacesLoaded().catch(() => {});
    const t = getSearchTemplate();
    if (!t) return;
    armSearchAutoDismiss();                    // idempotent
    try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch {}
  }
}

// Arm the position ring at module load (cheap; subscription only buffers).
armPosRing();
