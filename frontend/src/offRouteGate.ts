// offRouteGate — the off-route DECISION, extracted pure so it can be replayed.
//
// Everything here used to live inline in `useTurnByTurn` (src/nav.ts). It is the same
// streak + divergence-trend logic, moved verbatim, plus the four gates below (three from
// 2026-09-04's parking-lot storm, the fourth from 2026-09-05's stacked-request storm).
// It is pure and side-effect-free (state in, decision out — no React, no logEvent, no
// Date.now()) for exactly one reason: `tools/sim-qc/offroute_storm_test.mts` replays a
// real field trace against it as a numeric release gate. nav.ts keeps the GEOMETRY
// (nearest point on the polyline, the heading gate, the missed-maneuver detector) and
// hands the numbers here.
//
// ══ THE 2026-09-04 PARKING-LOT REROUTE STORM ═══════════════════════════════════
// Olaf (`enablewhore`), AI route with one stop, pulled into a lot and stopped.
// FIVE reroutes in three minutes. `crash_reports`, PDT:
//   06:06:32  off-route tripped d=46m streak=0 why=diverging step=0
//   06:06:33  reroute-result id=2 age=0s moved=0m n=1 applied · route-swap steps=26 onRoute=1
//   06:06:43  off-route tripped d=51m streak=0 why=diverging step=0   (11 s later)
//   06:06:44  reroute-result id=3 age=2s moved=8m applied · route-swap steps=18
//   06:06:55  off-route tripped d=48m streak=0 why=diverging step=0   (12 s later)
//   06:07:03  off-route tripped d=70m streak=0 why=diverging step=0   ( 8 s later)
// and, across the same window, `ribbon-trim … anchorOff=27→64 proj=31→65` — the drawn
// line sat 64 m from the drawn car.
//
// `streak=0 why=diverging` is the whole tell, and it is self-consistent: d never reached
// REROUTE_DISTANCE_M (80 m), so every streak path was dead and the streak legitimately
// read 0. Each trip came in through the divergence TREND, which is a FAST PATH — it
// bypasses the streak entirely — and the trend history is CLEARED on every route swap,
// so after each reroute it started measuring afresh from the car's position on the
// brand-new line. A reroute requested from inside a parking lot has its origin snapped
// onto the nearest ROAD (Mapbox snaps at unlimited radius), so the new line starts ~30 m
// from where the car actually is; the car creeps further into the lot; d walks 27 → 64 m,
// which is >45 m absolute with >20 m of monotonic growth inside the 8 s window — the
// trend's exact definition — and it trips again. The only thing bounding the loop was
// the 8 s rate limit, which is why the trips are 8–12 s apart.
//
// ── GATE 1: TRAVEL SINCE THE SWAP (`held why=moved`) ───────────────────────────
// A reroute is worth asking for only once the car has actually DRIVEN somewhere since
// the last one. Measured on RAW GPS (never the drawn/snapped position — in a lot the
// snapped marker is pinned to a road and would report no travel at all).
//   • The storm's own numbers: each cycle grew the offset 27 → 64 m (37 m) over 8–12 s,
//     and the reroute-result crumbs measure the car's travel directly — `moved=0m` on
//     ids 2, 4 and 5 (age 0–1 s) and `moved=8m` on id 3 (age 2 s). One lot cycle is
//     under 40 m of travel.
//   • A real wrong turn is not touched. The trend cannot fire before its window spans
//     DIVERGE_WINDOW_MS*0.75 = 6 s, and 6 s of travel exceeds 40 m at any speed at or
//     above 24 km/h — so at road speed this gate has already opened before the trend is
//     even eligible. At 20 km/h it costs ~1.2 s. `offroute_storm_test.mts` asserts the
//     40 km/h wrong turn trips on exactly the same tick as with the gate disabled.
export const SWAP_ARM_TRAVEL_M = 40;
// ── WHAT COUNTS AS TRAVEL (2026-09-04, adversarial review #2) ──────────────────
// `travelSinceSwapM` used to sum EVERY point-to-point step with no test at all, so the
// safeguard above could be satisfied by the very noise it exists to reject: a stationary
// phone scattering 5 m per fix "drives" SWAP_ARM_TRAVEL_M in eight fixes and
// SWAP_FASTPATH_ARM_M in thirty, after which every fast path is armed against a car that
// has not moved a metre. A step is counted only when the fix carries evidence that the
// CAR moved, not merely that the FIX moved:
//   • speed KNOWN   → count the step iff speed >= TRAVEL_MIN_SPEED_MS. Doppler speed is an
//     independent instrument from position, so it confirms — or refutes — motion outright,
//     and the step size is then not second-guessed. This is the only branch that runs on
//     the phone today: every `setCoords` in app/(app)/map.tsx resolves speed to a number
//     (:3349 clamps CoreLocation's -1 sentinel to 0, :3243 and :3775 do the same, and the
//     background takeover carries the last value forward at :1983).
//   • speed UNKNOWN → position is the only instrument left, so the step must be bigger
//     than the noise it could be: TRAVEL_MIN_STEP_M, or the fix's own horizontal accuracy
//     when that is larger. That is not a tuned threshold on `acc` — it is what the field
//     MEANS. A displacement smaller than the fix's own stated uncertainty is not a
//     measurement of movement. (app/(app)/map.tsx:477 records that nothing gated on `acc`
//     because its real-world distribution is unmeasured; that still holds — this floor
//     lives inside the unknown-speed branch, which no phone fix reaches, so it can only
//     ever help a feed that has nothing else.)
// `lastFix` still advances on EVERY tick, counted or not: a rejected step is DROPPED, not
// deferred, so the next step is measured from where the car actually is.
// 3 m is the OS's own jitter gate, not a guess — the navigating watcher asks for a fix
// every 2 m (app/(app)/map.tsx:3344), eco every 8 m (:3343), the background task every
// 5 m (src/navNotification.ts:855). A delivered step at or under 3 m is inside the
// smallest interval the OS was even asked to resolve.
export const TRAVEL_MIN_STEP_M = 3;
// 1 m/s = 3.6 km/h — walking pace, and under the 1.4 m/s (5 km/h) that nav.ts already
// calls "below a crawl" (ARRIVE_SETTLE_SPEED_MS), so this rejects only fixes the arrival
// machine would read as stopped too.
export const TRAVEL_MIN_SPEED_MS = 1;
// ── GATE 2: NO FAST PATH UNTIL THE ROUTE HAS BEEN DRIVEN (`held why=trend`) ────
// Right after a swap the only admissible evidence is the divergence TREND; the
// distance/streak fast paths are held until the car has driven this far on the new line.
// 150 m is not arbitrary: the missed-maneuver fast path REQUIRES the car to have receded
// more than 150 m from a maneuver it came within 80 m of (src/nav.ts, `missedManeuver`),
// and that approach happens after the swap — so missedManeuver implies >150 m of travel
// since the swap and this gate can never suppress it. What it does hold is
// `conclusivelyOff` (>160 m off the line) and the 80 m streak paths, for the first 150 m
// after a reroute — i.e. exactly the window in which the new line was computed from a
// position the car had already left.
export const SWAP_FASTPATH_ARM_M = 150;
// ── GATE 2b: THE TREND IS ONLY ADMISSIBLE AGAINST A LINE THE CAR HAS BEEN ON ───
// (also reported as `held why=trend`.)
//
// This is the gate that actually stops the storm, and the 40 m travel gate above does
// NOT on its own — replaying the trace proves it. The trend measures growth away from
// THIS line. A reroute requested from inside a parking lot has its origin snapped to the
// nearest ROAD, so the new line is installed with the car ~30 m off it and the car never
// joins it: the logged `ribbon-trim anchorOff=27→64 proj=31→65` says the car was never
// nearer than 27 m to any of the five routes it was handed. Growth away from a line you
// were never on measures the LOT, not a departure — and asking again just re-snaps to the
// same road, which is the ratchet. So the trend counts only once the car has actually
// been within ONROUTE_M of the route it is being judged against.
//   • no-op for a real wrong turn: that reroute is computed from a car that IS on a road,
//     so the first fix after the swap is metres from the new line and the gate opens.
//   • the escape hatch is intact: the distance/streak paths (>80 m off the line) still
//     fire once SWAP_FASTPATH_ARM_M has been driven, so a car that really is far off
//     every line — a divided highway whose route sits on the other carriageway, a driver
//     ignoring the new route — still reroutes, via `far`/`heading`/`sustained` instead of
//     `diverging`, a few seconds later.
// 25 m is the number the missed-maneuver detector already uses for "measurably off the
// line" (src/nav.ts), and it sits below every anchorOff logged during the storm (27 m).
export const ONROUTE_M = 25;
// ── GATE 3: CREEPING (`held why=creeping`) ─────────────────────────────────────
// Do not ask for a route at all while the car has been below 8 km/h for the last 10 s.
// That is parking, queueing at a lot exit, or hunting for a space — none of which a new
// route can help with, and all of which produce the slow monotonic drift the trend reads
// as a departure. A single fix at or above 8 km/h re-opens it immediately, so stop-and-go
// traffic (which crosses 8 km/h constantly) is unaffected.
//
// ⚠ A FIX WITH NO SPEED NO LONGER RE-OPENS IT (2026-09-04, adversarial review #2).
// It used to. The test was `typeof spd !== "number" || !Number.isFinite(spd) || spd >=
// CREEP_SPEED_MS`, so a speedless tick stamped `lastFastAt = now`; `now - lastFastAt`
// could then never reach CREEP_WINDOW_MS and this gate was DEAD for the exact class of
// fix that most needs it — a phone sitting in a lot with a wandering position and no
// Doppler solution. The heading gate it was modelled on is not analogous: falling back to
// `headingOff = true` WIDENS the trip on the argument that we cannot disprove a
// departure, whereas refreshing `lastFastAt` off nothing DISABLES a safeguard. Unknown
// now means unknown — the window ages normally, and 10 s with no fix KNOWN to be at or
// above 8 km/h engages the hold.
//   • the cost, bounded: a feed that never reports speed cannot reroute while this holds.
//     On the phone that feed does not exist — see the map.tsx receipts in WHAT COUNTS AS
//     TRAVEL above; `speedMs` is numeric on every tick nav.ts hands us. One fix at or
//     above 8 km/h clears it in either version.
//   • `offroute_storm_test.mts` scenario K is the gate: three minutes of stationary
//     3–8 m scatter with speed undefined/null/NaN. Pre-fix it reroutes; fixed it holds.
export const CREEP_SPEED_MS = 8 / 3.6;
export const CREEP_WINDOW_MS = 10000;

