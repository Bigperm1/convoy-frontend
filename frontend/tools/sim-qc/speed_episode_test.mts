// speed_episode_test.mts — numeric gate for src/speedEpisode.ts (2026-09-05).
// Run: node --experimental-strip-types tools/sim-qc/speed_episode_test.mts
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
//
// Jeff, 2026-09-05 23:20: "there is a single speed ding and a double ding happening, and
// when I go 20 over and speed up it dings, then I speed up more it dings — really annoying."
// The old effect in app/(app)/map.tsx (transcribed VERBATIM below as `legacyRun` so the model
// has to reproduce the complaint before it is allowed to prove the fix) armed each threshold
// on its own and re-armed it the instant the speed dropped under it, so every crossing was a
// fresh sound — and its 5-minute cooldown was an OR with the armed flag, so it also re-fired
// every five minutes while the driver just sat above the line.
//
// Every scenario drives the REAL exported `speedEpisodeTick` at 1 Hz (the nav watch cadence)
// with an injected clock, posted limit 50 km/h, tier 1 = 21 over, tier 2 = 41 over:
//   A  Jeff's exact complaint — 25 over for 30 s, up to 45, back to 25, up to 45 again:
//      exactly ONE single (on entry) + ONE double (first tier-2 crossing). Legacy: 3 sounds.
//   B  wobble 20↔23 over every 3 s for 2 min: ONE sound total. Legacy: 20.
//   C  a 10 s dip UNDER the limit then back over: same episode, no new sound. Legacy: 2.
//   D  under limit+5 for 25 s → the episode ends; a fresh crossing after the cooldown has
//      lapsed is a NEW episode with its own single (episode=2).
//   E  the 5-minute ceiling: three episodes in four minutes → one sound; a 20-minute episode
//      at 25 over → one sound (legacy: 4, one every 5 min); two tier-2 episodes in five
//      minutes → one double and one single; a 10-minute stretch at 45 over → one of each.
//   F  speed unknown / limit unknown (null, 0) → nothing, and the state is untouched;
//      unknown ticks in the middle of an episode neither end it nor sound.
//   G  a hard launch straight to 45 over → exactly one sound, the double (never single+double).
//   H  the dwell is CONSECUTIVE: one tick at limit+5 inside a below run resets it, so
//      19 s + 19 s below with that tick between them is still the same episode.
//   I  the adaptive tier-1 threshold (35) gates entry, the exit line stays at limit+5.
import {
  speedEpisodeTick, newSpeedEpisodeState,
  SPEED_TIER1_OVER_KMH, SPEED_TIER2_OVER_KMH, SPEED_ALERT_COOLDOWN_MS,
  SPEED_EPISODE_EXIT_OVER_KMH, SPEED_EPISODE_EXIT_DWELL_MS,
  type SpeedEpisodeState,
} from "../../src/speedEpisode.ts";

const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };

const T0 = 1_700_000_000_000;
const LIMIT = 50;
type Seg = [seconds: number, overKmh: number | null];   // over = null → speed unknown
type Fire = { t: number; tier: 1 | 2; episode: number };

// Drive a profile through the REAL machine at 1 Hz. `limit` null/0 = limit unknown.
function run(segs: Seg[], opts: { limit?: number | null; tier1?: number } = {}) {
  const limit = opts.limit === undefined ? LIMIT : opts.limit;
  let state: SpeedEpisodeState = newSpeedEpisodeState();
  const fires: Fire[] = [];
  let t = 0;
  for (const [secs, over] of segs) {
    for (let i = 0; i < secs; i++, t++) {
      const r = speedEpisodeTick(state, {
        nowMs: T0 + t * 1000,
        kmh: over == null ? null : LIMIT + over,
        limitKmh: limit,
        tier1Over: opts.tier1 ?? SPEED_TIER1_OVER_KMH,
        tier2Over: SPEED_TIER2_OVER_KMH,
      });
      state = r.state;
      if (r.fire) fires.push({ t, tier: r.fire, episode: state.episode });
    }
  }
  const singles = fires.filter((f) => f.tier === 1).length;
  const doubles = fires.filter((f) => f.tier === 2).length;
  return { fires, state, singles, doubles, sounds: fires.length, seconds: t };
}

