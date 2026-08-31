// Navigation engine — MAPBOX Directions + turn-by-turn step machine.
//
// ⚠ THIS HEADER USED TO SAY "Google Routes API v2 (computeRoutes)". That was TRUE
// until 2026-06-14 (`fcaebc8`), when routing moved to Mapbox alongside the map
// engine — and the comment was never updated, so for two months the file's own
// header contradicted its imports. It got repeated back to Jeff as fact on
// 2026-08-27. There is now NO Google routing call anywhere in the app: grep
// `computeRoutes|routes.googleapis` and the only hits are comments.
//
// Routing is 100% Mapbox: fetchMapboxRoutes (alternatives), fetchMapboxRouteVia
// (stops + the AI route's habitual-path replay), refreshMapboxRoute (live ETA).
// Google is still used, but NOT for routing — Places autocomplete
// (DestinationSearch), voice place/geocode lookups (voiceBus), one reverse-geocode
// for country->units (map.tsx), and Sign in with Google (auth). Those are separate
// decisions from the routing engine; do not "consolidate" them by assuming.

import { useEffect, useRef, useState } from "react";
import { Platform, AppState } from "react-native";
import { api } from "./api";
import { fetchMapboxRoutes, fetchMapboxRouteVia, refreshMapboxRoute, arrivesOnFarSide, type MapboxRoute, type MapboxRouteStep, type CongestionLevel } from "./mapboxDirections";
import { logEvent, logEventReliable } from "./crashBreadcrumb";
import { anchorStepIndex } from "./navAnchor";
import { getSettings, getNovaVoice, getAudioVol } from "./settings";
import { setPlaybackAudioMode, setIdleAudioMode } from "./audioMode";
import { duckForSpeech, unduckForSpeech } from "./applePlayer";
import { isOnCall, callSilence } from "./callState";
// Head-unit liveness for the arrival silence backstop below. locationPrivacy imports
// only AsyncStorage / Platform / settings, so this cannot close a cycle back to nav.
import { headUnitAttachedRaw } from "./locationPrivacy";

export type LatLng = { lat: number; lng: number };

export type NavStep = {
  html: string;
  distance_text: string;
  distance_m: number;
  duration_text: string;
  // Traffic-aware seconds for THIS step, straight off Mapbox. Mapbox has always sent
  // it (MapboxRouteStep.duration); we used to format it to `duration_text` and throw
  // the number away, which forced the ETA to guess with a flat distance ratio — see
  // the ETA block in useTurnByTurn for what that cost. Optional because a NavStep can
  // be rebuilt from a cached/legacy route that predates this field; the ETA falls back
  // when it's missing.
  duration_s?: number;
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
  // Per-SEGMENT traffic-aware seconds (same axis as `congestion` / `coordinates`).
  // The ETA is summed from these — see the ETA block in useTurnByTurn. Optional for
  // legacy/cached route shapes, which fall back to step durations then to a ratio.
  segDurations?: number[];
  // Directions Refresh handle: lets navigation pull UPDATED durations + congestion
  // for this exact geometry mid-drive (traffic, construction) without re-routing.
  refreshUuid?: string;
  routeIndex?: number;
  steps: NavStep[];
  // Route SLOT for the 3-route system. "best" (fastest) / "scenic" (alternate) are
  // assigned positionally by the map; "ai" is set here by fetchAiRoute for a learned
  // habitual route (drawn black-core + user-edges). Absent = positional default.
  kind?: "best" | "scenic" | "ai" | "alt";
  // Optional per-route preview color (legacy field, still set by map.tsx's rank-color).
  color?: string;
  /** Via routes: road-snapped interior waypoints (see MapboxRoute.viaSnapped). */
  viaSnapped?: ({ lat: number; lng: number } | null)[];
  /** Via routes: metres each pin was snapped to reach a road (see MapboxRoute.viaSnapDistM). */
  viaSnapDistM?: (number | null)[];
};

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

