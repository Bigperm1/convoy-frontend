// offroute_storm_test.mts — numeric regression gate for src/offRouteGate.ts (2026-09-04).
// Run: node --experimental-strip-types tools/sim-qc/offroute_storm_test.mts
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
//
// A: Olaf's 2026-09-04 parking-lot storm (06:04–06:07 PDT, five reroutes in three
//    minutes) replayed CLOSED-LOOP: every reroute the model grants re-snaps the line to
//    the road and the car keeps creeping away from it, which is the ratchet the field log
//    shows. Today's logic must reproduce the field count (≥4 over the window); the gated
//    logic must produce at most ONE.
// B: a genuine wrong turn at 40 km/h with 10 diverging ticks must still reroute, and on
//    the SAME TICK as with the gates disabled ("exactly as today").
// C: stopped in a lot with the GPS scattering outward (position drifts, reported speed
//    near zero — the classic stationary-multipath signature) must never reroute.
// D: the missed-maneuver fast path must still fire.
// I: the FIRST reroute FAILS (no route installed, so no resetOffRouteGate) and the car
//    carries on down a road that parallels the old line 45-80 m out. It must ask again
//    after the cooldown. Pre-fix — when the trip block cleared `onThisRoute` and the
//    travel budget — it asked exactly ONCE and then never again for the rest of the drive.
// J: TWO nav sessions on DIFFERENT routes. Drive 2 must start on a clean gate — pre-fix it
//    inherited drive 1's streak, trend history, travel budget and `onThisRoute` and could
//    reroute off evidence earned on a line it had never been on.
// K: parked three minutes with the OS reporting NO speed (undefined/null/NaN) and the fix
//    scattering 3–8 m. Zero reroutes, `held why=creeping`, and essentially no banked
//    travel — pre-fix the speedless ticks kept the creep window forever fresh and the raw
//    scatter path armed both post-swap guards on its own.
// L: Rodrigo's 2026-09-05 STACKED-REQUEST storm — five minutes genuinely off-route with
//    the phone locked, every reroute request HANGING and JS timers frozen so nothing can
//    cancel one. Pre-fix that stacks a request per trip (the field burst: 29 at once);
//    bounded, at most ONE may be outstanding and the FIX-DRIVEN sweep abandons it at 15 s.
// M: the Codex objection made executable — a fresh-GPS wrong turn at 40 km/h with JS
//    timers frozen and NO request in flight must reroute on exactly the tick B does.
//    (The rejected `timers-starved` hold would have failed this outright.)
// N: a hung request AND a genuine missed turn: held while the request is young, allowed
//    the moment the fix-driven abort frees the slot — and again every 16 s while the
//    retries keep hanging, never sooner.
//
// The traces are laid out on a straight synthetic road running due east: the car sits
// `d` metres south of the CURRENT line, and `pos` is how far south it has actually driven.
// Those two are tracked SEPARATELY on purpose — the first replay of this storm modelled a
// swap as the car teleporting back to 27 m, which counted the re-snap as 37 m of driving
// and armed the travel gate for free. A swap moves the LINE, not the car.
import {
  newOffRouteGateState, resetOffRouteGate, offRouteTick, ROUTE_FETCH_TIMEOUT_MS,
  SWAP_ARM_TRAVEL_M, SWAP_FASTPATH_ARM_M, ONROUTE_M, REROUTE_DISTANCE_M, type OffRouteGateState,
} from "../../src/offRouteGate.ts";
// The REAL one-in-flight slot nav.ts wraps (review 2026-09-05: the first version of this
// gate kept its own `outstanding[]` and would have passed with the registry deleted).
import {
  newRerouteSlotState, armRerouteClaim, dropRerouteClaim, claimRerouteSlot, releaseRerouteSlot,
  rerouteInFlightAgeMs, sweepRerouteInFlight, abandonRerouteInFlight,
} from "../../src/rerouteSlot.ts";

const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };

const LAT0 = 49.1000, LNG0 = -122.5000, M_PER_DEG_LAT = 111320;
const T0 = 1_700_000_000_000;   // a real epoch: at t≈0 the 8 s rate limit would self-block

type Tick = {
  pos: number; d: number; speedMs?: number | null; headingOff?: boolean; missed?: boolean;
  /** Horizontal accuracy for THIS fix, as map.tsx's `coords.acc` supplies it. */
  accM?: number | null;
};

