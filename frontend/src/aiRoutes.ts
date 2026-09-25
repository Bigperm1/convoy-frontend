// AI routes — the "how I actually drive there" memory. When you finish a drive to
// a saved place (Home / Work / custom), we persist a DECIMATED polyline of the path
// you really took. Next time you route to that place from near the same start, we
// re-run that habitual path through Mapbox (as via-waypoints) so it comes back as a
// real, traffic-aware NavRoute — your route, your way, even when it isn't the fastest.
//
// Local-only, no backend. Mirrors the storage shape of savedPlaces.ts: a module-level
// cache + load promise, with imperative get/record helpers.
// One trace per saved place. v1 stored the LAST drive, whatever it was; since 2026-09-24 a drive is judged against the
// remembered road before it may replace it, and a one-off waits in a candidate slot (see the learn section at the end).
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

// The geometry of one finished drive: the memory itself, or the candidate waiting to replace it.
export type AiTrace = {
  startLat: number; startLng: number;
  endLat: number; endLng: number;
  coords: [number, number][];       // decimated [lng,lat] driven path, origin -> dest
  t?: number[];                     // seconds from the drive's start at each kept coord (memories since 2026-09-24)
  m?: number[];                     // metres driven from the start at each kept coord, summed over the RAW fixes —
                                    // the kept coords are chords that cut corners on a winding road (Codex, 09-24)
  duration_s: number;               // last observed drive duration (fallback ETA)
  distance_m: number;
};
// How a finished drive related to the memory it met (compareDrive), plus the two outcomes recordDrive adds.
export type LearnVerdict = "same" | "partial" | "one-off";
export type LearnOutcome = LearnVerdict | "learn" | "promote";
export type AiRoute = AiTrace & {
  placeId: string;                  // the SavedPlace.id this trace leads to
  drives: number;                   // times learned/reinforced
  lastDrivenAt: number;
  learn?: LearnOutcome;             // how the last completed drive landed (since 2026-09-24)
  candidate?: AiTrace & { drivenAt: number };   // the last one-off against a habit; promoted when the next drive repeats it
};

let cached: AiRoute[] = [];
let loaded = false;

// Exported for the gate. Every coord must be a finite [lng,lat] pair: a persisted `[null, null]` used to pass and would
// throw inside compareDrive on the next drive, poisoning learning for that place (Codex review 2026-09-24).
export function isTrace(r: any): r is AiTrace {
  return !!(
    r &&
    Array.isArray(r.coords) && r.coords.length >= 2 &&
    r.coords.every((c: any) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) &&
    Number.isFinite(r.startLat) && Number.isFinite(r.startLng) &&
    Number.isFinite(r.endLat) && Number.isFinite(r.endLng)
  );
}

function isValid(r: any): r is AiRoute {
  return typeof r?.placeId === "string" && isTrace(r);
}

const loadPromise: Promise<AiRoute[]> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // A malformed candidate is dropped, never the memory it hangs off.
        cached = parsed.filter(isValid).map((r) => (r.candidate && !isTrace(r.candidate) ? { ...r, candidate: undefined } : r));
      }
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
  // Finite, not merely numeric: a NaN fix would ride into the memory and blind every later comparison against it.
  const raw = (input.trace || []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)
  );
  if (raw.length < 4) return null;

  const coordsLngLat: [number, number][] = raw.map((p) => [p.lng, p.lat]);
  const coords = decimate(coordsLngLat);
  // Distance is the RAW fix stream's length, not the kept chords': decimation (60 m gaps, then the 400-point cap
  // on a long drive) cuts corners, and on a winding road the chords can be well under half the road.
  const distance_m = pathDistanceM(coordsLngLat);
  if (distance_m < MIN_LEARN_DISTANCE_M) return null;
  const duration_s = Math.max(0, Math.round((raw[raw.length - 1].ts - raw[0].ts) / 1000));
  // Seconds and metres from the start at each kept coord (keyed by the coord array's identity, which decimate
  // preserves), so a replay from mid-drive is judged against what the remembered drive really took from there —
  // the last 3 km of a commute are local roads, not highway speed, and a mountain road is longer than its chords.
  const t0 = raw[0].ts;
  const tByCoord = new Map<[number, number], number>();
  const mByCoord = new Map<[number, number], number>();
  let acc = 0, maxGapM = 0;
  raw.forEach((p, i) => {
    if (i > 0) {
      const gap = haversineM(raw[i - 1].lat, raw[i - 1].lng, p.lat, p.lng);
      acc += gap;
      if (gap > maxGapM) maxGapM = gap;
    }
    tByCoord.set(coordsLngLat[i], Math.max(0, Math.round((p.ts - t0) / 1000)));
    mByCoord.set(coordsLngLat[i], Math.round(acc));
  });
  const t = coords.map((c) => tByCoord.get(c) ?? 0);
  const m = coords.map((c) => mByCoord.get(c) ?? 0);

  const start = coords[0];
  const end = coords[coords.length - 1];
  const trace: AiTrace = {
    startLat: start[1], startLng: start[0],
    endLat: end[1], endLng: end[0],
    coords, t, m, duration_s, distance_m,
  };
  // A recording with a hole in it (a tunnel, the app suspended) is a drive, not a geometry: it counts, it never replaces.
  const sparse = maxGapM > AI_TRACE_GAP_MAX_M;
  const entry = learnFrom(cached.find((r) => r.placeId === input.placeId), input.placeId, trace, Date.now(), sparse);
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

