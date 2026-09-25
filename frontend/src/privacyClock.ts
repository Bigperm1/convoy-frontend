// privacyClock.ts — the clocks for IN-PROCESS privacy timing (Codex delta review 4, 2026-09-25).
//
// Jeff, 2026-09-25: "it should not follow me when i discconect from car play... this is a privacy concern. fix it and
// lock it." Four review rounds found the same class: a privacy window measured on the WALL clock (Date.now) moves when
// the clock does. Rolled back, an expired Android Auto attachment came back to life inside its 90 s window and a
// walking fix was shared live and written as the car spot (park_rearm_test HF9g-0 on b286ad9b); rolled back further, a
// drive's latch was future-dated and never expired (HF9c-0). So every in-process window in src/locationPrivacy.ts and
// src/parkRearm.ts is measured on privacyNow(), and the car-feed settle rule on monotonic time (src/carFeedOwner.ts
// settleNow — that module stays import-free). The wall clock is kept only for values written to disk (the car spot's
// `t`, the last-driving stamp), and those are converted ONCE, at hydrate, with the conservative direction (future-dated
// or unknown → expired).
//
// privacyNow() — ELAPSED time, for windows whose SAFE direction is "expire" (the head-unit TTL, driving-evidence
// freshness, the re-arm windows, the hydrate backoff, the save throttles). It never goes backwards, so an expiry is
// irreversible until a NEW event re-stamps it. Per call it advances by the MONOTONIC step (performance.now()), plus
// any SLEEP the wall clock saw and the monotonic clock did not, plus the rollback penalty:
//   • performance.now() is monotonic but may PAUSE while the device sleeps (HYPOTHESIS for the RN/Hermes clock on each
//     platform — unmeasured), and a window must not outlive a sleep. So the wall clock's excess over the monotonic step
//     (Δwall − Δmono) is CARRIED — never below zero — and once the carry passes SLEEP_EXCESS_MS (1 s) all of it is
//     counted and the carry restarts. A sleep of any length is counted (a string of short ones adds up in the carry),
//     whatever happened before it: a rollback hidden inside an awake gap (the clock set back by R during a gap longer
//     than R, so no backward step is ever seen) drives the excess NEGATIVE, and the floor at zero forgets it — it can
//     never absorb a later sleep (round 12, the lead's C3/C4: round 11's max(Σmono, Σwall-forward) carried that R as a
//     debt for the life of the process, and a later 10 min sleep counted 0 s — a lost Android Auto attachment stayed
//     alive and a walk was shared live 89 s; park_rearm_test CLK3, HF11, HF12);
//   • dense calls cannot drift: the two clocks tick at different granularities (a float monotonic step, a whole-ms wall
//     step), but the carry of (Δwall − Δmono) TELESCOPES — it is the wall-minus-monotonic offset now, less its lowest
//     value since the last count — so granularity alone keeps it within about one tick of the coarser clock, far
//     below 1 s (round 11: summing max(Δmono, Δwall) per call ran 1.70× fast at 0.3 ms spacing; at 1.25× a real car's
//     covered/claimed ratio falls to ~0.8 and a re-arm could never prove; park_rearm_test CLK1, CLK1b);
//   • a wall clock that jumps FORWARD by more than 1 s is counted too (safe: things expire sooner); a slow wall-over-
//     monotonic rate drift is counted a second at a time (safe, negligible);
//   • a wall clock that moves BACKWARDS by more than a second adds an hour — every window closes (safe: a live drive
//     re-arms on its next vehicular fix; a rolled-back clock can never reopen a window) — and logs a bounded
//     `priv-clock-back` row;
//   • no usable monotonic step (performance.now() missing, throwing, NaN, or behind its last reading): that interval
//     advances by the wall clock's forward step alone, so time still passes; a NaN wall clock just skips the carry.
// ⚠ Not covered (CARPLAY.md §6c residual #10): a rollback and a sleep with the monotonic clock paused INSIDE THE SAME
// interval between two reads (the rollback during the sleep, or while the app is suspended around it) — that interval's
// two steps then cancel up to R of the sleep and JS cannot see it (park_rearm_test KF1). The fix is native (build 80): a
// boot-time clock that counts sleep (Android SystemClock.elapsedRealtime / CLOCK_BOOTTIME, iOS mach_continuous_time).
// Starts at 1e9 ms so a restored stamp (now − age) stays positive, and 0 keeps meaning "never".

import { logEventReliable } from "./crashBreadcrumb";

/** Wall-clock excess over the monotonic clock (ms, carried across calls) that counts as a sleep. */
export const SLEEP_EXCESS_MS = 1_000;
/** A backward wall step larger than this (ms) is a rollback: every window closes. */
export const ROLLBACK_STEP_MS = 1_000;
/** What a rollback adds (ms): longer than every privacy window. */
export const ROLLBACK_PENALTY_MS = 3_600_000;
/** `priv-clock-back` rows per process. */
export const CLOCK_BACK_ROWS_MAX = 5;

function perfNow(): number {
  try {
    const p = (globalThis as any).performance;
    const v = p && typeof p.now === "function" ? p.now() : NaN;
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}
function wallNow(): number {
  try { const v = Date.now(); return typeof v === "number" && Number.isFinite(v) ? v : NaN; } catch { return NaN; }
}

let elapsed = 1e9;
let sleepCarry = 0;       // wall-over-monotonic excess not yet counted (ms, never below 0)
let clockBackRows = 0;    // `priv-clock-back` rows this process (bounded)
let started = false;
let lastMono = NaN;
let lastWall = NaN;

/** Elapsed ms for privacy windows: never decreases; = 1e9 + Σ monotonic steps + every sleep the wall clock saw (the
 * carried excess, counted once past 1 s) + an hour per backward wall step > 1 s (every window closes). See the header. */
export function privacyNow(): number {
  const m = perfNow();
  const w = wallNow();
  if (!started) { started = true; lastMono = m; lastWall = w; return elapsed; }
  const monoOk = Number.isFinite(m) && Number.isFinite(lastMono) && m >= lastMono;
  const wallOk = Number.isFinite(w) && Number.isFinite(lastWall);
  const dm = monoOk ? m - lastMono : 0;
  const dw = wallOk ? w - lastWall : 0;
  if (wallOk && dw < -ROLLBACK_STEP_MS) {
    elapsed += ROLLBACK_PENALTY_MS;
    if (clockBackRows < CLOCK_BACK_ROWS_MAX) { clockBackRows += 1; try { logEventReliable(`priv-clock-back by=${Math.round(-dw / 1000)}s n=${clockBackRows}`); } catch {} }
  }
  if (monoOk) {
    elapsed += dm;
    if (wallOk) {
      sleepCarry = Math.max(0, sleepCarry + (dw - dm));
      if (sleepCarry > SLEEP_EXCESS_MS) { elapsed += sleepCarry; sleepCarry = 0; }
    }
  } else if (wallOk && dw > 0) {
    elapsed += dw;        // no usable monotonic step: the wall clock's forward step alone (time still passes)
  }
  lastMono = m;           // a NaN reading makes the NEXT interval fall back to the wall clock, not span two intervals
  lastWall = w;
  return elapsed;
}
