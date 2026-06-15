// mapboxDirections.ts — Convoy's FIRST first-party Mapbox routing data.
//
// Right now this is used for ONE thing: the live traffic-congestion gradient on
// the route preview (parked-testable). It is deliberately small and isolated so
// it can grow into the foundation of the planned Google→Mapbox routing swap —
// when we're ready (and able to drive-test turn-by-turn), the SAME fetch gets
// extended with steps/maneuvers and promoted to the real route source in nav.ts,
// replacing Google. Until then the Google route still drives all guidance; this
// only paints the colored line.
//
// Notes:
//   • Uses the public pk.* token (same one the map tiles use) — re-exported from
//     initMapbox so there's a single source of truth.
//   • The "driving-traffic" profile is REQUIRED for live `congestion` — plain
//     "driving" omits it.
//   • Billable (generous free tier). We fetch only when the DESTINATION changes,
//     never on a GPS tick, to keep request volume tiny.
//   • Fails soft: any error / bad shape returns null, and the caller simply
//     falls back to the normal blue route line. The gradient can never break the
//     map.

import { MAPBOX_PUBLIC_TOKEN } from "./initMapbox";

export type LatLng = { lat: number; lng: number };

// Mapbox congestion levels (per geometry segment). "unknown" = no traffic data.
export type CongestionLevel = "unknown" | "low" | "moderate" | "heavy" | "severe";

export type CongestionRoute = {
  // [lng, lat] vertices of the route geometry (GeoJSON order, ready for Mapbox).
  coordinates: [number, number][];
  // One congestion level per SEGMENT, so length === coordinates.length - 1.
  congestion: CongestionLevel[];
};

// ---- Congestion → colour ----------------------------------------------------
// Brand green (→ red) palette. "unknown" (no live data) and "low" both render in
// the SAME brand green as the plain route core (sampled from new_logo_icons.png),
// so a clear route looks identical whether or not the gradient is active — it
// only WARMS toward yellow / orange / red where Mapbox reports actual slow-downs.
const CONGESTION_COLOR: Record<CongestionLevel, string> = {
  unknown: "#2DEC86", // no live data → brand green (matches the route core)
  low: "#2DEC86",     // clear — brand green
  moderate: "#FFD60A", // slowing — yellow
  heavy: "#FF9500",    // congested — orange
  severe: "#FF3B30",   // jammed — red
};
const DEFAULT_COLOR = CONGESTION_COLOR.unknown;

function colorFor(level: CongestionLevel | string | undefined): string {
  return (level && (CONGESTION_COLOR as any)[level]) || DEFAULT_COLOR;
}

