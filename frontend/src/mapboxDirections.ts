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

// ===== Lane guidance =========================================================
// Convoy's turn-by-turn maneuvers come from Google (nav.ts), which returns NO
// lane data. Mapbox Directions DOES (`banner_instructions`), so we fetch lane
// guidance once per navigation session and anchor each maneuver's lanes to its
// geographic location. At display time we match the upcoming GOOGLE maneuver to
// the nearest Mapbox cue by location (pickLaneCue) and show lanes ONLY when the
// two engines agree on where the turn is — a routing divergence yields no lanes
// rather than wrong lanes. Fails soft everywhere: any error → null → no lanes.

// One lane within an upcoming maneuver's guidance.
export type LaneArrow = {
  // Mapbox direction tokens this lane allows, e.g. ["straight"], ["left","straight"].
  dirs: string[];
  // True when this lane can be used for the upcoming maneuver.
  active: boolean;
  // When active, the specific direction to follow through this lane.
  activeDir?: string;
};

// Lane guidance for one maneuver, anchored to that maneuver's location.
export type LaneCue = { lat: number; lng: number; lanes: LaneArrow[] };

// Fetch per-maneuver lane cues for a route. One Directions call per navigation
// session (NOT per GPS tick). overview=false keeps the payload small — we only
// need steps + banners, not geometry. Returns null on any failure.
export async function fetchMapboxLaneCues(
  origin: LatLng,
  dest: LatLng,
  opts?: { signal?: AbortSignal },
): Promise<LaneCue[] | null> {
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
      `?steps=true&banner_instructions=true&overview=false` +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}`;
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    const steps: any[] = json?.routes?.[0]?.legs?.[0]?.steps || [];
    const cues: LaneCue[] = [];
    for (const s of steps) {
      const loc = s?.maneuver?.location; // [lng, lat]
      if (!Array.isArray(loc) || loc.length < 2) continue;
      // Find a banner for this step that carries lane sub-components.
      let lanes: LaneArrow[] | null = null;
      for (const b of (s.bannerInstructions || [])) {
        const comps = b?.sub?.components;
        if (!Array.isArray(comps)) continue;
        const laneComps = comps.filter((c: any) => c?.type === "lane");
        if (!laneComps.length) continue;
        lanes = laneComps.map((c: any): LaneArrow => ({
          dirs: Array.isArray(c.directions) ? c.directions : [],
          active: !!c.active,
          activeDir: typeof c.active_direction === "string" ? c.active_direction : undefined,
        }));
        break; // first banner with lane data wins
      }
      if (lanes && lanes.length) cues.push({ lat: loc[1], lng: loc[0], lanes });
    }
    return cues;
  } catch {
    return null;
  }
}

// How close the Google maneuver and a Mapbox cue must be to count as the same
// turn, and how near the turn we start showing lanes.
const LANE_MATCH_RADIUS_M = 30;
const LANE_SHOW_WITHIN_M = 600;

// Pick the lane set for the CURRENTLY upcoming maneuver. Matches the Google
// maneuver location to the nearest Mapbox cue within a tight radius (fail-closed:
// no close match → null) and only surfaces lanes once you're within ~600 m of
// the turn, so the row doesn't sit up for the whole leg.
export function pickLaneCue(
  cues: LaneCue[] | null | undefined,
  maneuver: LatLng | null | undefined,
  distanceToManeuverM: number,
): LaneArrow[] | null {
  if (!cues || !cues.length || !maneuver) return null;
  if (!(distanceToManeuverM <= LANE_SHOW_WITHIN_M)) return null;
  let best: LaneCue | null = null;
  let bestD = Infinity;
  for (const c of cues) {
    const d = segMeters([c.lng, c.lat], [maneuver.lng, maneuver.lat]);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || bestD > LANE_MATCH_RADIUS_M) return null;
  return best.lanes;
}

// ===== Full route source (Google Routes API replacement) =====================
// The THIRD query variant of this module (after congestion + lane cues): the
// complete driving-traffic route used to DRIVE turn-by-turn, replacing Google.
// Returns geometry + steps + per-segment congestion + a real traffic vs free-flow
// duration split in ONE call. geometries=polyline (precision-5) is deliberate so
// nav.ts's existing decodePolyline (/1e5) keeps working unchanged.

export type MapboxManeuver = {
  type?: string;       // "turn" | "merge" | "fork" | "roundabout" | "depart" | ...
  modifier?: string;   // "left" | "right" | "slight left" | "uturn" | ...
  instruction?: string;
  location?: [number, number]; // [lng, lat]
};

export type MapboxRouteStep = {
  distance: number;            // metres
  duration: number;            // seconds (traffic-aware)
  name?: string;
  maneuver?: MapboxManeuver;
  geometry?: string;           // encoded polyline (precision-5)
};

export type MapboxRoute = {
  polyline: string;                  // encoded precision-5 (whole route)
  coordinates: [number, number][];   // [lng,lat] decoded geometry (for congestion paint)
  congestion: CongestionLevel[];     // one per segment (coordinates.length - 1)
  distance_m: number;
  duration_s: number;                // traffic-aware
  freeflow_s: number;                // typical/no-traffic (annotation duration sum)
  summary: string;
  steps: MapboxRouteStep[];
};

// Decode a precision-5 polyline to [lng,lat] (GeoJSON order for Mapbox paint).
function decodePolyline5LngLat(encoded: string): [number, number][] {
  const pts: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b: number, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push([lng / 1e5, lat / 1e5]);
    }
  } catch { return []; }
  return pts;
}

export type MapboxAvoid = { tolls?: boolean; highways?: boolean; ferries?: boolean };

// Fetch up to `alternatives` driving-traffic routes from origin->dest with steps,
// congestion, and a traffic/free-flow duration split. Returns [] on any failure
// (caller decides fallback). One leg (no waypoints) so annotations cover the whole
// geometry.
export async function fetchMapboxRoutes(
  origin: LatLng,
  dest: LatLng,
  avoid?: MapboxAvoid,
  opts?: { signal?: AbortSignal },
): Promise<MapboxRoute[]> {
  try {
    if (
      typeof origin?.lat !== "number" || typeof origin?.lng !== "number" ||
      typeof dest?.lat !== "number" || typeof dest?.lng !== "number"
    ) return [];

    const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const exclude: string[] = [];
    if (avoid?.tolls) exclude.push("toll");
    if (avoid?.highways) exclude.push("motorway");
    if (avoid?.ferries) exclude.push("ferry");

    const qs =
      `?alternatives=true&steps=true&overview=full&geometries=polyline` +
      `&annotations=congestion,duration,distance&banner_instructions=false` +
      (exclude.length ? `&exclude=${exclude.join(",")}` : ``) +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}`;

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}${qs}`;
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return [];
    const json: any = await res.json();
    const routes: any[] = Array.isArray(json?.routes) ? json.routes : [];
    if (!routes.length) return [];

    return routes.map((route: any): MapboxRoute => {
      const polyline: string = typeof route?.geometry === "string" ? route.geometry : "";
      const coordinates = decodePolyline5LngLat(polyline);
      const leg = route?.legs?.[0] || {};
      const ann = leg?.annotation || {};

      const segCount = Math.max(0, coordinates.length - 1);
      const rawC: any[] = Array.isArray(ann.congestion) ? ann.congestion : [];
      const congestion: CongestionLevel[] = new Array(segCount);
      for (let i = 0; i < segCount; i++) {
        const v = rawC[i];
        congestion[i] = (v === "low" || v === "moderate" || v === "heavy" || v === "severe") ? v : "unknown";
      }

      // Traffic-aware duration = route.duration. Free-flow ~= sum of per-segment
      // annotation durations is ALSO traffic-aware on driving-traffic, so use the
      // route's `duration_typical` when present, else fall back to route.duration.
      const durationS = typeof route?.duration === "number" ? route.duration : 0;
      const freeflowS = typeof route?.duration_typical === "number" ? route.duration_typical : durationS;

      const steps: MapboxRouteStep[] = Array.isArray(leg?.steps)
        ? leg.steps.map((s: any): MapboxRouteStep => ({
            distance: typeof s?.distance === "number" ? s.distance : 0,
            duration: typeof s?.duration === "number" ? s.duration : 0,
            name: typeof s?.name === "string" ? s.name : undefined,
            geometry: typeof s?.geometry === "string" ? s.geometry : undefined,
            maneuver: (() => {
              if (!s?.maneuver) return undefined;
              try { console.log("[nav] raw mapbox maneuver:", JSON.stringify({ type: s.maneuver.type, modifier: s.maneuver.modifier, instruction: s.maneuver.instruction })); } catch {}
              return {
                type: s.maneuver.type,
                modifier: s.maneuver.modifier,
                instruction: s.maneuver.instruction,
                location: Array.isArray(s.maneuver.location) ? s.maneuver.location : undefined,
              };
            })(),
          }))
        : [];

      return {
        polyline,
        coordinates,
        congestion,
        distance_m: typeof route?.distance === "number" ? route.distance : (leg?.distance ?? 0),
        duration_s: durationS,
        freeflow_s: freeflowS,
        summary: typeof leg?.summary === "string" ? leg.summary : "",
        steps,
      };
    }).filter((r) => r.polyline);
  } catch {
    return []; // includes AbortError
  }
}