// The OLD map.tsx logic (pre-2026-09-05), transcribed verbatim: per-tier {last, armed},
// re-arm under the line, fire the highest crossed tier if armed OR cooled down.
function legacyRun(segs: Seg[]) {
  const t1 = { last: 0, armed: true }, t2 = { last: 0, armed: true };
  const fires: Fire[] = [];
  let t = 0;
  for (const [secs, over] of segs) {
    for (let i = 0; i < secs; i++, t++) {
      if (over == null) continue;
      const now = T0 + t * 1000;
      if (over < SPEED_TIER1_OVER_KMH) t1.armed = true;
      if (over < SPEED_TIER2_OVER_KMH) t2.armed = true;
      let tier: 0 | 1 | 2 = 0;
      if (over >= SPEED_TIER2_OVER_KMH) {
        if (t2.armed || now - t2.last >= SPEED_ALERT_COOLDOWN_MS) { t2.last = now; t2.armed = false; tier = 2; }
      } else if (over >= SPEED_TIER1_OVER_KMH) {
        if (t1.armed || now - t1.last >= SPEED_ALERT_COOLDOWN_MS) { t1.last = now; t1.armed = false; tier = 1; }
      }
      if (tier) fires.push({ t, tier, episode: 0 });
    }
  }
  return { fires, sounds: fires.length };
}

const fmt = (r: { fires: Fire[] }) => r.fires.map((f) => `${f.tier === 2 ? "DD" : "D"}@${f.t}s`).join(",") || "none";

// ── A: Jeff's complaint ───────────────────────────────────────────────────────────
const JEFF: Seg[] = [[30, 25], [20, 45], [20, 25], [20, 45], [10, 25]];
const Alegacy = legacyRun(JEFF);
const A = run(JEFF);
check(Alegacy.sounds >= 3, `A legacy: the old logic must reproduce the complaint (≥3 sounds), got ${Alegacy.sounds} [${fmt(Alegacy)}]`);
check(A.singles === 1 && A.doubles === 1, `A: want exactly one single + one double, got ${A.singles}/${A.doubles} [${fmt(A)}]`);
check(A.fires[0]?.tier === 1 && A.fires[0]?.t === 0, `A: the single must fire on the ENTRY tick, got [${fmt(A)}]`);
check(A.fires[1]?.tier === 2 && A.fires[1]?.t === 30, `A: the double must fire on the FIRST tier-2 tick (t=30), got [${fmt(A)}]`);
check(A.state.episode === 1 && A.state.inEpisode, `A: one episode, still open at the end (episode=${A.state.episode} in=${A.state.inEpisode})`);

// ── B: wobble around the threshold ────────────────────────────────────────────────
const WOBBLE: Seg[] = [];
for (let i = 0; i < 20; i++) WOBBLE.push([3, 20], [3, 23]);
const Blegacy = legacyRun(WOBBLE);
const B = run(WOBBLE);
check(Blegacy.sounds >= 15, `B legacy: the old logic must ding on every re-crossing (≥15), got ${Blegacy.sounds}`);
check(B.sounds === 1 && B.fires[0]?.t === 3, `B: 2 min of 20↔23 over must make ONE sound (at t=3), got ${B.sounds} [${fmt(B)}]`);
check(B.state.episode === 1, `B: one episode, got ${B.state.episode}`);

// ── C: a 10 s dip under the limit ─────────────────────────────────────────────────
const DIP: Seg[] = [[30, 25], [10, -3], [30, 25]];
const Clegacy = legacyRun(DIP);
const C = run(DIP);
check(Clegacy.sounds === 2, `C legacy: the old logic re-dings after the dip (2), got ${Clegacy.sounds}`);
check(C.sounds === 1 && C.state.episode === 1 && C.state.inEpisode, `C: 10 s under the limit must NOT end the episode — want 1 sound / episode 1 / still open, got ${C.sounds} [${fmt(C)}] episode=${C.state.episode} in=${C.state.inEpisode}`);

