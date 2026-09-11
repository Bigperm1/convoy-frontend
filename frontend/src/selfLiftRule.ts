// selfLiftRule — WHEN the self car is drawn lifted off the ground, and by how much. PURE (no React,
// no RN, no imports) so tools/sim-qc/self_lift_rule_test.mts drives this exact code under Node.
// src/selfLift.ts owns the live state and the receipts; SelfCarModel (ConvoyMapbox.tsx) feeds it.
//
// ── WHY (Jeff, 2026-09-10 evening) ────────────────────────────────────────────────────────
// The 3D car has been drawn 10 m in the air since 2026-06-29 (16 m for the arrow) so the Standard
// style's 3D buildings — which share Mapbox's depth buffer with our model — could not swallow it.
// On a pitched camera a lifted point projects FORWARD up the road, and the cost doubles per zoom
// level: 3 pt on the highway frame, 56 pt on his exit ramp that night (`ribbon-trim lift=56`).
// The geometry says the lift is only needed OFF the road: in the chase view the camera sits behind
// the car along the road, so the sight line to the car runs over asphalt — a building can hide the
// car only when it stands between camera and car (right after a turn at a dense corner, which Jeff
// accepted as "briefly"), or when the car is IN a lot / driveway / footprint where buildings stand
// behind and around it. His rule, verbatim: "make sure the road rule is pronounced for the car at a
// light and slow speeds — that way it should never get lifted. parking lots / driveways / parkades
// should be lifted." The arrow is a 3D model too and takes the same rule.
//
// Signals, strongest first. ANY one of the first three grounds the car at once:
//   1. speed ≥ LIFT_ONROAD_SPEED_MS — a car doing 18 km/h is on a road, whatever the map says;
//   2. guidance active and the projection onto the route within LIFT_NAV_ONROAD_M;
//   3. the map itself: our own invisible mapbox-streets-v8 source (the road-snap's `convoy-roads`,
//      queried with querySourceFeatures on both surfaces — Standard hides its layers from queries) —
//      a drivable road's centreline within LIFT_ROAD_NEAR_M. A `service` road typed driveway /
//      parking_aisle / drive-through / parking is NOT a road here; when one of those is under the
//      car (within LIFT_PROPERTY_NEAR_M and closer than any road) the car is ON the property.
// Off-road evidence (the query ran and found no road, or the car is inside a building footprint)
// must hold for LIFT_OFFROAD_CONFIRM_MS before the lift starts; a road sighting drops it at once.
// No evidence at all (no query yet, the map not rendering, an error) never STARTS a lift, and a
// lift already up comes down after LIFT_UNKNOWN_HOLD_MS without evidence. Inside a footprint the
// lift is that building's height plus a margin, so a parkade's roof is cleared exactly.

export const LIFT_ONROAD_SPEED_MS = 5;      // ≥ 18 km/h → on a road, period
export const LIFT_NAV_ONROAD_M = 25;        // projection onto the active route within this → on the road
export const LIFT_ROAD_NEAR_M = 30;         // a drivable road's centreline within this → on the road. A lane is 3–10 m off it, a
                                            // fix at a light can sit 15–20 m off (the 20:22 sim run: 11–15 m on Marshall Rd), and the
                                            // road-snap itself locks at 22 m / releases at 34. Lots and driveways still lift through
                                            // the property rule below, which is positive evidence, not the absence of a road.
export const LIFT_PROPERTY_NEAR_M = 8;      // a driveway / parking aisle THIS close, and closer than any road, = you are on it…
export const LIFT_LANE_M = 9;               // …unless a road's centreline is within a lane's reach: a driveway MOUTH meets the
                                            // centreline, so a car in the lane over it is still on the road (Codex pass 2)
export const LIFT_COVERAGE_M = 300;         // road data counts as loaded HERE only if some road is within this of the car
export const LIFT_OFFROAD_CONFIRM_MS = 2500;   // POSITIVE off-road evidence (a driveway / aisle under the car, a footprint) must hold this long
export const LIFT_ABSENCE_CONFIRM_MS = 8000;   // "no drivable road within reach" alone is weaker (a tile still loading, a wide lot) and must hold this long
export const LIFT_UNKNOWN_HOLD_MS = 6000;
export const LIFT_EVIDENCE_FRESH_MS = 3500; // a surface's evidence older than this no longer counts
export const LIFT_BUILDING_MARGIN_M = 2;
export const LIFT_MAX_M = 40;
export const LIFT_TAU_S = 0.4;              // the drawn lift eases toward the target over ~1 s
export const LIFT_QUERY_MS = 1000;          // the map is asked at most once a second, and only when slow

