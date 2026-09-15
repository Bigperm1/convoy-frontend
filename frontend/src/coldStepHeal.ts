// coldStepHeal — lets the COLD car-strip engine (src/navNotification.ts updateNavBanner) step past a
// maneuver it never got within 25 m of. PURE: no React, no RN, so tools/sim-qc can run it.
//
// THE DEFECT (Jeff's 2026-09-15 drive, instance 1mdvgz-926948). After the 09:23:39 PDT reroute the cold
// engine correctly restarted the new route at step 0 (route-swap steps=4 anchored=0), but its only way
// forward is "the car came within 25 m of the CURRENT step's end". It never did, so it sat on step 0 for
// the rest of the drive: `car-strip cold step=0/3` with rem 1671 → 2854 m and turn 61 → 1244 m, while the
// phone engine (which has step-heal, nav.ts) reached step=2/3 rem=121m. rem − turn stayed 1610 on every row,
// which pins the index at 0. accepted=0 hid it that morning; it is the strip CarPlay/Android Auto fall back
// to whenever the phone JS is not driving it (locked phone, standalone car sessions in build 79), and cold
// arrival keys off the same rem, so it could never have fired either.
//
// THE RULE (designed + modelled by the route agent 2026-09-15; gated by tools/sim-qc/cold_step_heal_test.mts).
// A fix COUNTS toward a heal only when ALL hold:
//   - it moved >= COLD_HEAL_MOVE_M from the last counted fix (two feeds delivering one fix count once);
//   - the car is RECEDING from the current step's end (straight-line distance grew since the last count);
//   - its nearest polyline segment, searched only from the current step's START up to
//     COLD_HEAL_WINDOW_SEGS ahead (never a whole-route scan), is > COLD_HEAL_SEG_MARGIN past the step's end
//     segment and within COLD_HEAL_MAX_OFF_M of the line;
//   - speed > COLD_HEAL_MIN_SPEED_MS;
//   - the odometer since this route geometry began + COLD_HEAL_ODO_SLACK_M reaches at least the along-route
//     distance to that step's end (the loop-route defence: a car creeping at the origin of a route that ends
//     where it starts cannot have driven the whole loop). No odometer base → no heal.
// COLD_HEAL_TICKS consecutive counted fixes advance ONE step. Never onto the final (arrive) step; forward only.
// ⚠ COLD_HEAL_ODO_SLACK_M = 50 is not measured. ⚠ NOT FIELD-VERIFIED — look for `cold-step-heal` rows.
import { nearestSegment, type LngLat, type LL } from "./navAnchor.ts";

export const COLD_HEAL_TICKS = 3;
export const COLD_HEAL_SEG_MARGIN = 2;
export const COLD_HEAL_MAX_OFF_M = 100;
export const COLD_HEAL_MIN_SPEED_MS = 2;
export const COLD_HEAL_WINDOW_SEGS = 400;
export const COLD_HEAL_MOVE_M = 2;
export const COLD_HEAL_ODO_SLACK_M = 50;

export type ColdHealGeom = {
  coords: LngLat[];
  /** Segment index nearest each step's END point (−1 when unknown). Monotonic along the route. */
  stepEndSeg: number[];
  /** cumAlong[i] = metres from the route start to vertex i. */
  cumAlong: number[];
};

export type ColdHealState = { streak: number; lastIdx: number; lastD: number; lastLat: number; lastLng: number };

export function newColdHealState(): ColdHealState {
  return { streak: 0, lastIdx: -1, lastD: NaN, lastLat: NaN, lastLng: NaN };
}

