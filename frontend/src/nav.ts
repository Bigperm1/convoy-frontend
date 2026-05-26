// Navigation engine — multi-route Directions fetching + turn-by-turn step machine.

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Speech from "expo-speech";
import { api } from "./api";

export type LatLng = { lat: number; lng: number };

export type NavStep = {
  html: string;             // sanitized instruction
  distance_text: string;
  distance_m: number;       // meters (numeric)
  duration_text: string;
  maneuver?: string;        // e.g. "turn-right", "merge"
  start: LatLng;
  end: LatLng;
};

export type NavRoute = {
  polyline: string;         // encoded polyline (overview)
  summary: string;          // e.g. "US-101 N"
  distance_text: string;
  duration_text: string;
  distance_m: number;
  duration_s: number;
  // Traffic-aware ETA fields, populated when the Directions request was made
  // with `departure_time=now`. `_text` is the pretty human string ("23 mins").
  // Falls back to undefined on routes where Google didn't return traffic data.
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

// ---- Maneuver → human verb (used for both label + voice) ----
export function maneuverVerb(m?: string): string {
  if (!m) return "Continue";
  const map: Record<string, string> = {
    "turn-right": "Turn right",
    "turn-left": "Turn left",
    "turn-slight-right": "Slight right",
    "turn-slight-left": "Slight left",
    "turn-sharp-right": "Sharp right",
    "turn-sharp-left": "Sharp left",
    "uturn-right": "Make a U-turn",
    "uturn-left": "Make a U-turn",
    "merge": "Merge",
    "fork-right": "Keep right",
    "fork-left": "Keep left",
    "ramp-right": "Take the ramp on the right",
    "ramp-left": "Take the ramp on the left",
    "roundabout-right": "At the roundabout, turn right",
    "roundabout-left": "At the roundabout, turn left",
    "ferry": "Take the ferry",
    "straight": "Continue straight",
  };
  return map[m] || "Continue";
}

// ---- Directions API: multi-route fetch with alternatives + avoid prefs ----
export type AvoidPrefs = {
  tolls?: boolean;
  highways?: boolean;
  ferries?: boolean;
};

export async function fetchDirections(
  origin: LatLng,
  destination: LatLng,
  avoid?: AvoidPrefs
): Promise<NavRoute[]> {
  // On WEB the Google Directions REST endpoint blocks browser fetches via CORS,
  // so we round-trip through the FastAPI proxy at /api/directions which has the
  // same query surface. Native (iOS/Android) hits Google directly for low latency.
  let data: any = null;
  try {
    if (Platform.OS === "web") {
      const params = {
        origin_lat: origin.lat,
        origin_lng: origin.lng,
        dest_lat: destination.lat,
        dest_lng: destination.lng,
        avoid_tolls: !!avoid?.tolls,
        avoid_highways: !!avoid?.highways,
        avoid_ferries: !!avoid?.ferries,
      };
      const res = await api.get("/directions", { params });
      data = res.data;
    } else {
      const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;
      if (!KEY) return [];
      const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
      url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
      url.searchParams.set("destination", `${destination.lat},${destination.lng}`);
      url.searchParams.set("mode", "driving");
      url.searchParams.set("alternatives", "true");
      // Traffic-aware ETAs: telling Directions API the trip starts NOW makes
      // it return `duration_in_traffic` per route so we can rank alternates
      // by current congestion (not free-flow time).
      url.searchParams.set("departure_time", "now");
      url.searchParams.set("traffic_model", "best_guess");
      const avoidParts: string[] = [];
      if (avoid?.tolls) avoidParts.push("tolls");
      if (avoid?.highways) avoidParts.push("highways");
      if (avoid?.ferries) avoidParts.push("ferries");
      if (avoidParts.length) url.searchParams.set("avoid", avoidParts.join("|"));
      url.searchParams.set("key", KEY);
      const res = await fetch(url.toString());
      data = await res.json();
    }
  } catch {
    return [];
  }
  if (!data || data.status !== "OK" || !Array.isArray(data.routes)) return [];
  return data.routes
    .map((r: any): NavRoute | null => {
      const leg = r?.legs?.[0];
      if (!leg) return null;
      return {
        polyline: r.overview_polyline?.points || "",
        summary: r.summary || "",
        distance_text: leg.distance?.text || "",
        duration_text: leg.duration?.text || "",
        distance_m: leg.distance?.value || 0,
        duration_s: leg.duration?.value || 0,
        // duration_in_traffic comes back from Google when departure_time=now
        // was sent. May be missing on routes Google can't traffic-estimate.
        duration_in_traffic_text: leg.duration_in_traffic?.text,
        duration_in_traffic_s: leg.duration_in_traffic?.value,
        steps: (leg.steps || []).map((s: any): NavStep => ({
          html: (s.html_instructions || "").replace(/<[^>]+>/g, ""),
          distance_text: s.distance?.text || "",
          distance_m: s.distance?.value || 0,
          duration_text: s.duration?.text || "",
          maneuver: s.maneuver,
          start: { lat: s.start_location?.lat, lng: s.start_location?.lng },
          end: { lat: s.end_location?.lat, lng: s.end_location?.lng },
        })),
      };
    })
    .filter(Boolean) as NavRoute[];
}

// ---- Turn-by-turn engine ----
// Tracks user position vs step end coords and emits voice prompts.
// Caller passes the active route + a fresh user position; this returns the current
// step + distance/eta and triggers Speech as thresholds are crossed.

type TbtState = {
  active: boolean;
  stepIndex: number;
  distanceToManeuverM: number;
  distanceRemainingM: number;
  etaSeconds: number;
};

const VOICE_THRESHOLDS = [400, 150, 30] as const;     // meters before maneuver
const ADVANCE_THRESHOLD_M = 25;                       // distance to step end → advance
const REROUTE_DISTANCE_M = 80;                        // off-route detection threshold

export function useTurnByTurn(
  route: NavRoute | null,
  user: LatLng | null,
  active: boolean,
  options?: { mute?: boolean; onArrive?: () => void; onOffRoute?: () => void }
) {
  const [state, setState] = useState<TbtState>({
    active: false,
    stepIndex: 0,
    distanceToManeuverM: 0,
    distanceRemainingM: 0,
    etaSeconds: 0,
  });
  const announcedRef = useRef<Set<string>>(new Set());
  const lastSpokeRef = useRef<number>(0);
  const lastOffRouteAtRef = useRef<number>(0);
  // ===== Trip-state flag for the start-of-trip voice =====
  // Once we've announced "Starting navigation…" for the current trip we lock
  // it for the ENTIRE trip. Reset only happens on cancel (active → false) or
  // arrival (onArrive fires). Previous version was keyed on `route.polyline`
  // which re-armed every time the parent recomputed alternates with a new
  // polyline string mid-trip — causing the prompt to loop endlessly.
  const hasAnnouncedStartRef = useRef<boolean>(false);
  // Hold the latest route in a ref so the start-effect can read it without
  // re-running every time a different route object identity flows through.
  const routeRef = useRef<NavRoute | null>(route);
  useEffect(() => { routeRef.current = route; }, [route]);

  // Trip lifecycle effect — runs ONLY on `active` toggle, never on polyline
  // change. This is what kills the voice loop: a mid-trip alternate-route
  // reshuffle no longer triggers the "Starting navigation" greeting again.
  useEffect(() => {
    if (!active) {
      Speech.stop();
      announcedRef.current.clear();
      hasAnnouncedStartRef.current = false; // re-arm for next trip
      setState({ active: false, stepIndex: 0, distanceToManeuverM: 0, distanceRemainingM: 0, etaSeconds: 0 });
      return;
    }
    announcedRef.current.clear();
    setState((s) => ({ ...s, active: true, stepIndex: 0 }));
    // Speak ONCE per trip — guarded by the boolean ref. Read route from
    // routeRef so we get whatever route is current right now, without
    // putting `route` in the dependency array.
    const r = routeRef.current;
    if (r?.steps?.[0] && !options?.mute && !hasAnnouncedStartRef.current) {
      const verb = maneuverVerb(r.steps[0].maneuver);
      const inst = r.steps[0].html;
      speak(`Starting navigation. ${verb} ${inst.length > 80 ? "" : "to " + stripDirections(inst)}. Total ${r.duration_text}.`);
      lastSpokeRef.current = Date.now();
      hasAnnouncedStartRef.current = true; // lock for the whole trip
    }
  }, [active]);

  // Step machine
  useEffect(() => {
    if (!active || !route || !user) return;
    const steps = route.steps;
    if (!steps?.length) return;

    setState((prev) => {
      let stepIdx = Math.min(prev.stepIndex, steps.length - 1);
      let cur = steps[stepIdx];
      let dManeuver = haversineMeters(user, cur.end);

      // Advance step when close to its end coord
      while (stepIdx < steps.length - 1 && dManeuver < ADVANCE_THRESHOLD_M) {
        stepIdx += 1;
        cur = steps[stepIdx];
        dManeuver = haversineMeters(user, cur.end);
        announcedRef.current.clear(); // reset prompts for new step
      }

      // Voice prompts at fixed distances
      if (!options?.mute) {
        for (const t of VOICE_THRESHOLDS) {
          const key = `${stepIdx}-${t}`;
          if (dManeuver <= t && !announcedRef.current.has(key)) {
            const verb = maneuverVerb(steps[Math.min(stepIdx + 1, steps.length - 1)].maneuver);
            const distLabel = t >= 1000 ? `${(t / 1000).toFixed(1)} kilometers` : `${t} meters`;
            const inst = stripDirections(steps[Math.min(stepIdx + 1, steps.length - 1)].html);
            const utter = stepIdx + 1 < steps.length
              ? (t === 30 ? `${verb}.` : `In ${distLabel}, ${verb.toLowerCase()}${inst ? " onto " + inst : ""}.`)
              : (t === 30 ? "You have arrived." : `In ${distLabel}, you will arrive at your destination.`);
            // Avoid stacking prompts (min 1.2s spacing)
            if (Date.now() - lastSpokeRef.current > 1200) {
              speak(utter);
              lastSpokeRef.current = Date.now();
            }
            announcedRef.current.add(key);
            break;
          }
        }
      }

      // Off-route detection: distance from user to ALL upcoming step start lines
      // Simple proxy: if user is > REROUTE_DISTANCE_M from current step's start AND end, fire callback (debounced 8s)
      const dStart = haversineMeters(user, cur.start);
      if (dStart > REROUTE_DISTANCE_M && dManeuver > REROUTE_DISTANCE_M) {
        const now = Date.now();
        if (now - lastOffRouteAtRef.current > 8000) {
          lastOffRouteAtRef.current = now;
          options?.onOffRoute?.();
        }
      }

      // Distance remaining = distance to current step end + sum of remaining step lengths
      let remaining = dManeuver;
      for (let i = stepIdx + 1; i < steps.length; i++) remaining += steps[i].distance_m;

      const eta = (remaining / Math.max(route.distance_m, 1)) * route.duration_s;

      // Arrival
      if (stepIdx === steps.length - 1 && dManeuver < 20) {
        if (!options?.mute) speak("You have arrived at your destination.");
        options?.onArrive?.();
      }

      return {
        active: true,
        stepIndex: stepIdx,
        distanceToManeuverM: dManeuver,
        distanceRemainingM: remaining,
        etaSeconds: eta,
      };
    });
  }, [active, user?.lat, user?.lng, route?.polyline]);

  return state;
}

// ---- Speech helper — natural OpenAI TTS with expo-speech fallback ----
//
// Calls `POST /api/tts` (OpenAI tts-1, voice "nova") to fetch a base64 MP3
// for the prompt, then plays it through expo-av on native (writes the MP3
// to the cache dir first) or an HTMLAudio data URI on web. A simple FIFO
// queue guarantees prompts never overlap — "In 200 meters, turn left" will
// finish before "Turn right onto Main Street" starts.
//
// If the backend returns 503 (no OPENAI_API_KEY configured) or anything
// else fails (offline, quota, decode error), we silently fall back to the
// classic robotic expo-speech voice so navigation still has audio.

const ttsQueue: string[] = [];
let ttsPlaying = false;

function speak(text: string) {
  if (!text || !text.trim()) return;
  ttsQueue.push(text);
  if (!ttsPlaying) {
    // fire-and-forget the drainer
    drainTtsQueue();
  }
}

async function drainTtsQueue(): Promise<void> {
  if (ttsQueue.length === 0) { ttsPlaying = false; return; }
  ttsPlaying = true;
  const text = ttsQueue.shift()!;
  try {
    await speakOne(text);
  } catch {
    // speakOne already handles its own fallbacks — never let it kill the queue.
  }
  // Drain the next prompt — guarantees serial playback.
  drainTtsQueue();
}

async function speakOne(text: string): Promise<void> {
  // 1) Preferred: OpenAI TTS via backend proxy. Returns base64 MP3.
  try {
    const { data } = await api.post("/tts", { text, voice: "nova" });
    if (data?.audio_b64) {
      await playBase64Audio(data.audio_b64, data.mime ?? "audio/mp3");
      return;
    }
  } catch {
    // Fall through to expo-speech fallback.
  }
  // 2) Fallback: expo-speech (robotic but always works offline).
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        Speech.speak(text, { rate: 1.0, pitch: 1.0 });
      }
      return;
    }
    Speech.speak(text, { rate: 1.0, pitch: 1.0 });
  } catch { /* ignore */ }
}