// ── D: 25 s under limit+5 ends the episode; a fresh crossing after the cooldown dings ──
const COOL_S = SPEED_ALERT_COOLDOWN_MS / 1000;
const D = run([[30, 25], [25, -3], [COOL_S, 10], [30, 25]]);   // 10 over = inside the band, not speeding
check(D.state.episode === 2, `D: 25 s below limit+5 must END the episode so the next crossing is episode 2, got episode=${D.state.episode}`);
check(D.singles === 2 && D.doubles === 0 && D.fires[1]?.t === 30 + 25 + COOL_S,
  `D: the new episode gets its own single once the ceiling has lapsed, want D@0s,D@${30 + 25 + COOL_S}s got [${fmt(D)}]`);
// The moment the episode ends: the 21st consecutive below tick (t=30 … t=50).
const Dend = run([[30, 25], [SPEED_EPISODE_EXIT_DWELL_MS / 1000, -3]]);
const DendPlus = run([[30, 25], [SPEED_EPISODE_EXIT_DWELL_MS / 1000 + 1, -3]]);
check(Dend.state.inEpisode && !DendPlus.state.inEpisode,
  `D: the episode must end on the first below tick ≥${SPEED_EPISODE_EXIT_DWELL_MS / 1000} s after the run began (in@20s=${Dend.state.inEpisode} in@21s=${DendPlus.state.inEpisode})`);

// ── E: the 5-minute ceiling never ADDS a sound ────────────────────────────────────
const E1 = run([[30, 25], [30, -3], [30, 25], [30, -3], [30, 25]]);
check(E1.state.episode === 3 && E1.sounds === 1, `E1: three episodes inside four minutes → ONE sound, got episodes=${E1.state.episode} sounds=${E1.sounds} [${fmt(E1)}]`);
const E2legacy = legacyRun([[1200, 25]]);
const E2 = run([[1200, 25]]);
check(E2legacy.sounds === 4, `E2 legacy: the old logic re-fired every 5 min while sitting above the line (4), got ${E2legacy.sounds} [${fmt(E2legacy)}]`);
check(E2.sounds === 1, `E2: 20 minutes at 25 over → ONE sound, got ${E2.sounds} [${fmt(E2)}]`);
const E3 = run([[10, 25], [10, 45], [30, -3], [10, 25], [10, 45]]);
check(E3.state.episode === 2 && E3.singles === 1 && E3.doubles === 1,
  `E3: two tier-2 episodes inside five minutes → one single + one double total, got episodes=${E3.state.episode} [${fmt(E3)}]`);
const E4 = run([[10, 25], [600, 45]]);
check(E4.singles === 1 && E4.doubles === 1, `E4: 10 minutes at 45 over → one single + one double, never a re-fire, got [${fmt(E4)}]`);
const E5 = run([[10, 45], [30, -3], [COOL_S, 10], [10, 25]]);
check(E5.doubles === 1 && E5.singles === 1 && E5.fires[1]?.t === 10 + 30 + COOL_S,
  `E5: a double stamps the tier-1 clock too, so the next single waits for the ceiling, got [${fmt(E5)}]`);
const E6 = run([[10, 45], [30, -3], [10, 25]]);
check(E6.sounds === 1 && E6.state.episode === 2, `E6: … and inside the ceiling that next episode is silent, got ${E6.sounds} [${fmt(E6)}] episodes=${E6.state.episode}`);

// ── F: unknown speed / unknown limit ──────────────────────────────────────────────
const F1 = run([[60, null]]);
const F2 = run([[60, 25]], { limit: null });
const F3 = run([[60, 25]], { limit: 0 });
const fresh = JSON.stringify(newSpeedEpisodeState());
check(F1.sounds === 0 && JSON.stringify(F1.state) === fresh, `F1: speed unknown → nothing, state untouched, got ${F1.sounds} ${JSON.stringify(F1.state)}`);
check(F2.sounds === 0 && JSON.stringify(F2.state) === fresh, `F2: limit unknown → nothing, state untouched, got ${F2.sounds} ${JSON.stringify(F2.state)}`);
check(F3.sounds === 0 && JSON.stringify(F3.state) === fresh, `F3: limit 0 → nothing, state untouched, got ${F3.sounds}`);
const F4 = run([[10, 25], [60, null], [10, 25]]);
check(F4.sounds === 1 && F4.state.inEpisode && F4.state.episode === 1, `F4: a minute of unknown speed mid-episode neither ends it nor sounds, got ${F4.sounds} [${fmt(F4)}] in=${F4.state.inEpisode}`);
const F5 = run([[10, 25], [60, null], [10, 45]]);
check(F5.singles === 1 && F5.doubles === 1 && F5.fires[1]?.t === 70, `F5: … and the first tier-2 tick after it still gets the double, got [${fmt(F5)}]`);
const F6 = run([[10, -3], [60, null], [10, -3], [10, 25]]);   // unknown gap never advances the dwell (no episode open anyway) and never blocks entry
check(F6.sounds === 1 && F6.fires[0]?.t === 80, `F6: unknown ticks never block a later entry, got [${fmt(F6)}]`);

