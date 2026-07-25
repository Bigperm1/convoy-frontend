// src/roadSnap.ts
//
// Phase-2 road-snap: client-side "nearest road" resolver for the self marker.
//
// The map already renders Mapbox Standard, but Standard v3 hides its own road layers from
// queries — so ConvoyMapbox/CarMapView add their OWN invisible mapbox-streets-v8 VectorSource
// + a road LineLayer (opacity 0, purely so the road tiles LOAD in the viewport). They then
// call MapView.querySourceFeatures(...,['road']) near the car and pass the returned road
// LineStrings here. nearestRoadLine picks the road whose nearest segment is closest and
// returns that road's whole polyline; the caller LOCKS onto that line and then projects the
// LIVE raw fix onto it every render (via ConvoyMapbox's projectOntoRoute), so the marker
// tracks smoothly ALONG the road between the ~1.4s re-queries instead of freezing at the
// query-time point. Free, offline (loaded tiles), no network, no API cost.
//
// DISPLAY-ONLY. Callers snap ONLY the drawn marker; reroute/off-route detection, the camera
// used for detection, the /location POST and presence all stay on RAW GPS (see nav.ts). The
// snapped pose must never be lifted back into `coords`, or deviations get masked.

export type LatLng = { latitude: number; longitude: number };
export type RoadLine = { line: LatLng[]; distM: number };

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

// Perpendicular distance (m) from P to segment A→B, all in lat/lng. Local planar frame.
function segDistM(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(pLat * DEG);
  const bx = (bLng - aLng) * mPerDegLng, by = (bLat - aLat) * M_PER_DEG_LAT;
  const px = (pLng - aLng) * mPerDegLng, py = (pLat - aLat) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - t * bx, py - t * by);
}

// Scan every road LineString/MultiLineString; return the polyline of the road whose nearest
// segment is globally closest, if that distance is within maxM (else null — e.g. a parking
// lot, so the caller keeps raw GPS). The caller then projects the live fix onto `line`.
export function nearestRoadLine(
  lat: number, lng: number, features: any[] | null | undefined, maxM: number,
): RoadLine | null {
  if (!features || !features.length) return null;
  let bestDist = Infinity;
  let bestLine: number[][] | null = null;
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    const lines: number[][][] | null =
      g.type === 'MultiLineString' ? g.coordinates
      : g.type === 'LineString' ? [g.coordinates]
      : null;
    if (!lines) continue;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        if (typeof a[1] !== 'number' || typeof b[1] !== 'number') continue;
        const d = segDistM(lat, lng, a[1], a[0], b[1], b[0]);
        if (d < bestDist) { bestDist = d; bestLine = line; }
      }
    }
  }
  if (bestLine === null || bestDist > maxM) return null;
  return { line: bestLine.map((c) => ({ latitude: c[1], longitude: c[0] })), distM: bestDist };
}

// Absolute shortest-arc angle [0,180] between two compass headings.
export function headingDeltaDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

// A road is bidirectional, so travel heading can align with the segment bearing OR its
// reverse — return the smaller of the two deltas (used to reject a perpendicular cross-street
// the car is merely driving OVER, not travelling along).
export function roadHeadingOff(travelHdg: number, segBearing: number): number {
  return Math.min(headingDeltaDeg(travelHdg, segBearing), headingDeltaDeg(travelHdg, segBearing + 180));
}

// ── Is this projection actually USABLE for drawing? ─────────────────────────────
// Road features come back from querySourceFeatures TILE-CLIPPED, so a "road" is often
// a short fragment. projectOntoRoute clamps each segment's t to [0,1], so once the car
// drives PAST a fragment's end the nearest point IS that endpoint — the drawn marker
// PINS there while the driver keeps moving, and stays pinned because the distance to
// the endpoint is still inside the release band. Measured on a 60 m fragment at
// 100 km/h: the marker froze for ~1.2 s and fell 34 m behind before releasing, then
// teleported forward. Repeat at every fragment boundary and you get Jeff's 2026-07-24
// report — "the car marker does not really follow the location I am currently at and
// it is very glitchy when moving ... it's like it's lost" — on BOTH surfaces, because
// both run this same snap.
// So: if the projection sits AT an end of the line, only trust it while the car is
// still within a lane-ish distance of that end. Past that we have left the fragment —
// return false and let the caller fall back to RAW GPS, which is the safe direction
// (true position beats a pretty one).
export const ROAD_SNAP_END_TOL_M = 6;
export function roadProjUsable(
  p: { frac: number; distM: number; totalM: number } | null | undefined,
): boolean {
  if (!p || !Number.isFinite(p.totalM) || p.totalM <= 0) return false;
  const alongM = p.frac * p.totalM;
  const atEnd = alongM <= 0.5 || p.totalM - alongM <= 0.5;
  return !atEnd || p.distM <= ROAD_SNAP_END_TOL_M;
}