async function playBase64Audio(b64: string, mime: string): Promise<void> {
  if (Platform.OS === "web") {
    // Web: data URI in an HTMLAudio element. resolve on end OR error so the
    // queue keeps moving even if autoplay is blocked (first user gesture
    // required on some browsers).
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line no-undef
        const audio = new Audio(`data:${mime};base64,${b64}`);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  // Native: write MP3 to cache and play with expo-av. Matches the same pattern
  // used by livePtt.ts so we share the audio-decoder warmup with PTT.
  try {
    const { Audio } = await import("expo-av");
    const FileSystem = await import("expo-file-system/legacy");
    const path = FileSystem.cacheDirectory + `tts_${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return new Promise((resolve) => {
      Audio.Sound.createAsync({ uri: path }, { shouldPlay: true })
        .then(({ sound }) => {
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (!status?.isLoaded || status?.didJustFinish) {
              sound.unloadAsync().catch(() => {});
              // Best-effort cleanup of the cached MP3 so /cache doesn't grow.
              FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
              resolve();
            }
          });
        })
        .catch(() => resolve());
    });
  } catch {
    return;
  }
}

// Trim things like "toward" / "destination will be on the right" that bloat TTS.
function stripDirections(s: string): string {
  return (s || "")
    .replace(/^(Continue\s+(on\s+)?|Head\s+\w+\s+(on\s+)?|Take\s+|Turn\s+\w+\s+(onto\s+)?)/i, "")
    .replace(/\s+toward\b.*$/i, "")
    .replace(/\.?\s*(Destination|The\s+destination)\b.*$/i, "")
    .trim();
}

// Format helpers for UI labels
export function fmtDistanceM(m: number): string {
  if (m < 1) return "now";
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
export function fmtEtaSec(s: number): string {
  if (s < 60) return `${Math.round(s)} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