// ---- Route fetch (MAPBOX Directions — see the file header) ----
// Returns NavRoute[], the shape every caller (map.tsx, the car surfaces, the turn
// engine) consumes. The "Routes API v2 / computeRoutes" this comment used to name
// is Google's and has not been called since 2026-06-14.
export async function fetchRoutes(
  origin: LatLng,
  destination: LatLng,
  avoid?: AvoidPrefs
): Promise<NavRoute[]> {
  // Routing now comes from Mapbox Directions (driving-traffic), replacing Google
  // Routes API. Same signature + NavRoute/NavStep shape, so every caller (map.tsx,
  // the turn-by-turn machine, the greeting, CarPlay formatters) is unchanged.
  let mbRoutes: MapboxRoute[] = [];
  // TIMEOUT (2026-08-21). Verified on rkoji7-061995's drive: 20 off-route refetches
  // issued 06:29-06:33 PT ALL resolved in one 300 ms burst at 06:36:24 while Supabase
  // inserts from the same phone flowed within 0.2 s — the route fetches hung, the
  // stale one that resolved last became the live route, and nav never recovered.
  // No fetch here had any timeout. 15 s is well past a normal Directions round
  // trip; a hung request now fails instead of surfacing minutes later.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ROUTE_FETCH_TIMEOUT_MS);
  try {
    mbRoutes = await fetchMapboxRoutes(
      origin,
      destination,
      { tolls: !!avoid?.tolls, highways: !!avoid?.highways, ferries: !!avoid?.ferries },
      { signal: ctl.signal },
    );
    if (!mbRoutes.length) return [];
    mbRoutes = await preferCurbArrival(origin, destination, avoid, mbRoutes, ctl.signal);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  return mbRoutes.map(mapboxToNavRoute).filter((r: NavRoute) => r.polyline);
}
const ROUTE_FETCH_TIMEOUT_MS = 15000;

// ── ARRIVE ON THE DRIVER'S SIDE, WHEN IT IS CHEAP (2026-07-31) ──────────────
// Jeff: "the GPS needs to be a little mindful on which side of the road the
// destination is ... to route correctly to it."
//
// Mapbox's `approaches=unrestricted;curb` does exactly that. It is NOT free, and
// "a little mindful" is the whole design — measured against the live API over six
// real Vancouver origin/destination pairs:
//
//   quiet residential / mall / one-way / suburban   +0 m   +0 s   (already correct)
//   highway-adjacent                              +492 m   +1 s
//   Broadway (divided arterial)                   +917 m +227 s  (+47%)
//
// So four in six cost nothing, one costs a second, and one would have added nearly
// four minutes to an eight-minute trip. Forcing curb everywhere would be a bad trade;
// never using it is what Jeff is complaining about. Take it when it is cheap.
//
// The second request only fires when it can possibly help: the ARRIVE step already
// tells us the side (maneuver.modifier vs driving_side), so the common case costs no
// extra Directions call at all. Raw fields, never parsed English.
// ── TIGHTENED AFTER THE FIRST REAL DRIVE (2026-07-31) ──────────────────────
// Jeff's lunch run, on the build that first carried this: "I was approaching the
// destination and it took me around the building."
//
// 90 s / 25% was MY number, not the data's. The measured benefit was +0 s (four of six
// pairs) and +1 s; the measured harm was +227 s. Nothing in that supported 90. And on a
// SHORT trip the fraction stops protecting anything: a 5-minute lunch run allowed a
// 75-second detour — a quarter again on the trip, which is precisely "around the
// building".
// 20 s / 10% keeps every measured win with a 20x margin and rejects anything a driver
// would notice. If a genuinely useful curb route ever costs more than 20 s, the honest
// answer is to OFFER it, not to take it silently.
const CURB_MAX_EXTRA_S = 20;
const CURB_MAX_EXTRA_FRAC = 0.10;
// ── AND A DISTANCE AXIS (2026-07-31) ───────────────────────────────────────
// Time alone is not a sufficient budget: my own measurements include a curb route that
// cost +492 m for +1 s. Under a seconds-only rule that is a "free" win that silently
// adds half a kilometre of driving — the literal shape of "it took me around the
// building". Calibrated against those same pairs so the cheap win survives and the bad
// one dies twice over: BOTH conditions must hold to reject, so
//   highway-adjacent  +492 m on a 14199 m route -> 492 > 250 but < 15% -> KEPT
//   Broadway          +917 m on a 2702 m route  -> 917 > 250 and > 15%  -> REJECTED
const CURB_MAX_EXTRA_M = 250;
const CURB_MAX_EXTRA_DIST_FRAC = 0.15;
async function preferCurbArrival(
  origin: LatLng,
  destination: LatLng,
  avoid: AvoidPrefs | undefined,
  routes: MapboxRoute[],
  signal?: AbortSignal,
): Promise<MapboxRoute[]> {
  try {
    const best = routes[0];
    if (!best || !arrivesOnFarSide(best)) return routes;   // already correct side
    const curb = await fetchMapboxRoutes(
      origin,
      destination,
      { tolls: !!avoid?.tolls, highways: !!avoid?.highways, ferries: !!avoid?.ferries },
      { curbApproach: true, signal },
    );
    const alt = curb[0];
    if (!alt || !alt.polyline || arrivesOnFarSide(alt)) return routes;  // no better
    const extra = alt.duration_s - best.duration_s;
    const extraM = alt.distance_m - best.distance_m;
    const tooSlow = extra > CURB_MAX_EXTRA_S || extra > best.duration_s * CURB_MAX_EXTRA_FRAC;
    const tooFar = extraM > CURB_MAX_EXTRA_M && extraM > best.distance_m * CURB_MAX_EXTRA_DIST_FRAC;
    // RECEIPT. Whether this fired, and at what cost, has so far been inferred from
    // photographs — twice, with two different conclusions. One row per decision ends that.
    try {
      logEvent(`curb ${tooSlow || tooFar ? 'rejected' : 'TAKEN'} extra_s=${Math.round(extra)} extra_m=${Math.round(extraM)} base_s=${Math.round(best.duration_s)} base_m=${Math.round(best.distance_m)}`);
    } catch {}
    if (tooSlow || tooFar) return routes;
    // Replace only the PRIMARY line. The alternatives stay as they were, so the driver
    // can still pick a different route entirely and nothing else about the fan-out moves.
    return [alt, ...routes.slice(1)];
  } catch {
    return routes;   // routing must never fail because of a side-of-road nicety
  }
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
    viaSnapped: r.viaSnapped,
    viaSnapDistM: r.viaSnapDistM,
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
    segDurations: r.segDurations,
    refreshUuid: r.refreshUuid,
    routeIndex: r.routeIndex,
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
        duration_s: s.duration,
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
// Tester feedback (2026-07-16): callouts landed "as I'm already turning". Two
// stacked lags — the cue armed only 7s out, and speakOne() then did a LIVE /tts
// HTTP synth (1–3s on cellular) before any sound. Lead raised to ~10s / 60m min,
// and the imminent phrase is now PRE-SYNTHESIZED at prepare time (see
// prefetchTts) so "Turn right." plays from cache with zero network wait.
const IMMINENT_LEAD_S = 10;    // "Turn now" cue ~10 s out
const IMMINENT_MIN_M = 60;
const IMMINENT_MAX_M = 250;
const PREPARE_LEAD_S = 30;     // "In X, turn …" heads-up ~30 s out
const PREPARE_MIN_M = 150;
const PREPARE_MAX_M = 1200;
const ADVANCE_THRESHOLD_M = 25;
// ── ARRIVAL ─────────────────────────────────────────────────────────────────
// Auto-finish has always existed (map.tsx's onArrive does the full teardown), but
// it only ever fired on a GPS fix landing within ARRIVE_M of the destination — and
// that is the one moment the phone stops producing fixes. Both watchers set a
// distanceInterval (2 m navigating, 8 m eco, 5 m background) precisely so the OS
// drops stationary jitter, so once the car is parked NO further fix arrives and the
// effect never re-runs. Park in a lot, a driveway, or the far kerb — anywhere the
// last moving fix was >20 m from the road-snapped destination — and the route ran
// forever. Measured: only 4 auto-finished drives across all testers in three days.
//
// ARRIVE_M stays exactly as it was, so the normal case is bit-identical. The settle
// path below is purely ADDITIVE: it can only fire where nothing fired before.
// EXPORTED so the COLD car engine (navNotification's bg-task path) evaluates arrival
// with the identical numbers instead of a second copy that drifts. Same reason
// CHASE_ZOOM_CLAMP_* are exported to the car map.
export const ARRIVE_M = 20;
// "Close enough, and no longer moving." Deliberately generous on distance and
// strict on time: a red light 60 m short of the destination clears in well under
// ARRIVE_SETTLE_MS, whereas a parked car never does. Speed is the driver's own
// course speed in m/s (1.4 ≈ 5 km/h — below a crawl).
// Values chosen by SIMULATING the state machine against real arrival streams, not
// picked by feel. 50 m / 25 s is the pair where every parking case finishes and the
// only surviving false positive is a light within 50 m of the destination that holds
// longer than 25 s — at which point ending the route is nearly right anyway. 60 m /
// 20 s also fired on a 25 s light 50 m short, which is why it is not those numbers.
export const ARRIVE_SETTLE_M = 50;
export const ARRIVE_SETTLE_SPEED_MS = 1.4;
export const ARRIVE_SETTLE_MS = 25000;
// Ceiling for the SILENCE backstop's arm (2026-08-31). The backstop cannot read a
// trustworthy speed — that is the whole point — so it must not arm off one that is
// obviously still driving. 4.0 m/s (14 km/h) sits above the measured 2.5 m/s of a
// car rolling into a bay and far below anything moving through traffic: a fix at
// 21 km/h 45 m out must NOT arm a 25 s teardown. Chosen as a bound, not measured.
export const ARRIVE_SILENT_MAX_SPD_MS = 4.0;
// How late the silence timer may land and still be believed. iOS suspends JS timers
// with the screen off, so a 25 s timer can surface minutes later — by which time the
// car may be moving again with no fix having reached this screen to prove it.
export const ARRIVE_SILENT_MAX_SKEW_MS = 10000;
// The settle path is driven by fixes AND by one backup timer, because the whole
// point is that fixes may have stopped. iOS suspends JS timers while the phone is
// locked, so that timer can land arbitrarily late (the trap that once stranded the
// CarPlay alert modals). Late is FINE for the teardown — the route should be gone
// when the driver next looks — but "You have arrived" half an hour after parking is
// not, so a late fire tears down silently. Timestamp comparison, never trust the
// timer's own timing.
export const ARRIVE_SPEAK_MAX_LATE_MS = 90000;
// ── TIER 3: PARKED NEAR THE DOOR, BUT THE ROUTE STILL HAS ROAD LEFT (2026-07-31)
// Jeff's lunch run: photo 2 shows him out of the car with 142 m of route still to run,
// because the route looped the block and the destination sits across it. Neither tier
// above can fire — 142 m is 3x ARRIVE_SETTLE_M — and no choice of tier-2 radius fixes it
// without also firing mid-route.
//
// The axis that separates this from "still has far to drive" is CROW-FLY distance to the
// destination, which is small exactly when the route is doubling back around something.
// Alone it is not enough: a destination across a river or a divided highway can be 70 m
// away and 2 km to drive, and ending the route there would strand the driver. So all
// three must hold — physically close, not much road left, and stopped long enough that
// this is parking rather than traffic.
//
// Deliberately a LONG dwell. This branch is inherently less certain than tier 2, so it
// buys certainty with time; 90 s of stillness is parking, not a light.
const ARRIVE_NEAR_CROW_M = 80;
const ARRIVE_NEAR_ROUTE_M = 400;
const ARRIVE_NEAR_MS = 90000;
const REROUTE_DISTANCE_M = 80; // PERPENDICULAR distance off the route line before off-route
// ── DIVERGENCE TREND (2026-07-31) ──────────────────────────────────────────
// Jeff: "I took a different route and it took a while for the route to change, at
// least 1 min."
//
// The streak logic below is already fast ONCE you are 80 m off the line. The 80 m
// itself is the delay: turn onto a street that parallels the route and the gap opens
// slowly, so on a city grid you can drive a long way before any threshold trips. The
// missed-maneuver fast path does not help either — it needs you to have approached
// within 80 m of a maneuver first, and an early deliberate departure never does.
//
// A trend is a much better discriminator than a distance. On-route error OSCILLATES:
// GPS noise, lane changes and the simplified overview polyline all wander up and down
// around zero. A real departure MONOTONICALLY grows. So: already clearly off the line,
// growing on essentially every tick, and enough total growth that it cannot be noise.
// That fires while the gap is still ~45 m instead of waiting for 80 m.
//
// Tuned to require BOTH sustained growth and a floor well above polyline-simplification
// error (which is a fixed offset on a curve — it does not keep growing).
// TUNED BY SIMULATION over ten synthetic traces (scratchpad/offroute_sim2.js), three
// that must reroute and seven that must not. A 5-tick window was tried FIRST and was
// wrong in both directions: it fired on a 4-tick urban-canyon spike (a spurious reroute
// mid-drive — worse than the bug) and still missed the slow parallel-street case it was
// written for. The fix is a LONGER window, because that is what actually separates the
// two: a multipath spike rises fast and falls back within a few ticks, so it can never
// stay monotonic for ten; a real departure can. Result at these values, 10/10:
//   parallel street  23 s -> 10 s      urban-canyon spike   no reroute
//   gentle fork      38 s -> 19 s      two spikes in a row  no reroute
//   hard wrong turn   8 s (unchanged)  sweeping bend        no reroute
//   GPS noise / lane change / overtaking / service road beside the highway: none
const DIVERGE_MIN_M = 45;        // must already be clearly off the line
const DIVERGE_GROWTH_M = 20;     // total growth across the window
const DIVERGE_SLACK_M = 3;       // per-sample dip allowed, so one noisy fix doesn't reset
// ⚠ WINDOW IS WALL-CLOCK, NOT A TICK COUNT (corrected 2026-07-31, same day).
// It was DIVERGE_TICKS = 10 and the comment claimed "~10 s". That was wrong, and the
// error is large in the exact case this detector exists for. Fixes are gated by
// distanceInterval, not time — 2 m plugged, 8 m unplugged, 5 m background — so ten
// samples take:
//        5 km/h   10 km/h   20 km/h
//   eco    58 s     29 s      14 s
// Pulling out of a car park unplugged is the 5-10 km/h column, so the "reroute in ~10 s"
// I measured was really up to a minute. A wall-clock window is honest at any cadence.
// The sample floor keeps the anti-spike property: a multipath excursion rises and falls
// within a few seconds, so it cannot stay monotonic across a full window.
const DIVERGE_WINDOW_MS = 8000;
const DIVERGE_MIN_SAMPLES = 4;
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
// ── NAME THE DESTINATION (2026-08-05) ──────────────────────────────────────
// Jeff, arriving at his saved place "Lake": Scout said "you have arrived at ... your",
// which is the generic line read aloud and heard as a fragment. What he wants is the
// actual place — "Denny's" if he searched it, the address if he searched an address,
// and the SAVED name (Lake / Home / Work) when the destination is one of his.
//
// Two line sets, because a name has to sit in a sentence that was built for it. The
// unnamed set is unchanged, and is still what plays when we have no label — an
// arrival with no name is better than "You've arrived at ." with a hole in it.
const ARRIVAL_LINES = [
  "You've arrived at your destination.",
  "Here we are — you've made it.",
  "Arrived. Nice driving.",
  "This is it, you've reached your destination.",
  "You made it — welcome.",
  "Destination reached. Enjoy.",
];
const ARRIVAL_LINES_NAMED = [
  "You've arrived at {d}.",
  "Here we are — {d}.",
  "Arrived at {d}. Nice driving.",
  "This is it — {d}.",
  "You made it. Welcome to {d}.",
  "{d}. Destination reached.",
];
// A label only earns its way into speech if it reads as a place. Anything absurdly long
// is almost always a full formatted address with a country and postcode glued on, which
// is a mouthful mid-drive; fall back to the unnamed line rather than recite it.
const ARRIVAL_LABEL_MAX = 60;
export function cleanArrivalLabel(label?: string | null): string | null {
  let t = (label || "").trim();
  if (!t) return null;
  // Drop a trailing country/postcode tail from formatted addresses so "123 Main St,
  // Langley, BC V3A 1B2, Canada" speaks as "123 Main Street, Langley".
  const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length > 2) t = parts.slice(0, 2).join(", ");
  if (!t || t.length > ARRIVAL_LABEL_MAX) return null;
  // A bare coordinate pair is a label in name only.
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(t)) return null;
  return t;
}
export function arrivalLine(destLabel?: string | null): string {
  const name = cleanArrivalLabel(destLabel);
  if (name) {
    const set = ARRIVAL_LINES_NAMED;
    return set[Math.floor(Math.random() * set.length)].replace("{d}", name);
  }
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

// TRUE while the PHONE's turn-by-turn engine (this hook, mounted by map.tsx) is
// actively guiding. The cold CarPlay guidance path (navNotification's bg-task
// callouts — CarPlay-standalone Wave 2) checks this so BOTH engines never speak
// the same turn: the phone engine always wins while it's alive; the cold path
// covers force-quit / never-opened drives where this stays false.
// Breadcrumb cadence for the nav-eta receipt below. A plain timestamp compare, never
// a JS timer — iOS suspends timers while the phone is locked, which is exactly when a
// drive is most in need of a receipt.
const ETA_LOG_EVERY_MS = 30_000;
let lastEtaLogAt = 0;
let _tbtEngineActive = false;
export function isPhoneTbtSpeaking(): boolean { return _tbtEngineActive; }

// ── Segment-accurate time-remaining ──────────────────────────────────────────
//
// Mapbox annotates every geometry SEGMENT with its own traffic-aware duration. On a
// real Langley→Anglemont route that's 4337 segments against 16 steps, so summing the
// remaining segments is effectively exact where a step- or distance-based estimate
// has to interpolate across tens of minutes of mixed road.
//
// `suffix[i]` = seconds from the START of segment i to the destination, precomputed
// once per route so each GPS tick is O(1) instead of O(4337).
function buildSuffixSeconds(segDurations: number[] | undefined): number[] | null {
  if (!Array.isArray(segDurations) || segDurations.length === 0) return null;
  const n = segDurations.length;
  const suffix = new Array<number>(n + 1);
  suffix[n] = 0;
  let total = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = segDurations[i];
    total += Number.isFinite(v) && v > 0 ? v : 0;
    suffix[i] = total;
  }
  return total > 0 ? suffix : null;
}

