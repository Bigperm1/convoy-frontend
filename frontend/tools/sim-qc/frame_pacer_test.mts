// frame_pacer_test.mts — the nav draws at 60 fps on every panel (src/framePacer.ts; Jeff, 2026-09-23:
// "make sure the nav is stuck at 60fps for all 4 platforms").
//
// Drives frameDue() with synthetic vsync clocks (with jitter and JS-late callbacks) and checks:
//   - 60 Hz panels (iPhone, CarPlay, most car screens) are NEVER paced — every callback draws, even late ones;
//   - 75 / 90 / 120 / 144 Hz panels (Android phones, ProMotion, Android Auto heads) average 60 drawn frames a second;
//   - no two drawn frames are ever closer than 10 ms on a paced panel;
//   - an idle gap re-anchors instead of drawing a catch-up burst;
//   - navMapFps() gives Android a value that CHANGES after the first render (so rnmapbox's setter runs on a live
//     map), iOS a constant 60;
//   - E: the pacer TOGETHER with ConvoyMapbox's pump guard (armNextFrame: FAST_PUMP_MS / FAST_PUMP_RUN, read from the
//     source) still draws 60 when rAF callbacks run away at 0.5–3 ms — a flat 16 ms fallback settled at ~42 fps
//     (Codex review of 39cdbc34).
// Run: node --experimental-strip-types tools/sim-qc/frame_pacer_test.mts

import { readFileSync } from "node:fs";
import { createFramePacer, frameDue, msUntilDue, navMapFps, NAV_FPS } from "../../src/framePacer.ts";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

// Deterministic jitter (no Math.random in a gate).
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** Run `seconds` of callbacks on an `hz` panel. Each callback lands on its vsync + jitter (0…jitterMs late),
 *  and every `lateEvery`th one is `lateMs` late (a busy JS thread). Returns the drawn timestamps. */
function run(hz: number, seconds: number, jitterMs = 1, lateEvery = 0, lateMs = 0): { drawn: number[]; calls: number } {
  const p = createFramePacer();
  const period = 1000 / hz;
  const t0 = 1_000_000;
  const drawn: number[] = [];
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    let now = t0 + i * period + rnd() * jitterMs;
    if (lateEvery && i % lateEvery === lateEvery - 1) now += lateMs;
    if (frameDue(p, now)) drawn.push(now);
  }
  return { drawn, calls: n };
}
const fps = (d: number[], seconds: number) => d.length / seconds;
const minGap = (d: number[], from = 10) => {
  let m = Infinity;
  for (let i = Math.max(1, from); i < d.length; i++) m = Math.min(m, d[i] - d[i - 1]);
  return m;
};

console.log("A · 60 Hz panels are never paced");
{
  const r = run(60, 10, 1.5);
  ok("A1 60 Hz with vsync jitter: every callback draws", r.drawn.length === r.calls, `${r.drawn.length}/${r.calls}`);
  const late = run(60, 10, 1, 7, 12);
  ok("A2 60 Hz with a 12 ms-late callback every 7th frame: every callback still draws", late.drawn.length === late.calls, `${late.drawn.length}/${late.calls}`);
}
{
  const r75 = run(75, 10, 1);
  const f = fps(r75.drawn, 10);
  ok(`A3 75 Hz panel is capped too → ${f.toFixed(1)} fps (57…61)`, f >= 57 && f <= 61);
}

console.log("B · faster panels average 60");
for (const hz of [90, 120, 144]) {
  const r = run(hz, 10, 1);
  const f = fps(r.drawn, 10);
  ok(`B ${hz} Hz → ${f.toFixed(1)} fps drawn (57…61)`, f >= 57 && f <= 61);
  ok(`B ${hz} Hz → no two drawn frames closer than 10 ms`, minGap(r.drawn) >= 10 - 0.001, `min ${minGap(r.drawn).toFixed(2)} ms`);
}
{
  const r = run(120, 10, 1, 9, 6);
  const f = fps(r.drawn, 10);
  ok(`B 120 Hz with busy-JS late callbacks → ${f.toFixed(1)} fps (55…61)`, f >= 55 && f <= 61);
  ok("B 120 Hz with late callbacks → still never closer than 10 ms", minGap(r.drawn) >= 10 - 0.001, `min ${minGap(r.drawn).toFixed(2)} ms`);
}

console.log("C · idle / restart");
{
  const p = createFramePacer();
  const period = 1000 / 120;
  let t = 5_000_000;
  for (let i = 0; i < 60; i++) { frameDue(p, t); t += period; }
  // The loop idles for 1.2 s (ease finished), then restarts on the next GPS fix.
  t += 1200;
  const restart: number[] = [];
  for (let i = 0; i < 12; i++) { if (frameDue(p, t)) restart.push(t); t += period; }
  ok("C1 restart after an idle draws the first callback", restart.length > 0 && restart[0] === restart[0]);
  const g = restart.slice(1).map((x, i) => x - restart[i]);
  ok("C2 no catch-up burst after the idle (every drawn gap ≥ 10 ms)", g.every((x) => x >= 10 - 0.001), g.map((x) => x.toFixed(1)).join(","));
  ok("C3 the panel is remembered across the idle (still paced at 120 Hz)", restart.length <= 7, `${restart.length} drawn of 12 callbacks`);
}
{
  const p = createFramePacer();
  const first: boolean[] = [];
  for (let i = 0; i < 4; i++) first.push(frameDue(p, 9_000_000 + i * (1000 / 120)));
  ok("C4 before the panel is measured, every callback draws (no pacing on a guess)", first.every(Boolean));
}

