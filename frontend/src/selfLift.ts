// selfLift — the live lift of the self car (both surfaces) and its receipts. The RULE is pure and
// gated in src/selfLiftRule.ts; this file merges the evidence each surface reports, keeps ONE
// target (there is one car), and remembers what each surface actually DREW so its route ribbon can
// be cut from where the car is (routeTrim leadShiftedByLift).
import { logEvent } from "./crashBreadcrumb";
import {
  liftDecide, LIFT_STATE0, LIFT_EVIDENCE_FRESH_MS, LIFT_ONROAD_SPEED_MS,
  type LiftEvidence, type LiftState, type RoadEvidence,
} from "./selfLiftRule";

export type LiftSurface = "phone" | "car";
type SurfaceEv = { at: number; speedMs: number | null; roadHit: boolean | null; buildingH: number | null; lot: boolean; complete: boolean };

let _state: LiftState = LIFT_STATE0;
let _offRoadLiftM = 10;
const _ev: Partial<Record<LiftSurface, SurfaceEv>> = {};
let _navDistM: number | null = null;
let _navAt = 0;
const _drawn: Record<LiftSurface, number> = { phone: 0, car: 0 };
/** Mapbox's own completeness signal per surface: onMapIdle → true (every tile loaded and rendered, no camera
 *  transition); onCameraChanged → false. An absence of roads reported while not idle is unknown, never off-road. */
const _idle: Record<LiftSurface, boolean> = { phone: false, car: false };
/** Monotonic count of camera changes per surface: a query is complete only if this did not move while it ran. */
const _camGen: Record<LiftSurface, number> = { phone: 0, car: 0 };
export function noteMapIdle(surface: LiftSurface, idle: boolean): void {
  _idle[surface] = idle;
  if (!idle) _camGen[surface] = (_camGen[surface] + 1) | 0;
}
export function isMapIdle(surface: LiftSurface): boolean { return _idle[surface]; }
export function mapCameraGen(surface: LiftSurface): number { return _camGen[surface]; }
const _drawnSubs: Record<LiftSurface, Set<() => void>> = { phone: new Set(), car: new Set() };
const _drawnNotifiedAt: Record<LiftSurface, number> = { phone: 0, car: 0 };
const DRAWN_NOTIFY_MIN_MS = 500;   // the ribbon owner (the whole map component) re-renders at most twice a second while a
                                   // lift slides, and once more when it settles — 10/s coincided with a 3.5 s JS stall on the sim
let _rows = 0;
const ROWS_MAX = 40;
let _qFail = 0;
let _qRows = 0;
const Q_ROWS_MAX = 24;
let _qLastRoad: Record<LiftSurface, boolean | null | undefined> = { phone: undefined, car: undefined };

/** The surfaces report the projection onto the active route on every fix (null when not navigating). */
export function noteSelfLiftNav(distM: number | null): void {
  _navDistM = typeof distM === "number" && Number.isFinite(distM) ? distM : null;
  _navAt = Date.now();
}

/** Set by the marker that is mounted: the car and the arrow have different off-road lifts. */
export function setSelfOffRoadLiftM(m: number): void { if (Number.isFinite(m) && m >= 0) _offRoadLiftM = m; }

function merged(now: number): LiftEvidence {
  let speedMs: number | null = null, roadHit: boolean | null = null, buildingH: number | null = null, lot = false, complete = false;
  for (const k of ["phone", "car"] as LiftSurface[]) {
    const e = _ev[k];
    if (!e || now - e.at > LIFT_EVIDENCE_FRESH_MS) continue;
    if (typeof e.speedMs === "number" && (speedMs == null || e.speedMs > speedMs)) speedMs = e.speedMs;
    if (e.roadHit === true) roadHit = true;
    // Off-road evidence of EITHER kind counts only from a surface whose map was idle for the whole query: an
    // absence may be a tile still loading, and a driveway seen under the car may be missing the closer road of
    // a tile still loading (Codex pass 5). A road HIT is presence and counts from any surface.
    if (!e.complete) continue;
    if (e.roadHit === false && roadHit == null) { roadHit = false; complete = true; }
    if (typeof e.buildingH === "number" && (buildingH == null || e.buildingH > buildingH)) { buildingH = e.buildingH; complete = true; }
    if (e.lot) { lot = true; complete = true; }
  }
  const navDistM = now - _navAt <= LIFT_EVIDENCE_FRESH_MS ? _navDistM : null;
  return { speedMs, navDistM, roadHit, buildingH, lot, complete };
}