// PERPENDICULAR distance off the route line before off-route. Exported only so
// `offroute_storm_test.mts` scenario I can assert its trace stays BELOW it — i.e. that no
// streak path could have fired and the retry it measures can only be the trend.
export const REROUTE_DISTANCE_M = 80;
// ── HEADING FAST PATH (2026-09-11, Jeff's exit ramp) ───────────────────────────
// Receipts (build 78, PDT 09:29): braking from 100 km/h on the ramp from :27; the road-follow
// RELEASED at :46 (`pose-fix … rel=1`, `snap-mode gate=hdg hd=79` — the course 79° off the
// route bearing, which the estimator treats as "the line is wrong here"); dRoute 43 m at :52;
// the divergence TREND tripped at :54 (`off-route tripped d=56m streak=0 why=diverging`),
// and the reroute landed 134 ms later. So the reroute was instant and the DECISION was
// 8 s behind the strongest evidence we had. `headingOff` already exists as an input, but it
// only lowered the streak threshold, and the streak never arms below REROUTE_DISTANCE_M —
// a ramp runs beside its highway, so d grows late and the heading was inert at 43–56 m.
//
// This path trips on HEADING alone, guarded four ways so it can never be the lot storm:
//   • the heading must be KNOWN — from the FIX'S OWN COURSE (nav.ts). map.tsx keeps the display
//     heading sticky across course-less fixes; that held value is not direction evidence and must
//     never count here (nav.ts passes headingOff=true with no course: the distance-only fallback);
//   • the car must be physically off the line (> HDG_FAST_MIN_M: a lane plus the fix noise)
//     and MOVING (≥ HDG_FAST_MIN_SPEED_MS — the lot storm crept at 2.6 m/s);
//   • no route maneuver within HDG_FAST_MANEUVER_CLEAR_M ahead OR BEHIND: a legitimate turn AT a
//     maneuver has the course 45–90° off the segment bearing for a second or two before
//     the projection crosses the vertex — and the step ADVANCES at < 25 m, so "ahead" alone
//     would look clear one tick into the corner (Codex 2026-09-11, reproduced);
//   • HDG_FAST_TICKS consecutive qualifying ticks (fix-driven — timer starvation cannot
//     stretch them), and every existing hold still applies (post-swap arm, creep, in-flight,
//     the 8 s gap). Replay: tools/sim-qc/offroute_storm_test.mts scenarios S/T/U.
export const HDG_FAST_MIN_M = 12;
export const HDG_FAST_TICKS = 3;
export const HDG_FAST_MIN_SPEED_MS = 4;
export const HDG_FAST_MANEUVER_CLEAR_M = 100;
// ── DIVERGENCE TREND (2026-07-31) ──────────────────────────────────────────
// Jeff: "I took a different route and it took a while for the route to change, at
// least 1 min."
//
// The streak logic below is already fast ONCE you are 80 m off the line. The 80 m
// itself is the delay: turn onto a street that parallels the route and the gap opens
// slowly, so on a city grid you can drive a long way before any threshold trips. The
// missed-maneuver fast path does not help either — it needs you to have approached
// within 80 m of a maneuver first, and an early deliberate departure never does.
//
// A trend is a much better discriminator than a distance. On-route error OSCILLATES:
// GPS noise, lane changes and the simplified overview polyline all wander up and down
// around zero. A real departure MONOTONICALLY grows. So: already clearly off the line,
// growing on essentially every tick, and enough total growth that it cannot be noise.
// That fires while the gap is still ~45 m instead of waiting for 80 m.
//
// Tuned to require BOTH sustained growth and a floor well above polyline-simplification
// error (which is a fixed offset on a curve — it does not keep growing).
// TUNED BY SIMULATION over ten synthetic traces (scratchpad/offroute_sim2.js), three
// that must reroute and seven that must not. A 5-tick window was tried FIRST and was
// wrong in both directions: it fired on a 4-tick urban-canyon spike (a spurious reroute
// mid-drive — worse than the bug) and still missed the slow parallel-street case it was
// written for. The fix is a LONGER window, because that is what actually separates the
// two: a multipath spike rises fast and falls back within a few ticks, so it can never
// stay monotonic for ten; a real departure can. Result at these values, 10/10:
//   parallel street  23 s -> 10 s      urban-canyon spike   no reroute
//   gentle fork      38 s -> 19 s      two spikes in a row  no reroute
//   hard wrong turn   8 s (unchanged)  sweeping bend        no reroute
//   GPS noise / lane change / overtaking / service road beside the highway: none
//
// ⚠ 2026-09-04: the trend is a FAST PATH (it needs no streak) AND it is reset on every
// route swap. Those two together are the lot storm above — hence the gates at the top of
// this file. The constants themselves are unchanged; nothing here was re-tuned.
const DIVERGE_MIN_M = 45;        // must already be clearly off the line
const DIVERGE_GROWTH_M = 20;     // total growth across the window
const DIVERGE_SLACK_M = 3;       // per-sample dip allowed, so one noisy fix doesn't reset
// ⚠ WINDOW IS WALL-CLOCK, NOT A TICK COUNT (corrected 2026-07-31, same day).
// It was DIVERGE_TICKS = 10 and the comment claimed "~10 s". That was wrong, and the
// error is large in the exact case this detector exists for. Fixes are gated by
// distanceInterval, not time — 2 m plugged, 8 m unplugged, 5 m background — so ten
// samples take:
//        5 km/h   10 km/h   20 km/h
//   eco    58 s     29 s      14 s
// Pulling out of a car park unplugged is the 5-10 km/h column, so the "reroute in ~10 s"
// I measured was really up to a minute. A wall-clock window is honest at any cadence.
// The sample floor keeps the anti-spike property: a multipath excursion rises and falls
// within a few seconds, so it cannot stay monotonic across a full window.
const DIVERGE_WINDOW_MS = 8000;
const DIVERGE_MIN_SAMPLES = 4;
// One reroute request per this long, at most. Unchanged from the inline version — it is
// what set the storm's 8–12 s cadence, and on its own it only rate-limits a storm, it
// does not stop one.
const OFFROUTE_MIN_GAP_MS = 8000;