/** `swapD` maps the car's position at a swap to its offset from the NEW line. */
function run(
  ticks: Tick[],
  opts?: {
    gatesOff?: boolean;
    swapD?: (pos: number) => number;
    /** The reroute this trip asks for never lands (empty / superseded / stale result), so
     *  no polyline changes and nav.ts's swap effect — the only caller — does not run. */
    rerouteFails?: boolean;
    /** With `rerouteFails`, replay the PRE-FIX trip block, which cleared route-relative
     *  state here as well. This is the "must still reproduce the failure" direction. */
    legacyTripReset?: boolean;
    /** Carry on with an EXISTING gate state — a second nav session, or a second phase of
     *  one drive, on the same mounted engine. Without it every run starts clean. */
    state?: OffRouteGateState;
    /** Clock this run starts on (default T0). Trip times stay absolute from T0. */
    t0?: number;
    /** nav.ts resets the gate on every inactive→active transition (src/nav.ts, the
     *  `_tbtEngineActive = true` branch). Model a nav SESSION START with this; leave it
     *  off to replay the pre-fix nav.ts, which reset nothing at the session boundary. */
    sessionReset?: boolean;
    /** Replay the PRE-FIX creep window, in which a fix with NO speed stamped `lastFastAt`
     *  (`typeof spd !== "number" || !Number.isFinite(spd) || spd >= CREEP_SPEED_MS`), so
     *  the creeping hold could never engage. Set at the top of the tick, exactly where the
     *  old line sat. The "must still reproduce the failure" direction for scenario K. */
    legacyUnknownSpeedFast?: boolean;
    // ── REQUEST LIFECYCLE (2026-09-05, scenarios L/M/N) ──────────────────────────────
    /** Every trip issues a reroute request that HANGS and never settles. The request goes
     *  through the REAL slot (src/rerouteSlot.ts) exactly as src/nav.ts drives it: the tick
     *  arms the claim ticket, the "fetch" claims the slot, the ticket is dropped; and
     *  `sweepRerouteInFlight` runs at the top of every tick, BEFORE `offRouteTick`, off a
     *  location event. Implies the reroute never lands, so `resetOffRouteGate` is not
     *  called (same as `rerouteFails`). */
    hangingRequests?: boolean;
    /** THE PRE-FIX DIRECTION for L. Replays the shipped code exactly: there is no
     *  registry, so there is no fix-driven sweep and the gate is never told a request is
     *  outstanding — and with JS timers frozen the per-request `setTimeout` cannot cancel
     *  anything either. Nothing bounds the requests, and they all stay live. */
    preFixUnbounded?: boolean;
    /** JS-timer starvation reported on EVERY tick. A pure diagnostic in the tick input —
     *  the assertion is that it can never block a trip by itself (M). */
    starvedMs?: number;
  },
): {
  trips: number[]; holds: string[]; st: OffRouteGateState; endT: number; aborts: number[];
  maxInFlight: number; overwrites: number; ctlAborts: number;
} {
  const st: OffRouteGateState = opts?.state ?? newOffRouteGateState(opts?.t0 ?? T0);
  let t = opts?.t0 ?? T0, offset = 0;   // metres added to every subsequent d by the swaps so far
  if (opts?.sessionReset) resetOffRouteGate(st, t);
  const trips: number[] = [], holds: string[] = [];
  const slot = newRerouteSlotState();   // the real slot, bounded direction
  let outstanding: number[] = [];       // pre-fix world: no registry, every request stays live
  const aborts: number[] = [];
  let maxInFlight = 0, overwrites = 0, ctlAborts = 0;
  for (const k of ticks) {
    t += 1000;
    if (opts?.gatesOff) { st.travelSinceSwapM = 1e6; st.onThisRoute = true; }
    if (opts?.legacyUnknownSpeedFast &&
        (typeof k.speedMs !== "number" || !Number.isFinite(k.speedMs))) st.lastFastAt = t;
    // The fix-driven sweep, in the order src/nav.ts runs it: BEFORE the decision, so the
    // same tick that abandons an expired request may legitimately ask for the next one.
    if (opts?.hangingRequests && !opts?.preFixUnbounded) {
      if (sweepRerouteInFlight(slot, t) != null) aborts.push(t - T0);
    }
    const inFlightMs = opts?.preFixUnbounded ? null : rerouteInFlightAgeMs(slot, t);
    const d = k.d + offset;
    const dec = offRouteTick(st, {
      now: t, dRoute: d, headingOff: k.headingOff ?? true, missedManeuver: k.missed ?? false,
      lat: LAT0 - k.pos / M_PER_DEG_LAT, lng: LNG0, speedMs: k.speedMs, accM: k.accM,
      timersStarvedMs: opts?.starvedMs,
      rerouteInFlightMs: inFlightMs,
    });
    if (dec.trip) {
      trips.push(t - T0);
      if (opts?.hangingRequests) {
        if (opts.preFixUnbounded) {
          outstanding.push(t);
          if (outstanding.length > maxInFlight) maxInFlight = outstanding.length;
        } else {
          // nav.ts: arm the ticket → the handler's fetch claims before its first await →
          // the ticket is dropped. A trip while the slot is STILL occupied means the hold
          // failed — counted, and asserted to be zero.
          if (slot.inflight) overwrites++;
          armRerouteClaim(slot);
          claimRerouteSlot(slot, t, { abort() { ctlAborts++; } });
          dropRerouteClaim(slot);
          maxInFlight = Math.max(maxInFlight, slot.inflight ? 1 : 0);
        }
      }
      if (opts?.rerouteFails || opts?.hangingRequests) {
        // Nothing is installed and resetOffRouteGate is NOT called — the line, and every
        // route-relative counter measured against it, must survive untouched.
        if (opts.legacyTripReset) { st.swapAt = t; st.travelSinceSwapM = 0; st.onThisRoute = false; }
      } else {
        if (opts?.swapD) offset = opts.swapD(k.pos) - k.d; // the new line lands here
        resetOffRouteGate(st, t);                          // map.tsx swaps the route in
      }
    }
    if (dec.held) holds.push(dec.held);
  }
  return { trips, holds, st, endT: t, aborts, maxInFlight, overwrites, ctlAborts };
}

