// hazardAhead.ts — the PURE half of Scout's "hazard ahead" call for crew-reported hazards (police / crash / road
// hazard / traffic): how far ahead we call it, whether the pin is actually AHEAD, and what Scout says. No imports,
// so tools/sim-qc/hazard_ahead_test.mts loads it under plain Node.
//
// Jeff, 2026-09-25: "MAKE SURE THAT THERE IS A SCOUT NOTIFICATION THAT A SPECIFIC HAZARD IS AHEAD AND MAKE IT A GOOD
// DISTANCE AWAY." Before this the map effect fired at a FIXED 500 m with no heading test — 18 s of warning at
// 100 km/h, and a pin 500 m BEHIND the car (or on the road you just left) fired too. Now:
//   - the lead scales with speed: HAZARD_AHEAD_LEAD_S seconds of travel, floored at HAZARD_AHEAD_MIN_M and capped
//     at HAZARD_AHEAD_MAX_M (50 km/h → 1 km, 100 km/h → 1.25 km, 130 km/h → 1.6 km);
//   - the pin must sit inside a forward cone of the fix's course (± HAZARD_AHEAD_CONE_DEG); no course = no cone,
//     which is the old behaviour, so a parked or GPS-less phone loses nothing;
//   - the line names the KIND and the DISTANCE ("Heads up, police reported about 1 kilometer ahead.");
//   - one line per hazard, re-armed only once the car is HAZARD_AHEAD_REARM_EXTRA_M past the lead again.
// The reroute-worthy "hazard ahead on the route" prompt (map.tsx nearestHazardAhead, 🔒) is a different thing and is
// untouched. The user-facing consumer is the effect in app/(app)/map.tsx ("Hazard / police proximity voice alert").

/** Seconds of travel the call leads the pin by. */
export const HAZARD_AHEAD_LEAD_S = 45;
/** Never call it closer than this, even crawling. */
export const HAZARD_AHEAD_MIN_M = 1000;
/** Never call it further than this, even flying. */
export const HAZARD_AHEAD_MAX_M = 2000;
/** Re-arm a hazard only once the car is this far beyond the lead again. */
export const HAZARD_AHEAD_REARM_EXTRA_M = 500;
/** Half-angle of the forward cone the pin must sit in. */
export const HAZARD_AHEAD_CONE_DEG = 50;
/** Below this the car is not "driving toward" anything. */
export const HAZARD_AHEAD_MIN_KMH = 20;

export type HazardAheadUnit = 'km' | 'mi';

/** How far ahead (m) to call a hazard at this speed (m/s). */
export function hazardAheadLeadM(speedMps: number): number {
  const v = Number.isFinite(speedMps) && speedMps > 0 ? speedMps : 0;
  return Math.min(HAZARD_AHEAD_MAX_M, Math.max(HAZARD_AHEAD_MIN_M, v * HAZARD_AHEAD_LEAD_S));
}

/** Initial bearing from (lat1,lng1) to (lat2,lng2), degrees clockwise from north in [0, 360). */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const φ1 = lat1 * r, φ2 = lat2 * r, Δλ = (lng2 - lng1) * r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** Is a pin at `bearingToDeg` inside the forward cone of `headingDeg`? No heading → yes (no cone). */
export function isAheadOf(headingDeg: number | null | undefined, bearingToDeg: number, coneDeg: number = HAZARD_AHEAD_CONE_DEG): boolean {
  if (headingDeg == null || !Number.isFinite(headingDeg)) return true;
  let d = Math.abs(((bearingToDeg - headingDeg) % 360 + 540) % 360 - 180);
  if (!Number.isFinite(d)) d = 0;
  return d <= coneDeg;
}

/** The kind, the way Scout says it. */
export function hazardAheadKindWord(kind: string): string {
  switch (kind) {
    case 'police': return 'police';
    case 'accident': return 'a crash';
    case 'traffic': return 'traffic';
    case 'road': return 'a road hazard';
    default: return 'a hazard';
  }
}

/** "about 1 kilometer" / "about 1.5 kilometers" / "about 800 meters" — or miles. Rounded the way a person would say it. */
export function hazardAheadDistance(distM: number, unit: HazardAheadUnit): string {
  const m = Math.max(0, distM);
  if (unit === 'mi') {
    const mi = m / 1609.344;
    if (mi < 0.4) return 'about a quarter mile';
    if (mi < 0.9) return 'about half a mile';
    const half = Math.round(mi * 2) / 2;
    if (half === 1) return 'about a mile';
    if (half === 1.5) return 'about a mile and a half';
    return `about ${half} miles`;
  }
  if (m < 950) return `about ${Math.max(100, Math.round(m / 100) * 100)} meters`;
  const half = Math.round((m / 1000) * 2) / 2;
  return half === 1 ? 'about 1 kilometer' : `about ${half} kilometers`;
}

/** Openers, keyed by kind; the distance and "ahead" are appended so every line carries them. */
export const HAZARD_AHEAD_OPENERS: Record<string, string[]> = {
  police: ['Heads up, police reported', 'Police spotted', 'Cops reported', 'Heads up — police on the road'],
  accident: ['Crash reported', 'Heads up, accident reported', 'There\'s a crash', 'Collision reported'],
  traffic: ['Traffic reported', 'Heads up, slow traffic', 'Congestion reported', 'Traffic building'],
  road: ['Road hazard reported', 'Heads up, something on the road', 'Hazard on the road', 'Road hazard'],
};
const HAZARD_AHEAD_OPENER_FALLBACK = ['Hazard reported', 'Heads up, hazard reported'];

/** The spoken line: "<opener> <distance> ahead." e.g. "Heads up, police reported about 1 kilometer ahead." */
export function hazardAheadLine(kind: string, distM: number, unit: HazardAheadUnit, rnd: () => number = Math.random): string {
  const pool = HAZARD_AHEAD_OPENERS[kind] ?? HAZARD_AHEAD_OPENER_FALLBACK;
  const opener = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(rnd() * pool.length)))];
  return `${opener} ${hazardAheadDistance(distM, unit)} ahead.`;
}
