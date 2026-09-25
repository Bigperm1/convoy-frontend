// camRepair.ts — the head unit's CLOSED LOOP on its own camera (2026-09-25, Codex on round 7, [high]; round 9 review).
//
// Every earlier guard reasoned about WHEN a native animation ends from the JS side (its deadline + RETURN_FLY_GRACE_MS),
// and that grace is an unmeasured assumption (returnFly.ts): inject a 150 ms native start delay and a write made after
// the grace — Crew, a nearby crew, recenter at +720 ms — still loses to crewFit's easeTo on iOS (MapboxMap.setCamera
// "does not cancel existing animations"), leaving the parked camera at z 15 / pitch 0 / heading 0 with nothing owed.
//
// So the owner stops trusting its clock and LOOKS. It keeps what it last wrote (`want`: SelfCarModel.pushCam publishes
// every push; CarMapView's instant writers record theirs) and what the map REPORTS (`obs`: rnmapbox 10.3.1 onCameraChanged
// and onMapIdle carry properties.zoom / pitch / heading / center = cameraState.zoom / .pitch / .bearing / .center and a
// native epoch-ms `timestamp`, on iOS and Android). When nothing owns the camera (no fly, no JS ease, no Crew overview, no
// pinch, no tail), the map has stopped moving for CAM_REPAIR_SETTLE_MS, the owner has not written for as long, and the
// report shows the camera AFTER the last write (its native timestamp — a report delivered late but captured before the
// write is stale, round 9 finding 2; a write that drew no report at all is judged after CAM_REPAIR_NOREPORT_MS), the two
// must agree within tolerance. If they do not, a write was lost and the parked pump owes ONE corrective write that
// RESTORES WHAT WAS WRITTEN (round 9 finding 4): an instant push seeded with the written pose, or — when the gap itself
// is a visible jump (CAM_REPAIR_JUMP_*) — a short fly aimed at it. Never the speed target.
//
// Bounds (round 9 findings 1 and 3 — a budget for a device that NEVER agrees, not for a driver who taps several times):
//   • EPISODES: every owner intent (a gesture, a system correction, a Crew press) starts one; an agreement confirmed after
//     a try resets its count. CAM_REPAIR_BUDGET consecutive unconfirmed tries, each backing off (CAM_REPAIR_BACKOFF), then
//     ONE giveup row for the episode;
//   • after a giveup the camera is not abandoned: one slow retry after CAM_REPAIR_SLOW_MS, doubling each time up to
//     CAM_REPAIR_SLOW_MAX_MS, while it still disagrees — a stranded camera comes back with nothing happening;
//   • TIME caps across episodes (the GL retry-storm rule — bound every breadcrumb), per CAM_REPAIR_RATE_WINDOW_MS:
//     ≤ CAM_REPAIR_RATE_MAX corrective writes the map never CONFIRMED (a device that never agrees — the one the budget is
//     for; a confirmed repair proves the device agrees and the write was really lost, so a driver's taps are not
//     rationed), ≤ CAM_REPAIR_HARD_MAX corrective writes of any kind, ≤ CAM_REPAIR_ROWS_MAX rows (the rest are counted into
//     the next row's `drop=`).
// Why "what it last wrote" and not the speed target: a PARKED camera legitimately rests off the target (the automatic
// glide pump is off — camGlide.ts CAM_GLIDE_PUMP_ENABLED; nav start while stopped waits for the car to move). Comparing
// with the target would move a parked map. A MOVING car is untouched: it pushes every frame, so `want` is never
// CAM_REPAIR_SETTLE_MS old.
// Pure module: gated by tools/sim-qc/car_zoom_step_test.mts (CL*) and headunit_cam_delay_test.mts (the production code).

/** The map must have been still this long (and the owner silent this long) before its report is trusted. */
export const CAM_REPAIR_SETTLE_MS = 150;
/** Agreement tolerance: zoom levels. */
export const CAM_REPAIR_ZOOM_TOL = 0.05;
/** Agreement tolerance: pitch and heading, degrees. */
export const CAM_REPAIR_DEG_TOL = 1;
/** Consecutive unconfirmed corrective writes per episode before it gives up. */
export const CAM_REPAIR_BUDGET = 3;
/** Each further try waits this factor longer after the previous one (150 → 450 → 1350 ms). A push the map did not show
 *  was most likely overwritten by a native animation the report cannot reveal (harness DL493 — iOS, a 600 ms late fly
 *  home that flies to the pose it started from, the compass written inside it). */