// ── A: THE LOT STORM ─────────────────────────────────────────────────────────────
// Receipts: trips at 06:06:32 / :43 / :55 / 07:03 — 11, 12 and 8 s apart, all
// `streak=0 why=diverging step=0`, d = 46 / 51 / 48 / 70 m, with
// `ribbon-trim … anchorOff=27→64 proj=31→65` over the same window.
// `streak=0` is arithmetic, not noise: d never reached REROUTE_DISTANCE_M (80 m).
// And `why=diverging` fixes the outward rate: the trend needs >20 m of growth inside an
// 8 s window, so ≥2.5 m/s of apparent outward motion for ≥6 s at every one of those trips.
// Modelled at 2.6 m/s with the phone REPORTING that speed (9.4 km/h — above the creep
// threshold, i.e. the hostile case where the creep gate cannot help), after 60 s of normal
// on-route driving so the car arrives with a full travel budget, exactly as in the field
// (the 06:06:32 trip came two minutes after the 06:04:29 route-swap).
// Each granted reroute re-snaps its origin to the road the car left, so the new line lands
// ~27 m off — the smallest anchorOff logged all storm.
const OUT_MS = 2.6, LOT_S = 55;   // long enough to run the field's five ratchet cycles
const stormTicks: Tick[] = [];
for (let i = 0; i < 60; i++) stormTicks.push({ pos: 0, d: 5, speedMs: 8.3 });        // on route, 30 km/h
for (let i = 1; i <= LOT_S; i++) stormTicks.push({ pos: OUT_MS * i, d: 5 + OUT_MS * i, speedMs: OUT_MS });
const swapToRoad = () => 27;                                                          // logged anchorOff
const Atoday = run(stormTicks, { gatesOff: true, swapD: swapToRoad });
const A = run(stormTicks, { swapD: swapToRoad });
check(Atoday.trips.length >= 4, `A model is wrong: today's logic gave ${Atoday.trips.length} reroutes, the field logged 4 in this window`);
check(A.trips.length <= 1, `A lot storm produced ${A.trips.length} reroutes (want ≤1)`);

// ── B: A REAL WRONG TURN AT 40 km/h ──────────────────────────────────────────────
// 11.1 m/s, turned off the route: the offset opens ~8 m/s. Ten ticks at 1 Hz. The car
// starts ON the line (d=8 ≤ ONROUTE_M), which is what every reroute-from-a-road looks like.
const wrongTurn: Tick[] = [];
for (let i = 1; i <= 10; i++) wrongTurn.push({ pos: 11.1 * i, d: 8 * i, speedMs: 11.1 });
const B = run(wrongTurn);
const Bold = run(wrongTurn, { gatesOff: true });
check(B.trips.length >= 1, "B wrong turn at 40 km/h did NOT reroute");
check(B.trips[0] === Bold.trips[0],
  `B wrong turn tripped at ${B.trips[0] ?? "never"} ms, gates-off at ${Bold.trips[0] ?? "never"} ms — the gate must be a no-op here`);

// ── C: PARKED, GPS SCATTERING ────────────────────────────────────────────────────
// Stationary in the lot: the fix wanders outward at 2.6 m/s (enough to satisfy the trend)
// while the Doppler speed the OS reports stays at 0.5 m/s — the ordinary stationary-GPS
// signature. Car starts on the line so `onThisRoute` is earned; only the creep gate can
// stop this one.
const scatter: Tick[] = [];
for (let i = 0; i < 15; i++) scatter.push({ pos: 8.3 * i, d: 5, speedMs: 8.3 });      // arrive on route
for (let i = 1; i <= 40; i++) scatter.push({ pos: 8.3 * 15, d: 5 + 2.6 * i, speedMs: 0.5 });
const C = run(scatter);
check(C.trips.length === 0, `C parked with GPS scatter produced ${C.trips.length} reroutes (want 0)`);
check(C.holds.includes("creeping"), `C never reported held why=creeping (holds: ${[...new Set(C.holds)].join("/") || "none"})`);

// ── D: MISSED MANEUVER ───────────────────────────────────────────────────────────
// The detector needs the car to recede >150 m from a maneuver it came within 80 m of, so
// by the time it can be true the car has driven >150 m since the swap — which is why
// SWAP_FASTPATH_ARM_M can never suppress it. 90 km/h for 8 s (200 m), 30 m off the line.
const missed: Tick[] = [];
for (let i = 1; i <= 8; i++) missed.push({ pos: 25 * i, d: 30, speedMs: 25, missed: i === 8 });
const D = run(missed);
check(D.trips.length === 1, `D missed maneuver produced ${D.trips.length} reroutes (want 1)`);

// ── I: A FAILED REROUTE MUST NOT DISARM THE OLD ROUTE ────────────────────────────
// The trip block used to clear `onThisRoute` and the travel budget, on the reasoning that
// the swap it was about to cause "may never land". But when it does not land there IS no
// new line — nav.ts still judges the car against the OLD one, now with `onThisRoute`
// false, and `holdReason` answers `trend` (diverging && !onThisRoute) on every subsequent
// tick. `onThisRoute` can only be re-earned within ONROUTE_M (25 m), and the streak paths
// need REROUTE_DISTANCE_M (80 m): a car on a parallel road between the two is in a dead
// band and never reroutes again.
//
// Trace: 20 s on route at 40 km/h (11.1 m/s), then a road that peels away at 2.6 m/s —
// the same outward rate the field storm's `why=diverging` crumbs pin down, and a ~13°
// departure at this speed. Heading stays ALIGNED (headingOff false) because that is what
// a parallel street looks like — and it removes the `heading` path from the result.
// The whole trace stays below REROUTE_DISTANCE_M (asserted), so no streak path can fire
// either: any retry measured here is the divergence trend and nothing else.
const parallelRoad: Tick[] = [];
for (let i = 1; i <= 20; i++) parallelRoad.push({ pos: 11.1 * i, d: 5, speedMs: 11.1, headingOff: false });
for (let i = 21; i <= 48; i++) parallelRoad.push({ pos: 11.1 * i, d: 5 + 2.6 * (i - 20), speedMs: 11.1, headingOff: false });
const maxD = Math.max(...parallelRoad.map((k) => k.d));
const I = run(parallelRoad, { rerouteFails: true });
const Ilegacy = run(parallelRoad, { rerouteFails: true, legacyTripReset: true });
check(maxD < REROUTE_DISTANCE_M,
  `I trace reaches ${maxD.toFixed(1)} m, at or beyond REROUTE_DISTANCE_M=${REROUTE_DISTANCE_M} — a streak path could fire and the scenario would prove nothing`);
