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
// ── REVISED 2026-09-04 (Olaf, CarPlay, 90 km/h, AI route: "the route ribbon
// visibly covered the self car"). Telemetry at the moment of the kiss: `ribbon-trim
// surf=car z=15.76 lead=55 fade=46` alongside `cam-probe surf=car z=15.7 p=55-59
// spd=80-91` — a highway CHASE PITCH near the 60° cap. The ground-plane RATIO
// argument above still holds for a 3D object's FOOTPRINT, but metersPerDp is a
// zoom-only conversion (Mapbox's orthographic tile→metre scale) with NO
// perspective term — it does not know the camera is pitched, so it cannot itself
// be the thing that keeps a SCREEN gap constant as pitch changes. HYPOTHESIS, not
// yet field-verified: the on-screen projection of a fixed ground-metre gap along
// the road shrinks with pitch, so the same 60 ground-dp lead reads as materially
// fewer on-screen points at p=57° than at p=0° — thin enough to sit under the
// ~45pt CarPlay car plus its ~20dp casing glow. The phone's own 20 m floor hid
// this at its z18.5 cruise pitch (still ~136dp of screen clearance even
// compressed), which is why only CarPlay hit it. `pitchDeg` below is OPTIONAL and
// defaults to 0, so every caller that does not pass it gets the exact old number —
// this is an ADDITIVE compensation on top of the 2026-07-29 reasoning, not a
// reversal of it. Settling check: a drive video at a similar pitch after this
// ships, read alongside the receipt's new `pitch=`/`leadDp=` fields.
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
// ── 76.6 → 48 (Jeff, 2026-08-18: "do you think we are good enough now to get the
// route line closer to the car?") — YES, and here is why it is safe NOW when it
// wasn't before: the big buffer existed to absorb the trim/marker SAWTOOTH — the
// line was anchored to the newest GPS fix while the car eased toward it, so the gap
// jittered by a whole fix step (~15dp at 60 km/h) and a short lead let the line
// swallow the car. Since the ease-riding fix the line start runs the SAME
// interpolation on the SAME clock as the marker: the gap is constant in screen
// space by construction. Residual error is one render frame (~0.4 m at 100 km/h ≈
// 1dp). Measurement for 48: the car marker is ~62pt tall, center→nose ≈ 31dp, so
// the line now starts ~17dp ahead of the nose — visibly clear of the car at any
// speed, no longer a third of a screen away. OTA-tunable; if a drive photo shows a
// kiss, raise toward 56 before rethinking.
// ── 48 → 60 (2026-09-03, Jeff: "the route line was overlapping the car marker" — CarPlay video) ──
// The cut is now anchored to the DRAWN car on the ribbon's own metres (routeRibbon.alongMOnPartition),
// which removed a ~1%-of-distance drift and the separate ease clock. What remains at 48 is optics: the
// fade starts 26 dp ahead of the nose and the casing GLOW is blurred ~20 dp behind its own start, so the
// halo visibly touched the nose on the sim at 54 km/h (measured: faint green 3 pt ahead of the nose,
// solid 13 pt). 60 puts the cut 38 dp ahead of the nose and the halo clear of it at every zoom.
// ── 60 → 40 (2026-09-05, Jeff: "the route line/ribbon is way too far away from the car") ──
// The 09-04 pitch compensation doubles the ground lead at the car surface's pitch 60, so the 60 dp
// base became 120 dp on the ground — on the sim that was 48-51 pt of solid line ahead of the nose at
// 108 km/h, more than a car length, and Jeff drove behind it for four hours. (The bulk of what he saw
// was the anchor drift fixed in routeRibbon.anchorCutM the same night; this is the optics on top.)
// 40 → ~30 pt solid at 108 km/h and ~20 pt at 54 km/h on the sim, still clear of the halo (≥18).
export const TRIM_LEAD_DP = 40;

// Sanity rails on the METRE result. These exist only to stop a pathological camera
// (a mid-pinch zoom spike, a bogus latitude) producing an absurd trim; in normal
// driving the screen calculation sits well inside them and they never bind.
//   z17 city → 30 m · z15 → 120 m · z14 highway → 252 m · z12.8 at 180 km/h → 500 m (capped)
// 20 → 12 (2026-09-05): at z18.5 the 20 m floor was ~74 dp of ground — a line starting a car length
// and a half ahead of a creeping car (Jeff's phone rows at z18.50: lead=20 on every sample).
const TRIM_MIN_M = 12;
const TRIM_MAX_M = 500;

