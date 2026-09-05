// timer_starve_test.mts — numeric gate for the "fix-driven car surface" mitigation
// (2026-09-04/05). Run: node --experimental-strip-types tools/sim-qc/timer_starve_test.mts
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
//
// FIELD FACTS this exists to guard, both from crash_reports:
//   Rodrigo (iOS, CarPlay) 19:14-19:19 PT: off-route trips posted LIVE every 8-9 s (native
//   location events kept reaching JS) while the 15 s route-fetch ABORT timers (setTimeout,
//   src/nav.ts) fired 29-at-once 176-307 s late and the 60 s heat-probe setInterval
//   reported win=577549ms. JS TIMERS were dead; location was not.
//   The architect's sim run (2026-09-05, iOS 27 sim, Cmd+L lock @ 54 km/h) measured the
//   OPPOSITE split: setInterval-driven receipts kept cadence (timers ALIVE) while rAF
//   (3492->486/min) and location (`proj` froze at 27 m) went silent.
// So "JS timers dead", "rAF dead" and "location dead" are three independent axes. This
// gate covers the two PURE pieces built on that finding:
//
//   PART A — src/timerLiveness.ts, the REAL applied module (imported directly; it has no
//   RN-only imports at the top level — see its own header for why — so it runs unmodified
//   under plain Node, the same reason src/offRouteGate.ts was kept dependency-free).
//   Scenarios: fresh clock reads ~0; a stale heartbeat reads starved; a fresh tick clears
//   it; the sim-only debug-force override reports starved regardless of the real
//   heartbeat; the rAF side-channel counts frames in tumbling 5 s windows and reports 0
//   once genuinely silent for 2 windows, WITHOUT ever feeding `timersStarvedMs()` (the
//   two axes must stay independent, per the sim-run finding above); A7-A9 cover the
//   2026-09-05 Codex adversarial-review fix for the hidden-persisted-override bug (force
//   honoured only while BOTH debugOverlays AND debugForceTimerStarve read true, via the
//   `effectiveDebugForce()` pure helper; the sentinel FORCED_STARVE_DT_MS replacing
//   Number.MAX_SAFE_INTEGER; and the `forced=1`/`forced=0` receipt tag from
//   `buildStarveLogLine()`) — see the A7-A9 block comment for what this file can and
//   cannot exercise (settings.ts/developer.tsx's own halves need AsyncStorage/RN and are
//   read-verified instead).
//
//   PART B — the off-route side, against the REAL exported `holdReason()` / `offRouteTick()`
//   in src/offRouteGate.ts. The first design was a blanket `timers-starved` HOLD. Codex
//   adversarial review (2026-09-05, pass 2) rejected it — timer silence does not establish
//   that a request cannot settle (the timer is used for CANCELLATION only), and the hold
//   would have disabled off-route recovery for the whole locked interval — and it was
//   replaced by REQUEST-LIFECYCLE bounding (src/nav.ts: ONE reroute in flight, aged and
//   aborted off LOCATION FIXES, which kept running through Rodrigo's freeze). Part B
//   asserts that shipped contract from both sides: `rerouteInFlightMs` holds `inflight`
//   only while YOUNG (never once expired — a stuck request must not wedge the gate), and
//   `timersStarvedMs` can NEVER block a trip by itself. offroute_storm_test.mts scenarios
//   L/M/N are the same contract on full traces.
import {
  timersStarvedMs, noteTimerTick, noteRafFrame, rafFramesInLast5s, maybeLogTimerStarve,
  __setDebugForceForTest, effectiveDebugForce, buildStarveLogLine, FORCED_STARVE_DT_MS,
} from "../../src/timerLiveness.ts";
import {
  holdReason, offRouteTick, rerouteInflightExpired, ROUTE_FETCH_TIMEOUT_MS,
  newOffRouteGateState, SWAP_FASTPATH_ARM_M, type OffRouteGateState,
} from "../../src/offRouteGate.ts";

const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };

// ══════════════════════════════════════════════════════════════════════════════════
// PART A — src/timerLiveness.ts
// ══════════════════════════════════════════════════════════════════════════════════
const T0 = 1_700_000_000_000;

// A1: a heartbeat that just ticked reads ~0 ms starved.
noteTimerTick(T0);
check(timersStarvedMs(T0) === 0, `A1: fresh tick should read 0ms starved, got ${timersStarvedMs(T0)}`);
check(timersStarvedMs(T0 + 500) === 500, `A1b: 500ms after a tick should read 500ms starved, got ${timersStarvedMs(T0 + 500)}`);

// A2: no tick for >3s (Rodrigo's threshold) reads starved past it.
noteTimerTick(T0);
const dtA2 = timersStarvedMs(T0 + 5000);
check(dtA2 === 5000, `A2: 5s with no heartbeat should read 5000ms starved, got ${dtA2}`);
check(dtA2 > 3000, `A2b: 5s silence must exceed the 3000ms off-route hold threshold`);