// The car's heading must be within this of the remembered path's direction at the matched point — a driver on the
// opposite carriageway, or heading away, is not "on this road" (Codex review 2026-09-24).
export const AI_HEADING_TOL_DEG = 75;
// A replay that takes far longer than the remembered drive's remaining time is not "my way" — it is Mapbox looping
// back to a via point the car can no longer reach (a missed exit). Rejected before it can be offered.
export const AI_REPLAY_SLOW_FACTOR = 1.5;
export const AI_REPLAY_SLOW_SLACK_S = 180;

// Cheap planar metres between two [lng,lat] points (fine at the scale of a match radius).
function planarM(a: [number, number], b: [number, number], cosLat: number): number {
  const dx = (a[0] - b[0]) * 111320 * cosLat;
  const dy = (a[1] - b[1]) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

// Planar metres from point p to the SEGMENT a–b (not to its endpoints): Mapbox's full-overview geometry puts vertices
// hundreds of metres apart on a straight highway, so a vertex-only distance called every remembered point between two
// vertices "divergent" (Codex review 2026-09-24).
function segDistM(p: [number, number], a: [number, number], b: [number, number], cosLat: number): number {
  const ax = (a[0] - p[0]) * 111320 * cosLat, ay = (a[1] - p[1]) * 111320;   // p → a
  const bx = (b[0] - a[0]) * 111320 * cosLat, by = (b[1] - a[1]) * 111320;   // a → b
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? -(ax * bx + ay * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * bx, cy = ay + t * by;                                   // p → closest point on the segment
  return Math.sqrt(cx * cx + cy * cy);
}

function bearingDeg(a: [number, number], b: [number, number], cosLat: number): number {
  const dx = (b[0] - a[0]) * cosLat, dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
function angleDiffDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

// Where along the remembered path the car is: the nearest point's index + its distance. Undefined when the car is
// not on that road, is heading the other way along it (when a heading is known), or is already so close to the end
// that there is nothing left to replay.
export function matchAiRouteAlongPath(
  r: AiRoute,
  originLat: number,
  originLng: number,
  headingDeg?: number | null,
): { route: AiRoute; idx: number; distM: number } | undefined {
  const pts = r.coords;
  if (!pts || pts.length < 2) return undefined;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const o: [number, number] = [originLng, originLat];
  const withHeading = typeof headingDeg === "number" && Number.isFinite(headingDeg);
  let idx = -1, best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = planarM(o, pts[i], cosLat);
    if (d > AI_MATCH_RADIUS_M || d >= best) continue;
    if (withHeading) {
      const j = i < pts.length - 1 ? i : i - 1;
      if (angleDiffDeg(bearingDeg(pts[j], pts[j + 1], cosLat), headingDeg as number) > AI_HEADING_TOL_DEG) continue;
    }
    best = d; idx = i;
  }
  if (idx < 0) return undefined;
  let remaining = 0;
  for (let i = idx + 1; i < pts.length; i++) remaining += planarM(pts[i - 1], pts[i], cosLat);
  if (remaining < AI_MIN_REMAINING_M) return undefined;
  return { route: r, idx, distM: best };
}

// True when the memory carries per-point driven metres that line up with its coords.
export function hasDrivenMetres(r: AiRoute): boolean {
  return Array.isArray(r.m) && r.m.length === r.coords.length && r.m.length >= 2;
}

// Metres from index `fromIdx` to the end of the memory: the driven metres when the memory has them, else the
// kept chords (an under-count on a winding road — which is why the distance vet only runs with driven metres).
export function remainingPathM(r: AiRoute, fromIdx: number): number {
  const pts = r.coords;
  if (!pts || pts.length < 2) return 0;
  const from = Math.min(Math.max(0, fromIdx), pts.length - 1);
  if (hasDrivenMetres(r)) return Math.max(0, (r.m as number[])[pts.length - 1] - (r.m as number[])[from]);
  const cosLat = Math.cos((r.startLat * Math.PI) / 180);
  let m = 0;
  for (let i = from + 1; i < pts.length; i++) m += planarM(pts[i - 1], pts[i], cosLat);
  return m;
}

// A replay much LONGER than the remembered path still ahead is a loop back to a via the car can no longer
// reach (a missed exit: on to the next exit and back). Distance needs no speed assumption, so it is the rule
// for every memory; the timed rule below only applies when the memory carries per-point times.
export const AI_REPLAY_LONG_FACTOR = 1.3;
export const AI_REPLAY_LONG_SLACK_M = 1000;

// The replay came back — is it still "my way"? Returns null when it is, else why it is refused:
//   • "uturn": it needs a U-turn the fastest route does not (a via point behind the car — a missed exit);
//   • "too-long": only for memories with per-point driven metres (`m`): its road distance is far more than the
//     remembered road still ahead (a loop back). Chords from an older memory cut corners and are NOT a yardstick;
//   • "too-slow": only for memories with per-point times (`t`): it takes far longer than the remembered drive
//     really took from this point. A whole-trip average speed is NOT used — the last 3 km of a commute are local
//     roads, and an exact replay of them would have been refused (Codex reviews 2026-09-24).
// Every memory written from 2026-09-24 carries both; recordDrive overwrites an older one on the next completed drive.
export function vetReplay(input: {
  memory: AiRoute; fromIdx: number; aiDistanceM: number; aiDurationS: number; aiUturns: number; bestUturns: number;
}): "uturn" | "too-long" | "too-slow" | null {
  const { memory, fromIdx, aiDistanceM, aiDurationS, aiUturns, bestUturns } = input;
  if (aiUturns > bestUturns) return "uturn";
  if (hasDrivenMetres(memory)) {
    const remainingM = remainingPathM(memory, fromIdx);
    if (remainingM > 0 && aiDistanceM > remainingM * AI_REPLAY_LONG_FACTOR + AI_REPLAY_LONG_SLACK_M) return "too-long";
  }
  const t = memory.t;
  if (t && t.length === memory.coords.length && memory.duration_s > 0) {
    const from = Math.min(Math.max(0, fromIdx), t.length - 1);
    const expectedS = Math.max(0, memory.duration_s - (t[from] ?? 0));
    if (expectedS > 0 && aiDurationS > expectedS * AI_REPLAY_SLOW_FACTOR + AI_REPLAY_SLOW_SLACK_S) return "too-slow";
  }
  return null;
}

// Via points for the part of the memory still AHEAD of the car. With the fastest route's geometry (`bestLngLat`),
// they are placed only where the remembered path diverges from it by more than AI_DIVERGE_M — spread over the
// divergent stretch(es) so Mapbox is pinned to "my way" there and left alone where the two agree. Returns [] when
// the memory never leaves the fastest route (there is no "my way" to offer) or nothing usable lies ahead. Without
// a Best geometry, falls back to even sampling of the points ahead. With the car's position + heading, any leading
// via point that lies BEHIND the car is dropped (the match landed on a ramp the car has just passed).
export function viaPointsAhead(
  r: AiRoute,
  fromIdx: number,
  bestLngLat?: [number, number][],
  maxVia = 8,
  car?: { lat: number; lng: number; headingDeg?: number | null },
): [number, number][] {
  let ahead = r.coords.slice(Math.max(0, fromIdx) + 1, -1);   // interior only: the call supplies origin + dest
  const cosLat = Math.cos((r.startLat * Math.PI) / 180);
  if (car && typeof car.headingDeg === "number" && Number.isFinite(car.headingDeg)) {
    const h = (car.headingDeg * Math.PI) / 180;
    const hx = Math.sin(h), hy = Math.cos(h);
    const aheadOfCar = (p: [number, number]) => (p[0] - car.lng) * cosLat * hx + (p[1] - car.lat) * hy > 0;
    let k = 0;
    while (k < ahead.length && !aheadOfCar(ahead[k])) k++;
    ahead = ahead.slice(k);
  }
  if (ahead.length < 1) return [];
  const sample = (list: [number, number][]): [number, number][] => {
    if (list.length <= maxVia) return list;
    const out: [number, number][] = [];
    const step = list.length / maxVia;
    for (let i = 0; i < maxVia; i++) out.push(list[Math.floor(i * step + step / 2)]);
    return out;
  };
  if (!bestLngLat || bestLngLat.length < 2) return ahead.length < 2 ? [] : sample(ahead);
  const divergent: boolean[] = ahead.map((p) => {
    let best = Infinity;
    for (let i = 1; i < bestLngLat.length; i++) {
      const d = segDistM(p, bestLngLat[i - 1], bestLngLat[i], cosLat);
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

// ── 2026-09-24 — a one-off drive must not overwrite the habit ──
// Jeff's Tim Hortons stop (09-24 09:27, plotted mid-commute) would have been the next morning's "AI route": recordDrive
// stored the LAST drive to a place, whatever it was. A drive is now judged against the remembered road before it may
// replace it. Four measurements, all point-to-segment against the remembered path, AI_SAME_ROAD_M wide, each allowed
// AI_SLACK_M before it means anything:
//   • excursionM — metres the DRIVE spent off the remembered road after first reaching it: a loop (a coffee stop, a
//     missed exit) or a different middle (another exit);
//   • missedM    — metres of the REMEMBERED road the drive never touched after first joining it: it skipped part of the
//     memory (the memory holds a loop the drive did not take — v1 stored whatever the last drive was, so it may);
//   • skippedM   — remembered metres before the drive first joined it: it started later along the road;
//   • leadM      — metres the drive spent before reaching the remembered road: it started earlier, or elsewhere.
// Verdicts: "same" — no excursion, nothing missed, joined at the start: it replaces the memory (fresh t[]/m[]; a lead
// from further back EXTENDS it — a lead that joins AT the start is behind the car at every later plot and is never
// replayed, so it is harmless); "partial" — no excursion, nothing missed, joined the road later but ON it: the longer
// memory is kept and the drive counted, so a memory never shrinks; "one-off" — an excursion, a skipped stretch, or a
// road that joins the memory mid-way from elsewhere. Why not a length ratio (> 25 % longer / < 60 % shared)? The coffee
// stop: 600 m off a 30 km commute is +4 % length and 96 % shared — it would have been reinforced. Why not a coverage
// ratio (≥ 90 %)? A start 1.5 km later covered 95 % and shrank the memory by 1.5 km, three times over (Codex review
// 2026-09-24). Gate: tools/sim-qc/ai_route_test.mts section G.

// Two drives are on the same road when within this of each other — the same width that decides "my way" against the
// fastest route at replay (AI_DIVERGE_M): opposite carriageways 20–50 m apart, a frontage road ≥ 150 m, nav GPS ≤ 30 m.
export const AI_SAME_ROAD_M = 120;
// Metres of excursion / missed road / skipped start / lead that still mean "the same road". Decimation keeps a point every
// 60 m, so this is five kept points: a lane change, a parking lot or one stray fix cannot reach it; a 150 m-deep stop and
// back can. It bounds how far a memory's start can drift per drive, and a from-home drive restores it.
export const AI_SLACK_M = 300;
// Drives before a memory is a habit worth defending; below it the last drive still wins, as v1 did.
export const AI_HABIT_MIN_DRIVES = 2;
// A raw fix-to-fix gap wider than this is a hole in the recording, not driving: the map keeps fixes ≥ 25 m apart at the
// location rate (~36 m per fix at 130 km/h), so 1 km is ~30 s without a fix — a tunnel or a suspended app. Measured on
// the RAW stream: the 400-point cap widens the KEPT gaps on a long drive and must not read as a hole.
export const AI_TRACE_GAP_MAX_M = 1000;

export function compareDrive(
  memory: { coords: [number, number][]; startLat: number },
  trace: [number, number][],
): { verdict: LearnVerdict; leadM: number; excursionM: number; missedM: number; skippedM: number } {
  const H = Array.isArray(memory.coords) ? memory.coords : [];
  const T = Array.isArray(trace) ? trace : [];
  if (H.length < 2 || T.length < 2) return { verdict: "one-off", leadM: 0, excursionM: 0, missedM: 0, skippedM: 0 };
  const cosLat = Math.cos((memory.startLat * Math.PI) / 180);
  const nearPath = (p: [number, number], path: [number, number][]): boolean => {
    for (let i = 1; i < path.length; i++) if (segDistM(p, path[i - 1], path[i], cosLat) <= AI_SAME_ROAD_M) return true;
    return false;
  };
  // The drive against the memory: where it was before reaching the road, and where it went off it afterwards.
  const onT = T.map((p) => nearPath(p, H));
  const first = onT.indexOf(true);
  let leadM = 0, excursionM = 0;
  for (let i = 1; i < T.length; i++) {
    const d = planarM(T[i - 1], T[i], cosLat);
    if (first < 0 || i <= first) leadM += d;                 // before the road is reached (or it never is)
    else if (!(onT[i - 1] && onT[i])) excursionM += d;       // off the road after reaching it: a loop, another middle, a tail
  }
  // The memory against the drive: remembered road the drive never touched — before it joined (a later start) or after.
  const onH = H.map((p) => nearPath(p, T));
  let skippedM = 0, missedM = 0, joined = false;
  for (let i = 1; i < H.length; i++) {
    const d = planarM(H[i - 1], H[i], cosLat);
    if (onH[i - 1] && onH[i]) { joined = true; continue; }
    if (joined) missedM += d; else skippedM += d;
  }
  const verdict: LearnVerdict =
    first < 0 || excursionM > AI_SLACK_M || missedM > AI_SLACK_M ? "one-off"
    : skippedM <= AI_SLACK_M ? "same"
    : leadM <= AI_SLACK_M ? "partial"
    : "one-off";
  return { verdict, leadM, excursionM, missedM, skippedM };
}

function traceOf(x: AiTrace): AiTrace {
  const { startLat, startLng, endLat, endLng, coords, t, m, duration_s, distance_m } = x;
  return { startLat, startLng, endLat, endLng, coords, t, m, duration_s, distance_m };
}

// The next memory for a place after a finished drive. Pure, so the gate can drive it through recordDrive. A `sparse`
// drive (a hole in the recording) is evidence of where he went, never a geometry to keep.
function learnFrom(prev: AiRoute | undefined, placeId: string, trace: AiTrace, now: number, sparse: boolean): AiRoute {
  if (!prev) return { placeId, ...trace, drives: 1, lastDrivenAt: now, learn: "learn" };
  const v = compareDrive(prev, trace.coords).verdict;
  if (v === "same" || v === "partial") {
    // The habit, driven again: counted, the candidate forgotten. Replaced only by a whole, dense recording of it.
    return v === "same" && !sparse
      ? { placeId, ...trace, drives: prev.drives + 1, lastDrivenAt: now, learn: v }
      : { ...prev, candidate: undefined, drives: prev.drives + 1, lastDrivenAt: now, learn: v };
  }
  if (prev.drives < AI_HABIT_MIN_DRIVES) {
    // No habit yet: the last drive wins, as v1 did — unless it has a hole in it.
    return sparse ? { ...prev, lastDrivenAt: now, learn: v } : { placeId, ...trace, drives: prev.drives + 1, lastDrivenAt: now, learn: v };
  }
  // A one-off against a habit. Twice IN A ROW — it repeats the candidate left by the previous drive — and it is the way now,
  // with THIS drive's geometry: only what was driven twice is promoted, never a loop the candidate drove once (Codex 2026-09-24).
  const cand = prev.candidate;
  if (cand && compareDrive(cand, trace.coords).verdict !== "one-off") {
    const geometry = sparse ? traceOf(cand) : trace;
    return { placeId, ...geometry, drives: AI_HABIT_MIN_DRIVES, lastDrivenAt: now, learn: "promote" };
  }
  if (sparse) return { ...prev, lastDrivenAt: now, learn: v };
  return { ...prev, lastDrivenAt: now, learn: v, candidate: { ...trace, drivenAt: now } };
}