export const CAM_REPAIR_BACKOFF = 3;
/** A write that drew no report (it changed nothing on screen, or the report never came): judge the last report after this. */
export const CAM_REPAIR_NOREPORT_MS = 1000;
/** After a giveup: the first slow retry this long after the last try… */
export const CAM_REPAIR_SLOW_MS = 20000;
/** …then doubling, up to this. */
export const CAM_REPAIR_SLOW_MAX_MS = 300000;
/** Across episodes: at most this many corrective writes the map never confirmed… */
export const CAM_REPAIR_RATE_MAX = 6;
/** …at most this many corrective writes of any kind… */
export const CAM_REPAIR_HARD_MAX = 30;
/** …and this many `cam-repair` rows… */
export const CAM_REPAIR_ROWS_MAX = 12;
/** …per this sliding window. */
export const CAM_REPAIR_RATE_WINDOW_MS = 60000;
/** A gap above this zoom… */
export const CAM_REPAIR_JUMP_ZOOM = 0.2;
/** …or these degrees is a visible jump if cut: the corrective write flies (short) instead. */
export const CAM_REPAIR_JUMP_DEG = 2;

/** What the owner last wrote (heading/pitch null = not written / unknown). */
export type CamPose = { zoom: number; pitch: number | null; heading: number | null; at: number };
/** What the map last reported. `changedAt`: when the reported pose last MOVED (JS receipt time). `stamp`: when the map
 *  CAPTURED it (the native timestamp; the receipt time when the report carries none). */
export type CamObs = { zoom: number; pitch: number | null; heading: number | null; lng: number | null; lat: number | null; gesture: boolean; at: number; changedAt: number; stamp: number };
export type CamRepair = {
  episodeAt: number; tries: number[]; gaveUp: boolean; giveupLogged: boolean; slow: number; open: number;
  pending: "push" | "fly" | null;
  writes: number[]; unconfirmed: number[]; rows: number[]; dropped: number;
};
export type CamRepairAct = "none" | "ok" | "push" | "fly" | "giveup";
/** `log`: the caller may write this row (the row cap); `drop`: rows suppressed since the last one written. `rep`: the
 *  report's capture time − the write's time (ms; < 0 = judged on a report from before the write, after the no-report
 *  timeout); `ep`: the episode's age (ms). */
export type CamRepairVerdict = { act: CamRepairAct; dz: number; dp: number; dh: number; n: number; rep: number; ep: number; log: boolean; drop: number };