// A3: a fresh tick clears the starvation immediately (no latch — see main-gap-cannot-see
// -suspension memory for why a LATCHED signal was the wrong design for a related probe).
noteTimerTick(T0 + 5000);
check(timersStarvedMs(T0 + 5000) === 0, `A3: a tick must clear starvation immediately, got ${timersStarvedMs(T0 + 5000)}`);

// A4: the sim-only debug-force switch reports starved regardless of a HEALTHY real
// heartbeat — this is what lets the architect exercise the bypass on the sim.
noteTimerTick(T0 + 5000); // heartbeat healthy
__setDebugForceForTest(true);
check(timersStarvedMs(T0 + 5000) > 3000, `A4: debug-force must report starved even with a healthy heartbeat`);
__setDebugForceForTest(false);
check(timersStarvedMs(T0 + 5000) === 0, `A4b: turning debug-force off must restore the real (healthy) reading`);

// A5: rAF side channel — tumbling 5s windows, and it must NEVER be conflated with the
// timer clock (the sim run's whole point: timers alive + rAF dead must both be visible).
noteTimerTick(T0); // timers healthy throughout A5
for (let i = 0; i < 60; i++) noteRafFrame(T0 + i * 16); // ~1s of 60fps frames
const raf1 = rafFramesInLast5s(T0 + 60 * 16);
check(raf1 === 60, `A5: expected 60 frames counted in-window, got ${raf1}`);
// rAF goes silent for >10s (2 window-lengths) — must report 0, and timersStarvedMs must
// be UNAFFECTED (still reads off the heartbeat, not off rAF).
const rafSilentAt = T0 + 60 * 16 + 11000;
const rafAfterSilence = rafFramesInLast5s(rafSilentAt);
check(rafAfterSilence === 0, `A5b: rAF silent >10s must report 0, got ${rafAfterSilence}`);
noteTimerTick(rafSilentAt); // heartbeat still healthy despite rAF being dead
const dtA5c = timersStarvedMs(rafSilentAt);
check(dtA5c === 0, `A5c: timersStarvedMs must stay healthy while only rAF is dead (the sim-run split) — the two axes must not be conflated, got ${dtA5c}`);
// And the reverse split (Rodrigo's): rAF alive, timers dead.
const rodrigoT = rafSilentAt + 1000;
for (let i = 0; i < 30; i++) noteRafFrame(rodrigoT + i * 16); // rAF still ticking
const rafAliveWhileTimersDead = rafFramesInLast5s(rodrigoT + 30 * 16);
check(rafAliveWhileTimersDead > 0, `A5d: rAF must be able to read alive independent of the timer clock`);
const dtA5e = timersStarvedMs(rodrigoT + 30 * 16 + 6000);
check(dtA5e > 3000, `A5e: with no further noteTimerTick, the timer clock must independently read starved even while rAF (A5d) was alive, got ${dtA5e}`);

// A6: maybeLogTimerStarve must never throw under plain Node (logEventReliable is a lazy
// require() that fails silently here — see the file header) and must return the same
// figure timersStarvedMs would.
noteTimerTick(T0);
let threw = false;
let dtA6 = -1;
try { dtA6 = maybeLogTimerStarve('car', T0 + 4000); } catch { threw = true; }
check(!threw, `A6: maybeLogTimerStarve must not throw when logEventReliable is unavailable (plain Node)`);
check(dtA6 === 4000, `A6b: maybeLogTimerStarve must return the true starvation figure, got ${dtA6}`);

// A7-A9: the settings-coupling fix for the Codex adversarial review finding (2026-09-05)
// — "enable Debug overlays + Force timer starvation, then disable Debug overlays: the
// force control disappears but its persisted value remains true, and the (old)
// subscription ignored debugOverlays entirely." `effectiveDebugForce()` is the pure
// helper src/timerLiveness.ts's settings subscription now runs both fields through
// (:88-90); it is what settings.ts/developer.tsx's coupling is BUILT ON, not a mock of
// it — settings.ts itself needs AsyncStorage/RN and cannot run under plain Node (see
// this module's own header for why timerLiveness.ts stays dependency-free instead), so
// this is the honest boundary of what this Node gate can exercise directly. The other
// two pieces of the fix — developer.tsx (:11 onChange) writing
// `debugForceTimerStarve: false` when overlays are turned off, and settings.ts (the
// session-scoped load-time reset next to the other one-time migration flags) resetting
// a persisted `true` back to `false` on every app launch — are read-verified, not
// covered by this Node-runnable file.