// ── GATE 4: ONE REROUTE REQUEST IN FLIGHT (`held why=inflight`, 2026-09-05) ────
// Rodrigo, iOS + CarPlay, phone LOCKED, 2026-09-04 19:14-19:19 PT (crash_reports):
// off-route trips kept posting every 8-9 s (native location events still ran the
// decision) while JS TIMERS were frozen — the 15 s route-fetch abort `setTimeout`s
// (src/nav.ts) all fired at once at 19:19:25, `route-fetch-abort-fired ms=176000-306929`,
// 29 of them, and 29 `reroute-result … superseded` landed in the same burst. Each of the
// 29 trips had issued its own request; NOTHING bounded how many could be outstanding.
//
// The first fix tried was a blanket `timers-starved` hold. Codex adversarial review
// (2026-09-05) rejected it, correctly: timer silence does not establish that a network
// request cannot settle — `fetchRoutes` uses its timer for CANCELLATION, not completion —
// so that hold would have disabled off-route recovery outright for the whole locked
// interval, and a genuine missed turn with fresh GPS and no request in flight would never
// reroute. The bound belongs at the REQUEST OWNER, not on a proxy for it.
//
// So: at most ONE reroute request outstanding (src/rerouteSlot.ts — pure, so the storm
// gate drives the real thing; nav.ts wraps it). While one is younger than
// ROUTE_FETCH_TIMEOUT_MS the gate holds `inflight`; past that age nav.ts's FIX-DRIVEN
// sweep (which runs off location events and therefore survives frozen timers) aborts it
// and frees the slot, and the very next tick may trip. 29 stacked requests becomes at
// most one per ~16 s at a 1 Hz fix cadence. `timersStarvedMs` stays in the tick input as
// a RECEIPT ONLY — it is a diagnostic, never a blocker.
//   • `offroute_storm_test.mts` scenario L is the gate (Rodrigo's storm, modelled as
//     hanging requests + frozen timers); M asserts a fresh-GPS wrong turn with timers
//     frozen and no request in flight trips on exactly the tick it does today;
//     N asserts the second request is allowed once the fix-driven abort fires.
export type OffRouteWhy = "missed" | "diverging" | "far" | "heading" | "sustained";
export type OffRouteHold = "moved" | "trend" | "creeping" | "inflight";