check(Ilegacy.trips.length === 1,
  `I model is wrong: the pre-fix trip reset gave ${Ilegacy.trips.length} reroutes, the defect is that it gives exactly 1 and never retries`);
check(Ilegacy.holds.includes("trend"),
  `I pre-fix run never reported held why=trend (holds: ${[...new Set(Ilegacy.holds)].join("/") || "none"}) — it is not being blocked the way the defect describes`);
check(I.trips.length === 2,
  `I failed reroute then parallel road gave ${I.trips.length} reroutes (want 2: the first ask, then a retry)`);
check(I.trips.length === 2 && I.trips[1] - I.trips[0] > 8000 && I.trips[1] - I.trips[0] <= 12000,
  `I retry came ${I.trips.length === 2 ? I.trips[1] - I.trips[0] : NaN} ms after the first ask (want >8000 — the rate limit — and <=12000)`);

// ── J: TWO SESSIONS, AND THE SECOND MUST START CLEAN ─────────────────────────────
// Ending a route does not end the gate. nav.ts's route-swap effect returns early while
// inactive after recording the new polyline key, so a route that changes BETWEEN drives
// arrives at the next activation with the key already matching and the swap branch — the
// only caller of resetOffRouteGate — never runs; the teardown clears speech state only.
// Drive 2 therefore used to open holding drive 1's evidence: onThisRoute true and a travel
// budget past BOTH post-swap guards, i.e. every fast path armed against a line it has
// never been on. The fix is nav.ts resetting on every inactive→active transition, which is
// what `sessionReset` models here.
//
// Session 1: 41 s at 40 km/h that drifts 5 → 85 m off the line at 2 m/s — too slow for the
// trend (16 m of growth per 8 s window, under DIVERGE_GROWTH_M) and heading-aligned, so it
// ends WITHOUT tripping but with a live streak, a full history and ~445 m of travel.
// Session 2, 60 s later on a DIFFERENT route: the classic post-lot plot — the new line's
// origin was snapped to the road, so the car opens 50 m off it and creeps outward at
// 2.6 m/s (the field storm's own outward rate) while REPORTING that speed, so the creep
// gate cannot help. Only a clean gate can stop this one.
const s1: Tick[] = [];
for (let i = 1; i <= 41; i++) s1.push({ pos: 11.1 * i, d: 5 + 2 * (i - 1), speedMs: 11.1, headingOff: false });
const s2: Tick[] = [];
for (let i = 1; i <= 40; i++) s2.push({ pos: 3000 + 2.6 * i, d: 50 + 2.6 * i, speedMs: 2.6 });
const J1 = run(s1);
check(J1.trips.length === 0, `J session 1 tripped ${J1.trips.length}x — it must end cleanly, or session 2 inherits a cooldown instead of evidence`);
// The inheritance is the defect. Assert it exists at the boundary before asserting the fix.
const J1st = J1.st;
check(J1st.travelSinceSwapM > 150 && J1st.onThisRoute && J1st.hist.length > 0 && J1st.streak > 0,
  `J session 1 did not leave inheritable state (trav=${J1st.travelSinceSwapM.toFixed(0)}m onThisRoute=${J1st.onThisRoute} hist=${J1st.hist.length} streak=${J1st.streak}) — the scenario would prove nothing`);
const Jstale = run(s2, { state: J1.st, t0: J1.endT + 60_000 });                      // pre-fix nav.ts
const J2 = run(s1);                                                                  // a fresh drive 1
const J = run(s2, { state: J2.st, t0: J2.endT + 60_000, sessionReset: true });        // fixed nav.ts
check(Jstale.trips.length >= 1,
  `J model is wrong: with drive 1's state inherited, drive 2 gave ${Jstale.trips.length} reroutes — the defect is that it reroutes off evidence it never earned`);
check(J.trips.length === 0, `J second session produced ${J.trips.length} reroutes on a route it has never been on (want 0)`);
check(J.holds.includes("moved"),
  `J second session never reported held why=moved (holds: ${[...new Set(J.holds)].join("/") || "none"}) — the 40 m guard must apply again from zero`);
// Not a dead end: this only holds while the car is inside the post-swap window. Past
// SWAP_FASTPATH_ARM_M the streak paths arm exactly as scenario I asserts.

