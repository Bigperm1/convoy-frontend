// car_zoom_step_test — the head-unit +/- zoom as an EASE with an absolute framing and an eased way home, and the Crew
// overview's way home for a STOPPED car (2026-09-25).
//
// Jeff, 2026-09-25: "the carplay zoomout seems like its capped at a distance and is not smooth." → "It creeps back in".
// Approved: each press animates in about 0.3 s, the map stays exactly where he put it (no speed drift) during the hold,
// then eases home in about 1 s after the hold. Plus (Codex [high] on f6f9e99e, field 09-20 +23.75 s): 7 s after a car
// Crew tap the camera starts home whether moving or stopped, with ONE camera owner and never two flies.
//
// What runs here: every decision is the REAL exported function (src/carZoomStep.ts, src/crewReturn.ts,
// src/returnFly.ts, src/camGlide.ts glideStep with the LOCKED glide values read from nav-lock.json, src/chaseZoom.ts).
// The glue that calls them — CarMapView's getCam / applyZoomEased / carCamJob and SelfCarModel.pushCam's zoom branch — is
// replicated below in ~60 lines, and the S* static checks read the source to prove the real glue has that shape.
// Replays the field presses: 09-25 09:36:16.246 / 17.068 / 17.865 / 18.665 / 19.331 / 20.633 (58 → 33 km/h) and
// 09:41:36.259 / .472 / .641 / .796, 0.5 each, at 60 fps. A NEGATIVE CONTROL replays today's code (bias + zoomSnapRef
// cut, glide release, no parked pump) and must show the 0.50 jump, the ~9 s crawl, and the parked overview that stays.
//
//   node --experimental-strip-types tools/sim-qc/car_zoom_step_test.mts     → PASS car_zoom_step / exit 1
import { readFileSync } from "node:fs";
import {
  CAR_ZOOM_STEP_MS, CAR_ZOOM_RELEASE_MS, CAR_ZOOM_LOG_MS, carZoomPress, carZoomRelease, carZoomDest, carZoomRest,
  carZoomHoldLapsed, carZoomApply, carZoomJobOwed, carZoomEaseAt, carZoomEaseVel, carZoomLogGate, newCarZoomChannel,
  newCarZoomLog, type CarZoomChannel,
} from "../../src/carZoomStep.ts";
import { CREW_RETURN_MS, crewReturnEdge, crewReturnDue } from "../../src/crewReturn.ts";
import { RETURN_FLY_MS, returnFlyStep } from "../../src/returnFly.ts";
import { glideStep, type GlideParams } from "../../src/camGlide.ts";
import { chaseZoomForSpeed } from "../../src/chaseZoom.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const f2 = (x: number) => x.toFixed(2), f3 = (x: number) => x.toFixed(3);

// ── the locked values (read from the manifest the nav lock pins) ────────────────────────────────────────────────
const lock = JSON.parse(readFileSync(new URL("./data/nav-lock.json", import.meta.url), "utf8"));
const MB = lock.files["src/ConvoyMapbox.tsx"].locked, CM = lock.files["src/carplay/CarMapView.tsx"].locked;
const GLIDE: GlideParams = { zoomSlewPerS: +MB.CAM_ZOOM_SLEW_PER_S, zoomDeadband: +MB.CAM_ZOOM_DEADBAND, pitchSlewPerS: +MB.CAM_PITCH_SLEW_PER_S, tauMs: +MB.CAM_SMOOTH_TAU_MS };
const LIMIT = +CM.CAR_USER_ZOOM_BIAS_LIMIT, HOLD_MS = +CM.CAR_ZOOM_HOLD_MS, ZMIN = +MB.CHASE_ZOOM_CLAMP_MIN, ZMAX = +MB.CHASE_ZOOM_CLAMP_MAX;
const FRAME = 1000 / 60;
// Scenario clocks are offsets from T0 (a press at 0 = the field's first press); the model runs on T0 + offset so
// every deadline compares like Date.now() does (a zero deadline is always in the past).
const T0 = 1_000_000;