// How long a reroute request may be outstanding before it is abandoned. ONE number for
// three consumers, which is why it lives in this dependency-free file rather than in
// nav.ts where it started: (1) `fetchRoutes`/`fetchRouteViaStops`'s own `setTimeout`
// abort — now the SECOND line of defence, since a frozen timer service cannot fire it;
// (2) nav.ts's fix-driven sweep, the FIRST line, which ages the request off GPS events;
// (3) the `inflight` hold below. 15 s is unchanged from the 2026-08-21 value and its
// original measurement stands: well past a normal Directions round trip (rkoji7's 20
// hung refetches resolved 3-7 MINUTES late while Supabase inserts from the same phone
// flowed within 0.2 s).
export const ROUTE_FETCH_TIMEOUT_MS = 15000;

/** True once an outstanding reroute request is old enough to abandon. Exported so the
 *  fix-driven sweep in nav.ts, the `inflight` hold and the sim-qc gate all decide with
 *  ONE predicate instead of three copies of `>`. Non-numeric age = no request. */
export function rerouteInflightExpired(ageMs?: number | null): boolean {
  return typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs > ROUTE_FETCH_TIMEOUT_MS;
}

export type OffRouteGateState = {
  streak: number;                                   // consecutive ticks beyond REROUTE_DISTANCE_M
  hist: { t: number; d: number }[];                 // divergence trend window
  swapAt: number;                                   // last route SWAP only — never a trip
  // ⚠ `swapAt`, `travelSinceSwapM` and `onThisRoute` are ROUTE-RELATIVE: they describe the
  // polyline currently being judged against, so ONLY `resetOffRouteGate` (an actual swap)
  // may clear them. `lastTripAt` is the separate per-REQUEST cooldown. See the trip block.
  travelSinceSwapM: number;                         // RAW GPS travel since then
  lastFix: { lat: number; lng: number } | null;
  lastFastAt: number;                               // last fix at or above CREEP_SPEED_MS
  lastTripAt: number;
  onThisRoute: boolean;                             // has been within ONROUTE_M since the swap
  hdgOffTicks: number;                              // consecutive ticks qualifying for the heading fast path
};

