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
  ok("S10 carCamJob: nothing while a fly is in flight; lands a fly the moment its time is up (a seed never outlives its fly); re-arms the lockstep for a due crew hold or an armed fly; never yes when it cannot push", /if \(returnFlyRef\.current > 0 && now < returnFlyRef\.current \+ RETURN_FLY_GRACE_MS\) return false;/.test(job) && /const landingDue = returnFlyRef\.current > 0 && now >= returnFlyRef\.current \+ RETURN_FLY_GRACE_MS;/.test(job) && /crewDue \|\| flyArmed \|\| landingDue \|\|/.test(job) && /const flyArmed = returnFlyRef\.current < 0;/.test(job) && /\(crewDue \|\| flyArmed\) && !lockReadyRef\.current/.test(job) && /if \(!lockReadyRef\.current\) return false;/.test(job));
  const gc = code(between(cmv, "const edge = crewReturnEdge(", "crewOverviewRef.current = edge.overview;"));
  ok("S11 getCam: the fly carries the zoom (drops the ease); inside crewFit's easeTo the return is a short fly", /if \(edge\.fly\) \{ returnFlyRef\.current = -1; zoomChRef\.current\.ease = null; \}/.test(gc) && /nowC < crewEaseUntilRef\.current\) \{ returnFlyRef\.current = -CAR_ZOOM_STEP_MS; zoomChRef\.current\.ease = null; \}/.test(gc));
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
  const pure = ["carZoomStep", "crewReturn", "returnFly"].map((m) => readFileSync(new URL(`../../src/${m}.ts`, import.meta.url), "utf8"));
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
  ok("S15 pushCam re-arms a due crew hold before its readiness bail (a moving car comes home on the first frame)", /if \(camJob && !\(readyRef\?\.current\)\) camJob\(\);\s*\n\s*if \(!cameraRef\?\.current \|\| !getCam \|\| !\(readyRef\?\.current\)\) return;/.test(mbx));
}

console.log(fails ? `FAIL car_zoom_step (${fails})` : "PASS car_zoom_step");
process.exit(fails ? 1 : 0);