// ── the surface model: CarMapView (getCam / applyZoomEased / carCamJob / crewFit) + SelfCarModel.pushCam (zoom) ─────
type Surf = {
  legacy: boolean;                         // true = TODAY's code (the negative control)
  fz: (t: number) => number;               // followZoom (the speed zoom)
  manual: number | null; bias: number; holdUntil: number; pinch: boolean;
  zc: CarZoomChannel; log: ReturnType<typeof newCarZoomLog>; rows: string[];
  camZoom: number | null; camZoomGoal: number | null; camPitch: number; camPitchGoal: number; pitchTarget: number;
  lastCamAt: number; mapZoom: number; camZoomRef: number | null; zoomSnap: boolean;
  camHoldUntil: number; wasActive: boolean; overview: boolean; lockReady: boolean; painted: boolean; hasFix: boolean;
  returnFly: number; flyDest: number | null; flies: number[]; pushes: number;
};
function surf(legacy: boolean, fz: (t: number) => number, camZoom: number, pitch = 50): Surf {
  return { legacy, fz: (t: number) => fz(t - T0), manual: null, bias: 0, holdUntil: 0, pinch: false, zc: newCarZoomChannel(), log: newCarZoomLog(), rows: [],
    camZoom, camZoomGoal: camZoom, camPitch: pitch, camPitchGoal: pitch, pitchTarget: pitch, lastCamAt: 0, mapZoom: camZoom, camZoomRef: camZoom,
    zoomSnap: false, camHoldUntil: 0, wasActive: false, overview: false, lockReady: true, painted: true, hasFix: true,
    returnFly: 0, flyDest: null, flies: [], pushes: 0 };
}
const clampBiasOf = (s: Surf, t: number) => (want: number) => {   // 🔒 car-zoom-bias-clamp, verbatim arithmetic
  const fz = s.fz(t);
  return Math.max(Math.max(-LIMIT, ZMIN - fz), Math.min(Math.min(LIMIT, ZMAX - fz), want));
};
const log = (s: Surf, t: number, row: string | null) => { const o = carZoomLogGate(s.log, t, row); if (o) s.rows.push(`${Math.round(t - T0)} ${o}`); };
function getCam(s: Surf, t: number) {
  const e = crewReturnEdge(s.wasActive, s.overview, s.camHoldUntil, t, s.mapZoom);
  if (e.snap) s.zoomSnap = true;
  if (e.fly) s.returnFly = -1;
  s.overview = e.overview; s.wasActive = e.wasActive;
  const fz = s.fz(t);
  if (s.legacy) {
    if (carZoomHoldLapsed(s.holdUntil, t, s.pinch)) { s.holdUntil = 0; s.bias = 0; }
    return { zoomLevel: Math.max(ZMIN, Math.min(ZMAX, fz + s.bias)), pitch: s.pitchTarget, zoomCh: undefined as CarZoomChannel | undefined };
  }
  if (carZoomHoldLapsed(s.holdUntil, t, s.pinch)) {                       // zoomHoldRelease
    const prevDest = carZoomDest(s.manual, fz, s.bias, ZMIN, ZMAX);
    const from = carZoomRelease(s.zc, t, prevDest, carZoomRest(t, s.zc.pushAt, s.camZoomRef, s.mapZoom, prevDest));
    s.holdUntil = 0; s.bias = 0; s.manual = null;
    log(s, t, `car-zoom op=release z=${f2(from)} to=${f2(carZoomDest(null, fz, 0, ZMIN, ZMAX))}`);
  }
  log(s, t, null);
  return { zoomLevel: carZoomDest(s.manual, fz, s.bias, ZMIN, ZMAX), pitch: s.pitchTarget, zoomCh: s.zc };
}
function carCamJob(s: Surf, t: number): boolean {
  if (s.legacy) return false;                                               // today: no driver job, the pump is off
  log(s, t, null);
  const crewDue = crewReturnDue(s.wasActive, s.camHoldUntil, t);
  const flyArmed = s.returnFly === -1;
  if ((crewDue || flyArmed) && !s.lockReady && s.painted && s.hasFix && t >= s.camHoldUntil) s.lockReady = true;
  if (!s.lockReady) return false;
  return crewDue || flyArmed || carZoomJobOwed(s.zc, s.holdUntil, t, s.pinch);
}
function pushCam(s: Surf, t: number) {
  if (!s.legacy && !s.lockReady) carCamJob(s, t);
  if (!s.lockReady) return;
  const c = getCam(s, t);
  const st = returnFlyStep(s.returnFly as any, t);
  if (st.action === "fly") { s.flies.push(t - T0); s.flyDest = c.zoomLevel; s.returnFly = st.next; return; }
  if (st.action === "wait") { s.returnFly = st.next; return; }
  s.returnFly = st.next;
  const dt = s.lastCamAt ? Math.max(0, Math.min(200, t - s.lastCamAt)) : 16;
  s.lastCamAt = t;
  const userZoomed = s.zoomSnap; s.zoomSnap = false;
  if (userZoomed || st.landed || s.camZoom == null) {
    s.camZoom = st.landed && s.flyDest != null ? s.flyDest : c.zoomLevel; s.camPitch = c.pitch;
    s.camZoomGoal = c.zoomLevel; s.camPitchGoal = c.pitch; s.flyDest = null;
  } else {
    const g = glideStep({ zoom: s.camZoom, pitch: s.camPitch, zoomGoal: s.camZoomGoal ?? s.camZoom, pitchGoal: s.camPitchGoal }, c.zoomLevel, c.pitch, dt, GLIDE);
    s.camZoom = g.zoom; s.camZoomGoal = g.zoomGoal; s.camPitch = g.pitch; s.camPitchGoal = g.pitchGoal;
  }
  const eased = c.zoomCh ? carZoomApply(c.zoomCh, t, c.zoomLevel) : null;   // DRIVER ZOOM EASE
  if (eased != null) { s.camZoom = eased; s.camZoomGoal = eased; }
  s.mapZoom = s.camZoom; s.camZoomRef = s.camZoom; s.pushes++;
}
function press(s: Surf, t: number, delta: number) {
  const fz = s.fz(t);
  if (s.legacy) {                                                           // today: bias + applyZoomNow + zoomSnapRef
    s.bias = clampBiasOf(s, t)(s.bias + delta); s.camHoldUntil = 0; s.holdUntil = t + HOLD_MS; s.zoomSnap = true;
    s.mapZoom = Math.max(ZMIN, Math.min(ZMAX, fz + s.bias));
    return;
  }
  const prevDest = carZoomDest(s.manual, fz, s.bias, ZMIN, ZMAX);          // applyZoomEased
  const rest = carZoomRest(t, s.zc.pushAt, s.camZoomRef, s.mapZoom, prevDest);
  const r = carZoomPress(s.zc, t, delta, { manual: s.manual, followZoom: fz, bias: s.bias, lo: ZMIN, hi: ZMAX, rest, fromChase: s.wasActive }, clampBiasOf(s, t));
  s.manual = r.to; s.bias = 0; s.camHoldUntil = 0; s.holdUntil = t + HOLD_MS;
  log(s, t, `car-zoom op=step z=${f2(r.from)} to=${f2(r.to)} clamp=${r.clamped ? 1 : 0}`);
}
function crewFit(s: Surf, t: number, fitZoom: number) {
  s.camHoldUntil = t + CREW_RETURN_MS; s.overview = true; s.wasActive = true; s.lockReady = false;
  if (!s.legacy) { s.bias = 0; s.holdUntil = 0; s.manual = null; s.zc.ease = null; }
  s.mapZoom = fitZoom; s.camZoomRef = fitZoom;
}
const render = (s: Surf, t: number) => { s.lockReady = s.painted && s.hasFix && t >= s.camHoldUntil; };   // 🔒 car-cam-northup-lockready

