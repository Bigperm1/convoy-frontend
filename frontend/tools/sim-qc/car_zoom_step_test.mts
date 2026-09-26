// car_zoom_step_test — the head-unit +/- zoom as an EASE with an absolute framing and an eased way home, and the Crew
// overview's way home for a STOPPED car (2026-09-25).
//
// Jeff, 2026-09-25: "the carplay zoomout seems like its capped at a distance and is not smooth." → "It creeps back in".
// Approved: each press animates in about 0.3 s, the map stays exactly where he put it (no speed drift) during the hold,
// then eases home in about 1 s after the hold. Plus (Codex [high] on f6f9e99e, field 09-20 +23.75 s): 7 s after a car
// Crew tap the camera starts home whether moving or stopped, with ONE camera owner and never two flies. Plus the
// round-2 review of 25ad00e1: a press during the Crew return fly, a press within 500 ms of a Crew tap, a pinch taking
// over mid-ease / mid-release, a followZoom step mid-release.
//
//   P  — every scenario through the PRODUCTION code: tools/sim-qc/headunit_cam_harness.mts lifts CarMapView's and
//        SelfCarModel's real closures out of the sources (TypeScript compiler) and runs them against a virtual clock
//        and a native camera with the SDK's cancel semantics; the scenarios are tools/sim-qc/headunit_cam_scenarios.mts.
//        (Replaying those same scenarios against 25ad00e1's sources fails 20 of them — the round-2 findings.)
//   N  — NEGATIVE CONTROLS: a model of the PRE-change code (c97a1580: bias + zoomSnapRef cut, glide release, no parked
//        pump) must show the 0.50 cut, the speed drift, the ~9 s crawl, the pitch snap and the parked overview that
//        waits for motion; and 25ad00e1's release (no rate-limited target) must show the followZoom-step cut.
//   R  — the return-fly re-aim state machine (src/returnFly.ts).  H — the receipt gate.  S — static wiring checks.
//
//   node --experimental-strip-types tools/sim-qc/car_zoom_step_test.mts     → PASS car_zoom_step / exit 1
import { readFileSync } from "node:fs";
import {
  CAR_ZOOM_STEP_MS, CAR_ZOOM_RELEASE_MS, CAR_ZOOM_LOG_MS, carZoomApply, carZoomEaseAt, carZoomHoldLapsed, carZoomLogGate,
  newCarZoomChannel, newCarZoomLog,
} from "../../src/carZoomStep.ts";
import { CREW_RETURN_MS, crewReturnEdge } from "../../src/crewReturn.ts";
import { RETURN_FLY_MS, returnFlyStep, returnFlyReaim, returnFlyInFlight } from "../../src/returnFly.ts";
import { glideStep, type GlideParams } from "../../src/camGlide.ts";
import { camObserve, camWrote, camRepairStep, camRepairEpisode, camAngOff, newCamRepair, camFlyStart, camFlyHold, CAM_FLY_STILL_MS, CAM_FLY_LAND_MAX_MS, CAM_REPAIR_SETTLE_MS, CAM_REPAIR_BUDGET, CAM_REPAIR_BACKOFF, CAM_REPAIR_NOREPORT_MS, CAM_REPAIR_SLOW_MS, CAM_REPAIR_RATE_MAX, CAM_REPAIR_HARD_MAX, CAM_REPAIR_ROWS_MAX, CAM_REPAIR_RATE_WINDOW_MS, type CamObs, type CamRepair } from "../../src/camRepair.ts";
import { chaseZoomForSpeed } from "../../src/chaseZoom.ts";
import { loadSrc, cameraWriteSites, cameraJsxProps, cameraMethodRefs, refEscapes, cameraJsxSpreads } from "./headunit_cam_harness.mts";
import { runScenarios } from "./headunit_cam_scenarios.mts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const f2 = (x: number) => x.toFixed(2), f3 = (x: number) => x.toFixed(3);

console.log("P — the production head-unit camera code (CarMapView + SelfCarModel lifted from the sources)");
{
  const t = Date.now();
  for (const r of runScenarios(await loadSrc(), chaseZoomForSpeed)) ok(`${r.id} ${r.name}`, r.pass, r.detail);
  console.log(`  (${Date.now() - t} ms)`);
}

// ── N: a model of the PRE-change head-unit code (c97a1580) — the negative control ─────────────────────────────────
const lock = JSON.parse(readFileSync(new URL("./data/nav-lock.json", import.meta.url), "utf8"));
const MB = lock.files["src/ConvoyMapbox.tsx"].locked, CM = lock.files["src/carplay/CarMapView.tsx"].locked;
const GLIDE: GlideParams = { zoomSlewPerS: +MB.CAM_ZOOM_SLEW_PER_S, zoomDeadband: +MB.CAM_ZOOM_DEADBAND, pitchSlewPerS: +MB.CAM_PITCH_SLEW_PER_S, tauMs: +MB.CAM_SMOOTH_TAU_MS };
const LIMIT = +CM.CAR_USER_ZOOM_BIAS_LIMIT, HOLD_MS = +CM.CAR_ZOOM_HOLD_MS, ZMIN = +MB.CHASE_ZOOM_CLAMP_MIN, ZMAX = +MB.CHASE_ZOOM_CLAMP_MAX;
const FRAME = 1000 / 60, T0 = 1_000_000;
type Old = { fz: (t: number) => number; bias: number; holdUntil: number; camZoom: number; camZoomGoal: number; camPitch: number; camPitchGoal: number;
  pitchTarget: number; lastCamAt: number; mapZoom: number; zoomSnap: boolean; camHoldUntil: number; wasActive: boolean; overview: boolean;
  lockReady: boolean; returnFly: number; flies: number[] };
const old = (fz: (t: number) => number, z: number, pitch = 50): Old => ({ fz: (t) => fz(t - T0), bias: 0, holdUntil: 0, camZoom: z, camZoomGoal: z,
  camPitch: pitch, camPitchGoal: pitch, pitchTarget: pitch, lastCamAt: 0, mapZoom: z, zoomSnap: false, camHoldUntil: 0, wasActive: false,
  overview: false, lockReady: true, returnFly: 0, flies: [] });
