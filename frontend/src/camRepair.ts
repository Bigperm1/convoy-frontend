// camRepair.ts — the head unit's CLOSED LOOP on its own camera (2026-09-25, Codex on round 7, [high]).
//
// Every earlier guard reasoned about WHEN a native animation ends from the JS side (its deadline + RETURN_FLY_GRACE_MS),
// and that grace is an unmeasured assumption (returnFly.ts): inject a 150 ms native start delay and a write made after
// the grace — Crew, a nearby crew, recenter at +720 ms — still loses to crewFit's easeTo on iOS (MapboxMap.setCamera
// "does not cancel existing animations"), leaving the parked camera at z 15 / pitch 0 / heading 0 with nothing owed.
//
// So the owner stops trusting its clock and LOOKS. It keeps what it last wrote (`want`: SelfCarModel.pushCam publishes
// every push; CarMapView's instant writers record theirs) and what the map REPORTS (`obs`: rnmapbox 10.3.1 onCameraChanged
// and onMapIdle carry properties.zoom / pitch / heading = cameraState.zoom / .pitch / .bearing on iOS and Android). When
// nothing owns the camera (no fly, no JS ease, no Crew overview, no pinch, no tail) and the map has stopped moving for
// CAM_REPAIR_SETTLE_MS and the owner has not written for as long, the two must agree within tolerance. If they do not, a
// write was lost: the parked pump owes ONE corrective push — by the existing rule, a fly home from an overview zoom
// (isOverviewZoom, like crewReturnEdge) and a plain lockstep push otherwise. At most CAM_REPAIR_BUDGET tries per
// CAM_REPAIR_WINDOW_MS, each further try backing off (CAM_REPAIR_BACKOFF); then it gives up (one `cam-repair op=giveup` row) until the camera agrees again or the owner
// writes something new — a device that keeps reporting a different state cannot pump forever.
//
// Why "what it last wrote" and not the speed target: a PARKED camera legitimately rests off the target (the automatic
// glide pump is off — camGlide.ts CAM_GLIDE_PUMP_ENABLED; nav start while stopped waits for the car to move). Comparing
// with the target would move a parked map. Comparing with the last write only re-applies what the owner already did.
// A MOVING car is untouched: it pushes every frame, so `want` is never CAM_REPAIR_SETTLE_MS old.
// Pure module: gated by tools/sim-qc/car_zoom_step_test.mts (R*) and headunit_cam_delay_test.mts (the production code).

/** The map must have been still this long (and the owner silent this long) before its report is trusted. */
export const CAM_REPAIR_SETTLE_MS = 150;
/** Agreement tolerance: zoom levels. */
export const CAM_REPAIR_ZOOM_TOL = 0.05;
/** Agreement tolerance: pitch and heading, degrees. */
export const CAM_REPAIR_DEG_TOL = 1;
/** Corrective pushes allowed per window… */
export const CAM_REPAIR_BUDGET = 3;
/** …of this many ms (sliding). */
export const CAM_REPAIR_WINDOW_MS = 10000;
/** Each further try waits this factor longer after the previous one (150 → 450 → 1350 ms). A push the map did not show
 *  was most likely overwritten by a native animation the report cannot reveal: one that flies to the pose it started
 *  from reports no change at all (harness DL493 — iOS, a 600 ms late fly home, the compass written inside it: two pushes
 *  landed under the still-running fly, the third after it). Backing off lets that animation end inside the budget. */
export const CAM_REPAIR_BACKOFF = 3;

/** What the owner last wrote (heading/pitch null = not written / unknown). */
export type CamPose = { zoom: number; pitch: number | null; heading: number | null; at: number };
/** What the map last reported. `changedAt`: when the reported pose last MOVED (JS receipt time). */
export type CamObs = { zoom: number; pitch: number | null; heading: number | null; lng: number | null; lat: number | null; gesture: boolean; at: number; changedAt: number };
export type CamRepair = { tries: number[]; gaveUp: boolean; open: number; pending: "push" | "fly" | null };
export type CamRepairAct = "none" | "ok" | "push" | "fly" | "giveup";
export type CamRepairVerdict = { act: CamRepairAct; dz: number; dp: number; dh: number; n: number };