type Ev = { t: number; fn: (s: Surf, t: number) => void };
type Frame = { t: number; z: number; pitch: number; pushed: boolean };
/** 60 fps frames; moving → pushCam every frame, parked → the parked pump (carCamJob then pushCam); render ticks at renderMs. */
function run(s: Surf, t0: number, t1: number, moving: (t: number) => boolean, evs: Ev[], renderMs = 1000, tickMs = FRAME): Frame[] {
  const out: Frame[] = [];
  const q = [...evs].sort((a, b) => a.t - b.t);
  let nextRender = t0;
  for (let u = t0; u <= t1 + 1e-9; u += tickMs) {
    const t = T0 + u;
    while (q.length && q[0].t <= u) { const e = q.shift()!; e.fn(s, T0 + e.t); }
    if (u >= nextRender) { render(s, t); nextRender += renderMs; }
    const before = s.pushes;
    if (moving(u)) pushCam(s, t);
    else if (carCamJob(s, t)) pushCam(s, t);
    out.push({ t: u, z: s.mapZoom, pitch: s.camPitch, pushed: s.pushes > before });
  }
  return out;
}
const maxStep = (fr: Frame[], a: number, b: number) => {
  let m = 0, at = 0;
  for (let i = 1; i < fr.length; i++) if (fr[i].t >= a && fr[i].t <= b) { const d = Math.abs(fr[i].z - fr[i - 1].z); if (d > m) { m = d; at = fr[i].t; } }
  return { m, at };
};
const zAt = (fr: Frame[], t: number) => fr.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best)).z;

// Field clock: burst 1 starts at 09:36:16.246 → t = 0. Speed 58 → 33 km/h by 09:36:23.393 (7147 ms), 31 after.
const B1 = [0, 822, 1619, 2419, 3085, 4387];
const kmh1 = (t: number) => (t <= 0 ? 58 : t >= 7147 ? Math.max(31, 33 - (t - 7147) / 7625) : 58 + (33 - 58) * (t / 7147));
const fz1 = (t: number) => chaseZoomForSpeed(kmh1(t));
// Burst 2: 09:41:36.259 → t = 0; 40 km/h at 09:41:33, 26 km/h by 09:41:48 (11.8 s later).
const B2 = [0, 213, 382, 537];
const kmh2 = (t: number) => Math.max(26, 40 - 14 * Math.max(0, t + 3000) / 14800);
const fz2 = (t: number) => chaseZoomForSpeed(kmh2(t));

