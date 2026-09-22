// departureBearing.ts — "which way is the car actually pointing right now?"
//
// Jeff, 2026-07-30: "when I'm parked at work and I start a route it makes me do a
// U-turn when I can easily go forward."
//
// That is not a routing-quality problem, it is a MISSING INPUT. The Directions API
// picks the nearest point on the nearest road and is free to depart in either
// direction along it, so on a two-way street it will happily choose the side that
// happens to be a few metres closer — which from a parking spot is a reversal. The
// router was never told which way we face.
//
// ⚠ THE NOTE BELOW WAS WRONG (re-measured 2026-09-06). With the app's exact request shape —
// driving-traffic, alternatives=true, `bearings=<hdg>,45;` — the parameter DOES steer the
// departure: on Rodrigo's street a westward constraint turned both returned routes from
// "Drive east" (90°) to "Drive west" (270°) at +76 m / +20 s, and an eastward one left the
// eastbound routes untouched. map.tsx now uses it: reroutes pass the GPS heading
// (REROUTE_ORIGIN_BEARING) and an initial plot whose fastest route departs >75° off the
// facing is re-asked once with the facing as the constraint. The client-side ranking below
// stays as the tie-breaker among whatever comes back. The original July finding is kept
// for the record, not as guidance:
// (July) The Directions API's own `bearings`
// parameter looks like the answer and IS NOT. It validates (a wrong entry count 422s
// with "Number of bearing elements must match number of coordinates") but has NO
// effect on the route: tested across three locations, both the `driving` and
// `driving-traffic` profiles, filled and empty second entries, with and without
// `radiuses` — even `bearings=0,10` on an east-west street returned the identical
// eastbound line. Nudging the ORIGIN forward along the facing bearing is worse: at
// 20 m and 35 m it snapped to the CROSS street and departed 178 deg backwards.
//
// What works is client-side. We already request alternatives, and Mapbox genuinely
// returns BOTH directions as separate alternatives on a two-way street — verified on
// Inverness St, where alt0 departs 181 deg and alt1 departs 1 deg, and the FASTEST is
// the one that turns you around. That is the entire bug: we picked fastest, blind to
// which way the car pointed. This module supplies the missing input; map.tsx's
// existing forward-preference ranker consumes it.
//
// ── WHY NOT JUST USE coords.heading ──────────────────────────────────────────
// GPS course is a TRAVEL direction: it is derived from successive fixes, so it does
// not exist when you are stationary. iOS reports -1, and map.tsx deliberately holds
// the last good value — which after a drive is genuinely the direction you parked
// facing, but after sitting overnight (or after being carried indoors) is stale and
// can be badly wrong. So: use the course while it is FRESH, and fall back to the
// magnetometer, which measures where the device is physically pointing and works
// perfectly well at a standstill.
//
// getHeadingAsync() subscribes, takes one sample and unsubscribes, so this costs a
// brief magnetometer read at route time — not a running compass watcher.
//
// Fails soft in every direction: no permission, no compass, poor calibration, a
// timeout or a throw all return null, and a null simply means "rank by ETA alone",
// i.e. exactly today's behaviour.
import * as Location from "expo-location";
import { haversineMeters, countRouteUturns, firstUturnMeters } from "./nav";
import { carSpot } from "./locationPrivacy";
import { spotFacing } from "./carSpotTrust";

// How long a GPS course stays trustworthy as a proxy for "facing". A car that was
// moving 90 s ago is almost certainly still pointing the way it was travelling —
// parking manoeuvres are short and the final one sets the heading anyway.
const COURSE_FRESH_MS = 90_000;
// iOS compass accuracy buckets: 3 = <20 deg, 2 = <35 deg, 1 = worse, 0 = unusable.
// Require 2, because the whole point is to distinguish "forward" from "reversed" and
// anything at or below 1 cannot do that reliably. It also has to be comfortably
// inside the +/-75 deg cone the forward-preference ranker uses, and 35 deg is.
const MIN_COMPASS_ACCURACY = 2;
// Hard ceiling on how long we will wait for a compass sample before routing without
// one. Generous enough for a cold magnetometer, short enough that the driver never
// notices — the route fetch itself normally takes longer than this.
const COMPASS_TIMEOUT_MS = 1200;

let lastCourse: { deg: number; at: number } | null = null;
// Which source answered the last getDepartureBearing() — printed on the depart-rank rows as fsrc=.
export type DepartureBearingSource = "spot" | "course" | "compass" | "none";
let _lastSource: DepartureBearingSource = "none";
export function departureBearingSource(): DepartureBearingSource { return _lastSource; }

// Feed every GPS fix that carries a real course. Cheap, called from the position
// pipeline. Negative / non-finite values are iOS's "no course" and are ignored.
export function noteCourse(headingDeg: number | null | undefined): void {
  if (typeof headingDeg !== "number" || !Number.isFinite(headingDeg)) return;
  if (headingDeg < 0 || headingDeg > 360) return;
  lastCourse = { deg: headingDeg, at: Date.now() };
}