// ── K: STATIONARY SCATTER WITH NO SPEED FIELD ────────────────────────────────────
// The creep gate used to be defeated by the absence of evidence: a fix with no speed
// stamped `lastFastAt`, so `now - lastFastAt` never aged and `creeping` could not engage.
// Drive in, park deep in a lot ~70 m from the line the route was re-snapped to, then sit
// for three minutes while the fix wanders 3–8 m per second and the OS reports no speed at
// all (undefined / null / NaN in rotation — all three shapes reach us as `coords.speed`
// only ever being *optional* in the type). 1 Hz is not an assumption: the jitter itself
// trips the navigating watcher's own 2 m distanceInterval, so the fixes keep arriving.
// The walk is deterministic (LCG, no Math.random) and reflected into a 45–95 m band, so
// both trip paths are reachable — the trend on its monotonic runs, the streak whenever it
// sits past REROUTE_DISTANCE_M. Accuracy is 15 m, which is what makes every 3–8 m step
// unusable as motion evidence.
const kDrive: Tick[] = [];
for (let i = 1; i <= 20; i++) kDrive.push({ pos: 11.1 * i, d: 5, speedMs: 11.1, accM: 5 });      // on route, 40 km/h
for (let i = 1; i <= 20; i++) kDrive.push({ pos: 222 + 2 * i, d: 5 + 2 * i, speedMs: 1.5, accM: 8 }); // pulling in, 5.4 km/h
let kSeed = 20260904;
const kRnd = () => { kSeed = (kSeed * 1103515245 + 12345) % 2147483648; return kSeed / 2147483648; };
const kJitter: Tick[] = [];
{
  const LO = 45, HI = 95;
  let d = 60, pos = 262 + (60 - 45);   // the fix wanders PERPENDICULAR to the line, so pos tracks d
  for (let i = 0; i < 180; i++) {
    const step = 3 + 5 * kRnd();
    const prevD = d;
    d += kRnd() < 0.5 ? step : -step;
    if (d < LO) d = LO + (LO - d);
    if (d > HI) d = HI - (d - HI);
    pos += d - prevD;
    kJitter.push({ pos, d, speedMs: [undefined, null, NaN][i % 3], accM: 15 });
  }
}
const kRawPathM = kJitter.reduce((a, k, i) => (i ? a + Math.abs(k.pos - kJitter[i - 1].pos) : 0), 0);
const K0 = run(kDrive);
const travelAtPark = K0.st.travelSinceSwapM;
const K = run(kJitter, { state: K0.st, t0: K0.endT });
const Kpre = run(kJitter, { state: run(kDrive).st, t0: K0.endT, legacyUnknownSpeedFast: true });
// Travel is measured on its OWN run, from a FRESH gate: with nothing banked, every tick is
// held at `moved`, so no trip can fire and no reset can rewind the counter. Measuring it on
// K itself would be worthless — there the reroutes we are trying to prevent zero it.
const kTravelBanked = run(kJitter).st.travelSinceSwapM;
check(K0.trips.length === 0, `K drive-in phase tripped ${K0.trips.length}x — the scatter phase must start from a quiet gate`);
check(travelAtPark > 150, `K arrived with only ${travelAtPark.toFixed(0)}m of travel — both post-swap guards must be OPEN so the creep gate is the only thing left to test`);
check(Kpre.trips.length >= 1,
  `K model is wrong: with the pre-fix creep window (no speed = "fast"), the parked car gave ${Kpre.trips.length} reroutes — the defect is that it reroutes while stationary`);
check(K.trips.length === 0, `K stationary scatter produced ${K.trips.length} reroutes (want 0)`);
check(K.holds.includes("creeping"),
  `K never reported held why=creeping (holds: ${[...new Set(K.holds)].join("/") || "none"}) — an unknown speed must age the creep window, not refresh it`);
// The second half of the same defect: the raw path is long enough to arm every post-swap
// guard from noise alone. Filtered, a stationary phone must bank essentially nothing.
check(kRawPathM > SWAP_FASTPATH_ARM_M,
  `K raw scatter path is only ${kRawPathM.toFixed(0)}m — under SWAP_FASTPATH_ARM_M it could not have armed the guards and proves nothing`);
check(kTravelBanked < 1,
  `K banked ${kTravelBanked.toFixed(1)}m of "travel" from a parked car over a ${kRawPathM.toFixed(0)}m raw scatter path (want <1)`);

// ── L: RODRIGO'S STACKED-REQUEST STORM ───────────────────────────────────────────
// Receipts (crash_reports, 2026-09-04 PT, iOS + CarPlay, phone LOCKED):
//   19:14-19:19  off-route trips posting LIVE every 8-9 s (fix-driven, timers dead)
//   19:19:25     29 × `route-fetch-abort-fired ms=176000-306929` in ONE burst
//   19:19:25     29 × `reroute-result … superseded` in the same burst
// Every trip issued its own request; nothing bounded how many could be outstanding, and
// the only cancellation was a `setTimeout` that could not fire for five minutes.
//
// The car really IS off-route here — this is NOT the lot storm. It is on a road 205 m
// from the line at 40 km/h, so `conclusivelyOff` (>160 m) holds, every 09-04 gate is open
// (travel banked, `onThisRoute` earned, speed well above the creep threshold) and the
// ONLY thing that can bound the requests is the in-flight registry. That is deliberate:
// a scenario the older gates could stop would prove nothing about this one.
// 20 ticks of departure at 10 m/s outward, then five minutes holding station off the line.
const STORM_S = 300;
const rodrigo: Tick[] = [];
for (let i = 1; i <= 30; i++) rodrigo.push({ pos: 11.1 * i, d: 5, speedMs: 11.1 });          // on route, 40 km/h
for (let i = 1; i <= 20; i++) rodrigo.push({ pos: 333 + 11.1 * i, d: 5 + 10 * i, speedMs: 11.1 });
for (let i = 1; i <= STORM_S - 20; i++) rodrigo.push({ pos: 555 + 11.1 * i, d: 205, speedMs: 11.1 });
const Lpre = run(rodrigo, { hangingRequests: true, preFixUnbounded: true, starvedMs: 306_929 });
const L = run(rodrigo, { hangingRequests: true, starvedMs: 306_929 });
const Lgaps = L.trips.slice(1).map((x, i) => x - L.trips[i]);
check(Lpre.trips.length >= 29 && Lpre.maxInFlight >= 29,
  `L model is wrong: the pre-fix run gave ${Lpre.trips.length} requests / ${Lpre.maxInFlight} stacked, and the field burst was 29 at once — it is not reproducing the failure`);
check(L.maxInFlight === 1 && L.overwrites === 0,
  `L allowed a trip while a request was still in flight (${L.overwrites} overwrites; slot used=${L.maxInFlight}) — want 0 overwrites, slot used`);
check(L.ctlAborts === L.aborts.length,
  `L the sweep freed ${L.aborts.length} requests but aborted ${L.ctlAborts} controllers (want equal — free AND abort, every time)`);