// Squared-ish metric distance from P to segment AB, plus how far along AB the closest
// point sits (0..1). Equirectangular projection — over a single route segment (metres)
// the distortion is irrelevant and it avoids trig per candidate.
function pointToSegment(
  plng: number, plat: number,
  alng: number, alat: number,
  blng: number, blat: number,
): { d2: number; t: number } {
  const kx = Math.cos((plat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const ax = (alng - plng) * kx, ay = (alat - plat) * ky;
  const bx = (blng - plng) * kx, by = (blat - plat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t;
  return { d2: cx * cx + cy * cy, t };
}

// Find which segment the driver is on. Scans a WINDOW forward from the last known
// segment (driving is monotonic along the route), with a small backward allowance for
// GPS jitter, and only falls back to a full scan when nothing in the window is close —
// which is what happens after a reroute or when guidance first attaches. Without the
// window this would be 4337 distance tests on every GPS tick, which is exactly the kind
// of per-frame work that cooks the phone.
const SEG_WINDOW_AHEAD = 400;
const SEG_WINDOW_BACK = 40;
const SEG_MAX_SNAP_M = 250;   // beyond this the window result is not trusted
function findRouteSegment(
  coords: [number, number][],
  lat: number, lng: number,
  cursor: number,
): { seg: number; t: number; distM: number } | null {
  const n = coords.length - 1;
  if (n < 1) return null;
  const scan = (from: number, to: number) => {
    let bestD2 = Infinity, bestSeg = -1, bestT = 0;
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const a = coords[i], b = coords[i + 1];
      const r = pointToSegment(lng, lat, a[0], a[1], b[0], b[1]);
      if (r.d2 < bestD2) { bestD2 = r.d2; bestSeg = i; bestT = r.t; }
    }
    return { bestD2, bestSeg, bestT };
  };
  let { bestD2, bestSeg, bestT } = scan(cursor - SEG_WINDOW_BACK, cursor + SEG_WINDOW_AHEAD);
  if (bestSeg < 0 || Math.sqrt(bestD2) > SEG_MAX_SNAP_M) {
    ({ bestD2, bestSeg, bestT } = scan(0, n));      // reroute / first attach / way off
  }
  if (bestSeg < 0) return null;
  return { seg: bestSeg, t: bestT, distM: Math.sqrt(bestD2) };
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
  options?: { mute?: boolean; destLabel?: string | null; onArrive?: () => void; onOffRoute?: () => void }
) {
  const [state, setState] = useState<TbtState>({
    active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0,
  });
  const announcedRef = useRef<Set<string>>(new Set());
  const lastSpokeRef = useRef<number>(0);
  // MISSED-MANEUVER fast path: closest approach to the current step's maneuver.
  // Approached (<80 m) then receded (>min+150 m) without advancing = the driver
  // kept going past the turn/exit (tester: straight past an exit took ~30 s to
  // react, because the mainline runs parallel to the ramp and the perpendicular
  // off-route distance grows too slowly to trip the streak).
  const missRef = useRef<{ step: number; min: number } | null>(null);
  const lastOffRouteAtRef = useRef<number>(0);
  const offRouteStreakRef = useRef<number>(0);
  // Recent perpendicular distances, for the divergence trend (see DIVERGE_*).
  const divergeRef = useRef<{ t: number; d: number }[]>([]);
  const polyCacheRef = useRef<{ key: string; pts: LatLng[] }>({ key: "", pts: [] });
  const lastUserRef = useRef(user);
  lastUserRef.current = user;
  // Step-end segments of the current route, for the along-route heal below.
  const endSegsRef = useRef<{ key: string; endSegs: number[] }>({ key: "", endSegs: [] });
  const healStreakRef = useRef(0);
  // Segment-ETA state. `suffix` is rebuilt whenever the route's segment durations
  // change — which includes a live traffic REFRESH, not just a new route, so a refresh
  // takes effect on the very next GPS tick. `cursor` keeps the per-tick segment search
  // local instead of rescanning the whole geometry.
  const segSuffixRef = useRef<{ key: string; suffix: number[] | null }>({ key: "", suffix: null });
  const segCursorRef = useRef<number>(0);
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
  // Post-swap grace window: a just-swapped route was computed from a GPS fix a
  // couple of seconds old, so its first maneuver can already be under the car —
  // voicing it lands "Turn right." AS you're passing the turn. While this
  // deadline is live, maneuvers already within ~40m are marked announced
  // (banner still shows them; we just don't speak them late).
  const swapSuppressUntilRef = useRef<number>(0);
  // ── ARRIVAL SETTLE (2026-07-31) ─────────────────────────────────────────────
  // See ARRIVE_SETTLE_* below. When the driver is stopped near the destination we
  // stamp the time and arm ONE backup timer; both are cleared the moment they move
  // off again, and the whole mechanism is inert until the final step.
  const settleSinceRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireArriveRef = useRef<(late: boolean) => void>(() => {});
  // ── PARKED, BUT THE LAST FIX SAYS OTHERWISE (2026-08-31) ────────────────────
  // Tier 2 above tests `user.speed`. That field belongs to the LAST FIX THAT
  // ARRIVED, and the moment the car parks the OS stops producing fixes — so a
  // driver who rolls into a bay at 9 km/h leaves a permanent 9 km/h behind them.
  // `stopped` can then never become true, tier 2 disarms on that very fix, and
  // this effect (deps: active, user.lat, user.lng) never runs again to re-arm it.
  //
  // MEASURED, Jeff's Superstore run: step 8/8, rem=23m (ARRIVE_M is 20 — three
  // metres short), then gps=49.053873,-122.317384 spd=9 repeated IDENTICALLY at
  // 12:04:31, 12:04:44 and 12:07:31. Same point, same speed, three minutes apart.
  // The route never ended, so onArrive never ran, so recordTrip never ran: the
  // drive is missing from trips, no PB, and the AI route learned nothing.
  //
  // The honest signal for "parked" is not the speed field, it is SILENCE. Both
  // watchers set a distanceInterval (2 m navigating, 8 m eco), so a car that is
  // genuinely moving CANNOT go quiet — it trips the interval within a second or
  // two. A full dwell with no tick therefore proves the car is standing still,
  // whatever the stale speed claims.
  //
  // Kept as its OWN timer rather than widening tier 2, so every existing arrival
  // path stays bit-identical: this can only fire where nothing fired before.
  const tickSeqRef = useRef(0);
  const silentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    if (silentTimerRef.current) clearTimeout(silentTimerRef.current);
    silentTimerRef.current = null;
  }, []);

  // Disarm the settle window whenever guidance starts OR stops. Without this, a timer
  // armed while stopped near the old destination could land AFTER the driver ended the
  // route (or started a new one) and run the arrival teardown on top of it — recording
  // a second trip and dropping a route the driver had just set. Runs on both edges of
  // `active` deliberately: teardown and fresh start both invalidate any pending settle.
  useEffect(() => {
    settleSinceRef.current = null;
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
    // Same reasoning for the silence timer: a route that just started or just ended
    // must not inherit a pending arrival armed against the previous destination.
    if (silentTimerRef.current) { clearTimeout(silentTimerRef.current); silentTimerRef.current = null; }
  }, [active]);

  useEffect(() => {
    if (!active) {
      _tbtEngineActive = false; // cold CarPlay guidance may take over (Wave 2)
      resetSpeakGate();
      announcedRef.current.clear();
      hasAnnouncedStartRef.current = false;
      const cleared: TbtState = { active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0 };
      stateRef.current = cleared;
      setState(cleared);
      return;
    }
    _tbtEngineActive = true; // phone engine owns spoken guidance while active
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

  // Release spoken-guidance ownership if the phone screen unmounts mid-nav (tab
  // switch / app teardown) so the cold CarPlay path can pick the voice up.
  useEffect(() => () => { _tbtEngineActive = false; }, []);

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
      divergeRef.current = [];   // the trend is meaningless against a different line
      // A settle armed against the OLD route's destination must not survive a swap.
      settleSinceRef.current = null;
      if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
      // ...and neither may the silence backstop. Today's errand run swapped route FIVE
      // times; a timer armed against the old line's last 40 m would otherwise mature
      // against a brand-new route with kilometres left and tear it down.
      if (silentTimerRef.current) { clearTimeout(silentTimerRef.current); silentTimerRef.current = null; }
      swapSuppressUntilRef.current = Date.now() + 8000;
      // ANCHOR BY POSITION ALONG THE NEW LINE, NOT 0 (2026-08-21). A swapped-in route
      // is not always computed from where the car is now — rkoji7's was computed from
      // a point the car had left minutes earlier (car at seg 84/219 at install, step 0's
      // end already behind it). stepIndex 0 then froze for 3h10m because the advance
      // loop only ever tests the CURRENT step's end. See src/navAnchor.ts.
      let idx = 0;
      try {
        const u = lastUserRef.current;
        const coords = route?.coordinates;
        const steps = route?.steps;
        if (u && coords && coords.length >= 2 && steps?.length) {
          const a = anchorStepIndex(coords, steps, u);
          idx = a.onRoute ? a.index : 0;
          logEvent(`route-swap steps=${steps.length} coords=${coords.length} carSeg=${a.carSeg} onRoute=${a.onRoute ? 1 : 0} anchored=${idx}`);
        }
      } catch {}
      const reAnchored: TbtState = { ...stateRef.current, active: true, stepIndex: idx };
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
    // One tick per POSITION CHANGE reaching this line — NOT per delivered fix, and the
    // difference is the whole point. The effect's deps are user.lat/user.lng, so a
    // repeated fix at identical coordinates does not tick at all; that is exactly how a
    // parked car with a frozen speed reaches the silence probe below.
    // Two honest caveats, both measured by review rather than assumed:
    //   • It sits BELOW the three guard returns above and ABOVE the step-heal return, so
    //     a heal bumps the sequence without re-arming — read as "moved" downstream.
    //   • A frozen tick proves nothing about whether fixes were still being DELIVERED.
    //     The OS stops delivering when the app backgrounds without "Always" permission,
    //     which looks identical to parking from here. That ambiguity is the reason the
    //     probe below only measures and does not act.
    tickSeqRef.current += 1;

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
    if (stepIdx !== prevStepIdx) {
      // Split-maneuver corners: Google often breaks one physical turn into two
      // adjacent same-verb steps, so right after advancing, the "next" callout
      // is the SAME verb again a few dozen metres away — and the driver, still
      // IN the corner, hears "turn right" a third time (tester complaint
      // 2026-07-16). If we already voiced the turn on the step we just left and
      // the new upcoming maneuver is the same verb almost immediately (<120 m),
      // inherit the announced marks instead of re-voicing. Genuinely distinct
      // same-verb turns further out still announce normally, and the on-screen
      // banner always shows the new step regardless.
      const prevSpoke =
        announcedRef.current.has(`${prevStepIdx}-imm`) || announcedRef.current.has(`${prevStepIdx}-prep`);
      const prevNext = steps[prevStepIdx + 1];
      const newNext = steps[stepIdx + 1];
      announcedRef.current.clear();
      if (
        prevSpoke && prevNext && newNext && dManeuver < 120 &&
        maneuverVerb(newNext.maneuver) === maneuverVerb(prevNext.maneuver)
      ) {
        announcedRef.current.add(`${stepIdx}-imm`);
        announcedRef.current.add(`${stepIdx}-prep`);
      }
    }

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
      // Post-swap grace (see swapSuppressUntilRef): don't voice a maneuver the
      // car is already passing — mark it announced and let the next one speak.
      if (Date.now() < swapSuppressUntilRef.current && dManeuver < 40 && !isFinal) {
        announcedRef.current.add(immKey);
        announcedRef.current.add(prepKey);
      }
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
            const street = spokenStreet(v, ns.html);
            speak(ra
              ? `In ${fmtDistanceM(dManeuver)}, ${ra.toLowerCase()}.`
              : `In ${fmtDistanceM(dManeuver)}, ${v.toLowerCase()}${street ? " onto " + street : ""}.`);
            // Pre-synthesize the matching imminent phrase so "Turn right." plays
            // from cache the instant the turn-now cue fires (no /tts wait).
            prefetchTts(ra ? `${ra}.` : `${v}.`);
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
          const inst = spokenStreet(verb, nextStep.html);
          if (dManeuver <= imminentM && !announcedRef.current.has(immKey)) {
            speak(roundabout ? `${roundabout}.` : `${verb}.`);
            announcedRef.current.add(immKey);
            announcedRef.current.add(prepKey); // a "prepare" this late would be noise
          } else if (dManeuver <= prepareM && !announcedRef.current.has(prepKey)) {
            speak(roundabout
              ? `In ${fmtDistanceM(dManeuver)}, ${roundabout.toLowerCase()}.`
              : `In ${fmtDistanceM(dManeuver)}, ${verb.toLowerCase()}${inst ? " onto " + inst : ""}.`);
            announcedRef.current.add(prepKey);
            // Pre-synthesize the imminent phrase now (~30s out) so the turn-now
            // cue plays instantly from cache instead of waiting on a /tts hop.
            prefetchTts(roundabout ? `${roundabout}.` : `${verb}.`);
          }
        }
      }
    }

    // Track the closest approach to THIS step's maneuver (missed-turn detector).
    if (!missRef.current || missRef.current.step !== stepIdx) {
      missRef.current = { step: stepIdx, min: dManeuver };
    } else if (dManeuver < missRef.current.min) {
      missRef.current.min = dManeuver;
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
      // Divergence trend — catches the slow parallel-street departure long before the
      // 80 m threshold does. See the DIVERGE_* block for why a trend beats a distance.
      const hist = divergeRef.current;
      const nowT = Date.now();
      hist.push({ t: nowT, d: dRoute });
      while (hist.length && nowT - hist[0].t > DIVERGE_WINDOW_MS) hist.shift();
      const diverging =
        hist.length >= DIVERGE_MIN_SAMPLES &&
        nowT - hist[0].t >= DIVERGE_WINDOW_MS * 0.75 &&   // a real window, not 4 fast fixes
        dRoute > DIVERGE_MIN_M &&
        dRoute - hist[0].d > DIVERGE_GROWTH_M &&
        hist.every((v, i) => i === 0 || v.d >= hist[i - 1].d - DIVERGE_SLACK_M);
      // Trip fast when the evidence is strong, slower when it's marginal:
      //   • conclusively off (>160 m)      → 2 ticks (~2 s), heading irrelevant
      //   • off + heading diverging (>55°) → 3 ticks (~3 s): a real wrong turn
      //   • off but heading still aligned  → 6 ticks (~6 s): a SUSTAINED offset,
      //     not a momentary multipath spike (the parallel-road departure)
      // MISSED-MANEUVER fast path (tester: kept straight past an exit; the
      // mainline parallels the ramp so dRoute grows too slowly — ~30 s to
      // react). Got within 80 m of the maneuver, then receded 150 m+ WITHOUT
      // advancing (a pass-through advances at <25 m), while measurably off the
      // line (>25 m — kills loop-road false positives where the route itself
      // curls near the maneuver). Trips immediately, no streak needed.
      const missedManeuver =
        stepIdx < steps.length - 1 &&
        missRef.current != null && missRef.current.step === stepIdx &&
        missRef.current.min < 80 &&
        dManeuver > missRef.current.min + 150 &&
        dRoute > 25;
      const tripped =
        missedManeuver ? true :
        diverging ? true :
        conclusivelyOff ? offRouteStreakRef.current >= 2 :
        headingOff      ? offRouteStreakRef.current >= 3 :
                          offRouteStreakRef.current >= 6;
      if (tripped) {
        const now = Date.now();
        if (now - lastOffRouteAtRef.current > 8000) {
          lastOffRouteAtRef.current = now;
          try { logEvent(`off-route tripped d=${Math.round(dRoute)}m streak=${offRouteStreakRef.current} why=${missedManeuver ? 'missed' : diverging ? 'diverging' : conclusivelyOff ? 'far' : headingOff ? 'heading' : 'sustained'} step=${stepIdx}`); } catch {}
          offRouteStreakRef.current = 0;
          divergeRef.current = [];  // fresh trend against the NEW line
          missRef.current = null; // one miss = one reroute; re-arm on the new route
          options?.onOffRoute?.();
        }
      }
    }

    let remaining = dManeuver;
    for (let i = stepIdx + 1; i < steps.length; i++) remaining += steps[i].distance_m;

    // ===== TIME REMAINING =====
    //
    // Sum the REMAINING STEPS' OWN traffic-aware durations: the un-driven fraction of
    // the current step, plus every step after it.
    //
    // WHY (Jeff, 2026-07-26 — Langley → Anglemont): "when I started it was correct...
    // then I stopped for gas and continued on and the time increased by an hour even
    // though I stopped for 15 min. I ended the route and restarted and it was still
    // wrong."
    //
    // The old line was:
    //     eta = (remaining / r.distance_m) * r.duration_s
    // a flat DISTANCE ratio, which silently assumes one uniform speed for the whole
    // route. It is exactly right at the start (remaining === total, so eta ===
    // duration_s — which is why it always looked correct when you set off) and drifts
    // from then on, because real routes are not uniform. Every fast highway kilometre
    // is credited the same as a slow one, so the arrival clock creeps EARLIER across
    // the Coquihalla and then swings LATER once you reach a slow final stretch like
    // the winding lake road into Anglemont. Restarting the route could not help: the
    // fresh route used the same flat model, only now closer to the slow part.
    //
    // Of the reported hour, only the ~15 min of the gas stop was real — while parked,
    // `remaining` doesn't move, so `now + eta` legitimately slides by the time you sat
    // there. The rest was this formula.
    //
    // Mapbox has always sent per-step traffic-aware durations; mapboxToNavRoute just
    // dropped the number after formatting it for display. Now it keeps it.
    //
    // FALLS BACK to the old ratio when the steps carry no usable durations (a cached
    // or legacy route from before `duration_s` existed) so an old route still shows
    // something sane rather than 0.
    // ── TIER 1 (preferred): sum the remaining per-SEGMENT durations.
    // 4337 segments vs 16 steps on a real long route, and every one carries its own
    // traffic-aware seconds — including whatever a live refresh last wrote. Rebuild the
    // suffix table only when those numbers actually change (new route OR refreshed
    // traffic), keyed on length + total so a refresh is detected without deep-comparing
    // thousands of floats every tick.
    let eta = 0;
    let etaTier = 0;   // which tier answered — recorded in the breadcrumb below
    const segDur = r.segDurations;
    const segCoords = r.coordinates;
    if (segDur && segDur.length && segCoords && segCoords.length >= 2) {
      let segTotal = 0;
      for (let i = 0; i < segDur.length; i++) segTotal += segDur[i] || 0;
      const key = `${r.polyline.length}:${segDur.length}:${Math.round(segTotal)}`;
      if (segSuffixRef.current.key !== key) {
        segSuffixRef.current = { key, suffix: buildSuffixSeconds(segDur) };
        segCursorRef.current = 0;   // new numbers → re-find our place from scratch
      }
      const suffix = segSuffixRef.current.suffix;
      if (suffix) {
        const hit = findRouteSegment(segCoords, user.lat, user.lng, segCursorRef.current);
        if (hit) {
          segCursorRef.current = hit.seg;
          // ALONG-ROUTE HEAL (2026-08-21). The projection walked 84 -> 218/219 on
          // rkoji7's drive while stepIndex sat at 0: the cursor knew where the car was,
          // the step index did not. If the car's segment is past the current step's
          // end segment on three consecutive moving ticks, re-anchor by position.
          try {
            if (endSegsRef.current.key !== r.polyline) {
              const a = anchorStepIndex(segCoords, steps, user);
              endSegsRef.current = { key: r.polyline, endSegs: a.endSegs };
            }
            const endSeg = endSegsRef.current.endSegs[stepIdx] ?? -1;
            const moving = (user.speed ?? 0) > 2;
            const past = endSeg >= 0 && hit.seg > endSeg + 2 && hit.distM < 100;
            healStreakRef.current = past && moving ? healStreakRef.current + 1 : 0;
            if (healStreakRef.current >= 3 && stepIdx < steps.length - 1) {
              const a = anchorStepIndex(segCoords, steps, user);
              if (a.onRoute && a.index > stepIdx) {
                logEvent(`step-heal from=${stepIdx} to=${a.index} carSeg=${hit.seg} endSeg=${endSeg}`);
                healStreakRef.current = 0;
                stateRef.current = { ...stateRef.current, stepIndex: a.index };
                return;   // next tick runs on the healed index
              }
            }
          } catch {}
          // Time left = the un-driven remainder of the segment we're standing on,
          // plus every segment after it (O(1) via the suffix table).
          const inSeg = (segDur[hit.seg] || 0) * (1 - hit.t);
          eta = inSeg + (suffix[hit.seg + 1] ?? 0);
          etaTier = 1;
        }
      }
    }

    // ── TIER 2: per-STEP durations (coarser, but still respects the real speed profile).
    if (eta <= 0) {
      const curStep = steps[stepIdx];
      let stepSecs = 0;
      for (let i = stepIdx + 1; i < steps.length; i++) stepSecs += steps[i].duration_s || 0;
      // Pro-rate the step we're partway through by how much of it is left. dManeuver is
      // the distance still to run in this step, so the fraction is distance-based — fine
      // WITHIN a single step, where the speed really is roughly constant.
      const curLeft = curStep && curStep.distance_m > 0
        ? Math.min(1, Math.max(0, dManeuver / curStep.distance_m))
        : 0;
      stepSecs += (curStep?.duration_s || 0) * curLeft;
      eta = stepSecs;
      if (eta > 0) etaTier = 2;
    }

    // ── TIER 3: the original flat distance ratio. Only for a cached/legacy route that
    // carries neither segment nor step durations — better than showing 0.
    if (eta <= 0) { eta = (remaining / Math.max(r.distance_m, 1)) * r.duration_s; etaTier = 3; }

    // ── RECEIPT (2026-08-13) ────────────────────────────────────────────────────
    // Olaf, build 72: the phone read "11 min" while CarPlay read "43 min · 27 km" at
    // the same instant, and there was NO nav telemetry of any kind — so the only way to
    // reason about it was to read a photograph of a head unit. This line ends that.
    //
    // It records the two numbers side by side ON PURPOSE. `eta` comes from the SEGMENT
    // table (tier 1) and does not use the step index; `remaining` is the step-suffix sum
    // and does. When the step index freezes, eta stays right and remaining inflates —
    // so a widening gap between them, at a step index that stops moving, IS the
    // signature of the stuck-step defect, readable without a drive report.
    if (Date.now() - lastEtaLogAt > ETA_LOG_EVERY_MS) {
      lastEtaLogAt = Date.now();
      try {
        logEvent(
          `nav-eta tier=${etaTier} step=${stepIdx}/${steps.length - 1}` +
          ` eta=${Math.round(eta)}s rem=${Math.round(remaining)}m turn=${Math.round(dManeuver)}m` +
          ` seg=${segCursorRef.current}/${(r.segDurations?.length ?? 0)}`
        );
      } catch {}
    }

    // NOTE — deliberately NOT adding banked pitstop time here. The displayed arrival is
    // `now + eta`, so sitting still for 15 minutes already pushes arrival out by 15
    // minutes on its own: `now` advances while `eta` (which is distance-based) does
    // not. Adding the stop again would double-count it. Pitstop time is tracked and
    // SHOWN by src/pitstop.ts instead of being folded into the ETA.

    const arriveKey = `${steps.length - 1}-arrived`;
    // ── isLastStep WAS A HIDDEN 25 m GATE — my settle path was mostly dead (2026-07-31)
    // Both arrival branches used to require `stepIdx === steps.length - 1`. That reads
    // like a cheap guard. It is not: mapboxToNavRoute sets step[i].end to step[i+1]'s
    // maneuver location (:292-294) and Mapbox's final ARRIVE step has distance 0 AT the
    // destination — so steps[len-2].end === steps[len-1].end === the destination. The
    // advance loop only moves on when dManeuver < ADVANCE_THRESHOLD_M (25), which means
    // stepIdx reaches the last step ONLY after the car has already passed within 25 m.
    //
    // So `isLastStep` WAS a 25 m radius, and ARRIVE_SETTLE_M = 50 was unreachable: you
    // had to come within 25 m before a 50 m band could ever be tested. The exact case I
    // wrote the settle path for this morning — "park in a lot, a driveway, or the far
    // kerb" — was still blocked by it. Found by an adversarial review of a real drive.
    //
    // `remaining` is the correct axis and is a STRICT SUPERSET: on the last step the
    // sum loop never runs so remaining === dManeuver (identical behaviour), and on the
    // step before it remaining === dManeuver === distance-to-destination, so the settle
    // now fires at a true 50 m without ever requiring the 25 m pass. Nothing that fires
    // today stops firing.
    const dDest = remaining;
    // One funnel for both arrival paths, so they cannot disagree and cannot double-fire.
    // Kept in a ref because the backup timer's closure outlives this effect run.
    fireArriveRef.current = (late: boolean) => {
      if (announcedRef.current.has(arriveKey)) return;
      announcedRef.current.add(arriveKey);   // fire once, not on every parked GPS tick
      if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
      if (silentTimerRef.current) { clearTimeout(silentTimerRef.current); silentTimerRef.current = null; }
      // RECEIPT (2026-08-26, "it announced when I got to my destination despite being
      // off"): the arrival spoke through *some* mute for a tester and the gates here
      // could not be told apart after the fact. One reliable row per arrival records
      // every gate's state at fire time, so the next report is a one-query answer.
      try {
        const st = getSettings();
        logEventReliable(
          `arrive-speak engine=warm late=${late ? 1 : 0} optMute=${options?.mute ? 1 : 0} ` +
          `novaMuted=${st.novaMuted ? 1 : 0} novaVoice=${st.novaVoice === false ? 0 : 1} vol=${getAudioVol(st, "volVoice").toFixed(2)}`,
        );
      } catch {}
      if (!options?.mute && !late) speak(arrivalLine(options?.destLabel));
      options?.onArrive?.();
    };

    // Crow-fly gap to the destination — the last step's end IS the destination
    // (mapboxToNavRoute keeps end = its own maneuver point for the final step).
    const destPt = steps[steps.length - 1]?.end;
    const crowM = destPt ? haversineMeters(user, destPt) : Number.POSITIVE_INFINITY;
    const stopped = Math.max(0, user.speed ?? 0) < ARRIVE_SETTLE_SPEED_MS;
    const settleOk = dDest < ARRIVE_SETTLE_M && stopped;
    const nearOk = !settleOk && stopped
      && crowM < ARRIVE_NEAR_CROW_M && dDest < ARRIVE_NEAR_ROUTE_M;
    // One timestamp, one timer, but the dwell depends on which branch armed it.
    const dwellMs = settleOk ? ARRIVE_SETTLE_MS : ARRIVE_NEAR_MS;

    if (dDest < ARRIVE_M) {
      fireArriveRef.current(false);          // unchanged on the last step
    } else if ((settleOk || nearOk) && !announcedRef.current.has(arriveKey)) {
      // Stopped within reach of the destination. Stamp it, and arm ONE timer as the
      // backup for the case this whole mechanism exists to cover: no further fix.
      const now = Date.now();
      if (settleSinceRef.current == null) {
        settleSinceRef.current = now;
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          const since = settleSinceRef.current;
          if (since == null) return;         // moved off again before this landed
          try { logEvent(`arrive-settle fired dwell=${Math.round(dwellMs / 1000)}s crow=${Math.round(crowM)} route=${Math.round(dDest)}`); } catch {}
          fireArriveRef.current(Date.now() - since > dwellMs + ARRIVE_SPEAK_MAX_LATE_MS);
        }, dwellMs);
      } else if (now - settleSinceRef.current >= dwellMs) {
        // Receipt so the next drives PROVE which tier is doing the work, instead of
        // another round of reading photographs.
        try { logEvent(`arrive-settle fired dwell=${Math.round(dwellMs / 1000)}s crow=${Math.round(crowM)} route=${Math.round(dDest)}`); } catch {}
        fireArriveRef.current(false);        // fixes still flowing — the normal settle
      }
    } else {
      // Moving again, or no longer near the destination: disarm completely so a
      // later red light starts its own clean window.
      settleSinceRef.current = null;
      if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
      // ── THE SILENCE BACKSTOP ────────────────────────────────────────────────
      // Landing here while STILL inside the settle radius means tier 2 declined for
      // exactly one reason: `stopped` was false. That is either real motion — in
      // which case the next fix lands within a second or two and re-arms this — or a
      // frozen speed on a car that has already parked, which is the case tier 2
      // structurally cannot see (see the note beside settleSinceRef).
      //
      // Silence ALONE is not proof of parking, and this codebase says so in writing.
      // map.tsx's off-route note: iOS "stops delivering once the phone locks — so
      // `coords` froze". navNotification: the background task "only starts with 'Always'
      // location permission", which most testers never grant. So a MOVING car can go
      // silent too, and acting on silence unguarded tears down a live route and banks a
      // phantom trip.
      //
      // The probe below records what each candidate signal SAW at that moment:
      //   spd   the (possibly frozen) speed the arm was taken on
      //   moved whether any position change reached this screen during the dwell
      //   lateBy how far the timer slipped — iOS suspends JS timers with the screen off
      //   fg/hu foreground app, head unit attached
      // `would` is what a firing version WOULD have decided. Nothing acts on it yet.
      // See the shadow-mode note in the callback for why that is deliberate.
      const inSettle = dDest < ARRIVE_SETTLE_M;
      const inNear = crowM < ARRIVE_NEAR_CROW_M && dDest < ARRIVE_NEAR_ROUTE_M;
      const armedSpd = Math.max(0, user.speed ?? 0);
      if ((inSettle || inNear) && armedSpd < ARRIVE_SILENT_MAX_SPD_MS
          && !announcedRef.current.has(arriveKey)) {
        const armedSeq = tickSeqRef.current;
        const armedAt = Date.now();
        const dwell = inSettle ? ARRIVE_SETTLE_MS : ARRIVE_NEAR_MS;
        const armedDest = Math.round(dDest);
        if (silentTimerRef.current) clearTimeout(silentTimerRef.current);
        silentTimerRef.current = setTimeout(() => {
          silentTimerRef.current = null;
          const lateBy = Date.now() - armedAt - dwell;
          const moved = tickSeqRef.current !== armedSeq;
          const fg = AppState.currentState === "active";
          const hu = headUnitAttachedRaw();
          const would = !moved && lateBy <= ARRIVE_SILENT_MAX_SKEW_MS && (fg || hu);
          // ⚠ SHADOW MODE — MEASURES, DOES NOT ACT (2026-08-31). This deliberately does
          // NOT call fireArriveRef. Two adversarial review rounds killed two different
          // firing designs, and the second one killed this exact gate set: in the plain
          // park-unplug-pocket sequence `fg` and `hu` are BOTH false, so the guard that
          // makes firing safe also declines the one case the backstop exists for. The
          // guards are not wrong; the PREDICATE is. "Is a human present" is the wrong
          // question — the right one is "would we have HEARD the car if it had moved",
          // i.e. was a background location feed actually held. That is not currently
          // knowable from here, and inventing it blind is how the 07-31 collapse
          // happened. So: emit what every gate saw, on real drives, and build the fix
          // off measurements. Until then arrival behaviour is BIT-IDENTICAL to today —
          // this row is the only thing that changed.
          try {
            logEvent(
              `arrive-silent would=${would ? 1 : 0} moved=${moved ? 1 : 0} lateBy=${Math.round(lateBy)}ms ` +
              `fg=${fg ? 1 : 0} hu=${hu ? 1 : 0} app=${AppState.currentState} ` +
              `route=${armedDest}m dwell=${Math.round(dwell / 1000)}s spd=${armedSpd.toFixed(1)}`,
            );
          } catch {}
        }, dwell);
      } else if (silentTimerRef.current) {
        clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
    }

    const next: TbtState = { active: true, stepIndex: stepIdx, distanceToManeuverM: dManeuver, distanceRemainingM: remaining, etaSeconds: eta };
    stateRef.current = next;
    setState(next);
  }, [active, user?.lat, user?.lng]);

  return state;
}