// Best estimate of the direction the car is FACING, or null if we genuinely cannot
// tell. Never throws. `near` is where the route is being started FROM (the plot's origin);
// without it the parked heading cannot be applied (it is only valid AT the spot).
export async function getDepartureBearing(near?: { lat: number; lng: number } | null): Promise<number | null> {
  // 1) A fresh travel course beats the compass: it needs no calibration, is immune
  //    to magnetic interference (a car is a large steel box full of magnets) and is
  //    unaffected by how the phone is oriented in its mount.
  const c = lastCourse;
  if (c && Date.now() - c.at <= COURSE_FRESH_MS) { _lastSource = "course"; return c.deg; }
  // 1b) THE PARKED HEADING (2026-09-16, Jeff: "if I'm parked on the right side of the road I should keep going
  //     that direction when I launch the route again"). The car spot carries the course of the last MOVING fix
  //     before the stop (src/locationPrivacy.ts noteFix → src/carSpotTrust.ts spotFacing): valid only within
  //     SPOT_FACING_MAX_M of that spot, inside the spot's own 24 h life, and retired by a slow final turn. It
  //     comes AFTER a fresh course (Codex: a car still rolling has better evidence than where it once stopped)
  //     and BEFORE the compass, because it does not care how the phone sits in the mount or what the car's steel
  //     does to a magnetometer, and it survives a workday. Field 09-16: leaving work at 17:32 the compass DID read
  //     the facing right (141°) and the morning parkade had nothing (facing=null) — this answers the on-street
  //     park where neither is reliable. A reversed-in park faces the other way; that costs one early reroute.
  const parked = spotFacing(carSpot(), near ?? null, Date.now());
  if (parked != null) { _lastSource = "spot"; return parked; }
  _lastSource = "none";

  // 2) Standing still, or long parked → ask the magnetometer where we point.
  //
  // ⚠ TIMEOUT IS LOAD-BEARING. getHeadingAsync subscribes and resolves on the FIRST
  // sample — so on hardware with no magnetometer, or one that never calibrates, it
  // can simply never settle. The caller races this against the route fetch, so an
  // un-timed hang would mean a route that never appears: a far worse bug than the
  // U-turn this exists to fix. Lose the compass instead, and route as we do today.
  try {
    const h = await Promise.race([
      Location.getHeadingAsync(),
      new Promise<null>((r) => setTimeout(() => r(null), COMPASS_TIMEOUT_MS)),
    ]);
    if (!h) return null;
    const acc = typeof h?.accuracy === "number" ? h.accuracy : 0;
    if (acc < MIN_COMPASS_ACCURACY) return null;
    // trueHeading is -1 without location permission; magHeading still works and the
    // few degrees of declination are irrelevant against a 90 deg tolerance.
    const deg = (typeof h?.trueHeading === "number" && h.trueHeading >= 0)
      ? h.trueHeading
      : h?.magHeading;
    if (typeof deg !== "number" || !Number.isFinite(deg) || deg < 0) return null;
    _lastSource = "compass";
    return deg;
  } catch {
    return null;
  }
}

// ── PREFER A ROUTE THAT DEPARTS THE WAY WE FACE ──────────────────────────────
// Lives HERE, not in a screen, because FOUR surfaces start routes and they must
// choose identically: the phone's own route effect (iOS + Android) and
// carActions.startCarNav, which is what a search from CarPlay OR Android Auto runs.
// It was duplicated-by-omission before — the phone got the forward preference and
// the car surfaces kept sorting on ETA alone, so the same destination gave a U-turn
// from the head unit and not from the phone.
const FORWARD_TOLERANCE_DEG = 75;
// ── REROUTE USES A U-TURN-ONLY GATE (2026-07-31) ───────────────────────────
// Jeff: "when it re routed it did not route the fastest 'best way'."
//
// orderRoutesForward puts EVERY forward option ahead of every non-forward one, so a
// forward route that is ten minutes slower beats the fastest one. At DEPARTURE that is
// right — you are parked, pointing a way, and being told to U-turn out of your own
// street is the bug this fixed. Mid-drive it is wrong: a reroute is computed from where
// you are NOW, and the fastest continuation very often begins with an ordinary left or
// right. routeInitialBearing looks ~25 m ahead, so that first turn IS the bearing it
// measures — at 75° a normal left turn scores "not forward" and gets demoted below a
// slower straight-on line. That is exactly the symptom.
//
// So the reroute path keeps the guard but narrows it to what it was actually for:
// doubling back. 135° still catches a real U-turn and no longer punishes a turn.
export const UTURN_ONLY_TOLERANCE_DEG = 135;

function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat), dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// The direction a route initially heads — bearing from its origin to the end of the
// first step that is >=25 m away (skips a tiny DEPART step). null if unknown.
export function routeInitialBearing(r: any): number | null {
  const steps = r?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const start = steps[0]?.start;
  if (!start || typeof start.lat !== "number") return null;
  for (let i = 0; i < Math.min(steps.length, 4); i++) {
    const end = steps[i]?.end;
    if (end && typeof end.lat === "number" && haversineMeters(start, end) >= 25) return bearingDeg(start, end);
  }
  const end = steps[0]?.end;
  return end && typeof end.lat === "number" ? bearingDeg(start, end) : null;
}