// WHAT L PROVES AND WHAT IT CANNOT (Codex pass 3, 2026-09-05): this gate drives the slot,
// not the network. If the platform IGNORES abort(), every one of L's 19 asks stays live on
// the wire — the bound is RATE (one new request per timeout + one fix) and ownership, not a
// physical count of one. `liveIfAbortIgnored` is printed for exactly that reason, and the
// thing that makes an ignored abort harmless — an aborted request never returning a route —
// is enforced in nav.ts and guarded by trap-check's `aborted-route-result-returned`.
const liveIfAbortIgnored = L.trips.length;
check(L.trips.length <= 20,
  `L issued ${L.trips.length} reroute requests over ${STORM_S}s (want ≤20 — one per ROUTE_FETCH_TIMEOUT_MS + a fix)`);
// The exact bound this implementation gives, not a range: a request is abandoned on the
// first fix STRICTLY past ROUTE_FETCH_TIMEOUT_MS (15 s), which at a 1 Hz fix cadence is
// 16 s, and the 8 s rate limit has long since expired by then. 19 = 1 + floor(287/16).
check(Lgaps.every((g) => g === ROUTE_FETCH_TIMEOUT_MS + 1000),
  `L trips are ${[...new Set(Lgaps)].join("/")}ms apart (want every gap = ${ROUTE_FETCH_TIMEOUT_MS + 1000} — the timeout plus the fix that observes it)`);
check(L.trips.length === 19,
  `L issued ${L.trips.length} requests over ${STORM_S}s (want exactly 19)`);
check(L.holds.includes("inflight"),
  `L never reported held why=inflight (holds: ${[...new Set(L.holds)].join("/") || "none"}) — the bound is not the thing doing the work`);
check(L.aborts.length >= L.trips.length - 1,
  `L aborted only ${L.aborts.length} of ${L.trips.length} hung requests from the fix path (want ≥${L.trips.length - 1}; the last one may still be young when the trace ends)`);

// ── M: THE CODEX OBJECTION, EXECUTABLE ───────────────────────────────────────────
// "Timer starvation unconditionally disables off-route recovery — a genuine missed turn
// with fresh GPS and no request in flight never reroutes for the entire locked interval."
// Correct, and it is why the `timers-starved` hold was thrown away. Scenario B's exact
// trace, re-run with the worst starvation figure in Rodrigo's log (306929 ms) reported on
// every tick and NO request outstanding: it must trip on the same tick as B.
const M = run(wrongTurn, { starvedMs: 306_929 });
check(M.trips.length === B.trips.length && M.trips[0] === B.trips[0],
  `M wrong turn with timers frozen tripped at ${M.trips[0] ?? "never"} ms (${M.trips.length} trips) vs B's ${B.trips[0] ?? "never"} ms (${B.trips.length}) — timer starvation must never block a trip by itself`);
check(!M.holds.includes("inflight"),
  `M held why=inflight with nothing in flight (holds: ${[...new Set(M.holds)].join("/") || "none"})`);

// ── N: A HUNG REQUEST, THEN A GENUINE MISSED TURN ────────────────────────────────
// The reroute for the first departure hangs. The driver then misses a maneuver — the
// fast path that trips on ONE tick with no streak at all. It must be held while the
// outstanding request is young, and allowed the moment the fix-driven abort frees the
// slot: 16 s, not 5 minutes, and not "never". Every retry hangs too (the phone is still
// locked), so the pattern REPEATS for as long as the trace lasts: one ask, then exactly
// one more every ROUTE_FETCH_TIMEOUT_MS + one fix — 21 s, 37 s, 53 s on a 54 s trace.
// (The first draft of this scenario wanted "exactly 2" on the same trace; the third ask
// at 53 s is the bound doing its job, not a defect, so the expectation is DERIVED from
// the trace length rather than hard-coded.)
const nTicks: Tick[] = [];
for (let i = 1; i <= 20; i++) nTicks.push({ pos: 11.1 * i, d: 5, speedMs: 11.1 });            // on route
for (let i = 1; i <= 4; i++) nTicks.push({ pos: 222 + 11.1 * i, d: 205, speedMs: 11.1 });     // conclusively off → trip 1
for (let i = 1; i <= 30; i++) nTicks.push({ pos: 266 + 11.1 * i, d: 205, speedMs: 11.1, missed: true });
const N = run(nTicks, { hangingRequests: true, starvedMs: 306_929 });
const N_RETRY_MS = ROUTE_FETCH_TIMEOUT_MS + 1000;
const nGaps = N.trips.slice(1).map((x, i) => x - N.trips[i]);
// Retries expected after the first ask, given how long the trace runs past it.
const nWantTrips = N.trips.length ? 1 + Math.floor((N.endT - T0 - N.trips[0]) / N_RETRY_MS) : 0;
check(N.trips.length >= 2,
  `N hung request + missed turn gave ${N.trips.length} reroute(s) — the slot never freed; the missed turn must be allowed once the fix-driven abort fires`);
check(nGaps.length > 0 && nGaps.every((g) => g === N_RETRY_MS),
  `N retries came ${[...new Set(nGaps)].join("/") || "never"} ms apart (want every gap = ${N_RETRY_MS}: the timeout plus the fix that observes it — no earlier, no later)`);
check(N.trips.length === nWantTrips,
  `N issued ${N.trips.length} asks over the trace (want ${nWantTrips} = the first ask + one retry per ${N_RETRY_MS} ms while it kept hanging)`);
check(N.holds.includes("inflight"),
  `N never reported held why=inflight (holds: ${[...new Set(N.holds)].join("/") || "none"}) — the missed-maneuver fast path must be the thing being held`);
check(N.trips.slice(1).every((t, i) => N.aborts[i] === t),
  `N aborts [${N.aborts.join(",")}] did not each land on the same fix as the retry they freed [${N.trips.slice(1).join(",")}]`);
