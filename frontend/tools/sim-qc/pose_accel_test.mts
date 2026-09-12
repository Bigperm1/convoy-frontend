// pose_accel_test — the drawn car must not fall behind under acceleration.
//
// Jeff, 2026-09-12: "the corners in the sequence before the highway at the start we were off
// the line and yesterday was good." Three independent agents converged on the same answer:
// the marker was not off the line SIDEWAYS (lateral median 1.2 m, p90 2.6 m — on the line).
// It was BEHIND itself ALONG the road: 12.8 / 10.0 / 11.2 m at the lot-exit corner on 09-12
// versus 5.9 / 6.0 / 6.1 m at the same corner on 09-11. In a corner, a car drawn 12 m back
// reads as still being on the leg before the turn — which is exactly "off the line".
//
// THE SUSPECTED MECHANISM, read from source: src/poseEstimator.ts:322 `const spd = st.spd;`
// — the dead-reckoning speed is the ACCEPTED speed of the LAST fix, and there is no
// acceleration term (used at :391-396). At 1 Hz fixes a sustained acceleration therefore
// leaves a standing position debt.
//
// THE FIELD LAW to reproduce (86 car-surface corner rows pooled over six drives of the same
// commute, binned by longitudinal acceleration; correlation with acceleration 0.472, with
// speed only 0.136):
//     -0.51 m/s^2  ->  1.6 m AHEAD
//     +0.30 m/s^2  ->  1.5 m behind
//     +1.46 m/s^2  ->  4.2 m behind
//     +3.12 m/s^2  ->  8.6 m behind
// On 09-12 Jeff left the lot at 11 -> 18 -> 30 km/h in two seconds, up to 3.31 m/s^2, the
// hardest acceleration in the whole sample, with three corners in the next 60 s.
//
// THE FIX, and what this gate locks in: posePredict now dead-reckons at
// `spd + spdAcc * min(POSE_ACC_HOLD_S, timeSinceFix)` instead of a flat `spd`, with spdAcc
// derived between the last two ACCEPTED fixes and clamped to ±POSE_ACC_MAX.
// BEFORE -> AFTER on this probe: 0.30 m/s² 1.9 -> 1.5 m; 1.46 m/s² 2.7 -> 0.9 m;
// 3.12 m/s² 4.7 -> 1.5 m. The 60-seed cornering suite in pose_estimator_test.mts is
// BIT-UNCHANGED by it (every Y/X/R assertion reports the identical number).
//
// ⚠ WHAT THIS GATE DOES NOT CLAIM. It does not close Jeff's field gap: he measured
// 12.8/10.0/11.2 m at that corner and the hardest synthetic case is a few metres. It also does
// not reproduce the field's "1.6 m AHEAD under braking" — the probe stays behind there, so the
// field law's negative-acceleration end is NOT explained by this mechanism. The render stall is
// the other, larger candidate and is UNPROVEN: 4,139 ms of no rendering puts the marker ~38 m
// behind in this same probe, an order of magnitude above the acceleration debt, but whether a
// `main-gap` actually stops posePredict on the car surface has not been established.
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
import {
  poseStart, posePredict, poseFix, poseOut, haversineM, stepLatLng, bearingDeg,
  POSE_ACC_HOLD_S, POSE_ACC_DECAY_S,
} from "../../src/poseEstimator.ts";

const T0 = 1_700_000_000_000;
const HZ = 20;                 // render rate
const FIX_HZ = 1;              // what iOS actually delivers (measured ~1 Hz, see the big-3 note)

type Sample = { lat: number; lng: number; t: number; spd: number };