export type OffRouteTickInput = {
  now: number;
  dRoute: number;          // perpendicular metres from the raw fix to the route line
  headingOff: boolean;     // course diverges from the route's local bearing (nav.ts)
  /** The heading behind `headingOff` is REAL (nav.ts reports headingOff=true with no heading at all,
   *  as a distance-only fallback — that default must never feed the heading fast path). */
  headingKnown?: boolean;
  /** Distance to the current step's maneuver (nav.ts `dManeuver`); a turn that is about to happen
   *  legitimately points the car off the segment. null/undefined = unknown = treated as clear. */
  dManeuverM?: number | null;
  /** Distance to the maneuver just PASSED (the previous step's end). nav.ts advances the step at
   *  < 25 m, so `dManeuverM` jumps to the NEXT turn while the car is still inside this one — the
   *  guard must look both ways (Codex 2026-09-11). null/undefined = none / unknown. */
  dManeuverBehindM?: number | null;
  missedManeuver: boolean; // the missed-maneuver fast path (nav.ts)
  lat: number;
  lng: number;
  // m/s from GPS. Missing/non-finite = UNKNOWN — it neither refreshes the creep window
  // nor corroborates travel. See GATE 3 and WHAT COUNTS AS TRAVEL.
  speedMs?: number | null;
  // Horizontal accuracy in metres for THIS fix (map.tsx's `coords.acc`, CoreLocation's
  // negative sentinel already dropped). Optional: the background takeover publishes no
  // accuracy (app/(app)/map.tsx:1977-1984), so it arrives undefined there. Used only as
  // the minimum-step floor on the unknown-speed branch.
  accM?: number | null;
  // ms since src/timerLiveness.ts's 1 s heartbeat last ticked. ⚠ DIAGNOSTIC ONLY — it is
  // carried so the `off-route held`/`tripped` receipts can say whether JS timers were
  // frozen at the moment of the decision, and it NEVER blocks a trip. It used to (a
  // `timers-starved` hold, 2026-09-05, never shipped): see GATE 4 above for why that was
  // wrong — timer silence does not establish that a request cannot settle, and holding on
  // it would disable recovery for a genuine wrong turn with fresh GPS. undefined =
  // unmeasured.
  timersStarvedMs?: number;
  // Age in ms of the ONE outstanding reroute request, or null/undefined when none is in
  // flight. nav.ts owns the registry (it owns the AbortController) and sweeps expired
  // entries off GPS fixes BEFORE calling this, so an age past ROUTE_FETCH_TIMEOUT_MS
  // normally cannot reach here — and if it ever does it must NOT hold. See GATE 4.
  rerouteInFlightMs?: number | null;
};

