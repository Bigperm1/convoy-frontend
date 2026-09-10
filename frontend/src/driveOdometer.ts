// driveOdometer — the ONE running distance counter for this JS context.
//
// The maths and every gate live in src/tripOdometer.ts (pure, node-gated). This file is only
// the shared instance, and it exists for one reason: THERE ARE TWO LOCATION SOURCES.
//
//   * app/(app)/map.tsx's foreground watcher — the phone map, while it is mounted and awake.
//   * src/navNotification.ts's NAV_TASK background task — the CarPlay / Android Auto drive,
//     a locked phone, a backgrounded app.
//
// If the warm path kept its own counter, a drive done with the phone locked in a CarPlay
// cradle would be credited only the fixes the foreground watcher happened to see, and the
// recorded distance would come out SHORTER than the drive. Testers' numbers going DOWN is a
// worse failure than the one being fixed, so both sources feed the same counter and a drive
// reads the DELTA across it.
//
// Interleaving the two sources is safe by construction: the counter measures anchor-to-fix
// along the path, duplicates and out-of-order fixes are dropped by the `dt > 0` guard, and
// anything under the jitter floor is ignored. Two sources tracing one road still integrate
// to that road's length.
import { odoStart, odoAdd, odoMeters, type OdoFix } from "./tripOdometer";

let _state = odoStart();

/** Fold one fix in, from whichever source produced it. Never throws. */
export function feedOdo(f: OdoFix): void {
  try { _state = odoAdd(_state, f); } catch {}
}

/** Free-running metres since this JS context started. A drive reads the DELTA. */
export function odoNowM(): number {
  try { return odoMeters(_state); } catch { return 0; }
}

/** Diagnostic counters, for the trip receipt. */
export function odoSkips(): { acc: number; jump: number; gap: number; stopped: number } {
  return {
    acc: _state.skippedAcc, jump: _state.skippedJump,
    gap: _state.skippedGap, stopped: _state.skippedStopped,
  };
}

/** Test-only reset. Production never resets it — drives take a delta instead. */
export function _resetOdoForTest(): void {
  _state = odoStart();
}