// Pitch compensation shared by lead and fade (2026-09-04, see the REVISED note above):
// lead_dp = BASE_DP / max(0.45, cos(pitchRad)). At pitch 0 this is exactly BASE_DP —
// every existing caller that omits pitchDeg sees NO behaviour change. The 0.45 floor
// is a sanity rail, same spirit as TRIM_MIN_M/MAX_M: cos(60°) = 0.5 and Mapbox Standard
// hard-caps camera pitch at 60°, so in normal driving the floor never binds — it only
// stops a pathological >63° reading from blowing the lead up unboundedly.
function pitchCompensatedDp(baseDp: number, pitchDeg: number): number {
  const p = Number.isFinite(pitchDeg) ? pitchDeg : 0;
  const pRad = (p * Math.PI) / 180;
  return baseDp / Math.max(0.45, Math.cos(pRad));
}

// The lead in SCREEN POINTS after pitch compensation — exported so a caller can log the
// exact value routeTrimLeadM used (see the `leadDp=` field in the ribbon-trim receipt).
export function routeTrimLeadDp(pitchDeg = 0): number {
  return pitchCompensatedDp(TRIM_LEAD_DP, pitchDeg);
}

// ── THE SELF MARKER IS DRAWN 10 m IN THE AIR, AND THAT MOVES IT UP THE ROAD ─────────────
// (2026-09-09. Jeff's 2026-09-07 exit-90 photograph: the ribbon ran UNDER the car — again,
// after OTA-W's pitch compensation and OTA-Z's cut anchor had each "fixed" it.)
//
// src/ConvoyMapbox.tsx gives the self model `modelTranslation: [0, 0, 10]` (16 for the flat
// arrow) so the 3D buildings' shared depth buffer cannot eat it; the vendored SDK documents
// that field as "[longitudal, latitudal, altitude] offsets" IN METRES. On a pitched camera a
// raised object projects toward the horizon — i.e. FORWARD along the road — and the lift is a
// fixed number of GROUND metres, so its screen cost DOUBLES with every zoom level. The ribbon
// is a LineLayer with no lift and stays on the ground. The trim placed the cut a fixed screen
// distance ahead of the car's GROUND point, which is not where the car is DRAWN.
//
// MEASURED, not derived: two simulator frames at an IDENTICAL pinned camera (zoom 16.5,
// pitch 57, 402x874 pt), lift 10 m vs lift 0, with ground-anchored control markers unchanged
// to the pixel — the drawn car moved 17.2 pt up-screen (this model predicts 15.3). Carried to
// Jeff's 470x265 head unit that is 3.4 pt on the highway and 62.5 pt on the exit ramp, against
// a cut sitting ~35 pt ahead on screen at BOTH zooms by design. Highway: 20 pt of clear road.
// Ramp: the car's body lands 51-75 pt up-screen, past a cut at 36 — the line comes out from
// under it. That is exactly the two photographs, and it is why raising or lowering
// TRIM_LEAD_DP never fixed it: the lead was already correct.
//
// THE FIX: measure the lead from where the car is DRAWN. `leadShiftedByLift` moves the cut
// UP-SCREEN by exactly the lift's shift and converts back — solved exactly, not approximated:
// with h and s in map px and d = 1.5 * viewportHeight,
//     ground_screen(s) = d*s*cos p / (d + s*sin p)   and   lift_screen(h) = d*h*sin p / (d - h*cos p)
// are equal when   s = h*d*sin p / (d*cos p - h).
// Gate: tools/sim-qc/self_lift_lead_test.mts.
export const SELF_MODEL_LIFT_M = 10;   // the 3D car / scan twin (ConvoyMapbox modelTranslation)
export const SELF_ARROW_LIFT_M = 16;   // the flat arrow is lifted higher to clear the ribbon
// The crew's 3D twins share the car's lift. No route cut is measured from a PEER, so the trim
// defect above does not apply to them — but the same parallax does: at an exit-ramp zoom a peer
// is drawn ~55 pt further up the road than they actually are. Cosmetic today, and it moves with
// the self car by definition rather than drifting apart. Not yet raised with Jeff.
export const PEER_MODEL_LIFT_M = SELF_MODEL_LIFT_M;

