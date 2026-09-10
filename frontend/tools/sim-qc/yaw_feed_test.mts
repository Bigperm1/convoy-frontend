// yaw_feed_test — the DeviceMotion → cumulative-yaw reducer (src/yawFeed.ts), clocked by the
// SENSOR's timestamps. Codex 2026-09-10: a frozen sensor whose cached value keeps being
// re-dispatched must not look fresh, and bunched JS delivery must not compress real intervals.
import { yawFeedStart, yawFeedStep, yawFeedIntegral, yawFeedMeanDps, yawFeedSourceDiffDeg, YAW_STALE_MS, YAW_LOCK_DEG, YAW_UNLOCK_DEG } from "../../src/yawFeed.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const near = (a: number | null | undefined, b: number, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;
const FLAT = { x: 0, y: 0, z: 9.8 };

// A. fused attitude: deltas accumulate on the sensor clock; wrap at ±π is a small step
{
  let st = yawFeedStart(); let wall = 1_000_000;
  const rad = (deg: number) => deg * Math.PI / 180;
  st = yawFeedStep(st, { rotation: { alpha: rad(10), timestamp: 100.00 } }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: rad(12), timestamp: 100.05 } }, "ios", wall += 50);
  ok("A1 first sample seeds, second adds +2°", near(st.cumDeg, 2, 1e-9), `${st.cumDeg}`);
  ok("A2 rate over the SENSOR interval = 40°/s", near(st.lastDps, 40, 1e-6), `${st.lastDps}`);
  st = yawFeedStep(st, { rotation: { alpha: rad(179), timestamp: 100.10 } }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: rad(-179), timestamp: 100.15 } }, "ios", wall += 50);
  ok("A3 +179 → −179 wraps to +2°, not −358", near(st.cumDeg, 2 + 167 + 2, 1e-6), `${st.cumDeg}`);
  const integ = yawFeedIntegral(st, wall);
  ok("A4 integral carries the sensor time in ms", integ != null && near(integ.atMs, 100150, 1e-6) && near(integ.cumDeg, st.cumDeg), JSON.stringify(integ));
}
// B. a CACHED sample (same timestamp) re-dispatched by Android is not new: no delta, no freshness
{
  let st = yawFeedStart(); let wall = 2_000_000;
  st = yawFeedStep(st, { rotation: { alpha: 0.5, timestamp: 50.00 } }, "android", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.6, timestamp: 50.05 } }, "android", wall += 50);
  const before = st;
  for (let i = 0; i < 20; i++) st = yawFeedStep(st, { rotation: { alpha: 0.6, timestamp: 50.05 } }, "android", wall += 50);
  ok("B1 20 re-dispatches of the same sample change nothing (same state object)", st === before);
  ok("B2 …and after 1 s of only cached samples the integral is STALE (null)", yawFeedIntegral(st, wall) === null, `age=${wall - st.advancedAtMs} ms`);
  ok("B3 …and the mean rate is null too", yawFeedMeanDps(st, wall) === null);
  st = yawFeedStep(st, { rotation: { alpha: 0.7, timestamp: 51.10 } }, "android", wall += 50);
  ok("B4 a genuinely new sample revives it", yawFeedIntegral(st, wall) != null && st.samples === 3);
}
// C. bunched JS delivery: two callbacks 1 ms apart carrying samples 50 ms apart → the interval is 50 ms
{
  let st = yawFeedStart(); let wall = 3_000_000;
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 10.00 } }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.05, timestamp: 10.05 } }, "ios", wall + 1);
  ok("C1 rate from the sensor clock (≈57°/s), not from 1 ms of wall time", near(st.lastDps, 0.05 * 180 / Math.PI / 0.05, 1e-6), `${st.lastDps}`);
}
// D. fallback: no attitude → rotationRate about gravity integrated at the sensor interval
{
  let st = yawFeedStart(); let wall = 4_000_000;
  st = yawFeedStep(st, { rotationRate: { alpha: 20, beta: 0, gamma: 0, timestamp: 1.00 }, accelerationIncludingGravity: FLAT }, "ios", wall);
  st = yawFeedStep(st, { rotationRate: { alpha: 20, beta: 0, gamma: 0, timestamp: 1.05 }, accelerationIncludingGravity: FLAT }, "ios", wall += 50);
  ok("D1 rate path: 20°/s × 50 ms = 1° (ω·ĝ with ĝ up here ⇒ folded to −1° ccw)", near(st.cumDeg, -1, 1e-9) && st.src === "rate", `${st.cumDeg} ${st.src}`);
  ok("D2 no sample at all → unchanged", yawFeedStep(st, null, "ios", wall) === st);
}
// E. freshness is wall-clock since the last ADVANCING sample
{
  let st = yawFeedStart(); let wall = 5_000_000;
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 7.00 } }, "ios", wall);
  ok("E1 fresh within the window", yawFeedIntegral(st, wall + YAW_STALE_MS) != null);
  ok("E2 stale one ms past it", yawFeedIntegral(st, wall + YAW_STALE_MS + 1) === null);
}
// F. the windowed mean smooths a vibrating sample train: ±35°/s alternating at 20 Hz → mean ≈ 0
{
  let st = yawFeedStart(); let wall = 6_000_000; let alpha = 0;
  for (let i = 1; i <= 20; i++) { alpha += (i % 2 ? 0.0305 : -0.0305); st = yawFeedStep(st, { rotation: { alpha, timestamp: 20 + i * 0.05 } }, "ios", wall += 50); }
  const mean = yawFeedMeanDps(st, wall);
  ok("F1 alternating ±35°/s samples: windowed mean |rate| < 5°/s", mean != null && Math.abs(mean) < 5, `${mean?.toFixed(1)}`);
  ok("F2 …while the cumulative stays bounded (< 2°)", Math.abs(st.cumDeg) < 2, `${st.cumDeg.toFixed(2)}`);
}
// G. Codex 3rd pass: the attitude STALLS (cached rotation event) while the gyro keeps advancing →
//    after YAW_ATT_STALL_S the gyro carries the integral; when the attitude returns it re-seeds
//    without adding the stalled interval as one jump.
{
  let st = yawFeedStart(); let wall = 7_000_000;
  const rot = (alpha: number, ts: number) => ({ alpha, timestamp: ts });
  const gyro = (dps: number, ts: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: ts }, accelerationIncludingGravity: FLAT });   // ω·ĝ(down) = -dps ⇒ ccw +dps
  st = yawFeedStep(st, { rotation: rot(0.00, 1.00), ...gyro(0, 1.00) }, "ios", wall);
  st = yawFeedStep(st, { rotation: rot(0.02, 1.05), ...gyro(0, 1.05) }, "ios", wall += 50);
  const cumBefore = st.cumDeg;
  // attitude frozen at ts 1.05 / alpha 0.02; the gyro reports a steady 30°/s ccw for 1 s
  for (let i = 1; i <= 20; i++) st = yawFeedStep(st, { rotation: rot(0.02, 1.05), ...gyro(30, 1.05 + i * 0.05) }, "ios", wall += 50);
  ok("G1 stalled attitude + live gyro: the integral keeps advancing (src=rate)", st.src === "rate" && st.samples > 3, `src=${st.src} samples=${st.samples}`);
  ok("G2 …stays fresh", yawFeedIntegral(st, wall) != null);
  // ANGLE CONSERVATION (Codex 4th pass): 1.0 s at 30°/s = 30°, including the stall window before
  // the switch (reconciled from the remembered gyro samples) — nothing lost across the switch.
  ok("G3 …and no angle is lost across the switch: 30°/s × 1.0 s = 30° (±1°)", Math.abs(st.cumDeg - cumBefore - 30) < 1, `${(st.cumDeg - cumBefore).toFixed(1)}°`);
  // the attitude comes back with alpha 0.60 rad (≈34° — the turn it missed): must NOT add 34° again;
  // the gyro sample delivered beside it fills the 50 ms gap since the last integrated time (1.5°).
  const cumAtReturn = st.cumDeg;
  st = yawFeedStep(st, { rotation: rot(0.60, 2.10), ...gyro(30, 2.10) }, "ios", wall += 50);
  ok("G4 attitude returns: only the 50 ms gap is covered (+1.5° from the gyro beside it), no 34° jump", near(st.cumDeg - cumAtReturn, 1.5, 1e-6), `Δ=${(st.cumDeg - cumAtReturn).toFixed(2)} src=${st.src}`);
  st = yawFeedStep(st, { rotation: rot(0.62, 2.15), ...gyro(30, 2.15) }, "ios", wall += 50);
  // (the stale 1.05 cursor aged out of the 1 s pool, so ownership returns one sample later — with
  //  the gyro covering that sample: 2.05→2.15 at 30°/s = 3.0°, nothing lost, nothing doubled)
  // the attitude took over AT the return (zero-length handoff); from here its own deltas count (1.146°/sample in this test)
  ok("G5 …and the next sample adds the attitude's own delta: 1.5° + 1.146°", near(st.cumDeg - cumAtReturn, 1.5 + 0.02 * 180 / Math.PI, 1e-6) && st.src === "att", `${(st.cumDeg - cumAtReturn).toFixed(3)} src=${st.src}`);
  st = yawFeedStep(st, { rotation: rot(0.64, 2.20), ...gyro(30, 2.20) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: rot(0.66, 2.25), ...gyro(30, 2.25) }, "ios", wall += 50);
  // (this test's attitude stream steps 0.02 rad = 1.146° per sample while its gyro says 1.5°: once the
  //  attitude owns again its OWN deltas count — 3.0° gyro-covered + 2 × 1.146°)
  ok("G5b …and two more samples add 2 × 1.146°", st.src === "att" && Math.abs(st.cumDeg - cumAtReturn - (1.5 + 3 * 0.02 * 180 / Math.PI)) < 0.01, `${(st.cumDeg - cumAtReturn).toFixed(3)} src=${st.src}`);
}
// G6. three stall/return cycles during a steady 20°/s turn: total angle conserved within 2°
{
  let st = yawFeedStart(); let wall = 7_500_000; let alpha = 0; let ts = 10.0;
  let frozen: { alpha: number; timestamp: number } | null = null;   // a stalled sensor repeats its LAST sample verbatim
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  const step = (attFresh: boolean) => {
    ts += 0.05; alpha += (20 * Math.PI / 180) * 0.05;   // true attitude keeps turning at 20°/s
    if (attFresh) frozen = null; else if (!frozen) frozen = { alpha: alpha - (20 * Math.PI / 180) * 0.05, timestamp: ts - 0.05 };
    st = yawFeedStep(st, { rotation: attFresh ? { alpha, timestamp: ts } : frozen!, ...gyro(20, ts) }, "ios", wall += 50);
  };
  for (let cycle = 0; cycle < 3; cycle++) { for (let i = 0; i < 20; i++) step(true); for (let i = 0; i < 20; i++) step(false); }
  const expected = 20 * (ts - 10.0);
  ok("G6 three stall/return cycles at 20°/s: angle conserved within 2°", Math.abs(st.cumDeg - expected) < 2, `${st.cumDeg.toFixed(1)}° vs ${expected.toFixed(1)}°`);
}
// G7. Codex 5th pass: the attitude returns BEHIND the gyro cursor (independent Android timestamps):
//     gyro covered 10.0→11.0 at 30°/s; attitude returns stamped 10.8, then 11.1 → total must be
//     30°/s × 1.1 s = 33°, not 39° (the overlap 10.8→11.0 must not be integrated twice).
{
  let st = yawFeedStart(); let wall = 9_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 9.95 }, ...gyro(30, 9.95) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 10.00 }, ...gyro(30, 10.00) }, "ios", wall += 50);   // +1.5°
  const base = st.cumDeg;
  // attitude frozen at 10.00; gyro runs 10.05 … 11.00 (switch after 0.25 s, history reconciles the rest)
  for (let i = 1; i <= 20; i++) st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 10.00 }, ...gyro(30, 10 + i * 0.05) }, "ios", wall += 50);
  ok("G7a gyro carried 10.0→11.0: +30°", Math.abs(st.cumDeg - base - 30) < 1e-6, `${(st.cumDeg - base).toFixed(2)}`);
  // late attitude sample stamped 10.8 (behind the cursor at 11.0): re-seed only
  const a108 = 0.0262 + (30 * Math.PI / 180) * 0.8;
  st = yawFeedStep(st, { rotation: { alpha: a108, timestamp: 10.80 } }, "ios", wall += 50);
  ok("G7b behind-the-cursor attitude adds nothing and keeps gyro ownership", Math.abs(st.cumDeg - base - 30) < 1e-6 && st.src === "rate", `${(st.cumDeg - base).toFixed(2)} src=${st.src}`);
  // next attitude 11.1 (0.3 s after its cursor, of which only 11.0→11.1 is uncovered): +3°, not +9°
  const a111 = 0.0262 + (30 * Math.PI / 180) * 1.1;
  st = yawFeedStep(st, { rotation: { alpha: a111, timestamp: 11.10 }, ...gyro(30, 11.10) }, "ios", wall += 50);
  ok("G7c the overlap is never integrated twice: total 33° (±0.5)", Math.abs(st.cumDeg - base - 33) < 0.5, `${(st.cumDeg - base).toFixed(2)} src=${st.src}`);
}
// I. GIMBAL GUARD: with the phone standing upright (pitch 85°) the attitude is ignored, the gyro
//    carries the integral, and the shadow integral / pitch are reported.
{
  let st = yawFeedStart(); let wall = 10_000_000;
  const UP = { x: 0, y: -9.8, z: 0 };   // portrait upright: gravity along -y
  for (let i = 0; i <= 10; i++) st = yawFeedStep(st, { rotation: { alpha: 1.0 + i * 0.5, beta: 85 * Math.PI / 180, gamma: 0, timestamp: 1 + i * 0.05 }, rotationRate: { alpha: 0, beta: -20, gamma: 0, timestamp: 1 + i * 0.05 }, accelerationIncludingGravity: UP }, "ios", wall += 50);
  ok("I1 upright phone: locked, attitude ignored, gyro carries (src=rate)", st.locked && st.src === "rate", `lock=${st.locked} src=${st.src}`);
  ok("I2 …integral = gyro only (10 × 50 ms × ccw rate), not the wild Euler yaw", Math.abs(st.cumDeg - st.rateCumDeg) < 1e-9 && Math.abs(st.cumDeg) > 5, `cum=${st.cumDeg.toFixed(1)} shadow=${st.rateCumDeg.toFixed(1)}`);
  ok("I3 …pitch reported ≈85°", st.pitchRad != null && Math.abs(st.pitchRad * 180 / Math.PI - 85) < 1e-6);
}
// I4. Codex 6th pass: the guard oscillating 81°/79° every sample, fresh gyro on the locked callbacks
//     and a CACHED gyro on the unlocked ones, during a 30°/s turn for 1 s → the full 30° must survive
//     (no unfilled interval is ever skipped) — and with hysteresis the guard does not flip at all.
{
  let st = yawFeedStart(); let wall = 12_000_000;
  const UPish = (deg: number) => ({ x: 0, y: -9.8 * Math.sin(deg * Math.PI / 180), z: -9.8 * Math.cos(deg * Math.PI / 180) });
  let att = 0, lastGyroTs = 0.95, flips = 0, prevLocked: boolean | null = null;
  for (let i = 0; i <= 20; i++) {
    const t = 1 + i * 0.05; const pitchDeg = i % 2 === 0 ? 81 : 79;
    att += (30 * Math.PI / 180) * 0.05;                                   // the true attitude keeps turning
    const gyroTs = i % 2 === 0 ? t : lastGyroTs;                         // fresh on the "locked" samples, cached otherwise
    if (i % 2 === 0) lastGyroTs = t;
    // ω about the vertical: with the phone tilted the ccw rate projects onto -y/-z; keep it simple — pure yaw about the
    // gravity axis: ω = 30°/s × ĝ_up ⇒ ω·ĝ_down = -30
    const g = UPish(pitchDeg); const n = 9.8;
    st = yawFeedStep(st, { rotation: { alpha: att, beta: pitchDeg * Math.PI / 180, gamma: 0, timestamp: t },
      rotationRate: { alpha: 30 * (-g.z / n), beta: 30 * (-g.y / n), gamma: 0, timestamp: gyroTs }, accelerationIncludingGravity: g }, "ios", wall += 50);
    if (prevLocked != null && st.locked !== prevLocked) flips++;
    prevLocked = st.locked;
  }
  ok("I4a hysteresis: the guard did not flip between 81° and 79°", flips === 0 && st.locked, `flips=${flips} locked=${st.locked}`);
  ok("I4b a 30°/s turn over 1 s is conserved through the oscillation (≥ 28.5°, gyro-carried at 20 Hz on every other sample)", st.cumDeg > 28.4 && st.cumDeg <= 30.01, `${st.cumDeg.toFixed(2)}° shadow=${st.rateCumDeg.toFixed(2)}`);
}
// I5. returning attitude WITHOUT a fresh gyro sample beside it: no unfilled interval is skipped
{
  let st = yawFeedStart(); let wall = 13_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.00) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 1.05 }, ...gyro(30, 1.05) }, "ios", wall += 50);
  const base = st.cumDeg;
  for (let i = 1; i <= 10; i++) st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 1.05 }, ...gyro(30, 1.05 + i * 0.05) }, "ios", wall += 50);   // stall, gyro to 1.55
  // attitude returns stamped 1.65 with the CACHED gyro (ts 1.55): must not advance past 1.55
  st = yawFeedStep(st, { rotation: { alpha: 0.0262 + (30 * Math.PI / 180) * 0.6, timestamp: 1.65 }, ...gyro(30, 1.55) }, "ios", wall += 50);
  ok("I5a returning attitude with only a STALE cursor (0.6 s span) waits — the gyro still owns at 1.55, 15° so far", st.src === "rate" && Math.abs((st.sensorS ?? 0) - 1.55) < 1e-9 && Math.abs(st.cumDeg - base - 15) < 0.01, `${(st.cumDeg - base).toFixed(2)}° src=${st.src} through=${st.sensorS}`);
  st = yawFeedStep(st, { rotation: { alpha: 0.0262 + (30 * Math.PI / 180) * 0.6, timestamp: 1.65 }, ...gyro(30, 1.65) }, "ios", wall += 50);   // gyro catches up to 1.65
  st = yawFeedStep(st, { rotation: { alpha: 0.0262 + (30 * Math.PI / 180) * 0.7, timestamp: 1.75 }, ...gyro(30, 1.75) }, "ios", wall += 50);   // attitude resumes
  ok("I5b …and the full 0.7 s at 30°/s = 21° is conserved (±0.01)", Math.abs(st.cumDeg - base - 21) < 0.01 && st.src === "att", `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
}
// I6. Codex 7th pass: TWO attitude samples arrive before the gyro catches up → nothing skipped.
//     gyro through 1.55 (30°/s); attitude 1.65 and 1.75 with the gyro still cached at 1.55; then the gyro
//     catches up to 1.75 and the attitude resumes at 1.85 → 30°/s × 0.8 s = 24° conserved.
{
  let st = yawFeedStart(); let wall = 14_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  const A = (dt: number) => 0.0262 + (30 * Math.PI / 180) * dt;
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.00) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 1.05 }, ...gyro(30, 1.05) }, "ios", wall += 50);
  const base = st.cumDeg;
  for (let i = 1; i <= 10; i++) st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 1.05 }, ...gyro(30, 1.05 + i * 0.05) }, "ios", wall += 50);   // stall; gyro to 1.55
  st = yawFeedStep(st, { rotation: { alpha: A(0.6), timestamp: 1.65 }, ...gyro(30, 1.55) }, "ios", wall += 50);   // cached gyro
  st = yawFeedStep(st, { rotation: { alpha: A(0.7), timestamp: 1.75 }, ...gyro(30, 1.55) }, "ios", wall += 50);   // still cached
  ok("I6a two attitudes before catch-up, stale cursor: both wait — gyro owns at 1.55, 15° so far", st.src === "rate" && Math.abs((st.sensorS ?? 0) - 1.55) < 1e-9 && Math.abs(st.cumDeg - base - 15) < 0.01, `${(st.cumDeg - base).toFixed(2)}° src=${st.src} through=${st.sensorS}`);
  st = yawFeedStep(st, { rotation: { alpha: A(0.7), timestamp: 1.75 }, ...gyro(30, 1.65) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: A(0.7), timestamp: 1.75 }, ...gyro(30, 1.75) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: A(0.8), timestamp: 1.85 }, ...gyro(30, 1.85) }, "ios", wall += 50);
  ok("I6b …after catch-up the attitude takes over: 0.8 s × 30°/s = 24° conserved (±0.01)", Math.abs(st.cumDeg - base - 24) < 0.01 && st.src === "att", `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
}
// I7. Codex 7th pass: the turn STOPS during the handoff — 30°/s through 11.0 then 0°/s; a returning
//     attitude at 10.8 (behind) and 11.1 must give 30°, not 32° (no share of the finished turn is
//     re-allocated to the stationary interval).
{
  let st = yawFeedStart(); let wall = 15_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 9.95 }, ...gyro(30, 9.95) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 10.00 }, ...gyro(30, 10.00) }, "ios", wall += 50);
  const base = st.cumDeg;
  for (let i = 1; i <= 20; i++) st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 10.00 }, ...gyro(30, 10 + i * 0.05) }, "ios", wall += 50);   // +30° to 11.0
  for (let i = 1; i <= 2; i++) st = yawFeedStep(st, { rotation: { alpha: 0.0262, timestamp: 10.00 }, ...gyro(0, 11 + i * 0.05) }, "ios", wall += 50);     // stopped, gyro to 11.1
  const a108 = 0.0262 + (30 * Math.PI / 180) * 0.8, a111 = 0.0262 + (30 * Math.PI / 180) * 1.0;   // true attitude: turned 30° by 11.0, then still
  st = yawFeedStep(st, { rotation: { alpha: a108, timestamp: 10.80 } }, "ios", wall += 50);            // behind the cursor: re-seed
  st = yawFeedStep(st, { rotation: { alpha: a111, timestamp: 11.10 }, ...gyro(0, 11.10) }, "ios", wall += 50);
  ok("I7 turn stopped during the handoff: total 30° (±0.01), not 32°", Math.abs(st.cumDeg - base - 30) < 0.01, `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
}
// I8. Codex 8th pass: both streams advancing every 50 ms with the attitude a fixed 75 ms AHEAD of the
//     gyro while the gyro owns → the attitude must take ownership back within a few samples and the
//     angle (20°/s) is conserved.
{
  let st = yawFeedStart(); let wall = 16_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  // start in gyro ownership: no attitude for the first two samples
  st = yawFeedStep(st, { ...gyro(20, 1.00) }, "ios", wall);
  st = yawFeedStep(st, { ...gyro(20, 1.05) }, "ios", wall += 50);
  const base = st.cumDeg; let tookOverAt: number | null = null;
  for (let i = 1; i <= 40; i++) {
    const tg = 1.05 + i * 0.05, ta = tg + 0.075;
    st = yawFeedStep(st, { rotation: { alpha: (20 * Math.PI / 180) * (ta - 1.0), timestamp: ta }, ...gyro(20, tg) }, "ios", wall += 50);
    if (tookOverAt == null && st.src === "att") tookOverAt = i;
  }
  ok("I8a the attitude takes ownership back within 10 samples", tookOverAt != null && tookOverAt <= 10, `tookOverAt=${tookOverAt}`);
  const expected = 20 * ((1.05 + 40 * 0.05 + 0.075) - 1.05);
  ok("I8b …and the angle is conserved (±0.6° ≈ one 0.075 s tail at 20°/s)", Math.abs(st.cumDeg - base - expected) < 0.6, `${(st.cumDeg - base).toFixed(2)}° vs ${expected.toFixed(2)}° src=${st.src}`);
}
// I9. Codex 9th pass: a stale pooled cursor (0.875 s old) must not scale a turn that already ended into a
//     stationary 75 ms tail. Gyro owns from 1.0 (pooled attitude 0° at 1.0), 30°/s through 1.75, then 0;
//     attitude returns at 1.875 (22.5°) with the gyro cached at 1.8 → total stays 22.5° (±1.5° = one sample).
{
  let st = yawFeedStart(); let wall = 17_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { ...gyro(30, 0.95) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.00) }, "ios", wall += 50);   // gyro owns; attitude pooled at 1.0
  const base = st.cumDeg;
  for (let i = 1; i <= 15; i++) st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1 + i * 0.05) }, "ios", wall += 50);   // to 1.75: +22.5°
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(0, 1.80) }, "ios", wall += 50);                                          // stopped
  st = yawFeedStep(st, { rotation: { alpha: 22.5 * Math.PI / 180, timestamp: 1.875 }, ...gyro(0, 1.80) }, "ios", wall += 50);                    // returns, cached gyro
  ok("I9a stale cursor + stationary tail: no reallocation (22.5° ±1.5°)", Math.abs(st.cumDeg - base - 22.5) < 1.5, `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
  st = yawFeedStep(st, { rotation: { alpha: 22.5 * Math.PI / 180, timestamp: 1.925 }, ...gyro(0, 1.90) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: 22.5 * Math.PI / 180, timestamp: 1.975 }, ...gyro(0, 1.95) }, "ios", wall += 50);
  ok("I9b …and the attitude retakes ownership on fresh samples with the total still 22.5° (±1.5°)", st.src === "att" && Math.abs(st.cumDeg - base - 22.5) < 1.5, `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
}
// I10. Codex 10th pass: DEAD gyro + stale cursor + stationary tail → no reallocation. Pooled attitude at
//      1.0; gyro 30°/s through 1.5, stationary at 1.55, then dead; attitude returns at 1.85 reporting the
//      true 15° → total 15° (±1.5°).
{
  let st = yawFeedStart(); let wall = 18_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { ...gyro(30, 0.95) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.00) }, "ios", wall += 50);
  const base = st.cumDeg;
  for (let i = 1; i <= 10; i++) st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1 + i * 0.05) }, "ios", wall += 50);   // +15° to 1.5
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(0, 1.55) }, "ios", wall += 50);                                          // stationary; then the gyro dies
  st = yawFeedStep(st, { rotation: { alpha: 15 * Math.PI / 180, timestamp: 1.85 } }, "ios", wall += 300);                                          // returns, gyro dead (0.3 s)
  ok("I10 dead gyro + stale cursor: stationary tail not reallocated (15° ±1.5°)", Math.abs(st.cumDeg - base - 15) < 1.5, `${(st.cumDeg - base).toFixed(2)}° src=${st.src}`);
}
// I11. Codex 10th pass: exactly 0.1 s ahead at a large sensor uptime (10 000 s) — floating-point slack
//      must not block a healthy attitude: takeover within a few samples, angle conserved.
{
  let st = yawFeedStart(); let wall = 19_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { ...gyro(20, 10000.00) }, "ios", wall);
  st = yawFeedStep(st, { ...gyro(20, 10000.05) }, "ios", wall += 50);
  const base = st.cumDeg; let tookOverAt: number | null = null;
  for (let i = 1; i <= 40; i++) {
    const tg = 10000.05 + i * 0.05, ta = tg + 0.1;
    st = yawFeedStep(st, { rotation: { alpha: (20 * Math.PI / 180) * (ta - 10000), timestamp: ta }, ...gyro(20, tg) }, "ios", wall += 50);
    if (tookOverAt == null && st.src === "att") tookOverAt = i;
  }
  ok("I11a exactly 100 ms ahead at uptime 10 000 s: takeover within 10 samples", tookOverAt != null && tookOverAt <= 10, `tookOverAt=${tookOverAt}`);
  const expected = 20 * ((10000.05 + 40 * 0.05 + 0.1) - 10000.05);
  ok("I11b …angle conserved (±0.6°)", Math.abs(st.cumDeg - base - expected) < 0.6, `${(st.cumDeg - base).toFixed(2)}° vs ${expected.toFixed(2)}° src=${st.src}`);
}
// I12. Codex 11th pass: a LATE attitude sample (stamped behind gyro samples already buffered) must not
//      erase the buffered gyro history; a stall right after must still reconcile the turn.
//      attitude 0° @1.00; gyro 30°/s @1.05, @1.10 (attitude cached); attitude 0.75° @1.025 with gyro 0 @1.15;
//      attitude frozen, gyro 0 through 1.35 → total 3.0° (0.75° attitude + 2.25° gyro), not 0.75°.
{
  let st = yawFeedStart(); let wall = 20_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(0, 1.00) }, "ios", wall);
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.05) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: 0, timestamp: 1.00 }, ...gyro(30, 1.10) }, "ios", wall += 50);
  st = yawFeedStep(st, { rotation: { alpha: 0.75 * Math.PI / 180, timestamp: 1.025 }, ...gyro(0, 1.15) }, "ios", wall += 50);
  for (let i = 1; i <= 4; i++) st = yawFeedStep(st, { rotation: { alpha: 0.75 * Math.PI / 180, timestamp: 1.025 }, ...gyro(0, 1.15 + i * 0.05) }, "ios", wall += 50);
  ok("I12 late attitude then stall: 3.0° conserved (±0.05), not 0.75°", Math.abs(st.cumDeg - 3.0) < 0.05, `${st.cumDeg.toFixed(2)}° src=${st.src}`);
}
// I13. Codex 12th pass: the attitude a fixed 25 ms BEHIND the gyro (independent clocks, gyro integrates
//      first) must still take ownership back within a few samples, with the angle conserved.
{
  let st = yawFeedStart(); let wall = 21_000_000;
  const gyro = (dps: number, t: number) => ({ rotationRate: { alpha: -dps, beta: 0, gamma: 0, timestamp: t }, accelerationIncludingGravity: FLAT });
  st = yawFeedStep(st, { ...gyro(20, 1.00) }, "ios", wall);
  const base = st.cumDeg; let tookOverAt: number | null = null;
  for (let i = 1; i <= 40; i++) {
    const tg = 1 + i * 0.05, ta = tg - 0.025;
    st = yawFeedStep(st, { rotation: { alpha: (20 * Math.PI / 180) * (ta - 1), timestamp: ta }, ...gyro(20, tg) }, "ios", wall += 50);
    if (tookOverAt == null && st.src === "att") tookOverAt = i;
  }
  ok("I13a attitude 25 ms behind the gyro: takeover within 10 samples", tookOverAt != null && tookOverAt <= 10, `tookOverAt=${tookOverAt} src=${st.src}`);
  const expected = 20 * ((1 + 40 * 0.05) - 1);   // through the last gyro sample
  ok("I13b …angle conserved (±0.6°)", Math.abs(st.cumDeg - base - expected) < 0.6, `${(st.cumDeg - base).toFixed(2)}° vs ${expected.toFixed(2)}°`);
}
// J. the shadow integral: attitude feed vs gyro feed disagree by a slow slew → mdiff grows
{
  let st = yawFeedStart(); let wall = 11_000_000;
  for (let i = 0; i <= 20; i++) st = yawFeedStep(st, { rotation: { alpha: i * 0.01745 * 0.05 * 2, timestamp: 1 + i * 0.05 }, rotationRate: { alpha: 0, beta: 0, gamma: 0, timestamp: 1 + i * 0.05 }, accelerationIncludingGravity: FLAT }, "ios", wall += 50);   // attitude drifts 2°/s, gyro says 0
  const md = yawFeedSourceDiffDeg(st);
  ok("J1 mdiff = attitude − gyro ≈ 2°/s × 1 s = 2°", Math.abs(md - 2) < 0.05, `${md.toFixed(2)}`);
}
// H. one sign: a counter-clockwise turn is POSITIVE from both sources
{
  let a = yawFeedStart(), r = yawFeedStart(); let wall = 8_000_000;
  a = yawFeedStep(a, { rotation: { alpha: 0.0, timestamp: 1.00 } }, "ios", wall); a = yawFeedStep(a, { rotation: { alpha: 0.1, timestamp: 1.05 } }, "ios", wall += 50);
  // CoreMotion flat face-up: gravity (0,0,-1) ⇒ accelerationIncludingGravity z = -9.8; ω about +z (ccw) = +20°/s ⇒ ω·ĝ = -20
  const DOWN = { x: 0, y: 0, z: -9.8 };
  r = yawFeedStep(r, { rotationRate: { alpha: 20, beta: 0, gamma: 0, timestamp: 1.00 }, accelerationIncludingGravity: DOWN }, "ios", wall); r = yawFeedStep(r, { rotationRate: { alpha: 20, beta: 0, gamma: 0, timestamp: 1.05 }, accelerationIncludingGravity: DOWN }, "ios", wall += 50);
  ok("H1 attitude ccw turn → positive", a.cumDeg > 0, `${a.cumDeg.toFixed(2)}`);
  ok("H2 gyro ccw turn (ω·ĝ negative) → positive after the sign fold", r.cumDeg > 0, `${r.cumDeg.toFixed(2)}`);
}
console.log(fails === 0 ? "\nPASS yaw_feed" : `\nFAIL yaw_feed (${fails})`);
if (fails) process.exit(1);