function oldPush(s: Old, t: number) {                        // c97a1580 SelfCarModel.pushCam + CarMapView getCam (zoom/pitch)
  if (!s.lockReady) return;
  const e = crewReturnEdge(s.wasActive, s.overview, s.camHoldUntil, t, s.mapZoom);
  if (e.snap) s.zoomSnap = true; if (e.fly) s.returnFly = -1; s.overview = e.overview; s.wasActive = e.wasActive;
  if (carZoomHoldLapsed(s.holdUntil, t, false)) { s.holdUntil = 0; s.bias = 0; }
  const zt = Math.max(ZMIN, Math.min(ZMAX, s.fz(t) + s.bias));
  const st = returnFlyStep(s.returnFly, t);
  if (st.action === "fly") { s.flies.push(t - T0); s.returnFly = st.next; return; }
  if (st.action === "wait") { s.returnFly = st.next; return; }
  s.returnFly = st.next;
  const dt = s.lastCamAt ? Math.max(0, Math.min(200, t - s.lastCamAt)) : 16; s.lastCamAt = t;
  const snap = s.zoomSnap || st.landed; s.zoomSnap = false;
  if (snap) { s.camZoom = s.camZoomGoal = zt; s.camPitch = s.camPitchGoal = s.pitchTarget; }
  else { const g = glideStep({ zoom: s.camZoom, pitch: s.camPitch, zoomGoal: s.camZoomGoal, pitchGoal: s.camPitchGoal }, zt, s.pitchTarget, dt, GLIDE);
    s.camZoom = g.zoom; s.camZoomGoal = g.zoomGoal; s.camPitch = g.pitch; s.camPitchGoal = g.pitchGoal; }
  s.mapZoom = s.camZoom;
}
function oldPress(s: Old, t: number, delta: number) {       // c97a1580 'zoomStep': bias + applyZoomNow + zoomSnapRef
  const fz = s.fz(t);
  s.bias = Math.max(Math.max(-LIMIT, ZMIN - fz), Math.min(Math.min(LIMIT, ZMAX - fz), s.bias + delta));
  s.camHoldUntil = 0; s.holdUntil = t + HOLD_MS; s.zoomSnap = true; s.mapZoom = Math.max(ZMIN, Math.min(ZMAX, fz + s.bias));
}
function oldRun(s: Old, u0: number, u1: number, moving: (u: number) => boolean, evs: { t: number; fn: (s: Old, t: number) => void }[]) {
  const out: { t: number; z: number; pitch: number }[] = [];
  const q = [...evs].sort((a, b) => a.t - b.t);
  let nextRender = u0;
  for (let u = u0; u <= u1 + 1e-9; u += FRAME) {
    while (q.length && q[0].t <= u) { const e = q.shift()!; e.fn(s, T0 + e.t); }
    if (u >= nextRender) { s.lockReady = T0 + u >= s.camHoldUntil; nextRender += 1000; }   // render-time lockReady
    if (moving(u)) oldPush(s, T0 + u);                                                         // parked: nothing pushes
    out.push({ t: u, z: s.mapZoom, pitch: s.camPitch });
  }
  return out;
}
console.log("N — NEGATIVE CONTROLS: the pre-change code (c97a1580, modelled) and 25ad00e1's release");
{
  const B1 = [0, 822, 1619, 2419, 3085, 4387], B2 = [0, 213, 382, 537];
  const kmh1 = (u: number) => (u <= 0 ? 58 : u >= 7147 ? Math.max(31, 33 - (u - 7147) / 7625) : 58 + (33 - 58) * (u / 7147));
  const fz1 = (u: number) => chaseZoomForSpeed(kmh1(u));
  const s2 = old(() => chaseZoomForSpeed(40), chaseZoomForSpeed(40));
  const fr2 = oldRun(s2, -200, 1500, () => true, B2.map((t) => ({ t, fn: (x: Old, tt: number) => oldPress(x, tt, -0.5) })));
  const cuts = B2.map((p) => { const i = fr2.findIndex((g) => g.t >= p); return Math.abs(fr2[i].z - fr2[i - 1].z); });
  ok("N1 before: each press is a one-frame cut of 0.50", cuts.every((c) => Math.abs(c - 0.5) < 1e-9), `(cuts ${cuts.map(f2).join(" ")}; field 09:41:36.523 16.13 → 15.63)`);
  let biasAt33 = NaN;
  const s1 = old(fz1, fz1(0));
  const fr1 = oldRun(s1, -200, 4387 + HOLD_MS + 12000, () => true, [...B1.map((t) => ({ t, fn: (x: Old, tt: number) => oldPress(x, tt, -0.5) })), { t: 7147, fn: (x: Old) => { biasAt33 = x.bias; } }]);
  const undone = fz1(7147) + biasAt33 - (fz1(0) - 3);
  ok("N2 before: slowing 58 → 33 km/h pulls the framing back in under the driver", undone > 0.5 && Math.abs(fz1(7147) + biasAt33 - 13.65) < 0.02, `(target at 33 km/h ${f2(fz1(7147) + biasAt33)} — field 09:36:23 zt=13.65; ${f2(undone)} of his 3.00 levels undone)`);
  const lapse = 4387 + HOLD_MS;
  const within = fr1.find((f, i) => f.t >= lapse && fr1.slice(i).every((g) => Math.abs(g.z - fz1(g.t)) <= 0.3));
  ok("N3 before: the way home crawls (> 5 s to within 0.3)", !!within && within.t - lapse > 5000, `(${within ? ((within.t - lapse) / 1000).toFixed(1) : "∞"} s; the investigation's glide replay: 9.0 s from −3)`);
  const sp = old(() => 16.84, 16.13);
  const frp = oldRun(sp, -200, HOLD_MS + 8000, () => false, B2.map((t) => ({ t, fn: (x: Old, tt: number) => oldPress(x, tt, -0.5) })));
  ok("N4 before: PARKED, the lapsed hold never comes home until the car moves", frp.filter((f) => f.t > 537 + HOLD_MS && f.t < 537 + HOLD_MS + 5000).every((f) => Math.abs(f.z - 14.84) < 1e-9), "(09-21: held 20 s, then a 3.5-level cut)");
  const pe = old(() => 16.5, 16.5, 45); pe.pitchTarget = 52;
  const frE = oldRun(pe, -100, 600, () => true, [{ t: 0, fn: (x: Old, tt: number) => oldPress(x, tt, -0.5) }]);
  const pj = Math.max(...frE.slice(1).map((f, i) => Math.abs(f.pitch - frE[i].pitch)));
  ok("N5 before: the press snaps the pitch to its target in one frame", pj >= 5, `(max ${f2(pj)}°/frame)`);
  const sc = old(() => 16.84, 16.84);
  oldRun(sc, 0, 26000, (u) => u >= 1000 + 23750, [{ t: 1000, fn: (x: Old, tt: number) => { x.camHoldUntil = tt + CREW_RETURN_MS; x.overview = true; x.wasActive = true; x.lockReady = false; x.mapZoom = 9.1; } }]);
  ok("N6 before: stopped, the Crew overview holds until the car moves (09-20: +23.75 s)", sc.flies.length === 1 && sc.flies[0] >= 1000 + 23750, `(fly at +${Math.round(sc.flies[0] - 1000)} ms)`);
  // 25ad00e1's release: its target was the raw live followZoom (no `to`) — a step passes through as a one-frame cut.
  const zc = newCarZoomChannel(), t0 = T0;
  zc.ease = { kind: "release", from: 16.5, v0: 0, start: t0, dur: CAR_ZOOM_RELEASE_MS };
  let prev = carZoomApply(zc, t0 + 900 - FRAME, 17.0)!, cut = 0;
  for (let t = t0 + 900; t <= t0 + 1300; t += FRAME) { const z = carZoomApply(zc, t, 16.43); if (z == null) break; cut = Math.max(cut, Math.abs(z - prev)); prev = z; }
  ok("N7 25ad00e1: a followZoom step 900 ms into the release was a one-frame cut", cut > 0.3, `(${f3(cut)} in one frame — the review measured 0.45)`);
}

console.log("R — the return fly re-aim (src/returnFly.ts)");
{
  const t = T0;
  ok("R1 re-aim a fly in flight → armed for its remaining time", returnFlyReaim(t + 1500, t + 300, CAR_ZOOM_STEP_MS) === -1200);
  ok("R2 …never shorter than CAR_ZOOM_STEP_MS", returnFlyReaim(t + 1500, t + 1400, CAR_ZOOM_STEP_MS) === -CAR_ZOOM_STEP_MS);
  ok("R3 an armed, idle or landed fly is left alone", returnFlyReaim(-1, t, 280) === -1 && returnFlyReaim(0, t, 280) === 0 && returnFlyReaim(t - 5, t, 280) === t - 5);
  const a = returnFlyStep(-1200, t), b = returnFlyStep(-1, t);
  ok("R4 a re-aim flies for its own ms; the return itself for RETURN_FLY_MS (the phone's -1 unchanged)", a.action === "fly" && a.ms === 1200 && a.next === t + 1200 && b.ms === RETURN_FLY_MS && b.next === t + RETURN_FLY_MS);
  ok("R5 in flight = armed or before its deadline", returnFlyInFlight(-1, t) && returnFlyInFlight(-280, t) && returnFlyInFlight(t + 1, t) && !returnFlyInFlight(t, t) && !returnFlyInFlight(0, t));
}