function havM(a: LL, b: LL): number {
  const R = 6371000, k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k, dLng = (b.lng - a.lng) * k;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function nearestIn(coords: LngLat[], p: LL, lo: number, hi: number) {
  const a = Math.max(0, lo), b = Math.min(coords.length, hi + 2);
  if (b - a < 2) return null;
  const h = nearestSegment(coords.slice(a, b), p);
  return h ? { ...h, seg: h.seg + a } : null;
}

/** Built once per route geometry. Step ends are matched FORWARD from the previous step's end, so a loop
 *  route's final step end (at the origin) can never claim segment 0. */
export function buildColdHealGeom(coords: LngLat[], stepEnds: LL[]): ColdHealGeom {
  const cumAlong = [0];
  for (let i = 1; i < coords.length; i++) {
    cumAlong.push(cumAlong[i - 1] + havM({ lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] }));
  }
  const stepEndSeg: number[] = [];
  let from = 0;
  for (const e of stepEnds) {
    const h = coords.length >= 2 && Number.isFinite(e.lat) && Number.isFinite(e.lng)
      ? nearestIn(coords, e, from, coords.length) : null;
    const seg = h ? h.seg : -1;
    stepEndSeg.push(seg);
    if (seg >= 0) from = seg;
  }
  return { coords, stepEndSeg, cumAlong };
}

/** Cache key for a heal geometry: the polyline AND every step end (Codex review 2026-09-15 — a same-polyline swap can
 *  still move step boundaries, and a geometry keyed on the polyline alone would compare new steps to old ends). */
export function coldHealStepsKey(polyline: string, stepEnds: LL[]): string {
  return `${polyline.length}:${polyline.slice(0, 32)}:${polyline.slice(-32)}|${stepEnds.length}|${stepEnds.map((e) => `${e.lat.toFixed(6)},${e.lng.toFixed(6)}`).join(";")}`;
}

export type ColdHealResult = { idx: number; healed: boolean; carSeg?: number; endSeg?: number; alongM?: number };

/**
 * One fix. `idx` is the index AFTER the cold engine's own 25 m walk; `dToStepEnd` is that walk's distance
 * to steps[idx].end; `travelledM` is the odometer distance since this geometry began (null = unknown).
 * Mutates `st`. Returns the (possibly advanced by one) index.
 */
export function coldHealStep(
  geom: ColdHealGeom, st: ColdHealState, idx: number, stepCount: number,
  car: LL, dToStepEnd: number, speedMs: number | null | undefined, travelledM: number | null | undefined,
): ColdHealResult {
  if (idx !== st.lastIdx) {
    st.streak = 0; st.lastIdx = idx; st.lastD = dToStepEnd; st.lastLat = car.lat; st.lastLng = car.lng;
    return { idx, healed: false };
  }
  if (Number.isFinite(st.lastLat) && havM({ lat: st.lastLat, lng: st.lastLng }, car) < COLD_HEAL_MOVE_M) return { idx, healed: false };
  const receding = dToStepEnd > st.lastD;
  st.lastD = dToStepEnd; st.lastLat = car.lat; st.lastLng = car.lng;
  // Never heal onto the final (arrive) step.
  if (idx + 1 > stepCount - 2) { st.streak = 0; return { idx, healed: false }; }
  const endSeg = geom.stepEndSeg[idx] ?? -1;
  const lo = idx > 0 ? Math.max(0, geom.stepEndSeg[idx - 1] ?? 0) : 0;
  const hit = endSeg >= 0 ? nearestIn(geom.coords, car, lo, lo + COLD_HEAL_WINDOW_SEGS) : null;
  const past = !!hit && hit.seg > endSeg + COLD_HEAL_SEG_MARGIN && hit.distM < COLD_HEAL_MAX_OFF_M;
  const alongM = endSeg >= 0 ? (geom.cumAlong[Math.min(endSeg + 1, geom.cumAlong.length - 1)] ?? Infinity) : Infinity;
  const odoOk = typeof travelledM === "number" && Number.isFinite(travelledM) && travelledM + COLD_HEAL_ODO_SLACK_M >= alongM;
  const moving = typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs > COLD_HEAL_MIN_SPEED_MS;
  st.streak = past && receding && odoOk && moving ? st.streak + 1 : 0;
  if (st.streak >= COLD_HEAL_TICKS) {
    st.streak = 0;
    return { idx: idx + 1, healed: true, carSeg: hit?.seg, endSeg, alongM };
  }
  return { idx, healed: false };
}
