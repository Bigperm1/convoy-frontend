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

// Mapbox `congestion_numeric` is a 0–100 score per segment (null = no data) and is
// far more accurate + granular than the coarse categorical `congestion`, which
// rarely reports heavy/severe — the "only ever yellow, never orange/red" bug. Bucket
// it so genuinely slow / near-stopped traffic warms all the way through orange to red.
export function levelFromNumeric(n: any): CongestionLevel {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return "unknown";
  if (v < 35) return "low";       // free-flowing → green
  if (v < 55) return "moderate";  // slowing → yellow
  if (v < 75) return "heavy";     // congested → orange
  return "severe";                // near-stopped / stopped → red
}

// `baseColor` (the user's chosen route color) overrides the clear-traffic color
// (unknown / low) so a recolored route stays that color where traffic is moving;
// the warm slow-down stops (yellow / orange / red) keep their traffic meaning.
export function colorFor(level: CongestionLevel | string | undefined, baseColor?: string): string {
  if (level === "moderate" || level === "heavy" || level === "severe") {
    return (CONGESTION_COLOR as any)[level];
  }
  return baseColor || DEFAULT_COLOR; // unknown / low / undefined → the route base color
}

// Public: the color for one congestion level (clear → base color, warming through
// yellow/orange/red). Used to paint congestion-colored route segments outside the
// Mapbox-expression world (e.g. the reroute card's react-native-maps mini-map).
export function congestionColor(level: CongestionLevel | string | undefined, baseColor?: string): string {
  return colorFor(level, baseColor);
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
// Mapbox emits "Take exit EXIT 90 toward McCallum Road" for signed exits — its verb
// ("Take exit") plus the road's OWN exit signage ("EXIT 90") = a redundant double "exit"
// that shows in the banner AND gets read aloud. Collapse "exit EXIT" → "exit" (and the
// rarer "exit Exit") so it reads "Take exit 90 toward McCallum Road", like Google/Apple.
export function cleanManeuverInstruction(s?: string): string | undefined {
  if (!s) return s;
  return s.replace(/\bexit\s+exit\b/gi, "exit").replace(/\s{2,}/g, " ").trim();
}

export function buildCongestionGradient(
  coordinates: [number, number][],
  congestion: CongestionLevel[],
  routeBase?: string,
): any {
  const segCount = Math.max(0, coordinates.length - 1);
  if (segCount === 0) return routeBase || DEFAULT_COLOR;

  // Segment lengths + total, for fractional positions along the line.
  const lengths: number[] = new Array(segCount);
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const len = segMeters(coordinates[i], coordinates[i + 1]);
    lengths[i] = len;
    total += len;
  }
  if (total <= 0) return colorFor(congestion[0], routeBase);

  // Walk the segments, recording each colour CHANGE point (fraction along the
  // line where the colour flips). A plain step expression here gives hard edges;
  // below we expand each change into a short blend band so the gradient reads
  // smoothly (green→yellow→orange→red) instead of as solid blocks.
  const baseColor = colorFor(congestion[0], routeBase);
  const changes: Array<[number, string]> = [];
  let cum = 0;
  let prevColor = baseColor;
  for (let i = 0; i < segCount; i++) {
    const frac = cum / total; // fraction at the START of segment i
    const color = colorFor(congestion[i], routeBase);
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
  // colour up to (f - band), then blend to the new colour by (f + band). Where two
  // changes are closer than a full band, the band is shrunk for that pair (and
  // collapses to a near-hard edge if they nearly coincide) — inputs are kept clamped
  // to [0,1] and strictly ascending, which `interpolate` requires.
  //
  // ⚠ THE BAND IS IN METRES, NOT A PERCENTAGE OF THE ROUTE (fixed 2026-07-29).
  // It used to be ±1.25% of the whole line, which quietly made congestion
  // unreadable in proportion to trip length — the "sometimes the red is pronounced,
  // sometimes it isn't" complaint. On a 5 km route ±1.25% is ±62 m and a 300 m jam
  // paints 58% of itself FULL red. On a 15 km route the band is ±188 m, wider than
  // the jam itself, so the ramp-in meets the ramp-out and the red NEVER reaches
  // saturation — 0% of the jam is full red. On a 400 km Langley→Anglemont run the
  // band is ±5 km. Same data, same code, completely different picture, decided by
  // how far you happen to be driving.
  // In metres the blend is a constant 53% of a 300 m jam at ANY route length, so a
  // jam reads the same whether it is 10 minutes or 4 hours from home. This is the
  // shared builder, so the phone, CarPlay and Android Auto all inherit it at once.
  const BLEND_M = 70;
  const HALF = Math.min(0.05, BLEND_M / total); // metres → fraction, capped for tiny routes
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
      `?annotations=congestion_numeric&overview=full&geometries=geojson&steps=false` +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}`;

    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    const route = json?.routes?.[0];
    const coordinates: [number, number][] = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

    // Congestion lives on the leg annotation; with no waypoints there's one leg.
    const rawCongestion: any[] = route?.legs?.[0]?.annotation?.congestion_numeric || [];
    const segCount = coordinates.length - 1;
    const congestion: CongestionLevel[] = new Array(segCount);
    for (let i = 0; i < segCount; i++) congestion[i] = levelFromNumeric(rawCongestion[i]);
    return { coordinates, congestion };
  } catch {
    return null; // includes AbortError — a stale request was simply cancelled
  }
}

// ===== Full route source (Google Routes API replacement) =====================
// The SECOND query variant of this module (after congestion): the
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
  // Per-SEGMENT traffic-aware seconds — one per (coordinates.length - 1), the same
  // axis `congestion` uses. This is the finest-grained timing Mapbox will give us:
  // a real Langley→Anglemont route has 16 steps but 4337 segments, so an ETA summed
  // from these is effectively exact instead of interpolated. See the ETA block in
  // nav.ts's useTurnByTurn.
  segDurations: number[];
  // Directions Refresh handle. With `enable_refresh=true` the response carries a
  // `uuid`; GET /directions-refresh/v1/mapbox/driving-traffic/{uuid}/{routeIndex}/0
  // returns UPDATED duration + congestion annotations for this exact geometry, which
  // is how the ETA keeps up with traffic and construction mid-drive without ever
  // re-routing the driver. Verified against the live API 2026-07-26.
  refreshUuid?: string;
  /** Via routes only: the ROAD-SNAPPED interior waypoints, in via order, from the
   *  response's `waypoints[]`. null per slot when the API omitted a location. The
   *  visited-stop marking MUST use these, not the raw pins — snapping is unlimited-
   *  radius, so a raw pin can sit 167 m (measured) from anywhere the car drives. */
  viaSnapped?: ({ lat: number; lng: number } | null)[];
  /** Via routes only: metres Mapbox moved each pin to reach a routable road, in via
   *  order. null per slot when the API omitted it. Lets the visited radius scale to
   *  how far off-road the pin actually sits (see the note at the producer). */
  viaSnapDistM?: (number | null)[];
  routeIndex: number;
  // ── WHICH SIDE OF THE ROAD THE DESTINATION LANDS ON (2026-07-31) ───────────
  // Jeff: "the GPS needs to be a little mindful on which side of the road the
  // destination is." Mapbox already tells us — the ARRIVE step carries
  // maneuver.modifier ("left" | "right" | "straight") and the step carries
  // driving_side. modifier opposite to driving_side = the driver has to cross
  // oncoming traffic to reach it. Free: it is in the response we already fetch.
  arriveSide?: "left" | "right" | "straight";
  drivingSide?: "left" | "right";
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

// True when the destination sits across oncoming traffic — the arrive modifier is the
// OPPOSITE side from the region's driving side. "straight" (a dead end, a driveway, the
// end of a cul-de-sac) is never wrong-side. Undefined fields fail closed to false so a
// route from an older cache never triggers a pointless second request.
export function arrivesOnFarSide(r: Pick<MapboxRoute, "arriveSide" | "drivingSide">): boolean {
  if (!r.arriveSide || !r.drivingSide || r.arriveSide === "straight") return false;
  return r.arriveSide !== r.drivingSide;
}

// Fetch up to `alternatives` driving-traffic routes from origin->dest with steps,
// congestion, and a traffic/free-flow duration split. Returns [] on any failure
// (caller decides fallback). One leg (no waypoints) so annotations cover the whole
// geometry.
export async function fetchMapboxRoutes(
  origin: LatLng,
  dest: LatLng,
  avoid?: MapboxAvoid,
  opts?: { signal?: AbortSignal; curbApproach?: boolean; bearing?: number },
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
      `&annotations=congestion_numeric,duration,distance&banner_instructions=false` +
      // enable_refresh gives the response a `uuid`, the handle the Directions Refresh
      // API needs to hand back UPDATED traffic for this exact geometry mid-drive.
      `&enable_refresh=true` +
      // approaches is one entry PER COORDINATE. Origin unrestricted (never make the
      // driver cross the road to LEAVE), destination curb = arrive on the driver's
      // side. Verified against the live API 2026-07-31: it flips the arrive step from
      // "on the left" to "on the right" and is a genuine re-route, not a relabel.
      (opts?.curbApproach ? `&approaches=unrestricted%3Bcurb` : ``) +
      (exclude.length ? `&exclude=${exclude.join(",")}` : ``) +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}` +
      // ORIGIN BEARING (2026-09-03, Olaf: "it really wanted me to turn around" — 8 reroutes
      // in 113 s, each the same route back through a closed street). Without a bearing the
      // API is free to route you back the way you came; with `bearings=hdg,45;` it must
      // continue within 45° of the direction of travel. Empty entry = destination free.
      (typeof opts?.bearing === "number" && Number.isFinite(opts.bearing)
        ? `&bearings=${Math.round(((opts.bearing % 360) + 360) % 360)},45;`
        : "");

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}${qs}`;
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return [];
    const json: any = await res.json();
    const routes: any[] = Array.isArray(json?.routes) ? json.routes : [];
    if (!routes.length) return [];

    return routes.map((route: any, routeIndex: number): MapboxRoute => {
      const polyline: string = typeof route?.geometry === "string" ? route.geometry : "";
      const coordinates = decodePolyline5LngLat(polyline);
      const leg = route?.legs?.[0] || {};
      const ann = leg?.annotation || {};

      const segCount = Math.max(0, coordinates.length - 1);
      const rawC: any[] = Array.isArray(ann.congestion_numeric) ? ann.congestion_numeric : [];
      const congestion: CongestionLevel[] = new Array(segCount);
      for (let i = 0; i < segCount; i++) congestion[i] = levelFromNumeric(rawC[i]);

      // Per-segment traffic-aware seconds, same axis as `congestion`.
      const rawD: any[] = Array.isArray(ann.duration) ? ann.duration : [];
      const segDurations: number[] = new Array(segCount);
      for (let i = 0; i < segCount; i++) {
        const v = Number(rawD[i]);
        segDurations[i] = Number.isFinite(v) && v >= 0 ? v : 0;
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
            maneuver: s?.maneuver ? {
              type: s.maneuver.type,
              modifier: s.maneuver.modifier,
              instruction: cleanManeuverInstruction(s.maneuver.instruction),
              location: Array.isArray(s.maneuver.location) ? s.maneuver.location : undefined,
            } : undefined,
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
        segDurations,
        refreshUuid: typeof json?.uuid === "string" ? json.uuid : undefined,
        routeIndex,
        // Read off the ARRIVE step (always the last one). Raw Mapbox fields, not the
        // cleaned instruction string, so this never depends on parsing English.
        arriveSide: (() => {
          const m = (route?.legs?.[0]?.steps || []).slice(-1)[0]?.maneuver?.modifier;
          return m === "left" || m === "right" || m === "straight" ? m : undefined;
        })(),
        drivingSide: (() => {
          const ds = (route?.legs?.[0]?.steps || []).slice(-1)[0]?.driving_side;
          return ds === "left" || ds === "right" ? ds : undefined;
        })(),
      };
    }).filter((r) => r.polyline);
  } catch {
    return []; // includes AbortError
  }
}

// Replay a HABITUAL path through driving-traffic by pinning the route to a chain of
// via-waypoints (origin -> via... -> dest). Forces the route along the learned geometry
// while still returning a live traffic-aware ETA + congestion. Single result, multi-leg:
// route.duration/distance are already totals; we concat each leg's steps + congestion.
// Used by the AI route (aiRoutes.ts). Returns null on any failure (caller falls back).
export async function fetchMapboxRouteVia(
  origin: LatLng,
  via: [number, number][],     // interior [lng,lat] waypoints
  dest: LatLng,
  avoid?: MapboxAvoid,
  opts?: { signal?: AbortSignal; bearing?: number },
): Promise<MapboxRoute | null> {
  try {
    if (
      typeof origin?.lat !== "number" || typeof origin?.lng !== "number" ||
      typeof dest?.lat !== "number" || typeof dest?.lng !== "number"
    ) return null;

    // origin;via1;...;viaN;dest — Mapbox allows up to 25 coordinates; caller caps `via`.
    const pts: string[] = [`${origin.lng},${origin.lat}`];
    for (const v of via) {
      if (Array.isArray(v) && v.length >= 2) pts.push(`${v[0]},${v[1]}`);
    }
    pts.push(`${dest.lng},${dest.lat}`);
    if (pts.length < 2) return null;

    const exclude: string[] = [];
    if (avoid?.tolls) exclude.push("toll");
    if (avoid?.highways) exclude.push("motorway");
    if (avoid?.ferries) exclude.push("ferry");

    // `enable_refresh=true` makes the refresh handle EXPLICIT rather than incidental.
    // ⚠ Correction (2026-07-29): this was first added on the theory that its absence
    // was why a via-route's congestion froze — that Mapbox withholds the `uuid`
    // unless asked. TESTED AGAINST THE LIVE API AND THAT IS FALSE: the identical
    // request returns a uuid with or without this parameter, so `refreshUuid` was
    // never undefined and this fixed nothing. It stays because relying on an
    // undocumented default for something load-bearing is a bad trade, and because
    // the docs specify this parameter as the way to obtain a refresh handle.
    // The real cause of a green line in traffic is NOT here — see the congestion
    // probe in map.tsx.
    const qs =
      `?alternatives=false&steps=true&overview=full&geometries=polyline` +
      `&annotations=congestion_numeric,duration,distance&banner_instructions=false` +
      `&enable_refresh=true` +
      (exclude.length ? `&exclude=${exclude.join(",")}` : ``) +
      `&access_token=${MAPBOX_PUBLIC_TOKEN}` +
      // ORIGIN BEARING — same constraint as fetchMapboxRoutes. `bearings` needs one entry per
      // coordinate: origin `hdg,45`, then an EMPTY entry for every via and for the destination.
      (typeof opts?.bearing === "number" && Number.isFinite(opts.bearing)
        ? `&bearings=${Math.round(((opts.bearing % 360) + 360) % 360)},45${";".repeat(via.length + 1)}`
        : "");

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${pts.join(";")}${qs}`;
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    const route: any = Array.isArray(json?.routes) ? json.routes[0] : null;
    if (!route) return null;

    const polyline: string = typeof route?.geometry === "string" ? route.geometry : "";
    if (!polyline) return null;
    const coordinates = decodePolyline5LngLat(polyline);
    const legs: any[] = Array.isArray(route?.legs) ? route.legs : [];

    // Concat per-leg congestion AND per-segment durations across all legs (each leg
    // annotates its own segments). Both arrays stay on the same axis as `coordinates`,
    // so the segment-based ETA works on an AI/via route exactly as on a plain one.
    const congestion: CongestionLevel[] = [];
    const segDurations: number[] = [];
    for (const leg of legs) {
      const rawC: any[] = Array.isArray(leg?.annotation?.congestion_numeric) ? leg.annotation.congestion_numeric : [];
      for (const v of rawC) congestion.push(levelFromNumeric(v));
      const rawD: any[] = Array.isArray(leg?.annotation?.duration) ? leg.annotation.duration : [];
      for (const v of rawD) {
        const n = Number(v);
        segDurations.push(Number.isFinite(n) && n >= 0 ? n : 0);
      }
    }

    // Concat per-leg steps for turn-by-turn guidance along the whole habitual path.
    // Mapbox emits an `arrive` + `depart` step at EVERY via-waypoint; keep only the very
    // first `depart` and the very last `arrive` so driving the AI route doesn't trigger
    // a spurious "you have arrived" at each interior waypoint.
    const steps: MapboxRouteStep[] = [];
    const lastLeg = legs.length - 1;
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      if (!Array.isArray(leg?.steps)) continue;
      for (const s of leg.steps) {
        const t = s?.maneuver?.type;
        if (t === "depart" && li > 0) continue;        // interior waypoint re-departure
        if (t === "arrive" && li < lastLeg) continue;  // interior waypoint arrival
        steps.push({
          distance: typeof s?.distance === "number" ? s.distance : 0,
          duration: typeof s?.duration === "number" ? s.duration : 0,
          name: typeof s?.name === "string" ? s.name : undefined,
          geometry: typeof s?.geometry === "string" ? s.geometry : undefined,
          maneuver: s?.maneuver ? {
            type: s.maneuver.type,
            modifier: s.maneuver.modifier,
            instruction: cleanManeuverInstruction(s.maneuver.instruction),
            location: Array.isArray(s.maneuver.location) ? s.maneuver.location : undefined,
          } : undefined,
        });
      }
    }

    const durationS = typeof route?.duration === "number" ? route.duration : 0;
    const freeflowS = typeof route?.duration_typical === "number" ? route.duration_typical : durationS;
    // SNAPPED VIA COORDINATES (2026-08-27, the visited-stops blocker). The request
    // carries no `radiuses`, so Mapbox snaps every via to the nearest routable road at
    // UNLIMITED distance — live-probed with this exact request shape: a pin 167 m
    // off-road returns Ok with waypoints[i].distance = 167.37 and a route that never
    // comes closer than that to the raw pin. The car drives through the SNAPPED
    // point, so any passed-the-stop test against the RAW pin can simply never fire.
    // json.waypoints = [origin, ...vias, destination]; keep the interior ones, in
    // via order, as {lat,lng} for the caller's visited-marking.
    const wp: any[] = Array.isArray(json?.waypoints) ? json.waypoints : [];
    const wpVia = wp.slice(1, Math.max(1, wp.length - 1));
    const viaSnapped = wpVia
      .map((w: any) => (Array.isArray(w?.location) && w.location.length >= 2
        ? { lat: Number(w.location[1]), lng: Number(w.location[0]) }
        : null));
    // HOW FAR OFF-ROAD EACH PIN SAT (2026-08-28, Olaf's Brentwood loop). The very
    // same waypoint carries `distance` — the metres Mapbox moved the pin to reach a
    // routable road — and we were throwing it away. We paid for that: the visited
    // test ran a flat 60 m around a mall centroid no car can legally reach, so the
    // stop never marked, and all 19 reroutes that drive re-fed it (stops=1/1 every
    // time). Keeping the number lets the radius self-calibrate per stop instead of
    // guessing one constant that has to serve both a gas pump and a shopping mall.
    const viaSnapDistM = wpVia
      .map((w: any) => (typeof w?.distance === "number" && Number.isFinite(w.distance)
        ? w.distance
        : null));
    return {
      polyline,
      coordinates,
      congestion,
      distance_m: typeof route?.distance === "number" ? route.distance : 0,
      duration_s: durationS,
      freeflow_s: freeflowS,
      summary: legs[0]?.summary && typeof legs[0].summary === "string" ? legs[0].summary : "Your usual way",
      steps,
          segDurations,
      refreshUuid: typeof json?.uuid === "string" ? json.uuid : undefined,
      routeIndex: 0,
      viaSnapped,
      viaSnapDistM,
};
  } catch {
    return null; // includes AbortError
  }
}