check(N.aborts.length === N.trips.length - 1,
  `N aborted ${N.aborts.length} requests for ${N.trips.length} asks (want ${N.trips.length - 1}: every ask but the last, still-young one)`);
check(N.overwrites === 0 && N.ctlAborts === N.aborts.length,
  `N overwrites=${N.overwrites} ctlAborts=${N.ctlAborts} sweeps=${N.aborts.length} (want 0, equal)`);

// ── O: THE CLAIM TICKET + IDENTITY RELEASE (src/rerouteSlot.ts, unit) ────────────
// The registry's contract, one clause per check, against the real functions nav.ts wraps.
const o = newRerouteSlotState();
const c1 = { abort() {} }, c2 = { abort() {} };
check(claimRerouteSlot(o, T0, c1) === false && o.inflight === null,
  "O1 a fetch nobody armed (initial plot / scenic / preview / CarPlay search) must not take the slot");
armRerouteClaim(o); dropRerouteClaim(o);
check(claimRerouteSlot(o, T0, c1) === false && o.inflight === null,
  "O2 a ticket dropped before any fetch ran (handler returned early) must leave nothing claimable");
armRerouteClaim(o);
check(claimRerouteSlot(o, T0, c1) === true && o.claim === false && rerouteInFlightAgeMs(o, T0 + 500) === 500,
  "O3 the armed fetch takes the slot, consumes the ticket, and the gate reads its age");
check(claimRerouteSlot(o, T0, c2) === false && o.inflight?.ctl === c1,
  "O4 the ticket is one-shot — a second fetch in the same window must not take the slot");
check(releaseRerouteSlot(o, c2) === false && o.inflight !== null,
  "O5 a foreign controller (a zombie settling late) must not clear the slot");
check(sweepRerouteInFlight(o, T0 + ROUTE_FETCH_TIMEOUT_MS) === null && o.inflight !== null,
  `O6 at exactly ${ROUTE_FETCH_TIMEOUT_MS} ms the request is still the slot's`);
let oTimer = 0, oAbort = 0;
o.inflight!.cancelTimer = () => { oTimer++; }; o.inflight!.ctl = { abort() { oAbort++; } };
check(sweepRerouteInFlight(o, T0 + ROUTE_FETCH_TIMEOUT_MS + 1) === ROUTE_FETCH_TIMEOUT_MS + 1 && o.inflight === null && oTimer === 1 && oAbort === 1,
  `O7 one ms past the timeout the sweep frees, cancels the request's own timer and aborts — each exactly once (timer=${oTimer} abort=${oAbort})`);
armRerouteClaim(o); claimRerouteSlot(o, T0, c1);
check(releaseRerouteSlot(o, c1) === true && o.inflight === null,
  "O8 the settling fetch clears its own slot");
armRerouteClaim(o); claimRerouteSlot(o, T0, c1);
check(abandonRerouteInFlight(o, T0 + 4000) === 4000 && o.inflight === null && abandonRerouteInFlight(o, T0 + 5000) === null,
  "O9 nav end / unmount frees without aborting, and is a no-op on an empty slot");

// ── Q: THE REROUTE THE DRIVER NEVER JOINS (Rodrigo, 2026-09-05 14:27) ────────────
// A reroute lands (`route-swap`), but its line starts on a road the car has already left,
// so the car is never within 25 m of it and drives AWAY at ~15 km/h: d 57 → 82 → 120 m over
// 25 s, travel 71 → 114 m (his exact `held why=trend` rows). Before tonight every path was
// held by the trend flag until the car joined the line, i.e. forever. Now: the trend fast
// path still needs the join; `sustained` (streak ≥ 6 over 80 m) must trip once the 150 m
// post-swap travel arm is banked — here at ~33 s, not never. The 1.5 km sim case (108 km/h)
// is the same trace at 30 m/s: `far` must trip within ~6 s of the swap.
function neverJoined(speedMs: number): Tick[] {
  const t: Tick[] = [];
  for (let i = 1; i <= 20; i++) t.push({ pos: speedMs * i, d: 5, speedMs });      // on the OLD line
  t.push({ pos: speedMs * 21, d: 57, speedMs });                                  // the swap tick: 57 m off
  // Driving AWAY: the distance to the line grows at ~0.85 × speed (Rodrigo's rows: 82 → 120 m
  // over 10 s at ~15 km/h; the 108 km/h sim replay: 241 → 1393 m over 40 s).
  for (let i = 1; i <= 60; i++) t.push({ pos: speedMs * (21 + i), d: 57 + 0.85 * speedMs * i, speedMs });
  return t;
}
// Model the swap: a fresh gate state whose line moved under the car — the car is 57 m off
// the NEW line from the first tick and never gets closer.
function runNeverJoined(speedMs: number, legacy: boolean) {
  const st = newOffRouteGateState(T0); st.onThisRoute = true; st.travelSinceSwapM = 1000;  // long on the old line
  const ticks = neverJoined(speedMs);
  // the swap happens at tick 21: replay ticks 1-20 on the old line, reset (the swap), then the rest
  let t = T0; const trips: number[] = []; const holds: string[] = [];
  ticks.forEach((k, i) => {
    t += 1000;
    if (i === 20) resetOffRouteGate(st, t);   // route-swap: the line moved, the car did not
    const dec = offRouteTick(st, { now: t, dRoute: k.d, headingOff: true, missedManeuver: false,
      lat: LAT0 - k.pos / M_PER_DEG_LAT, lng: LNG0, speedMs: k.speedMs });
    if (dec.trip) trips.push(t - T0); else if (dec.held) holds.push(dec.held);
    void legacy;
  });
  return { trips, holds, swapAt: 21000 };
}
const Qslow = runNeverJoined(15 / 3.6, false);   // Rodrigo: ~15 km/h
const Qfast = runNeverJoined(30, false);          // the 09-05 sim replay: 108 km/h
const qSlowDelay = Qslow.trips.length ? Qslow.trips[0] - Qslow.swapAt : Infinity;
const qFastDelay = Qfast.trips.length ? Qfast.trips[0] - Qfast.swapAt : Infinity;
check(Qslow.trips.length >= 1 && qSlowDelay <= 40000,
  `Q slow: a driver leaving a reroute he never joined at 15 km/h re-tripped ${Number.isFinite(qSlowDelay) ? (qSlowDelay / 1000).toFixed(0) + "s" : "NEVER"} after the swap (want ≤40 s: the 150 m arm at that speed)`);