export type OffRouteDecision = {
  trip: boolean;                 // fire onOffRoute / ask for a new route
  why: OffRouteWhy | null;       // why it WOULD have tripped (set even when held)
  held: OffRouteHold | null;     // which gate stopped it, if any
  streak: number;
  sinceSwapS: number;
  travelSinceSwapM: number;
};

export const newOffRouteGateState = (now = 0): OffRouteGateState => ({
  streak: 0, hist: [], swapAt: now, travelSinceSwapM: 0, lastFix: null, lastFastAt: 0,
  lastTripAt: 0, onThisRoute: false, hdgOffTicks: 0,
});

/**
 * Call on every route SWAP (the polyline changed) — the trend is meaningless against a
 * different line and the travel budget starts again on the new one.
 * Deliberately does NOT clear `lastFastAt`: the creep window is a property of the CAR,
 * not of the route, and clearing it per swap would let a 10 s storm re-arm itself forever.
 * Nor `lastTripAt`: the 8 s request cooldown is a property of the REQUEST, and a swap is
 * the answer to a request we just made.
 *
 * ⚠ THIS IS THE ONLY PLACE ALLOWED TO CLEAR ROUTE-RELATIVE STATE. It is reached from
 * exactly TWO call sites, both in nav.ts, and no others:
 *   1. the `route?.polyline` change effect — a real mid-drive swap, which by definition
 *      cannot run for a reroute that failed, timed out, was superseded or came back stale;
 *   2. every inactive→active transition (2026-09-04, adversarial review #2). The swap
 *      effect CANNOT cover the session boundary: while inactive it records the new
 *      polyline key and returns, so a route that changed between sessions arrives with
 *      the key already matching and the swap branch never runs — and the teardown leaves
 *      streak, hist, travelSinceSwapM, onThisRoute and lastFix exactly as the last drive
 *      left them. Trip 2 would inherit trip 1's evidence (onThisRoute true, a travel
 *      budget already past both SWAP_ARM_TRAVEL_M and SWAP_FASTPATH_ARM_M) and could
 *      reroute on its opening ticks. `offroute_storm_test.mts` scenario J is the gate.
 * Resetting on activation can only DELAY a reroute (the 40 m budget re-arms), never cause
 * one — which is why it is safe even if `active` were ever to flicker mid-drive.
 */
export function resetOffRouteGate(st: OffRouteGateState, now: number): void {
  st.streak = 0;
  st.hist.length = 0;
  st.swapAt = now;
  st.travelSinceSwapM = 0;
  st.lastFix = null;
  st.onThisRoute = false;   // re-earned against the NEW line, on the next fix
  st.hdgOffTicks = 0;
}

const haversineM = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

// ⚠ NOT A GATE — a RECEIPT threshold (2026-09-05; it was briefly TIMERS_STARVED_HOLD_MS and
// renamed the same day so the name cannot lie). Past this many ms of timer silence the
// off-route crumbs carry `starved=<ms>`, so a storm read back off crash_reports
// can be attributed to a freeze without guessing. It blocked trips for one unshipped
// revision; GATE 4 above records why that was wrong and what replaced it. Kept at 3× the
// 1 s heartbeat — one missed tick is noise, three is a freeze — and still referenced by
// src/timerLiveness.ts's FORCED_STARVE_DT_MS comment as the far end of the real thresholds.
export const TIMERS_STARVED_RECEIPT_MS = 3000;

/** Which gate (if any) blocks a trip right now. `diverging` = the trend fired.
 *  `trendOnly` = the trip would rest on the trend ALONE (no streak / distance / missed
 *  evidence of its own) — defaults to `diverging` for legacy callers.
 *  `rerouteInFlightMs` is the age of the outstanding reroute request (null = none). */
