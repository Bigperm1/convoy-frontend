// Navigation engine — Routes API (computeRoutes) + turn-by-turn step machine.
// Replaces the legacy Directions API with the Google Routes API v2 which
// provides richer traffic data, better polyline quality and is the
// forward-looking Google-recommended routing endpoint.

import { useEffect, useRef, useState } from "react";
import { Platform, AppState } from "react-native";
import { api } from "./api";
import { fetchMapboxRoutes, fetchMapboxRouteVia, type MapboxRoute, type MapboxRouteStep, type CongestionLevel } from "./mapboxDirections";
import { getSettings, getNovaVoice, getAudioVol } from "./settings";
import { setPlaybackAudioMode, setIdleAudioMode } from "./audioMode";
import { duckForSpeech, unduckForSpeech } from "./applePlayer";
import { isOnCall, callSilence } from "./callState";

export type LatLng = { lat: number; lng: number };

export type NavStep = {
  html: string;
  distance_text: string;
  distance_m: number;
  duration_text: string;
  maneuver?: string;
  start: LatLng;
  end: LatLng;
};

export type NavRoute = {
  polyline: string;
  summary: string;
  distance_text: string;
  duration_text: string;
  distance_m: number;
  duration_s: number;
  duration_in_traffic_text?: string;
  duration_in_traffic_s?: number;
  // Free-flow (no-traffic) duration from the Routes API `staticDuration`. Used
  // only to gauge congestion for the route-start greeting; duration_s stays the
  // traffic-aware ETA the UI shows.
  freeflow_s?: number;
  // Per-segment live congestion + decoded [lng,lat] geometry, carried straight
  // through from Mapbox so the map can paint the live traffic gradient on the
  // ACTIVE route DURING navigation (not just in preview). Optional: absent for
  // any legacy/cached route shape.
  congestion?: CongestionLevel[];
  coordinates?: [number, number][];
  steps: NavStep[];
  // Route SLOT for the 3-route system. "best" (fastest) / "scenic" (alternate) are
  // assigned positionally by the map; "ai" is set here by fetchAiRoute for a learned
  // habitual route (drawn black-core + user-edges). Absent = positional default.
  kind?: "best" | "scenic" | "ai" | "alt";
  // Optional per-route preview color (legacy field, still set by map.tsx's rank-color).
  color?: string;
};

export type NavMode = "preview" | "turn-by-turn";

// ---- Distance utils ----
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---- Maneuver → human verb ----
// Shared turn glyph for the maneuver tile — used by BOTH the phone banner
// (TurnByTurnNav) and the CarPlay strip so they render the SAME dark arrow on the
// green tile (Option A). Unicode text renders reliably on the CarPlay Fabric
// surface, where the vector-icon font is flaky — hence glyphs, not <Ionicons>.
export function maneuverArrow(instruction: string): string {
  const t = (instruction || "").toLowerCase();
  if (/\bu[- ]?turn\b/.test(t)) return "⟲";       // ⟲
  if (/\bslight left\b/.test(t)) return "↖";      // ↖
  if (/\bslight right\b/.test(t)) return "↗";     // ↗
  if (/\bleft\b/.test(t)) return "↰";             // ↰
  if (/\bright\b/.test(t)) return "↱";            // ↱
  if (/\bmerge\b/.test(t)) return "⤵";            // ⤵
  if (/\b(ramp|exit|take)\b/.test(t)) return "↗"; // ↗
  return "↑";                                     // ↑
}

export function maneuverVerb(m?: string): string {
  if (!m) return "Continue";
  const map: Record<string, string> = {
    "TURN_RIGHT": "Turn right", "TURN_LEFT": "Turn left",
    "TURN_SLIGHT_RIGHT": "Slight right", "TURN_SLIGHT_LEFT": "Slight left",
    "TURN_SHARP_RIGHT": "Sharp right", "TURN_SHARP_LEFT": "Sharp left",
    "UTURN_RIGHT": "Make a U-turn", "UTURN_LEFT": "Make a U-turn",
    "MERGE": "Merge", "FORK_RIGHT": "Keep right", "FORK_LEFT": "Keep left",
    "RAMP_RIGHT": "Take the ramp on the right", "RAMP_LEFT": "Take the ramp on the left",
    "ROUNDABOUT_RIGHT": "At the roundabout, turn right",
    "ROUNDABOUT_LEFT": "At the roundabout, turn left",
    "FERRY": "Take the ferry", "STRAIGHT": "Continue straight",
    // Legacy Directions API maneuver names (kept for any cached data)
    "turn-right": "Turn right", "turn-left": "Turn left",
    "turn-slight-right": "Slight right", "turn-slight-left": "Slight left",
    "turn-sharp-right": "Sharp right", "turn-sharp-left": "Sharp left",
    "uturn-right": "Make a U-turn", "uturn-left": "Make a U-turn",
    "merge": "Merge", "fork-right": "Keep right", "fork-left": "Keep left",
    "ramp-right": "Take the ramp on the right", "ramp-left": "Take the ramp on the left",
    "roundabout-right": "At the roundabout, turn right",
    "roundabout-left": "At the roundabout, turn left",
    "ferry": "Take the ferry", "straight": "Continue straight",
    // Mapbox vocabulary (type|modifier joined by mapboxManeuverKey below).
    "turn|left": "Turn left", "turn|right": "Turn right",
    "turn|slight left": "Slight left", "turn|slight right": "Slight right",
    "turn|sharp left": "Sharp left", "turn|sharp right": "Sharp right",
    "turn|uturn": "Make a U-turn", "turn|straight": "Continue straight",
    "merge|left": "Merge left", "merge|right": "Merge right", "merge|straight": "Merge",
    "merge|slight left": "Merge left", "merge|slight right": "Merge right",
    "fork|left": "Keep left", "fork|right": "Keep right",
    "fork|slight left": "Keep left", "fork|slight right": "Keep right",
    "on ramp|left": "Take the ramp on the left", "on ramp|right": "Take the ramp on the right",
    "on ramp|slight left": "Take the ramp on the left", "on ramp|slight right": "Take the ramp on the right",
    "off ramp|left": "Take the exit on the left", "off ramp|right": "Take the exit on the right",
    "off ramp|slight left": "Take the exit on the left", "off ramp|slight right": "Take the exit on the right",
    "roundabout|left": "At the roundabout, turn left", "roundabout|right": "At the roundabout, turn right",
    "roundabout|straight": "At the roundabout, continue straight",
    "rotary|left": "At the roundabout, turn left", "rotary|right": "At the roundabout, turn right",
    "exit roundabout|left": "Exit the roundabout", "exit roundabout|right": "Exit the roundabout",
    "exit rotary|left": "Exit the roundabout", "exit rotary|right": "Exit the roundabout",
    "end of road|left": "Turn left", "end of road|right": "Turn right",
    "continue|left": "Keep left", "continue|right": "Keep right",
    "continue|straight": "Continue straight", "continue|uturn": "Make a U-turn",
    "depart|left": "Head out", "depart|right": "Head out", "depart|straight": "Head out",
    "arrive|left": "Arrive on the left", "arrive|right": "Arrive on the right",
    "arrive|straight": "You have arrived",
  };
  return map[m] || "Continue";
}