// ── Live traffic refresh ─────────────────────────────────────────────────────
//
// Re-fetch ONLY the annotations (per-segment duration + congestion) for a route we
// already hold, using the `uuid` the original `enable_refresh=true` request returned.
// The geometry is unchanged, so this can run mid-drive without ever moving the driver
// onto a different road — it just makes the ETA and the congestion colours reflect
// traffic and construction as they are RIGHT NOW.
//
// Why this and not "re-fetch the route": a full re-fetch returns whatever Mapbox
// currently considers best, which can silently swap the driver onto another highway
// halfway through a trip. Refresh cannot do that by construction.
//
// Verified against the live API (2026-07-26) on a real Langley→Anglemont route:
// HTTP 200, `code: "Ok"`, 4337 duration + 4337 congestion_numeric values back — the
// same segment count as the original. Note the refresh payload carries NO steps, only
// annotations, which is exactly why the ETA is computed off segments.
//
// Routes expire server-side. On any non-OK response (typically 404 once the uuid has
// aged out) this returns null and the caller simply keeps the numbers it already has.
export type MapboxRefresh = {
  segDurations: number[];
  congestion: CongestionLevel[];
};

// TRANSIENT vs PERMANENT (2026-07-29). This used to return plain `null` for every
// kind of failure, so the caller could not tell "this uuid is dead" from "we drove
// through a dead zone". Its give-up counter therefore treated three patchy-signal
// ticks as route expiry and switched live traffic off for the REST OF THE DRIVE —
// on a road trip, which is exactly where the signal drops and where a stale ETA
// hurts most. "expired" is the only failure worth giving up on.
export type MapboxRefreshResult = MapboxRefresh | "expired" | null;