// Mapbox's camera: fov 36.87 deg => cameraToCenterDistance = 0.5*H/tan(fov/2) = 1.5*H.
const camDist = (viewportHDp: number) => 1.5 * viewportHDp;

/** Screen points ABOVE the camera target for a GROUND point `sM` metres ahead of it. */
export function groundScreenPt(sM: number, zoom: number, lat: number, pitchDeg: number, viewportHDp: number): number {
  const d = camDist(viewportHDp), x = sM / metersPerDp(zoom, lat), p = (pitchDeg * Math.PI) / 180;
  return (d * x * Math.cos(p)) / (d + x * Math.sin(p));
}
/** Screen points ABOVE the camera target for a point at ALTITUDE `hM` metres over it — i.e. how
 *  far up the road the lifted self marker is actually DRAWN. This is the whole defect. */
export function selfLiftScreenPt(hM: number, zoom: number, lat: number, pitchDeg: number, viewportHDp: number): number {
  if (!(hM > 0) || !(viewportHDp > 0)) return 0;
  const p = (pitchDeg * Math.PI) / 180;
  if (!(p > 0)) return 0;                       // a flat camera hides the lift entirely
  const mpd = metersPerDp(zoom, lat);
  if (!(mpd > 0)) return 0;
  const d = camDist(viewportHDp), y = hM / mpd;
  const den = d - y * Math.cos(p);
  if (!(den > 0)) return 0;
  const v = (d * y * Math.sin(p)) / den;
  return Number.isFinite(v) ? v : 0;
}
/** Inverse of groundScreenPt: the ground metres whose projection lands at `Ypt`. */
function groundMetresAtScreenPt(Ypt: number, zoom: number, lat: number, pitchDeg: number, viewportHDp: number): number {
  const d = camDist(viewportHDp), p = (pitchDeg * Math.PI) / 180;
  const den = d * Math.cos(p) - Ypt * Math.sin(p);
  if (!(den > 0)) return TRIM_MAX_M;            // at or past the horizon — rail it, never NaN
  return ((Ypt * d) / den) * metersPerDp(zoom, lat);
}

/**
 * THE FIX (2026-09-09): move the cut UP-SCREEN by exactly the number of points the lift moved
 * the CAR, then convert back to ground metres. Adding the lift's ground-equivalent instead is
 * NOT enough — high on a pitched screen the perspective is so compressed that the remaining
 * design lead buys almost no visible road, and the gate caught that on the ARROW skin (lifted
 * 16 m, so drawn 94 pt up-screen at z18.26: the additive version left 3.7 pt of clearance).
 * Working in screen space restores the SAME gap for every lift, zoom and pitch by construction.
 * With no lift, no viewport height or a flat camera this returns `leadM` UNCHANGED, so every
 * pre-existing caller and the whole pitch-0 path keep their exact numbers.
 */
// ── THE CORRECTION IS BOUNDED, AND THAT BOUND IS NOT A ROUND NUMBER ─────────────────────────
// (Codex adversarial review, 2026-09-09, and it was right.) The inverse projection blows up as
// the target approaches the horizon, which sits d/tan(pitch) above the camera target — only
// 229 screen pt on a 265 pt head unit at pitch 60. MEASURED across the supported envelope
// (pitch 60, CHASE_ZOOM_CLAMP_MAX = 20, viewports 201 / 265 / 874 dp, lifts 10 and 16 m), the
// correction the marker actually needs is:
//     phone   874 dp : 19-36 m (car), 31-85 m (arrow)   — tame at every reachable zoom
//     head unit 265 dp: 24-42 m (car), 39-117 m (arrow) up to z18.5, then 490 m at z19 and
//                       UNREACHABLE (past the horizon) at z19.5
//     short 201 dp    : unreachable from z19 (car) and z18.5+ (arrow)
// Past that point the marker is being DRAWN at the vanishing point and no cut can clear it —
// the lift itself is the broken thing there, not the trim. Letting the inverse run to the
// TRIM_MAX_M rail would hand buildRibbonFeatures a 500 m cut, and it drops every feature once
// `totalM - cut < 1`: the whole route line would VANISH rather than merely overlap the car.
// So the correction is capped at 120 m. WHAT THAT COVERS, stated exactly (and asserted in the
// gate, not just claimed here): the CAR at every viewport up to maneuver zoom 18.5, and the
// ARROW at every viewport up to z18. It does NOT cover the arrow skin on the short Android Auto
// canvas above z18 (480 m needed at z18.5) — there the marker is drawn 124 pt up a 201 pt layout,
// 71% of the way to the horizon, and the LIFT is the broken thing at that camera, not the trim.
// That case degrades to a PARTIAL correction, and `clampCutToRoute` below guarantees the line
// still reaches the screen. Fixing it properly means a zoom-aware lift, which cannot be done in
// a layer style without the per-tick main-thread write the 0x8BADF00D rule forbids. Open item.
export const LIFT_LEAD_MAX_M = 120;

