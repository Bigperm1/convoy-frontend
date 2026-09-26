// camRepair.ts — the head unit's CLOSED LOOP on its own camera (2026-09-25, Codex on round 7, [high]; round 9 review),
// and the head unit's camera LATENCY crumb (round 11).
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
// pinch, no tail, no zoom job owed), the map has stopped moving for CAM_REPAIR_SETTLE_MS, the owner has not written for as
// long, and the report shows the camera AFTER the last write (its native timestamp — a report delivered late but captured
// before the write is stale, round 9 finding 2; a write that drew no report at all is judged after CAM_REPAIR_NOREPORT_MS),
// the two must agree within tolerance. If they do not, a write was lost and the parked pump owes ONE corrective write.
//
// ROUND 11 — THE LOOP NEVER FLIES. The corrective write is always ONE INSTANT PUSH that restores the full WRITTEN pose:
// zoom, pitch AND heading (the north-up override still wins the heading), through the lockstep's CamWriteSeed path —
// the same instant 'none' write every parked push makes. Round 9/10's 280 ms repair FLY (when the gap exceeded 0.2 zoom /
// 2°) is gone, and with it the three findings it caused against round 10 (b68bda7e): it flew to the CAR's heading, not
// the written one (a parked map rotated ~20°); its landing hold froze a moving car's camera and hopped up to 18 m; and
// every owner intent inside it re-aimed it (460–1200 flyTo / 10 min). A repair is therefore a one-frame cut of exactly the
// lost write's size — the price of never animating from a pose the loop cannot see being reached.
//
// Bounds (round 9 findings 1 and 3 — a budget for a device that NEVER agrees, not for a driver who taps several times):
//   • EPISODES: every owner intent (a gesture, a system correction, a Crew press) starts one; an agreement confirmed after
//     a try resets its count. CAM_REPAIR_BUDGET consecutive unconfirmed tries, each backing off (CAM_REPAIR_BACKOFF), then
//     ONE giveup row for the episode;
//   • after a giveup the camera is not abandoned: one slow retry after CAM_REPAIR_SLOW_MS, doubling each time up to
//     CAM_REPAIR_SLOW_MAX_MS, while it still disagrees — a stranded camera comes back with nothing happening;
//   • TIME caps across episodes (the GL retry-storm rule — bound every breadcrumb), per CAM_REPAIR_RATE_WINDOW_MS:
//     ≤ CAM_REPAIR_RATE_MAX corrective writes the map never CONFIRMED, ≤ CAM_REPAIR_HARD_MAX corrective writes of any kind,
//     ≤ CAM_REPAIR_ROWS_MAX rows (the rest are counted into the next row's `drop=`);
//   • ROUND 11 rationing: a try an owner intent SUPERSEDES before it was judged proves nothing about the device — it is
//     DROPPED (never counted as unconfirmed) and logs one `op=superseded` row. Only a try judged against a post-write
//     report (or the CAM_REPAIR_NOREPORT_MS fallback) counts. Every try's episode resolves in one row: ok | giveup |
//     superseded (`counted=1` when the superseded try had already been judged wrong — it stays counted).
// Why "what it last wrote" and not the speed target: a PARKED camera legitimately rests off the target (the automatic
// glide pump is off — camGlide.ts CAM_GLIDE_PUMP_ENABLED; nav start while stopped waits for the car to move). Comparing
// with the target would move a parked map. A MOVING car is untouched: it pushes every frame, so `want` is never
// CAM_REPAIR_SETTLE_MS old.
// Also kept from round 10: a lapsed-but-unreleased 15 s zoom hold is busy for the loop (CarMapView carZoomJobOwed) — a
// try due on the lapse tick used to aim at the old held framing while the release eased from under it.
//
// THE LATENCY CRUMB (round 11 — measure instead of modelling). Every guard above rests on native latencies nobody has
// measured on a head unit (the 100 ms fly grace, the harness's 0–600 ms start delays). `cam-lat` measures them on the next
// drive, per car session: for an owner fly / ease and a sampled instant write, the time from the JS call to the first
// native camera report CAPTURED after it (start), to the next onMapIdle captured after it (end), and the report delivery
// lag (JS receipt − native capture, max over the window). Bounded: ≤ CAM_LAT_ROWS_MAX rows per session, ≥
// CAM_LAT_ROW_GAP_MS apart; a fly / ease outranks an instant-write sample, and instant writes are sampled on their own
// quota (≤ CAM_LAT_PUSH_ROWS_MAX a session, ≥ CAM_LAT_PUSH_GAP_MS apart) so the flies and eases keep the rest.
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
/** `cam-lat` rows per car session (one CarMapView mount)… */
export const CAM_LAT_ROWS_MAX = 20;
/** …at least this far apart. */
export const CAM_LAT_ROW_GAP_MS = 3000;
/** A measurement still open this long after its call is written as it stands (`end=-`: a moving car never goes idle). */
export const CAM_LAT_OPEN_MAX_MS = 6000;
/** Instant-write samples per session — a moving car writes 60 a second, so without a quota they would spend the whole
 *  session's rows in its first minute and no fly or ease would ever be measured (harness RL2)… */