console.log("D · navMapFps (the Android preferredFramesPerSecond re-send)");
ok("D1 iOS: the cap from the first render", navMapFps("ios", false) === NAV_FPS && navMapFps("ios", true) === NAV_FPS);
ok("D2 Android: a different value on the first render", navMapFps("android", false) !== NAV_FPS);
ok("D3 Android: the cap once mounted (the prop CHANGES, so rnmapbox's setter runs on a live map)", navMapFps("android", true) === NAV_FPS);
ok("D4 NAV_FPS is 60", NAV_FPS === 60);
{
  const mbx = readFileSync(new URL("../../src/ConvoyMapbox.tsx", import.meta.url), "utf8");
  const car = readFileSync(new URL("../../src/carplay/CarMapView.tsx", import.meta.url), "utf8");
  const flip = /useEffect\(\(\) => \{ setFpsArmed\(true\); \}, \[\]\);/;
  ok("D5 both maps flip the cap after the FIRST RENDER, not on map load (tiles)", flip.test(mbx) && flip.test(car));
  ok("D6 both maps pass navMapFps(Platform.OS, fpsArmed)", /preferredFramesPerSecond=\{navMapFps\(Platform\.OS, fpsArmed\)\}/.test(mbx)
    && /preferredFramesPerSecond=\{navMapFps\(Platform\.OS, fpsArmed\)\}/.test(car));
}

console.log("E · the pacer with ConvoyMapbox's pump guard (runaway rAF)");
{
  const src = readFileSync(new URL("../../src/ConvoyMapbox.tsx", import.meta.url), "utf8");
  const FAST_PUMP_MS = Number(/const FAST_PUMP_MS = (\d+)/.exec(src)?.[1]);
  const FAST_PUMP_RUN = Number(/const FAST_PUMP_RUN = (\d+)/.exec(src)?.[1]);
  ok("E0 read the guard's constants from the source", FAST_PUMP_MS > 0 && FAST_PUMP_RUN > 0, `FAST_PUMP_MS=${FAST_PUMP_MS} FAST_PUMP_RUN=${FAST_PUMP_RUN}`);
  ok("E0b the timer fallback waits for the pacer's next slot", /setTimeout\(step, Math\.min\(16, Math\.max\(1, Math\.ceil\(msUntilDue\(pacerRef\.current, now\)\)\)\)\)/.test(src));

  /** Model of SelfCarModel.step + armNextFrame. `rafDelay(now)` = when the next rAF callback lands. */
  function sim(seconds: number, rafDelay: (now: number) => number) {
    const p = createFramePacer();
    let lastArmAt = 0, fastRun = 0;
    const drawn: number[] = [];
    let t = 7_000_000;
    const end = t + seconds * 1000;
    let nextAt = t;
    while (nextAt < end) {
      t = nextAt;
      if (frameDue(p, t)) drawn.push(t);
      // armNextFrame(), as in ConvoyMapbox
      const gap = t - lastArmAt; lastArmAt = t;
      if (gap < FAST_PUMP_MS) {
        if (++fastRun >= FAST_PUMP_RUN) {
          nextAt = t + Math.min(16, Math.max(1, Math.ceil(msUntilDue(p, t)))) + rnd() * 0.8; // timer jitter
          continue;
        }
      } else fastRun = 0;
      nextAt = rafDelay(t);
    }
    return drawn;
  }
  const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))]; };
  const gaps = (d: number[]) => d.slice(20).map((x, i) => x - d.slice(20)[i - 1]).slice(1);

  const runaway = sim(10, (now) => now + 0.5 + rnd() * 2.5);
  const fr = runaway.length / 10;
  const gr = gaps(runaway);
  ok(`E1 runaway rAF (0.5–3 ms callbacks) → ${fr.toFixed(1)} fps (57…61)`, fr >= 57 && fr <= 61);
  ok(`E2 runaway rAF → steady cadence: p90 draw gap ${pct(gr, 0.9).toFixed(1)} ms ≤ 21, min ${Math.min(...gr).toFixed(1)} ≥ 10`, pct(gr, 0.9) <= 21 && Math.min(...gr) >= 10 - 0.001);

  // Codex's exact repro: fixed 1 ms (and 0.5 ms) runaway callbacks. With the old flat 16 ms fallback these gave
  // 42.1 and 50.4 fps (measured 2026-09-23); slot-timed they hold 60.
  for (const cb of [0.5, 1]) {
    const d = sim(10, (now) => now + cb);
    ok(`E1b fixed ${cb} ms runaway callbacks → ${(d.length / 10).toFixed(1)} fps (57…61)`, d.length / 10 >= 57 && d.length / 10 <= 61);
  }

  const v120 = sim(10, (now) => Math.ceil((now + 0.01) / (1000 / 120)) * (1000 / 120) + rnd() * 0.8);
  ok(`E3 120 Hz vsync through the guard → ${(v120.length / 10).toFixed(1)} fps (57…61)`, v120.length / 10 >= 57 && v120.length / 10 <= 61);
  const v60 = sim(10, (now) => Math.ceil((now + 0.01) / (1000 / 60)) * (1000 / 60) + rnd() * 0.8);
  ok(`E4 60 Hz vsync through the guard → ${(v60.length / 10).toFixed(1)} fps (59…61)`, v60.length / 10 >= 59 && v60.length / 10 <= 61);
}

console.log(failed ? `\nFAIL frame_pacer (${failed})` : "\nPASS frame_pacer");
process.exit(failed ? 1 : 0);