console.log("H — the receipt gate (≤ 1 row per 2 s, the burst's last row kept)");
{
  const st = newCarZoomLog(); const out: [number, string][] = [];
  const put = (t: number, r: string | null) => { const o = carZoomLogGate(st, t, r); if (o) out.push([t, o]); };
  for (let i = 0; i < 10; i++) put(T0 + i * 100, `row${i}`);
  for (let t = 1000; t < 5000; t += 33) put(T0 + t, null);
  ok("H1 ten presses in 1 s → two rows: the first, and the last once 2 s have passed", out.length === 2 && out[0][1] === "row0 n=1" && out[1][1] === "row9 n=9" && out[1][0] - T0 >= CAR_ZOOM_LOG_MS, `(${out.map(([t, r]) => `${t - T0}ms ${r}`).join(" | ")})`);
  const e = { kind: "step" as const, from: 16.8, v0: 2 * -0.5 / CAR_ZOOM_STEP_MS, start: T0, dur: CAR_ZOOM_STEP_MS };
  ok("H2 a press curve from rest moves ≤ 0.06 in its first 60 fps frame (easeOutCubic would move 0.084)", Math.abs(carZoomEaseAt(e, T0 + FRAME, 16.3) - 16.8) <= 0.06, `(${f3(Math.abs(carZoomEaseAt(e, T0 + FRAME, 16.3) - 16.8))})`);
}