export const CAM_LAT_PUSH_ROWS_MAX = 5;
/** …at least this far apart. */
export const CAM_LAT_PUSH_GAP_MS = 60000;

/** What the owner last wrote (heading/pitch null = not written / unknown). */
export type CamPose = { zoom: number; pitch: number | null; heading: number | null; at: number };
/** What the map last reported. `changedAt`: when the reported pose last MOVED (JS receipt time). `stamp`: when the map
 *  CAPTURED it (the native timestamp; the receipt time when the report carries none). */
export type CamObs = { zoom: number; pitch: number | null; heading: number | null; lng: number | null; lat: number | null; gesture: boolean; at: number; changedAt: number; stamp: number };
export type CamLatKind = "fly" | "ease" | "push";
/** One latency measurement: the call (JS ms), its requested duration, and what the reports showed (ms after the call). */
export type CamLatM = { kind: CamLatKind; at: number; ms: number; start: number | null; end: number | null; lag: number | null; n: number };
/** The crumb's per-session state: the open measurement, the row waiting for the gap, rows written, the last row's time,
 *  and the instant-write samples' own quota (rows written, the last one's time). */
export type CamLat = { open: CamLatM | null; pend: CamLatM | null; rows: number; lastRowAt: number; pushRows: number; lastPushRowAt: number };
/** `judged`: the open try has been judged wrong since it was made (it stays counted even if an intent supersedes it).
 *  `gap`: the last judged gap (for the superseded row). `lat`: the latency crumb (it rides the loop's per-mount state). */
export type CamRepair = {
  episodeAt: number; tries: number[]; gaveUp: boolean; giveupLogged: boolean; slow: number; open: number; judged: boolean;
  pending: "push" | null; gap: { dz: number; dp: number; dh: number };
  writes: number[]; unconfirmed: number[]; rows: number[]; dropped: number;
  lat: CamLat;
};
export type CamRepairAct = "none" | "ok" | "push" | "giveup" | "superseded";
/** `log`: the caller may write this row (the row cap); `drop`: rows suppressed since the last one written. `rep`: the
 *  report's capture time − the write's time (ms; < 0 = judged on a report from before the write, after the no-report
 *  timeout); `ep`: the episode's age (ms). `counted`: a superseded try stays counted (it was judged wrong first). */
export type CamRepairVerdict = { act: CamRepairAct; dz: number; dp: number; dh: number; n: number; rep: number; ep: number; log: boolean; drop: number; counted: boolean };

