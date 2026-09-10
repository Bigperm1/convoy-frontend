// speedLimitSnap — which tagged road the driver is ON, for the posted-limit sign and the speed
// alert. PURE (no React, no RN, no imports) so tools/sim-qc/speed_limit_snap_test.mts drives this
// exact code under Node. src/speedLimit.ts owns the Overpass cache and calls this on every resolve.
//
// ── WHY (2026-09-10, Jeff: "the first speed ding I think tripled up … make sure these are correct") ──
// His 09:01:55 row: `speed-alert tier=2 mode=ding over=45 limit=50` at 95 km/h, westbound on the
// Trans-Canada at 49.038018,-122.338203. OSM within 40 m of that point: the TCH (motorway,
// maxspeed 100), a ramp (motorway_link, no maxspeed) and CLEARBROOK ROAD (secondary, maxspeed 50)
// — the road crossing OVER the highway on the overpass. The old picker took the nearest tagged
// way by flat 2-D distance, and at the crossing point the overpass road IS the nearest way (0 m
// laterally, a bridge deck above), so for a second or two the limit read 50 and the double ding
// fired on a highway at 95. The road you are on runs the way you are going: a way whose direction
// disagrees with the car's course by more than SNAP_MAX_COURSE_DIFF_DEG (a crossing, an overpass,
// an underpass, a side street at a junction) cannot be the road you are on while you are moving.
// With no course (stopped, unknown) the old nearest-way rule stands.

export type LimitWay = {
  maxspeedKmh: number;
  geom: { lat: number; lng: number }[];
  /** OSM `oneway=yes`: the way only runs in its drawn direction; a two-way road matches either. */
  oneway?: boolean;
  /** OSM `highway=*` class, for the receipt and the tie-break (a `*_link` is a ramp). */
  highway?: string;
};

/** How close a road must be to count as "the road you're on". */
export const SNAP_TOLERANCE_M = 30;
/** A way pointing further than this from the car's course is a crossing road, not the road under the car. */
export const SNAP_MAX_COURSE_DIFF_DEG = 35;
/** Below this the course is not evidence of direction (a crawl, a parking manoeuvre): direction is ignored. */
export const SNAP_MIN_SPEED_MS = 3;

export type SnapResult = {
  limitKmh: number | null;
  /** Distance to the chosen way (m), Infinity when nothing is cached. */
  nearestM: number;
  /** The chosen way's class, for the receipt. */
  highway?: string;
  /** The nearest way REJECTED for direction (the overpass case), for the receipt. */
  crossing?: { limitKmh: number; distM: number; highway?: string; diffDeg: number } | null;
};

const wrap180 = (d: number) => ((((d) % 360) + 540) % 360) - 180;

function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(aLat), φ2 = toRad(bLat), Δλ = toRad(bLng - aLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Distance (metres) from point P to segment A→B, via a local equirectangular projection centred on P.
function segDistM(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const X = (lng: number) => toRad(lng - pLng) * cosLat * R;
  const Y = (lat: number) => toRad(lat - pLat) * R;
  const ax = X(aLng), ay = Y(aLat);
  const bx = X(bLng), by = Y(bLat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((0 - ax) * dx + (0 - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * The limit of the road the driver is on: the nearest cached way within SNAP_TOLERANCE_M whose
 * direction agrees with the course (when the course is evidence: moving ≥ SNAP_MIN_SPEED_MS with a
 * finite course). Ways rejected for direction are reported as `crossing` so the receipt can show
 * what the old rule would have picked.
 */
export function snapSpeedLimit(
  lat: number, lng: number, ways: LimitWay[],
  courseDeg: number | null | undefined, speedMs: number | null | undefined,
): SnapResult {
  const useCourse = typeof courseDeg === "number" && Number.isFinite(courseDeg) && courseDeg >= 0
    && typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs >= SNAP_MIN_SPEED_MS;
  let best = Infinity, bestSpeed: number | null = null, bestHwy: string | undefined;
  let crossing: SnapResult["crossing"] = null;
  for (const w of ways) {
    const g = w.geom;
    if (g.length === 1) {
      const d = haversineM(lat, lng, g[0].lat, g[0].lng);
      if (d < best) { best = d; bestSpeed = w.maxspeedKmh; bestHwy = w.highway; }
      continue;
    }
    for (let i = 0; i + 1 < g.length; i++) {
      const d = segDistM(lat, lng, g[i].lat, g[i].lng, g[i + 1].lat, g[i + 1].lng);
      if (d >= best) continue;
      if (useCourse) {
        const b = bearingDeg(g[i].lat, g[i].lng, g[i + 1].lat, g[i + 1].lng);
        const fwd = Math.abs(wrap180(b - courseDeg!));
        const diff = w.oneway ? fwd : Math.min(fwd, Math.abs(wrap180(b + 180 - courseDeg!)));
        if (diff > SNAP_MAX_COURSE_DIFF_DEG) {
          if (d <= SNAP_TOLERANCE_M && (!crossing || d < crossing.distM)) crossing = { limitKmh: w.maxspeedKmh, distM: d, highway: w.highway, diffDeg: diff };
          continue;
        }
      }
      best = d; bestSpeed = w.maxspeedKmh; bestHwy = w.highway;
    }
  }
  return { limitKmh: best <= SNAP_TOLERANCE_M ? bestSpeed : null, nearestM: Number.isFinite(best) ? best : Infinity, highway: bestHwy, crossing };
}