console.log("CL — the closed loop (src/camRepair.ts): what the map reports vs what the owner last wrote");
{
  const t = T0;
  const o1 = camObserve(null, 16.8, 45, 90, false, t, [-123, 49], t - 5)!;
  const o2 = camObserve(o1, 16.8, 45, 90, false, t + 100, [-123, 49])!;
  const o3 = camObserve(o2, 16.8, 45, 90, false, t + 200, [-123.0001, 49])!;
  const o4 = camObserve(o3, 16.9, 45, 90, false, t + 300, [-123.0001, 49])!;
  const o5 = camObserve(o4, 16.9, 45, 90, false, t + 500, [-123.0001, 49], t + 450)!;
  ok("CL1 a repeated report keeps its changedAt; a moved zoom — or a moved CENTRE alone — dates it; the native timestamp is the capture time (the receipt time when absent); no zoom = no report; movedStamp = the CAPTURE time of the last move (a repeat keeps it)",
    o2.changedAt === t && o3.changedAt === t + 200 && o4.changedAt === t + 300 && o1.stamp === t - 5 && o2.stamp === t + 100 && camObserve(o4, undefined, 1, 2, false, t + 400, null) === o4
    && o1.movedStamp === t - 5 && o2.movedStamp === t - 5 && o3.movedStamp === t + 200 && o5.movedStamp === t + 300 && o5.stamp === t + 450);
  const obsAt = (z: number, p: number, h: number, at: number, stamp = at): CamObs => ({ zoom: z, pitch: p, heading: h, lng: 0, lat: 0, gesture: false, at, changedAt: at, stamp, movedStamp: stamp });
  const want = camWrote(null, 16.8, 45, 90, t)!;
  const late = t + 10 * CAM_REPAIR_SETTLE_MS;
  const after = (z: number, p: number, h: number) => obsAt(z, p, h, t + 20);   // captured AFTER the write, then still
  {
    const st = newCamRepair(t); st.pending = "push";
    const v = camRepairStep(st, late, after(15, 0, 0), want, true);
    ok("CL2 busy (a fly, an ease, an overview, a pinch, a tail): nothing — and an owed write is DROPPED (never fights them)", v.act === "none" && st.pending === null);
  }
  {
    const st = newCamRepair(t);
    const a1 = camRepairStep(st, t + CAM_REPAIR_SETTLE_MS - 1, after(15, 0, 0), want, false);
    const a2 = camRepairStep(st, late, obsAt(15, 0, 0, late - CAM_REPAIR_SETTLE_MS + 1), want, false);
    const a3 = camRepairStep(st, late, after(15, 0, 0), camWrote(null, 16.8, 45, 90, late - 1), false);
    ok("CL3 not before the map has been still AND the owner silent for the settle time", a1.act === "none" && a2.act === "none" && a3.act === "none" && st.tries.length === 0);
  }
  {
    // A report CAPTURED before the write but DELIVERED after it (round 9, two reviewers): never judged against the write…
    const st = newCamRepair(t);
    const stale = obsAt(16.8, 45, 0, t + 300, t - 50);   // heading 0 captured 50 ms before the write of heading 90
    const b1 = camRepairStep(st, t + 600, stale, want, false);
    const b2 = camRepairStep(st, t + CAM_REPAIR_NOREPORT_MS - 1, stale, want, false);
    // …unless the write drew no report at all: then the last report is judged after CAM_REPAIR_NOREPORT_MS.
    const b3 = camRepairStep(st, t + CAM_REPAIR_NOREPORT_MS, stale, want, false);
    ok("CL4 a stale report (captured before the write, delivered after it) is never judged against the write; with no report at all the last one is judged after the no-report timeout, rep < 0 on the row",
      b1.act === "none" && b2.act === "none" && b3.act === "fly" && b3.rep === -50);
  }
  {
    const st = newCamRepair(t);
    const inTol = camRepairStep(st, late, after(16.84, 45.9, 90.9), want, false);
    const v = camRepairStep(st, late, after(16.8, 45, 88.5), want, false);
    const again = camRepairStep(st, late + 5, after(16.8, 45, 88.5), want, false);
    const owedOnce = st.pending === "push";
    st.pending = null;   // getCam takes it: the corrective write is made (and, here, lands)
    const okd = camRepairStep(st, late + 1000, obsAt(16.8, 45, 90, late + 20), camWrote(null, 16.8, 45, 90, late + 10)!, false);
    const quiet = camRepairStep(st, late + 2000, obsAt(16.8, 45, 90, late + 20), want, false);
    ok("CL5 within 0.05 zoom / 1° agrees; 1.5° of heading off → ONE push owed (asked again: still one); the next agreement confirms it once ('ok', n=1) and clears the count",
      inTol.act === "none" && v.act === "push" && owedOnce && again.act === "none" && okd.act === "ok" && okd.n === 1 && quiet.act === "none" && st.tries.length === 0 && typeof v.rep === "number" && v.rep === 20);
  }
  ok("CL6 fly or push is chosen from the GAP (a visible jump flies, short), never from where the camera rests: a 0.3-level or 3° gap flies; a 0.1-level gap at z 12.5 is a push",
    camRepairStep(newCamRepair(t), late, after(16.5, 45, 90), want, false).act === "fly"
    && camRepairStep(newCamRepair(t), late, after(16.8, 42, 90), want, false).act === "fly"
    && camRepairStep(newCamRepair(t), late, obsAt(12.6, 45, 90, t + 20), camWrote(null, 12.5, 45, 90, t)!, false).act === "push");
  // A map that NEVER agrees, 10 minutes, one episode: the corrective writes and rows it gets.
  const run = (st: CamRepair, from: number, ms: number, wantAt = t) => {
    const out: { at: number; act: string; log: boolean; drop: number }[] = [];
    for (let clock = from; clock < from + ms; clock += 50) {
      st.pending = null;   // each owed write is made, and lost again
      const v = camRepairStep(st, clock, obsAt(15, 0, 0, t + 20), camWrote(null, 16.8, 45, 90, wantAt)!, false);
      if (v.act !== "none") out.push({ at: clock - from, act: v.act, log: v.log, drop: v.drop });
    }
    return out;
  };
  {
    const seq = run(newCamRepair(t), late, 600000);
    const tries = seq.filter((x) => x.act === "fly" || x.act === "push").map((x) => x.at);
    const gaps = tries.slice(1).map((x, i) => x - tries[i]);
    const gives = seq.filter((x) => x.act === "giveup").length;
    const giveAt = seq.find((x) => x.act === "giveup")!.at;
    const slow = tries.filter((x) => x > giveAt);
    ok(`CL7 a map that never agrees: ${CAM_REPAIR_BUDGET} tries backing off ×${CAM_REPAIR_BACKOFF}, ONE giveup row for the episode, then only slow retries ${CAM_REPAIR_SLOW_MS / 1000} s apart and doubling`,
      tries.slice(0, 3).length === 3 && gaps[0] >= CAM_REPAIR_SETTLE_MS * CAM_REPAIR_BACKOFF && gaps[1] >= CAM_REPAIR_SETTLE_MS * CAM_REPAIR_BACKOFF ** 2 && gives === 1
      && slow.length >= 3 && slow[0] - tries[2] >= CAM_REPAIR_SLOW_MS && slow[1] - slow[0] >= 2 * CAM_REPAIR_SLOW_MS && slow[2] - slow[1] >= 4 * CAM_REPAIR_SLOW_MS,
      `(tries at ${tries.map((x) => (x / 1000).toFixed(2)).join(", ")} s; giveup at ${(giveAt / 1000).toFixed(2)} s)`);
  }
  {
    // Episodes: a new owner intent re-arms a given-up loop with its own tries. A flood of episodes on a never-agreeing
    // map is held to CAM_REPAIR_RATE_MAX unconfirmed writes per window.
    const st = newCamRepair(t); let clock = late; const acts: { at: number; act: string }[] = [];
    for (let k = 0; k < 100; k++) {
      camRepairEpisode(st, clock);
      const w = camWrote(null, 16.8, 45, 90, clock)!;
      for (let u = 0; u < 3000; u += 50) {
        st.pending = null;
        const v = camRepairStep(st, clock + u, obsAt(15, 0, 0, clock + 20), w, false);
        if (v.act !== "none") acts.push({ at: clock + u, act: v.act });
      }
      clock += 3000;
    }
    const writes = acts.filter((x) => x.act === "fly" || x.act === "push").map((x) => x.at);
    let worst = 0; for (let i = 0; i < writes.length; i++) { let n = 0; for (let k = i; k < writes.length && writes[k] - writes[i] < CAM_REPAIR_RATE_WINDOW_MS; k++) n++; worst = Math.max(worst, n); }
    const first = newCamRepair(t); run(first, late, 20000);
    camRepairEpisode(first, late + 20000);
    const fresh = camRepairStep(first, late + 20000 + 10 * CAM_REPAIR_SETTLE_MS, obsAt(15, 0, 0, late + 20020), camWrote(null, 16.8, 45, 90, late + 20000)!, false);
    ok(`CL8 a new owner intent is a fresh episode (a given-up loop tries again); 100 episodes 3 s apart on a map that never agrees: ≤ ${CAM_REPAIR_RATE_MAX} corrective writes in any ${CAM_REPAIR_RATE_WINDOW_MS / 1000} s`,
      fresh.act === "fly" && worst <= CAM_REPAIR_RATE_MAX, `(most in a window: ${worst}; total ${writes.length})`);
  }
  {
    // A CONFIRMED repair is not rationed (a driver's taps): 20 lost writes in a minute, each repaired and confirmed → all
    // repaired. The hard ceiling still holds: ≤ CAM_REPAIR_HARD_MAX of any kind per window.
    const st = newCamRepair(t); let repaired = 0, clock = late;
    for (let k = 0; k < 40; k++) {
      const w = camWrote(null, 16.8, 45, 90, clock)!;
      camRepairEpisode(st, clock);
      const v = camRepairStep(st, clock + 10 * CAM_REPAIR_SETTLE_MS, obsAt(15, 0, 0, clock + 20), w, false);
      st.pending = null;
      const c = camRepairStep(st, clock + 20 * CAM_REPAIR_SETTLE_MS, obsAt(16.8, 45, 90, clock + 10 * CAM_REPAIR_SETTLE_MS + 20), camWrote(null, 16.8, 45, 90, clock + 10 * CAM_REPAIR_SETTLE_MS)!, false);
      if ((v.act === "fly" || v.act === "push") && c.act === "ok") repaired++;
      clock += 1500;   // 40 lost writes in 60 s
    }
    ok(`CL9 confirmed repairs are not rationed by the never-agree cap, only by the hard ceiling: 40 lost writes in 60 s, each confirmed → ${CAM_REPAIR_HARD_MAX} repaired (the hard cap), not ${CAM_REPAIR_RATE_MAX}`, repaired === CAM_REPAIR_HARD_MAX, `(repaired ${repaired})`);
  }
  {
    // Rows: ≤ CAM_REPAIR_ROWS_MAX per window; the rest are counted into the next written row's drop=.
    const st = newCamRepair(t); const logged: number[] = []; let dropped = 0, reported = 0;
    for (let k = 0; k < 60; k++) {
      const clock = late + k * 1000;
      const v = camRepairStep(st, clock, obsAt(15, 0, 0, clock - 500), camWrote(null, 16.8, 45, 90, clock - 1000)!, false);
      st.pending = null;
      const c = camRepairStep(st, clock + 400, obsAt(16.8, 45, 90, clock + 200), camWrote(null, 16.8, 45, 90, clock - 1000)!, false);
      for (const x of [v, c]) if (x.act !== "none") { if (x.log) { logged.push(x.act === "ok" ? clock + 400 : clock); reported += x.drop; } else dropped++; }
    }
    let worst = 0; for (let i = 0; i < logged.length; i++) { let n = 0; for (let k = i; k < logged.length && logged[k] - logged[i] < CAM_REPAIR_RATE_WINDOW_MS; k++) n++; worst = Math.max(worst, n); }
    // A minute later (the window empty), the next row carries every suppressed one in drop=.
    const q = late + 60 * 1000 + CAM_REPAIR_RATE_WINDOW_MS;
    const nx = camRepairStep(st, q, obsAt(15, 0, 0, q - 500), camWrote(null, 16.8, 45, 90, q - 1000)!, false);
    ok(`CL10 rows are time-capped: ≤ ${CAM_REPAIR_ROWS_MAX} per ${CAM_REPAIR_RATE_WINDOW_MS / 1000} s; the suppressed ones are counted into the next written row's drop=`, worst <= CAM_REPAIR_ROWS_MAX && dropped > 0 && nx.log && nx.drop === dropped - reported, `(most in a window ${worst}; suppressed ${dropped}; the next row, a window later: ${nx.act} drop=${nx.drop})`);
  }
  {
    const nanWant = { zoom: 16.8, pitch: 45, heading: NaN, at: t };
    const g = camRepairStep(newCamRepair(t), late, { ...after(15, 0, 0), gesture: true }, want, false);
    const unk = camRepairStep(newCamRepair(t), late, { ...after(16.8, 0, 0), pitch: null, heading: null }, want, false);
    const nan = camRepairStep(newCamRepair(t), late, after(16.8, 45, 0.3), nanWant, false);
    ok("CL11 a native gesture stands the loop down; an unreported or NON-FINITE pitch / heading is not compared (a NaN heading used to disagree forever); camWrote ignores a NaN zoom; 359° vs 1° is 2°",
      g.act === "none" && unk.act === "none" && nan.act === "none" && camWrote(want, NaN, 1, 2, t + 1) === want && Math.abs(camAngOff(359, 1) - 2) < 1e-9);
  }
  {
    // Round 10, finding 3 (verify_zoom_storm_1 ration4): an owner intent that lands before a try's verdict CARRIES it —
    // the next agreement clears it from the never-agree count. A try already judged wrong stays counted; so does a carried
    // try on a device that never agrees (the cap it exists for).
    const repairThenIntent = (st: CamRepair, clock: number, agreeAfter: boolean, judgeFirst: boolean) => {
      const w = camWrote(null, 16.8, 45, 90, clock)!;
      camRepairEpisode(st, clock);
      const v = camRepairStep(st, clock + 10 * CAM_REPAIR_SETTLE_MS, obsAt(15, 0, 0, clock + 20), w, false);   // lost → a try
      st.pending = null;
      const tw = clock + 10 * CAM_REPAIR_SETTLE_MS;
      if (judgeFirst) camRepairStep(st, tw + 200, obsAt(15, 0, 0, tw + 20), camWrote(null, 16.8, 45, 90, tw)!, false);   // judged wrong
      camRepairEpisode(st, tw + 250);   // the driver taps again before (or after) the verdict
      const w2 = camWrote(null, 16.8, 45, 90, tw + 250)!;
      camRepairStep(st, tw + 250 + 10 * CAM_REPAIR_SETTLE_MS, agreeAfter ? obsAt(16.8, 45, 90, tw + 270) : obsAt(15, 0, 0, tw + 270), w2, false);
      return v.act;
    };
    const a = newCamRepair(t); let acts = "";
    for (let k = 0; k < 10; k++) acts += repairThenIntent(a, late + k * 5000, true, false)[0];
    const b = newCamRepair(t); repairThenIntent(b, late, true, true);
    const c = newCamRepair(t); repairThenIntent(c, late, false, false);
    ok("CL12 a try an owner intent superseded before its verdict is CARRIED: the next agreement clears it (10 such in 50 s, all repaired, none left unconfirmed); a try judged wrong first stays counted; on a map that never agrees the carried try stays counted",
      acts === "ffffffffff" && a.unconfirmed.length === 0 && a.carry.length === 0 && b.unconfirmed.length === 1 && c.unconfirmed.length >= 1,
      `(tries ${acts}; unconfirmed after: superseded ${a.unconfirmed.length}, judged-first ${b.unconfirmed.length}, never-agree ${c.unconfirmed.length})`);
    // …and the never-agree cap still holds when EVERY try is superseded by an intent before its verdict.
    const st = newCamRepair(t); let clock = late; const tries: number[] = [];
    for (let k = 0; k < 100; k++) {
      camRepairEpisode(st, clock);
      const w = camWrote(null, 16.8, 45, 90, clock)!;
      st.pending = null;
      const v = camRepairStep(st, clock + 10 * CAM_REPAIR_SETTLE_MS, obsAt(15, 0, 0, clock + 20), w, false);
      if (v.act === "fly" || v.act === "push") tries.push(clock);
      clock += 3000;
    }
    let worst = 0; for (let i = 0; i < tries.length; i++) { let n = 0; for (let k = i; k < tries.length && tries[k] - tries[i] < CAM_REPAIR_RATE_WINDOW_MS; k++) n++; worst = Math.max(worst, n); }
    ok(`CL13 a never-agreeing map with an owner intent right after EVERY try (none ever judged): still ≤ ${CAM_REPAIR_RATE_MAX} corrective writes in any ${CAM_REPAIR_RATE_WINDOW_MS / 1000} s`, worst <= CAM_REPAIR_RATE_MAX && worst > 0, `(most in a window ${worst}; total ${tries.length})`);
  }
  {
    // Round 10, finding 2: A FLY'S LANDING WAITS FOR THE MAP. A fly called at t0 for 280 ms (JS deadline t0 + 280), grace G.
    const G = 100, t0 = late, end = t0 + 280;
    const st = newCamRepair(t); camFlyStart(st, t0, end);
    const still = obsAt(12, 45, 90, t0 - 500);                  // last moved (and captured) before the call: not started
    const run = { ...obsAt(14, 45, 90, end + G + 10), movedStamp: end + G + 5 };   // moving after the call
    const done = { ...obsAt(16.8, 45, 90, end + G + 10), movedStamp: end + G + 5 };  // moved after the call, then still
    const clock = camFlyHold(st, end, end + G - 1, still, G);
    const ns = camFlyHold(st, end, end + G + 20, still, G);
    const mv = camFlyHold(st, end, end + G + 20, run, G);
    const land = camFlyHold(st, end, end + G + 10 + CAM_FLY_STILL_MS, done, G);
    const cap = camFlyHold(st, end, end + G + CAM_FLY_LAND_MAX_MS, still, G);
    const noObs = camFlyHold(st, end, end + G + 20, null, G);
    const noRec = camFlyHold(newCamRepair(t), end, end + G + 20, still, G);
    const idle = camFlyHold(st, 0, end + G + 20, still, G), armed = camFlyHold(st, -1, end + G + 20, still, G);
    ok(`CL14 a fly's landing: the clock owns it until deadline + grace (unchanged); past it the fly stays in flight while the map shows it NOT STARTED (no move captured since the call) or MOVING (< ${CAM_FLY_STILL_MS} ms since the last change) — held ${CAM_FLY_STILL_MS} ms at a time; it lands once the map was still after moving, at the ${CAM_FLY_LAND_MAX_MS} ms cap, and with no report / no record (the clock, as before); idle and armed states untouched`,
      clock === end && ns === end + G + 20 + CAM_FLY_STILL_MS - G && mv === end + G + 20 + CAM_FLY_STILL_MS - G && land === end && cap === end && noObs === end && noRec === end && idle === 0 && armed === -1,
      `(clock ${clock - end}; not started → owned until +${ns + G - (end + G + 20)} ms; moving → +${mv + G - (end + G + 20)} ms; still → ${land === end ? "lands" : "held"}; cap → ${cap === end ? "lands" : "held"})`);
  }
}