/** A surface's one-second look at the map (or just its speed when it was too fast to bother asking). */
export function reportSelfLiftEvidence(surface: LiftSurface, ev: { speedMs: number | null; roadHit: boolean | null; buildingH: number | null; lot?: boolean; complete?: boolean }): LiftState {
  const now = Date.now();
  _ev[surface] = { at: now, speedMs: ev.speedMs, roadHit: ev.roadHit, buildingH: ev.buildingH, lot: !!ev.lot, complete: !!ev.complete };
  const m = merged(now);
  const next = liftDecide(_state, m, now, _offRoadLiftM);
  if (next.targetM !== _state.targetM && _rows < ROWS_MAX) {
    _rows += 1;
    try {
      logEvent(`self-lift surf=${surface} to=${next.targetM.toFixed(1)} from=${_state.targetM.toFixed(1)} why=${next.why} spd=${m.speedMs == null ? "?" : (m.speedMs * 3.6).toFixed(0)} nav=${m.navDistM == null ? "-" : m.navDistM.toFixed(0)} road=${m.roadHit == null ? "?" : m.roadHit ? 1 : 0} bld=${m.buildingH == null ? "-" : m.buildingH.toFixed(0)}${ev.lot ? " lot=1" : ""} idle=${ev.complete ? 1 : 0}`);
    } catch {}
  }
  _state = next;
  return next;
}

/** The map query threw (bounded receipt): the rule then sees "unknown", which never lifts. */
export function noteSelfLiftQueryFail(surface: LiftSurface, err: unknown): void {
  if (_qFail >= 3) return;
  _qFail += 1;
  try { logEvent(`self-lift q-fail surf=${surface} err=${String((err as any)?.message ?? err).slice(0, 80)}`); } catch {}
}

export function selfLiftTargetM(): number { return _state.targetM; }
export function selfLiftWhy(): string { return _state.why; }
/** What this surface is drawing right now (eased), for its ribbon cut. */
export function selfLiftDrawnM(surface: LiftSurface): number { return _drawn[surface]; }
/** The marker publishes what it draws; the ribbon owner of that surface is told (throttled, and always
 *  when the slide settles) so its cut is measured from the drawn car even while the car stands still. */
export function setSelfLiftDrawnM(surface: LiftSurface, m: number, settled = false): void {
  const v = Number.isFinite(m) ? m : 0;
  if (v === _drawn[surface] && !settled) return;
  _drawn[surface] = v;
  const now = Date.now();
  if (!settled && now - _drawnNotifiedAt[surface] < DRAWN_NOTIFY_MIN_MS) return;
  _drawnNotifiedAt[surface] = now;
  for (const fn of _drawnSubs[surface]) { try { fn(); } catch {} }
}
export function subscribeSelfLiftDrawn(surface: LiftSurface, fn: () => void): () => void {
  _drawnSubs[surface].add(fn);
  return () => { _drawnSubs[surface].delete(fn); };
}
/** A surface's marker went away (unmount, or it became the flat sprite): it draws no lift and its
 *  evidence no longer counts — the other surface, if any, decides alone. */
export function clearSelfLiftSurface(surface: LiftSurface): void {
  delete _ev[surface];
  _qLastRoad[surface] = undefined;
  setSelfLiftDrawnM(surface, 0, true);
  // No other surface still holds fresh evidence: the decision restarts from the ground, so a new
  // marker cannot inherit a lift (or a half-confirmed off-road timer) from a life that is over.
  const now = Date.now();
  const other = (["phone", "car"] as LiftSurface[]).some((k) => k !== surface && _ev[k] && now - (_ev[k] as SurfaceEv).at <= LIFT_EVIDENCE_FRESH_MS);
  if (!other) _state = LIFT_STATE0;
}
/** Bounded receipt of what our road source handed back — the first few queries and every flip of the
 *  road verdict — so the evidence behind a lift is in telemetry, not guessed. */
export function logSelfLiftQuery(surface: LiftSurface, q: { roads: number; drivable: number; drivableM: number | null; propertyM: number | null; buildings: number; ms?: number; complete?: boolean; nearestCls?: string | null }, ev: RoadEvidence): void {
  const flipped = _qLastRoad[surface] !== ev.roadHit;
  _qLastRoad[surface] = ev.roadHit;
  if (_qRows >= Q_ROWS_MAX || (!flipped && _qRows >= 4)) return;
  _qRows += 1;
  try {
    logEvent(`self-lift q surf=${surface} roads=${q.roads} drv=${q.drivable} drvM=${q.drivableM == null ? "-" : q.drivableM.toFixed(0)} propM=${q.propertyM == null ? "-" : q.propertyM.toFixed(0)} bldN=${q.buildings} ms=${q.ms ?? "?"} idle=${q.complete ? 1 : 0} road=${ev.roadHit == null ? "?" : ev.roadHit ? 1 : 0} bld=${ev.buildingH == null ? "-" : ev.buildingH}${ev.lot ? " lot=1" : ""} cls=${q.nearestCls ?? "-"}`);
  } catch {}
}
/** Fast enough that the map need not be asked at all. */
export function selfLiftSkipQuery(speedMs: number | null | undefined): boolean {
  return typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs >= LIFT_ONROAD_SPEED_MS;
}