// A7: force on + overlays OFF → the coupling must NOT honour it (this is exactly the
// state the review found leaking: force=true persisted, overlays=false, no visible
// control). timersStarvedMs must read the REAL (healthy) heartbeat, never the sentinel.
noteTimerTick(T0);
const eff7 = effectiveDebugForce(false, true);
check(eff7 === false, `A7: overlays=false + force=true must resolve to NOT honoured, got ${eff7}`);
__setDebugForceForTest(eff7);
check(timersStarvedMs(T0) === 0, `A7b: with the override not honoured, a healthy heartbeat must read 0ms, got ${timersStarvedMs(T0)}`);

// A8: force on + overlays ON → honoured, starved, and (d) the sentinel + receipt must
// unambiguously mark it as forced — dt is the sane FORCED_STARVE_DT_MS (never
// Number.MAX_SAFE_INTEGER), and the receipt line carries forced=1 so the field can
// never mistake a forced sim run for a real freeze.
const eff8 = effectiveDebugForce(true, true);
check(eff8 === true, `A8: overlays=true + force=true must resolve to honoured, got ${eff8}`);
__setDebugForceForTest(eff8);
const dtA8 = timersStarvedMs(T0);
check(dtA8 === FORCED_STARVE_DT_MS, `A8b: honoured override must report the sentinel ${FORCED_STARVE_DT_MS}, got ${dtA8}`);
check(dtA8 !== Number.MAX_SAFE_INTEGER, `A8c: must never report Number.MAX_SAFE_INTEGER`);
const lineA8 = buildStarveLogLine(dtA8, 'car', 0, true);
check(lineA8.includes('forced=1'), `A8d: a forced receipt must carry forced=1, got "${lineA8}"`);
const lineReal = buildStarveLogLine(5000, 'car', 0, false);
check(lineReal.includes('forced=0'), `A8e: a real (unforced) receipt must carry forced=0, got "${lineReal}"`);
__setDebugForceForTest(false);

// A9: the flag must read false whenever overlays is false, regardless of what order the
// two switches were left in — "force on, THEN overlays off" (the review's exact repro
// sequence) must land on the same false as "overlays off, force never mattered".
const seqLeftOnThenOverlaysOff = effectiveDebugForce(false, true); // force stayed true, overlays flipped off
const seqNeverForced = effectiveDebugForce(false, false);
check(seqLeftOnThenOverlaysOff === false, `A9: force left true + overlays now false must read false, got ${seqLeftOnThenOverlaysOff}`);
check(seqLeftOnThenOverlaysOff === seqNeverForced, `A9b: that state must be indistinguishable from "never forced" while overlays is off, got ${seqLeftOnThenOverlaysOff} vs ${seqNeverForced}`);

// ═════════════════════════════════════════════════
// PART B — the off-route side, exercised against the REAL exported `holdReason()` and
// `offRouteTick()` in src/offRouteGate.ts (the shipped 2026-09-05 contract: GATE 4).
// ═════════════════════════════════════════════════

// A state with every OTHER gate already satisfied — nothing here should read "moved",
// "trend" or "creeping", so the ONLY thing that can block a trip is the in-flight bound.
function armedState(now: number): OffRouteGateState {
  const st = newOffRouteGateState(now - 60000);
  st.travelSinceSwapM = SWAP_FASTPATH_ARM_M + 10; // past both travel gates
  st.onThisRoute = true;                          // trend gate satisfied
  st.lastFastAt = now;                             // creep gate satisfied (just moved)
  return st;
}

// B1: fully armed + a YOUNG outstanding reroute (50 ms old) → held, why=inflight.
const b1 = holdReason(armedState(T0), true, T0, 50);
check(b1 === "inflight", `B1: fully-armed state with a 50ms-old request in flight must hold why=inflight, got ${b1}`);

// B2: fully armed + nothing in flight (null) → NOT held (a real trip proceeds normally).
const b2 = holdReason(armedState(T0), true, T0, null);
check(b2 === null, `B2: fully-armed state with no request in flight must not hold, got ${b2}`);

// B3: in-flight age UNMEASURED (undefined) → never holds on it.
const b3 = holdReason(armedState(T0), true, T0, undefined);
check(b3 === null, `B3: unmeasured rerouteInFlightMs must never itself cause a hold, got ${b3}`);

