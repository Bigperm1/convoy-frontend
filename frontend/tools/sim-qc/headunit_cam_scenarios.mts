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

  // ── the harness itself: every identifier the lifted production code read resolved ─────────────────────────────
  const unres = new Set<string>(); for (const h of all) for (const u of h.unresolved) unres.add(u);
  ok("Z1", "the lifted production code resolved every identifier it read", unres.size === 0, unres.size ? `(unresolved: ${[...unres].join(", ")})` : "");
  return R;
}