// ---- Speech helper ----
// Spoken-direction playback rate. Was 1.05 ("brisk"), but the time-stretch +
// pitch-correction pass smears consonants on some clips — a tester reported
// Nova "slurs some words which makes it basically impossible to understand".
// Clarity beats brisk: play the synth exactly as rendered.
const NAV_TTS_RATE = 1.0;

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
// 12s (was 6s): a slow corner takes longer than 6s, so the second half of a
// split maneuver could re-say the identical "Turn right." mid-corner (tester:
// told to take a right 3 times before through the corner). Two genuinely
// distinct identical bare-verb turns within 12s are effectively one corner.
const SAME_TEXT_DEDUPE_MS = 12000;
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
// arrives, deliverGreetingAudio leads the queue with the greeting + a pause + a
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

// Plays PRE-SYNTHESIZED greeting audio (prepared during the route preview) so
// the greeting starts instantly at Start with no /tts hop.
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

// FINAL safety net for the "turn right onto Turn right" family. spokenStreet()
// guards the phone engine's own composition, but every builder that feeds
// speak() (cold CarPlay guidance, banner text, future callers) must ALSO never
// utter its own instruction twice. If the same turn phrase appears a second
// time later in the text, cut the sentence at the second occurrence and drop
// any dangling connector ("onto", "at", …). Dropping a tail is always safe;
// speaking a doubled instruction never is.
const INSTRUCTION_VERB_RE =
  /\b(turn\s+(?:left|right)|keep\s+(?:left|right)|slight\s+(?:left|right)|sharp\s+(?:left|right)|continue\s+straight|make\s+a\s+u-?turn|u-?turn|merge)\b/gi;
