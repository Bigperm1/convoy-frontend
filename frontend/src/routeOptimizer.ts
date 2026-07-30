// routeOptimizer.ts — put the driver's stops in the RIGHT ORDER.
//
// Jeff, 2026-07-29: "if I make a route and decide to stop near the end and plot it,
// then add another stop that is BEFORE the added stop, Scout should reroute the best
// route based on the two added stops and the end destination — it should re-organise
// the route stops. With Google Maps I have to re-organise them myself."
//
// So: origin and final destination are FIXED, and everything the driver pinned in
// between is free to be re-ordered. That is the travelling-salesman problem with
// fixed endpoints, and it is emphatically NOT a job for the language model — Scout
// ANNOUNCES the result, but the ordering is computed exactly here. An LLM guessing at
// a visiting order would be both slower and occasionally wrong, and wrong here means
// sending someone the long way round with no way to tell.
//
// ── THE CAPS ARE REAL AND WERE MEASURED, NOT ASSUMED (2026-07-29) ────────────
//   Optimization v1, driving-traffic .... 12 coords  -> origin + 10 stops + dest
//   Matrix, driving-traffic .............. 10 coords -> too small to be useful
//   Matrix, driving (free-flow) .......... 25 coords -> origin + 23 stops + dest
//   Directions, driving-traffic .......... 25 coords -> origin + 23 stops + dest
// Each of those was confirmed by walking the coordinate count up until the API
// returned 422 "Too many coordinates".
//
// Hence two tiers, and one honest wall:
//   • up to 10 stops  -> the Optimization API. Exact, and TRAFFIC-AWARE.
//   • 11 to 23 stops  -> a free-flow Matrix + nearest-neighbour + 2-opt, here on the
//     device. Correct ordering, but blind to live traffic (driving-traffic's matrix
//     tops out at 10 coordinates, so there is no traffic-aware matrix to be had).
//   • past 23 stops   -> the route cannot be DRAWN at all: Directions itself refuses
//     more than 25 coordinates. That is a platform ceiling, not a choice we are
//     making. Serving more would mean stitching several Directions calls per drive,
//     which would break the single refresh uuid and the one-axis segment ETA that the
//     accurate ETA and the congestion gradient are both built on.
import { MAPBOX_PUBLIC_TOKEN } from "./initMapbox";
import type { LatLng } from "./mapboxDirections";

// origin + stops + destination must fit the smallest API in the chain.
export const OPTIMIZE_MAX_STOPS = 10;   // Optimization v1: 12 coords
export const MATRIX_MAX_STOPS = 23;     // Matrix `driving`: 25 coords
export const ROUTABLE_MAX_STOPS = 23;   // Directions: 25 coords — the hard wall

export type StopOrder = {
  // Indices into the ORIGINAL stops array, in the order they should be driven.
  order: number[];
  // Which engine decided it — surfaced so the UI can say whether traffic was included.
  source: "optimization" | "matrix";
  // Optimal total drive time in seconds, when the engine gives us one.
  totalSec?: number;
  // Seconds saved versus the order the driver tapped in — ONLY set when it can be
  // measured like-for-like. The matrix tier scores both orders off the same matrix, so
  // there the number is exact. The Optimization tier has no comparable figure (its
  // traffic-aware matrix caps at 10 coordinates, below what this tier already uses),
  // and a savings claim built from two different origins would be fiction, so it stays
  // undefined and the UI simply says it reordered.
  savedSec?: number;
};

function coordList(pts: Array<[number, number]>): string {
  return pts.map(([lng, lat]) => `${lng},${lat}`).join(";");
}

function excludeParam(avoid?: { tolls?: boolean; highways?: boolean; ferries?: boolean }): string {
  const ex: string[] = [];
  if (avoid?.tolls) ex.push("toll");
  if (avoid?.highways) ex.push("motorway");
  if (avoid?.ferries) ex.push("ferry");
  return ex.length ? `&exclude=${ex.join(",")}` : "";
}