console.log("A — burst 1 (6 presses over 4.4 s, 58 → 33 km/h), moving: each press an ease, framing held, eased home");
{
  const s = surf(false, fz1, 16.02);                                        // cam-probe 09:36:08.390 z=16.02 zt=15.80
  const evs = B1.map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) }));
  const fr = run(s, -200, 4387 + HOLD_MS + 3000, () => true, evs);
  const last = B1[B1.length - 1];
  const st = maxStep(fr, -200, last + CAR_ZOOM_STEP_MS + 50);
  ok("A1 no frame-to-frame zoom change > 0.06 across the burst", st.m <= 0.06, `(max ${f3(st.m)} at t=${Math.round(st.at)} ms)`);
  const want = 16.02 - 3.0;
  ok("A2 six presses = exactly 3.0 levels from where the camera was", Math.abs((s.manual ?? NaN) - want) < 1e-9 || Math.abs(zAt(fr, last + 1000) - want) < 1e-9, `(framing ${f2(zAt(fr, last + 1000))}, want ${f2(want)})`);
  const landT = last + CAR_ZOOM_STEP_MS;
  const firstLanded = fr.find((f) => f.t >= landT)!;
  ok("A3 the last press lands on its framing by CAR_ZOOM_STEP_MS", Math.abs(firstLanded.z - want) < 1e-9, `(z ${f3(firstLanded.z)} at +${Math.round(firstLanded.t - last)} ms)`);
  const miss = B1.map((p, i) => Math.abs(fr.find((f) => f.t >= p + CAR_ZOOM_STEP_MS)!.z - (16.02 - 0.5 * (i + 1))));
  ok("A4 every press lands on its own framing within CAR_ZOOM_STEP_MS (0.8 s apart → no overlap)", miss.every((m) => m < 1e-9), `(max miss ${Math.max(...miss).toExponential(1)})`);
  const hold = fr.filter((f) => f.t >= landT && f.t < last + HOLD_MS);
  const drift = Math.max(...hold.map((f) => Math.abs(f.z - want)));
  const fzMove = fz1(landT) - fz1(last + HOLD_MS - 1);
  ok("A5 the framing does not move while the speed zoom does (58 → 31 km/h)", drift < 1e-9, `(drift ${drift.toExponential(1)}; followZoom moved ${f2(fz1(-100))} → ${f2(fz1(last + HOLD_MS - 1))}, Δ ${f2(-fzMove)})`);
  const lapse = last + HOLD_MS;
  const within = fr.find((f, i) => f.t >= lapse && fr.slice(i).every((g) => g.t > lapse + 3000 || Math.abs(g.z - fz1(g.t)) <= 0.1));
  const took = within ? within.t - lapse : Infinity;
  ok("A6 after the 15 s hold it eases home to the live speed zoom within 0.1 in ≤ 1.4 s", took <= 1400, `(${Math.round(took)} ms from ${f2(want)} to ~${f2(fz1(lapse))})`);
  const rel = maxStep(fr, lapse - 20, lapse + CAR_ZOOM_RELEASE_MS + 20);
  const firstRel = fr.find((f) => f.t >= lapse)!, prevRel = fr[fr.indexOf(firstRel) - 1];
  ok("A7 the release starts from rest (no jerk): first frame < 0.01", Math.abs(firstRel.z - prevRel.z) < 0.01, `(${f3(Math.abs(firstRel.z - prevRel.z))}; max frame step in the release ${f3(rel.m)} — a ${f2(fz1(lapse) - want)}-level ease-in-out in ${CAR_ZOOM_RELEASE_MS} ms)`);
  const ended = fr.find((f) => f.t >= lapse + CAR_ZOOM_RELEASE_MS)!;
  ok("A8 the release lands exactly on the live speed zoom and hands to the glide", Math.abs(ended.z - fz1(ended.t)) < 0.02 && s.zc.ease === null, `(z ${f3(ended.z)} vs ${f3(fz1(ended.t))})`);
  const hasStep = s.rows.some((r) => /car-zoom op=step/.test(r)), hasRel = s.rows.some((r) => /car-zoom op=release/.test(r));
  const gaps = s.rows.map((r) => +r.split(" ")[0]).map((t, i, a) => (i ? t - a[i - 1] : Infinity));
  ok("A9 the car-zoom receipt: ≤ 1 row per 2 s, the burst's last press on record, the release on record", hasStep && hasRel && gaps.every((g) => g >= CAR_ZOOM_LOG_MS) && s.rows.some((r) => /to=13\.02/.test(r)), `(${s.rows.length} rows: ${s.rows.map((r) => r.replace(/^(\d+) car-zoom /, "$1ms ")).join(" | ")})`);
}

