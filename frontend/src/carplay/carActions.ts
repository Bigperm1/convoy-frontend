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
import { getCarState, setCarState, setCarHazards, subscribeCarState } from './carStore';

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

function toast(msg: string): void {
  try { getLib()?.CarPlay?.bridge?.toast?.(msg, 2.5); } catch {}
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
function getSearchTemplate(): any | null {
  if (_searchTemplate) return _searchTemplate;
  const lib = getLib();
  if (!lib?.SearchTemplate) return null;
  try {
    _searchTemplate = new lib.SearchTemplate({
      id: 'convoy-car-search',
      // Called per keystroke; return ListItem[] to render. (CarPlay only offers
      // the keyboard while parked — an OS rule, same as Waze.)
      onSearch: async (query: string) => {
        if (!query || query.trim().length < 2) { _lastResults = []; return []; }
        try {
          _lastResults = await placesAutocomplete(query.trim());
        } catch {
          _lastResults = [];
        }
        return _lastResults.map((r) => ({ text: r.description }));
      },
      onItemSelect: async ({ index }: { index: number }) => {
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
  leadingNavigationBarButtons: [
    { id: 'car-search', type: 'text' as const, title: 'Search' },
  ],
  trailingNavigationBarButtons: [
    { id: 'car-police', type: 'text' as const, title: 'Police' },
    { id: 'car-end', type: 'text' as const, title: 'End' },
  ],
};

export function handleCarBarButton(id: string): void {
  armPosRing(); // idempotent — make sure the 5s-ago buffer is running
  if (id === 'car-police') { void reportPoliceFromCar(); return; }
  if (id === 'car-end') { void endCarNav(); return; }
  if (id === 'car-search') {
    const t = getSearchTemplate();
    if (!t) return;
    try { getLib()?.CarPlay?.pushTemplate?.(t, true); } catch {}
  }
}

// Arm the position ring at module load (cheap; subscription only buffers).
armPosRing();