export function holdReason(
  st: OffRouteGateState,
  diverging: boolean,
  now: number,
  rerouteInFlightMs?: number | null,
  trendOnly: boolean = diverging,
  dRoute: number = 0,   // legacy callers (no distance) keep the creep hold unconditional
): OffRouteHold | null {
  // FIRST, deliberately: while a request is outstanding a second one can only stack. When
  // a storm is read back off crash_reports this must name the bound that actually held it,
  // not whichever older gate happened to be closed as well.
  // Note the polarity — an EXPIRED age does not hold. The sweep should already have freed
  // the slot; if it somehow has not, the stuck request must never be able to wedge the
  // gate shut, which is the exact failure mode the `timers-starved` hold would have had.
  if (typeof rerouteInFlightMs === "number" && Number.isFinite(rerouteInFlightMs) &&
      !rerouteInflightExpired(rerouteInFlightMs)) return "inflight";
  if (st.travelSinceSwapM < SWAP_ARM_TRAVEL_M) return "moved";
  // ── THE TWO POST-SWAP HOLDS ARE PER PATH, NOT PER TREND FLAG (2026-09-05, Rodrigo) ──
  // Until tonight these two lines read `if (!diverging && travel < 150) trend` and
  // `if (diverging && !onThisRoute) trend` — keyed on the TREND FLAG, not on the path that
  // wants to trip — and the `why` ladder ranks the trend ABOVE `far`/`heading`/`sustained`
  // because it is the fast path. So whenever the distance happened to be growing
  // monotonically (which it always is for a driver leaving a reroute they never joined),
  // EVERY trip — even one that also had 160 m+ and a streak of 30 behind it — was held
  // until the car came within 25 m of the new line, with no travel bound at all. Rodrigo 14:27:22 (crash_reports):
  // reroute applied, then `held why=trend d=82m since=15s trav=71m`, `d=120m since=25s
  // trav=114m` — 25 s of driving away with no reroute, until he gave up and re-plotted by
  // hand ("takes a long time to re-route"; GR Advisor: "I have the same"). The sim replay the
  // same afternoon held a `far` trip for 48 s while d grew to 1.5 km.
  // The lot storm (the reason these holds exist) is `why=diverging` at 45-70 m with streak
  // 0 — the trend FAST PATH. That path still needs the car to have joined the line; every
  // other path carries its own evidence (a streak, >160 m, a missed maneuver) and needs only
  // the 150 m post-swap travel arm. `trendOnly` is computed by the tick from the SAME
  // ladder with the trend switched off. `offroute_storm_test.mts` Q is the gate; A (the
  // lot storm) is asserted unchanged.
  if (trendOnly && !st.onThisRoute) return "trend";
  if (!trendOnly && st.travelSinceSwapM < SWAP_FASTPATH_ARM_M) return "trend";
  // CREEP HOLD ONLY NEAR THE LINE (2026-09-06, Codex rescue: "creeping can hold indefinitely").
  // The hold exists for a car crawling in a lot 45-70 m off the route (Olaf's storm); a car
  // crawling in a traffic jam 160 m+ off it — conclusively on another road — needs the reroute,
  // and the creep window would otherwise hold it for as long as the jam lasts.
  if (now - st.lastFastAt >= CREEP_WINDOW_MS && dRoute <= REROUTE_DISTANCE_M * 2) return "creeping";
  return null;
}

/**
 * One GPS tick. Mutates `st` (travel, creep window, streak, trend) and returns the
 * decision. Pure otherwise: no clock, no logging, no I/O.
 */