console.log("B — burst 2 (4 presses in 0.54 s), moving: re-aimed, velocity-continuous, lands 280 ms after the last press");
{
  const s = surf(false, fz2, 16.13);
  const eases: { t: number; from: number; before: number; vBefore: number; vAfter: number }[] = [];
  const evs = B2.map((t) => ({ t, fn: (x: Surf, tt: number) => {
    const fz = x.fz(tt), prevDest = carZoomDest(x.manual, fz, x.bias, ZMIN, ZMAX);
    const before = x.zc.ease ? carZoomEaseAt(x.zc.ease, tt, prevDest) : NaN;
    const vBefore = x.zc.ease ? carZoomEaseVel(x.zc.ease, tt, prevDest) : 0;
    press(x, tt, -0.5);
    eases.push({ t: tt, from: x.zc.ease!.from, before, vBefore, vAfter: x.zc.ease!.v0 });
  } }));
  const fr = run(s, -200, 3000, () => true, evs);
  const last = B2[B2.length - 1];
  const st = maxStep(fr, -200, last + CAR_ZOOM_STEP_MS + 50);
  ok("B1 no frame-to-frame zoom change > 0.06 across the burst", st.m <= 0.06, `(max ${f3(st.m)} at t=${Math.round(st.at)} ms)`);
  const reaims = eases.slice(1);
  const posJump = Math.max(...reaims.map((e) => Math.abs(e.from - e.before)));
  const velJump = Math.max(...reaims.map((e) => Math.abs(e.vAfter - e.vBefore) * FRAME));
  ok("B2 re-aim is continuous: each press starts from where the running ease IS (no restart jerk)", posJump < 1e-12, `(max position jump ${posJump.toExponential(1)})`);
  ok("B3 re-aim keeps the speed it already had (velocity-continuous, same direction)", velJump < 1e-9, `(max velocity change ${velJump.toExponential(1)} levels/frame)`);
  const want = eases[0].from - 2.0;   // from where the camera WAS at the first press (it was gliding: field zt 16.42, z 16.12)
  const landed = fr.find((f) => f.t >= last + CAR_ZOOM_STEP_MS)!;
  ok("B4 four presses = exactly 2.0 levels, landed CAR_ZOOM_STEP_MS after the last press", Math.abs(landed.z - want) < 1e-9, `(${f3(eases[0].from)} → ${f3(landed.z)} at +${Math.round(landed.t - last)} ms)`);
  const mono = fr.filter((f) => f.t >= 0 && f.t <= last + CAR_ZOOM_STEP_MS).every((f, i, a) => i === 0 || f.z <= a[i - 1].z + 1e-12);
  ok("B5 zoom-out only ever moves out during the burst (no bounce)", mono);
}

console.log("C — burst 2 while PARKED: the parked pump (SelfCarModel's parked branches) drives the same ease, then stops");
{
  const s = surf(false, () => 16.84, 16.13);   // stopped: speed zoom flat
  s.zc.pushAt = T0 - 60000;                     // the lockstep has not pushed for a minute
  const evs = B2.map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) }));
  const fr = run(s, -200, HOLD_MS + 4000, () => false, evs);
  const last = B2[B2.length - 1];
  const st = maxStep(fr, -200, last + CAR_ZOOM_STEP_MS + 50);
  ok("C1 parked: no frame-to-frame zoom change > 0.06", st.m <= 0.06, `(max ${f3(st.m)})`);
  const landed = fr.find((f) => f.t >= last + CAR_ZOOM_STEP_MS)!;
  ok("C2 parked: lands on the framing by CAR_ZOOM_STEP_MS", Math.abs(landed.z - 14.13) < 1e-9, `(z ${f3(landed.z)})`);
  const idle = fr.filter((f) => f.t > last + CAR_ZOOM_STEP_MS + FRAME && f.t < last + HOLD_MS - FRAME);
  ok("C3 parked: the pump stops once landed (no spin through the hold)", idle.every((f) => !f.pushed), `(${fr.filter((f) => f.pushed).length} pushed frames in all)`);
  const lapse = last + HOLD_MS;
  const firstRel = fr.find((f) => f.t >= lapse && f.pushed);
  ok("C4 parked: the hold's lapse is caught on the next parked tick — no fix, no render needed", !!firstRel && firstRel.t - lapse <= FRAME + 1e-6, `(${firstRel ? Math.round(firstRel.t - lapse) : "never"} ms after the deadline)`);
  const home = fr.find((f) => f.t >= lapse + CAR_ZOOM_RELEASE_MS)!;
  const after = fr.filter((f) => f.t > lapse + CAR_ZOOM_RELEASE_MS + 2 * FRAME);
  ok("C5 parked: eased home to the speed zoom in CAR_ZOOM_RELEASE_MS, then the pump stops", Math.abs(home.z - 16.84) < 1e-9 && after.every((f) => !f.pushed), `(z ${f3(home.z)})`);
}

