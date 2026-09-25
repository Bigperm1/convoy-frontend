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
// irreversible until a NEW event re-stamps it. It is max(the monotonic total, the wall clock's FORWARD total) plus
// the rollback penalties:
//   • performance.now() is monotonic but may PAUSE while the device sleeps (HYPOTHESIS for the RN/Hermes clock on each
//     platform — unmeasured), and a window must not outlive a sleep, so the wall clock's forward steps count too;
//   • a wall clock that jumps FORWARD therefore ages everything (safe: things expire sooner);
//   • a wall clock that moves BACKWARDS by more than a second adds an hour — every window closes (safe: a live drive
//     re-arms on its next vehicular fix; a rolled-back clock can never reopen a window) — and logs a bounded
//     `priv-clock-back` row.
// The two totals are kept SEPARATELY and compared, never maxed per call (privacy round 11: summing max(Δmono, Δwall)
// on every call ran 1.70× fast at 0.3 ms spacing, because the two clocks tick at different granularities — at 1.25×
// a real car's covered/claimed ratio falls to ~0.8 and a re-arm could never prove; park_rearm_test CLK1).
// ⚠ Not covered (CARPLAY.md §6c residual): a rollback that happens while the device sleeps AND the monotonic clock is
// paused — both clocks then agree on a short interval and JS cannot see it. The fix is native (build 80): a
// boot-time clock that counts sleep (Android SystemClock.elapsedRealtime / CLOCK_BOOTTIME, iOS mach_continuous_time).
// Starts at 1e9 ms so a restored stamp (now − age) stays positive, and 0 keeps meaning "never".

import { logEventReliable } from "./crashBreadcrumb";

function perfNow(): number {
  try {
    const p = (globalThis as any).performance;
    const v = p && typeof p.now === "function" ? p.now() : NaN;
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

let monoTotal = 0;        // Σ forward monotonic steps
let wallFwdTotal = 0;     // Σ forward wall-clock steps
let penalties = 0;        // Σ rollback penalties
let clockBackRows = 0;    // `priv-clock-back` rows this process (bounded)
let lastMono: number | null = null;
let lastWall: number | null = null;

/** Elapsed ms for privacy windows: never decreases; = 1e9 + max(Σ monotonic, Σ forward wall) + an hour per backward
 * wall step > 1 s (every window closes). See the header. */
export function privacyNow(): number {
  const m = perfNow();
  const w = Date.now();
  if (lastWall === null) { lastMono = m; lastWall = w; return 1e9; }
  if (Number.isFinite(m) && lastMono !== null && Number.isFinite(lastMono) && m > lastMono) monoTotal += m - lastMono;
  const dw = Number.isFinite(w) ? w - lastWall : 0;
  if (dw < -1_000) {
    penalties += 3_600_000;
    if (clockBackRows < 5) { clockBackRows += 1; try { logEventReliable(`priv-clock-back by=${Math.round(-dw / 1000)}s n=${clockBackRows}`); } catch {} }
  } else if (dw > 0) wallFwdTotal += dw;
  lastMono = Number.isFinite(m) ? m : lastMono;
  lastWall = Number.isFinite(w) ? w : lastWall;
  return 1e9 + Math.max(monoTotal, wallFwdTotal) + penalties;
}