// ══ A U-TURN COSTS TWO MINUTES WHEN WE RANK (2026-09-21, Jeff: "you can fix them ...go") ══
// Rodrigo, WhatsApp 2026-09-20 23:37: "the app loves to send me on borderline illegal
// u-turns. On my last drive tonight it tried to make me do two u turns that weren't safe.
// Something I haven't experience with waze or gmaps" — and 23:46, after a week of running
// Waze alongside: "it never sent me in weird u turns".
//
// MEASURED at his departure point (49.242496,-123.003784, live Directions replay
// 2026-09-21, his 05:12:06Z drive): Mapbox offered BOTH of these and we took the second.
//   alt0  363 s  departs 102°  0 U-turns   "Turn right onto Willingdon Avenue"
//   alt1  336 s  departs 360°  1 U-turn    "Make a left U-turn at Willingdon Avenue… if permitted"
// His row: `depart-rank facing=273 chosenBr=344 cands=179/402s,344/379s`. The ranking below
// scored alt1 "forward" (70° off his facing, inside the 75° gate) and then sorted on pure
// duration — so it traded a clean route for 27 SECONDS. Nothing in this file, or anywhere
// else on the path to the driver, had ever looked at whether a route contains a U-turn.
//
// 120 s is a JUDGEMENT, not a measurement: enough to lose 27 s comfortably, not so much
// that a genuine 5-minute detour beats one legal U-turn. Where every candidate carries the
// same U-turn — a divided arterial with the destination behind you, which is the OTHER half
// of Rodrigo's night — the penalty cancels out and the order is unchanged. That case is
// Mapbox's answer and no ranking can fix it.
export const UTURN_PENALTY_S = 120;

// ⛔ AND A U-TURN IN THE FIRST 600 m IS A REVERSAL WEARING A DISGUISE.
// The time penalty alone does NOT fix Rodrigo's night, and the gate below is why: his clean
// option left 94° off his facing — an ordinary right turn out of the lot — so the 75° forward
// gate had already thrown it into the back group, where no amount of penalty can reach past a
// "forward" route. Meanwhile the route we picked went north and then made its U-turn 400 m
// later, which is a reversal in everything but the first 25 m of bearing the ranker measures.
// So an EARLY U-turn costs a route its forward status; a U-turn 5 km down a genuinely
// forward line does not, and only pays the time penalty. That keeps Jeff's original 2026-07-30
// complaint fixed ("when I'm parked at work and I start a route it makes me do a U-turn when I
// can easily go forward") — a clean forward route still beats a clean backward one every time.
export const EARLY_UTURN_M = 600;

// Does the route ask for a U-turn inside the first EARLY_UTURN_M metres? Nothing but a
// threshold on firstUturnMeters (src/nav.ts), which walks the NavStep distances in order and
// stops at the first U-turn key. It was this file's own inline walk until 2026-09-21, when
// the `uAt=` breadcrumb needed the same number on the route-swap row and there was no way to
// import it back out without closing a cycle — so the walk moved next to countRouteUturns,
// where the NavStep shape is already documented, and this became the one-line caller. No
// behaviour change: the old loop's `if (run > EARLY_UTURN_M) return false` was an early exit,
// not a rule, and a later U-turn already returned false through the same comparison.
export function hasEarlyUturn(r: any): boolean {
  const m = firstUturnMeters(r);
  return m != null && m <= EARLY_UTURN_M;
}

// Order routes so the FASTEST one heading roughly the way the car already faces comes
// first; options that start with a U-turn fall to the back (also fastest-first).
// No heading -> plain fastest-first, i.e. the behaviour before any of this existed.
// Either way a route is ranked on its duration PLUS UTURN_PENALTY_S per U-turn it asks for.
export function orderRoutesForward<T = any>(res: T[], heading?: number, toleranceDeg?: number): T[] {
  if (!Array.isArray(res) || res.length <= 1) return res;
  const dur = (r: any) => {
    const base = r?.duration_in_traffic_s ?? r?.duration_s ?? Infinity;
    return Number.isFinite(base) ? base + UTURN_PENALTY_S * countRouteUturns(r) : base;
  };
  if (typeof heading !== "number" || !Number.isFinite(heading)) {
    return [...res].sort((a, b) => dur(a) - dur(b));
  }
  const tol = typeof toleranceDeg === "number" ? toleranceDeg : FORWARD_TOLERANCE_DEG;
  const offBy = (br: number) => Math.abs(((br - heading + 540) % 360) - 180); // 0..180
  const scored = res.map((r) => {
    const br = routeInitialBearing(r);
    // An early U-turn disqualifies a route from "forward" however promising its first
    // 25 m look — see EARLY_UTURN_M. Everything else is unchanged.
    return { r, forward: br != null && offBy(br) <= tol && !hasEarlyUturn(r), d: dur(r) };
  });
  const fwd = scored.filter((s) => s.forward).sort((a, b) => a.d - b.d);
  const rest = scored.filter((s) => !s.forward).sort((a, b) => a.d - b.d);
  return [...fwd, ...rest].map((s) => s.r);
}