console.log("D — the framing is ABSOLUTE: a speed zoom sweeping 15.80 → 13.65 under a held framing does not move it");
{
  const fzD = (t: number) => (t < 500 ? 15.8 : t > 12000 ? 13.65 : 15.8 + (13.65 - 15.8) * ((t - 500) / 11500));
  const s = surf(false, fzD, 15.8);
  const fr = run(s, 0, 16000, () => true, [0, 300, 600].map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) })));
  const held = fr.filter((f) => f.t >= 600 + CAR_ZOOM_STEP_MS && f.t < 600 + HOLD_MS);
  const drift = Math.max(...held.map((f) => Math.abs(f.z - 14.3)));
  ok("D1 held at 14.30 exactly while followZoom moves 15.80 → 13.65", drift < 1e-9, `(drift ${drift.toExponential(1)})`);
}

console.log("E — a press no longer snaps the pitch (nor, by the same branch, the heading lag)");
{
  const mk = (legacy: boolean) => { const s = surf(legacy, () => 16.5, 16.5, 45); s.pitchTarget = 52; return s; };
  const pNew = run(mk(false), -100, 600, () => true, [{ t: 0, fn: (x: Surf, tt: number) => press(x, tt, -0.5) }]);
  const pOld = run(mk(true), -100, 600, () => true, [{ t: 0, fn: (x: Surf, tt: number) => press(x, tt, -0.5) }]);
  const jmp = (fr: Frame[]) => Math.max(...fr.slice(1).map((f, i) => Math.abs(f.pitch - fr[i].pitch)));
  ok("E1 new: pitch keeps gliding through the press (≤ 0.2° per frame)", jmp(pNew) <= 0.2, `(max ${f2(jmp(pNew))}°/frame)`);
  ok("E2 NEGATIVE CONTROL today: the press snaps the pitch to its target in one frame", jmp(pOld) >= 5, `(max ${f2(jmp(pOld))}°/frame)`);
}

console.log("F — NEGATIVE CONTROL: today's code on the same presses");
{
  const s = surf(true, fz1, 16.02);
  let biasAt33 = NaN;
  const fr = run(s, -200, 4387 + HOLD_MS + 12000, () => true, [
    ...B1.map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) })),
    { t: 7147, fn: (x: Surf) => { biasAt33 = x.bias; } },
  ]);
  const s2 = surf(true, fz2, 16.13);
  const fr2 = run(s2, -200, 1500, () => true, B2.map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) })));
  const cutsOf = (f: Frame[], ps: number[]) => ps.map((p) => { const i = f.findIndex((g) => g.t >= p); return Math.abs(f[i].z - f[i - 1].z); });
  const c1 = cutsOf(fr, B1), c2 = cutsOf(fr2, B2);
  ok("F1 NEGATIVE CONTROL today: each press is a one-frame cut (burst 2: 0.50 each after the first)", c2.slice(1).every((c) => Math.abs(c - 0.5) < 0.02) && Math.max(...c1, ...c2) >= 0.5, `(burst 2 cuts ${c2.map(f2).join(" ")}; burst 1 cuts ${c1.map(f2).join(" ")} — the glide lag between presses eats part of each; field 09:41:36.523 16.13 → 15.63)`);
  const tgt = (t: number) => fz1(t) + biasAt33;   // today's target once the burst is in: followZoom − 3.00
  const undone = tgt(7147) - (fz1(0) - 3);
  ok("F2 today: slowing 58 → 33 km/h pulls the framing back in under the driver", undone > 0.5 && Math.abs(tgt(7147) - 13.65) < 0.02, `(target at 33 km/h ${f2(tgt(7147))} — field 09:36:23 zt=13.65; ${f2(undone)} of his 3.00 levels undone)`);
  const lapse = 4387 + HOLD_MS;
  const within = fr.find((f, i) => f.t >= lapse && fr.slice(i).every((g) => Math.abs(g.z - fz1(g.t)) <= 0.3));
  ok("F3 today: the way home crawls (> 5 s to within 0.3)", !!within && within.t - lapse > 5000, `(${within ? ((within.t - lapse) / 1000).toFixed(1) : "∞"} s; the investigation's glide replay: 9.0 s from −3)`);
  const par = surf(true, () => 16.84, 16.13);
  const frP = run(par, -200, HOLD_MS + 8000, () => false, B2.map((t) => ({ t, fn: (x: Surf, tt: number) => press(x, tt, -0.5) })));
  const stuck = frP.filter((f) => f.t > 537 + HOLD_MS && f.t < 537 + HOLD_MS + 5000).every((f) => Math.abs(f.z - (16.84 - 2)) < 1e-9);
  ok("F4 today: PARKED, the lapsed hold never comes home until the car moves", stuck, "(09-21: held 20 s, then a 3.5-level cut)");
}

