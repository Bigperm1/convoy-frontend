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
// irreversible until a NEW event re-stamps it. Each call advances it by max(Δmonotonic, Δwall):
//   • performance.now() is monotonic but may PAUSE while the device sleeps (HYPOTHESIS for the RN/Hermes clock on each
//     platform — unmeasured), and a window must not outlive a sleep, so the wall clock's forward steps count too;
//   • a wall clock that jumps FORWARD therefore ages everything (safe: things expire sooner);
//   • a wall clock that moves BACKWARDS by more than a second adds an hour — every window closes (safe: a live drive
//     re-arms on its next vehicular fix; a rolled-back clock can never reopen a window).
// Starts at 1e9 ms so a restored stamp (now − age) stays positive, and 0 keeps meaning "never".

function perfNow(): number {
  try {
    const p = (globalThis as any).performance;
    const v = p && typeof p.now === "function" ? p.now() : NaN;
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

let elapsed = 1e9;
let lastMono: number | null = null;
let lastWall: number | null = null;

/** Elapsed ms for privacy windows: never decreases; advances by max(Δmonotonic, Δwall); a backward wall step > 1 s adds
 * an hour (every window closes). See the header. */
export function privacyNow(): number {
  const m = perfNow();
  const w = Date.now();
  if (lastWall === null) { lastMono = m; lastWall = w; return elapsed; }
  const dm = Number.isFinite(m) && lastMono !== null && Number.isFinite(lastMono) ? Math.max(0, m - lastMono) : 0;
  const dw = Number.isFinite(w) ? w - lastWall : 0;
  elapsed += dw < -1_000 ? dm + 3_600_000 : Math.max(dm, dw, 0);
  lastMono = Number.isFinite(m) ? m : lastMono;
  lastWall = Number.isFinite(w) ? w : lastWall;
  return elapsed;
}