// ── Tier 1: the Optimization API (<= 10 stops) ───────────────────────────────
// `source=first` + `destination=last` + `roundtrip=false` pins the ends and permutes
// only the middle, which is exactly the shape of this problem. The response gives
// each input coordinate a `waypoint_index` = its position in the optimal trip.
async function viaOptimizationApi(
  origin: LatLng,
  stops: LatLng[],
  dest: LatLng,
  avoid?: { tolls?: boolean; highways?: boolean; ferries?: boolean },
  signal?: AbortSignal,
): Promise<StopOrder | null> {
  const pts: Array<[number, number]> = [
    [origin.lng, origin.lat],
    ...stops.map((s): [number, number] => [s.lng, s.lat]),
    [dest.lng, dest.lat],
  ];
  const url =
    `https://api.mapbox.com/optimized-trips/v1/mapbox/driving-traffic/${coordList(pts)}` +
    `?source=first&destination=last&roundtrip=false&overview=false` +
    excludeParam(avoid) +
    `&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const json: any = await res.json();
  if (json?.code !== "Ok" || !Array.isArray(json?.waypoints)) return null;

  // waypoints come back in INPUT order, each carrying its optimal position.
  const wps: any[] = json.waypoints;
  if (wps.length !== pts.length) return null;
  const positioned: Array<{ input: number; pos: number }> = [];
  for (let i = 0; i < wps.length; i++) {
    const pos = wps[i]?.waypoint_index;
    if (typeof pos !== "number") return null;
    positioned.push({ input: i, pos });
  }
  positioned.sort((a, b) => a.pos - b.pos);
  // Drop the pinned ends and shift back into stops-array indices.
  const order = positioned
    .map((p) => p.input)
    .filter((i) => i > 0 && i < pts.length - 1)
    .map((i) => i - 1);
  if (order.length !== stops.length) return null;
  const totalSec = typeof json?.trips?.[0]?.duration === "number" ? json.trips[0].duration : undefined;
  return { order, source: "optimization", totalSec };
}

// ── Tier 2: Matrix + nearest-neighbour + 2-opt (11..23 stops) ────────────────
// The `driving` profile is deliberate: driving-traffic's matrix caps at 10
// coordinates, so above tier 1 there is no traffic-aware matrix available at any
// price. Free-flow ordering is still far better than the order things were tapped in.
async function viaMatrix(
  origin: LatLng,
  stops: LatLng[],
  dest: LatLng,
  signal?: AbortSignal,
): Promise<StopOrder | null> {
  const pts: Array<[number, number]> = [
    [origin.lng, origin.lat],
    ...stops.map((s): [number, number] => [s.lng, s.lat]),
    [dest.lng, dest.lat],
  ];
  const url =
    `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coordList(pts)}` +
    `?annotations=duration&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const json: any = await res.json();
  const m: Array<Array<number | null>> = json?.durations;
  if (json?.code !== "Ok" || !Array.isArray(m) || m.length !== pts.length) return null;

  const N = pts.length;
  const START = 0, END = N - 1;
  // A missing pair (an unroutable stop) would poison the comparisons; treat it as
  // very expensive rather than bailing, so one bad pin cannot block the whole reorder.
  const BIG = 1e9;
  const d = (a: number, b: number) => {
    const v = m[a]?.[b];
    return typeof v === "number" && Number.isFinite(v) ? v : BIG;
  };
  const cost = (path: number[]) => {
    let t = 0;
    for (let i = 0; i + 1 < path.length; i++) t += d(path[i], path[i + 1]);
    return t;
  };

  // Nearest neighbour from the start for an initial tour...
  const mid = stops.map((_, i) => i + 1);
  const unvisited = new Set(mid);
  const tour: number[] = [START];
  let cur = START;
  while (unvisited.size) {
    let best = -1, bestD = Infinity;
    for (const c of unvisited) { const dc = d(cur, c); if (dc < bestD) { bestD = dc; best = c; } }
    if (best < 0) break;
    tour.push(best); unvisited.delete(best); cur = best;
  }
  tour.push(END);

  // ...then 2-opt: repeatedly reverse any interior span that shortens the tour. The
  // endpoints are never moved (i starts at 1, j stops before END), which is what keeps
  // origin and destination pinned. Bounded pass count so a pathological matrix cannot
  // spin on a phone mid-drive.
  let improved = true, guard = 0;
  while (improved && guard++ < 40) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let j = i + 1; j < tour.length - 1; j++) {
        const before = d(tour[i - 1], tour[i]) + d(tour[j], tour[j + 1]);
        const after = d(tour[i - 1], tour[j]) + d(tour[i], tour[j + 1]);
        if (after + 1e-6 < before) {
          let a = i, b = j;
          while (a < b) { const t = tour[a]; tour[a] = tour[b]; tour[b] = t; a++; b--; }
          improved = true;
        }
      }
    }
  }
  const order = tour.slice(1, -1).map((i) => i - 1);
  if (order.length !== stops.length) return null;
  const total = cost(tour);
  // Both orders scored off the SAME matrix, so this difference is exact.
  const givenPath = [START, ...mid, END];
  const given = cost(givenPath);
  const saved = given < BIG && total < BIG ? Math.max(0, given - total) : undefined;
  return {
    order,
    source: "matrix",
    totalSec: total < BIG ? total : undefined,
    savedSec: saved,
  };
}

// Is this order already what the driver has?
export function isSameOrder(order: number[]): boolean {
  return order.every((v, i) => v === i);
}

// Decide the best visiting order for the pinned stops. Origin and destination stay
// put. Returns null when there is nothing to do (fewer than 2 stops, past the routable
// ceiling, or the request failed) — every caller keeps the driver's own order then.
export async function optimizeStopOrder(
  origin: LatLng,
  stops: LatLng[],
  dest: LatLng,
  avoid?: { tolls?: boolean; highways?: boolean; ferries?: boolean },
  opts?: { signal?: AbortSignal },
): Promise<StopOrder | null> {
  try {
    const valid = (p: any) => p && typeof p.lat === "number" && typeof p.lng === "number";
    if (!valid(origin) || !valid(dest)) return null;
    if (!Array.isArray(stops) || stops.length < 2) return null;   // nothing to reorder
    if (!stops.every(valid)) return null;
    if (stops.length > ROUTABLE_MAX_STOPS) return null;           // cannot be drawn anyway
    if (stops.length <= OPTIMIZE_MAX_STOPS) {
      const r = await viaOptimizationApi(origin, stops, dest, avoid, opts?.signal);
      if (r) return r;
      // fall through — a matrix answer beats no answer
    }
    if (stops.length <= MATRIX_MAX_STOPS) return await viaMatrix(origin, stops, dest, opts?.signal);
    return null;
  } catch {
    return null; // includes AbortError
  }
}