console.log("G — Crew overview while STOPPED (unchanged coordinates, deadband-filtered fixes → no pose ease, no push)");
const crewRun = (legacy: boolean, evs: Ev[], moving: (t: number) => boolean, t1 = 20000, tickMs = 1000 / 30) => {
  const s = surf(legacy, () => 16.84, 16.84);
  const fr = run(s, 0, t1, moving, evs, 1000, tickMs);   // render ticks at 1 Hz (a store tick per deadband-filtered fix)
  return { s, fr };
};
{
  const tap = 1000;
  // Worst case clock: the parked pump at the 33 ms bgTick setInterval (30 Hz) — the CarPlay frame pump / rAF are faster.
  const a = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }], () => false);
  const fly = a.s.flies[0];
  ok("G1 a stopped car starts home at CREW_RETURN_MS after the tap (≤ one 30 Hz tick late)", a.s.flies.length === 1 && fly - (tap + CREW_RETURN_MS) >= 0 && fly - (tap + CREW_RETURN_MS) <= 1000 / 30 + 1e-6, `(fly at +${fly != null ? Math.round(fly - tap) : "never"} ms; RETURN_FLY_MS ${RETURN_FLY_MS})`);
  ok("G2 …and the pump does not spin afterwards (one push starts the fly)", a.fr.filter((f) => f.pushed).length === 0 && a.s.pushes === 0, `(pushes that reached setCamera: ${a.s.pushes}; the fly itself is the one camera move)`);
  const b = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }], (t) => t >= tap + CREW_RETURN_MS + 100);
  ok("G3 no double fly when the car pulls away during the parked fly", b.s.flies.length === 1, `(flies ${b.s.flies.length}; landed and following: returnFly=${b.s.returnFly})`);
  const c2 = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }], (t) => t >= tap + CREW_RETURN_MS - 10);
  ok("G4 no double fly when it pulls away just BEFORE the deadline (moving frames + parked tick race)", c2.s.flies.length === 1 && c2.s.flies[0] - (tap + CREW_RETURN_MS) <= 1000 / 30 + 1e-6, `(flies ${c2.s.flies.length} at +${Math.round(c2.s.flies[0] - tap)} ms)`);
  const d = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }, { t: tap + 5000, fn: (x, tt) => crewFit(x, tt, 9.3) }], () => false);
  ok("G5 a re-press re-arms the 7 s (home 7 s after the SECOND tap, once)", d.s.flies.length === 1 && d.s.flies[0] >= tap + 5000 + CREW_RETURN_MS && d.s.flies[0] - (tap + 5000 + CREW_RETURN_MS) <= 1000 / 30 + 1e-6, `(fly at +${Math.round(d.s.flies[0] - tap)} ms)`);
  const e = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }, { t: tap + 3000, fn: (x, tt) => press(x, tt, -0.5) }], () => false);
  const flyE = e.s.flies[0];
  ok("G6 a zoom press ends the overview at once, parked (home in ≤ one tick, once, onto the new framing)", e.s.flies.length === 1 && flyE - (tap + 3000) <= 1000 / 30 + 1e-6 && Math.abs(zAt(e.fr, tap + 3000 + RETURN_FLY_MS + 400) - (16.84 - 0.5)) < 1e-9, `(fly +${Math.round(flyE - tap - 3000)} ms after the press; framing ${f2(zAt(e.fr, tap + 3000 + RETURN_FLY_MS + 400))})`);
  // The edge consumed OUTSIDE a push (the AA re-assert / cold-start snap call getCam().padding): the armed fly must
  // still start while parked, and only once.
  const h = crewRun(false, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }, { t: tap + CREW_RETURN_MS - 5, fn: (x, tt) => { x.camHoldUntil = 0; getCam(x, tt); } }], () => false);
  ok("G8 an edge consumed by a non-push getCam still flies home while parked, once", h.s.flies.length === 1 && h.s.flies[0] - (tap + CREW_RETURN_MS - 5) <= 1000 / 30 + 1e-6, `(fly +${Math.round(h.s.flies[0] - (tap + CREW_RETURN_MS - 5))} ms after the re-assert)`);
  const neg = crewRun(true, [{ t: tap, fn: (x, tt) => crewFit(x, tt, 9.1) }], (t) => t >= tap + 23750, tap + 26000);
  ok("G7 NEGATIVE CONTROL today: stopped, the overview holds until the car moves (09-20: +23.75 s)", neg.s.flies.length === 1 && neg.s.flies[0] >= tap + 23750, `(fly at +${Math.round(neg.s.flies[0] - tap)} ms)`);
}

