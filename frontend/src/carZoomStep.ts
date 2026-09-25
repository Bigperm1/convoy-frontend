// carZoomStep — the head-unit +/- (and tap) zoom as an EASE, not a cut (2026-09-25).
//
// Jeff, 2026-09-25: "the carplay zoomout seems like its capped at a distance and is not smooth." Asked what 'capped'
// felt like, he picked "It creeps back in". The fix he approved: each press animates in about 0.3 s, the map stays
// exactly where he put it (no speed drift) during the hold, then eases home in about 1 s after the hold.
//
// What it replaces (all VERIFIED in the 09-25 investigation, scratchpad inv_out/investigate_carplay-zoomout.md):
//   • every press was a one-frame 0.5-level cut (applyZoomNow setCamera 'none' + pushCam's zoomSnapRef branch), which
//     also snapped the camera pitch and the heading lag — up to 25° of heading on a curve;
//   • the press was a BIAS added to the live speed zoom, so slowing down pulled the framing back in under the driver
//     (it cancelled 20–28 % of his presses on 09-25);
//   • when the 15 s hold lapsed the bias was zeroed and the 0.5 level/s glide crawled home (~9 s from −3), and a parked
//     car did not come home at all until it moved (09-21: 20 s, then a 3.5-level cut).
//
// THE ONE CAMERA OWNER. Nothing here calls setCamera. SelfCarModel.pushCam (src/ConvoyMapbox.tsx) is the only writer of
// the head-unit camera in every state: while the car moves its pose ease pushes every frame and applies carZoomApply;
// while it is PARKED, SelfCarModel's existing parked branches (step / bgTick / the wake effect — the camGlide parked
// pump) keep pushing at the drawn pose for as long as the surface owes a driver camera job (carZoomJobOwed, or the
// crew return — src/crewReturn.ts). So there is no second native ease racing the per-frame setCamera, no hand-over to
// get wrong, pushCam's own zoom state never goes stale, and the self car's per-tick size rides the same push.
//
// Pure: no 'react-native' import, so tools/sim-qc/car_zoom_step_test.mts replays the field presses against it.

/** One press lands in this long (Jeff: "about 0.3 s"). */
export const CAR_ZOOM_STEP_MS = 280;
/** The eased way home when the 15 s hold (CarMapView CAR_ZOOM_HOLD_MS, value-locked) lapses (Jeff: "about 1 s"). */
export const CAR_ZOOM_RELEASE_MS = 1200;
/** Launch speed of a press from rest, in units of (distance / CAR_ZOOM_STEP_MS). The curve is a cubic Hermite that
 *  lands at rest: 3 would be exactly easeOutCubic, 2 is exactly easeOutQuad. easeOutCubic moves 0.084 of a zoom level
 *  in the first 60 fps frame of a 0.5 press — over the 0.06/frame smoothness bar the gate holds; 2 moves 0.058. */
export const CAR_ZOOM_STEP_LAUNCH = 2;
/** The camera zoom pushCam last published (camZoomRef) is the start of a new ease only if it pushed this recently;
 *  otherwise the map's own reported zoom is (the lockstep was idle and something else may have moved the map). */
export const CAR_ZOOM_REST_FRESH_MS = 500;
/** Receipt tag only: the lockstep pushed this recently → the car's own ease loop is driving (via=push), else the
 *  parked pump will (via=park). */
export const CAR_ZOOM_MOVING_PUSH_MS = 100;
/** Receipt rate floor: at most one `car-zoom` row per this, plus the burst's last row once the floor allows. */
export const CAR_ZOOM_LOG_MS = 2000;
/** How fast the eased release's TARGET may follow the live speed zoom (levels/s) — the automatic framing's own pace
 *  (ConvoyMapbox CAM_ZOOM_SLEW_PER_S, 0.5). A step in followZoom mid-release (a step advance, nav start) used to pass
 *  straight into the camera as a one-frame cut of up to 1.4 levels (review of 25ad00e1). */
export const CAR_ZOOM_RELEASE_SLEW_PER_S = 0.5;

/** A zoom curve: cubic Hermite from (from, v0) to (dest, 0) over dur. dest is supplied when evaluated: fixed for a
 *  press (the driver's framing). A release carries its own target `to`, which follows the live follow zoom at no more
 *  than CAR_ZOOM_RELEASE_SLEW_PER_S (advanced by carZoomApply at `toAt`), so it lands on a moving target smoothly. */
export type CarZoomEase = { kind: "step" | "release"; from: number; v0: number; start: number; dur: number; to?: number; toAt?: number };
/** Shared by CarMapView (writes eases) and pushCam (applies them, stamps pushAt). */
export type CarZoomChannel = { ease: CarZoomEase | null; pushAt: number };
export type CarZoomLog = { at: number; pending: string | null; n: number };

