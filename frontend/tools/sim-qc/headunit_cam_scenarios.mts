// headunit_cam_scenarios — every head-unit camera scenario of the 2026-09-25 zoom / Crew work, run through the
// PRODUCTION coordination code (headunit_cam_harness.mts). Returned as results so car_zoom_step_test.mts gates them and a
// scratch run can replay an older revision as a negative control.
//
// Jeff, 2026-09-25: "the carplay zoomout seems like its capped at a distance and is not smooth" → "It creeps back in" →
// each press animates in about 0.3 s, the map stays exactly where he put it during the hold, eases home in about 1 s.
// Plus the Crew overview's 7 s way home while STOPPED (Codex [high] on f6f9e99e) and the round-2 review of 25ad00e1
// (a press during the return fly; a press within 500 ms of Crew; pinch takeover; a followZoom step mid-release).
import { makeHeadUnit, type Src } from "./headunit_cam_harness.mts";

export type Result = { id: string; name: string; pass: boolean; detail: string };

/** The press smoothness bar: no vsync-to-vsync zoom change above this during a +/- ease (0.5 per press). */
export const STEP_BAR = 0.06;
/** A one-frame zoom change above this is a CUT. Native flies and the crew easeTo in these scenarios stay below it
 *  (the harness's native fly is a smoothstep over its duration); every cut the review found was ≥ 0.24. */
export const CUT = 0.2;
/** One 60 Hz vsync: a push made at vsync k is on screen at vsync k + 1 (the harness records the frame first). */
const VS = 1000 / 60;

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
type HU = ReturnType<typeof makeHeadUnit>;
const hAt = (h: HU, t: number) => { if (t > h.now) h.advance(t - h.now); };
const hPark = (h: HU) => { h.setMoving(false); h.advance(1500); return h; };
const hFlies = (h: HU, from = 0) => h.rows(/cam-return-fly surf=car/).filter((r) => r.t >= from);
const angOff = (a: number, b: number) => { const d = (((a - b) % 360) + 540) % 360 - 180; return Math.abs(d); };
/** The native animations the camera owner starts, whose END a gesture can straddle (TL, DL). */
type TAnchor = "crewFit's easeTo" | "a fly started inside the easeTo" | "a re-aimed fly" | "the 7 s return";
const T_ANCHORS: TAnchor[] = ["crewFit's easeTo", "a fly started inside the easeTo", "a re-aimed fly", "the 7 s return"];
/** Every gesture that writes the camera, with the independent framing it must end on (16.8 · pitch 45 · heading 90). */
const TG: { key: string; act: (h: HU) => void; z: number; hdg: number }[] = [
  { key: "recenter", act: (h) => h.gesture({ kind: "recenter" }), z: 16.8, hdg: 90 },
  { key: "compass", act: (h) => h.gesture({ kind: "compass" }), z: 16.8, hdg: 0 },
  { key: "pinch (begin · scale 1 · end)", act: (h) => { h.gesture({ kind: "zoomBegin" }); h.gesture({ kind: "zoom", scale: 1, velocity: 0 }); h.gesture({ kind: "zoomEnd" }); }, z: 16.8, hdg: 90 },
  { key: "+ press", act: (h) => h.press(0.5), z: 16.8, hdg: 90 },
  { key: "− press", act: (h) => h.press(-0.5), z: 16.8, hdg: 90 },
  { key: "AppState re-assert", act: (h) => h.reassert(), z: 16.8, hdg: 90 },
  { key: "relayout (→ 17.8)", act: (h) => h.relayout(17.8), z: 17.8, hdg: 90 },
];
/** Crew tapped at now + 100, then the anchor animation set up; returns its JS end (harness ms) — NaN when this crew has
 *  no such animation — and the tap time. */
const tlSetup = (h: HU, anchor: TAnchor): number => {
  const off = h.abs - h.now, C = h.C;
  const tap = h.now + 100; hAt(h, tap); h.crew();
  if (anchor === "crewFit's easeTo") return C.crewEaseUntilRef.current - off;
  if (anchor === "the 7 s return") {
    hAt(h, tap + 7000 + 40);
    return C.returnFlyRef.current > 0 ? C.returnFlyRef.current - off : C.camHoldWasActiveRef.current ? NaN : tap + 7000;
  }
  hAt(h, tap + 300); h.gesture({ kind: "recenter" }); hAt(h, tap + 340);
  if (anchor === "a fly started inside the easeTo") return C.returnFlyRef.current > 0 ? C.returnFlyRef.current - off : NaN;
  const f0 = hFlies(h, tap)[0]; if (!f0) return NaN;
  hAt(h, f0.t + 100); h.press(0.5); hAt(h, h.now + 40);
  return C.returnFlyRef.current > 0 ? C.returnFlyRef.current - off : NaN;
};
/** Something owns the camera right now (the owner's framing is legitimately not on screen): a fly armed / flying /
 *  landing, a JS ease, a Crew overview, a pinch, or a native animation still running. */