export function newCamRepair(now = 0): CamRepair {
  return { episodeAt: now, tries: [], gaveUp: false, giveupLogged: false, slow: 0, open: 0, pending: null, writes: [], unconfirmed: [], rows: [], dropped: 0 };
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Smallest angle between two headings, degrees (0…180). */
export function camAngOff(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

/** Fold one map report into the observation (prev when it carries no zoom). The CENTRE only dates motion — a fly that
 *  moves the map at a constant zoom / pitch / heading is still moving — it is never compared. `stamp`: the report's native
 *  timestamp (rnmapbox `state.timestamp`, epoch ms); the receipt time when it has none. */
export function camObserve(prev: CamObs | null, zoom: unknown, pitch: unknown, heading: unknown, gesture: boolean, now: number, center?: unknown, stamp?: unknown): CamObs | null {
  if (!fin(zoom)) return prev;
  const p = fin(pitch) ? pitch : null, h = fin(heading) ? heading : null;
  const c = Array.isArray(center) && fin(center[0]) && fin(center[1]) ? center : null;
  const lng = c ? (c[0] as number) : prev?.lng ?? null, lat = c ? (c[1] as number) : prev?.lat ?? null;
  const same = !!prev && Math.abs(prev.zoom - zoom) < 1e-4
    && (p == null || prev.pitch == null || Math.abs(prev.pitch - p) < 0.01)
    && (h == null || prev.heading == null || camAngOff(prev.heading, h) < 0.01)
    && (c == null || prev.lng == null || prev.lat == null || (Math.abs(prev.lng - lng!) < 1e-7 && Math.abs(prev.lat - lat!) < 1e-7))
    && prev.gesture === gesture;
  return { zoom, pitch: p ?? prev?.pitch ?? null, heading: h ?? prev?.heading ?? null, lng, lat, gesture, at: now, changedAt: same ? prev!.changedAt : now, stamp: fin(stamp) ? stamp : now };
}

/** Record an owner write: the fields it wrote replace the last ones, the rest carry over. Non-finite values are unknown. */
export function camWrote(prev: CamPose | null, zoom: number, pitch: number | null | undefined, heading: number | null | undefined, now: number): CamPose | null {
  if (!fin(zoom)) return prev;
  return { zoom, pitch: fin(pitch) ? pitch : prev?.pitch ?? null, heading: fin(heading) ? heading : prev?.heading ?? null, at: now };
}

/** Observed − wanted: |zoom| levels, |pitch| and |heading| degrees (0 where either side is unknown or not finite). */
export function camGap(obs: CamObs, want: CamPose): { dz: number; dp: number; dh: number } {
  return {
    dz: fin(obs.zoom) && fin(want.zoom) ? Math.abs(obs.zoom - want.zoom) : 0,
    dp: fin(obs.pitch) && fin(want.pitch) ? Math.abs(obs.pitch - want.pitch) : 0,
    dh: fin(obs.heading) && fin(want.heading) ? camAngOff(obs.heading, want.heading) : 0,
  };
}

/** A new owner intent (a gesture, a system correction, a Crew press): a fresh episode — its own tries, no giveup, no
 *  owed write. The time caps stand. */
export function camRepairEpisode(st: CamRepair, now: number): void {
  st.episodeAt = now; st.tries = []; st.gaveUp = false; st.giveupLogged = false; st.slow = 0; st.open = 0; st.pending = null;
}

/**
 * One evaluation of the loop (CarMapView carCamJob, every parked tick). Mutates `st`. `busy`: something owns the camera
 * right now (a fly, a JS ease, a Crew overview, a pinch, a native tail) — the loop stands down and drops any owed write,
 * so it can never fight a gesture. Returns what happened THIS call: "push"/"fly" (a corrective write is now owed —
 * st.pending), "ok" (an earlier try is confirmed), "giveup" (the episode's budget ran out), "none".
 */
export function camRepairStep(st: CamRepair, now: number, obs: CamObs | null, want: CamPose | null, busy: boolean): CamRepairVerdict {
  const verdict = (act: CamRepairAct, g = { dz: 0, dp: 0, dh: 0 }): CamRepairVerdict => {
    const v: CamRepairVerdict = { act, ...g, n: st.tries.length, rep: obs && want ? obs.stamp - want.at : NaN, ep: now - st.episodeAt, log: false, drop: 0 };
    if (act === "none") return v;
    st.rows = st.rows.filter((t) => now - t < CAM_REPAIR_RATE_WINDOW_MS);
    if (st.rows.length < CAM_REPAIR_ROWS_MAX) { st.rows.push(now); v.log = true; v.drop = st.dropped; st.dropped = 0; } else st.dropped++;
    return v;
  };
  if (busy) { st.pending = null; return verdict("none"); }
  if (st.pending) return verdict("none");   // owed, and asked again before the pump pushed it
  if (!obs || !want || obs.gesture) return verdict("none");
  if (now - obs.changedAt < CAM_REPAIR_SETTLE_MS || now - want.at < CAM_REPAIR_SETTLE_MS) return verdict("none");
  // Judge a report of the camera AFTER the write — never one captured before it and delivered late (round 9 finding 2).
  if (obs.stamp < want.at && now - want.at < CAM_REPAIR_NOREPORT_MS) return verdict("none");
  const g = camGap(obs, want);
  if (g.dz <= CAM_REPAIR_ZOOM_TOL && g.dp <= CAM_REPAIR_DEG_TOL && g.dh <= CAM_REPAIR_DEG_TOL) {
    const confirmed = st.open !== 0;
    const v = confirmed ? verdict("ok", g) : verdict("none");
    if (confirmed) st.unconfirmed = st.unconfirmed.filter((t) => t !== st.open);   // this try worked: not rationed
    st.tries = []; st.gaveUp = false; st.slow = 0; st.open = 0;   // it agrees: nothing unconfirmed any more
    return v;
  }
  const lastTry = st.tries.length ? st.tries[st.tries.length - 1] : -Infinity;
  if (st.gaveUp) {
    // Given up — but a camera left wrong must come back with nothing happening: slow retries, doubling.
    if (now - lastTry < Math.min(CAM_REPAIR_SLOW_MAX_MS, CAM_REPAIR_SLOW_MS * 2 ** st.slow)) return verdict("none");
  } else if (st.tries.length >= CAM_REPAIR_BUDGET) {
    st.gaveUp = true; st.open = 0;
    if (st.giveupLogged) return verdict("none");
    st.giveupLogged = true;
    return verdict("giveup", g);
  } else if (now - lastTry < CAM_REPAIR_SETTLE_MS * CAM_REPAIR_BACKOFF ** st.tries.length) return verdict("none");   // back off
  st.writes = st.writes.filter((t) => now - t < CAM_REPAIR_RATE_WINDOW_MS);
  st.unconfirmed = st.unconfirmed.filter((t) => now - t < CAM_REPAIR_RATE_WINDOW_MS);
  if (st.unconfirmed.length >= CAM_REPAIR_RATE_MAX || st.writes.length >= CAM_REPAIR_HARD_MAX) return verdict("none");   // the time caps
  if (st.gaveUp) st.slow++;
  st.tries.push(now); st.writes.push(now); st.unconfirmed.push(now); st.open = now;
  st.pending = g.dz > CAM_REPAIR_JUMP_ZOOM || g.dp > CAM_REPAIR_JUMP_DEG || g.dh > CAM_REPAIR_JUMP_DEG ? "fly" : "push";
  return verdict(st.pending, g);
}
