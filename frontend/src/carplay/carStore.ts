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

export type CarPeer = { id: string; handle: string };

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

export function getCarState(): CarState {
  return state;
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