export function newCamLat(): CamLat { return { open: null, pend: null, rows: 0, lastRowAt: -Infinity, pushRows: 0, lastPushRowAt: -Infinity }; }
export function newCamRepair(now = 0): CamRepair {
  return { episodeAt: now, tries: [], gaveUp: false, giveupLogged: false, slow: 0, open: 0, judged: false, pending: null, gap: { dz: 0, dp: 0, dh: 0 }, writes: [], unconfirmed: [], rows: [], dropped: 0, lat: newCamLat() };
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Smallest angle between two headings, degrees (0…180). */
export function camAngOff(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

/** Fold one map report into the observation (prev when it carries no zoom). The CENTRE only dates motion — a map that
 *  moves at a constant zoom / pitch / heading is still moving — it is never compared. `stamp`: the report's native
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

/** The row time cap: may this row be written (and how many were suppressed since the last one)? */
function camRepairRowGate(st: CamRepair, now: number): { log: boolean; drop: number } {
  st.rows = st.rows.filter((t) => now - t < CAM_REPAIR_RATE_WINDOW_MS);
  if (st.rows.length < CAM_REPAIR_ROWS_MAX) { st.rows.push(now); const drop = st.dropped; st.dropped = 0; return { log: true, drop }; }
  st.dropped++;
  return { log: false, drop: 0 };
}

/** The `cam-repair` receipt for a verdict the row cap lets through (null otherwise). */
export function camRepairRow(v: CamRepairVerdict): string | null {
  if (!v.log || v.act === "none") return null;
  return `cam-repair surf=car op=${v.act} n=${v.n} dz=${v.dz.toFixed(2)} dp=${Math.round(v.dp)} dh=${Math.round(v.dh)} rep=${Number.isFinite(v.rep) ? Math.round(v.rep) : "-"} ep=${Math.round(v.ep)}${v.act === "superseded" ? ` counted=${v.counted ? 1 : 0}` : ""}${v.drop ? ` drop=${v.drop}` : ""}`;
}

/** A new owner intent (a gesture, a system correction, a Crew press): a fresh episode — its own tries, no giveup, no
 *  owed write. The time caps stand. ROUND 11: a try still open is SUPERSEDED — dropped from the never-agree count unless
 *  it was already judged wrong — and resolves in one `op=superseded` row, returned here for the caller to log (null when
 *  there was no open try or the row cap suppressed it). */
export function camRepairEpisode(st: CamRepair, now: number): string | null {
  let row: string | null = null;
  if (st.open !== 0) {
    const counted = st.judged;
    if (!counted) { const t = st.open; st.unconfirmed = st.unconfirmed.filter((x) => x !== t); }
    const gate = camRepairRowGate(st, now);
    row = camRepairRow({ act: "superseded", ...st.gap, n: st.tries.length, rep: NaN, ep: now - st.episodeAt, log: gate.log, drop: gate.drop, counted });
  }
  st.episodeAt = now; st.tries = []; st.gaveUp = false; st.giveupLogged = false; st.slow = 0; st.open = 0; st.judged = false; st.pending = null;
  return row;
}

/**
 * One evaluation of the loop (CarMapView carCamJob, every parked tick). Mutates `st`. `busy`: something owns the camera
 * right now (a fly, a JS ease, a lapsed zoom hold, a Crew overview, a pinch, a native tail) — the loop stands down and
 * drops any owed write, so it can never fight a gesture. Returns what happened THIS call: "push" (a corrective write is
 * now owed — st.pending; it is always an instant push of the written pose), "ok" (an earlier try is confirmed),
 * "giveup" (the episode's budget ran out), "none". Format the row with camRepairRow.
 */
export function camRepairStep(st: CamRepair, now: number, obs: CamObs | null, want: CamPose | null, busy: boolean): CamRepairVerdict {
  const verdict = (act: CamRepairAct, g = { dz: 0, dp: 0, dh: 0 }): CamRepairVerdict => {
    const v: CamRepairVerdict = { act, ...g, n: st.tries.length, rep: obs && want ? obs.stamp - want.at : NaN, ep: now - st.episodeAt, log: false, drop: 0, counted: false };
    if (act === "none") return v;
    const gate = camRepairRowGate(st, now);
    v.log = gate.log; v.drop = gate.drop;
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
    // This try worked, and the map shows what was written: it is not rationed.
    if (confirmed) { const t = st.open; st.unconfirmed = st.unconfirmed.filter((x) => x !== t); }
    st.tries = []; st.gaveUp = false; st.slow = 0; st.open = 0; st.judged = false;   // it agrees: nothing unconfirmed any more
    return v;
  }
  st.gap = g;
  if (st.open !== 0) st.judged = true;   // the open try is judged wrong: it stays counted even if an intent comes next
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
  st.tries.push(now); st.writes.push(now); st.unconfirmed.push(now); st.open = now; st.judged = false;
  st.pending = "push";   // round 11: ALWAYS one instant push of the written pose — the loop never flies
  return verdict("push", g);
}

// ── cam-lat: the latency crumb ─────────────────────────────────────────────────────────────────────────────────────
const latRank = (m: CamLatM) => (m.kind === "push" ? 0 : 2) + (m.end != null ? 1 : 0);
/** Close the open measurement into the waiting row (a fly / ease, or a measured end, outranks what is waiting). */
function latClose(L: CamLat): void {
  const m = L.open;
  L.open = null;
  if (m && (!L.pend || latRank(m) >= latRank(L.pend))) L.pend = m;
}
/** The `cam-lat` receipt for one measurement (ms, rounded; `-` = not seen). */
export function camLatRow(m: CamLatM): string {
  const r = (x: number | null) => (x == null || !Number.isFinite(x) ? "-" : String(Math.round(x)));
  return `cam-lat surf=car kind=${m.kind} ms=${Math.round(m.ms)} start=${r(m.start)} end=${r(m.end)} lag=${r(m.lag)} n=${m.n}`;
}
/** Every tick / call / report: close a measurement open too long, then write the waiting row once the gap allows. Returns
 *  the row to log (null = nothing to write now). */
export function camLatTick(L: CamLat, now: number): string | null {
  if (L.open && now - L.open.at >= CAM_LAT_OPEN_MAX_MS) latClose(L);
  if (L.pend && L.rows < CAM_LAT_ROWS_MAX && now - L.lastRowAt >= CAM_LAT_ROW_GAP_MS) {
    const row = camLatRow(L.pend);
    if (L.pend.kind === "push") { L.pushRows++; L.lastPushRowAt = now; }
    L.pend = null; L.rows++; L.lastRowAt = now;
    return row;
  }
  return null;
}
/**
 * A camera CALL on the car surface at `now` (JS ms, taken before the native call): an owner fly or ease (`ms` = its
 * requested duration) or an instant write (a push — the lockstep's 'none' write or an owner instant write). A fly / ease
 * always opens a measurement (a push sample open is discarded; a fly / ease still open is written as it stands — it was
 * re-aimed or replaced). A push opens one only when nothing is open or waiting, the row gap has passed and the push quota
 * allows (CAM_LAT_PUSH_ROWS_MAX, CAM_LAT_PUSH_GAP_MS), and the next push ends a push sample whose first report was seen
 * (a moving car pushes every frame). Returns the row to log.
 */
export function camLatCall(L: CamLat, kind: CamLatKind, now: number, ms: number): string | null {
  if (!fin(now)) return null;
  const anim = kind !== "push";
  if (L.open) {
    if (!anim) { if (L.open.kind === "push" && L.open.n > 0) latClose(L); }
    else if (L.open.kind === "push") L.open = null;
    else latClose(L);
  }
  const room = L.rows + (L.pend ? 1 : 0) < CAM_LAT_ROWS_MAX;
  const pushOk = !L.pend && now - L.lastRowAt >= CAM_LAT_ROW_GAP_MS && L.pushRows < CAM_LAT_PUSH_ROWS_MAX && now - L.lastPushRowAt >= CAM_LAT_PUSH_GAP_MS;
  if (!L.open && room && (anim || pushOk)) {
    L.open = { kind, at: now, ms: fin(ms) ? ms : 0, start: null, end: null, lag: null, n: 0 };
  }
  return camLatTick(L, now);
}
/**
 * A native camera REPORT (onCameraChanged, or onMapIdle with `idle`) received at `now`, captured at `stamp` (the native
 * epoch-ms timestamp; the receipt time when absent). A report captured before the open call is not its own. The first
 * one after the call dates the START; the first onMapIdle after that dates the END and closes it (an idle that comes
 * first is an earlier motion's). `lag` = the largest receipt − capture. Returns the row to log.
 */
export function camLatReport(L: CamLat, now: number, stamp: unknown, idle: boolean): string | null {
  const m = L.open;
  if (m && fin(now)) {
    const s = fin(stamp) ? stamp : now;
    if (s >= m.at && !(idle && m.n === 0)) {
      m.n++;
      if (fin(stamp)) m.lag = m.lag == null ? now - stamp : Math.max(m.lag, now - stamp);
      if (m.start == null) m.start = s - m.at;
      if (idle) { m.end = s - m.at; latClose(L); }
    }
  }
  return camLatTick(L, now);
}