export function offRouteTick(st: OffRouteGateState, t: OffRouteTickInput): OffRouteDecision {
  // ── raw travel + creep window ────────────────────────────────────────────────
  // UNKNOWN SPEED IS UNKNOWN (2026-09-04): it does not stamp `lastFastAt` (GATE 3) and it
  // does not corroborate a step (WHAT COUNTS AS TRAVEL). Both were wrong the other way.
  const spd = typeof t.speedMs === "number" && Number.isFinite(t.speedMs) ? t.speedMs : null;
  if (spd !== null && spd >= CREEP_SPEED_MS) st.lastFastAt = t.now;
  const prev = st.lastFix;
  st.lastFix = { lat: t.lat, lng: t.lng };   // advances whether or not the step counts
  if (prev) {
    const stepM = haversineM(prev.lat, prev.lng, t.lat, t.lng);
    const accM = typeof t.accM === "number" && Number.isFinite(t.accM) && t.accM > 0 ? t.accM : 0;
    const moved = spd !== null
      ? spd >= TRAVEL_MIN_SPEED_MS                              // Doppler says the car moved
      : stepM >= Math.max(TRAVEL_MIN_STEP_M, accM);             // position is all we have
    if (moved) st.travelSinceSwapM += stepM;
  }
  if (t.dRoute <= ONROUTE_M) st.onThisRoute = true;   // the car has joined this line

  // ── streak: count ANY tick that's off the line by more than the threshold. The
  // heading gate does not SUPPRESS the count (that was the "~1 minute to recalculate"
  // bug: on a road PARALLEL to the route the heading stays aligned, so the streak reset
  // every tick). Heading feeds the TRIP threshold instead.
  const conclusivelyOff = t.dRoute > REROUTE_DISTANCE_M * 2;   // >160 m: GPS multipath can't explain this
  if (t.dRoute > REROUTE_DISTANCE_M) st.streak += 1;
  else st.streak = 0;
  // Heading fast path: consecutive ticks with a KNOWN heading off the line, the car off the
  // line and moving, and no maneuver about to explain it. See HDG_FAST_* above.
  const farEnough = (d: number | null | undefined) => !(typeof d === "number" && Number.isFinite(d)) || d > HDG_FAST_MANEUVER_CLEAR_M;
  const maneuverClear = farEnough(t.dManeuverM) && farEnough(t.dManeuverBehindM);
  const hdgFastTick =
    t.headingKnown === true && t.headingOff &&
    t.dRoute > HDG_FAST_MIN_M &&
    spd !== null && spd >= HDG_FAST_MIN_SPEED_MS &&
    maneuverClear;
  st.hdgOffTicks = hdgFastTick ? st.hdgOffTicks + 1 : 0;

  // ── divergence trend — catches the slow parallel-street departure long before the
  // 80 m threshold does. See the DIVERGE_* block for why a trend beats a distance.
  const hist = st.hist;
  hist.push({ t: t.now, d: t.dRoute });
  while (hist.length && t.now - hist[0].t > DIVERGE_WINDOW_MS) hist.shift();
  const diverging =
    hist.length >= DIVERGE_MIN_SAMPLES &&
    t.now - hist[0].t >= DIVERGE_WINDOW_MS * 0.75 &&   // a real window, not 4 fast fixes
    t.dRoute > DIVERGE_MIN_M &&
    t.dRoute - hist[0].d > DIVERGE_GROWTH_M &&
    hist.every((v, i) => i === 0 || v.d >= hist[i - 1].d - DIVERGE_SLACK_M);

  // Trip fast when the evidence is strong, slower when it's marginal:
  //   • conclusively off (>160 m)      → 2 ticks (~2 s), heading irrelevant
  //   • off + heading diverging (>55°) → 3 ticks (~3 s): a real wrong turn
  //   • off but heading still aligned  → 6 ticks (~6 s): a SUSTAINED offset,
  //     not a momentary multipath spike (the parallel-road departure)
  // The evidence that stands WITHOUT the trend (missed / far / heading / sustained) — what
  // holdReason uses to tell a trend-only trip (needs the car to have joined the line) from
  // one that has a streak or a distance of its own (needs only the 150 m post-swap arm).
  const strongWhy: OffRouteWhy | null =
    t.missedManeuver ? "missed" :
    conclusivelyOff ? (st.streak >= 2 ? "far" : null) :
    st.hdgOffTicks >= HDG_FAST_TICKS ? "heading" :                 // the 09-11 fast path
    t.headingOff ? (st.streak >= 3 ? "heading" : null) :
                   (st.streak >= 6 ? "sustained" : null);
  const why: OffRouteWhy | null =
    t.missedManeuver ? "missed" :
    diverging ? "diverging" :
    strongWhy;
  const trendOnly = why === "diverging" && strongWhy == null;

  const base = {
    streak: st.streak,
    sinceSwapS: (t.now - st.swapAt) / 1000,
    travelSinceSwapM: st.travelSinceSwapM,
  };
  if (!why) return { trip: false, why: null, held: null, ...base };
  if (t.now - st.lastTripAt <= OFFROUTE_MIN_GAP_MS) return { trip: false, why, held: null, ...base };
  const held = holdReason(st, diverging, t.now, t.rerouteInFlightMs, trendOnly, t.dRoute);
  if (held) return { trip: false, why, held, ...base };

  // ── COOLDOWN ONLY — NOTHING ROUTE-RELATIVE (corrected 2026-09-04, same day) ──
  // A trip does NOT install a route; it only asks for one. The request can come back
  // empty (`fetchRoutes` returns [] on a timeout or a failure — src/nav.ts:176, crumb
  // `route-fetch-fail`), superseded, or stale (app/(app)/map.tsx: `if (superseded ||
  // stale) return;` then `if (res.length > 0)`). In all three cases NO polyline changes,
  // so nav.ts's route-swap effect — the ONLY caller of resetOffRouteGate — never runs.
  //
  // This block used to clear `onThisRoute`, `swapAt` and the travel budget here as well,
  // "so a failed reroute cannot storm either". That threw away divergence evidence about
  // the route the car is STILL BEING JUDGED AGAINST: with `onThisRoute` false and the old
  // line still live, `holdReason` answers `trend` (diverging && !onThisRoute) forever,
  // and the streak paths need >80 m. A driver on a parallel road 45-80 m out is in the
  // gap between the two and would never be rerouted again for the rest of the drive.
  // Found by adversarial review; `offroute_storm_test.mts` scenario I is the gate — it
  // asserts the OLD reset gives exactly ONE trip and never retries, the new one retries.
  //
  // The lot storm is untouched by this: a reroute that LANDS calls resetOffRouteGate,
  // which clears all of it. One that does NOT land is bounded by OFFROUTE_MIN_GAP_MS plus
  // a trend window that must be rebuilt from empty (>= DIVERGE_WINDOW_MS*0.75 = 6 s), so
  // at most one retry per ~9 s — and the creep gate still holds a car crawling in a lot,
  // which is what the storm actually was.
  st.lastTripAt = t.now;
  st.streak = 0;
  st.hist.length = 0;          // the trend has been acted on; re-earn it from here
  return { trip: true, why, held: null, ...base };
}
