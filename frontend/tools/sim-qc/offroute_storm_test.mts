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
//
// The traces are laid out on a straight synthetic road running due east: the car sits
// `d` metres south of the CURRENT line, and `pos` is how far south it has actually driven.
// Those two are tracked SEPARATELY on purpose — the first replay of this storm modelled a
// swap as the car teleporting back to 27 m, which counted the re-snap as 37 m of driving
// and armed the travel gate for free. A swap moves the LINE, not the car.
import {
  newOffRouteGateState, resetOffRouteGate, offRouteTick,
  SWAP_ARM_TRAVEL_M, SWAP_FASTPATH_ARM_M, ONROUTE_M, REROUTE_DISTANCE_M, type OffRouteGateState,
} from "../../src/offRouteGate.ts";

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
  },
): { trips: number[]; holds: string[]; st: OffRouteGateState; endT: number } {
  const st: OffRouteGateState = opts?.state ?? newOffRouteGateState(opts?.t0 ?? T0);
  let t = opts?.t0 ?? T0, offset = 0;   // metres added to every subsequent d by the swaps so far
  if (opts?.sessionReset) resetOffRouteGate(st, t);
  const trips: number[] = [], holds: string[] = [];
  for (const k of ticks) {
    t += 1000;
    if (opts?.gatesOff) { st.travelSinceSwapM = 1e6; st.onThisRoute = true; }
    if (opts?.legacyUnknownSpeedFast &&
        (typeof k.speedMs !== "number" || !Number.isFinite(k.speedMs))) st.lastFastAt = t;
    const d = k.d + offset;
    const dec = offRouteTick(st, {
      now: t, dRoute: d, headingOff: k.headingOff ?? true, missedManeuver: k.missed ?? false,
      lat: LAT0 - k.pos / M_PER_DEG_LAT, lng: LNG0, speedMs: k.speedMs, accM: k.accM,
    });
    if (dec.trip) {
      trips.push(t - T0);
      if (opts?.rerouteFails) {
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
  return { trips, holds, st, endT: t };
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
  `arm=${SWAP_ARM_TRAVEL_M}m onRoute=${ONROUTE_M}m`,
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