/** Mapbox Streets v8 `road` classes that mean "a road you drive on". Paths, rail, ferries, golf,
 *  construction and aerialways are not; `service` is, unless its `type` says otherwise (below). */
export const ROAD_CLASSES: ReadonlySet<string> = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "street", "street_limited",
  "service", "track", "living_street",
]);
/** Streets v8 `type` values on class `service` that are a property, not a road. The tileset spells
 *  them `service:parking_aisle`, `service:driveway`, `service:drive_through`, `service:parking`,
 *  `service:emergency_access` (Codex, 2026-09-10: the bare OSM spelling matched nothing); the bare
 *  form is accepted too so a schema change cannot silently turn every lot into a road. */
export const OFFROAD_SERVICE_TYPES: ReadonlySet<string> = new Set([
  "driveway", "parking_aisle", "drive_through", "drive-through", "parking", "emergency_access",
]);

export type RoadEvidence = {
  /** true = a drivable road within reach; false = roads are loaded here and none is (or a property is under the car); null = no road data */
  roadHit: boolean | null;
  /** the tallest building footprint under the car (m), null when not inside one */
  buildingH: number | null;
  /** the car sits on a driveway / parking aisle (receipt only) */
  lot: boolean;
};

const propStr = (p: any, k: string): string | null => {
  const v = p?.[k];
  return typeof v === "string" ? v : (typeof v === "number" ? String(v) : null);
};
const propNum = (p: any, k: string): number | null => {
  const v = p?.[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  return null;
};

/** Is this road feature a road you drive on (see ROAD_CLASSES / OFFROAD_SERVICE_TYPES)? */
export function isDrivableRoad(props: any): boolean {
  const cls = propStr(props, "class");
  if (!cls || !ROAD_CLASSES.has(cls)) return false;
  if (cls === "service") {
    const t = propStr(props, "type");
    if (t && OFFROAD_SERVICE_TYPES.has(t.replace(/^service:/, ""))) return false;
  }
  return true;
}
/** A driveway / parking aisle / drive-through / parking access road: the property itself. */
export function isPropertyRoad(props: any): boolean {
  if (propStr(props, "class") !== "service") return false;
  const t = propStr(props, "type");
  return !!t && OFFROAD_SERVICE_TYPES.has(t.replace(/^service:/, ""));
}
/** Is this a building footprint (Streets v8 `building` layer, above ground)? Its roof height in m. */
export function buildingHeightOf(props: any): number | null {
  if (!props) return null;
  // Streets v8: a building with `building:part`s ships the whole-footprint outline with extrude=false
  // (and possibly a height) beside the extruded parts — only the extruded geometry is a roof.
  if (propStr(props, "extrude") !== "true") return null;
  if (propStr(props, "underground") === "true") return null;
  const h = propNum(props, "height");
  return h != null ? Math.max(0, h) : 4;   // an un-heighted footprint is a one-storey roof
}

/** Even-odd point-in-polygon over every ring of a Polygon / MultiPolygon feature ([lng, lat] rings);
 *  counting crossings across all rings handles holes for free. */
export function pointInPolygonFeature(lat: number, lng: number, feature: any): boolean {
  const g = feature?.geometry;
  if (!g) return false;
  const polys: number[][][][] = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : [];
  for (const rings of polys) {
    let inside = false;
    for (const ring of rings) {
      if (!Array.isArray(ring)) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i]?.[0], yi = ring[i]?.[1], xj = ring[j]?.[0], yj = ring[j]?.[1];
        if (typeof xi !== "number" || typeof yi !== "number" || typeof xj !== "number" || typeof yj !== "number") continue;
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
/** The tallest building footprint (tile-clipped polygons from the `building` source-layer) under the point. */
export function buildingUnder(lat: number, lng: number, features: any[] | null | undefined): number | null {
  if (!Array.isArray(features)) return null;
  let best: number | null = null;
  for (const f of features) {
    const h = buildingHeightOf(f?.properties);
    if (h == null) continue;
    if (!pointInPolygonFeature(lat, lng, f)) continue;
    if (best == null || h > best) best = h;
  }
  return best;
}

/**
 * The road verdict from our own road source: `roadsLoaded` = the source answered with road features
 * at all (else the verdict is UNKNOWN — a blank tile or a map still loading can never lift the car);
 * `drivableM` = distance to the nearest drivable road's centreline (null = none within reach);
 * `propertyM` = distance to the nearest driveway / parking aisle (null = none). The property wins
 * only when it is under the car and closer than any road, so a driveway beside the street reads as
 * off the road while a car in the lane beside that same driveway does not.
 */
export function roadEvidence(roadsLoaded: boolean, drivableM: number | null, propertyM: number | null, buildingH: number | null): RoadEvidence {
  if (!roadsLoaded) return { roadHit: null, buildingH, lot: false };
  // The property wins only when the car is OUT of every lane: a driveway's line meets the street's
  // centreline, so a car in the lane over its mouth is 0 m from the driveway and 4 m from the road.
  const onProperty = typeof propertyM === "number" && propertyM <= LIFT_PROPERTY_NEAR_M
    && (drivableM == null || (propertyM < drivableM && drivableM > LIFT_LANE_M));
  if (onProperty) return { roadHit: false, buildingH, lot: true };
  const road = typeof drivableM === "number" && drivableM <= LIFT_ROAD_NEAR_M;
  return { roadHit: road, buildingH, lot: false };
}

export type LiftEvidence = {
  speedMs: number | null;
  navDistM: number | null;
  roadHit: boolean | null;
  buildingH: number | null;
  /** POSITIVE off-road evidence: a driveway / parking aisle under the car (roadEvidence's `lot`). */
  lot?: boolean;
  /** The reporting map was IDLE (Mapbox: every tile loaded and rendered, no camera transition) when it answered —
   *  the only proof that "no road within reach" is not a tile still loading. An absence without it is unknown. */
  complete?: boolean;
};
export type LiftState = {
  targetM: number;
  why: string;
  /** since when ANY counted off-road evidence has been continuous (absence needs LIFT_ABSENCE_CONFIRM_MS of it) */
  offRoadSince: number | null;
  /** since when POSITIVE evidence (something under the car) has been continuous (LIFT_OFFROAD_CONFIRM_MS) */
  positiveSince: number | null;
  unknownSince: number | null;
};
export const LIFT_STATE0: LiftState = { targetM: 0, why: "init", offRoadSince: null, positiveSince: null, unknownSince: null };

/** One decision. `offRoadLiftM` is the marker's own off-road lift (car 10, arrow 16). */
export function liftDecide(st: LiftState, ev: LiftEvidence, now: number, offRoadLiftM: number): LiftState {
  const fastEnough = typeof ev.speedMs === "number" && Number.isFinite(ev.speedMs) && ev.speedMs >= LIFT_ONROAD_SPEED_MS;
  const onRoute = typeof ev.navDistM === "number" && Number.isFinite(ev.navDistM) && ev.navDistM <= LIFT_NAV_ONROAD_M;
  if (fastEnough || onRoute || ev.roadHit === true) {
    return { targetM: 0, why: fastEnough ? "speed" : onRoute ? "nav" : "road", offRoadSince: null, positiveSince: null, unknownSince: null };
  }
  // Something UNDER the car (a driveway, an aisle, a roof) is positive evidence. "No road within reach" is only an
  // absence: it counts solely when the map was idle (every tile loaded) — a tile still loading looks the same
  // (Codex passes 3–4) — and it must hold longer. The two tiers keep their own clocks: a first positive sample after
  // seconds of absence does not inherit the absence clock.
  const positive = !!ev.lot || (typeof ev.buildingH === "number" && ev.buildingH >= 0);
  const absence = ev.roadHit === false && ev.complete === true;
  if (positive || absence) {
    const since = st.offRoadSince ?? now;
    const pSince = positive ? (st.positiveSince ?? now) : null;
    const ready = (pSince != null && now - pSince >= LIFT_OFFROAD_CONFIRM_MS) || (now - since >= LIFT_ABSENCE_CONFIRM_MS);
    if (ready) {
      const bld = typeof ev.buildingH === "number" ? ev.buildingH + LIFT_BUILDING_MARGIN_M : 0;
      const target = Math.min(LIFT_MAX_M, Math.max(offRoadLiftM, bld));
      return { targetM: target, why: bld > 0 ? `bld:${Math.round(ev.buildingH as number)}` : "offroad", offRoadSince: since, positiveSince: pSince, unknownSince: null };
    }
    return { ...st, why: st.targetM > 0 ? st.why : "offroad-wait", offRoadSince: since, positiveSince: pSince, unknownSince: null };
  }
  // No counted evidence either way (nothing, or an absence the map could not vouch for).
  const uSince = st.unknownSince ?? now;
  if (st.targetM > 0 && now - uSince >= LIFT_UNKNOWN_HOLD_MS) {
    return { targetM: 0, why: "unknown", offRoadSince: null, positiveSince: null, unknownSince: uSince };
  }
  return { ...st, offRoadSince: null, positiveSince: null, unknownSince: uSince };
}

/** The drawn lift slides toward the target: a slide, never a pop. */
export function easeLift(current: number, targetM: number, dtS: number): number {
  if (!(dtS > 0)) return current;
  const next = current + (targetM - current) * (1 - Math.exp(-dtS / LIFT_TAU_S));
  return Math.abs(next - targetM) < 0.02 ? targetM : next;
}