export function leadShiftedByLift(
  leadM: number, liftM: number, zoom: number, lat: number, pitchDeg: number, viewportHDp: number,
): number {
  const shift = selfLiftScreenPt(liftM, zoom, lat, pitchDeg, viewportHDp);
  if (!(shift > 0)) return leadM;
  const target = groundScreenPt(leadM, zoom, lat, pitchDeg, viewportHDp) + shift;
  const m = groundMetresAtScreenPt(target, zoom, lat, pitchDeg, viewportHDp);
  if (!Number.isFinite(m) || m <= leadM) return leadM;
  return Math.min(leadM + LIFT_LEAD_MAX_M, Math.min(TRIM_MAX_M, m));
}

// Metres ahead of the car's projected point at which the route line should start.
// Pass the camera zoom the surface is actually using (including any pinch bias) and
// the car's latitude. `pitchDeg` (optional, default 0) is the camera's ACTUAL pitch —
// see routeTrimLeadDp / the REVISED note above.
export function routeTrimLeadM(
  zoom: number, lat: number, pitchDeg = 0, selfLiftM = 0, viewportHDp = 0,
): number {
  const m = routeTrimLeadDp(pitchDeg) * metersPerDp(zoom, lat);
  if (!Number.isFinite(m)) return 30;
  const railed = Math.max(TRIM_MIN_M, Math.min(TRIM_MAX_M, m));
  // The rails stay on the DESIGN lead; the lift correction is a rendering fact, not a tuning
  // choice, so it is applied after the floor rather than being squeezed by it. With no lift or
  // no viewport height this is exactly `railed` — the pre-2026-09-09 number, byte for byte.
  return Math.min(TRIM_MAX_M, leadShiftedByLift(railed, selfLiftM, zoom, lat, pitchDeg, viewportHDp));
}

// The soft transparent→solid fade just past the trim, also in screen points so it
// stays a consistent slice of the visible line rather than a fixed metre count that
// vanishes when zoomed out.
const TRIM_FADE_DP = 34;   // scaled with the lead (60→40) on 2026-09-05

// Same pitch compensation as the lead, and for the identical reason: this is the same
// metersPerDp zoom-only conversion applied to a different screen-dp constant, so it is
// wrong on a pitched camera in exactly the same way. `pitchDeg` optional, default 0 —
// unchanged for callers that don't pass it.
export function routeTrimFadeM(zoom: number, lat: number, pitchDeg = 0): number {
  const m = pitchCompensatedDp(TRIM_FADE_DP, pitchDeg) * metersPerDp(zoom, lat);
  if (!Number.isFinite(m)) return 20;
  return Math.max(10, Math.min(340, m));
}

// ── THE TRIM MUST NEVER TRIM THE WHOLE LINE AWAY ────────────────────────────────────────────
// (Codex adversarial review, 2026-09-09.) `buildRibbonFeatures` drops EVERY feature once
// `totalM - cut < 1` — correct at the destination, catastrophic if a large cut ever outruns the
// route while the driver still has turns ahead. The lift correction is capped, but a capped cut
// is still ~130 m, so on a short remaining route it could have swallowed the line. Clamp the cut
// to leave a tail, FLOORED at the car's own anchor so arrival still clears the ribbon exactly as
// before (there the base already sits at the end and this returns it untouched).
export const RIBBON_MIN_TAIL_M = 40;

export function clampCutToRoute(cutM: number, cutBaseM: number, totalM: number): number {
  if (!Number.isFinite(cutM) || !Number.isFinite(totalM) || !(totalM > 0)) return cutM;
  const base = Number.isFinite(cutBaseM) ? cutBaseM : 0;
  return Math.min(cutM, Math.max(base, totalM - RIBBON_MIN_TAIL_M));
}
