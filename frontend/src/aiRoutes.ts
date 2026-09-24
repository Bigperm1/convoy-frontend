// AI routes — the "how I actually drive there" memory. When you finish a drive to
// a saved place (Home / Work / custom), we persist a DECIMATED polyline of the path
// you really took. Next time you route to that place from near the same start, we
// re-run that habitual path through Mapbox (as via-waypoints) so it comes back as a
// real, traffic-aware NavRoute — your route, your way, even when it isn't the fastest.
//
// Local-only, no backend. Mirrors the storage shape of savedPlaces.ts: a module-level
// cache + load promise, with imperative get/record helpers.
// One trace per saved place (last-good v1; most-frequent clustering can come later).
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  return cached;
})();

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(cached));
  } catch {}
}

export async function ensureAiRoutesLoaded(): Promise<AiRoute[]> {
  return loaded ? cached : loadPromise;
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
// Kept for callers that have no fastest-route geometry to compare against; the map's plot
// path uses viaPointsAhead below (Jeff, 2026-09-24).
export function viaPointsFor(r: AiRoute, maxVia = 8): [number, number][] {
  const interior = r.coords.slice(1, -1);
  if (interior.length <= maxVia) return interior;
  const out: [number, number][] = [];
  const step = interior.length / maxVia;
  for (let i = 0; i < maxVia; i++) out.push(interior[Math.floor(i * step + step / 2)]);
  return out;
}

// ── 2026-09-24 — Jeff: "FOR SOME REASON THE ROUTE LEARNING IS NOT WORKING... EVERYDAY I MERGE OFF THE
// HIGHWAY ON THE WAY TO WORK, BUT IT ALWAYS IS TAKING ME THE FASTEST WAY NOT MY WAY. LETS FIX IT" ──
// Two things about the v1 replay could not survive his commute, so both are replaced here:
//   • matchAiRoute only applied within 350 m of the FIRST fix of the remembered drive. Every commute plot in his
//     crumbs is `depart-rank fsrc=course` — he plots while already moving — so that first fix is wherever he
//     happened to tap Start that day, and 350 m of road is ~12 s at highway speed. The memory now applies when the
//     car is ON the remembered road (nearest point of the whole path), and only the part still ahead is replayed.
//   • viaPointsFor spread 8 points evenly over the whole drive (~4 km apart on his 33 km). A 3 km exit-and-
//     parallel-road detour can fall between two of them, Mapbox hands the highway back, and the "AI" route is
//     then dropped as identical to Best. The via points now sit on the stretch where his path LEAVES the fastest
//     route, so the replay is forced off the highway exactly where he goes.
// Gate: tools/sim-qc/ai_route_test.mts.

// Origin must be within this of the remembered PATH (any point of it) for the memory to apply.
export const AI_MATCH_RADIUS_M = 250;
// A remembered point further than this from the fastest route is "my way" — the via points go there.
export const AI_DIVERGE_M = 120;
// Nothing worth replaying once the car is within this of the end of the memory.
export const AI_MIN_REMAINING_M = 800;

// Cheap planar metres between two [lng,lat] points (fine at the scale of a match radius).
function planarM(a: [number, number], b: [number, number], cosLat: number): number {
  const dx = (a[0] - b[0]) * 111320 * cosLat;
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

// Where along the remembered path the car is: the nearest point's index + its distance. Undefined when the car is
// not on that road, or is already so close to the end that there is nothing left to replay.
export function matchAiRouteAlongPath(
  r: AiRoute,
  originLat: number,
  originLng: number,
): { route: AiRoute; idx: number; distM: number } | undefined {
  const pts = r.coords;
  if (!pts || pts.length < 2) return undefined;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const o: [number, number] = [originLng, originLat];
  let idx = 0, best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = planarM(o, pts[i], cosLat);
    if (d < best) { best = d; idx = i; }
  }
  if (best > AI_MATCH_RADIUS_M) return undefined;
  let remaining = 0;
  for (let i = idx + 1; i < pts.length; i++) remaining += planarM(pts[i - 1], pts[i], cosLat);
  if (remaining < AI_MIN_REMAINING_M) return undefined;
  return { route: r, idx, distM: best };
}

// Via points for the part of the memory still AHEAD of the car. With the fastest route's geometry (`bestLngLat`),
// they are placed only where the remembered path diverges from it by more than AI_DIVERGE_M — spread over the
// divergent stretch(es) so Mapbox is pinned to "my way" there and left alone where the two agree. Returns [] when
// the memory never leaves the fastest route (there is no "my way" to offer) or nothing usable lies ahead. Without
// a Best geometry, falls back to even sampling of the points ahead.
export function viaPointsAhead(
  r: AiRoute,
  fromIdx: number,
  bestLngLat?: [number, number][],
  maxVia = 8,
): [number, number][] {
  const ahead = r.coords.slice(Math.max(0, fromIdx) + 1, -1);   // interior only: the call supplies origin + dest
  if (ahead.length < 1) return [];
  const sample = (list: [number, number][]): [number, number][] => {
    if (list.length <= maxVia) return list;
    const out: [number, number][] = [];
    const step = list.length / maxVia;
    for (let i = 0; i < maxVia; i++) out.push(list[Math.floor(i * step + step / 2)]);
    return out;
  };
  if (!bestLngLat || bestLngLat.length < 2) return ahead.length < 2 ? [] : sample(ahead);
  const cosLat = Math.cos((r.startLat * Math.PI) / 180);
  const divergent: boolean[] = ahead.map((p) => {
    let best = Infinity;
    for (let i = 0; i < bestLngLat.length; i++) {
      const d = planarM(p, bestLngLat[i], cosLat);
      if (d < best) { best = d; if (best <= AI_DIVERGE_M) break; }
    }
    return best > AI_DIVERGE_M;
  });
  // Contiguous divergent runs, bridging single-point dropouts (GPS noise on the boundary).
  const runs: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (let i = 0; i < ahead.length; i++) {
    if (divergent[i] || (cur && i + 1 < ahead.length && divergent[i + 1])) {
      if (!cur) { cur = []; runs.push(cur); }
      if (divergent[i]) cur.push(ahead[i]);
    } else cur = null;
  }
  if (!runs.length) return [];
  if (runs.length === 1) return sample(runs[0]);
  // Several detours: share the via budget by length, at least one point (its middle) per run.
  const total = runs.reduce((a, run) => a + run.length, 0);
  const out: [number, number][] = [];
  const budget = Math.max(runs.length, maxVia);
  for (const run of runs) {
    const n = Math.max(1, Math.min(run.length, Math.round((run.length / total) * budget)));
    const step = run.length / n;
    for (let i = 0; i < n; i++) out.push(run[Math.floor(i * step + step / 2)]);
  }
  return out.length <= maxVia ? out : sample(out);
}
