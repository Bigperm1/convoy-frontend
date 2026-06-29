// AI routes — the "how I actually drive there" memory. When you finish a drive to
// a saved place (Home / Work / custom), we persist a DECIMATED polyline of the path
// you really took. Next time you route to that place from near the same start, we
// re-run that habitual path through Mapbox (as via-waypoints) so it comes back as a
// real, traffic-aware NavRoute — your route, your way, even when it isn't the fastest.
//
// Local-only, no backend. Mirrors the storage shape of savedPlaces.ts: a module-level
// cache + listener set + load promise, with imperative get/record helpers and a hook.
// One trace per saved place (last-good v1; most-frequent clustering can come later).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

const KEY = "convoy.aiRoutes.v1";

// Decimation: keep a point roughly every this-many metres along the driven path. Dense
// enough to preserve the route's shape, sparse enough to store + replay cheaply.
const DECIMATE_GAP_M = 60;
// Hard cap on stored trace points (a very long drive still stays bounded).
const MAX_TRACE_POINTS = 400;
// Origin must be within this of the learned trace's start for the memory to apply —
// otherwise it's a different trip to the same place and the habitual path is irrelevant.
export const AI_START_RADIUS_M = 350;
// Minimum drive distance to bother learning (skip trivial sub-300 m hops).
const MIN_LEARN_DISTANCE_M = 300;

export type AiRoute = {
  placeId: string;                  // the SavedPlace.id this trace leads to
  startLat: number; startLng: number;
  endLat: number; endLng: number;
  coords: [number, number][];       // decimated [lng,lat] driven path, origin -> dest
  drives: number;                   // times learned/reinforced
  lastDrivenAt: number;
  duration_s: number;               // last observed drive duration (fallback ETA)
  distance_m: number;
};

let cached: AiRoute[] = [];
let loaded = false;
const listeners = new Set<(r: AiRoute[]) => void>();

function isValid(r: any): r is AiRoute {
  return (
    r &&
    typeof r.placeId === "string" &&
    Array.isArray(r.coords) && r.coords.length >= 2 &&
    typeof r.startLat === "number" && typeof r.startLng === "number" &&
    typeof r.endLat === "number" && typeof r.endLng === "number"
  );
}

const loadPromise: Promise<AiRoute[]> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cached = parsed.filter(isValid);
    }
  } catch {}
  loaded = true;
  listeners.forEach((l) => l(cached));
  return cached;
})();

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(cached));
  } catch {}
  listeners.forEach((l) => l(cached));
}

export async function ensureAiRoutesLoaded(): Promise<AiRoute[]> {
  return loaded ? cached : loadPromise;
}

export function getAiRoutes(): AiRoute[] {
  return cached;
}

export function getAiRouteForPlace(placeId: string): AiRoute | undefined {
  return cached.find((r) => r.placeId === placeId);
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Distance-based decimation: drop points closer than DECIMATE_GAP_M to the last kept
// point, always keeping the first + last. Cheap, order-preserving, good enough to keep
// the route's shape without a full Douglas-Peucker pass.
function decimate(coords: [number, number][]): [number, number][] {
  if (coords.length <= 2) return coords;
  const out: [number, number][] = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i++) {
    const c = coords[i];
    if (haversineM(last[1], last[0], c[1], c[0]) >= DECIMATE_GAP_M) {
      out.push(c);
      last = c;
    }
  }
  out.push(coords[coords.length - 1]);
  // Cap: if still too many (a very long drive), keep an evenly-spaced subset.
  if (out.length > MAX_TRACE_POINTS) {
    const step = out.length / MAX_TRACE_POINTS;
    const capped: [number, number][] = [];
    for (let i = 0; i < MAX_TRACE_POINTS; i++) capped.push(out[Math.floor(i * step)]);
    capped[capped.length - 1] = out[out.length - 1];
    return capped;
  }
  return out;
}

function pathDistanceM(coords: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return d;
}

// Learn (or reinforce) the habitual path to a saved place from a finished drive.
// `trace` is the raw {lat,lng,ts} fix stream the map collected during nav. Returns the
// stored AiRoute, or null when the drive was too short / sparse to be worth keeping.
export async function recordDrive(input: {
  placeId: string;
  trace: { lat: number; lng: number; ts: number }[];
}): Promise<AiRoute | null> {
  await ensureAiRoutesLoaded();
  const raw = (input.trace || []).filter(
    (p) => typeof p?.lat === "number" && typeof p?.lng === "number"
  );
  if (raw.length < 4) return null;

  const coordsLngLat: [number, number][] = raw.map((p) => [p.lng, p.lat]);
  const coords = decimate(coordsLngLat);
  const distance_m = pathDistanceM(coords);
  if (distance_m < MIN_LEARN_DISTANCE_M) return null;
  const duration_s = Math.max(0, Math.round((raw[raw.length - 1].ts - raw[0].ts) / 1000));

  const start = coords[0];
  const end = coords[coords.length - 1];
  const prev = cached.find((r) => r.placeId === input.placeId);
  const entry: AiRoute = {
    placeId: input.placeId,
    startLat: start[1], startLng: start[0],
    endLat: end[1], endLng: end[0],
    coords,
    drives: (prev?.drives ?? 0) + 1,
    lastDrivenAt: Date.now(),
    duration_s,
    distance_m,
  };
  cached = [entry, ...cached.filter((r) => r.placeId !== input.placeId)];
  await persist();
  return entry;
}

// Find a learned trace for a destination IF the current origin is near where that trace
// began. Caller resolves the saved place first (matchSavedPlace), then passes its id.
export function matchAiRoute(
  placeId: string,
  originLat: number,
  originLng: number
): AiRoute | undefined {
  const r = getAiRouteForPlace(placeId);
  if (!r) return undefined;
  return haversineM(originLat, originLng, r.startLat, r.startLng) <= AI_START_RADIUS_M ? r : undefined;
}

// Evenly-sampled INTERIOR via points (excludes the start + end — the Directions call
// supplies those as origin/destination). Capped so the waypoint URL stays well under
// Mapbox's 25-coordinate limit. These force the replayed route along the habitual path.
export function viaPointsFor(r: AiRoute, maxVia = 8): [number, number][] {
  const interior = r.coords.slice(1, -1);
  if (interior.length <= maxVia) return interior;
  const out: [number, number][] = [];
  const step = interior.length / maxVia;
  for (let i = 0; i < maxVia; i++) out.push(interior[Math.floor(i * step + step / 2)]);
  return out;
}

export async function removeAiRoute(placeId: string): Promise<AiRoute[]> {
  await ensureAiRoutesLoaded();
  cached = cached.filter((r) => r.placeId !== placeId);
  await persist();
  return cached;
}

export function useAiRoutes(): AiRoute[] {
  const [list, setList] = useState<AiRoute[]>(cached);
  useEffect(() => {
    let active = true;
    if (!loaded) loadPromise.then((v) => { if (active) setList(v); });
    listeners.add(setList);
    return () => { active = false; listeners.delete(setList); };
  }, []);
  return list;
}