export function newCarZoomChannel(): CarZoomChannel { return { ease: null, pushAt: 0 }; }
export function newCarZoomLog(): CarZoomLog { return { at: 0, pending: null, n: 0 }; }

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** The zoom this curve puts the camera at, at `now`. At and after start + dur it is exactly `dest`. */
export function carZoomEaseAt(e: CarZoomEase, now: number, dest: number): number {
  if (!(e.dur > 0)) return dest;
  const s = clamp01((now - e.start) / e.dur);
  if (s >= 1) return dest;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * e.from + (s3 - 2 * s2 + s) * e.dur * e.v0 + (-2 * s3 + 3 * s2) * dest;
}

/** Its slope in zoom levels per ms (dest held still), 0 once landed — carried into a re-aimed press. */
export function carZoomEaseVel(e: CarZoomEase, now: number, dest: number): number {
  if (!(e.dur > 0)) return 0;
  const s = clamp01((now - e.start) / e.dur);
  if (s >= 1) return 0;
  const s2 = s * s;
  return ((6 * s2 - 6 * s) * e.from + (3 * s2 - 4 * s + 1) * e.dur * e.v0 + (-6 * s2 + 6 * s) * dest) / e.dur;
}

export function carZoomEaseDone(e: CarZoomEase, now: number): boolean { return now >= e.start + e.dur; }

/** The destination an ease is heading for: a release's own (rate-limited) target, else the caller's. */
function easeDest(e: CarZoomEase, dest: number): number { return e.kind === "release" && typeof e.to === "number" ? e.to : dest; }

/** What getCam returns as zoomLevel: the driver's absolute framing while a press hold is on (so speed no longer pulls
 *  it — Jeff: "the map stays exactly where he put it"), else the speed zoom plus any pinch bias. Clamped to the range. */
export function carZoomDest(manual: number | null, followZoom: number, bias: number, lo: number, hi: number): number {
  const want = manual != null ? manual : followZoom + bias;
  return Math.max(lo, Math.min(hi, want));
}

/** The zoom the camera is at when no ease is running: pushCam's last push if fresh AND the lockstep owns the camera,
 *  else the map's reported zoom. lockstepOwns is false while a Crew overview or a return fly moves the map natively —
 *  then camZoomRef holds the overview's TARGET or a stale chase zoom, never what is on screen (review of 25ad00e1: a
 *  press within 500 ms of a Crew tap cut 0.7–6.7 levels from it). */
export function carZoomRest(now: number, pushAt: number, camZoom: number | null | undefined, liveZoom: number | null | undefined, fallback: number, lockstepOwns = true): number {
  if (lockstepOwns && typeof camZoom === "number" && Number.isFinite(camZoom) && now - pushAt < CAR_ZOOM_REST_FRESH_MS) return camZoom;
  if (typeof liveZoom === "number" && Number.isFinite(liveZoom) && liveZoom > 0) return liveZoom;
  if (typeof camZoom === "number" && Number.isFinite(camZoom)) return camZoom;
  return fallback;
}

/** The zoom pushCam would apply right now: the running ease's value, else the resting camera zoom. */
export function carZoomNow(zc: CarZoomChannel, now: number, dest: number, rest: number): number {
  return zc.ease ? carZoomEaseAt(zc.ease, now, easeDest(zc.ease, dest)) : rest;
}

/** fromChase: the press ends a Crew overview — step from the chase framing, not from the overview's wide zoom. */
export type CarZoomPressIn = { manual: number | null; followZoom: number; bias: number; lo: number; hi: number; rest: number; fromChase?: boolean };

/**
 * One +/- press (delta −0.5 / +0.5) or tap-zoom (±1). Re-aimable: a press during a running ease starts from where that
 * ease is NOW (never a restart jerk) and, when it keeps the same direction, from the speed it is moving at; a fresh or
 * reversing press launches at CAR_ZOOM_STEP_LAUNCH. The step is taken from what is ON SCREEN (so each press moves the
 * view exactly one step, even when the glide sits inside its dead-band off the speed zoom); while a hold is on, from the
 * pending framing, so N presses add exactly N steps; after a Crew overview, from the chase framing. `clampBias` is
 * CarMapView's 🔒 car-zoom-bias-clamp (the press limit, CAR_USER_ZOOM_BIAS_LIMIT, relative to the live speed zoom) —
 * passed in so there is one copy of that rule. Writes zc.ease; returns the framing.
 */
