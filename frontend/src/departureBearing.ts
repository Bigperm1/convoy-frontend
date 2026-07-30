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
// ⚠ MEASURED — DO NOT RE-TRY THE OBVIOUS FIX. The Directions API's own `bearings`
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
import { haversineMeters } from "./nav";

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

// Feed every GPS fix that carries a real course. Cheap, called from the position
// pipeline. Negative / non-finite values are iOS's "no course" and are ignored.
export function noteCourse(headingDeg: number | null | undefined): void {
  if (typeof headingDeg !== "number" || !Number.isFinite(headingDeg)) return;
  if (headingDeg < 0 || headingDeg > 360) return;
  lastCourse = { deg: headingDeg, at: Date.now() };
}

// Best estimate of the direction the car is FACING, or null if we genuinely cannot
// tell. Never throws.
export async function getDepartureBearing(): Promise<number | null> {
  // 1) A fresh travel course beats the compass: it needs no calibration, is immune
  //    to magnetic interference (a car is a large steel box full of magnets) and is
  //    unaffected by how the phone is oriented in its mount.
  const c = lastCourse;
  if (c && Date.now() - c.at <= COURSE_FRESH_MS) return c.deg;

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

// Order routes so the FASTEST one heading roughly the way the car already faces comes
// first; options that start with a U-turn fall to the back (also fastest-first).
// No heading -> plain fastest-first, i.e. the behaviour before any of this existed.
export function orderRoutesForward<T = any>(res: T[], heading?: number): T[] {
  if (!Array.isArray(res) || res.length <= 1) return res;
  const dur = (r: any) => r?.duration_in_traffic_s ?? r?.duration_s ?? Infinity;
  if (typeof heading !== "number" || !Number.isFinite(heading)) {
    return [...res].sort((a, b) => dur(a) - dur(b));
  }
  const offBy = (br: number) => Math.abs(((br - heading + 540) % 360) - 180); // 0..180
  const scored = res.map((r) => {
    const br = routeInitialBearing(r);
    return { r, forward: br != null && offBy(br) <= FORWARD_TOLERANCE_DEG, d: dur(r) };
  });
  const fwd = scored.filter((s) => s.forward).sort((a, b) => a.d - b.d);
  const rest = scored.filter((s) => !s.forward).sort((a, b) => a.d - b.d);
  return [...fwd, ...rest].map((s) => s.r);
}