function scrubDoubledInstruction(text: string): string {
  INSTRUCTION_VERB_RE.lastIndex = 0;
  const first = INSTRUCTION_VERB_RE.exec(text);
  if (!first) return text;
  const second = INSTRUCTION_VERB_RE.exec(text);
  if (!second) return text;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  if (norm(second[1]) !== norm(first[1])) return text; // two DIFFERENT maneuvers ("turn left then turn right") are legit
  let head = text.slice(0, second.index).replace(/[,\s]*(onto|at|on|to|toward|towards)?\s*$/i, "");
  if (head && !/[.!?]$/.test(head)) head += ".";
  return head || text;
}

function speak(text: string) {
  if (!text || !text.trim()) return;
  text = scrubDoubledInstruction(text);
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

// (Reroute is intentionally SILENT — Convoy used to speak "Recalculating route."
// and it was intrusive on drives. The off-route handler in the map screen still
// recomputes the route in the background; we just never announce it out loud.)

// General-purpose Nova announcement (e.g. hazard-report confirmations) — uses
// the same queue as turn instructions so nothing ever talks over anything else.
export function announce(text: string) {
  speak(text);
}

// Stop nav speech immediately — clears the queue AND the in-flight playback so
// a half-spoken instruction doesn't linger after End / Clear.
export function stopSpeech() {
  resetSpeakGate();
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

// ===== TTS prefetch cache =====
// The imminent "Turn right." cue must land INSTANTLY — a live /tts hop at speak
// time (1–3s on cellular) put the voice mid-turn (tester: "tells me to turn
// right as I'm already turning"). When the prepare callout fires (~30s out) the
// turn engine pre-synthesizes the matching imminent phrase; speakOne() then
// plays it straight from this cache with zero network wait. The working set is
// tiny (bare verbs + roundabout exits repeat all drive), capped hard so it can
// never grow unbounded, and keyed by voice so a settings change never plays the
// wrong narrator.
const _ttsCache = new Map<string, { b64: string; mime: string }>();
const _ttsPending = new Set<string>();
const TTS_CACHE_MAX = 12;
function _ttsKey(text: string): string { return `${getNovaVoice()}|${text}`; }
export function prefetchTts(text: string): void {
  const t = (text || "").trim();
  if (!t) return;
  if (getSettings().novaVoice === false) return;
  const key = _ttsKey(t);
  if (_ttsCache.has(key) || _ttsPending.has(key)) return;
  _ttsPending.add(key);
  api.post("/tts", { text: t, voice: getNovaVoice() })
    .then(({ data }) => {
      if (!data?.audio_b64) return;
      if (_ttsCache.size >= TTS_CACHE_MAX) {
        const oldest = _ttsCache.keys().next().value;
        if (oldest !== undefined) _ttsCache.delete(oldest);
      }
      _ttsCache.set(key, { b64: data.audio_b64, mime: data.mime ?? "audio/mp3" });
    })
    .catch(() => {})
    .finally(() => { _ttsPending.delete(key); });
}

async function speakOne(text: string): Promise<void> {
  try {
    // Pre-synthesized? Play instantly — no network hop between "should speak"
    // and sound. (Cached clips are kept: the same bare verb recurs all drive.)
    const cached = _ttsCache.get(_ttsKey(text));
    if (cached) {
      await playBase64Audio(cached.b64, cached.mime);
      return;
    }
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
  // Voice slider at/near zero → the clip would be INAUDIBLE, but playing it
  // would still pause Apple Music + grab the .duckOthers session — the tester's
  // "random dips in my music but nothing plays in the app". Silence costs
  // nothing; never duck anyone's music for it.
  if (getAudioVol(getSettings(), "volVoice") <= 0.02) return;
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
      // Ease in from ~55% of target, NOT near-silence: the old 0.05 start +
      // 180ms ramp swallowed the first word entirely (tester: "the first word
      // will be super quiet"). 55%/100ms still rounds off the attack over the
      // music without eating any speech.
      const startV = target * 0.55;
      const FADE_IN_MS = 100, FADE_OUT_MS = 240, STEPS = 4;
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
    // Verb coverage matters: any leading verb phrase this regex misses leaks the
    // whole instruction through as the "street" (see spokenStreet below). The
    // trailing \s+ is deliberate — a BARE verb ("Turn left", end of string) should
    // NOT strip; it has no street, and spokenStreet drops it instead.
    .replace(/^(Continue\s+(straight\s+)?(on\s+)?|Head\s+\w+\s+(on\s+)?|Take\s+|Turn\s+\w+\s+(onto\s+)?|Slight\s+\w+\s+(onto\s+)?|Sharp\s+\w+\s+(onto\s+)?|Keep\s+\w+\s+to\s+stay\s+on\s+|Keep\s+\w+\s+(onto\s+)?|Merge\s+(onto\s+|on\s+)?|Make\s+a\s+U-?turn\s+(onto\s+)?)/i, "")
    .replace(/\s+toward\b.*$/i, "")
    .replace(/\.?\s*(Destination|The\s+destination)\b.*$/i, "")
    .trim();
}

// The spoken "onto <street>" tail for a turn callout. stripDirections removes the
// leading verb phrase to leave the road name — but Mapbox instructions come in more
// shapes than that regex covers: a BARE verb with no street ("Turn left" — the
// trailing-space requirement fails at end-of-string, so nothing strips), or verbs
// outside its list ("Sharp left onto X", "Keep right to stay on Y", "Merge…"). In
// those cases the "street" is really the instruction itself, and composing
// `${verb} onto ${street}` spoke the reported "turn left onto Turn left." Guard:
// if what's left echoes the verb (either contains the other) or still STARTS like
// an instruction, there is no clean street name — return "" so Nova says just
// "In 200 m, turn left." Dropping the tail is always safe; duplicating it never is.
function spokenStreet(verb: string, html: string): string {
  const street = stripDirections(html);
  if (!street) return "";
  const s = street.toLowerCase();
  const v = (verb || "").toLowerCase();
  if (v && (v.includes(s) || s.includes(v))) return "";
  // Looks-like-an-instruction check. Turny verbs need a DIRECTION word after them
  // so real streets like "Turn Valley Road" or "Keeping Creek Dr" still get spoken.
  if (/^((turn|slight|sharp|keep)\s+(left|right|straight)\b|(merge|continue|head|take|make|exit|u-?turn|the\s+ramp|the\s+exit)\b|at\s+the\s+roundabout)/i.test(street)) return "";
  return street;
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

// ── Live traffic refresh during navigation ───────────────────────────────────
//
// The route's durations are a SNAPSHOT from the moment it was fetched. On a 4-hour
// drive that snapshot is stale long before you arrive: a crash on the Coquihalla or a
// construction slowdown that appears after you set off would never reach the ETA.
// Jeff, 2026-07-26: "I wanted it to calculate everything on the trip including
// traffic/construction etc. this needs to be very accurate."
//
// So while guidance is running, re-pull JUST the annotations for the route we're
// already on (Mapbox Directions Refresh, keyed by the `uuid` from the original
// enable_refresh request). Same geometry, ~40 kB, no chance of silently swapping the
// driver onto a different highway the way a full re-fetch could.
//
// The fresh numbers land back on the route, the ETA's suffix table notices the totals
// changed and rebuilds, and the congestion gradient recolours — all on the next tick.
//
// Cadence: every 2 minutes. Fast enough that a jam is priced in within a couple of
// minutes, slow enough to be invisible on battery and data (a 4-hour drive = ~120
// small requests).
const TRAFFIC_REFRESH_MS = 120_000;
// Routes expire server-side; once the uuid is dead every call 404s. Give up after a few
// consecutive misses rather than poll a dead handle for the rest of the drive.
const TRAFFIC_REFRESH_MAX_FAILS = 3;

export function useRouteTrafficRefresh(
  route: NavRoute | null,
  active: boolean,
  onRefresh: (patch: { segDurations: number[]; congestion: CongestionLevel[] }) => void,
): void {
  const cbRef = useRef(onRefresh);
  useEffect(() => { cbRef.current = onRefresh; }, [onRefresh]);

  const uuid = route?.refreshUuid;
  const routeIndex = route?.routeIndex ?? 0;
  // Re-arm the whole loop when the ROUTE changes (new uuid), not on every render.
  useEffect(() => {
    if (!active || !uuid) return;
    let cancelled = false;
    let fails = 0;
    const ctrls = new Set<AbortController>();

    const tick = async () => {
      if (cancelled) return;
      const ctrl = new AbortController();
      ctrls.add(ctrl);
      try {
        const fresh = await refreshMapboxRoute(uuid, routeIndex, { signal: ctrl.signal });
        if (cancelled) return;
        // TRANSIENT failures no longer count. `null` is a dead zone or a 5xx, and
        // giving up on those switched live traffic off for the rest of a road trip —
        // the one place patchy signal is guaranteed and a stale ETA matters most.
        // Only "expired" (the server has forgotten this route) is worth stopping for.
        if (fresh === null) return;
        if (fresh === "expired") {
          if (++fails >= TRAFFIC_REFRESH_MAX_FAILS) { clearInterval(timer); }
          return;
        }
        fails = 0;
        cbRef.current(fresh);
      } catch {
        // network blip — keep the numbers we have and try again next tick
      } finally {
        ctrls.delete(ctrl);
      }
    };

    // Refresh ONCE straight away, then on the interval. Without this the first
    // update was 2 minutes into guidance — and a route plotted while parked, or
    // restored from disk on a cold CarPlay connect, could be minutes stale before
    // the driver even moved. It is one ~40 kB request; do it at Start.
    void tick();
    const timer = setInterval(tick, TRAFFIC_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const c of ctrls) { try { c.abort(); } catch {} }
    };
  }, [active, uuid, routeIndex]);
}

// ── Multi-stop routing ───────────────────────────────────────────────────────
//
// Route origin → stop → stop → … → destination, pinning each stop as a Mapbox
// via-waypoint (Jeff, 2026-07-28: "add into the drawer an 'add stop' feature").
//
// This rides the SAME `fetchMapboxRouteVia` the AI route already uses, so a stopped
// route is a completely ordinary NavRoute: it carries per-step durations, per-segment
// durations, congestion and a refresh uuid, which means the accurate ETA, the live
// traffic refresh and the congestion gradient all work through stops with no extra
// wiring. That is why this is a thin wrapper rather than a second routing path.
//
// NOTE Mapbox returns ONE route for a via request — no `alternatives`. So adding a stop
// collapses the Best/Scenic fan-out to a single line, which is correct: the driver has
// pinned the shape of the trip and alternates through fixed waypoints are meaningless.
//
// Interior arrive/depart steps at each waypoint are already stripped inside
// fetchMapboxRouteVia, so guidance won't announce "you have arrived" at every stop.
export async function fetchRouteViaStops(
  origin: LatLng,
  stops: LatLng[],
  destination: LatLng,
  avoid?: AvoidPrefs,
): Promise<NavRoute | null> {
  try {
    const via: [number, number][] = (stops || [])
      .filter((s) => typeof s?.lat === "number" && typeof s?.lng === "number")
      .map((s) => [s.lng, s.lat]);
    if (!via.length) return null;
    const mb = await fetchMapboxRouteVia(
      origin, via, destination,
      { tolls: !!avoid?.tolls, highways: !!avoid?.highways, ferries: !!avoid?.ferries },
    );
    if (!mb || !mb.polyline) return null;
    return mapboxToNavRoute(mb);
  } catch {
    return null;
  }
}