// ── G: straight to 45 over ────────────────────────────────────────────────────────
const G = run([[20, 45], [20, 25]]);
check(G.sounds === 1 && G.fires[0]?.tier === 2 && G.fires[0]?.t === 0, `G: entering past tier 2 → exactly one sound, the double, got [${fmt(G)}]`);

// ── H: the dwell is consecutive ───────────────────────────────────────────────────
const DW = SPEED_EPISODE_EXIT_DWELL_MS / 1000;
const H = run([[10, 25], [DW - 1, 4], [1, SPEED_EPISODE_EXIT_OVER_KMH], [DW - 1, 4], [10, 25]]);
check(H.sounds === 1 && H.state.episode === 1, `H: one tick AT limit+5 between two ${DW - 1} s below runs resets the dwell → same episode, no new sound, got ${H.sounds} [${fmt(H)}] episodes=${H.state.episode}`);
const Hband = run([[10, 25], [120, 10], [10, 25]]);
check(Hband.sounds === 1 && Hband.state.episode === 1, `H: two minutes inside the band (limit+5 … tier 1) keeps the episode open, got ${Hband.sounds} episodes=${Hband.state.episode}`);

// ── I: adaptive tier-1 threshold ──────────────────────────────────────────────────
const I1 = run([[60, 25]], { tier1: 35 });
const I2 = run([[10, 25], [10, 36], [25, 4], [10, 36]], { tier1: 35 });
check(I1.sounds === 0 && I1.state.episode === 0, `I1: 25 over never enters at an adaptive threshold of 35, got ${I1.sounds}`);
check(I2.sounds === 1 && I2.fires[0]?.t === 10 && I2.state.episode === 2, `I2: entry at 36 over, exit still at limit+5 (episode 2 opens silently inside the ceiling), got [${fmt(I2)}] episodes=${I2.state.episode}`);

console.log(
  `A jeff: legacy=${Alegacy.sounds} [${fmt(Alegacy)}] → ${A.singles} single + ${A.doubles} double [${fmt(A)}] (want 1+1) | ` +
  `B wobble 2min: legacy=${Blegacy.sounds} → ${B.sounds} (want 1) | ` +
  `C dip 10s: legacy=${Clegacy.sounds} → ${C.sounds} episodes=${C.state.episode} (want 1/1) | ` +
  `D below 25s: episodes=${D.state.episode} [${fmt(D)}] (want 2, 2nd single after ${COOL_S}s) | ` +
  `E ceiling: 3-in-4min=${E1.sounds} 20min=${E2.sounds} (legacy ${E2legacy.sounds}) 2×tier2=${E3.singles}+${E3.doubles} 10min@45=${E4.singles}+${E4.doubles} (want 1,1,1+1,1+1) | ` +
  `F unknown: ${F1.sounds}/${F2.sounds}/${F3.sounds} mid-episode=${F4.sounds} (want 0/0/0, 1) | ` +
  `G straight to 45: [${fmt(G)}] (want DD@0s only) | H consecutive dwell: ${H.sounds} (want 1) | I adaptive@35: ${I1.sounds}/${I2.sounds} (want 0/1) | ` +
  `exit<limit+${SPEED_EPISODE_EXIT_OVER_KMH} dwell=${SPEED_EPISODE_EXIT_DWELL_MS}ms ceiling=${SPEED_ALERT_COOLDOWN_MS}ms`,
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