// Join Mapbox's split maneuver (type + modifier) into a single lookup key for
// maneuverVerb, e.g. {type:"turn",modifier:"left"} -> "turn|left". Falls back to
// the bare type so a missing modifier still resolves ("merge" -> "merge|").
export function mapboxManeuverKey(type?: string, modifier?: string): string {
  const t = (type || "").toLowerCase().trim();
  const mod = (modifier || "").toLowerCase().trim();
  return mod ? `${t}|${mod}` : t;
}

// ---- Route preferences ----
export type AvoidPrefs = {
  tolls?: boolean;
  highways?: boolean;
  ferries?: boolean;
};

// ---- Routes API v2 (computeRoutes) ----
// On web: proxied through FastAPI /api/routes (CORS limitation).
// On native: calls the Routes API directly for minimum latency.
// Returns the same NavRoute[] shape as the old Directions-based function
// so all callers (map.tsx, NavigationPanel, etc.) need zero changes.
export async function fetchRoutes(
  origin: LatLng,
  destination: LatLng,
  avoid?: AvoidPrefs
): Promise<NavRoute[]> {
  // Routing now comes from Mapbox Directions (driving-traffic), replacing Google
  // Routes API. Same signature + NavRoute/NavStep shape, so every caller (map.tsx,
  // the turn-by-turn machine, the greeting, CarPlay formatters) is unchanged.
  let mbRoutes: MapboxRoute[] = [];
  try {
    mbRoutes = await fetchMapboxRoutes(
      origin,
      destination,
      { tolls: !!avoid?.tolls, highways: !!avoid?.highways, ferries: !!avoid?.ferries },
    );
  } catch {
    return [];
  }
  if (!mbRoutes.length) return [];

  return mbRoutes.map(mapboxToNavRoute).filter((r: NavRoute) => r.polyline);
}

// Map one Mapbox route to the shared NavRoute shape. Extracted so both fetchRoutes and
// the AI route (via-waypoint replay) produce identical NavRoutes — all the downstream
// stats / gradient / turn-engine code then treats the AI route like any other.
export function mapboxToNavRoute(r: MapboxRoute): NavRoute {
  const durS = r.duration_s;
  // freeflow_s carries Mapbox's typical (historical) duration. When it differs
  // from the live traffic-aware duration we surface a real traffic ETA — the
  // old Google parser always left this undefined (it parsed the same field
  // twice), so this also fixes that latent bug.
  const freeflowS = r.freeflow_s > 0 ? r.freeflow_s : durS;
  const hasTraffic = durS > 0 && freeflowS > 0 && Math.abs(durS - freeflowS) >= 30;

  return {
    polyline: r.polyline,
    summary: r.summary,
    distance_text: formatDistance(r.distance_m),
    duration_text: formatDuration(durS),
    distance_m: r.distance_m,
    duration_s: durS,
    freeflow_s: freeflowS || undefined,
    duration_in_traffic_text: hasTraffic ? formatDuration(durS) : undefined,
    duration_in_traffic_s: hasTraffic ? durS : undefined,
    congestion: r.congestion,
    coordinates: r.coordinates,
    steps: r.steps.map((s: MapboxRouteStep, i: number, arr: MapboxRouteStep[]): NavStep => {
      const loc = s.maneuver?.location; // [lng, lat] — START of this step (the turn point)
      const here: LatLng = Array.isArray(loc) && loc.length >= 2
        ? { lat: loc[1], lng: loc[0] } : { lat: 0, lng: 0 };
      // The turn-by-turn machine (Google-shaped) treats step.end as the NEXT
      // maneuver's location: it measures distance to cur.end and announces the
      // following step. Mapbox gives one point per step, so set end = the NEXT
      // step's maneuver point. Without this, callouts run one turn ahead (the
      // "lefts/rights reversed" bug). Last step keeps end = here (arrival).
      const nLoc = arr[i + 1]?.maneuver?.location;
      const end: LatLng = Array.isArray(nLoc) && nLoc.length >= 2
        ? { lat: nLoc[1], lng: nLoc[0] } : here;
      const verbKey = mapboxManeuverKey(s.maneuver?.type, s.maneuver?.modifier);
      const html = s.maneuver?.instruction || maneuverVerb(verbKey);
      return {
        html,
        distance_text: formatDistance(s.distance),
        distance_m: s.distance,
        duration_text: formatDuration(s.duration),
        // Store the joined Mapbox key so maneuverVerb / isSpokenManeuver resolve it.
        maneuver: verbKey,
        start: here,
        end,
      };
    }),
  };
}

// Replay a learned habitual path (aiRoutes.ts) as a real traffic-aware NavRoute by
// pinning it to its via-waypoints. Returns a NavRoute tagged kind:"ai" so the map +
// CarPlay style it as the AI slot, or null on failure (caller hides the AI slot).
export async function fetchAiRoute(
  origin: LatLng,
  via: [number, number][],
  destination: LatLng,
  avoid?: AvoidPrefs,
): Promise<NavRoute | null> {
  let mb: MapboxRoute | null = null;
  try {
    mb = await fetchMapboxRouteVia(
      origin, via, destination,
      { tolls: !!avoid?.tolls, highways: !!avoid?.highways, ferries: !!avoid?.ferries },
    );
  } catch {
    return null;
  }
  if (!mb || !mb.polyline) return null;
  return { ...mapboxToNavRoute(mb), kind: "ai" };
}

// Keep the old name as an alias so any remaining legacy callsites still compile.
// New code should call fetchRoutes() directly.
export const fetchDirections = fetchRoutes;