/** A straight south run that accelerates from v0 to v1 at a constant rate, then holds v1. */
function accelStraight(v0: number, accel: number, seconds: number, holdS = 6): Sample[] {
  const out: Sample[] = [];
  let lat = 49.0330, lng = -122.2930, t = 0, v = v0;
  const dt = 1 / HZ;
  const vMax = v0 + accel * seconds;
  while (t <= seconds + holdS) {
    out.push({ lat, lng, t, spd: v });
    const p = stepLatLng(lat, lng, 180, v * dt);
    lat = p.lat; lng = p.lng; t += dt;
    v = t < seconds ? v0 + accel * t : vMax;
  }
  return out;
}

/**
 * Drive the SHIPPED estimator over a sample stream exactly the way the surfaces do, and return
 * the signed along-track error of the drawn point at each render frame. Positive = drawn car is
 * BEHIND the truth. `gapAtS` injects a render stall of `gapMs` (no posePredict calls) to model
 * the 4,139 ms main-gap that sits 2.1 s before Jeff's first complained-about corner.
 */
function drive(samples: Sample[], opts: { gapAtS?: number; gapMs?: number } = {}) {
  let st = poseStart();
  let lastFixT = -Infinity;
  const lag: { t: number; along: number; spd: number }[] = [];
  let skipUntil = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (opts.gapAtS != null && Math.abs(s.t - opts.gapAtS) < 1 / HZ / 2) {
      skipUntil = s.t + (opts.gapMs ?? 0) / 1000;
    }
    const now = T0 + s.t * 1000;
    // During a render stall the rAF loop does not run, so posePredict is never called. Fixes
    // still arrive (location events keep running — verified in the field: rows were still being
    // written from the phone inside the 21 s windows on 09-11).
    const stalled = s.t < skipUntil;
    if (!stalled) st = posePredict(st, now, null);
    if (s.t - lastFixT >= 1 / FIX_HZ - 1e-9) {
      const course = i > 0 ? bearingDeg(samples[Math.max(0, i - HZ)].lat, samples[Math.max(0, i - HZ)].lng, s.lat, s.lng) : null;
      st = poseFix(st, { lat: s.lat, lng: s.lng, at: now, accM: 5, speedMs: s.spd, courseDeg: course }, null);
      lastFixT = s.t;
    }
    if (stalled) continue;
    const o = poseOut(st);
    if (!o) continue;
    // Signed along-track: the run is due south, so a drawn point NORTH of truth is behind.
    const d = haversineM(o.lat, o.lng, s.lat, s.lng);
    const behind = o.lat > s.lat ? 1 : -1;
    lag.push({ t: s.t, along: d * behind, spd: s.spd });
  }
  return lag;
}

/** Steady-state lag: the median over the last 2 s of the accelerating phase. */
function steady(lag: { t: number; along: number }[], fromS: number, toS: number) {
  const w = lag.filter((x) => x.t >= fromS && x.t <= toS).map((x) => x.along).sort((a, b) => a - b);
  return w.length ? w[Math.floor(w.length / 2)] : NaN;
}

console.log("SHIPPED ESTIMATOR — signed along-track error, + = drawn car is BEHIND\n");
console.log("  accel m/s^2   v0->v1 km/h        measured lag   field law says");
const FIELD: Record<string, string> = { "-0.51": "1.6 m AHEAD", "0.30": "1.5 m behind", "1.46": "4.2 m behind", "3.12": "8.6 m behind" };
const CASES: { a: number; v0: number; secs: number }[] = [
  { a: -0.51, v0: 12, secs: 4 },
  { a: 0.30, v0: 5, secs: 6 },
  { a: 1.46, v0: 3, secs: 6 },
  { a: 3.12, v0: 3, secs: 5 },
  { a: 3.31, v0: 3.05, secs: 2 },   // Jeff's actual lot exit: 11 -> 18 -> 30 km/h in 2 s
];
for (const c of CASES) {
  const v1 = c.v0 + c.a * c.secs;
  const samples = accelStraight(c.v0, c.a, c.secs);
  const lag = drive(samples);
  const m = steady(lag, Math.max(0, c.secs - 2), c.secs);
  const key = c.a.toFixed(2);
  console.log(
    `  ${String(c.a).padStart(7)}      ${(c.v0 * 3.6).toFixed(0).padStart(3)} -> ${(v1 * 3.6).toFixed(0).padStart(3)}` +
    `          ${m >= 0 ? "+" : ""}${m.toFixed(1)} m`.padEnd(22) +
    (FIELD[key] ?? "(Jeff's lot exit, field 12.8/10.0/11.2 m)")
  );
}

