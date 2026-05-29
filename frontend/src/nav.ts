// Navigation engine — Routes API (computeRoutes) + turn-by-turn step machine.
// Replaces the legacy Directions API with the Google Routes API v2 which
// provides richer traffic data, better polyline quality and is the
// forward-looking Google-recommended routing endpoint.

import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Speech from "expo-speech";
import { api } from "./api";

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
      const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;
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
        departureTime: new Date().toISOString(),
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

    return {
      polyline: r.polyline?.encodedPolyline ?? "",
      summary: r.description ?? r.routeLabels?.[0] ?? "",
      distance_text: formatDistance(distM),
      duration_text: formatDuration(durS),
      distance_m: distM,
      duration_s: durS,
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
  const match = dur.match(/^(d+)s$/);
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

const VOICE_THRESHOLDS = [400, 150, 30] as const;
const ADVANCE_THRESHOLD_M = 25;
const REROUTE_DISTANCE_M = 80;

export function useTurnByTurn(
  route: NavRoute | null,
  user: LatLng | null,
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
    resetSpeakGate();
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

    if (!options?.mute) {
      for (const t of VOICE_THRESHOLDS) {
        const key = `${stepIdx}-${t}`;
        if (dManeuver <= t && !announcedRef.current.has(key)) {
          const nextStep = steps[Math.min(stepIdx + 1, steps.length - 1)];
          const verb = maneuverVerb(nextStep.maneuver);
          const distLabel = t >= 1000 ? `${(t / 1000).toFixed(1)} kilometers` : `${t} meters`;
          const inst = stripDirections(nextStep.html);
          const utter = stepIdx + 1 < steps.length
            ? (t === 30 ? `${verb}.` : `In ${distLabel}, ${verb.toLowerCase()}${inst ? " onto " + inst : ""}.`)
            : (t === 30 ? "You have arrived." : `In ${distLabel}, you will arrive at your destination.`);
          speak(utter);
          announcedRef.current.add(key);
          break;
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

    if (stepIdx === steps.length - 1 && dManeuver < 20) {
      if (!options?.mute) speak("You have arrived at your destination.");
      options?.onArrive?.();
    }

    const next: TbtState = { active: true, stepIndex: stepIdx, distanceToManeuverM: dManeuver, distanceRemainingM: remaining, etaSeconds: eta };
    stateRef.current = next;
    setState(next);
  }, [active, user?.lat, user?.lng]);

  return state;
}

// ---- Speech helper ----
let _speakLock = false;
let _lastSpoke = 0;
const ttsQueue: string[] = [];
let ttsPlaying = false;

function speak(text: string) {
  if (!text || !text.trim()) return;
  const now = Date.now();
  if (now - _lastSpoke < 1500) return;
  _lastSpoke = now;
  ttsQueue.push(text);
  if (!ttsPlaying) drainTtsQueue();
}

function resetSpeakGate() {
  _speakLock = false;
  _lastSpoke = 0;
  ttsQueue.length = 0;
  ttsPlaying = false;
  try { Speech.stop(); } catch {}
  if (Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
}

async function drainTtsQueue(): Promise<void> {
  if (ttsQueue.length === 0) { ttsPlaying = false; return; }
  ttsPlaying = true;
  const text = ttsQueue.shift()!;
  try { await speakOne(text); } catch {}
  drainTtsQueue();
}

async function speakOne(text: string): Promise<void> {
  try {
    const { data } = await api.post("/tts", { text, voice: "nova" });
    if (data?.audio_b64) {
      await playBase64Audio(data.audio_b64, data.mime ?? "audio/mp3");
      return;
    }
  } catch {}
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && "speechSynthesis" in window) Speech.speak(text, { rate: 1.0, pitch: 1.0 });
      return;
    }
    Speech.speak(text, { rate: 1.0, pitch: 1.0 });
  } catch {}
}

async function playBase64Audio(b64: string, mime: string): Promise<void> {
  if (Platform.OS === "web") {
    return new Promise((resolve) => {
      try {
        const audio = new Audio(`data:${mime};base64,${b64}`);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      } catch { resolve(); }
    });
  }
  try {
    const { Audio } = await import("expo-av");
    const FileSystem = await import("expo-file-system/legacy");
    const path = FileSystem.cacheDirectory + `tts_${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
    return new Promise((resolve) => {
      Audio.Sound.createAsync({ uri: path }, { shouldPlay: true })
        .then(({ sound }) => {
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (!status?.isLoaded || status?.didJustFinish) {
              sound.unloadAsync().catch(() => {});
              FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
              resolve();
            }
          });
        })
        .catch(() => resolve());
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