export function formatDistance(m: number): string {
  // Imperial regions (mph): feet under ~1000 ft, else miles. Metric otherwise.
  // Reads the live unit so every distance readout — banner, ETA, spoken cues,
  // CarPlay — follows the driver's country with no call-site changes.
  if (getSettings().speedUnit === 'mph') {
    const mi = m / 1609.344;
    if (mi < 0.19) return `${Math.round((m * 3.28084) / 10) * 10} ft`;
    return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
  }
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function formatDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} sec`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

// ---- Turn-by-turn engine (unchanged — same logic, works with new route shape) ----
type TbtState = {
  active: boolean;
  stepIndex: number;
  distanceToManeuverM: number;
  distanceRemainingM: number;
  etaSeconds: number;
};

// Speed-aware voice lead. Fixed-distance callouts fire too late at speed (the
// "Nova falls behind the car" bug — a 30 m final cue is ~1 second of warning on
// the highway) and too early in town. Scale the trigger to a constant TIME
// before the maneuver, clamped so it stays sane when stopped/crawling or very
// fast. TTS adds ~1–2 s of queue+network latency, so the imminent lead must
// cover reaction time AND that latency.
const IMMINENT_LEAD_S = 7;     // "Turn now" cue ~7 s out
const IMMINENT_MIN_M = 30;
const IMMINENT_MAX_M = 250;
const PREPARE_LEAD_S = 30;     // "In X, turn …" heads-up ~30 s out
const PREPARE_MIN_M = 150;
const PREPARE_MAX_M = 1200;
const ADVANCE_THRESHOLD_M = 25;
const REROUTE_DISTANCE_M = 80; // PERPENDICULAR distance off the route line before off-route
// Heading gate for off-route: a big perpendicular distance only counts as a real
// departure if the car's heading ALSO diverges from the route's local direction
// by more than this. Driving straight along a highway while GPS multipath off an
// overpass/bridge throws the fix sideways keeps the heading aligned — so those
// spikes no longer trigger a phantom reroute.
const OFFROUTE_HEADING_TOL_DEG = 55;

// Decode a Google encoded polyline → [{lat,lng}]. Used to measure how far off the
// ROUTE LINE the driver actually is (perpendicular) — the correct off-route signal.
export function decodePolyline(encoded: string): LatLng[] {
  const pts: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b: number, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
  } catch { return []; }
  return pts;
}

// Initial bearing (deg, 0=N, clockwise) from point a to point b.
function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const p1 = toRad(a.lat), p2 = toRad(b.lat);
  const dL = toRad(b.lng - a.lng);
  const y = Math.sin(dL) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Nearest point on the route polyline: its perpendicular distance (m) AND the
// bearing of the segment it falls on (the direction the route runs there).
// Mid-segment on a straight highway the distance is ~0, so it does NOT false-flag
// off-route. The segment bearing lets the caller gate off-route on heading, so
// GPS multipath off an overpass/bridge — a big sideways jump while still heading
// down the road — no longer triggers a phantom reroute.
function nearestRouteInfo(lat: number, lng: number, pts: LatLng[]): { distM: number; bearingDeg: number } {
  if (!pts || pts.length < 2) return { distM: Infinity, bearingDeg: NaN };
  const kx = Math.cos((lat * Math.PI) / 180);
  const px = lng * kx, py = lat;
  let best = Infinity, bi = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].lng * kx, ay = pts[i].lat;
    const bx = pts[i + 1].lng * kx, by = pts[i + 1].lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    const d = ex * ex + ey * ey;
    if (d < best) { best = d; bi = i; }
  }
  return { distM: Math.sqrt(best) * 111320, bearingDeg: bearingBetween(pts[bi], pts[bi + 1]) };
}

// Arrival lines — varied so Nova doesn't say the exact same thing every trip.
// Spoken by the engine (not the screen) so the line survives nav teardown; the
// map screen's onArrive ends navigation WITHOUT stopSpeech so it isn't cut off.
const ARRIVAL_LINES = [
  "You've arrived at your destination.",
  "Here we are — you've made it.",
  "Arrived. Nice driving.",
  "This is it, you've reached your destination.",
  "You made it — welcome.",
  "Destination reached. Enjoy.",
];
function arrivalLine(): string {
  return ARRIVAL_LINES[Math.floor(Math.random() * ARRIVAL_LINES.length)];
}

// "Less intrusive Nova" filter. Maneuvers that just mean "keep going" aren't
// worth a spoken callout — speaking them ("continue straight for 2 km") is the
// nagging the driver complained about. We skip ONLY these, so real turns,
// merges, ramps, forks, roundabouts and U-turns still speak.
const SILENT_MANEUVERS = new Set([
  "straight", "continue", "name_change", "name-change", "depart",
]);
// Decide whether a maneuver is worth speaking. A known non-actionable maneuver
// is silenced. For an empty/unknown maneuver we fall back to the instruction
// text and speak ONLY if it clearly describes a real maneuver — so we never
// drop a genuine turn that arrived without a maneuver code, but still stay quiet
// on "Continue on Main St" filler.
function isSpokenManeuver(maneuver?: string, html?: string): boolean {
  const m = (maneuver || "").toLowerCase();
  // maneuver may be a joined Mapbox key ("type|modifier", e.g. "continue|straight",
  // "depart|left", "turn|straight") or a bare legacy token ("straight"). Split so
  // the SILENT set matches on the TYPE half regardless of modifier.
  const type = m.split("|")[0];
  const modifier = m.split("|")[1] || "";
  // A "straight" modifier means no real turn (e.g. "turn|straight", "merge|straight"
  // continuing ahead) — treat as non-actionable filler, same as continue/straight.
  if (modifier === "straight") return false;
  if (type && SILENT_MANEUVERS.has(type)) return false;
  if (m && !SILENT_MANEUVERS.has(m)) return true;
  const h = (html || "").toLowerCase();
  return /\b(turn|merge|exit|ramp|fork|u-?turn|roundabout|keep (?:left|right))\b/.test(h);
}

// Ordinal word for a small exit number (roundabouts). Falls back to "Nth".
function ordinalWord(n: number): string {
  const words = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  return words[n] || `${n}th`;
}

// Roundabout / rotary → a clean exit-based spoken cue with NO road names
// ("take the second exit"), which is what a driver actually needs mid-roundabout.
// The exit number is parsed from Mapbox's OWN instruction text (e.g. "Take the
// 2nd exit onto Maplewood Dr"). Returns null when the maneuver is NOT a roundabout
// so the caller uses the normal verb path. If the number can't be parsed it still
// returns a generic, road-name-free roundabout cue rather than nothing.
function roundaboutExitCue(maneuverKey?: string, html?: string): string | null {
  const type = (maneuverKey || "").split("|")[0];
  if (type !== "roundabout" && type !== "rotary") return null;
  const m = (html || "").match(/\b(\d+)\s*(?:st|nd|rd|th)?\s+exit\b/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  if (Number.isFinite(n) && n >= 1) return `Take the ${ordinalWord(n)} exit`;
  return "Take your exit at the roundabout";
}

export function useTurnByTurn(
  route: NavRoute | null,
  // `speed` (m/s, from GPS) rides along on the position the caller already
  // passes (map.tsx hands us `coords`, which carries it) — used to scale the
  // voice lead distance with speed. Optional so other callers stay compatible.
  // `heading` (deg, course over ground) rides along too — used to gate off-route
  // detection so GPS multipath off an overpass can't fake a departure.
  user: (LatLng & { speed?: number; heading?: number }) | null,
  active: boolean,
  options?: { mute?: boolean; onArrive?: () => void; onOffRoute?: () => void }
) {
  const [state, setState] = useState<TbtState>({
    active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0,
  });
  const announcedRef = useRef<Set<string>>(new Set());
  const lastSpokeRef = useRef<number>(0);
  const lastOffRouteAtRef = useRef<number>(0);
  const offRouteStreakRef = useRef<number>(0);
  const polyCacheRef = useRef<{ key: string; pts: LatLng[] }>({ key: "", pts: [] });
  const stateRef = useRef<TbtState>({
    active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0,
  });
  const hasAnnouncedStartRef = useRef<boolean>(false);
  // One-shot: announce the next maneuver from the CURRENT position once guidance is
  // free (after the greeting), instead of a stale step-0 "Starting navigation" readout.
  const pendingStartCueRef = useRef<boolean>(false);
  const routeRef = useRef<NavRoute | null>(route);
  useEffect(() => { routeRef.current = route; }, [route]);
  // Tracks the active route's polyline so we can detect a mid-drive route SWAP
  // (Nova reroute accept / off-route refetch) and re-anchor guidance onto it.
  const routeKeyRef = useRef<string>("");

  useEffect(() => {
    if (!active) {
      resetSpeakGate();
      announcedRef.current.clear();
      hasAnnouncedStartRef.current = false;
      const cleared: TbtState = { active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0 };
      stateRef.current = cleared;
      setState(cleared);
      return;
    }
    // NOTE: no resetSpeakGate() here. startNav() calls stopSpeech() right before
    // reserving the Nova greeting, so resetting again on activate would wipe the
    // greeting we just queued (and clear the in-flight hold) — which let the first
    // turn callout play OVER the greeting. Teardown reset still runs in the
    // !active branch above.
    announcedRef.current.clear();
    const fresh: TbtState = { ...stateRef.current, active: true, stepIndex: 0 };
    stateRef.current = fresh;
    setState(fresh);
    const r = routeRef.current;
    if (r?.steps?.[0] && !options?.mute && !hasAnnouncedStartRef.current) {
      // Don't speak a static "Starting navigation. {step0}. Total X." here — by the
      // time the greeting finishes the car may have rolled forward. Instead arm a
      // one-shot cue that the location effect fires from the LIVE position once the
      // greeting clears, announcing whatever maneuver is actually next.
      pendingStartCueRef.current = true;
      hasAnnouncedStartRef.current = true;
    }
  }, [active]);

  // Re-anchor on a mid-drive route SWAP. When the active route's polyline changes
  // while navigating — a Nova reroute the driver accepted, or an off-route
  // refetch — the new route is computed FROM the current GPS position, so its
  // step 0 is exactly where the driver is now. Reset stepIndex to 0 (and clear
  // spoken-cue dedupe) so guidance picks up the new line and actually calls out
  // the turn ONTO it. Without this the engine kept the OLD route's stale step
  // index and silently skipped the divergence — so accepting a reroute "did
  // nothing" and the driver stayed on the original road.
  useEffect(() => {
    const key = route?.polyline || "";
    if (!active || !key) { routeKeyRef.current = key; return; }
    if (key !== routeKeyRef.current) {
      routeKeyRef.current = key;
      announcedRef.current.clear();
      const reAnchored: TbtState = { ...stateRef.current, active: true, stepIndex: 0 };
      stateRef.current = reAnchored;
      setState(reAnchored);
    }
  }, [route?.polyline, active]);

  useEffect(() => {
    if (!active || !user) return;
    const r = routeRef.current;
    if (!r) return;
    const steps = r.steps;
    if (!steps?.length) return;

    // Cache the decoded route polyline per route (for perpendicular off-route).
    if (polyCacheRef.current.key !== r.polyline) {
      polyCacheRef.current = { key: r.polyline, pts: r.polyline ? decodePolyline(r.polyline) : [] };
    }

    let stepIdx = Math.min(stateRef.current.stepIndex, steps.length - 1);
    const prevStepIdx = stepIdx;
    let cur = steps[stepIdx];
    let dManeuver = haversineMeters(user, cur.end);

    while (stepIdx < steps.length - 1 && dManeuver < ADVANCE_THRESHOLD_M) {
      stepIdx += 1;
      cur = steps[stepIdx];
      dManeuver = haversineMeters(user, cur.end);
    }
    if (stepIdx !== prevStepIdx) announcedRef.current.clear();

    // Speed-aware spoken callouts. The lead distance scales with current speed
    // so a cue lands a steady few seconds before the turn at any speed, and the
    // SPOKEN distance is the live distance-to-maneuver (the SAME value the
    // on-screen banner shows via fmtDistanceM) instead of a fixed threshold
    // number — so voice and screen always agree.
    if (!options?.mute) {
      const spd = Math.max(0, user.speed ?? 0);
      const imminentM = Math.min(IMMINENT_MAX_M, Math.max(IMMINENT_MIN_M, spd * IMMINENT_LEAD_S));
      const prepareM = Math.min(PREPARE_MAX_M, Math.max(PREPARE_MIN_M, spd * PREPARE_LEAD_S));
      const prepKey = `${stepIdx}-prep`;
      const immKey = `${stepIdx}-imm`;
      const isFinal = stepIdx >= steps.length - 1;
      // ONE-SHOT START CUE — the first thing Nova says once guidance is free (the
      // greeting finished, or there was none): whatever maneuver is next from the
      // CURRENT position, regardless of the distance threshold. Marked announced so
      // the normal "prepare" callout for the same step doesn't immediately repeat it.
      if (pendingStartCueRef.current && !isAudioBusy()) {
        pendingStartCueRef.current = false;
        if (!announcedRef.current.has(prepKey)) {
          if (isFinal) {
            speak(`In ${fmtDistanceM(dManeuver)}, you will arrive at your destination.`);
          } else {
            const ns = steps[stepIdx + 1];
            const ra = roundaboutExitCue(ns.maneuver, ns.html);
            const v = maneuverVerb(ns.maneuver);
            const street = stripDirections(ns.html);
            speak(ra
              ? `In ${fmtDistanceM(dManeuver)}, ${ra.toLowerCase()}.`
              : `In ${fmtDistanceM(dManeuver)}, ${v.toLowerCase()}${street ? " onto " + street : ""}.`);
          }
          announcedRef.current.add(prepKey);
          lastSpokeRef.current = Date.now();
        }
      }
      if (isFinal) {
        // Final leg → arrival heads-up only; the actual "You have arrived" +
        // onArrive fire from the dManeuver < 20 block below.
        if (dManeuver <= prepareM && !announcedRef.current.has(prepKey)) {
          speak(`In ${fmtDistanceM(dManeuver)}, you will arrive at your destination.`);
          announcedRef.current.add(prepKey);
        }
      } else {
        const nextStep = steps[stepIdx + 1];
        // Less-intrusive filter: only speak for actual maneuvers, not "continue
        // straight" filler. (#6)
        if (isSpokenManeuver(nextStep.maneuver, nextStep.html)) {
          // Roundabouts: speak the EXIT ("take the second exit") with NO road
          // names. Everything else keeps the normal verb (+ onto street) phrasing.
          const roundabout = roundaboutExitCue(nextStep.maneuver, nextStep.html);
          const verb = maneuverVerb(nextStep.maneuver);
          const inst = stripDirections(nextStep.html);
          if (dManeuver <= imminentM && !announcedRef.current.has(immKey)) {
            speak(roundabout ? `${roundabout}.` : `${verb}.`);
            announcedRef.current.add(immKey);
            announcedRef.current.add(prepKey); // a "prepare" this late would be noise
          } else if (dManeuver <= prepareM && !announcedRef.current.has(prepKey)) {
            speak(roundabout
              ? `In ${fmtDistanceM(dManeuver)}, ${roundabout.toLowerCase()}.`
              : `In ${fmtDistanceM(dManeuver)}, ${verb.toLowerCase()}${inst ? " onto " + inst : ""}.`);
            announcedRef.current.add(prepKey);
          }
        }
      }
    }

    // Off-route by PERPENDICULAR distance to the route LINE — not distance to the
    // step's endpoints (which falsely flagged off-route in the middle of a long
    // highway step → the underpass/bridge detours). Require it to persist ≥2 GPS
    // ticks so a transient spike under an underpass doesn't trigger a reroute.
    const routePts = polyCacheRef.current.pts;
    if (routePts.length >= 2) {
      const info = nearestRouteInfo(user.lat, user.lng, routePts);
      const dRoute = info.distM;
      // Heading gate: a big perpendicular distance only counts as a real
      // departure when the car's heading ALSO diverges from the route's local
      // direction. Driving straight down a highway while GPS multipath off an
      // overpass throws the fix sideways keeps the heading aligned — so it no
      // longer counts as off-route. With no heading we can't disprove a
      // departure, so we fall back to distance-only (headingOff = true).
      const hdg = user.heading;
      let headingOff = true;
      if (typeof hdg === "number" && hdg >= 0 && !Number.isNaN(info.bearingDeg)) {
        let dHdg = Math.abs(hdg - info.bearingDeg) % 360;
        if (dHdg > 180) dHdg = 360 - dHdg;
        headingOff = dHdg > OFFROUTE_HEADING_TOL_DEG;
      }
      // Count ANY tick that's off the line by more than the threshold. The heading
      // gate no longer SUPPRESSES the count — that was the bug behind the "~1 minute
      // to recalculate": on a road PARALLEL to the route the heading stays aligned,
      // so the streak reset every tick and a reroute never fired until the roads
      // finally diverged. Heading now feeds the TRIP threshold instead, so real
      // departures act in ~2-3 s while a transient multipath spike (a brief sideways
      // fix with aligned heading) still gets ridden out.
      const conclusivelyOff = dRoute > REROUTE_DISTANCE_M * 2;   // >160 m: GPS multipath can't explain this
      if (dRoute > REROUTE_DISTANCE_M) offRouteStreakRef.current += 1;
      else offRouteStreakRef.current = 0;
      // Trip fast when the evidence is strong, slower when it's marginal:
      //   • conclusively off (>160 m)      → 2 ticks (~2 s), heading irrelevant
      //   • off + heading diverging (>55°) → 3 ticks (~3 s): a real wrong turn
      //   • off but heading still aligned  → 6 ticks (~6 s): a SUSTAINED offset,
      //     not a momentary multipath spike (the parallel-road departure)
      const tripped =
        conclusivelyOff ? offRouteStreakRef.current >= 2 :
        headingOff      ? offRouteStreakRef.current >= 3 :
                          offRouteStreakRef.current >= 6;
      if (tripped) {
        const now = Date.now();
        if (now - lastOffRouteAtRef.current > 8000) {
          lastOffRouteAtRef.current = now;
          offRouteStreakRef.current = 0;
          options?.onOffRoute?.();
        }
      }
    }

    let remaining = dManeuver;
    for (let i = stepIdx + 1; i < steps.length; i++) remaining += steps[i].distance_m;
    const eta = (remaining / Math.max(r.distance_m, 1)) * r.duration_s;

    const arriveKey = `${steps.length - 1}-arrived`;
    if (stepIdx === steps.length - 1 && dManeuver < 20 && !announcedRef.current.has(arriveKey)) {
      announcedRef.current.add(arriveKey);   // fire once, not on every parked GPS tick
      if (!options?.mute) speak(arrivalLine());
      options?.onArrive?.();
    }

    const next: TbtState = { active: true, stepIndex: stepIdx, distanceToManeuverM: dManeuver, distanceRemainingM: remaining, etaSeconds: eta };
    stateRef.current = next;
    setState(next);
  }, [active, user?.lat, user?.lng]);

  return state;
}

// ---- Speech helper ----
// Spoken-direction playback rate (1.0 = normal). Nudged a touch ABOVE normal so
// Nova's callouts feel brisk rather than sluggish. Pitch is corrected on both
// web and native (preservesPitch / shouldCorrectPitch), so faster playback
// speeds her up without chipmunking her voice.
const NAV_TTS_RATE = 1.05;

// Normalize text for natural speech: spell out street-type AND unit
// abbreviations so the TTS voice never reads "min", "km", or "Rd" literally.
// Unit expansions are anchored to a preceding digit so ordinary words are
// never mangled (the "m" in "Salmon Ave" is left alone).
function toSpeech(s: string): string {
  if (!s) return s;
  let out = s
    // Street / road types
    .replace(/\bRd\b\.?/g, "Road")
    .replace(/\bAve\b\.?/g, "Avenue")
    .replace(/\bBlvd\b\.?/g, "Boulevard")
    .replace(/\bDr\b\.?/g, "Drive")
    .replace(/\bHwy\b\.?/g, "Highway")
    .replace(/\bPkwy\b\.?/g, "Parkway")
    .replace(/\bCres\b\.?/g, "Crescent")
    .replace(/\bCt\b\.?/g, "Court")
    .replace(/\bPl\b\.?/g, "Place")
    .replace(/\bLn\b\.?/g, "Lane")
    .replace(/\bSq\b\.?/g, "Square")
    .replace(/\bTrl\b\.?/g, "Trail")
    .replace(/\bSt\b\.?(?!\s+[A-Z])/g, "Street");
  // Units — only when attached to a number, so plain words are never touched.
  // Order matters: longer/space forms before the bare "m".
  out = out
    .replace(/(\d(?:\.\d+)?)\s*km\b/gi, "$1 kilometers")
    .replace(/(\d(?:\.\d+)?)\s*mi\b/gi, "$1 miles")
    .replace(/(\d)\s*ft\b/gi, "$1 feet")
    .replace(/(\d)\s*min\b/gi, "$1 minutes")
    .replace(/(\d)\s*sec\b/gi, "$1 seconds")
    .replace(/(\d)\s*hr\b/gi, "$1 hours")
    .replace(/(\d)\s*h\b/g, "$1 hours")   // "1h 30m" → hours part
    .replace(/(\d)\s+m\b/g, "$1 meters")  // "500 m" (space) ⇒ meters
    .replace(/(\d)m\b/g, "$1 minutes");    // "30m" (no space) ⇒ minutes (Xh Ym)
  return out;
}

let _speakLock = false;
let _lastSpoke = 0;
// Same-phrase dedupe (see speak()): drop an EXACT-identical callout within this
// window so a split maneuver can't say "Turn left, turn left" a beat apart.
let _lastText = "";
let _lastTextAt = 0;
const SAME_TEXT_DEDUPE_MS = 6000;
let _lastRerouteSpoke = 0;
type TtsItem = string | { _greetAudio: string; mime: string };
const ttsQueue: TtsItem[] = [];
let ttsPlaying = false;
// The currently-playing TTS Sound (native) so nav teardown can stop a
// half-spoken instruction. Web playback is fire-and-forget.
let _currentSound: any = null;
// Serialize ALL clip playback so two clips can never sound at once (the confirmed
// "two voices at the same time" bug). Every playBase64Audio call awaits the prior
// one's completion before it starts; the speed ding yields via isAudioBusy() too.
let _audioChain: Promise<void> = Promise.resolve();

// ===== In-app music ducking (Apple Music / MusicKit) =====
// expo-av's `.duckOthers` already dips OTHER apps (Spotify, podcasts) while Nova
// speaks, but NOT same-app audio — so the in-app Music tab (Apple Music via
// MusicKit, an out-of-process system player) would otherwise play right over
// her. We pause it for the duration of her speech and resume after. Debounced:
// back-to-back callouts and the greeting→first-turn gap collapse into a single
// pause/resume instead of flickering. Safe by construction — see applePlayer.
let _musicDucked = false;
let _unduckTimer: ReturnType<typeof setTimeout> | null = null;

function _duckMusicForSpeech(): void {
  if (_unduckTimer) { clearTimeout(_unduckTimer); _unduckTimer = null; }
  if (_musicDucked) return;
  _musicDucked = true;
  void duckForSpeech();
}

function _restoreMusicSoon(): void {
  if (_unduckTimer) clearTimeout(_unduckTimer);
  _unduckTimer = setTimeout(() => {
    _unduckTimer = null;
    if (!_musicDucked) return;
    _musicDucked = false;
    void unduckForSpeech();
  }, 800);
}

function _restoreMusicNow(): void {
  if (_unduckTimer) { clearTimeout(_unduckTimer); _unduckTimer = null; }
  if (!_musicDucked) return;
  _musicDucked = false;
  void unduckForSpeech();
}

// ===== Duck safety watchdog =====
// The ducking audio session (setPlaybackAudioMode dips external music) is
// released only when the TTS queue fully drains. If the drain loop stalls
// between clips (a slow/stalled /tts synth, multiple queued items, or a reroute
// that never fires) the duck has NO independent release and the user's music
// stays quiet for minutes. This gives the duck its own release valve: armed
// only AFTER a clip finishes (never during active speech, so it cannot misfire
// mid-callout) and force-restores music if no new clip starts within
// DUCK_MAX_MS. Normal back-to-back callouts re-arm it; a normal drain clears it,
// so it is inert during ordinary navigation and only fires on a genuine stall.
let _duckWatchdog: ReturnType<typeof setTimeout> | null = null;
const DUCK_MAX_MS = 12000;
function _armDuckWatchdog(): void {
  if (_duckWatchdog) clearTimeout(_duckWatchdog);
  _duckWatchdog = setTimeout(() => {
    _duckWatchdog = null;
    // Held too long with nothing playing — force music back to full volume.
    _restoreMusicNow();
    void setIdleAudioMode();
  }, DUCK_MAX_MS);
}
function _clearDuckWatchdog(): void {
  if (_duckWatchdog) { clearTimeout(_duckWatchdog); _duckWatchdog = null; }
}

// ===== Background restore =====
// If a Nova callout ducked the music (Apple Music paused + the .duckOthers session)
// and the app is backgrounded/locked BEFORE the 800ms/12s restore timers fire, iOS
// suspends the JS runtime and those timers never run — Apple Music stays paused +
// external audio ducked until the app is reopened. Flush the restore synchronously
// on the way to background, BUT only when we're ducked AND nothing is actively
// speaking (`!ttsPlaying`), so we never un-duck over an in-flight background callout
// (which keeps the runtime alive and self-restores normally anyway). Registered once.
AppState.addEventListener("change", (s) => {
  if (s === "active") return;
  if (_musicDucked && !ttsPlaying) {
    _restoreMusicNow();
    void setIdleAudioMode();
  }
});

// ---- Route-start greeting coordination ----
// The personable Nova greeting must ALWAYS play before the first turn callout,
// with a clear pause between them. The greeting text is fetched async, so the
// instant routing begins the caller reserves a "greeting in flight" hold
// (reserveGreeting). While that hold is up, turn callouts (e.g. the engine's
// "Starting navigation\u2026") are PARKED — not dropped, not spoken. When the greeting
// arrives, deliverGreeting leads the queue with the greeting + a pause + a
// sentinel that clears the hold and replays the parked callout. If the fetch
// fails or times out, cancelGreeting releases the parked callout immediately.
const PAUSE_TOKEN = "\u0000pause:";            // followed by milliseconds
const GREETING_DONE_TOKEN = "\u0000greetdone"; // clears the hold + flushes
const GREETING_PAUSE_MS = 1200;               // gap between greeting and 1st turn
let _greetingInFlight = false;
let _greetingTimer: ReturnType<typeof setTimeout> | null = null;
let _heldSpeech: string | null = null;        // latest parked turn callout (raw)

// True while any Nova/greeting clip is sounding (or a greeting is being prepared).
// The turn engine's start cue waits on this (so it speaks AFTER the greeting), and
// the speed ding waits on it too so a chime never sounds on top of a clip. A `function`
// so it's hoisted/callable from the earlier turn engine.
export function isAudioBusy(): boolean {
  return _greetingInFlight || ttsPlaying || _currentSound != null;
}

export function reserveGreeting(): void {
  _greetingInFlight = true;
  _heldSpeech = null;
  if (_greetingTimer) clearTimeout(_greetingTimer);
  // Safety valve: never hold the first instruction more than 4s on a slow or
  // failed backend call.
  _greetingTimer = setTimeout(() => { if (_greetingInFlight) cancelGreeting(); }, 8000);
}

export function deliverGreeting(text: string): void {
  if (_greetingTimer) { clearTimeout(_greetingTimer); _greetingTimer = null; }
  if (!_greetingInFlight) return;             // already cancelled / timed out
  if (getSettings().novaVoice === false) { cancelGreeting(); return; }  // master Nova off
  const t = (text || "").trim();
  if (!t) { cancelGreeting(); return; }
  // Lead the queue: greeting, then a pause, then the hold-clear sentinel.
  ttsQueue.unshift(toSpeech(t), PAUSE_TOKEN + GREETING_PAUSE_MS, GREETING_DONE_TOKEN);
  _lastSpoke = Date.now();
  if (!ttsPlaying) drainTtsQueue();
}

// Like deliverGreeting, but plays PRE-SYNTHESIZED audio (prepared during the
// route preview) so the greeting starts instantly at Start with no /tts hop.
export function deliverGreetingAudio(b64: string, mime: string): void {
  if (_greetingTimer) { clearTimeout(_greetingTimer); _greetingTimer = null; }
  if (!_greetingInFlight) return;
  if (getSettings().novaVoice === false) { cancelGreeting(); return; }  // master Nova off
  if (!b64) { cancelGreeting(); return; }
  ttsQueue.unshift({ _greetAudio: b64, mime: mime || "audio/mp3" }, PAUSE_TOKEN + GREETING_PAUSE_MS, GREETING_DONE_TOKEN);
  _lastSpoke = Date.now();
  if (!ttsPlaying) drainTtsQueue();
}

export function cancelGreeting(): void {
  if (_greetingTimer) { clearTimeout(_greetingTimer); _greetingTimer = null; }
  _greetingInFlight = false;
  _flushHeldSpeech();
}

function _flushHeldSpeech(): void {
  const held = _heldSpeech;
  _heldSpeech = null;
  if (held) {
    ttsQueue.push(toSpeech(held));
    if (!ttsPlaying) drainTtsQueue();
  }
}

function speak(text: string) {
  if (!text || !text.trim()) return;
  // Master Nova voice switch (settings). Off → nothing speaks at all.
  if (getSettings().novaVoice === false) return;
  // While the route-start greeting is in flight, park the latest turn callout
  // so the greeting always leads (it's replayed once the greeting + pause end).
  if (_greetingInFlight) { _heldSpeech = text; return; }
  const now = Date.now();
  if (now - _lastSpoke < 1500) return;
  // Same-phrase dedupe: kills the "Turn left, turn left" double that happens when
  // the Routes API splits one maneuver into two adjacent same-direction steps and
  // each fires the identical bare verb a couple seconds apart. Only EXACT repeats
  // within the window are dropped — prepare callouts ("In 300 m, turn left onto X")
  // and opposite turns differ as strings, so real guidance is untouched. Window is
  // short enough that two genuinely distinct identical turns can't fall inside it.
  if (text === _lastText && now - _lastTextAt < SAME_TEXT_DEDUPE_MS) return;
  _lastText = text;
  _lastTextAt = now;
  _lastSpoke = now;
  ttsQueue.push(toSpeech(text));
  if (!ttsPlaying) drainTtsQueue();
}

function resetSpeakGate() {
  _speakLock = false;
  _lastSpoke = 0;
  _lastText = "";
  _lastTextAt = 0;
  ttsQueue.length = 0;
  ttsPlaying = false;
  // Clear any in-flight greeting hold so a fresh nav session starts clean.
  _greetingInFlight = false;
  _heldSpeech = null;
  if (_greetingTimer) { clearTimeout(_greetingTimer); _greetingTimer = null; }
  // Nav stopped/cleared — let any ducked in-app music come back immediately.
  _clearDuckWatchdog();
  _restoreMusicNow();
  // ...and release the ducking audio session so external music (Spotify etc.)
  // returns to full volume the moment nav ends, not just when the queue drains.
  // BUT only when Nova voice is actually on: with the readout toggled off we never
  // play anything here, so grabbing the audio session just needlessly re-routes the
  // user's own music. Leaving it untouched keeps their stereo (A2DP) intact.
  if (getSettings().novaVoice !== false) void setIdleAudioMode();
}

// Reroute is intentionally SILENT. Convoy used to speak "Recalculating route."
// here, but it was intrusive on drives, so the spoken callout is removed
// entirely. The route itself still recomputes in the background via the
// off-route handler in the map screen — we just never announce it out loud.
// The throttle/timestamp is kept so stopSpeech() stays consistent.
export function announceReroute() {
  const now = Date.now();
  if (now - _lastRerouteSpoke < 12000) return;
  _lastRerouteSpoke = now;
  // (no speech — see note above)
}

// General-purpose Nova announcement (e.g. hazard-report confirmations) — uses
// the same queue as turn instructions so nothing ever talks over anything else.
export function announce(text: string) {
  speak(text);
}

// Stop nav speech immediately — clears the queue AND the in-flight playback so
// a half-spoken instruction doesn't linger after End / Clear.
export function stopSpeech() {
  resetSpeakGate();
  _lastRerouteSpoke = 0;
  try { _currentSound?.stopAsync?.(); } catch {}
  try { _currentSound?.unloadAsync?.(); } catch {}
  _currentSound = null;
}

async function drainTtsQueue(): Promise<void> {
  if (ttsQueue.length === 0) {
    ttsPlaying = false;
    _clearDuckWatchdog();
    _restoreMusicSoon();
    // Queue fully drained — release the ducking audio session so EXTERNAL music
    // (Spotify, podcasts) returns to full volume. Without this the session stays
    // in .duckOthers and the user's music is stuck quiet until they force-quit.
    void setIdleAudioMode();
    return;
  }
  ttsPlaying = true;
  const item = ttsQueue.shift()!;
  if (typeof item !== "string") {
    // Pre-synthesized greeting audio (prepared during preview, no /tts hop).
    try { await playBase64Audio(item._greetAudio, item.mime); } catch {}
  } else if (item === GREETING_DONE_TOKEN) {
    // Greeting + pause finished — release the hold and replay the parked turn.
    _greetingInFlight = false;
    _flushHeldSpeech();
  } else if (item.startsWith(PAUSE_TOKEN)) {
    const ms = parseInt(item.slice(PAUSE_TOKEN.length), 10) || 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  } else {
    try { await speakOne(item); } catch {}
  }
  drainTtsQueue();
}

async function speakOne(text: string): Promise<void> {
  try {
    const { data } = await api.post("/tts", { text, voice: getNovaVoice() });
    if (data?.audio_b64) {
      await playBase64Audio(data.audio_b64, data.mime ?? "audio/mp3");
    }
  } catch {
    // TTS unavailable: stay silent. The on-screen nav banner still shows the
    // turn, and we no longer fall back to the robotic device voice.
  }
}

async function playBase64Audio(b64: string, mime: string): Promise<void> {
  // Serialize: wait for any in-flight clip to finish before starting this one, so two
  // clips can NEVER sound at the same time (the confirmed two-voices bug). Even if a
  // stale/re-entrant caller races the drain, the second clip queues behind the first
  // instead of overlapping it.
  const prev = _audioChain;
  let release: () => void = () => {};
  _audioChain = new Promise<void>((r) => { release = r; });
  try { await prev; } catch {}
  try {
    await _playClip(b64, mime);
  } finally {
    release();
  }
}

async function _playClip(b64: string, mime: string): Promise<void> {
  // Mute-during-calls: skip Nova entirely while on a call (nav callouts, greeting & quips
  // all route through here) so she isn't loud over the call. Settings → Mute During Calls.
  if (callSilence()) return;
  if (Platform.OS === "web") {
    return new Promise((resolve) => {
      try {
        const audio = new Audio(`data:${mime};base64,${b64}`);
        audio.playbackRate = NAV_TTS_RATE;
        (audio as any).preservesPitch = true;
        audio.volume = getAudioVol(getSettings(), "volVoice");
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      } catch { resolve(); }
    });
  }
  try {
    const { Audio } = await import("expo-av");
    const FileSystem = await import("expo-file-system/legacy");
    const ext = mime.includes("wav") ? "wav" : "mp3";
    const path = FileSystem.cacheDirectory + `tts_${Date.now()}.${ext}`;
    await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
    // Route to the loudspeaker at full volume. After a PTT recording the iOS
    // session is left in .playAndRecord, which sends playback to the quiet
    // earpiece — that's what made the nav voice sound faint. Forcing playback
    // mode (the same helper comms uses) puts Nova back on the main speaker, and
    // volume:1.0 overrides expo-av's ~0.5 default (so it's markedly louder).
    // Pause in-app Apple Music ONLY here — at actual playback — not back when the
    // callout was queued. The /tts synthesis hop runs with music still playing,
    // so there's no dead-air gap before Nova and the pause lasts only for her
    // speech. (Apple Music exposes no volume API, so pause is the only lever;
    // external apps like Spotify are smoothly dipped by the duck audio session.)
    _duckMusicForSpeech();
    await setPlaybackAudioMode();
    return new Promise((resolve) => {
      // Watchdog: resolve no matter what so a stalled/never-finishing clip can't
      // wedge the queue and leave music paused for ages (the "music quit for no
      // reason, came back a minute later" bug).
      let done = false;
      const finish = () => { if (done) return; done = true; _armDuckWatchdog(); resolve(); };
      const watchdog = setTimeout(finish, 15000);
      // Gentle volume FADE so Nova eases IN and OUT instead of snapping on/off
      // over the music (the "abrupt ducking" complaint). On a phone call she also
      // sits at a lower ducked level (0.22) so she isn't loud over the call.
      // NOTE: Apple Music itself can't be volume-faded (MusicKit gives apps no
      // volume control — it's a hard pause), so this fades NOVA's voice; external
      // apps (Spotify/podcasts) are already ramped by iOS's duck session.
      const onCall = isOnCall();
      // Tester-tunable Voice level (Settings → Audio) scales the whole fade envelope.
      const target = (onCall ? 0.22 : 1.0) * getAudioVol(getSettings(), "volVoice");
      const startV = Math.min(target, 0.05);     // ease in from near-silent
      const FADE_IN_MS = 180, FADE_OUT_MS = 240, STEPS = 4;
      Audio.Sound.createAsync({ uri: path }, { shouldPlay: true, rate: NAV_TTS_RATE, shouldCorrectPitch: true, volume: startV })
        .then(({ sound, status: initStatus }) => {
          _currentSound = sound;
          sound.setVolumeAsync(startV).catch(() => {});
          // Fade IN to the target over ~FADE_IN_MS. Fire-and-forget; if the clip
          // ends first these no-op on the unloaded sound.
          for (let i = 1; i <= STEPS; i++) {
            const v = startV + (target - startV) * (i / STEPS);
            setTimeout(() => { sound.setVolumeAsync(v).catch(() => {}); }, Math.round((FADE_IN_MS / STEPS) * i));
          }
          // Fade OUT just before the clip ends (when the duration is known and the
          // clip is long enough that in+out won't overlap). Account for the TTS rate
          // since the clip finishes faster than the source durationMillis at rate>1.
          const durMs = typeof (initStatus as any)?.durationMillis === "number" ? (initStatus as any).durationMillis : 0;
          const effDur = durMs / (NAV_TTS_RATE || 1);
          if (effDur > FADE_IN_MS + FADE_OUT_MS + 200) {
            const outAt = effDur - FADE_OUT_MS;
            for (let i = 1; i <= STEPS; i++) {
              const v = target * (1 - i / STEPS);
              setTimeout(() => { sound.setVolumeAsync(Math.max(0, v)).catch(() => {}); }, Math.round(outAt + (FADE_OUT_MS / STEPS) * i));
            }
          }
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (!status?.isLoaded || status?.didJustFinish) {
              if (_currentSound === sound) _currentSound = null;
              sound.unloadAsync().catch(() => {});
              FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
              clearTimeout(watchdog);
              finish();
            }
          });
        })
        .catch(() => { clearTimeout(watchdog); finish(); });
    });
  } catch { return; }
}

function stripDirections(s: string): string {
  return (s || "")
    .replace(/^(Continue\s+(on\s+)?|Head\s+\w+\s+(on\s+)?|Take\s+|Turn\s+\w+\s+(onto\s+)?)/i, "")
    .replace(/\s+toward\b.*$/i, "")
    .replace(/\.?\s*(Destination|The\s+destination)\b.*$/i, "")
    .trim();
}

export function fmtDistanceM(m: number): string {
  if (m < 1) return "now";
  return formatDistance(m);
}

// Maneuver-banner distance. Testers want KILOMETRES, not "800 m", so show km from
// 300 m up and metres only on the final approach (<300 m) where the exact figure
// matters. mph regions keep the standard feet/miles readout. Used by BOTH the phone
// banner AND the CarPlay strip so the two read identically.
export function fmtManeuverDist(m: number): string {
  if (getSettings().speedUnit === "mph") return fmtDistanceM(m);
  if (m < 1) return "now";
  if (m < 300) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function fmtEtaSec(s: number): string {
  return formatDuration(s);
}