export async function refreshMapboxRoute(
  uuid: string,
  routeIndex: number,
  opts?: { signal?: AbortSignal },
): Promise<MapboxRefreshResult> {
  try {
    if (!uuid) return "expired";
    const idx = Number.isFinite(routeIndex) && routeIndex >= 0 ? Math.floor(routeIndex) : 0;
    const url =
      `https://api.mapbox.com/directions-refresh/v1/mapbox/driving-traffic/` +
      `${encodeURIComponent(uuid)}/${idx}/0?access_token=${MAPBOX_PUBLIC_TOKEN}`;
    const res = await fetch(url, { signal: opts?.signal });
    // 404/410/422 = the server has forgotten this route: permanent. 5xx / 429 are the
    // server having a moment, and a thrown fetch is the network — both retryable.
    if (!res.ok) return (res.status === 404 || res.status === 410 || res.status === 422) ? "expired" : null;
    const json: any = await res.json();
    if (json?.code && json.code !== "Ok") return "expired";

    // Multi-leg (AI/via) routes annotate per leg — concat in order so the arrays stay
    // on the same axis as the route's `coordinates`, same as the original parse.
    const legs: any[] = Array.isArray(json?.route?.legs) ? json.route.legs : [];
    if (!legs.length) return "expired";

    const segDurations: number[] = [];
    const congestion: CongestionLevel[] = [];
    for (const leg of legs) {
      const rawD: any[] = Array.isArray(leg?.annotation?.duration) ? leg.annotation.duration : [];
      for (const v of rawD) {
        const n = Number(v);
        segDurations.push(Number.isFinite(n) && n >= 0 ? n : 0);
      }
      const rawC: any[] = Array.isArray(leg?.annotation?.congestion_numeric) ? leg.annotation.congestion_numeric : [];
      for (const v of rawC) congestion.push(levelFromNumeric(v));
    }
    if (!segDurations.length) return "expired";
    return { segDurations, congestion };
  } catch {
    return null; // includes AbortError
  }
}