// Haversine metres between two [lng, lat] points (for segment fractions).
function segMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(a[0] - b[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Build a Mapbox `lineGradient` INTERPOLATE expression that colours the line by
// congestion along its length, blending each colour change over a short band so
// the result reads as a smooth gradient rather than hard blocks. Requires the
// LineLayer's source to have `lineMetrics: true` (so `line-progress` 0..1 is
// available). Returns a plain colour string when there's only one colour overall
// (no gradient needed).
export function buildCongestionGradient(
  coordinates: [number, number][],
  congestion: CongestionLevel[],
): any {
  const segCount = Math.max(0, coordinates.length - 1);
  if (segCount === 0) return DEFAULT_COLOR;

  // Segment lengths + total, for fractional positions along the line.
  const lengths: number[] = new Array(segCount);
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const len = segMeters(coordinates[i], coordinates[i + 1]);
    lengths[i] = len;
    total += len;
  }
  if (total <= 0) return colorFor(congestion[0]);

  // Walk the segments, recording each colour CHANGE point (fraction along the
  // line where the colour flips). A plain step expression here gives hard edges;
  // below we expand each change into a short blend band so the gradient reads
  // smoothly (green→yellow→orange→red) instead of as solid blocks.
  const baseColor = colorFor(congestion[0]);
  const changes: Array<[number, string]> = [];
  let cum = 0;
  let prevColor = baseColor;
  for (let i = 0; i < segCount; i++) {
    const frac = cum / total; // fraction at the START of segment i
    const color = colorFor(congestion[i]);
    if (i > 0 && color !== prevColor && frac > 0 && frac < 1) {
      // Avoid duplicate / non-ascending change inputs.
      if (changes.length === 0 || frac > changes[changes.length - 1][0]) {
        changes.push([frac, color]);
        prevColor = color;
      }
    }
    cum += lengths[i];
  }

  if (changes.length === 0) return baseColor; // single colour → solid

  // Expand each colour change at fraction f into a blend band: hold the previous
  // colour up to (f - HALF), then linearly blend to the new colour by (f + HALF),
  // so each transition spans ~2.5% of the line. Where two changes are closer than
  // a full band, the band is shrunk for that pair (and collapses to a near-hard
  // edge if they nearly coincide) — inputs are kept clamped to [0,1] and strictly
  // ascending, which `interpolate` requires.
  const HALF = 0.0125; // ±1.25% → ~2.5% total blend width
  const EPS = 1e-4;
  const out: Array<[number, string]> = [[0, baseColor]];
  let prevInput = 0;
  let curColor = baseColor;
  for (let k = 0; k < changes.length; k++) {
    const [f, color] = changes[k];
    const nextF = k + 1 < changes.length ? changes[k + 1][0] : 1;
    // Limit the band so it never overruns the previous stop or the next change.
    const band = Math.min(HALF, (f - prevInput) / 2, (nextF - f) / 2);
    let lo = f - band;
    let hi = f + band;
    // Strict-ascension + [0,1] guards (handles colliding/clustered changes).
    if (lo <= prevInput) lo = prevInput + EPS;
    if (hi <= lo) hi = lo + EPS;
    if (hi > 1) hi = 1;
    if (lo >= hi) lo = hi - EPS;
    if (lo <= prevInput) continue; // no room → merge into the prior transition
    out.push([lo, curColor]);
    out.push([hi, color]);
    prevInput = hi;
    curColor = color;
  }
  if (prevInput < 1) out.push([1, curColor]);

  // Final defensive pass: guarantee strictly ascending inputs for interpolate.
  const expr: any[] = ["interpolate", ["linear"], ["line-progress"]];
  let lastInput = -1;
  for (const [input, color] of out) {
    const v = input > lastInput ? input : lastInput + 1e-6;
    expr.push(v, color);
    lastInput = v;
  }
  return expr;
}

// Fetch the PRIMARY driving-traffic route from origin→dest and return its
// geometry + per-segment congestion. Returns null on any failure (caller falls
// back to the normal route line). No intermediate waypoints, so there is exactly
// one leg whose annotation covers the whole geometry.
export async function fetchMapboxCongestion(
  origin: LatLng,
  dest: LatLng,
  opts?: { signal?: AbortSignal },
): Promise<CongestionRoute | null> {
  try {
    if (
      typeof origin?.lat !== "number" || typeof origin?.lng !== "number" ||
      typeof dest?.lat !== "number" || typeof dest?.lng !== "number"
    ) {
      return null;
    }
    const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
      `?annotations=congestion&overview=full&geometries=geojson&steps=false` +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}`;

    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    const route = json?.routes?.[0];
    const coordinates: [number, number][] = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

    // Congestion lives on the leg annotation; with no waypoints there's one leg.
    const rawCongestion: any[] = route?.legs?.[0]?.annotation?.congestion || [];
    const segCount = coordinates.length - 1;
    const congestion: CongestionLevel[] = new Array(segCount);
    for (let i = 0; i < segCount; i++) {
      const v = rawCongestion[i];
      congestion[i] =
        v === "low" || v === "moderate" || v === "heavy" || v === "severe" ? v : "unknown";
    }
    return { coordinates, congestion };
  } catch {
    return null; // includes AbortError — a stale request was simply cancelled
  }
}