console.log("S — static: the wiring the harness exercises");
{
  const cmv = readFileSync(new URL("../../src/carplay/CarMapView.tsx", import.meta.url), "utf8");
  const mbx = readFileSync(new URL("../../src/ConvoyMapbox.tsx", import.meta.url), "utf8");
  const czs = readFileSync(new URL("../../src/carZoomStep.ts", import.meta.url), "utf8");
  const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); if (i < 0) return ""; const j = src.indexOf(b, i + a.length); return j < 0 ? "" : src.slice(i, j); };
  const code = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const zs = code(between(cmv, "case 'zoomStep': {", "case 'recenter':"));
  ok("S1 the +/- buttons take the eased entry, not the instant one", /applyZoomEased\(g\.delta/.test(zs) && !/applyZoomNow\(/.test(zs));
  const tap = code(between(cmv, "if (!pinchActiveRef.current) {", "const delta = Math.log2("));
  ok("S2 tap-zoom takes the eased entry", /applyZoomEased\(dir \* ZOOM_TAP_STEP/.test(tap) && !/applyZoomNow\(/.test(tap));
  const pinch = code(between(cmv, "const delta = Math.log2(", "case 'zoomStep':"));
  ok("S3 a real pinch still calls the INSTANT path (1:1 with the fingers) — through the owner", /applyZoomNow\('gesture'\)/.test(pinch));
  const eased = code(between(cmv, "const applyZoomEased = (", "\n  };"));
  ok("S4 the eased entry sets no zoomSnapRef and calls no setCamera (pushCam is the one writer)", eased.length > 0 && !/zoomSnapRef/.test(eased) && !/setCamera/.test(eased));
  ok("S5 …during a return fly it re-aims the fly (through pushCam) and seeds from the visible zoom", /returnFlyRef\.current = returnFlyReaim\(returnFlyRef\.current, now, CAR_ZOOM_STEP_MS, RETURN_FLY_GRACE_MS\)/.test(eased) && /carZoomRest\([^)]*!\(overview \|\| flying\)\)/.test(eased));
  const blk = code(between(mbx, "const zoomCh = c.zoomCh;", "// Publish the zoom the camera is ACTUALLY at."));
  ok("S6 pushCam's ease block moves ZOOM only (no camPitch, no camHdgLag)", /carZoomApply\(zoomCh, now, c\.zoomLevel\)/.test(blk) && !/camPitch|camHdgLag/.test(blk));
  const fly = code(between(mbx, "if (st.action === 'fly') {", "return;   // lastCamAt"));
  ok("S7 pushCam flies for the step's own duration (a re-aim), not a fixed RETURN_FLY_MS", /animationDuration: st\.ms/.test(fly) && /predictAhead\([^)]*st\.ms\)/.test(fly));
  const gp = code(between(mbx, "const camGlidePending = (): boolean => {", "return !glideSettled("));
  ok("S8 the parked pump asks camJob BEFORE the automatic-glide ship switch", gp.indexOf("camJob()") >= 0 && gp.indexOf("camJob()") < gp.indexOf("CAM_GLIDE_PUMP_ENABLED"));
  ok("S9 CarMapView wires it: camJob={carCamJob}, getCam returns zoomCh, the crew edge is crewReturnEdge", /camJob=\{carCamJob\}/.test(cmv) && /zoomCh: zoomChRef\.current/.test(cmv) && /crewReturnEdge\(camHoldWasActiveRef\.current, crewOverviewRef\.current/.test(cmv));
  const job = code(between(cmv, "const carCamJob = useRef(", "}).current;"));
  ok("S10 carCamJob: nothing while a fly is in flight; lands a fly the moment its time is up (a seed never outlives its fly); re-arms the lockstep for a due crew hold or an armed fly; never yes when it cannot push", /if \(returnFlyRef\.current > 0 && now < returnFlyRef\.current \+ RETURN_FLY_GRACE_MS\) return false;/.test(job) && /const landingDue = returnFlyRef\.current > 0 && now >= returnFlyRef\.current \+ RETURN_FLY_GRACE_MS;/.test(job) && /crewDue \|\| flyArmed \|\| landingDue \|\| reapplyDue \|\|/.test(job) && /const reapplyDue = reapplyAfterRef\.current !== 0 && now >= reapplyAfterRef\.current;/.test(job) && /const flyArmed = returnFlyRef\.current < 0;/.test(job) && /\(crewDue \|\| flyArmed\) && !lockReadyRef\.current/.test(job) && /if \(!lockReadyRef\.current\) return false;/.test(job));
  const gc = code(between(cmv, "const edge = crewReturnEdge(", "crewOverviewRef.current = edge.overview;"));
  ok("S11 getCam: the fly carries the zoom (drops the ease); inside crewFit's easeTo — through its NATIVE end + grace — the return is a short fly", /if \(edge\.fly\) \{ returnFlyRef\.current = -1; zoomChRef\.current\.ease = null; \}/.test(gc) && /nowC < crewEaseUntilRef\.current \+ RETURN_FLY_GRACE_MS\) \{ returnFlyRef\.current = -CAR_ZOOM_STEP_MS; zoomChRef\.current\.ease = null; \}/.test(gc));
  // S25 — a write that lands in a native animation's tail is re-applied after it, never dropped (Codex's final pass).
  const tailFn = code(between(cmv, "const nativeTailUntil = (", "\n  };"));
  const gcHead = code(between(cmv, "const nowC = Date.now();", "const edge = crewReturnEdge("));
  const second = (name: string) => code(between(cmv, `const ${name} = (`, "\n  };")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))[2] ?? "";
  ok("S25 every native animation the owner starts is owned through its native end + grace, and a write inside that tail books a re-apply: the tail covers crewFit's easeTo and every fly (incl. re-aimed); both instant writers and every getCam push note it; getCam clears a due one (that push re-applies)",
    /Math\.max\(crewEaseUntilRef\.current \+ RETURN_FLY_GRACE_MS, rf > 0 \? rf \+ RETURN_FLY_GRACE_MS : 0\)/.test(tailFn)
    && /^noteWriteInTail\(Date\.now\(\)\);$/.test(second("applyZoomNow")) && /^noteWriteInTail\(Date\.now\(\)\);$/.test(second("ownerSetPose"))
    && /if \(reapplyAfterRef\.current !== 0 && nowC >= reapplyAfterRef\.current\) reapplyAfterRef\.current = 0;\s*\n\s*noteWriteInTail\(nowC\);/.test(gcHead)
    && (cmv.match(/reapplyAfterRef\.current = /g) ?? []).length === 2,
    `(${second("applyZoomNow")} | ${second("ownerSetPose")})`);
  const zb = code(between(cmv, "case 'zoomBegin':", "case 'zoomEnd':"));
  ok("S12 a pinch takes over from the APPLIED zoom (carZoomNow), not the ease's destination", /carZoomNow\(/.test(zb) && /userZoomRef\.current = clampBias\(applied - fzB\)/.test(zb));
  const clears = (a: string, b: string) => { const t = code(between(cmv, a, b)); return /manualZoomRef\.current = null/.test(t) && /zoomChRef\.current\.ease = null/.test(t); };
  ok("S13 recenter, compass, Crew and the AA re-assert clear the framing and the ease", clears("case 'recenter':", "case 'compass':") && clears("case 'compass': {", "case 'crewFit': {") && clears("case 'crewFit': {", "setCarState({ crewViewUntil") && clears("const reassertAaFollow = (", "const now = Date.now();"));
  ok("S14 src/carZoomStep.ts is pure (no imports at all)", !/^\s*import\s/m.test(czs));
  const tk = code(between(cmv, "const takeOverNativeCam = (", "\n  };"));
  ok("S16 an instant gesture goes through the camera owner: takeOverNativeCam retires a finished-but-unlanded fly first, re-aims a fly in flight, ends a Crew overview (the edge flies home); never writes the camera itself", /if \(returnFlyRef\.current > 0 && now >= returnFlyRef\.current \+ RETURN_FLY_GRACE_MS\) returnFlyRef\.current = 0;/.test(tk) && /returnFlyRef\.current = returnFlyReaim\(returnFlyRef\.current, now, CAR_ZOOM_STEP_MS, RETURN_FLY_GRACE_MS\)/.test(tk) && /if \(camHoldWasActiveRef\.current\) \{/.test(tk) && tk.indexOf("returnFlyRef.current = 0;") < tk.indexOf("returnFlyInFlight(") && !/setCamera/.test(tk));
  ok("S19 a head-unit landing starts the glide's goals at the landed frame (a parked landing cannot make the first moving push jump); the phone's landing is unchanged", /const carLand = !!landSeed && !!c\.zoomCh;/.test(mbx) && /camZoomGoal\.current = carLand \? landSeed!\.zoom : ws \? camZoom\.current : c\.zoomLevel;/.test(mbx) && /camPitchGoal\.current = carLand \? landSeed!\.pitch : ws \? camPitch\.current : c\.pitch;/.test(mbx));
  const pinchUpd = code(between(cmv, "const delta = Math.log2(", "case 'zoomStep':"));
  const effBody = (marker: string) => { const k = cmv.indexOf(marker); return k < 0 ? "" : code(cmv.slice(k, cmv.indexOf("}, [", k))); };
  ok("S17 every instant write names its kind: gestures (pinch update, recenter, compass, re-assert; the pending re-centre — unreachable today, defensive) and system corrections (layout, the cold-start snap at first paint); pinch begin asks the owner; crewFit retires any fly; the dead style-load seed is gone",
    /takeOverNativeCam\(nowB\)/.test(zb) && /applyZoomNow\('gesture'\)/.test(pinchUpd) && /applyZoomNow\('gesture'\)/.test(code(between(cmv, "case 'recenter':", "case 'compass':")))
    && /ownerSetPose\('gesture', \{ heading: drawHdgRef\.current \}\)/.test(code(between(cmv, "case 'compass': {", "case 'crewFit': {")))
    && /ownerSetPose\('gesture', \{ centerCoordinate: \[live\.lng, live\.lat\]/.test(code(between(cmv, "const reassertAaFollow = (", "const now = Date.now();")))
    && /ownerSetPose\('gesture', \{ centerCoordinate: \[lng, lat\]/.test(effBody("if (!aaPendingRecenterRef.current || !painted"))
    && /applyZoomNow\('system'\)/.test(effBody("if (!painted || mapW <= 0) return;")) && /ownerSetPose\('system'/.test(effBody("if (!painted || !hasFix || !cameraRef.current) return;"))
    && !/ownerSetPose\('system', \{ centerCoordinate: \[lng, lat\], pitch: followPitch, heading: followHeadingDeg \}\)/.test(cmv) && /markPainted\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*setStyleGen\(\(g\) => g \+ 1\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*\/\/ 🔒 NAV-LOCK end car-cam-style-load-seed/.test(cmv)
    && /returnFlyRef\.current = 0;/.test(code(between(cmv, "case 'crewFit': {", "setCarState({ crewViewUntil"))));
  const pure = ["carZoomStep", "crewReturn", "returnFly", "camRepair"].map((m) => readFileSync(new URL(`../../src/${m}.ts`, import.meta.url), "utf8"));
  ok("S18 disconnect / remount starts clean: the pure modules hold no module-level state (all state is per-mount refs)", pure.every((t) => !/^(let|var)\s/m.test(t)));
  // ── CLOSE THE CLASS (Codex fourth pass): a head-unit camera writer that bypasses the owner cannot come back silently ──
  // CarMapView may write the camera ONLY in the owner's two instant writers and in crewFit's overview easeTo (which
  // reconciles itself: it retires any fly and clears the zoom state); SelfCarModel only in pushCam (the per-frame
  // lockstep and the return fly). Any other site — a new effect, a gesture, a callback — fails here.
  const ALLOWED_CMV = new Set(["applyZoomNow", "ownerSetPose", "case 'crewFit'"]);
  // Hardened (round 6): the WHOLE file is scanned for camera-method mentions (module-level helpers, bracket access,
  // .call, destructuring), and the camera REF is followed — passing it or its .current to any helper (local or imported),
  // aliasing or storing it outside the owner fails too. <Camera> may carry no spread.
  const violations = (cmvSrc: string, mbxSrc: string): string[] => {
    const v: string[] = [];
    for (const x of cameraMethodRefs(cmvSrc)) if (!ALLOWED_CMV.has(x.owner)) v.push(`CarMapView ${x.shape} in ${x.owner}:${x.line}`);
    for (const x of refEscapes(cmvSrc, "CarMapView", "cameraRef", ALLOWED_CMV)) v.push(`CarMapView cameraRef escapes in ${x.owner}:${x.line} (${x.text})`);
    if (cameraJsxSpreads(cmvSrc, "CarMapView") > 0) v.push("CarMapView <Camera {...spread}>");
    for (const x of cameraMethodRefs(mbxSrc, "SelfCarModel")) if (x.owner !== "pushCam") v.push(`SelfCarModel ${x.shape} in ${x.owner}:${x.line}`);
    for (const x of refEscapes(mbxSrc, "SelfCarModel", "cameraRef", new Set(["pushCam"]))) v.push(`SelfCarModel cameraRef escapes in ${x.owner}:${x.line} (${x.text})`);
    return v;
  };
  const cmvSites = cameraWriteSites(cmv, "CarMapView");
  const real = violations(cmv, mbx);
  ok("S20 the head unit's camera is written only by the owner: CarMapView applyZoomNow · ownerSetPose · crewFit's easeTo, SelfCarModel pushCam — whole-file scan, ref followed", real.length === 0 && cmvSites.length === 3, `(${real.length ? real.join("; ") : cmvSites.map((x) => `${x.owner}:${x.line}`).join(", ")})`);
  const selfSites = cameraWriteSites(mbx, "SelfCarModel");
  ok("S21 SelfCarModel writes the camera only in pushCam (the lockstep push and the return fly)", selfSites.length === 2 && selfSites.every((x) => x.owner === "pushCam"), `(${selfSites.map((x) => `${x.owner}:${x.line}`).join(", ")})`);
  const camProps = cameraJsxProps(cmv, "CarMapView");
  const cp = camProps[0] ?? {};
  ok("S22 the head unit's <Camera> animates nothing (a seed only: no centre / zoom / bounds / follow props, no spread)", camProps.length === 1 && cameraJsxSpreads(cmv, "CarMapView") === 0 && Object.keys(cp).sort().join(",") === "animationDuration,animationMode,defaultSettings,followUserLocation,ref" && cp.followUserLocation === "{false}" && cp.animationMode === '"none"' && cp.animationDuration === "{0}", `(${JSON.stringify(cp)})`);
  const firstLine = (name: string) => code(between(cmv, `const ${name} = (`, "\n  };")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))[1] ?? "";
  ok("S23 both instant writers ask the owner before anything else", /^if \(takeOverNativeCam\(Date\.now\(\), kind\)\) return false;$/.test(firstLine("applyZoomNow")) && /^if \(takeOverNativeCam\(Date\.now\(\), kind\)\) return false;$/.test(firstLine("ownerSetPose")), `(${firstLine("applyZoomNow")} | ${firstLine("ownerSetPose")})`);
  // S24 — the gate bites: plant each realistic writer shape in a copy of the sources; every one must be caught.
  const LAYOUT = "applyZoomNow('system');";
  const plantC = (body: string, extra = "", importLine = "") => {
    let t = cmv.replace(LAYOUT, body) + extra;
    if (importLine) t = t.replace("import React, {", importLine + "\nimport React, {");
    return t;
  };
  const plants: [string, string, string][] = [
    ["P1 a direct write in the layout effect", plantC("cameraRef.current?.setCamera({ zoomLevel: followZoom, animationDuration: 0, animationMode: 'none' });"), mbx],
    ["P2 a module-level helper in CarMapView.tsx", plantC("snapCarCamera(cameraRef, followZoom);", "\nfunction snapCarCamera(ref: any, z: number) { ref.current?.setCamera({ zoomLevel: z, animationDuration: 0, animationMode: 'none' }); }\n"), mbx],
    ["P3 an IMPORTED helper handed the ref", plantC("snapCam(cameraRef, followZoom);", "", "import { snapCam } from '../camHelper';"), mbx],
    ["P4 bracket access", plantC("cameraRef.current?.['setCamera']({ zoomLevel: followZoom });"), mbx],
    ["P5 .setCamera.call", plantC("cameraRef.current?.setCamera.call(cameraRef.current, { zoomLevel: followZoom });"), mbx],
    ["P6 an alias of cameraRef.current", plantC("const cam = cameraRef.current; cam?.setCamera({ zoomLevel: followZoom });"), mbx],
    ["P7 a destructured method", plantC("const { setCamera } = cameraRef.current as any; setCamera({ zoomLevel: followZoom });"), mbx],
    ["P8 a JSX spread on <Camera>", cmv.replace("<Camera\n        ref={cameraRef}", "<Camera\n        {...{ zoomLevel: followZoom }}\n        ref={cameraRef}"), mbx],
    ["P9 a ConvoyMapbox helper called from SelfCarModel.bgTick", cmv, mbx.replace("    lastBgTickAt.current = now;\n", "    lastBgTickAt.current = now; camHelper(cameraRef, 16);\n") + "\nfunction camHelper(ref: any, z: number) { ref.current?.setCamera({ zoomLevel: z }); }\n"],
    ["P10 a direct write in SelfCarModel.bgTick", cmv, mbx.replace("    lastBgTickAt.current = now;\n", "    lastBgTickAt.current = now; cameraRef?.current?.setCamera({ zoomLevel: 16 });\n")],
  ];
  for (const [name, c2, m2] of plants) {
    const planted = c2 !== cmv || m2 !== mbx;
    const vv = violations(c2, m2);
    ok(`S24 negative control: ${name} is caught`, planted && vv.length > 0, `(${planted ? vv.slice(0, 2).join("; ") : "PLANT DID NOT APPLY"})`);
  }
  // S26 — the closed loop's wiring (Codex on round 7: close the class with observation, not a latency assumption).
  {
    const job26 = code(between(cmv, "const carCamJob = useRef(", "}).current;"));
    const gcHead26 = code(between(cmv, "const nowC = Date.now();", "const edge = crewReturnEdge("));
    const body = (name: string) => code(between(cmv, `const ${name} = (`, "\n  };"));
    const pub = between(mbx, "// 🔒 NAV-LOCK end mbx-pushcam-setcamera", "// CAM-APPLY RECEIPT");
    const setHdg = /heading: (\(camHeadingOverrideRef && typeof camHeadingOverrideRef\.current === 'number'\) \? camHeadingOverrideRef\.current : camHeading),/.exec(between(mbx, "NAV-LOCK begin mbx-pushcam-setcamera", "NAV-LOCK end mbx-pushcam-setcamera"))?.[1];
    const firstStmt = (name: string) => code(between(cmv, `const ${name} = (`, "\n  };")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))[1] ?? "";
    const crewCase = code(between(cmv, "case 'crewFit': {", "NAV-LOCK end car-gesture-crewfit"));
    ok("S26 the closed loop is wired: every owner (a fly armed / flying / landing, a JS ease, the Crew overview, a pinch, a reapply, a native tail) makes it stand down; getCam takes its owed write and RESTORES THE WRITTEN POSE (a 'push' seeds zoomSnapRef with it, a 'fly' is short and aimed at it); both instant writers record what they wrote, timed BEFORE the call; every owner intent opens an episode (takeOverNativeCam's first line, the +/- entry, Crew); onCameraChanged feeds it (with the native timestamp) before anything can return, outside the 🔒 region, and onMapIdle too; SelfCarModel publishes the pose it wrote — finite values only — with the setCamera's own heading expression; the JSX wires it",
      /const zoomOwed = carZoomJobOwed\(zoomChRef\.current, zoomHoldUntilRef\.current, now, pinchActiveRef\.current\);\s*const repairBusy = pinchActiveRef\.current \|\| zoomOwed \|\| returnFlyRef\.current !== 0 \|\| camHoldWasActiveRef\.current \|\|\s*now < camHoldUntilRef\.current \|\| reapplyAfterRef\.current !== 0 \|\| now < nativeTailUntil\(\);/.test(job26)
      && /\|\| repairDue \|\| zoomOwed;/.test(job26)
      && /camRepairStep\(camRepairRef\.current, now, camObsRef\.current, camWantRef\.current, repairBusy\)/.test(job26) && /\|\| repairDue \|\|/.test(job26) && /if \(rv\.log\)/.test(job26) && / rep=\$\{/.test(job26) && / ep=\$\{/.test(job26)
      && /if \(rw && rp === 'fly' && returnFlyRef\.current === 0\) \{ returnFlyRef\.current = -CAR_ZOOM_STEP_MS; zoomChRef\.current\.ease = null; repairAim = rw; \}/.test(gcHead26)
      && /else if \(rw\) zoomSnapRef\.current = \{ zoom: rw\.zoom, pitch: rw\.pitch \?\? undefined, heading: typeof camHdgOverrideRef\.current === 'number' \? undefined : rw\.heading \?\? undefined \};/.test(gcHead26)
      && /zoomLevel: repairAim \? repairAim\.zoom : carZoomDest\(/.test(cmv) && /pitch: repairAim && repairAim\.pitch != null \? repairAim\.pitch : fp,/.test(cmv)
      && ["applyZoomNow", "ownerSetPose"].every((n) => /camWantRef\.current = camWrote\([^;]*, wroteAt\);/.test(body(n)) && body(n).indexOf("const wroteAt = Date.now();") >= 0 && body(n).indexOf("const wroteAt = Date.now();") < body(n).indexOf("setCamera(") && body(n).indexOf("camWrote(") > body(n).indexOf("setCamera(") && !/camRepairRearm/.test(body(n)))
      && /^camRepairEpisode\(camRepairRef\.current, now\);$/.test(firstStmt("takeOverNativeCam")) && /camRepairEpisode\(camRepairRef\.current, now\);/.test(code(between(cmv, "const applyZoomEased = (", "\n  };"))) && /camRepairEpisode\(camRepairRef\.current, Date\.now\(\)\);/.test(crewCase)
      && /onCameraChanged=\{\(state: any\) => \{\s*\n\s*noteCamObserved\(state\);[^\n]*\n\s*\/\/ 🔒 NAV-LOCK begin car-selfcar-scale-refresh/.test(cmv) && /camObserve\([^;]*p\?\.center, state\?\.timestamp\);/.test(cmv)
      && /onMapIdle=\{\(state: any\) => \{ noteCamObserved\(state\);/.test(cmv) && /camPoseOutRef=\{camWantRef\}/.test(cmv)
      && !!setHdg && pub.includes(`const wh = ${setHdg};`) && /if \(Number\.isFinite\(camZoom\.current\)\) camPoseOutRef\.current = \{ zoom: camZoom\.current, pitch: Number\.isFinite\(camPitch\.current\) \? camPitch\.current : null, heading: typeof wh === 'number' && Number\.isFinite\(wh\) \? wh : null, at: now \};/.test(pub),
      `(setCamera heading expr ${setHdg ? "found" : "NOT FOUND"}; takeOverNativeCam first statement: ${firstStmt("takeOverNativeCam")})`);
    const cr = readFileSync(new URL("../../src/camRepair.ts", import.meta.url), "utf8");
    ok("S27 src/camRepair.ts is pure (no imports at all)", !/^\s*import\s/m.test(cr));
    // S28 — round 10: every reader of the fly's deadline asks the map first (holdFly = camFlyHold), and getCam records the
    // fly its push is about to start (camFlyStart) as its LAST statement before the return.
    const hold = /^returnFlyRef\.current = camFlyHold\(camRepairRef\.current, returnFlyRef\.current, now, camObsRef\.current, RETURN_FLY_GRACE_MS\);$/.test(firstStmt("holdFly"));
    const jobFirst = job26.indexOf("holdFly(now);"), jobEarly = job26.indexOf("if (returnFlyRef.current > 0 && now < returnFlyRef.current + RETURN_FLY_GRACE_MS) return false;");
    const gcAll = code(between(cmv, "const getCam = useRef(() => {", "}).current;"));
    const gcHold = gcAll.indexOf("holdFly(nowC);"), gcRet = gcAll.indexOf("return {"), gcStart = gcAll.indexOf("if (returnFlyRef.current < 0) camFlyStart(camRepairRef.current, nowC, returnFlyStep(returnFlyRef.current, nowC).next);");
    const pinchB = code(between(cmv, "case 'zoomBegin':", "takeOverNativeCam(nowB);"));
    ok("S28 a fly's landing asks the map first: holdFly runs before carCamJob's in-flight test, first in getCam (before pushCam's returnFlyStep), in takeOverNativeCam, the +/- entry and a pinch's start; getCam records the fly it arms (camFlyStart) after every change to returnFlyRef, just before its return",
      hold && jobFirst >= 0 && jobFirst < jobEarly && gcHold >= 0 && gcHold < gcAll.indexOf("const rp = camRepairRef.current.pending") && gcStart > gcAll.lastIndexOf("returnFlyRef.current = ") && gcStart < gcRet
      && /holdFly\(now\);/.test(body("takeOverNativeCam")) && /holdFly\(now\);/.test(code(between(cmv, "const applyZoomEased = (", "\n  };"))) && /holdFly\(nowB\);/.test(pinchB),
      `(holdFly body ${hold ? "ok" : "CHANGED"}; carCamJob ${jobFirst}<${jobEarly}; getCam hold@${gcHold} start@${gcStart} return@${gcRet})`);
  }
  ok("S15 pushCam re-arms a due crew hold before its readiness bail (a moving car comes home on the first frame)", /if \(camJob && !\(readyRef\?\.current\)\) camJob\(\);\s*\n\s*if \(!cameraRef\?\.current \|\| !getCam \|\| !\(readyRef\?\.current\)\) return;/.test(mbx));
}

console.log(fails ? `FAIL car_zoom_step (${fails})` : "PASS car_zoom_step");
process.exit(fails ? 1 : 0);
