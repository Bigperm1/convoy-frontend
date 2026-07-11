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