console.log("\nTHE 4.1 s RENDER STALL — same hardest case, with the gap injected mid-acceleration");
const jeff = accelStraight(3.05, 3.31, 2);
const noGap = steady(drive(jeff), 0.5, 2);
const withGap = drive(jeff, { gapAtS: 0.5, gapMs: 4139 });
const afterGap = withGap.filter((x) => x.t > 4.6);
const peak = afterGap.length ? Math.max(...afterGap.map((x) => x.along)) : NaN;
console.log(`  no stall  : ${noGap >= 0 ? "+" : ""}${noGap.toFixed(1)} m`);
console.log(`  4,139 ms stall injected: peak after the stall ${peak >= 0 ? "+" : ""}${peak.toFixed(1)} m`);
console.log(`  -> the stall ${Number.isFinite(peak) && peak > noGap + 2 ? "ADDS" : "does NOT add"} materially on top of the acceleration debt.`);

// ── ASSERTIONS ────────────────────────────────────────────────────────────────────────────
// Bars sit between the measured before and after, so removing the acceleration term fails them.
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
console.log("\nASSERTIONS");
const lagAt = (a: number, v0: number, secs: number) =>
  steady(drive(accelStraight(v0, a, secs)), Math.max(0, secs - 2), secs);

const a146 = lagAt(1.46, 3, 6);
const a312 = lagAt(3.12, 3, 5);
const a030 = lagAt(0.30, 5, 6);
// Before the fix these read 2.7 / 4.7 / 1.9 m. The bars are set below those and above the
// measured 0.9 / 1.5 / 1.5, so the term cannot be removed without tripping one.
ok("A1 moderate acceleration (1.46 m/s²) keeps the marker within 2.0 m", a146 < 2.0, `${a146.toFixed(1)} m (was 2.7)`);
ok("A2 hard acceleration (3.12 m/s²) keeps it within 3.0 m", a312 < 3.0, `${a312.toFixed(1)} m (was 4.7)`);
ok("A3 gentle acceleration is not made worse", a030 < 2.0, `${a030.toFixed(1)} m (was 1.9)`);
// The whole point: the debt must not GROW with acceleration any more.
ok("A4 hard acceleration is no worse than moderate + 2 m", a312 < a146 + 2.0, `${a312.toFixed(1)} vs ${a146.toFixed(1)} m`);
// Guardrail: the extrapolation must never overshoot the car.
const ahead = drive(accelStraight(3, 3.12, 5)).filter((x) => x.t > 1).map((x) => x.along);
const mostAhead = Math.min(...ahead);
ok("A5 it never runs AHEAD of the car by more than 2 m", mostAhead > -2.0, `${mostAhead.toFixed(1)} m`);