const ownerBusy = (h: HU) => { const C = h.C; return !!C.zoomChRef.current.ease || C.returnFlyRef.current !== 0 || C.camHoldWasActiveRef.current || C.pinchActiveRef.current || h.animating; };
/** Camera vs the owner's framing: zoom = carZoomDest, pitch = followPitch, heading = the north-up override or the car's. */
const ownerOff = (h: HU, src: Src) => {
  const C = h.C, fz = C.camInputsRef.current.followZoom, fp = C.camInputsRef.current.followPitch;
  const wz = src.mods.carZoomDest(C.manualZoomRef.current, fz, C.userZoomRef.current, 10.5, 20);
  const wh = C.camHdgOverrideRef.current ?? C.drawHdgRef.current;
  const off = Math.abs(h.cam.zoom - wz) > 0.02 || Math.abs(h.cam.pitch - fp) > 0.5 || angOff(h.cam.heading, wh) > 0.5;
  return off ? `camera ${f3(h.cam.zoom)}/${h.cam.pitch.toFixed(1)}/${h.cam.heading.toFixed(1)} vs owner ${f3(wz)}/${fp}/${wh}` : "";
};
// Field speed zooms (src/chaseZoom.ts chaseZoomForSpeed): 58 km/h 15.78 · 40 km/h 16.43 · 33 km/h 16.65 · 26 km/h 16.84.
export function runScenarios(src: Src, chaseZoomForSpeed: (kmh: number) => number): Result[] {
  const R: Result[] = [];
  const ok = (id: string, name: string, pass: boolean, detail = "") => { R.push({ id, name, pass, detail }); };
  const all: ReturnType<typeof makeHeadUnit>[] = [];
  const unit = (o: Parameters<typeof makeHeadUnit>[1] = {}) => { const h = makeHeadUnit(src, { followZoom: 16.8, ...o }); all.push(h); return h; };
  const park = (h: ReturnType<typeof makeHeadUnit>) => { h.setMoving(false); h.advance(1500); return h; };
  const at = (h: ReturnType<typeof makeHeadUnit>, t: number) => { if (t > h.now) h.advance(t - h.now); };
  const flies = (h: ReturnType<typeof makeHeadUnit>, from = 0) => h.rows(/cam-return-fly surf=car/).filter((r) => r.t >= from);
  const lapse = src.lock.files["src/carplay/CarMapView.tsx"].locked.CAR_ZOOM_HOLD_MS * 1;
  const B1 = [0, 822, 1619, 2419, 3085, 4387], B2 = [0, 213, 382, 537];

  // ── A: burst 1 (09-25 09:36:16.246 …, 58 → 33 km/h), MOVING ────────────────────────────────────────────────────
  {
    const kmh = (u: number) => (u <= 0 ? 58 : u >= 7147 ? Math.max(31, 33 - (u - 7147) / 7625) : 58 + (33 - 58) * (u / 7147));
    const h = unit({ followZoom: chaseZoomForSpeed(58), renderMs: 83 });
    const t0 = h.now + 500;
    h.followZoomAt((t) => chaseZoomForSpeed(kmh(t - t0)));
    at(h, t0 - 1);
    const start = h.cam.zoom;
    for (const p of B1) { at(h, t0 + p); h.press(-0.5); }
    const last = t0 + B1[B1.length - 1];
    const framing = h.C.manualZoomRef.current;
    at(h, last + lapse + 4000);
    const st = h.maxStep(t0 - 100, last + 400);
    ok("A1", "burst 1 moving: no vsync zoom change above 0.06", st.m <= STEP_BAR, `(max ${f3(st.m)})`);
    ok("A2", "six presses = exactly 3.0 levels from what was on screen", Math.abs(framing - (start - 3)) < 1e-9, `(${f3(start)} → ${f3(framing)})`);
    const landF = h.frames.find((f) => f.t >= last + 280 + VS)!;
    ok("A3", "the last press lands on its framing within CAR_ZOOM_STEP_MS (+ one vsync)", Math.abs(landF.zoom - framing) < 1e-9, `(z ${f3(landF.zoom)} at +${Math.round(landF.t - last)} ms)`);
    const held = h.frames.filter((f) => f.t >= last + 300 && f.t < last + lapse);
    const drift = Math.max(...held.map((f) => Math.abs(f.zoom - framing)));
    ok("A4", "the framing holds exactly while the speed zoom moves (58 → 31 km/h)", drift < 1e-9, `(drift ${drift.toExponential(1)}; followZoom ${f3(chaseZoomForSpeed(58))} → ${f3(chaseZoomForSpeed(31))})`);
    const L = last + lapse;
    const fzL = (t: number) => chaseZoomForSpeed(kmh(t - t0));
    const home = h.frames.find((f, i) => f.t >= L && h.frames.slice(i).every((g) => g.t > L + 3000 || Math.abs(g.zoom - fzL(g.t)) <= 0.1));
    ok("A5", "after the 15 s hold it eases home within 0.1 of the live speed zoom in ≤ 1.4 s", !!home && home.t - L <= 1400, `(${home ? Math.round(home.t - L) : "never"} ms)`);
    const i0 = h.frames.findIndex((f) => f.t >= L + 1), rel = h.maxStep(L - 20, L + 1400);
    // The release is an ease-in-out: its own peak is 1.5 × distance / 1.2 s. Nothing may exceed that curve (+ the
    // target's 0.5 level/s follow) — a cut would; a 3.9-level release honestly peaks at ~0.082 per vsync.
    const peak = (1.5 * Math.abs(fzL(L) - framing) / 1200 + 0.5 / 1000) * VS + 0.002;
    ok("A6", "the release starts from rest and never exceeds its own ease-in-out curve (no cut)", Math.abs(h.frames[i0 + 1].zoom - h.frames[i0].zoom) < 0.01 && rel.m <= peak, `(max vsync step ${f3(rel.m)} ≤ curve peak ${f3(peak)} — ${f3(fzL(L) - framing)} levels in 1.2 s)`);
    const rows = h.rows(/car-zoom op=/);
    const gaps = rows.map((r, i) => (i ? r.t - rows[i - 1].t : Infinity));
    ok("A7", "car-zoom receipt: ≤ 1 row / 2 s, the burst's last press on record, the release on record", gaps.every((g) => g >= 2000) && rows.some((r) => new RegExp(`to=${framing.toFixed(2)}`).test(r.row)) && rows.some((r) => /op=release/.test(r.row)), `(${rows.length} rows)`);
    const sz = h.maxSizeLag(t0 - 100, last + 400);
    ok("A8", "the self car is sized for the zoom on screen through every press (no size pop)", sz.m <= 0.07, `(max size-vs-screen zoom gap ${f3(sz.m)} at a vsync)`);
  }

  // ── B/C: burst 2 (09:41:36.259 …, 4 presses in 0.54 s), moving and PARKED ───────────────────────────────────────
  for (const mode of ["moving", "parked"] as const) {
    const h = unit({ followZoom: chaseZoomForSpeed(40) });
    if (mode === "parked") park(h);
    const t0 = h.now + 200;
    at(h, t0 - 1);
    const start = h.cam.zoom;
    const M = src.mods;
    const reaim: { jump: number; dv: number }[] = [];
    for (const p of B2) {
      at(h, t0 + p);
      const C = h.C, zc = C.zoomChRef.current, now = h.abs;
      const fz = C.camInputsRef.current.followZoom, dest = M.carZoomDest(C.manualZoomRef.current, fz, C.userZoomRef.current, 10.5, 20);
      const before = zc.ease ? M.carZoomEaseAt(zc.ease, now, dest) : NaN, vB = zc.ease && !M.carZoomEaseDone(zc.ease, now) ? M.carZoomEaseVel(zc.ease, now, dest) : 0;
      h.press(-0.5);
      if (Number.isFinite(before)) reaim.push({ jump: Math.abs(zc.ease.from - before), dv: Math.abs(zc.ease.v0 - vB) });
    }
    const last = t0 + B2[3];
    at(h, last + 1500);
    const id = mode === "moving" ? "B" : "C";
    const st = h.maxStep(t0 - 50, last + 400);
    ok(`${id}1`, `burst 2 ${mode}: no vsync zoom change above 0.06`, st.m <= STEP_BAR, `(max ${f3(st.m)})`);
    ok(`${id}2`, `burst 2 ${mode}: every re-aim starts where the running ease is, at the speed it had`, reaim.length === 3 && reaim.every((r) => r.jump < 1e-12 && r.dv < 1e-12), `(max jump ${f3(Math.max(...reaim.map((r) => r.jump)))})`);
    const land = h.frames.find((f) => f.t >= last + 280 + VS)!;
    ok(`${id}3`, `burst 2 ${mode}: exactly 2.0 levels, landed CAR_ZOOM_STEP_MS after the last press`, Math.abs(land.zoom - (start - 2)) < 1e-9, `(${f3(start)} → ${f3(land.zoom)})`);
    const sz = h.maxSizeLag(t0 - 50, last + 400);
    ok(`${id}4`, `burst 2 ${mode}: the self car keeps its on-screen size (no pop)`, sz.m <= 0.07, `(max gap ${f3(sz.m)})`);
    if (mode === "parked") {
      const n0 = h.counts.noteCam; at(h, last + lapse - 50); const n1 = h.counts.noteCam;
      ok("C5", "parked: the pump stops once the press lands (no pushes through the hold)", n1 === n0, `(${n1 - n0} pushes)`);
      at(h, last + lapse + 60);
      const moved = h.frames.find((f) => f.t > last + lapse && Math.abs(f.zoom - (start - 2)) > 1e-9);
      ok("C6", "parked: the hold's lapse is caught on the next tick (no fix, no render needed)", !!moved && moved.t - (last + lapse) <= 40, `(${moved ? Math.round(moved.t - (last + lapse)) : "never"} ms)`);
      at(h, last + lapse + 3000);
      const n2 = h.counts.noteCam; at(h, last + lapse + 5000);
      ok("C7", "parked: eased home to the speed zoom, then the pump stops", Math.abs(h.cam.zoom - chaseZoomForSpeed(40)) < 1e-9 && h.counts.noteCam === n2, `(z ${f3(h.cam.zoom)})`);
    }
  }

  // ── D: the framing is ABSOLUTE — a speed zoom sweeping 15.80 → 13.65 under it does not move it ───────────────
  {
    const h = unit({ followZoom: 15.8, renderMs: 83 });
    const t0 = h.now + 200;
    h.followZoomAt((t) => (t < t0 + 500 ? 15.8 : t > t0 + 12000 ? 13.65 : 15.8 + (13.65 - 15.8) * ((t - t0 - 500) / 11500)));
    for (const p of [0, 300, 600]) { at(h, t0 + p); h.press(-0.5); }
    const framing = h.C.manualZoomRef.current;
    at(h, t0 + 600 + lapse - 10);
    const held = h.frames.filter((f) => f.t >= t0 + 600 + 300);
    const drift = Math.max(...held.map((f) => Math.abs(f.zoom - framing)));
    ok("D1", "held exactly while followZoom moves 15.80 → 13.65 (the corner/roundabout zoom-in is suspended too)", drift < 1e-9, `(framing ${f3(framing)}, drift ${drift.toExponential(1)})`);
  }

  // ── E: a press eases ZOOM only — the camera pitch keeps gliding through it (no snap) ──────────────────────────
  {
    const h = unit({ followZoom: 16.8, followPitch: 45 });
    const t0 = h.now + 100;
    h.C.camInputsRef.current = { ...h.C.camInputsRef.current, followPitch: 55 };   // pitch mid-glide 45 → 55
    at(h, t0); h.press(-0.5); at(h, t0 + 400);
    const fr = h.frames.filter((f) => f.t >= t0 - 50 && f.t <= t0 + 400);
    const jump = Math.max(...fr.slice(1).map((f, i) => Math.abs(f.pitch - fr[i].pitch)));
    ok("E1", "the press does not snap the pitch (it keeps gliding, ≤ 0.2° per vsync)", jump <= 0.2, `(max ${f3(jump)}°/vsync)`);
  }

  // ── G: Crew overview while STOPPED (deadband-filtered fixes → no pose ease), and the double-fly races ──────────
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew();
    at(h, tap + 7000 + 500);
    const f = flies(h, tap);
    ok("G1", "stopped: the Crew overview starts home at 7 s (≤ one vsync late)", f.length === 1 && f[0].t - (tap + 7000) >= 0 && f[0].t - (tap + 7000) <= 17, `(fly at +${f[0] ? f[0].t - tap : "never"} ms)`);
    const n0 = h.counts.noteCam; at(h, tap + 7000 + 1700);
    ok("G2", "…and nothing pushes during the fly (no 60 Hz no-op pushes)", h.counts.noteCam === n0, `(${h.counts.noteCam - n0} pushes)`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7100); h.setMoving(true); at(h, tap + 12000);
    ok("G3", "no double fly when the car pulls away during the parked fly", flies(h, tap).length === 1, `(flies ${flies(h, tap).length})`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 6990); h.setMoving(true); at(h, tap + 12000);
    const f = flies(h, tap);
    ok("G4", "no double fly when it pulls away just BEFORE the deadline", f.length === 1 && f[0].t - (tap + 7000) <= 17, `(flies ${f.length}, first at +${f[0] ? f[0].t - tap : "-"} ms)`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 5000); h.crew(); at(h, tap + 14000);
    const f = flies(h, tap);
    ok("G5", "a re-press re-arms the 7 s (home 7 s after the second tap, once)", f.length === 1 && f[0].t - (tap + 12000) >= 0 && f[0].t - (tap + 12000) <= 17, `(fly at +${f[0] ? f[0].t - tap : "never"} ms)`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 3000); h.press(-0.5); const tp = h.now; at(h, tp + 3000);
    const f = flies(h, tap);
    ok("G6", "a zoom press ends the overview at once, parked, and flies home once onto the new framing", f.length === 1 && f[0].t - tp <= 17 && Math.abs(h.cam.zoom - 16.3) < 1e-6, `(fly +${f[0] ? f[0].t - tp : "-"} ms after the press; z ${f3(h.cam.zoom)})`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 6995); h.reassert(); const tr = h.now; at(h, tr + 3000);
    const f = flies(h, tap);
    ok("G7", "an edge consumed by a non-push getCam (the AppState re-assert) still flies home at once, once", f.length === 1 && f[0].t - tr <= 17, `(fly +${f[0] ? f[0].t - tr : "never"} ms after the re-assert)`);
  }

  // ── P: a +/- press DURING the 1.8 s Crew return fly (review of 25ad00e1: nothing, then a cut of up to 4 levels) ───
  const flyPress = (id: string, name: string, o: { android?: boolean; moving?: boolean; intoFly: number[]; delta: number; want: number }) => {
    const h = unit({ android: o.android });
    if (!o.moving) park(h);
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7000 + 40);
    const f0 = flies(h, tap)[0];
    if (!f0) { ok(id, name, false, "(the return fly never started)"); return; }
    const presses: number[] = [];
    for (const d of o.intoFly) { at(h, f0.t + d); h.press(o.delta); presses.push(h.now); }
    const n0 = h.counts.noteCam, s0 = h.counts.setNone + h.counts.setFly;
    at(h, presses[presses.length - 1] + 2600);
    const answered = presses.every((p) => flies(h, p).some((r) => r.t - p <= 17));
    const cut = h.maxStep(presses[0] + 20, h.now);
    const noops = (h.counts.noteCam - n0) - (h.counts.setNone + h.counts.setFly - s0);
    const done = Math.abs(h.cam.zoom - o.want) < 1e-6;
    ok(id, name, answered && cut.m <= CUT && done && (o.moving || noops === 0),
      `(re-aimed within a vsync: ${answered ? "yes" : "NO"}; max vsync step after ${f3(cut.m)} at +${Math.round(cut.at - presses[0])} ms; lands ${f3(h.cam.zoom)} want ${f3(o.want)}; no-op pushes ${noops})`);
  };
  flyPress("P1", "'+' 100 ms into the parked return fly: answers at once, no touchdown cut, ends at chase + 0.5 (never OUT)", { intoFly: [100], delta: 0.5, want: 17.3 });
  flyPress("P2", "'−' 100 ms into the parked return fly → chase − 0.5", { intoFly: [100], delta: -0.5, want: 16.3 });
  flyPress("P3", "'+' 900 ms into the parked return fly → chase + 0.5", { intoFly: [900], delta: 0.5, want: 17.3 });
  flyPress("P4", "Jeff's 09-25 burst (4 × '−' in 0.54 s) during the fly accumulates: chase − 2.0, no cut", { intoFly: [100, 313, 482, 637], delta: -0.5, want: 14.8 });
  flyPress("P5", "the same '+' while MOVING", { moving: true, intoFly: [100], delta: 0.5, want: 17.3 });
  flyPress("P6", "the same '+' on ANDROID AUTO semantics ('none' cancels animations)", { android: true, intoFly: [100], delta: 0.5, want: 17.3 });
  {
    // P7: the burst begins 3 s into the overview — the first press ends it (the fly), the rest land in the fly.
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew();
    for (const p of B2) { at(h, tap + 3000 + p); h.press(-0.5); }
    at(h, tap + 3000 + 537 + 2600);
    const cut = h.maxStep(tap + 3000 + 20, h.now);
    ok("P7", "the 09-25 burst starting 3 s into a Crew overview: home onto chase − 2.0, no cut", cut.m <= CUT && Math.abs(h.cam.zoom - 14.8) < 1e-6, `(max vsync step ${f3(cut.m)}; z ${f3(h.cam.zoom)})`);
  }
  {
    const h = park(unit());
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7000 + 1800 + 500);
    const tp = h.now; h.press(0.5); at(h, tp + 800);
    const st = h.maxStep(tp, tp + 800);
    ok("P8", "control: '+' after the fly landed eases normally (≤ 0.06 per vsync) onto chase + 0.5", st.m <= STEP_BAR && Math.abs(h.cam.zoom - 17.3) < 1e-6, `(max ${f3(st.m)}; z ${f3(h.cam.zoom)})`);
  }

  for (const moving of [false, true]) {
    // P9: after a press re-aimed the fly, the 15 s hold lapses — parked, the fly's landing push is still pending then.
    const h = unit();
    if (!moving) park(h);
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7040);
    const f0 = flies(h, tap)[0];
    if (!f0) { ok(`P9${moving ? "m" : ""}`, "hold lapse after a re-aimed fly", false, "(no fly)"); continue; }
    at(h, f0.t + 100); h.press(0.5); const tp = h.now;
    at(h, tp + lapse + 3000);
    const cut = h.maxStep(tp + 20, h.now);
    ok(`P9${moving ? "m" : ""}`, `after a re-aimed fly the 15 s hold eases home without a cut (${moving ? "moving" : "parked"})`, cut.m <= CUT && Math.abs(h.cam.zoom - 16.8) < 1e-6 && flies(h, tap).length === 2, `(max vsync step ${f3(cut.m)}; z ${f3(h.cam.zoom)}; flies ${flies(h, tap).length})`);
  }

  // ── Q: a press within 500 ms of a Crew tap, MOVING (review: eased from the fit TARGET — cuts of 0.7–6.7 levels) ─
  for (const [id, peers, dt] of [["Q1", "spread", 100], ["Q2", "spread", 300], ["Q3", "solo", 150], ["Q4", "solo", 400]] as const) {
    for (const android of [false, true]) {
      const h = unit({ android });
      if (peers === "solo") h.C.__peers = [];
      const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + dt); h.press(-0.5); const tp = h.now; at(h, tp + 2500);
      const cut = h.maxStep(tp + 20, tp + 2500);
      ok(`${id}${android ? "a" : ""}`, `press ${dt} ms after Crew (${peers} crew, moving${android ? ", Android" : ""}): no cut, onto chase − 0.5`, cut.m <= CUT && Math.abs(h.cam.zoom - 16.3) < 1e-6, `(max vsync step after the press ${f3(cut.m)} at +${Math.round(cut.at - tp)} ms; z ${f3(h.cam.zoom)})`);
    }
  }

  // ── K: a pinch taking over mid-ease / mid-release — its first (scale ≈ 1) update must not jump ──────────────────
  const pinch = (id: string, name: string, moving: boolean, when: "ease" | "release") => {
    const h = unit();
    if (!moving) park(h);
    // mid-ease: one press (its ease moves ≤ 0.06/vsync, so any jump shows); mid-release: two (a longer way home)
    const t0 = h.now + 100; at(h, t0); h.press(-0.5); if (when === "release") h.press(-0.5);
    const tb = when === "ease" ? t0 + 120 : t0 + lapse + 500;
    at(h, tb);
    const z0 = h.cam.zoom;
    h.gesture({ kind: "zoomBegin" }); h.gesture({ kind: "zoom", scale: 1.0, velocity: 0 });
    at(h, tb + 400);
    const st = h.maxStep(tb + 1, tb + 400);   // from the pinch on (the button ease before it is A/B's business)
    ok(id, name, st.m <= 0.08 && Math.abs(h.cam.zoom - z0) <= 0.08, `(visible ${f3(z0)} → ${f3(h.cam.zoom)}; max vsync step after the pinch ${f3(st.m)})`);
  };
  pinch("K1", "pinch takeover mid button-ease (parked): the scale=1 update keeps the visible zoom", false, "ease");
  pinch("K2", "pinch takeover mid button-ease (moving)", true, "ease");
  pinch("K3", "pinch takeover mid-release (parked): no jump to the full follow zoom", false, "release");
  pinch("K4", "pinch takeover mid-release (moving)", true, "release");

  // ── W: a followZoom STEP during the 1.2 s release (review: passed straight through as a one-frame cut) ─────────
  for (const [id, into, from, to, moving] of [["W1", 600, 17.0, 16.43, true], ["W2", 900, 17.0, 16.43, true], ["W3", 1100, 17.0, 16.43, true], ["W4", 700, 14.8, 17.0, false]] as const) {
    const h = unit({ followZoom: from });
    if (!moving) park(h);
    const t0 = h.now + 100; at(h, t0); h.press(-0.5);
    const L = t0 + lapse;
    at(h, L + into); h.setFollowZoom(to);
    at(h, L + 6000);
    const st = h.maxStep(L - 20, L + 6000);
    ok(id, `followZoom ${from} → ${to} ${into} ms into the release (${moving ? "moving" : "parked — nav start"}): no cut, lands on it`, st.m <= 0.08 && Math.abs(h.cam.zoom - to) < 0.26, `(max vsync step ${f3(st.m)}; z ${f3(h.cam.zoom)})`);
  }

  // ── X: EVERY gesture that can start while a native animation owns the camera (Codex second pass, 2026-09-25) ─────
  // Contexts: 300 ms into the Crew return FLY; 300 ms after a '+' RE-AIMED it; 200 ms into crewFit's own 600 ms EASE.
  // Each gesture, iOS and Android, parked (then the car pulls away). Asserted: it takes effect within one vsync (the
  // camera owner flies / crewFit eases); no cut above X_CUT (a zoom change no native animation made); no fly or
  // landing state left stale; the parked pump stops; pulling away lands on the right framing without a cut.
  const X_CUT = 0.12;
  type Ctx = "fly" | "reaimed" | "crewEase";
  type Gest = { key: string; act: (h: ReturnType<typeof makeHeadUnit>) => void; effect: "owner" | "crew" | "auto";
    want: (ctx: Ctx, zg: number) => number | null; fz0?: number; settle?: number; recover?: (ctx: Ctx) => number };
  const FZ = 16.8;
  // A pinch frames what is on screen, within the (value-locked) press limit: followZoom ± 4, floor 10.5 (clampBias).
  const pinchFrame = (z: number) => FZ + Math.max(Math.max(-4, 10.5 - FZ), Math.min(Math.min(4, 20 - FZ), z - FZ));
  const G: Gest[] = [
    { key: "pinch (begin · scale 1 · end)", effect: "owner", want: (_c, zg) => pinchFrame(zg),
      act: (h) => { h.gesture({ kind: "zoomBegin" }); h.gesture({ kind: "zoom", scale: 1, velocity: 0 }); h.gesture({ kind: "zoomEnd" }); } },
    { key: "pinch out-in (begin · scale 1.3)", effect: "owner", want: (_c, zg) => pinchFrame(pinchFrame(zg) + Math.log2(1.3)),
      act: (h) => { h.gesture({ kind: "zoomBegin" }); h.gesture({ kind: "zoom", scale: 1.3, velocity: 0 }); } },
    { key: "tap-zoom in (double tap)", effect: "owner", want: (c) => (c === "reaimed" ? FZ + 0.5 : FZ) + 1,
      act: (h) => h.gesture({ kind: "zoom", scale: 1, velocity: 1 }) },
    { key: "+ press", effect: "owner", want: (c) => (c === "reaimed" ? FZ + 0.5 : FZ) + 0.5, act: (h) => h.press(0.5) },
    { key: "− press", effect: "owner", want: (c) => (c === "reaimed" ? FZ + 0.5 : FZ) - 0.5, act: (h) => h.press(-0.5) },
    { key: "recenter", effect: "owner", want: () => FZ, act: (h) => h.gesture({ kind: "recenter" }) },
    { key: "compass", effect: "owner", want: () => FZ, act: (h) => h.gesture({ kind: "compass" }) },
    { key: "AppState re-assert", effect: "owner", want: () => FZ, act: (h) => h.reassert() },
    { key: "Crew re-press", effect: "crew", want: () => FZ, act: (h) => h.crew(), settle: 7000 + 1800 + 800 },
    // Automatic framing: the new speed zoom is reached by the locked glide once the car moves — 2.2 levels at 0.5 level/s,
    // then its 1.4 s low-pass; it rests within the 0.25 dead-band of the target.
    { key: "nav start (followZoom 14.6 → 16.8)", effect: "auto", fz0: 14.6, recover: (c) => (c === "reaimed" ? 3000 : 12000), want: (c) => (c === "reaimed" ? 14.6 + 0.5 : 16.8), act: (h) => h.setFollowZoom(16.8) },
    { key: "nav stop (followZoom 16.8 → 14.6)", effect: "auto", recover: (c) => (c === "reaimed" ? 3000 : 12000), want: (c) => (c === "reaimed" ? FZ + 0.5 : 14.6), act: (h) => h.setFollowZoom(14.6) },
  ];
  const sweepOne = (ctx: Ctx, g: Gest, android: boolean, moving: boolean): { pass: boolean; detail: string } => {
    const h = unit({ android, followZoom: g.fz0 ?? FZ });
    if (!moving) park(h);
    const tap = h.now + 100; at(h, tap); h.crew();
    let tg: number;
    if (ctx === "crewEase") tg = tap + 200;
    else {
      at(h, tap + 7000 + 40);
      const f0 = flies(h, tap)[0];
      if (!f0) return { pass: false, detail: "(the return fly never started)" };
      if (ctx === "reaimed") { at(h, f0.t + 100); h.press(0.5); tg = h.now + 300; } else tg = f0.t + 300;
    }
    at(h, tg);
    const zg = h.cam.zoom, ease0 = h.counts.setEase;
    g.act(h);
    at(h, tg + 20);
    const acted = g.effect === "owner" ? flies(h, tg).some((r) => r.t - tg <= 18) : g.effect === "crew" ? h.counts.setEase > ease0 : true;
    at(h, tg + (g.settle ?? 3500));
    const cut = h.maxCut(tg, h.now);
    const n0 = h.counts.noteCam; at(h, h.now + 3000);
    const idle = moving || h.counts.noteCam === n0;
    const rf = h.C.returnFlyRef.current, fd = h.S.flyDestRef.current;
    const stale = returnFlyLive(rf, h.abs) ? "fly still in flight" : rf > 0 && fd && Math.abs(fd.zoom - h.cam.zoom) > 0.02 ? `landing seed ${f3(fd.zoom)} ≠ camera ${f3(h.cam.zoom)}` : "";
    const zParked = h.cam.zoom;
    const tr = h.now; h.setMoving(true); at(h, tr + (g.recover ? g.recover(ctx) : 3000));
    const cutR = h.maxCut(tr, h.now);
    const want = g.want(ctx, zg);
    const lands = want == null || Math.abs(h.cam.zoom - Math.max(10.5, Math.min(20, want))) <= 0.26;
    const pass = acted && cut.m <= X_CUT && idle && !stale && cutR.m <= X_CUT && lands;
    return { pass, detail: `(acted ${acted ? "≤1 vsync" : "NO"}; cut ${f3(cut.m)}; pump ${idle ? "idle" : "RUNNING"}; ${stale || "no stale fly"}; parked ${f3(zParked)} → moving ${f3(h.cam.zoom)} want ${want == null ? "-" : f3(want)}, cut ${f3(cutR.m)})` };
  };
  const returnFlyLive = (rf: number, abs: number) => rf < 0 || (rf > 0 && abs < rf);
  let xi = 0;
  for (const ctx of ["fly", "reaimed", "crewEase"] as Ctx[]) for (const g of G) for (const android of [false, true]) {
    const r = sweepOne(ctx, g, android, false);
    ok(`X${++xi}`, `${g.key} during the ${ctx === "fly" ? "return fly" : ctx === "reaimed" ? "re-aimed fly" : "crewFit easeTo"} (${android ? "Android" : "iOS"})`, r.pass, r.detail);
  }
  for (const key of ["pinch (begin · scale 1 · end)", "recenter"]) for (const android of [false, true]) {
    const r = sweepOne("fly", G.find((g) => g.key === key)!, android, true);
    ok(`X${++xi}`, `${key} during the return fly, MOVING (${android ? "Android" : "iOS"})`, r.pass, r.detail);
  }

  // ── Y: the AFTER-THE-FLY axis (Codex third pass, 2026-09-25) ─────────────────────────────────────────────────────
  // A parked fly used to FINISH without its landing being pushed, so its seed waited for the car to move and then beat
  // any framing set since (Crew → pinch in the return → settle → pinch again → a 1.0-level cut on pulling away). Each
  // X gesture at three times — DURING the return fly · right after it LANDED (parked) · landed + 10 s LATER — then a
  // SECOND gesture (a pinch ramped to ×2, or a '−' press), then the car pulls away. iOS and Android. Asserted: no cut
  // above X_CUT from the first gesture to the end, no fly in flight or landing left pending once parked, the parked
  // camera shows the framing, the parked pump is idle, and pulling away lands on that framing without a cut.
  const pinchRamp = (to: number, n: number) => (h: ReturnType<typeof makeHeadUnit>) => {
    h.gesture({ kind: "zoomBegin" });
    for (let k = 1; k <= n; k++) { h.gesture({ kind: "zoom", scale: Math.pow(to, k / n), velocity: 0 }); if (k < n) h.advance(33); }
    h.gesture({ kind: "zoomEnd" });
  };
  const G1: Gest[] = G.map((g) => (g.key.startsWith("pinch out-in") ? { ...g, key: "pinch ramp to ×1.3", act: pinchRamp(1.3, 4) } : g));
  const G2 = [
    { key: "a pinch ramped to ×2", act: pinchRamp(2, 10), pinch: true },
    { key: "a '−' press", act: (h: ReturnType<typeof makeHeadUnit>) => h.press(-0.5), pinch: false },
  ];
  const RETURN_FLY = (src.mods.RETURN_FLY_MS as number) ?? 1800;
  let yi = 0;
  for (const tm of ["during", "landed", "later"] as const) for (const g1 of G1) for (const g2 of G2) for (const android of [false, true]) {
    const id = `Y${++yi}`, name = `${g1.key} ${tm === "during" ? "during the return fly" : tm === "landed" ? "right after the fly landed (parked)" : "10 s after the fly landed (parked)"}, then ${g2.key}, then pull away (${android ? "Android" : "iOS"})`;
    const h = unit({ android, followZoom: g1.fz0 ?? FZ });
    park(h);
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7000 + 40);
    const f0 = flies(h, tap)[0];
    if (!f0) { ok(id, name, false, "(the return fly never started)"); continue; }
    const t1 = tm === "during" ? f0.t + 300 : tm === "landed" ? f0.t + RETURN_FLY + 50 : f0.t + RETURN_FLY + 10000;
    at(h, t1); g1.act(h);
    at(h, t1 + 2500);
    const zb = h.cam.zoom, t2 = h.now;
    const overviewBefore = h.C.camHoldWasActiveRef.current, manualBefore = h.C.manualZoomRef.current;
    g2.act(h);
    at(h, t2 + 3000);
    const rf = h.C.returnFlyRef.current;
    const stale = rf < 0 || (rf > 0 && h.abs < rf) ? "a fly still in flight" : rf > 0 ? "a LANDING still pending (stale seed)" : "";
    const C = h.C, fz = C.camInputsRef.current.followZoom;
    const framing = src.mods.carZoomDest(C.manualZoomRef.current, fz, C.userZoomRef.current, 10.5, 20);
    const shows = Math.abs(h.cam.zoom - framing) < 0.02;
    // What the 2nd gesture must frame (the production rules, clampBias's press limit): a pinch — what was on screen,
    // +1 level; a '−' — from the chase framing if it ended an overview, else from the held framing, else from the screen.
    const lim = (z: number) => fz + Math.max(Math.max(-4, 10.5 - fz), Math.min(Math.min(4, 20 - fz), z - fz));
    const want2 = g2.pinch ? lim(lim(zb) + 1) : lim((overviewBefore ? fz : manualBefore ?? zb) - 0.5);
    const g2ok = Math.abs(framing - want2) < 0.02;
    const n0 = h.counts.noteCam; at(h, h.now + 3000); const idle = h.counts.noteCam === n0;
    const cutP = h.maxCut(t1, h.now);
    const tr = h.now; h.setMoving(true); at(h, tr + 3000);
    const cutR = h.maxCut(tr, h.now);
    const lands = Math.abs(h.cam.zoom - framing) <= 0.02;
    ok(id, name, !stale && shows && g2ok && idle && cutP.m <= X_CUT && cutR.m <= X_CUT && lands,
      `(${stale || "no stale fly"}; framing ${f3(framing)}, parked ${f3(h.frames.find((f) => f.t >= tr)!.zoom)} → moving ${f3(h.cam.zoom)}; 2nd gesture ${g2ok ? "ok" : `WRONG (want ${f3(want2)})`}; cut parked ${f3(cutP.m)} / on resume ${f3(cutR.m)}; pump ${idle ? "idle" : "RUNNING"})`);
  }

  // ── L: SYSTEM corrections through the camera owner (Codex fourth pass, 2026-09-25) ───────────────────────────────
  // A head-unit RELAYOUT (the [painted, mapW] effect — followZoom 16.8 → 17.8, as aaZoomOutFor does when mapW arrives
  // late) and a fix LOST AND REGAINED (the [painted, hasFix] effects — the cold-start snap and the pending re-centre) are
  // camera writes too. They used to bypass the owner: mid-fly on Android the instant write cancelled the fly while its
  // deadline + landing survived, and the parked landing then overwrote the corrected framing (a 1.0-level cut, stuck at
  // 16.8). Each correction during the return fly · right after it landed · during a +/- ease · during the release ·
  // during a Crew overview (still, and inside crewFit's easeTo) — iOS and Android — then the car pulls away. Asserted:
  // no cut after the correction (a landed, idle camera takes the relayout instantly by design — that one step excepted),
  // no fly or landing left stale, the pump idle, the camera ends on the corrected framing, and pulling away does not cut.
  const sysCase = (id: string, name: string, android: boolean, run: (h: ReturnType<typeof makeHeadUnit>) => { t: number; instant: boolean; want: number; settle: number }) => {
    const h = park(unit({ android }));
    const r = run(h);
    at(h, r.t + r.settle);
    const cut = h.maxCut(r.t + (r.instant ? 40 : 0), h.now);
    const rf = h.C.returnFlyRef.current;
    const stale = rf < 0 || (rf > 0 && h.abs < rf) ? "a fly still in flight" : rf > 0 ? "a LANDING still pending" : "";
    const shows = Math.abs(h.cam.zoom - r.want) < 0.02;
    const n0 = h.counts.noteCam; at(h, h.now + 3000); const idle = h.counts.noteCam === n0;
    const tr = h.now; h.setMoving(true); at(h, tr + 3000);
    const cutR = h.maxCut(tr, h.now), lands = Math.abs(h.cam.zoom - r.want) <= 0.02;
    ok(`${id}${android ? "a" : ""}`, `${name} (${android ? "Android" : "iOS"})`, cut.m <= X_CUT && !stale && shows && idle && cutR.m <= X_CUT && lands,
      `(cut after ${f3(cut.m)}${cut.m > X_CUT ? ` at +${Math.round(cut.at - r.t)} ms` : ""}; ${stale || "no stale fly"}; parked ${f3(h.frames.find((f) => f.t >= tr)!.zoom)} want ${f3(r.want)}; pump ${idle ? "idle" : "RUNNING"}; moving ${f3(h.cam.zoom)}, cut ${f3(cutR.m)})`);
  };
  const flyStart = (h: ReturnType<typeof makeHeadUnit>) => { const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 7000 + 40); return flies(h, tap)[0]?.t ?? NaN; };
  for (const android of [false, true]) {
    sysCase("L1", "relayout 300 ms into the return fly → the fly is re-aimed onto the corrected framing", android, (h) => { const f = flyStart(h); at(h, f + 300); h.relayout(17.8); return { t: h.now, instant: false, want: 17.8, settle: 3000 }; });
    sysCase("L2", "relayout right after the fly landed (parked) → instant, and no old landing overwrites it", android, (h) => { const f = flyStart(h); at(h, f + RETURN_FLY + 50); h.relayout(17.8); return { t: h.now, instant: true, want: 17.8, settle: 3000 }; });
    sysCase("L3", "relayout during a +/- ease → the ease keeps the zoom; after the hold it eases home to the corrected zoom", android, (h) => { const t0 = h.now + 100; at(h, t0); h.press(-0.5); at(h, t0 + 100); h.relayout(17.8); return { t: h.now, instant: false, want: 17.8, settle: lapse + 4000 }; });
    sysCase("L4", "relayout during the 1.2 s release → the release follows the corrected zoom (no cut)", android, (h) => { const t0 = h.now + 100; at(h, t0); h.press(-0.5); at(h, t0 + lapse + 400); h.relayout(17.8); return { t: h.now, instant: false, want: 17.8, settle: 5000 }; });
    sysCase("L5", "relayout during a still Crew overview → the overview is kept; its way home lands on the corrected zoom", android, (h) => { const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 3000); h.relayout(17.8); return { t: h.now, instant: false, want: 17.8, settle: 4000 + 1800 + 1000 }; });
    sysCase("L6", "relayout inside crewFit's 600 ms easeTo → kept; the way home lands on the corrected zoom", android, (h) => { const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 200); h.relayout(17.8); return { t: h.now, instant: false, want: 17.8, settle: 6800 + 1800 + 1000 }; });
    // L7–L9 are DEFENSIVE, not production paths: CarMapView mounts only with a fix and carStore never sets selfLat back
    // to null, so hasFix cannot go true → false → true within a mount (review of 1f2faada); the harness also does not
    // unmount SelfCarModel as `{hasFix && <SelfCarModel/>}` would. They only prove the effects route through the owner.
    sysCase("L7", "DEFENSIVE (unreachable today): the cold-start + pending re-centre effects re-run during the return fly → re-aimed", android, (h) => { const f = flyStart(h); at(h, f + 300); h.fixRegained(); return { t: h.now, instant: false, want: 16.8, settle: 3000 }; });
    sysCase("L8", "DEFENSIVE (unreachable today): those effects re-run during a +/- ease → the ease keeps the zoom", android, (h) => { const t0 = h.now + 100; at(h, t0); h.press(-0.5); at(h, t0 + 100); h.fixRegained(); return { t: h.now, instant: false, want: 16.3, settle: 3000 }; });
    sysCase("L9", "DEFENSIVE (unreachable today): those effects re-run during a still Crew overview → kept; home at 7 s", android, (h) => { const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 3000); h.fixRegained(); return { t: h.now, instant: false, want: 16.8, settle: 4000 + 1800 + 1000 }; });
  }

  // ── T: a STALE ONE-SHOT (review of 1f2faada, major) ────────────────────────────────────────────────────────────────
  // An instant owner write on a STOPPED car (compass on/off, the AppState re-assert, a layout correction, a pinch's last
  // update) used to leave zoomSnapRef = true with nothing to consume it; minutes later the next push (a +/- press, or
  // pulling away) snapped to every target that had changed meanwhile — a press snapped the pitch 45°. Now the write
  // records what it wrote and the lockstep seeds from that. Each prior, then 5 min stopped during which the targets
  // move (the 2D/3D toggle: pitch 45 → 0; or nav start: zoom 16.8 → 17.0, pitch 45 → 48), then a '−' press or the car
  // pulls away — iOS and Android. Asserted over the 3 s after: no zoom cut > X_CUT, no pitch or heading cut > 2°.
  const priors: [string, (h: ReturnType<typeof makeHeadUnit>) => void][] = [
    ["compass on then off", (h) => { h.gesture({ kind: "compass" }); h.advance(300); h.gesture({ kind: "compass" }); }],
    ["the AppState re-assert", (h) => h.reassert()],
    ["a layout correction", (h) => h.relayout(16.8)],
    ["a pinch's last update", (h) => { h.gesture({ kind: "zoomBegin" }); for (let k = 1; k <= 3; k++) { h.gesture({ kind: "zoom", scale: Math.pow(1.1, k / 3), velocity: 0 }); h.advance(33); } h.gesture({ kind: "zoomEnd" }); }],
    ["compass north-up (latched)", (h) => h.gesture({ kind: "compass" })],
  ];
  const changes: [string, (h: ReturnType<typeof makeHeadUnit>) => void][] = [
    ["2D/3D (pitch 45 → 0)", (h) => h.setFollowPitch(0)],
    ["nav start (zoom 17.0, pitch 48)", (h) => { h.setFollowZoom(17.0); h.setFollowPitch(48); }],
  ];
  let ti = 0;
  for (const [pn, prior] of priors) for (const [cn, change] of changes) for (const trig of ["a '−' press", "pulling away"] as const) for (const android of [false, true]) {
    const h = park(unit({ android }));
    prior(h);
    h.advance(10000); change(h); h.advance(290000);   // 5 min stopped; the targets move 10 s in
    const t0 = h.now;
    if (trig === "a '−' press") h.press(-0.5); else h.setMoving(true);
    at(h, t0 + 3000);
    const z = h.maxCut(t0, h.now), p = h.maxPitchCut(t0, h.now), hd = h.maxHeadingCut(t0, h.now);
    ok(`T${++ti}`, `${pn}, 5 min stopped with ${cn}, then ${trig} (${android ? "Android" : "iOS"})`, z.m <= X_CUT && p.m <= 2 && hd.m <= 2,
      `(largest one-vsync zoom ${f3(z.m)} · pitch ${p.m.toFixed(2)}° · heading ${hd.m.toFixed(2)}°)`);
  }

  // ── NU: the north-up latch is honoured by every owner write (review of 1f2faada) ────────────────────────────────────
  for (const android of [false, true]) {
    const h = park(unit({ android }));
    h.gesture({ kind: "compass" }); h.advance(500);
    const t1 = h.now; h.reassert(); h.advance(10000);
    const parkedHdg = Math.max(...h.frames.filter((f) => f.t >= t1).map((f) => Math.abs(((f.heading % 360) + 360) % 360 > 180 ? 360 - (((f.heading % 360) + 360) % 360) : ((f.heading % 360) + 360) % 360)));
    const tr = h.now; h.setMoving(true); at(h, tr + 3000);
    const hd = h.maxHeadingCut(tr, h.now);
    ok(`NU1${android ? "a" : ""}`, `compass north-up latched, then the AppState re-assert while stopped: the map stays north-up, and pulling away does not turn it (${android ? "Android" : "iOS"})`, parkedHdg <= 0.5 && hd.m <= 2, `(largest heading off north while parked ${parkedHdg.toFixed(1)}°; largest one-vsync heading change on pulling away ${hd.m.toFixed(1)}°)`);
  }

  // ── G: a write landing between the fly's JS deadline and the native fly's last frame (review of 1f2faada, iOS) ─────
  // The native flyTo starts on the next display frame after the call, so it ends up to a frame after the JS deadline;
  // an instant write in that gap was overwritten by the fly's last frames on iOS and, parked, never re-applied. The fly
  // now owns the camera for RETURN_FLY_GRACE_MS past its deadline (a write there re-aims it) and lands after it.
  let gi = 0;
  for (const dt of [0, 5, 10, 16, 40, 120]) for (const [kn, act, wantZ, wantH] of [["a layout correction (→ 17.8)", (h: ReturnType<typeof makeHeadUnit>) => h.relayout(17.8), 17.8, null], ["the compass (north-up)", (h: ReturnType<typeof makeHeadUnit>) => h.gesture({ kind: "compass" }), 16.8, 0]] as const) for (const android of [false, true]) {
    const h = park(unit({ android }));
    const f0 = flyStart(h);
    at(h, f0 + RETURN_FLY + dt); (act as any)(h);
    const tw = h.now;
    at(h, tw + 3000);
    const zOk = Math.abs(h.cam.zoom - (wantZ as number)) < 0.02;
    const hN = ((h.cam.heading % 360) + 360) % 360, hOff = Math.min(hN, 360 - hN);
    const hOk = wantH == null || hOff < 0.5;
    const tr = h.now; h.setMoving(true); at(h, tr + 3000);
    const z = h.maxCut(tr, h.now), hd = h.maxHeadingCut(tr, h.now);
    ok(`G${++gi}`, `${kn} ${dt} ms after the fly's JS deadline, parked (${android ? "Android" : "iOS"})`, zOk && hOk && z.m <= X_CUT && hd.m <= 2,
      `(parked zoom ${f3(h.frames.find((f) => f.t >= tr)!.zoom)} want ${f3(wantZ as number)}${wantH == null ? "" : `, heading off north ${hOff.toFixed(1)}°`}; pulling away: zoom cut ${f3(z.m)} · heading ${hd.m.toFixed(1)}°)`);
  }

  // ── CF: crewFit frames the crew on the MEASURED canvas (review of 1f2faada; pre-existing since 0f092762) ───────────
  // The gesture handler is subscribed once, so render #1's mapW/mapH (0) → the 400×240 fallback on every head unit.
  for (const android of [false, true]) {
    const h = park(unit({ android }));
    const { mapW: w, mapH: hh } = h.C.camInputsRef.current;
    const pts = [[h.cam.lng, h.cam.lat], ...(h.C.__peers as any[]).map((p) => [p.lng, p.lat])];
    const lngSpan = Math.max(0.002, Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])));
    const latSpan = Math.max(0.002, Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])));
    const want = Math.max(8, Math.min(15, Math.min(Math.log2((w * 0.75 * 360) / (512 * lngSpan)), Math.log2((hh * 0.65 * 180) / (512 * latSpan)))));
    const tap = h.now + 100; at(h, tap); h.crew(); at(h, tap + 900);
    ok(`CF1${android ? "a" : ""}`, `Crew frames the crew for the measured ${w}×${hh} canvas, not render #1's 400×240 fallback (${android ? "Android" : "iOS"})`, Math.abs(h.cam.zoom - want) < 0.02, `(overview zoom ${f3(h.cam.zoom)}, want ${f3(want)})`);
  }

  // ── TL: a write at the TAIL of a native animation (Codex's final pass [high], 2026-09-25) ─────────────────────────
  // crewFit's 600 ms easeTo, a fly home, a re-aimed fly: each ends natively up to a frame after its JS deadline, and on
  // iOS MapboxMap.setCamera(to:) does not cancel it — a 'none' write in that tail is overwritten by the animation's last
  // frame. Codex: park, a nearby crew, Crew, recenter 600 ms later → the edge's snap lost to the easeTo's last frame,
  // stuck at z 15 / pitch 0 / heading 0 with nothing owed. Each gesture −20 … +120 ms around each animation's JS end ·
  // a NEARBY crew (fits z 15 — its 7 s return is a snap, no animation) and the WIDE crew (fits below z 14 — its 7 s return
  // is the 1.8 s fly) · parked · iOS and Android. Asserted: from 3 s to 20 s after the gesture, whenever nothing animates
  // the camera shows exactly the owner's framing (zoom = carZoomDest, pitch = followPitch, heading = the north-up
  // override or the car's) and is never off it for more than 250 ms; then for 5 s it HOLDS the independent end framing
  // (16.8, or the relayout's 17.8 · pitch 45 · heading 90, north for the compass) with nothing owed and the pump idle.
  const TL_OFFSETS = [-20, -10, -5, 0, 5, 10, 17, 40, 80, 120];
  let tli = 0;
  for (const anchor of T_ANCHORS)
  for (const crewKind of ["nearby", "wide"] as const) for (const g of TG) for (const dt of TL_OFFSETS) for (const android of [false, true]) {
    const h = park(unit({ android }));
    if (crewKind === "nearby") h.C.__peers = [];
    let netAt = 0;   // did the re-apply net engage (a write inside a native animation's tail)?
    const rr = h.C.reapplyAfterRef; let rv = rr.current;
    Object.defineProperty(rr, "current", { get: () => rv, set: (v: number) => { if (v !== 0 && !netAt) netAt = h.now; rv = v; }, configurable: true });
    const tap0 = h.now;
    const A = tlSetup(h, anchor);
    const id = `TL${++tli}`;
    const name = `${g.key} ${dt >= 0 ? "+" : "−"}${Math.abs(dt)} ms from the end of ${anchor}${anchor === "the 7 s return" && crewKind === "nearby" ? " (a snap)" : ""}, ${crewKind} crew, parked (${android ? "Android" : "iOS"})`;
    if (!Number.isFinite(A)) { ok(id, name, false, "(the anchor animation never started)"); continue; }
    const tg = A + dt; at(h, tg); g.act(h);
    const C = h.C;
    let run = 0, worst = 0, worstAt = 0, checked = 0, worstWhat = "";
    for (let t = tg + 3000; t <= tg + 20000; t += 50) {
      at(h, t);
      const last = h.frames[h.frames.length - 1];
      const busy = !!C.zoomChRef.current.ease || C.returnFlyRef.current !== 0 || C.camHoldWasActiveRef.current || C.pinchActiveRef.current || !!last?.animating;
      if (busy) { run = 0; continue; }
      checked++;
      const fz = C.camInputsRef.current.followZoom, fp = C.camInputsRef.current.followPitch;
      const wz = src.mods.carZoomDest(C.manualZoomRef.current, fz, C.userZoomRef.current, 10.5, 20);
      const wh = C.camHdgOverrideRef.current ?? C.drawHdgRef.current;
      const dz = Math.abs(h.cam.zoom - wz), dp = Math.abs(h.cam.pitch - fp), dh = angOff(h.cam.heading, wh);
      if (dz > 0.02 || dp > 0.5 || dh > 0.5) {
        run += 50;
        if (run > worst) { worst = run; worstAt = t - tg; worstWhat = `camera ${f3(h.cam.zoom)}/${h.cam.pitch.toFixed(1)}/${h.cam.heading.toFixed(1)} vs owner ${f3(wz)}/${fp}/${wh}`; }
      } else run = 0;
    }
    // The end framing, held: 5 more seconds, every sample on it, nothing owed, no camera push.
    const n0 = h.counts.noteCam; let held = true, endWhat = "";
    for (let t = tg + 20050; t <= tg + 25000; t += 250) {
      at(h, t);
      const off = Math.abs(h.cam.zoom - g.z) > 0.02 || Math.abs(h.cam.pitch - 45) > 0.5 || angOff(h.cam.heading, g.hdg) > 0.5;
      if (off && held) { held = false; endWhat = `at +${Math.round(t - tg)} ms ${f3(h.cam.zoom)}/${h.cam.pitch.toFixed(1)}/${h.cam.heading.toFixed(1)}`; }
    }
    const owed = C.carCamJob() || C.returnFlyRef.current !== 0 || C.camHoldWasActiveRef.current || rv !== 0;
    const idle = h.counts.noteCam === n0;
    const ovZ = Math.min(...h.frames.filter((f) => f.t >= tap0).map((f) => f.zoom));   // lowest zoom since the Crew tap
    const pass = worst <= 250 && checked > 0 && held && !owed && idle;
    ok(id, name, pass, `(lowest zoom since Crew ${f3(ovZ)}; ${checked ? `off the owner's framing ${worst} ms${worst ? ` at +${worstAt} ms: ${worstWhat}` : ""}` : "NEVER CHECKED — always busy"}; end ${held ? `held ${f3(g.z)}/45/${g.hdg}` : `NOT held (${endWhat})`}; ${owed ? "something still OWED" : "nothing owed"}; pump ${idle ? "idle" : "RUNNING"}; net ${netAt ? `engaged at +${Math.round(netAt - tg)} ms` : "-"})`);
  }

  // ── the harness itself: every identifier the lifted production code read resolved ─────────────────────────────
  const unres = new Set<string>(); for (const h of all) for (const u of h.unresolved) unres.add(u);
  ok("Z1", "the lifted production code resolved every identifier it read", unres.size === 0, unres.size ? `(unresolved: ${[...unres].join(", ")})` : "");
  return R;
}

