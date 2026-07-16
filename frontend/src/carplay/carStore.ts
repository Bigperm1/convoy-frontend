// src/carplay/carStore.ts
//
// Tiny shared store that bridges the phone's React tree and the CarPlay /
// Android Auto surface. The car surface (CarSurface) renders as a SEPARATE
// AppRegistry root, so it can't read map.tsx's props/state directly. map.tsx
// (via useConvoyCarPlay) pushes live state in here; the car surface subscribes
// with useCarStore(). Plain pub/sub, platform-agnostic, safe on web.

import { useEffect, useState } from 'react';
import type { MapMode } from '../settings';
import type { RoadEvent } from '../driveBcEvents';

// Peer entry for the car surface. `id`+`handle` feed the Comms list (the original
// shape); the optional position/status fields (added for CarPlay-standalone Wave 1)
// let CarMapView draw the convoy on the head-unit map. Peers without a numeric
// lat/lng simply don't render a map dot — the Comms list is unaffected.
export type CarPeer = {
  id: string;
  handle: string;
  lat?: number;
  lng?: number;
  heading?: number;
  status?: 'live' | 'parked';
};

export type CarState = {
  navigating: boolean;
  speedMs: number; // current speed in m/s (0 when stopped/unknown)
  instruction: string; // upcoming maneuver text (while navigating)
  distanceToTurn: string; // e.g. "102 m"
  eta: string; // e.g. "24 min"
  distanceRemaining: string; // e.g. "33 km"
  destinationLabel: string;
  peers: CarPeer[];
  // Raw numeric mirrors of the formatted strings above. Android Auto's
  // NavigationTemplate needs real meters/seconds (it formats them itself), not
  // the pre-formatted phone-banner strings. Populated alongside the strings.
  distanceToTurnM: number; // meters to the next maneuver
  distanceRemainingM: number; // meters to the destination
  etaSeconds: number; // seconds remaining to the destination
  // --- Live map (CarPlay static-map background) ---
  // Self position + heading for centering the car map and rotating the car
  // marker, plus the encoded route geometry. routePolyline is Google's
  // precision-5 overview polyline, which is a drop-in for the Mapbox Static
  // Images API `path` overlay (same encoding). selfLat/selfLng are null until
  // GPS is acquired; heading is null when unknown/stationary; routePolyline is
  // '' when there is no active route.
  selfLat: number | null;
  selfLng: number | null;
  heading: number | null; // degrees, 0 = north
  routePolyline: string;
  // Self car paint (mirror of the phone's settings.carColor). Lets the car root
  // pick the right 3D vehicle model (getVehicleModelUrl). undefined → car root
  // falls back to the default GRC model. Set from the phone mirror feed and the
  // background/foreground location feeds (best-effort on the cold-connect path).
  selfCarColor?: string;
  // Base-map mode (mirror of the phone's getMapMode(settings)). Lets the car map
  // match the phone's style: 'satellite' → SatelliteStreet, else Standard with the
  // matching light preset. undefined → car falls back to the phone default 'dusk'.
  mapMode?: MapMode;
  // Self-marker style (mirror of settings.selfMarkerType). Lets the CarPlay live map
  // render the green ARROW model when the phone is set to 'arrow', else the 3D car —
  // so the head unit matches the phone. undefined → car.
  selfMarkerType?: 'car' | 'arrow' | 'photo';
  // Map markers mirrored from the phone so the CarPlay live map shows the SAME
  // hazards / DriveBC incidents / speed cameras / place pins the driver sees on the
  // phone. All optional; undefined → none. The 'when active' gating is applied on the
  // phone BEFORE writing (speed cameras + road events self-gate to [] when their layer
  // is off; places only when the pins setting is on; hazards filtered to disputes<2).
  // CarMapView renders them with the phone's own marker components (no duplication).
  hazards?: { id: string; kind: string; lat: number; lng: number; confirms?: number; disputes?: number }[];
  speedCameras?: { id: string; lat: number; lng: number }[];
  roadEvents?: RoadEvent[];
  places?: { id: string; lat: number; lng: number; label?: string }[];
  // Posted speed limit (km/h) for the road the driver is on (OSM/Overpass, fed by
  // the navNotification location feed). undefined/0 → no badge shown.
  speedLimitKmh?: number;
  // Live weather at the driver (mirror of the phone's WeatherHUD), fed from
  // useConvoyCarPlay only while the phone's weather layer is on. weatherTemp is the
  // pre-formatted reading in the driver's unit (e.g. '18°'); weatherKind is a
  // WeatherKind string the car maps to a glyph. undefined → no weather chip.
  weatherTemp?: string;
  weatherKind?: string;
  // Agentic Scout mic state (mirror of the phone's useVoice instance, fed by
  // map.tsx). Drives the "Listening… / Thinking…" pill on the car surface so a
  // native map-button tap gets visible feedback — the head unit has no haptics.
  scoutListening?: boolean;
  scoutThinking?: boolean;
  // User-chosen route-line color (base hex, mirror of settings.routeColor). Lets the
  // CarPlay live route match the phone. undefined → CarMapView falls back to green.
  routeColor?: string;
  // Up to three DISPLAY routes (Best / Scenic / AI) for the CarPlay preview, mirrored
  // from the phone. Each carries its precomputed core `color` + casing `edge` (AI = black
  // core, user-color edge) so CarMapView paints them per-kind without re-deriving, plus
  // the route's original `index` so it can match `selectedRouteIndex`. Empty/undefined when
  // there's no route or only one option. `routePolyline` (above) stays the SELECTED route
  // used for nav trim + the static-map fallback. Route SELECTION is phone-driven (CarPlay
  // route lines are display-only) — CarPlay just mirrors whichever the phone picked.
  routes?: { index: number; polyline: string; kind: string; color: string; edge: string }[];
  selectedRouteIndex?: number;
  // Selected route's decoded [lng,lat] geometry + per-segment congestion (mirror of
  // routes[selectedRouteIndex].coordinates/.congestion). Lets the CarPlay map paint the
  // SAME live traffic gradient as the phone — clear in the route color, warming to
  // yellow/orange/red where it slows. undefined → CarMapView falls back to the flat color.
  routeCoordinates?: [number, number][];
  routeCongestion?: string[];
  // Glyph (unicode arrow) for the upcoming maneuver, shown in the car banner's green
  // arrow box (mirrors the phone's maneuver icon). undefined when not navigating.
  maneuverIcon?: string;
  // Lane guidance for the upcoming maneuver ("3D-lanes lite") — same fail-closed
  // pickLaneCue data the phone's lane row shows: active lanes glow green on the
  // car banner. Written by the phone mirror (warm) or navNotification (cold).
  // undefined/[] → the lane row is hidden.
  lanes?: { dirs: string[]; active: boolean; activeDir?: string }[];
  // On-screen diagnostic breadcrumb for the CarPlay surface (which feed last wrote a
  // position, or which call failed). Shown in the logo fallback so the head-unit screen
  // self-reports why hasFix is false — no Mac/device log needed. e.g. 'fgfeed',
  // 'navtask#3', 'seed:ok#0', 'seed:err#1:…', 'seed:no-fg-perm', 'bgstart:err:…'.
  carDbg?: string;
};

