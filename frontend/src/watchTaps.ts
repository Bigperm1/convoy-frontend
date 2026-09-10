// watchTaps — the ONE rule for when the wrist taps. Pure; node-gated by
// tools/sim-qc/watch_taps_test.mts. The watch app plays whatever kind it is told
// (WKHapticType.navigationLeftTurn / RightTurn / GenericManeuver) and never compares a
// distance itself — trap-check rule `watch-haptic-math-in-swift`.
//
// Two taps per step: `prepare` at a speed-scaled lead (12 s of travel, clamped 120–400 m —
// shorter than the voice's PREPARE_LEAD_S 30 s because a tap has no words to fit) and `now`
// at 40 m. A step change resets; the same step never re-taps; taps are ≥ 1.5 s apart.
export type TapSide = "left" | "right" | "generic";
export type TapKind = "prepare" | "now";
export type TapState = { stepIdx: number; prepared: boolean; fired: boolean; lastAt: number };

export const WATCH_PREPARE_LEAD_S = 12;
export const WATCH_PREPARE_MIN_M = 120;
export const WATCH_PREPARE_MAX_M = 400;
export const WATCH_NOW_M = 40;
export const WATCH_TAP_MIN_GAP_MS = 1500;

/** Mapbox maneuver key ("turn|left", "roundabout|straight", …) → haptic side. */
export function tapSideFor(maneuverKey: string | undefined): TapSide {
  const mod = (maneuverKey || "").split("|")[1] || "";
  if (mod.includes("uturn")) return "generic";
  if (mod.includes("left")) return "left";
  if (mod.includes("right")) return "right";
  return "generic";
}

export function tapStart(): TapState {
  return { stepIdx: -1, prepared: false, fired: false, lastAt: -Infinity };
}

export function tapDecide(
  st: TapState,
  input: { stepIdx: number; distM: number; speedMs: number; nowMs: number },
): { st: TapState; tap: TapKind | null } {
  const { stepIdx, distM, speedMs, nowMs } = input;
  if (!Number.isFinite(distM) || !Number.isFinite(nowMs)) return { st, tap: null };
  let s: TapState = stepIdx !== st.stepIdx ? { stepIdx, prepared: false, fired: false, lastAt: st.lastAt } : st;
  if (nowMs - s.lastAt < WATCH_TAP_MIN_GAP_MS) return { st: s, tap: null };
  const spd = Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 0;
  const lead = Math.min(WATCH_PREPARE_MAX_M, Math.max(WATCH_PREPARE_MIN_M, spd * WATCH_PREPARE_LEAD_S));
  if (!s.fired && distM <= WATCH_NOW_M) {
    s = { ...s, prepared: true, fired: true, lastAt: nowMs };
    return { st: s, tap: "now" };
  }
  if (!s.prepared && distM <= lead) {
    s = { ...s, prepared: true, lastAt: nowMs };
    return { st: s, tap: "prepare" };
  }
  return { st: s, tap: null };
}
