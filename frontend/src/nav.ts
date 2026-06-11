// Navigation engine — Routes API (computeRoutes) + turn-by-turn step machine.
// Replaces the legacy Directions API with the Google Routes API v2 which
// provides richer traffic data, better polyline quality and is the
// forward-looking Google-recommended routing endpoint.

import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { api, GOOGLE_MAPS_KEY } from "./api";
import { setPlaybackAudioMode, setIdleAudioMode } from "./audioMode";
import { duckForSpeech, unduckForSpeech } from "./applePlayer";
import { isOnCall } from "./callState";

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
  steps: NavStep[];
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
  };
  return map[m] || "Continue";
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
  let routes: any[] = [];
  try {
    if (Platform.OS === "web") {
      // Backend proxy mirrors the Routes API computeRoutes request
      const params = {
        origin_lat: origin.lat, origin_lng: origin.lng,
        dest_lat: destination.lat, dest_lng: destination.lng,
        avoid_tolls: !!avoid?.tolls,
        avoid_highways: !!avoid?.highways,
        avoid_ferries: !!avoid?.ferries,
      };
      const res = await api.get("/routes", { params });
      routes = res.data?.routes ?? [];
    } else {
      const KEY = GOOGLE_MAPS_KEY;
      if (!KEY) return [];

      const avoidTolls = avoid?.tolls ?? false;
      const avoidHighways = avoid?.highways ?? false;
      const avoidFerries = avoid?.ferries ?? false;

      // Routes API request body
      const body: any = {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE",
        computeAlternativeRoutes: true,
        routingPreference: "TRAFFIC_AWARE",
        routeModifiers: {
          avoidTolls, avoidHighways, avoidFerries,
        },
        languageCode: "en-US",
        units: "METRIC",
      };

      const res = await fetch(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": KEY,
            // Field mask — only request the fields we actually use to minimize
            // response size and avoid unnecessary billing for unused fields.
            "X-Goog-FieldMask": [
              "routes.duration",
              "routes.staticDuration",
              "routes.distanceMeters",
              "routes.polyline.encodedPolyline",
              "routes.description",
              "routes.legs.duration",
              "routes.legs.distanceMeters",
              "routes.legs.steps.navigationInstruction",
              "routes.legs.steps.distanceMeters",
              "routes.legs.steps.staticDuration",
              "routes.legs.steps.startLocation",
              "routes.legs.steps.endLocation",
              "routes.travelAdvisory.tollInfo",
              "routes.routeLabels",
            ].join(","),
          },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      routes = data?.routes ?? [];
    }
  } catch {
    return [];
  }

  if (!routes.length) return [];

  return routes.map((r: any): NavRoute => {
    const leg = r?.legs?.[0];
    const distM = r.distanceMeters ?? leg?.distanceMeters ?? 0;
    const durS = parseDurationSeconds(r.duration ?? leg?.duration);
    const trafficDurS = parseDurationSeconds(r.duration ?? leg?.duration);
    const freeflowS = parseDurationSeconds(r.staticDuration ?? leg?.staticDuration);

    return {
      polyline: r.polyline?.encodedPolyline ?? "",
      summary: r.description ?? r.routeLabels?.[0] ?? "",
      distance_text: formatDistance(distM),
      duration_text: formatDuration(durS),
      distance_m: distM,
      duration_s: durS,
      freeflow_s: freeflowS || undefined,
      duration_in_traffic_text: trafficDurS !== durS ? formatDuration(trafficDurS) : undefined,
      duration_in_traffic_s: trafficDurS !== durS ? trafficDurS : undefined,
      steps: (leg?.steps ?? []).map((s: any): NavStep => {
        const sDistM = s.distanceMeters ?? 0;
        const sDurS = parseDurationSeconds(s.staticDuration);
        const maneuver = s.navigationInstruction?.maneuver ?? "";
        const html = s.navigationInstruction?.instructions ?? "";
        return {
          html,
          distance_text: formatDistance(sDistM),
          distance_m: sDistM,
          duration_text: formatDuration(sDurS),
          maneuver,
          start: latLngFromRoutes(s.startLocation),
          end: latLngFromRoutes(s.endLocation),
        };
      }),
    };
  }).filter((r: NavRoute) => r.polyline);
}

// Keep the old name as an alias so any remaining legacy callsites still compile.
// New code should call fetchRoutes() directly.
export const fetchDirections = fetchRoutes;

// ---- Routes API helpers ----
function parseDurationSeconds(dur: string | undefined): number {
  if (!dur) return 0;
  // Routes API returns durations as "NNNs" e.g. "1234s"
  const match = dur.match(/^(\d+)s$/);
  if (match) return parseInt(match[1], 10);
  // Fallback: treat as numeric string
  const n = parseFloat(dur);
  return isFinite(n) ? n : 0;
}

function latLngFromRoutes(loc: any): LatLng {
  return {
    lat: loc?.latLng?.latitude ?? loc?.lat ?? 0,
    lng: loc?.latLng?.longitude ?? loc?.lng ?? 0,
  };
}

export function formatDistance(m: number): string {
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
const REROUTE_DISTANCE_M = 80;

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
  if (m && !SILENT_MANEUVERS.has(m)) return true;
  const h = (html || "").toLowerCase();
  return /\b(turn|merge|exit|ramp|fork|u-?turn|roundabout|keep (?:left|right))\b/.test(h);
}