const initial: CarState = {
  navigating: false,
  speedMs: 0,
  instruction: '',
  distanceToTurn: '',
  eta: '',
  distanceRemaining: '',
  destinationLabel: '',
  peers: [],
  distanceToTurnM: 0,
  distanceRemainingM: 0,
  etaSeconds: 0,
  selfLat: null,
  selfLng: null,
  heading: null,
  routePolyline: '',
};

let state: CarState = initial;
const listeners = new Set<(s: CarState) => void>();

export function setCarState(patch: Partial<CarState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

// ── Self-position write GATE (fixes the "marker roams after CarPlay connects") ──
// Once CarPlay connects, selfLat/selfLng is fed by THREE concurrent GPS streams: the
// phone-coords mirror (BestForNavigation / 0 m — most accurate), a foreground car watch
// (High / 15 m), and the background nav task (High / 20 m). A plain last-writer-wins
// merge let the two LAGGING feeds overwrite the precise one, so the stored position
// hopped between three disagreeing fixes and the eased marker wandered. This gate keeps
// ALL THREE feeds running (the CarPlay-logo robustness is untouched) but only lets the
// highest-priority ACTIVE feed move the marker: a lower-priority feed is ignored while a
// higher one is still fresh, and takes over only once the higher goes stale
// (SELF_STALE_MS) — e.g. when the phone screen backgrounds and its mirror stops, the
// fg/bg feeds resume within ~2 s. Because the first write and any post-staleness write are
// always accepted, selfLat/selfLng are never left null, so the logo-fallback can't return.
export type SelfPosSource = 'mirror' | 'fgwatch' | 'bgtask';
const SELF_SOURCE_RANK: Record<SelfPosSource, number> = { mirror: 3, fgwatch: 2, bgtask: 1 };
// Kept well above the 500 ms mirror interval so interleaved fg/bg fixes are rejected
// while the mirror is alive, but short enough that if a higher-priority feed dies
// (phone screen sleeps → mirror stops) the surviving lower feed takes over quickly.
// 1200 → 2600 (2026-07-16 drive test): the same-day bg-cadence bump (fg/bg feeds now
// tick at 1 s/5 m) let RAW-GPS fixes slip between the phone's ROUTE-SNAPPED mirror
// fixes whenever the mirror paused >1.2 s (render hitch, GPS gap) — the marker
// zigzagged between the two tracks ("very jittery even when plugged in"). 2.6 s
// rejects those interleaves; screen-off handoff now takes ≤2.6 s once, then the
// lower feed owns the marker (and the SelfCarModel watchdog keeps it easing).
const SELF_STALE_MS = 2600;
let lastSelfPos: { ts: number; rank: number } | null = null;

export function setCarSelfPosition(lat: number, lng: number, heading: number | null, source: SelfPosSource) {
  const now = Date.now();
  const rank = SELF_SOURCE_RANK[source];
  const cur = lastSelfPos;
  // dt < 0 = the wall clock stepped backward (NTP / manual set); treat as stale so a clock
  // jump can never leave a dead higher feed looking permanently fresh and freeze the marker.
  const dt = cur ? now - cur.ts : Infinity;
  const stale = dt > SELF_STALE_MS || dt < 0;
  // Ignore ONLY a lower-priority feed overwriting a still-fresh higher-priority fix.
  // Same/higher priority always writes; after staleness the next feed takes over. The first
  // write (cur null → stale) and every post-staleness write are accepted, so selfLat/selfLng
  // are never left null → the CONVOY-logo fallback cannot return.
  if (cur && !stale && rank < cur.rank) return;
  lastSelfPos = { ts: now, rank };
  setCarState({ selfLat: lat, selfLng: lng, heading });
}

// ── Peers/hazards write GATE (CarPlay-standalone Wave 1) ────────────────────
// Two writers now produce peers + hazards: the WARM phone mirror (useConvoyCarPlay,
// runs only while map.tsx is mounted) and the COLD module-scope carDataService
// (started on CarPlay connect, keeps the head unit fed when the phone app was never
// opened). Plain setCarState is last-writer-wins, so without a gate they'd clobber
// each other on every tick. Same mental model as setCarSelfPosition above: the
// richer 'phone' feed always writes and suppresses 'service' while fresh; when the
// phone screen unmounts/backgrounds (its writes stop), the service takes over after
// FEED_STALE_MS. The first write and any post-staleness write are always accepted.
export type ConvoyFeedSource = 'phone' | 'service';
const FEED_RANK: Record<ConvoyFeedSource, number> = { phone: 2, service: 1 };
// The phone mirror re-writes only when its React deps CHANGE (not on a fixed
// cadence), so this is deliberately generous — long enough that a quiet-but-alive
// phone feed isn't usurped mid-drive, short enough that the cold service takes
// over within one of its own refresh ticks after the phone goes away.
const FEED_STALE_MS = 12_000;
let lastPeersWrite: { ts: number; rank: number } | null = null;
let lastHazardsWrite: { ts: number; rank: number } | null = null;

function feedGateAllows(cur: { ts: number; rank: number } | null, rank: number): boolean {
  if (!cur) return true;
  const dt = Date.now() - cur.ts;
  const stale = dt > FEED_STALE_MS || dt < 0; // dt<0 = wall clock stepped back → treat stale
  return stale || rank >= cur.rank;
}

export function setCarPeers(peers: CarPeer[], source: ConvoyFeedSource) {
  const rank = FEED_RANK[source];
  if (!feedGateAllows(lastPeersWrite, rank)) return;
  lastPeersWrite = { ts: Date.now(), rank };
  setCarState({ peers });
}

export function setCarHazards(hazards: NonNullable<CarState['hazards']>, source: ConvoyFeedSource) {
  const rank = FEED_RANK[source];
  if (!feedGateAllows(lastHazardsWrite, rank)) return;
  lastHazardsWrite = { ts: Date.now(), rank };
  setCarState({ hazards });
}

export function getCarState(): CarState {
  return state;
}

// Imperative subscription for module-scope services (no React). The cold
// carDataService drives its refresh throttles off these ticks — the background
// location task keeps writing positions while the phone is locked, so position
// ticks are the reliable event source (JS timers can stall when locked).
export function subscribeCarState(fn: (s: CarState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useCarStore(): CarState {
  const [s, setS] = useState<CarState>(state);
  useEffect(() => {
    const l = (next: CarState) => setS(next);
    listeners.add(l);
    setS(state); // sync any state set before this subscribed
    return () => { listeners.delete(l); };
  }, []);
  return s;
}

// ── CarPlay map gestures ───────────────────────────────────────────────────
// Transient touch commands (NOT persistent state), so they ride a tiny pub/sub
// bus rather than CarState — same pattern as voiceBus/hailBus. ConvoyCarPlay's
// CPMapTemplate gesture callbacks (wired via the react-native-carplay patch)
// emit here; CarMapView subscribes and folds them into its camera. Only zoom is
// consumed today (it adds a bias to the lockstep's follow-zoom without touching
// SelfCarModel); pan/rotate/pitch are carried for future use. `scale` is the
// CarPlay pinch scale factor relative to the gesture start (1.0 at begin).
export type CarGesture =
  | { kind: 'zoomBegin' }
  | { kind: 'zoom'; scale: number; velocity: number }
  | { kind: 'zoomEnd'; velocity: number }
  | { kind: 'recenter' }
  // RN-surface Scout mic tap → map.tsx (same JS context) toggles the voice agent.
  // EXPERIMENT: native map buttons are covered by our RN car surface, so this
  // tests whether the surface ITSELF receives CarPlay taps.
  | { kind: 'scoutMic' };

const gestureListeners = new Set<(g: CarGesture) => void>();

export function emitCarGesture(g: CarGesture) {
  gestureListeners.forEach((l) => l(g));
}

export function subscribeCarGesture(fn: (g: CarGesture) => void): () => void {
  gestureListeners.add(fn);
  return () => { gestureListeners.delete(fn); };
}
