// routeTrim.ts — ONE definition of "how far ahead of the car does the route line
// start", shared by the phone (ConvoyMapbox), CarPlay and Android Auto (CarMapView).
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Jeff, 2026-07-29: "We need to deep dive into the route line touching the car
// distance. It should be consistent for all speeds on CarPlay, Android Auto and
// phone. Right now it's all over the place — one day it'll be 30 m away from the
// car, the next drive it'll be touching the car, the next drive overlapping."
//
// Two independent causes, and both are structural rather than a bad constant.
//
// 1. THE TWO SURFACES DISAGREED. The phone used
//        clamp(12 + speed * 1.6, 30, 100)
//    while CarMapView — which draws BOTH CarPlay and Android Auto — used
//        clamp(10 + speed * 1.1, 10, 55)
//    At a standstill that is 30 m on the phone and 10 m in the car. The phone's
//    floor had been raised 12 → 30 m specifically because a short lead let the line
//    touch the marker at city zoom; CarPlay never got that fix and kept the 10 m
//    floor that the phone had already proven was too small.
//
// 2. A LEAD IN METRES CANNOT TRACK A MARKER MEASURED IN PIXELS. The self-car's
//    modelScale curve (CAR_MODEL_SCALE_BY_ZOOM) is geometric at ~2x per zoom level:
//    13 at z17, 29 at z16, 60 at z15, 120 at z14. That is deliberate — it cancels
//    the doubling of metres-per-pixel so the car reads the same SIZE on screen at
//    every zoom. The consequence is that the marker's footprint in GROUND METRES
//    doubles with every zoom level out: ~20 m at z17 becomes ~185 m at z14.
//    The chase camera zooms out with speed, so as the driver speeds up the marker
//    silently eats more and more road — while the old lead only grew from 30 m to
//    ~65 m. At city speed the gap looked right, at highway speed the line reached
//    the car, and at 120+ it started underneath it. That is exactly the three
//    behaviours in the report, and it is why they seemed to change "per drive":
//    they change per SPEED, via zoom.
//
// ── THE FIX ──────────────────────────────────────────────────────────────────
// Measure the lead where the driver actually judges it: on screen. Convert a fixed
// screen distance to metres at the live camera zoom, so the lead doubles exactly
// when the marker's ground footprint doubles. The gap then looks identical at every
// zoom, on every surface, at every speed — by construction rather than by tuning.
//
// NO PITCH TERM, on purpose. Raising the pitch foreshortens the ground plane, but
// the marker sits on that same plane and is foreshortened by the identical amount,
// so the RATIO the driver sees (gap vs car length) is unchanged. Adding a
// 1/cos(pitch) factor would have doubled the gap at highway pitch for no visual
// gain.
//
// NO SPEED TERM either. The old one existed to cover the drawn car interpolating
// ahead of the raw GPS fix the projection is computed from — worst case ~30 m at
// 100 km/h. But at the zoom the camera actually uses at 100 km/h the lead is
// already ~250 m, so that overshoot is under 12% of the gap and invisible. Speed
// now reaches the lead only through zoom, which is the thing that governs how big
// the marker is.

// Metres per screen point at a Mapbox zoom level and latitude.
// Mapbox GL zoom is defined on 512px tiles, so the world is 512 * 2^zoom points
// wide: 40075016.686 * cos(lat) / (512 * 2^zoom) = 78271.5169 * cos(lat) / 2^zoom.
export function metersPerDp(zoom: number, lat: number): number {
  const z = Number.isFinite(zoom) ? zoom : 17;
  const la = Number.isFinite(lat) ? lat : 0;
  return (78271.516964 * Math.cos((la * Math.PI) / 180)) / Math.pow(2, z);
}

// The gap, in screen points, from the car's projected position to where the line
// starts. Calibrated to preserve the phone's known-good standstill behaviour: at
// z17 and latitude 49, metersPerDp is 0.392, so 76.6dp reproduces the 30 m lead
// that was verified not to touch the marker. THE tuning knob — raise for more
// clear road in front of the nose, lower to tuck the line closer.
export const TRIM_LEAD_DP = 76.6;

// Sanity rails on the METRE result. These exist only to stop a pathological camera
// (a mid-pinch zoom spike, a bogus latitude) producing an absurd trim; in normal
// driving the screen calculation sits well inside them and they never bind.
//   z17 city → 30 m · z15 → 120 m · z14 highway → 252 m · z12.8 at 180 km/h → 500 m (capped)
const TRIM_MIN_M = 20;
const TRIM_MAX_M = 500;

// Metres ahead of the car's projected point at which the route line should start.
// Pass the camera zoom the surface is actually using (including any pinch bias) and
// the car's latitude.
export function routeTrimLeadM(zoom: number, lat: number): number {
  const m = TRIM_LEAD_DP * metersPerDp(zoom, lat);
  if (!Number.isFinite(m)) return 30;
  return Math.max(TRIM_MIN_M, Math.min(TRIM_MAX_M, m));
}

// The soft transparent→solid fade just past the trim, also in screen points so it
// stays a consistent slice of the visible line rather than a fixed metre count that
// vanishes when zoomed out.
const TRIM_FADE_DP = 51;

export function routeTrimFadeM(zoom: number, lat: number): number {
  const m = TRIM_FADE_DP * metersPerDp(zoom, lat);
  if (!Number.isFinite(m)) return 20;
  return Math.max(10, Math.min(340, m));
}