export function carZoomPress(zc: CarZoomChannel, now: number, delta: number, p: CarZoomPressIn, clampBias: (want: number) => number): { to: number; from: number; clamped: boolean } {
  const prevDest = carZoomDest(p.manual, p.followZoom, p.bias, p.lo, p.hi);
  const prev = zc.ease;
  const from = prev ? carZoomEaseAt(prev, now, easeDest(prev, prevDest)) : p.rest;
  const base = p.manual != null || p.fromChase ? prevDest : from;
  const want = base + delta;
  const to = p.followZoom + clampBias(want - p.followZoom);
  const d = to - from;
  let v0 = (CAR_ZOOM_STEP_LAUNCH * d) / CAR_ZOOM_STEP_MS;
  if (prev && !carZoomEaseDone(prev, now)) {
    const vc = carZoomEaseVel(prev, now, easeDest(prev, prevDest));
    if (vc * d > 0) v0 = vc;   // same direction: keep the speed it already has (velocity-continuous re-aim)
  }
  const vMax = (3 * Math.abs(d)) / CAR_ZOOM_STEP_MS;   // 3 = easeOutCubic's launch; faster would overshoot the framing
  if (Math.abs(v0) > vMax) v0 = Math.sign(v0) * vMax;
  zc.ease = { kind: "step", from, v0, start: now, dur: CAR_ZOOM_STEP_MS };
  return { to, from, clamped: Math.abs(to - want) > 1e-9 };
}

/** The hold's deadline has passed (not while a pinch is in progress — its 15 s runs from the pinch's END). */
export function carZoomHoldLapsed(holdUntil: number, now: number, pinchActive: boolean): boolean {
  return holdUntil !== 0 && !pinchActive && now >= holdUntil;
}

/** The eased way home: from wherever the camera is to the live follow zoom (liveDest now; its target then follows the
 *  live value at CAR_ZOOM_RELEASE_SLEW_PER_S — carZoomApply), starting at rest. */
export function carZoomRelease(zc: CarZoomChannel, now: number, prevDest: number, rest: number, liveDest: number): number {
  const from = zc.ease ? carZoomEaseAt(zc.ease, now, easeDest(zc.ease, prevDest)) : rest;
  zc.ease = { kind: "release", from, v0: 0, start: now, dur: CAR_ZOOM_RELEASE_MS, to: liveDest, toAt: now };
  return from;
}

/** pushCam, every push that reaches the camera: stamp the push, and if a driver ease is on, the zoom to push this frame
 *  (null → pushCam's own glide decides). The push that lands an ease retires it (a release: once its rate-limited target
 *  has reached the live follow zoom); the glide carries on from there. */
export function carZoomApply(zc: CarZoomChannel, now: number, dest: number): number | null {
  zc.pushAt = now;
  const e = zc.ease;
  if (!e) return null;
  if (e.kind === "release" && typeof e.to === "number") {
    // The release's target walks toward the live follow zoom at a bounded rate (a followZoom step is no longer a cut).
    const step = (CAR_ZOOM_RELEASE_SLEW_PER_S * Math.max(0, Math.min(200, now - (e.toAt ?? now)))) / 1000;
    e.to = e.to + Math.max(-step, Math.min(step, dest - e.to));
    e.toAt = now;
  }
  const z = carZoomEaseAt(e, now, easeDest(e, dest));
  // Retire once landed — a release only when its target has also REACHED the live follow zoom (so a parked car, whose
  // automatic glide is off, still finishes on the chase framing after a mid-release step instead of stopping short).
  if (carZoomEaseDone(e, now) && (e.kind !== "release" || typeof e.to !== "number" || e.to === dest)) zc.ease = null;
  return z;
}

/** A driver zoom job still owed to the camera: an ease not yet landed by a push, or a lapsed hold not yet released. */
export function carZoomJobOwed(zc: CarZoomChannel, holdUntil: number, now: number, pinchActive: boolean): boolean {
  return zc.ease != null || carZoomHoldLapsed(holdUntil, now, pinchActive);
}

/** ≤ 1 row per CAR_ZOOM_LOG_MS. A row that arrives too soon is kept as `pending` (a newer one replaces it) and emitted
 *  by a later call with row = null once the floor allows — so the last press of a burst is always on record. */
export function carZoomLogGate(st: CarZoomLog, now: number, row: string | null): string | null {
  if (row != null) {
    st.n += 1;
    if (now - st.at >= CAR_ZOOM_LOG_MS) { const out = `${row} n=${st.n}`; st.at = now; st.pending = null; st.n = 0; return out; }
    st.pending = row;
    return null;
  }
  if (st.pending != null && now - st.at >= CAR_ZOOM_LOG_MS) {
    const out = `${st.pending} n=${st.n}`; st.at = now; st.pending = null; st.n = 0; return out;
  }
  return null;
}