export function useTurnByTurn(
  route: NavRoute | null,
  // `speed` (m/s, from GPS) rides along on the position the caller already
  // passes (map.tsx hands us `coords`, which carries it) — used to scale the
  // voice lead distance with speed. Optional so other callers stay compatible.
  user: (LatLng & { speed?: number }) | null,
  active: boolean,
  options?: { mute?: boolean; onArrive?: () => void; onOffRoute?: () => void }
) {
  const [state, setState] = useState<TbtState>({
    active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0,
  });
  const announcedRef = useRef<Set<string>>(new Set());
  const lastSpokeRef = useRef<number>(0);
  const lastOffRouteAtRef = useRef<number>(0);
  const stateRef = useRef<TbtState>({
    active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0,
  });
  const hasAnnouncedStartRef = useRef<boolean>(false);
  const routeRef = useRef<NavRoute | null>(route);
  useEffect(() => { routeRef.current = route; }, [route]);

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
      const verb = maneuverVerb(r.steps[0].maneuver);
      const inst = r.steps[0].html;
      speak(`Starting navigation. ${verb} ${inst.length > 80 ? "" : "to " + stripDirections(inst)}. Total ${r.duration_text}.`);
      lastSpokeRef.current = Date.now();
      hasAnnouncedStartRef.current = true;
    }
  }, [active]);

  useEffect(() => {
    if (!active || !user) return;
    const r = routeRef.current;
    if (!r) return;
    const steps = r.steps;
    if (!steps?.length) return;

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
          const verb = maneuverVerb(nextStep.maneuver);
          const inst = stripDirections(nextStep.html);
          if (dManeuver <= imminentM && !announcedRef.current.has(immKey)) {
            speak(`${verb}.`);
            announcedRef.current.add(immKey);
            announcedRef.current.add(prepKey); // a "prepare" this late would be noise
          } else if (dManeuver <= prepareM && !announcedRef.current.has(prepKey)) {
            speak(`In ${fmtDistanceM(dManeuver)}, ${verb.toLowerCase()}${inst ? " onto " + inst : ""}.`);
            announcedRef.current.add(prepKey);
          }
        }
      }
    }

    const dStart = haversineMeters(user, cur.start);
    if (dStart > REROUTE_DISTANCE_M && dManeuver > REROUTE_DISTANCE_M) {
      const now = Date.now();
      if (now - lastOffRouteAtRef.current > 8000) {
        lastOffRouteAtRef.current = now;
        options?.onOffRoute?.();
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
let _lastRerouteSpoke = 0;
type TtsItem = string | { _greetAudio: string; mime: string };
const ttsQueue: TtsItem[] = [];
let ttsPlaying = false;
// The currently-playing TTS Sound (native) so nav teardown can stop a
// half-spoken instruction. Web playback is fire-and-forget.
let _currentSound: any = null;

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
  // While the route-start greeting is in flight, park the latest turn callout
  // so the greeting always leads (it's replayed once the greeting + pause end).
  if (_greetingInFlight) { _heldSpeech = text; return; }
  const now = Date.now();
  if (now - _lastSpoke < 1500) return;
  _lastSpoke = now;
  ttsQueue.push(toSpeech(text));
  if (!ttsPlaying) drainTtsQueue();
}

function resetSpeakGate() {
  _speakLock = false;
  _lastSpoke = 0;
  ttsQueue.length = 0;
  ttsPlaying = false;
  // Clear any in-flight greeting hold so a fresh nav session starts clean.
  _greetingInFlight = false;
  _heldSpeech = null;
  if (_greetingTimer) { clearTimeout(_greetingTimer); _greetingTimer = null; }
  // Nav stopped/cleared — let any ducked in-app music come back immediately.
  _restoreMusicNow();
  // ...and release the ducking audio session so external music (Spotify etc.)
  // returns to full volume the moment nav ends, not just when the queue drains.
  void setIdleAudioMode();
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
    const { data } = await api.post("/tts", { text, voice: "nova" });
    if (data?.audio_b64) {
      await playBase64Audio(data.audio_b64, data.mime ?? "audio/mp3");
    }
  } catch {
    // TTS unavailable: stay silent. The on-screen nav banner still shows the
    // turn, and we no longer fall back to the robotic device voice.
  }
}

async function playBase64Audio(b64: string, mime: string): Promise<void> {
  if (Platform.OS === "web") {
    return new Promise((resolve) => {
      try {
        const audio = new Audio(`data:${mime};base64,${b64}`);
        audio.playbackRate = NAV_TTS_RATE;
        (audio as any).preservesPitch = true;
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
      const finish = () => { if (done) return; done = true; resolve(); };
      const watchdog = setTimeout(finish, 15000);
      // On a phone call, duck Nova WAY down so she isn't loud over the call —
      // applies to every callout during the call. Start near-silent and ease up
      // to the ducked level (gentle fade, no jarring blast); full volume
      // otherwise. (Call detection is native — inert until that module ships.)
      const onCall = isOnCall();
      const targetVol = onCall ? 0.22 : 1.0;
      const startVol = onCall ? 0.05 : 1.0;
      Audio.Sound.createAsync({ uri: path }, { shouldPlay: true, rate: NAV_TTS_RATE, shouldCorrectPitch: true, volume: startVol })
        .then(({ sound }) => {
          _currentSound = sound;
          sound.setVolumeAsync(startVol).catch(() => {});
          if (onCall) {
            // Fire-and-forget ramp up to the ducked level (~0.3s). If the clip
            // finishes first, these setVolume calls just no-op on the unloaded sound.
            setTimeout(() => { sound.setVolumeAsync(0.13).catch(() => {}); }, 120);
            setTimeout(() => { sound.setVolumeAsync(targetVol).catch(() => {}); }, 280);
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

export function fmtEtaSec(s: number): string {
  return formatDuration(s);
}