// ── B · the two failures Codex reproduced (2026-09-12) ────────────────────────────────────
// Both were live in the first cut of this change and neither was caught by section A, because
// section A feeds an uninterrupted stream of good fixes.
{
  // B1 — A STALE FIX MUST NOT MANUFACTURE ACCELERATION.
  // A stale fix still advances fixAt while KEEPING the old speed, so differencing against fixAt
  // pairs a new speed with an old timestamp. Codex's case: 3 m/s at t=0, stale at t=3, 9 m/s at
  // t=6 — fixAt makes that look like a legal 3 s interval and yields 2 m/s² from samples six
  // seconds apart. The baseline clock must be spdAt, which a stale fix does not move.
  const T = 1_700_000_000_000;
  let st = poseStart();
  st = poseFix(st, { lat: 49.033, lng: -122.293, at: T, accM: 5, speedMs: 3, courseDeg: 180 }, null);
  st = posePredict(st, T + 6000, null);
  // A fix whose own timestamp is far behind the clock is the stale path.
  st = poseFix(st, { lat: 49.0325, lng: -122.293, at: T + 3000, accM: 5, speedMs: 3, courseDeg: 180 }, null);
  st = poseFix(st, { lat: 49.0320, lng: -122.293, at: T + 6000, accM: 5, speedMs: 9, courseDeg: 180 }, null);
  ok("B1pre the FIRST fix opens the speed clock (else acceleration starts a fix late)",
     poseFix(poseStart(), { lat: 49.033, lng: -122.293, at: 1_700_000_000_000, accM: 5, speedMs: 3, courseDeg: 180 }, null).spdAt === 1_700_000_000_000,
     "spdAt set on fix 1");
  ok("B1 a stale fix in between does not invent acceleration across the gap",
     Math.abs(st.spdAcc) < 0.01, `spdAcc=${st.spdAcc.toFixed(2)} m/s² (was 2.00)`);
}
{
  // B2 — THE EXTRAPOLATION MUST EXPIRE, NOT PERSIST.
  // Clamping only the DURATION kept the inflated speed forever: accepted 3 -> 6 m/s a second
  // apart, then three seconds of silence, and the marker was still travelling at 10.5 m/s.
  const T = 1_700_000_000_000;
  let st = poseStart();
  st = poseFix(st, { lat: 49.0330, lng: -122.293, at: T, accM: 5, speedMs: 3, courseDeg: 180 }, null);
  st = poseFix(st, { lat: 49.03296, lng: -122.293, at: T + 1000, accM: 5, speedMs: 6, courseDeg: 180 }, null);
  // PRECONDITION: without this B2 is vacuous — two fixes must actually establish acceleration
  // before the expiry can be tested at all (Codex, 2026-09-12).
  ok("B2pre the second fix establishes a real acceleration to expire",
     Math.abs(st.spdAcc - 3) < 0.01, `spdAcc=${st.spdAcc.toFixed(2)} m/s²`);
  const before = poseOut(posePredict(st, T + 1050, null));
  // March forward past the hold + decay window with NO further fixes, 20 Hz.
  let s2 = st;
  const endMs = T + 1000 + (POSE_ACC_HOLD_S + POSE_ACC_DECAY_S + 1) * 1000;
  let prev = before, maxStepMs = 0, lastT = T + 1050;
  for (let t = T + 1100; t <= endMs; t += 50) {
    s2 = posePredict(s2, t, null);
    const o = poseOut(s2);
    if (o && prev) {
      const v = haversineM(prev.lat, prev.lng, o.lat, o.lng) / ((t - lastT) / 1000);
      maxStepMs = Math.max(maxStepMs, v);
      prev = o; lastT = t;
    }
  }
  // The last MEASURED speed is 6 m/s. With the taper the marker may briefly exceed it while the
  // extrapolation is trusted, but it must never still be running away at the end.
  s2 = posePredict(s2, endMs + 50, null);
  const oEnd = poseOut(s2);
  const vEnd = oEnd && prev ? haversineM(prev.lat, prev.lng, oEnd.lat, oEnd.lng) / 0.05 : 0;
  ok("B2 the extrapolated speed expires back toward the last measured speed",
     vEnd <= 6.5, `${vEnd.toFixed(1)} m/s at the end vs 6.0 measured (was 10.5)`);
  ok("B2b and it never ran away past the acceleration cap while trusted",
     maxStepMs < 12, `peak ${maxStepMs.toFixed(1)} m/s`);
}

console.log(fails === 0 ? "\nPASS pose_accel" : `\nFAIL pose_accel (${fails})`);
if (fails) process.exit(1);
