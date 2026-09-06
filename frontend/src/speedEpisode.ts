// speedEpisode — the speed-alert EPISODE state machine, extracted pure (2026-09-05).
//
// Jeff, 2026-09-05 23:20: "there is a single speed ding and a double ding happening, and
// when I go 20 over and speed up it dings, then I speed up more it dings — really annoying."
// The old logic inline in app/(app)/map.tsx armed each threshold on its own and RE-ARMED it
// the instant the speed dropped back under it, so every crossing was a fresh sound: 25 over
// → ding, dip under 21 over and back → ding again, past 41 → double, back under and past
// again → double again. And because the 5-minute cooldown was an OR with the armed flag, it
// re-fired every five minutes while the driver simply sat above the line.
//
// THE RULE NOW: ONE ALERT PER SPEEDING EPISODE.
//   • An episode STARTS on the first tick at or past tier 1 (21 over, or the adaptive
//     threshold the caller passes in). The single ding / Scout nudge fires on entry — or the
//     double / firmer line instead if that first tick is already past tier 2.
//   • Inside an episode the double fires AT MOST ONCE, on the FIRST tick at or past tier 2
//     (41 over). Nothing else sounds no matter how the speed wobbles: dipping under the tier-1
//     line and back is silent, dropping under the posted limit for a moment is silent.
//   • An episode ENDS only once the speed has been BELOW limit + 5 km/h (hysteresis) for
//     20 CONSECUTIVE seconds (dwell), on the clock the caller passes in. Any tick at or above
//     limit + 5 resets the dwell. The end is declared on a below tick — a gap in fixes (a
//     locked phone, a stop with no speed change) cannot end an episode by itself.
//   • The 5-minute cooldown per tier survives as a hard CEILING across episodes: at most one
//     single and one double per five minutes. It only ever REMOVES sounds — a fire it
//     suppresses is still spent for that episode — and a double also stamps the tier-1 clock,
//     because the firmer warning covers the softer one.
//   • Unknown speed or unknown limit (null / ≤0) is a no-op: no sound, no state change.
//
// Pure and dependency-free (no React, no RN, no Date.now(), no logEvent) so that
// tools/sim-qc/speed_episode_test.mts can drive it under plain Node as a release gate —
// the same shape as src/offRouteGate.ts and src/rerouteSlot.ts, for the same reason.
// map.tsx wraps it: settings, the adaptive tier-1 threshold, the ding / Scout output and the
// bounded `speed-alert` receipt. Nothing here may import anything.

export const SPEED_TIER1_OVER_KMH = 21;
export const SPEED_TIER2_OVER_KMH = 41;
/** Hard ceiling per tier across episodes: at most one sound per tier per 5 minutes. */
export const SPEED_ALERT_COOLDOWN_MS = 300_000;
/** Hysteresis: an episode can only end while the speed is BELOW limit + this. */
export const SPEED_EPISODE_EXIT_OVER_KMH = 5;
/** Dwell: ... and only after it has stayed below that line for this long, consecutively. */
export const SPEED_EPISODE_EXIT_DWELL_MS = 20_000;

export type SpeedEpisodeState = {
  /** Inside a speeding episode (crossed tier 1, not yet dwelled out below limit + 5). */
  inEpisode: boolean;
  /** Episodes started so far — the `episode=` field of the receipt. */
  episode: number;
  /** Tier 2 has been reached in THIS episode (the double is spent, fired or suppressed). */
  tier2Seen: boolean;
  /** Clock of the first tick of the current below-limit+5 run, null while at/above it. */
  belowSinceMs: number | null;
  /** When a tier-1 / tier-2 sound last actually fired (cooldown ceilings), null = never. */
  lastTier1Ms: number | null;
  lastTier2Ms: number | null;
};

export type SpeedEpisodeInput = {
  nowMs: number;
  /** Current speed, km/h — null when unknown. */
  kmh: number | null;
  /** Posted limit, km/h — null / ≤0 when unknown. */
  limitKmh: number | null;
  /** Entry threshold, km/h over the limit (21, or the adaptive value up to 35). */
  tier1Over: number;
  /** Firmer threshold, km/h over the limit (41). */
  tier2Over: number;
};

/** 0 = nothing, 1 = the single ding / nudge, 2 = the double ding / firmer line. */
export type SpeedEpisodeFire = 0 | 1 | 2;

export function newSpeedEpisodeState(): SpeedEpisodeState {
  return { inEpisode: false, episode: 0, tier2Seen: false, belowSinceMs: null, lastTier1Ms: null, lastTier2Ms: null };
}

/**
 * One location tick. Returns what to sound (if anything) and the next state — the input
 * state is never mutated. Call it from location fixes only; the dwell is measured on
 * `nowMs`, not on tick count, so sparse fixes are fine.
 */
export function speedEpisodeTick(
  state: SpeedEpisodeState,
  input: SpeedEpisodeInput,
): { fire: SpeedEpisodeFire; state: SpeedEpisodeState } {
  const { nowMs, kmh, limitKmh, tier1Over, tier2Over } = input;
  if (kmh == null || !Number.isFinite(kmh) || limitKmh == null || !Number.isFinite(limitKmh) || limitKmh <= 0) {
    return { fire: 0, state };
  }
  const over = kmh - limitKmh;
  const cool1 = state.lastTier1Ms == null || nowMs - state.lastTier1Ms >= SPEED_ALERT_COOLDOWN_MS;
  const cool2 = state.lastTier2Ms == null || nowMs - state.lastTier2Ms >= SPEED_ALERT_COOLDOWN_MS;

  if (!state.inEpisode) {
    if (over < tier1Over) return { fire: 0, state };
    // Episode entry: the highest tier crossed on this tick fires, subject to its ceiling.
    const next: SpeedEpisodeState = { ...state, inEpisode: true, episode: state.episode + 1, belowSinceMs: null, tier2Seen: false };
    if (over >= tier2Over) {
      next.tier2Seen = true;
      if (!cool2) return { fire: 0, state: next };
      return { fire: 2, state: { ...next, lastTier2Ms: nowMs, lastTier1Ms: nowMs } };
    }
    if (!cool1) return { fire: 0, state: next };
    return { fire: 1, state: { ...next, lastTier1Ms: nowMs } };
  }

  // Inside an episode.
  if (over >= tier2Over) {
    if (state.tier2Seen) return { fire: 0, state: state.belowSinceMs == null ? state : { ...state, belowSinceMs: null } };
    const next: SpeedEpisodeState = { ...state, tier2Seen: true, belowSinceMs: null };
    if (!cool2) return { fire: 0, state: next };
    return { fire: 2, state: { ...next, lastTier2Ms: nowMs, lastTier1Ms: nowMs } };
  }
  if (over < SPEED_EPISODE_EXIT_OVER_KMH) {
    if (state.belowSinceMs == null) return { fire: 0, state: { ...state, belowSinceMs: nowMs } };
    if (nowMs - state.belowSinceMs >= SPEED_EPISODE_EXIT_DWELL_MS) {
      // Dwelled out: the episode is over. This tick is below the limit, so it cannot start
      // the next one — that takes a fresh crossing of tier 1.
      return { fire: 0, state: { ...state, inEpisode: false, tier2Seen: false, belowSinceMs: null } };
    }
    return { fire: 0, state };
  }
  // Between limit + 5 and tier 2: still speeding (or close to it) — the dwell resets.
  return { fire: 0, state: state.belowSinceMs == null ? state : { ...state, belowSinceMs: null } };
}