// B4: the boundary belongs to the SWEEP. AT exactly ROUTE_FETCH_TIMEOUT_MS the request is
// not yet expired → still the slot's → held. ONE ms past it, it is expired: the sweep
// should already have freed it, and if it somehow has not, a stuck request must NEVER
// wedge the gate shut — the exact failure the rejected timers-starved hold would have had.
const b4 = holdReason(armedState(T0), true, T0, ROUTE_FETCH_TIMEOUT_MS);
check(b4 === "inflight", `B4: age===${ROUTE_FETCH_TIMEOUT_MS} (the boundary, not yet expired) must still hold, got ${b4}`);
const b4b = holdReason(armedState(T0), true, T0, ROUTE_FETCH_TIMEOUT_MS + 1);
check(b4b === null, `B4b: age===${ROUTE_FETCH_TIMEOUT_MS + 1} (expired) must NOT hold — a stuck request must not wedge the gate, got ${b4b}`);
check(!rerouteInflightExpired(ROUTE_FETCH_TIMEOUT_MS) && rerouteInflightExpired(ROUTE_FETCH_TIMEOUT_MS + 1)
  && !rerouteInflightExpired(null) && !rerouteInflightExpired(undefined) && !rerouteInflightExpired(NaN),
  `B4c: rerouteInflightExpired must be strictly-greater-than ${ROUTE_FETCH_TIMEOUT_MS} and false for null/undefined/NaN`);

// B5: an UNARMED state (an existing gate would already hold it) + nothing in flight must
// still report the EXISTING reason — the new check must not shadow the others when it
// does not itself apply.
const unarmed = newOffRouteGateState(T0);
unarmed.travelSinceSwapM = 5; // under SWAP_ARM_TRAVEL_M
const b5 = holdReason(unarmed, true, T0, null);
check(b5 === "moved", `B5: an existing 'moved' hold must be untouched when nothing is in flight, got ${b5}`);

// B6: an unarmed state ALSO carrying a young request must report `inflight` FIRST —
// deliberately ordered first, so a storm read back off crash_reports names the bound that
// actually held it, not whichever older gate happened to be closed as well.
const b6 = holdReason(unarmed, true, T0, 4000);
check(b6 === "inflight", `B6: young in-flight + otherwise-unarmed must report inflight (checked first), got ${b6}`);

// B7: THE CODEX OBJECTION AT THE TICK LEVEL. Fully armed, a missed maneuver (the one-tick
// fast path), JS timers reported starved by Rodrigo's worst figure (306929 ms), NO request
// in flight → MUST trip. Timer starvation is a receipt, never a blocker.
const tickAt = (st: OffRouteGateState, inflight: number | null, starved?: number) => offRouteTick(st, {
  now: T0, dRoute: 205, headingOff: true, missedManeuver: true, lat: 49.25, lng: -123.1,
  speedMs: 11.1, timersStarvedMs: starved, rerouteInFlightMs: inflight,
});
const b7 = tickAt(armedState(T0), null, 306_929);
check(b7.trip === true && b7.held === null,
  `B7: missed turn + timers starved 306929ms + nothing in flight must TRIP (starvation is receipt-only), got trip=${b7.trip} held=${b7.held}`);

// B8: the same tick with a YOUNG request in flight is held `inflight` (not tripped); with
// an EXPIRED one it trips — the two halves of the sweep's contract at the decision.
const b8y = tickAt(armedState(T0), 5000, 306_929);
check(b8y.trip === false && b8y.held === "inflight",
  `B8: missed turn with a 5s-old request in flight must be held inflight, got trip=${b8y.trip} held=${b8y.held}`);
const b8x = tickAt(armedState(T0), ROUTE_FETCH_TIMEOUT_MS + 1, 306_929);
check(b8x.trip === true && b8x.held === null,
  `B8b: missed turn with an EXPIRED request in flight must trip (a stuck request never wedges the gate), got trip=${b8x.trip} held=${b8x.held}`);

console.log(
  `A liveness clock: fresh=0ms silent5s=${dtA2}ms debugForce=forced raf-in-window=${raf1} raf-after-silence=${rafAfterSilence} ` +
  `(axes independent: timers-healthy-rAF-dead=${dtA5c}ms, rAF-alive-timers-dead>3000=${dtA5e > 3000}) | ` +
  `A7-9 settings coupling: overlaysOff+forceOn honoured=${eff7} dt=${timersStarvedMs(T0)}ms, overlaysOn+forceOn honoured=${eff8} dt=${dtA8} line="${lineA8}", sequenceOverlaysOffAfterForce=${seqLeftOnThenOverlaysOff} | ` +
  `B off-route (shipped GATE 4): armed+young=${b1} armed+none=${b2} unmeasured=${b3} boundary@${ROUTE_FETCH_TIMEOUT_MS}ms=${b4} expired+1ms=${b4b} unarmed+none=${b5} unarmed+young=${b6} | ` +
  `codex objection: starved306929+none trip=${b7.trip} young→held=${b8y.held} expired→trip=${b8x.trip}`,
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
// src/timerLiveness.ts self-starts a real setInterval at import (by design — see its
// header), which would otherwise keep this short-lived script's event loop alive
// forever. Exit explicitly now that both parts have reported.
process.exit(0);