console.log("H — the receipt gate (≤ 1 row per 2 s, the burst's last row kept)");
{
  const st = newCarZoomLog(); const out: [number, string][] = [];
  const put = (t: number, r: string | null) => { const o = carZoomLogGate(st, t, r); if (o) out.push([t, o]); };
  for (let i = 0; i < 10; i++) put(T0 + i * 100, `row${i}`);
  for (let t = 1000; t < 5000; t += 33) put(T0 + t, null);
  ok("H1 ten presses in 1 s → two rows: the first, and the last once 2 s have passed", out.length === 2 && out[0][1] === "row0 n=1" && out[1][1] === "row9 n=9" && out[1][0] - T0 >= CAR_ZOOM_LOG_MS, `(${out.map(([t, r]) => `${t - T0}ms ${r}`).join(" | ")})`);
}

console.log("S — static: the real glue has the shape replicated above");
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
  ok("S3 a real pinch still calls the INSTANT path (1:1 with the fingers)", /applyZoomNow\(\)/.test(pinch));
  const eased = code(between(cmv, "const applyZoomEased = (", "\n  };"));
  ok("S4 the eased entry sets no zoomSnapRef and calls no setCamera (pushCam is the one writer)", eased.length > 0 && !/zoomSnapRef/.test(eased) && !/setCamera/.test(eased));
  const blk = code(between(mbx, "const zoomCh = c.zoomCh;", "// Publish the zoom the camera is ACTUALLY at."));
  ok("S5 pushCam's ease block moves ZOOM only (no camPitch, no camHdgLag)", /carZoomApply\(zoomCh, now, c\.zoomLevel\)/.test(blk) && !/camPitch|camHdgLag/.test(blk));
  const gp = code(between(mbx, "const camGlidePending = (): boolean => {", "return !glideSettled("));
  ok("S6 the parked pump asks camJob BEFORE the automatic-glide ship switch", gp.indexOf("camJob()") >= 0 && gp.indexOf("camJob()") < gp.indexOf("CAM_GLIDE_PUMP_ENABLED"));
  const bg = code(between(mbx, "const bgTick = () => {", "const startBgTimer"));
  const stp = code(between(mbx, "const step = () => {", "a.stepped = true;"));
  ok("S7 the parked branches that pump exist: bgTick and step push while camGlidePending()", /if \(!a\) \{\s*if \(camGlidePending\(\)\) pushCam\(/.test(bg) && /if \(camGlidePending\(\)\) \{[\s\S]*?pushCam\(render\.current\.lat/.test(stp));
  ok("S8 CarMapView wires it: camJob={carCamJob}, getCam returns zoomCh, the crew edge is crewReturnEdge", /camJob=\{carCamJob\}/.test(cmv) && /zoomCh: zoomChRef\.current/.test(cmv) && /crewReturnEdge\(camHoldWasActiveRef\.current, crewOverviewRef\.current/.test(cmv));
  const job = code(between(cmv, "const carCamJob = useRef(", "}).current;"));
  ok("S9 carCamJob re-arms the lockstep on a due crew hold, owes an armed fly, and never answers yes while it cannot push", /crewReturnDue\(/.test(job) && /lockReadyRef\.current = true/.test(job) && /if \(!lockReadyRef\.current\) return false;/.test(job) && /const flyArmed = returnFlyRef\.current === -1;/.test(job) && /\(crewDue \|\| flyArmed\) && !lockReadyRef\.current/.test(job));
  const clears = (a: string, b: string) => { const t = code(between(cmv, a, b)); return /manualZoomRef\.current = null/.test(t) && /zoomChRef\.current\.ease = null/.test(t); };
  ok("S10 recenter, compass, Crew and the AA re-assert clear the framing and the ease", clears("case 'recenter':", "case 'compass':") && clears("case 'compass': {", "case 'crewFit': {") && clears("case 'crewFit': {", "setCarState({ crewViewUntil") && clears("const reassertAaFollow = (", "const now = Date.now();"));
  ok("S11 src/carZoomStep.ts is pure (no imports at all)", !/^\s*import\s/m.test(czs));
  ok("S12 pushCam re-arms a due crew hold before its readiness bail (a moving car comes home on the first frame)", /if \(camJob && !\(readyRef\?\.current\)\) camJob\(\);\s*\n\s*if \(!cameraRef\?\.current \|\| !getCam \|\| !\(readyRef\?\.current\)\) return;/.test(mbx));
}

console.log(fails ? `FAIL car_zoom_step (${fails})` : "PASS car_zoom_step");
process.exit(fails ? 1 : 0);