// ════ DL — NATIVE LATENCY the JS side cannot see (Codex on round 7, [high]; 2026-09-25) ═══════════════════════════════
// Every guard before round 8 dated a native animation's end from the JS side (its deadline + RETURN_FLY_GRACE_MS). Codex
// injected a 150 ms native START delay: nearby crew, Crew, recenter at +720 ms → the snap lost to crewFit's easeTo on
// iOS, parked at z 15 / pitch 0 / heading 0 with nothing owed. The closed loop (src/camRepair.ts) compares what the map
// REPORTS with what the owner last wrote. Swept here: native start delay 0 / 50 / 150 / 300 / 600 ms, every animation
// stretched by a seeded 0–80 ms end jitter · every TL gesture × every TL animation · nearby and wide crew · parked · iOS
// and Android · one offset per case from −20 / +10 / +120 / (delay + 40) ms around the animation's JS end (rotated).
// Asserted: whenever no native animation has run for 1.5 s and nothing owns the camera, it shows EXACTLY the owner's
// framing (from the gesture to 20 s after); then it holds the independent end framing for 5 s; nothing is owed; then
// 60 s idle with ZERO camera writes and no loop row; the loop never gives up.
export const DL_DELAYS = [0, 50, 150, 300, 600];
export function runDelayScenarios(src: Src): Result[] {
  const R: Result[] = [];
  const ok = (id: string, name: string, pass: boolean, detail = "") => { R.push({ id, name, pass, detail }); };
  const all: HU[] = [];
  const unit = (o: Parameters<typeof makeHeadUnit>[1] = {}) => { const h = makeHeadUnit(src, { followZoom: 16.8, ...o }); all.push(h); return h; };
  const writes = (h: HU) => h.counts.noteCam + h.counts.setNone + h.counts.setFly + h.counts.setEase;
  const repairRows = (h: HU, a: number, b: number) => h.rows(/cam-repair surf=car/).filter((r) => r.t >= a && r.t <= b);
  const ops = (rows: { row: string }[]) => { const m: Record<string, number> = {}; for (const r of rows) { const op = / op=(\w+)/.exec(r.row)?.[1] ?? "?"; m[op] = (m[op] ?? 0) + 1; } return Object.entries(m).map(([k, v]) => `${k}×${v}`).join(" ") || "-"; };
  /** From `a` to `b`: every 50 ms, skip while a native animation runs or ran < 1.5 s ago or the owner is busy; else the
   *  camera must show the owner's framing. Returns the first miss ("" = none) and how many samples were judged. */
  const judge = (h: HU, a: number, b: number) => {
    let miss = "", judged = 0;
    for (let t = a; t <= b; t += 50) {
      hAt(h, t);
      const lastEnd = h.animEnds.length ? h.animEnds[h.animEnds.length - 1] : -1e9;
      if (h.animating || t < lastEnd + 1500 || ownerBusy(h)) continue;
      judged++;
      const off = ownerOff(h, src);
      if (off && !miss) miss = `at +${Math.round(t - a)} ms (${Math.round(t - lastEnd)} ms after the last native end): ${off}`;
    }
    return { miss, judged };
  };
  /** The end framing held for 5 s, nothing owed, then 60 s idle: zero camera writes and no loop row. */
  const tail = (h: HU, t: number, z: number, hdg: number) => {
    let held = "";
    for (let u = t; u <= t + 5000; u += 250) {
      hAt(h, u);
      if (!held && (Math.abs(h.cam.zoom - z) > 0.02 || Math.abs(h.cam.pitch - 45) > 0.5 || angOff(h.cam.heading, hdg) > 0.5)) held = `at +${Math.round(u - t)} ms ${f3(h.cam.zoom)}/${h.cam.pitch.toFixed(1)}/${h.cam.heading.toFixed(1)}`;
    }
    const C = h.C;
    const owed = C.carCamJob() || C.returnFlyRef.current !== 0 || C.camHoldWasActiveRef.current || C.reapplyAfterRef.current !== 0 || (C.camRepairRef?.current?.pending ?? null) != null;
    const w0 = writes(h), i0 = h.now; hAt(h, h.now + 60000);
    const idleWrites = writes(h) - w0, idleRows = repairRows(h, i0, h.now).length;
    return { held, owed, idleWrites, idleRows };
  };

  // DL0 — Codex's repro, exactly: 150 ms native start delay, a nearby crew, Crew, recenter at +720 ms, 20 s.
  for (const android of [false, true]) {
    const h = hPark(unit({ android, animStartDelayMs: 150 }));
    h.C.__peers = [];
    const tap = h.now; h.crew(); h.advance(720); h.gesture({ kind: "recenter" }); h.advance(20000);
    const easeEnd = h.animEnds.find((t) => t > tap) ?? NaN;
    const late = h.frames.filter((f) => f.t >= easeEnd + 1500);
    const bad = late.find((f) => Math.abs(f.zoom - 16.8) > 0.02 || Math.abs(f.pitch - 45) > 0.5 || angOff(f.heading, 90) > 0.5);
    const rr = repairRows(h, tap, h.now);
    ok(`DL0${android ? "a" : ""}`, `Codex's repro: 150 ms native start delay, nearby crew, Crew, recenter at +720 ms → home within 1.5 s of the easeTo's REAL end and held for 20 s (${android ? "Android" : "iOS"})`,
      Number.isFinite(easeEnd) && late.length > 0 && !bad,
      `(easeTo really ended +${Math.round(easeEnd - tap)} ms after the tap; ${bad ? `OFF at +${Math.round(bad.t - tap)} ms: ${f3(bad.zoom)}/${bad.pitch.toFixed(1)}/${bad.heading.toFixed(1)}` : `16.8/45/90 from +${Math.round(easeEnd + 1500 - tap)} ms to +${Math.round(h.now - tap)} ms`}; loop ${ops(rr)})`);
  }

  // DL — the sweep.
  let di = 0, rot = 0;
  for (const D of DL_DELAYS) for (const anchor of T_ANCHORS) for (const crewKind of ["nearby", "wide"] as const) for (const g of TG) {
    const offs = [-20, 10, 120, D + 40];
    const dt = offs[rot++ % offs.length];
    for (const android of [false, true]) {
      const h = hPark(unit({ android, animStartDelayMs: D, animEndJitterMs: 80, seed: 17 + di }));
      if (crewKind === "nearby") h.C.__peers = [];
      const id = `DL${++di}`;
      const name = `${g.key} ${dt >= 0 ? "+" : "−"}${Math.abs(dt)} ms from the JS end of ${anchor}${anchor === "the 7 s return" && crewKind === "nearby" ? " (a snap)" : ""}, native start delay ${D} ms + end jitter ≤ 80 ms, ${crewKind} crew, parked (${android ? "Android" : "iOS"})`;
      const A = tlSetup(h, anchor);
      if (!Number.isFinite(A)) { ok(id, name, false, "(the anchor animation never started)"); continue; }
      const tg = A + dt; hAt(h, tg); g.act(h);
      const j = judge(h, tg, tg + 20000);
      const t = tail(h, tg + 20000, g.z, g.hdg);
      const rr = repairRows(h, 0, h.now), gaveUp = rr.some((r) => / op=giveup/.test(r.row));
      const pass = !j.miss && j.judged > 0 && !t.held && !t.owed && t.idleWrites === 0 && t.idleRows === 0 && !gaveUp;
      ok(id, name, pass, `(${j.judged ? (j.miss ? `OFF the owner's framing ${j.miss}` : `on the owner's framing at all ${j.judged} judged samples`) : "NEVER JUDGED"}; end ${t.held ? `NOT held (${t.held})` : `held ${g.z}/45/${g.hdg}`}; ${t.owed ? "something OWED" : "nothing owed"}; 60 s idle: ${t.idleWrites} writes, ${t.idleRows} loop rows; loop ${ops(rr)})`);
    }
  }

  // PF — no fight with a pinch in progress. A 1.2 s pinch (×1.5) that starts just past the JS end + grace of a delayed
  // native animation, i.e. while it still runs on screen. Asserted: the loop logs nothing and owes nothing while the
  // fingers are down; once the animation has really ended (+1.5 s) the camera shows the pinch's framing; after the 15 s
  // hold it is home (16.8/45/90) and held; then 60 s idle with zero writes.
  let pi = 0;
  for (const D of [150, 300, 600]) for (const anchor of ["crewFit's easeTo", "a fly started inside the easeTo", "the 7 s return"] as TAnchor[]) for (const android of [false, true]) {
    const h = hPark(unit({ android, animStartDelayMs: D, animEndJitterMs: 80, seed: 900 + pi }));
    const id = `PF${++pi}`, name = `a 1.2 s pinch starting inside the delayed tail of ${anchor} (native start delay ${D} ms), wide crew, parked (${android ? "Android" : "iOS"})`;
    const A = tlSetup(h, anchor);
    if (!Number.isFinite(A)) { ok(id, name, false, "(the anchor animation never started)"); continue; }
    const p0 = A + 100 + 20; hAt(h, p0);
    const nativeRunning = h.animating;
    let pendingDuring = false;
    h.gesture({ kind: "zoomBegin" });
    for (let k = 1; k <= 36; k++) { h.gesture({ kind: "zoom", scale: Math.pow(1.5, k / 36), velocity: 0 }); h.advance(33); if (h.C.camRepairRef?.current?.pending) pendingDuring = true; }
    h.gesture({ kind: "zoomEnd" });
    const p1 = h.now;
    const rowsDuring = repairRows(h, p0, p1);
    const j = judge(h, p1, p1 + 14000);   // inside the 15 s hold: the pinch's framing
    const t = tail(h, p1 + 20000, 16.8, 90);
    const pass = !pendingDuring && rowsDuring.length === 0 && !j.miss && j.judged > 0 && !t.held && !t.owed && t.idleWrites === 0 && t.idleRows === 0;
    ok(id, name, pass, `(native animation ${nativeRunning ? "still running" : "NOT running"} at the first finger; loop during the pinch: ${rowsDuring.length} rows, ${pendingDuring ? "OWED a push" : "owed nothing"}; after: ${j.judged ? (j.miss ? `OFF ${j.miss}` : `on the pinch framing at all ${j.judged} judged samples`) : "NEVER JUDGED"}; end ${t.held ? `NOT held (${t.held})` : "held 16.8/45/90"}; 60 s idle: ${t.idleWrites} writes; loop ${ops(repairRows(h, 0, h.now))})`);
  }

  // ════ Round 9 (three adversarial reviews of 6c8abe9d) — each finding's reproduction, through the production code ════
  const native = (h: HU, o: any) => h.C.cameraRef.current.setCamera({ ...o, animationMode: "none", animationDuration: 0 });   // NOT an owner write
  const poseOf = (h: HU) => `${f3(h.cam.zoom)}/${h.cam.pitch.toFixed(1)}/${h.cam.heading.toFixed(1)}`;
  const at3 = (h: HU, z: number, p: number, hd: number) => Math.abs(h.cam.zoom - z) <= 0.02 && Math.abs(h.cam.pitch - p) <= 0.5 && angOff(h.cam.heading, hd) <= 0.5;
  /** Largest number of `re` rows / camera writes in any `win` ms window of [a, b]. */
  const perWindow = (ts: number[], win: number) => { let m = 0; for (let i = 0; i < ts.length; i++) { let n = 0; for (let k = i; k < ts.length && ts[k] - ts[i] < win; k++) n++; m = Math.max(m, n); } return m; };
  const corrective = (h: HU, a: number) => h.rows(/cam-repair surf=car op=(push|fly)/).filter((r) => r.t >= a).map((r) => r.t);

  // RB — the budget bounds a map that NEVER agrees (it always reports 0.1 of a level off), parked, 10 min: per episode
  // ≤ 3 corrective writes then ONE giveup row; after it only slow retries (20 s, doubling); in any minute ≤ 6 corrective
  // writes and ≤ 12 rows. A recenter starts a new episode (≤ 3 more, one more giveup). A moving car never involves it.
  for (const android of [false, true]) {
    const h = hPark(unit({ android, reportZoomBias: 0.1 }));
    const t0 = h.now; h.advance(600000);
    const rr = repairRows(h, t0, h.now), cw = corrective(h, t0), rowsT = rr.map((r) => r.t);
    const gives = rr.filter((r) => / op=giveup/.test(r.row)).length;
    const burst = cw.filter((t) => t < t0 + 10000).length;
    const t1 = h.now; h.gesture({ kind: "recenter" }); h.advance(10000);
    const r2 = repairRows(h, t1, h.now);
    const tm = h.now; h.setMoving(true); h.advance(10000);
    const rm = repairRows(h, tm, h.now).length;
    ok(`RB1${android ? "a" : ""}`, `a map that always reports 0.1 off, parked 10 min: ≤ 3 corrective writes then ONE giveup, then slow retries only; ≤ 6 writes and ≤ 12 rows in any minute; a recenter = a new episode (≤ 3 + one giveup); moving: never (${android ? "Android" : "iOS"})`,
      burst >= 1 && burst <= 3 && gives === 1 && perWindow(cw, 60000) <= 6 && perWindow(rowsT, 60000) <= 12 && cw.length <= 3 + 6
      && r2.filter((r) => / op=(push|fly)/.test(r.row)).length <= 3 && r2.filter((r) => / op=giveup/.test(r.row)).length === 1 && rm === 0,
      `(10 min: ${ops(rr)}; first 10 s ${burst} writes; most in a minute: ${perWindow(cw, 60000)} writes / ${perWindow(rowsT, 60000)} rows; slow retries at +${cw.filter((t) => t >= t0 + 10000).map((t) => Math.round((t - t0) / 1000)).join(", +")} s; after a recenter ${ops(r2)}; 10 s moving: ${rm} rows)`);
  }

  // RC — the time caps under a flood of episodes (probe1 P2: the never-agree map + an AppState re-assert every 3 s for
  // 5 min used to log 175 rows and 75 corrective writes). Any minute: ≤ 6 unconfirmed corrective writes, ≤ 12 rows.
  for (const android of [false, true]) {
    const h = hPark(unit({ android, reportZoomBias: 0.1 }));
    h.advance(15000);
    const t0 = h.now;
    for (let k = 0; k < 100; k++) { h.reassert(); h.advance(3000); }
    const rr = repairRows(h, t0, h.now), cw = corrective(h, t0);
    const mw = perWindow(cw, 60000), mr = perWindow(rr.map((r) => r.t), 60000);
    ok(`RC1${android ? "a" : ""}`, `a never-agreeing map + an AppState re-assert every 3 s for 5 min: ≤ 6 corrective writes and ≤ 12 rows in any minute (${android ? "Android" : "iOS"})`,
      mw <= 6 && mr <= 12, `(5 min: ${ops(rr)}; most in a minute: ${mw} writes / ${mr} rows; drop= on rows: ${rr.filter((r) => / drop=/.test(r.row)).length})`);
  }

  // BS — SEPARATE lost writes never exhaust a budget (probe3: DL0 ×4 at 2.5 s gave up and stranded the camera at
  // 15/0/0). Codex's shape repeated N times, 150 ms native start delay, parked: 30 s after the last, home and held.
  for (const [N, gap] of [[4, 2500], [5, 2000], [8, 2000]] as const) for (const android of [false, true]) {
    const h = hPark(unit({ android, animStartDelayMs: 150 }));
    h.C.__peers = [];
    const t0 = h.now;
    for (let k = 0; k < N; k++) { hAt(h, t0 + k * gap); h.crew(); h.advance(720); h.gesture({ kind: "recenter" }); }
    const tl = h.now; h.advance(30000);
    const rr = repairRows(h, t0, h.now);
    const late = h.frames.filter((f) => f.t >= tl + 5000);
    const off = late.find((f) => Math.abs(f.zoom - 16.8) > 0.02 || Math.abs(f.pitch - 45) > 0.5 || angOff(f.heading, 90) > 0.5);
    ok(`BS${N}${android ? "a" : ""}`, `Codex's lost write ×${N}, ${gap} ms apart (150 ms native start delay, nearby crew, parked): home 5 s after the last and held for 25 s; no giveup (${android ? "Android" : "iOS"})`,
      !off && !rr.some((r) => / op=giveup/.test(r.row)), `(${off ? `OFF at +${Math.round(off.t - tl)} ms: ${f3(off.zoom)}/${off.pitch.toFixed(1)}/${off.heading.toFixed(1)}` : `home ${poseOf(h)}`}; loop ${ops(rr)})`);
  }

  // GS — after a giveup the camera is not abandoned: a map that ignores EVERY write for 8 s (all three tries are lost),
  // then works again. Nothing else happens. The slow retry must bring it home, then 60 s idle with zero writes.
  for (const android of [false, true]) {
    const h = hPark(unit({ android }));
    const set0 = h.C.cameraRef.current.setCamera; let deafUntil = 0;
    h.C.cameraRef.current.setCamera = (o: any) => { if (h.now < deafUntil) return; set0(o); };
    const t0 = h.now; native(h, { zoomLevel: 12, pitch: 20 }); deafUntil = t0 + 8000;
    h.advance(40000);
    const rr = repairRows(h, t0, h.now);
    const giveAt = rr.find((r) => / op=giveup/.test(r.row))?.t ?? NaN, okAt = rr.find((r) => / op=ok/.test(r.row))?.t ?? NaN;
    const w0 = writes(h), i0 = h.now; h.advance(60000);
    const idle = writes(h) - w0, idleRows = repairRows(h, i0, h.now).length;
    ok(`GS1${android ? "a" : ""}`, `a map deaf to every write for 8 s: three tries lost → ONE giveup → a slow retry brings it home ≤ 25 s after the giveup with nothing happening; then 60 s idle with zero writes (${android ? "Android" : "iOS"})`,
      Number.isFinite(giveAt) && Number.isFinite(okAt) && okAt - giveAt <= 25000 && at3(h, 16.8, 45, 90) && idle === 0 && idleRows === 0,
      `(loop ${ops(rr)}; giveup +${Math.round(giveAt - t0)} ms, home +${Math.round(okAt - t0)} ms; camera ${poseOf(h)}; idle 60 s: ${idle} writes, ${idleRows} rows)`);
  }

  // RW — the repair RESTORES WHAT WAS WRITTEN, never the speed target (probe1 P3/P4). Parked, the target moved while
  // stopped (a legitimate rest off target), then one foreign change: P3 — target 15.0/30, a 0.3-level loss → back at
  // exactly the written 16.8/45; P4 — resting at 13.5 with the target at 16.8, a 3° pitch loss → back at 13.5/45.
  for (const android of [false, true]) {
    const h3 = hPark(unit({ android }));
    h3.setFollowZoom(15.0); h3.setFollowPitch(30); h3.advance(3000);
    const t3 = h3.now; native(h3, { zoomLevel: h3.cam.zoom - 0.3 }); h3.advance(5000);
    ok(`RW1${android ? "a" : ""}`, `target moved while parked (15.0 / pitch 30), a 0.3-level loss → back at EXACTLY the written 16.8/45/90 (≤ 0.002 / 0.02°), not a step toward the target (${android ? "Android" : "iOS"})`,
      Math.abs(h3.cam.zoom - 16.8) <= 0.002 && Math.abs(h3.cam.pitch - 45) <= 0.02 && angOff(h3.cam.heading, 90) <= 0.02, `(camera ${h3.cam.zoom.toFixed(4)}/${h3.cam.pitch.toFixed(3)}/${h3.cam.heading.toFixed(2)}; loop ${ops(repairRows(h3, t3, h3.now))})`);
    const h4 = unit({ android, followZoom: 13.5 }); h4.advance(8000); hPark(h4);
    h4.setFollowZoom(16.8); h4.advance(3000);
    const t4 = h4.now; native(h4, { pitch: h4.cam.pitch + 3 }); h4.advance(5000);
    ok(`RW2${android ? "a" : ""}`, `resting at z 13.5 with the target at 16.8, a 3° pitch loss → back at the written 13.5/45, not flown to the target (${android ? "Android" : "iOS"})`,
      at3(h4, 13.5, 45, 90), `(camera ${poseOf(h4)}; loop ${ops(repairRows(h4, t4, h4.now))}; flies ${h4.rows(/cam-return-fly/).filter((r) => r.t >= t4).map((r) => r.row.split(" ").slice(2, 4).join(" ")).join(", ") || "-"})`);
  }

  // RD — a LATE REPORT is never judged against a newer write (two reviewers, independently): camera reports delivered
  // 0 / 100 / 160 / 250 / 400 ms after they were captured × compass / recenter / '+' / tap-zoom, parked, iOS and Android;
  // plus a recenter from a − framing below 14 and the same with the pitch target moved 45 → 60 while parked. Expected:
  // ZERO loop rows (only the report is late), no fly, the camera on the owner's framing — the parked map never moved to
  // the new pitch target.
  const rdActs: [string, (h: HU) => void, number, number][] = [
    ["compass", (h) => h.gesture({ kind: "compass" }), 16.8, 0],
    ["recenter", (h) => h.gesture({ kind: "recenter" }), 16.8, 90],
    ["+ press", (h) => h.press(0.5), 17.3, 90],
    ["tap-zoom in", (h) => h.gesture({ kind: "zoom", scale: 1, velocity: 1 }), 17.8, 90],
    ["recenter from a − framing at 12.8", (h) => h.gesture({ kind: "recenter" }), 16.8, 90],
    ["recenter from 12.8 with the pitch target moved to 60 while parked", (h) => h.gesture({ kind: "recenter" }), 16.8, 90],
  ];
  let ri = 0;
  for (const d of [0, 100, 160, 250, 400]) for (const [name, act, z, hd] of rdActs) for (const android of [false, true]) {
    const h = hPark(unit({ android, reportDelayMs: d }));
    if (name.includes("12.8")) { for (let k = 0; k < 8; k++) { h.press(-0.5); h.advance(120); } h.advance(1500); }
    if (name.includes("pitch target")) h.setFollowPitch(60);
    h.advance(3000);
    const t0 = h.now; act(h); h.advance(5000);
    const rr = repairRows(h, t0, h.now), fl = h.rows(/cam-return-fly/).filter((r) => r.t >= t0).length;
    ok(`RD${++ri}`, `${name}, camera reports delivered ${d} ms late, parked (${android ? "Android" : "iOS"})`, rr.length === 0 && fl === 0 && at3(h, z, 45, hd),
      `(loop ${ops(rr)}; flies ${fl}; camera ${poseOf(h)} want ${z}/45/${hd})`);
  }

  // ════ Round 10 (three verified findings against e492b0e1) — each reproduction, through the production code ════════
  // LR — a repair try due on the tick the 15 s zoom hold LAPSES (verify_zoom_fight_1 race_trace / race.mts): parked,
  // 4 × −0.5 (held framing 14.8), one foreign write to z 16.0 or 12 made 140–195 ms before the lapse, 1 ms apart
  // (e492b0e1: the try flew to the old 14.8 while the release eased from under it, then cut 1.40 / 1.58 levels on
  // landing — lost writes 151–166 ms before the lapse on iOS, 151–183 on Android). Expected: no one-vsync zoom change
  // above CUT that no native animation made (the release's own ease-in-out peaks at ~0.10 for 4.8 levels) and home at 16.8.
  for (const android of [false, true]) for (const lostZ of [16.0, 12]) {
    const bad: string[] = []; let worst = 0, n = 0;
    for (let d = 140; d <= 195; d++) {
      const h = hPark(unit({ android }));
      for (let k = 0; k < 4; k++) { h.press(-0.5); h.advance(100); }
      const lapse = h.C.zoomHoldUntilRef.current - (h.abs - h.now);
      hAt(h, lapse - d); const tInj = h.now;
      native(h, { zoomLevel: lostZ }); h.advance(6000); n++;
      const c = h.maxCut(tInj + 20, h.now);
      worst = Math.max(worst, c.m);
      if (c.m > CUT || Math.abs(h.cam.zoom - 16.8) > 0.01) bad.push(`−${d} ms: cut ${f3(c.m)} at lapse+${Math.round(c.at - lapse)}, end ${f3(h.cam.zoom)}`);
    }
    ok(`LR${android ? 2 : 1}${lostZ === 12 ? "b" : "a"}`, `a foreign write to z ${lostZ} made 140–195 ms before the 15 s hold lapses (1 ms steps, ${n} runs), 4 × −0.5 held at 14.8, parked: no cut above ${CUT} and home at 16.8 — a try due on the lapse tick stands down (${android ? "Android" : "iOS"})`,
      bad.length === 0, `(worst one-vsync zoom change outside a native animation ${f3(worst)}${bad.length ? `; ${bad.length} runs FAIL, e.g. ${bad.slice(0, 3).join("; ")}` : ""})`);
  }

  // FL — A FLY'S LANDING WAITS FOR THE MAP (verify_zoom_fight_1 fight3 T11): every head-unit fly — the loop's 280 ms
  // repair fly, the Crew 1.8 s return, the return re-aimed by a '+', the short fly a recenter starts inside crewFit's
  // easeTo — with its native start 0 / 150 / 300 / 600 ms late, parked. e492b0e1: Android cut 0.62 / 4.1 levels on the
  // repair fly at 150 / 300 ms (the landing 'none' cancels a late fly), 0.29 / 1.46 on the Crew return at 300 / 600 ms;
  // iOS cut 4.8 at 600 ms (a fly that has not started is cut to its end). Expected: no zoom change above STEP_BAR and no
  // pitch / heading change above 1° that no native animation made; the flown framing held at the end.
  const flyKinds: [string, (h: HU) => void, number][] = [
    ["the loop's 280 ms repair fly (a foreign write to z 12)", (h) => native(h, { zoomLevel: 12 }), 16.8],
    ["the Crew 1.8 s return (wide crew)", (h) => h.crew(), 16.8],
    ["the Crew return re-aimed by a '+' 1.5 s into it", (h) => { h.crew(); h.advance(8500); h.press(0.5); }, 17.3],
    ["the short fly a recenter starts inside crewFit's easeTo (nearby crew)", (h) => { h.C.__peers = []; h.crew(); h.advance(300); h.gesture({ kind: "recenter" }); }, 16.8],
  ];
  let fi = 0;
  for (const [name, act, wz] of flyKinds) for (const android of [false, true]) {
    const per: string[] = []; let pass = true;
    for (const D of [0, 150, 300, 600]) {
      const h = hPark(unit({ android, animStartDelayMs: D }));
      const t0 = h.now; act(h); h.advance(12000);
      const z = h.maxCut(t0 + 20, h.now), p = h.maxPitchCut(t0 + 20, h.now), hd = h.maxHeadingCut(t0 + 20, h.now);
      const good = z.m <= STEP_BAR && p.m <= 1 && hd.m <= 1 && at3(h, wz, 45, 90);
      if (!good) pass = false;
      per.push(`${D} ms: ${good ? "ok" : "FAIL"} zoom ${f3(z.m)} pitch ${p.m.toFixed(1)}° heading ${hd.m.toFixed(1)}°, end ${poseOf(h)}`);
    }
    ok(`FL${++fi}`, `${name}, native start 0 / 150 / 300 / 600 ms late, parked: the landing never cuts the fly (${android ? "Android" : "iOS"})`, pass, `(${per.join(" | ")})`);
  }

  // RN — a driver who taps again right after a repair is NOT rationed (verify_zoom_storm_1 ration3/4/5): Codex's lost
  // write (Crew, nearby crew, recenter at +720 ms, 150 ms native start delay) ×6, G ms apart, each corrective write
  // followed D ms later by a second owner intent; then a 7th lost write. e492b0e1 (iOS): the six superseded tries stayed
  // "unconfirmed", the 7th was rationed — the camera left at the Crew pose 17–44 s. Expected: home within 1 s of the
  // 7th's animations (the longest stretch off 16.8/45/90 after them ≤ 1000 ms).
  let ni = 0;
  for (const android of [false, true]) for (const [kind, D, G] of [["recenter", 100, 2500], ["recenter", 100, 4000], ["recenter", 550, 4000], ["recenter", 100, 7000], ["compass ×2", 200, 7000], ["AppState re-assert", 43, 7000]] as const) {
    const h = hPark(unit({ android, animStartDelayMs: 150 }));
    h.C.__peers = [];
    const t0 = h.now; let seen = 0, n2 = 0;
    const intent = () => { if (kind === "recenter") h.gesture({ kind: "recenter" }); else if (kind === "AppState re-assert") h.reassert(); else { h.gesture({ kind: "compass" }); h.advance(150); h.gesture({ kind: "compass" }); } n2++; };
    const runUntil = (t: number) => { while (h.now < t) { h.advance(10); const tries = h.rows(/cam-repair surf=car op=(push|fly)/).length; if (tries > seen) { seen = tries; h.advance(D); intent(); } } };
    for (let k = 0; k < 6; k++) { runUntil(t0 + k * G); h.crew(); h.advance(720); h.gesture({ kind: "recenter" }); }
    runUntil(t0 + 6 * G);
    h.crew(); h.advance(720); h.gesture({ kind: "recenter" }); const tl = h.now;
    h.advance(70000);
    let run = 0, best = 0, prev = -1;
    for (const f of h.frames) { if (f.t < tl + 1500) continue; if (Math.abs(f.zoom - 16.8) > 0.05 || Math.abs(f.pitch - 45) > 1 || angOff(f.heading, 90) > 1) { run += prev < 0 ? 0 : f.t - prev; best = Math.max(best, run); } else run = 0; prev = f.t; }
    const rr = repairRows(h, tl, h.now);
    ok(`RN${++ni}`, `Codex's lost write ×6, ${G} ms apart, each repair followed ${D} ms later by a second ${kind}; then a 7th lost write (150 ms native start delay, nearby crew, parked): the 7th is repaired, not rationed (${android ? "Android" : "iOS"})`,
      best <= 1000, `(${n2} second intents; 7th lost write → longest stretch off 16.8/45/90 ${Math.round(best)} ms; loop after it ${ops(rr)})`);
  }

  const unres = new Set<string>(); for (const h of all) for (const u of h.unresolved) unres.add(u);
  ok("DLZ", "the lifted production code resolved every identifier it read", unres.size === 0, unres.size ? `(unresolved: ${[...unres].join(", ")})` : "");
  return R;
}