check(Qslow.holds.includes("trend") || Qslow.holds.includes("moved"),
  `Q slow: the post-swap holds must still engage before the arm (holds: ${[...new Set(Qslow.holds)].join("/") || "none"})`);
check(Qfast.trips.length >= 1 && qFastDelay <= 8000,
  `Q fast: at 108 km/h the same driver re-tripped ${Number.isFinite(qFastDelay) ? (qFastDelay / 1000).toFixed(0) + "s" : "NEVER"} after the swap (want ≤8 s; the sim held this 48 s while d reached 1.5 km)`);

// ── R: CRAWLING IN A JAM 200 M OFF THE LINE (Codex rescue 2026-09-06) ────────────────
// The creep hold is for a car scattering in a LOT next to the route (C). A car creeping at
// 5 km/h on another road 200 m away — conclusively off — must still be rerouted: before, the
// creep window held it for as long as the jam lasted.
const jam: Tick[] = [];
for (let i = 1; i <= 20; i++) jam.push({ pos: 11.1 * i, d: 5, speedMs: 11.1 });          // on route, 40 km/h
for (let i = 1; i <= 60; i++) jam.push({ pos: 222 + 1.4 * i, d: 200, speedMs: 1.4 });     // 5 km/h, 200 m off
const R = run(jam, {});
check(R.trips.length >= 1 && R.trips[0] <= 60000,
  `R crawling 200 m off the line: re-tripped ${R.trips.length ? (R.trips[0] / 1000).toFixed(0) + "s" : "NEVER"} (want within 60 s — the creep hold must not apply this far off)`);
check(C.trips.length === 0,
  `R changed C: the parked lot scatter now trips ${C.trips.length} times (want 0)`);

const fmt = (r: { trips: number[] }) => r.trips.map((x) => (x / 1000).toFixed(0) + "s").join(",") || "none";
console.log(
  `A lot storm: today=${Atoday.trips.length} [${fmt(Atoday)}] → gated=${A.trips.length} [${fmt(A)}] ` +
  `holds=${[...new Set(A.holds)].join("/") || "-"} (want ≤1) | ` +
  `B wrong turn 40km/h trip=${fmt(B)} vs gates-off ${fmt(Bold)} (want equal) | ` +
  `C parked+scatter reroutes=${C.trips.length} holds=${[...new Set(C.holds)].join("/") || "-"} (want 0) | ` +
  `D missed maneuver reroutes=${D.trips.length} (want 1) | ` +
  `I failed reroute + parallel road: pre-fix=${Ilegacy.trips.length} [${fmt(Ilegacy)}] holds=${[...new Set(Ilegacy.holds)].join("/") || "-"} → ` +
  `fixed=${I.trips.length} [${fmt(I)}] retry=+${I.trips.length === 2 ? I.trips[1] - I.trips[0] : NaN}ms maxD=${maxD.toFixed(1)}m (want 2, ≤12s) | ` +
  `J session 2 on a new route: stale-state=${Jstale.trips.length} → clean=${J.trips.length} ` +
  `holds=${[...new Set(J.holds)].join("/") || "-"} (want 0) | ` +
  `K parked 3min, no speed field: pre-fix=${Kpre.trips.length} → fixed=${K.trips.length} ` +
  `holds=${[...new Set(K.holds)].join("/") || "-"} banked=${kTravelBanked.toFixed(1)}m of ${kRawPathM.toFixed(0)}m raw (want 0, <1m) | ` +
  `L stacked-request storm ${STORM_S}s: pre-fix=${Lpre.trips.length} reqs / ${Lpre.maxInFlight} in flight (field: 29) → ` +
  `bounded=${L.trips.length} reqs / ${L.maxInFlight} tracked (overwrites=${L.overwrites}; ${liveIfAbortIgnored} live on the wire if abort is ignored), gaps=${[...new Set(Lgaps)].join("/")}ms aborts=${L.aborts.length}/${L.ctlAborts} ` +
  `holds=${[...new Set(L.holds)].join("/") || "-"} (want ≤20, 1) | ` +
  `M wrong turn + timers frozen ${fmt(M)} vs B ${fmt(B)} (want equal) | ` +
  `N hung request + missed turn=${N.trips.length} [${fmt(N)}] gaps=${[...new Set(nGaps)].join("/") || "-"}ms aborts=${N.aborts.length} (want ${nWantTrips}, +${N_RETRY_MS}ms) | ` +
  `R jam 200m off: re-trip ${R.trips.length ? R.trips[0] / 1000 + "s" : "never"} | O slot contract 9/9 | Q never-joined reroute: re-trip +${Number.isFinite(qSlowDelay) ? qSlowDelay / 1000 : "never"}s @15km/h, +${Number.isFinite(qFastDelay) ? qFastDelay / 1000 : "never"}s @108km/h (want ≤40, ≤8) | arm=${SWAP_ARM_TRAVEL_M}m onRoute=${ONROUTE_M}m fetchTimeout=${ROUTE_FETCH_TIMEOUT_MS}ms`,
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