export function newCamRepair(): CamRepair {
  return { tries: [], gaveUp: false, open: 0, pending: null };
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Smallest angle between two headings, degrees (0…180). */
export function camAngOff(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

/** Fold one map report into the observation (prev when it carries no zoom). The CENTRE only dates motion — a fly that
 *  moves the map at a constant zoom / pitch / heading is still moving — it is never compared. */
export function camObserve(prev: CamObs | null, zoom: unknown, pitch: unknown, heading: unknown, gesture: boolean, now: number, center?: unknown): CamObs | null {
  if (!fin(zoom)) return prev;
  const p = fin(pitch) ? pitch : null, h = fin(heading) ? heading : null;
  const c = Array.isArray(center) && fin(center[0]) && fin(center[1]) ? center : null;
  const lng = c ? (c[0] as number) : prev?.lng ?? null, lat = c ? (c[1] as number) : prev?.lat ?? null;
  const same = !!prev && Math.abs(prev.zoom - zoom) < 1e-4
    && (p == null || prev.pitch == null || Math.abs(prev.pitch - p) < 0.01)
    && (h == null || prev.heading == null || camAngOff(prev.heading, h) < 0.01)
    && (c == null || prev.lng == null || prev.lat == null || (Math.abs(prev.lng - lng!) < 1e-7 && Math.abs(prev.lat - lat!) < 1e-7))
    && prev.gesture === gesture;
  return { zoom, pitch: p ?? prev?.pitch ?? null, heading: h ?? prev?.heading ?? null, lng, lat, gesture, at: now, changedAt: same ? prev!.changedAt : now };
}

/** Record an owner write: the fields it wrote replace the last ones, the rest carry over. */
export function camWrote(prev: CamPose | null, zoom: number, pitch: number | null | undefined, heading: number | null | undefined, now: number): CamPose {
  return { zoom, pitch: fin(pitch) ? pitch : prev?.pitch ?? null, heading: fin(heading) ? heading : prev?.heading ?? null, at: now };
}

/** Observed − wanted: |zoom| levels, |pitch| and |heading| degrees (0 where either side is unknown). */
export function camGap(obs: CamObs, want: CamPose): { dz: number; dp: number; dh: number } {
  return {
    dz: Math.abs(obs.zoom - want.zoom),
    dp: obs.pitch != null && want.pitch != null ? Math.abs(obs.pitch - want.pitch) : 0,
    dh: obs.heading != null && want.heading != null ? camAngOff(obs.heading, want.heading) : 0,
  };
}

/**
 * One evaluation of the loop (CarMapView carCamJob, every parked tick). Mutates `st`. `busy`: something owns the camera
 * right now (a fly, a JS ease, a Crew overview, a pinch, a native tail) — the loop stands down and drops any owed push, so
 * it can never fight a gesture. Returns what happened THIS call: "push"/"fly" (a corrective push is now owed — st.pending),
 * "ok" (an earlier try is confirmed), "giveup" (the budget ran out), "none". The caller logs the non-"none" ones.
 */
export function camRepairStep(st: CamRepair, now: number, obs: CamObs | null, want: CamPose | null, busy: boolean, isOverview: (z: number) => boolean): CamRepairVerdict {
  const none: CamRepairVerdict = { act: "none", dz: 0, dp: 0, dh: 0, n: st.tries.length };
  if (busy) { st.pending = null; return none; }
  if (st.pending) return none;   // owed, and asked again before the pump pushed it
  if (!obs || !want || obs.gesture) return none;
  if (now - obs.changedAt < CAM_REPAIR_SETTLE_MS || now - want.at < CAM_REPAIR_SETTLE_MS) return none;
  const g = camGap(obs, want);
  st.tries = st.tries.filter((t) => now - t < CAM_REPAIR_WINDOW_MS);
  if (g.dz <= CAM_REPAIR_ZOOM_TOL && g.dp <= CAM_REPAIR_DEG_TOL && g.dh <= CAM_REPAIR_DEG_TOL) {
    st.gaveUp = false;
    if (st.open) { st.open = 0; return { act: "ok", ...g, n: st.tries.length }; }
    return none;
  }
  if (st.gaveUp) return none;
  if (st.tries.length >= CAM_REPAIR_BUDGET) { st.gaveUp = true; st.open = 0; return { act: "giveup", ...g, n: st.tries.length }; }
  const lastTry = st.tries.length ? st.tries[st.tries.length - 1] : -Infinity;
  if (now - lastTry < CAM_REPAIR_SETTLE_MS * CAM_REPAIR_BACKOFF ** st.tries.length) return none;   // back off
  st.tries.push(now);
  st.open = now;
  st.pending = isOverview(obs.zoom) ? "fly" : "push";
  return { act: st.pending, ...g, n: st.tries.length };
}

/** A new owner intent (a gesture, a system correction): a given-up loop may try again. The window budget stands. */
export function camRepairRearm(st: CamRepair): void {
  st.gaveUp = false;
}
