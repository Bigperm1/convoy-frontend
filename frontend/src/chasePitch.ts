// chasePitch — the follow camera's TILT. One constant, on every surface.
//
// Split out of ConvoyMapbox.tsx on 2026-09-11 for the same reason as cornerBlend.ts,
// offRouteGate.ts and selfLiftRule.ts: a rule that decides behaviour must live where
// tools/sim-qc can import it. ConvoyMapbox.tsx re-exports it, so CarMapView and every
// other caller are unchanged. Import nothing from 'react-native' in this file.
//
// Jeff, 2026-09-11: "my goal here is to be as close to as the mapbox other maps view and
// smoothness ... seems like everybody is at a fixed pitch and cieling of around 16", then
// "do nto touch the car position, i agree with the pitch change. go".
//
// ── WHY THE SPEED RAMP WENT ─────────────────────────────────────────────────────────────
// It used to be CHASE_PITCH_CITY 48 below 45 km/h, ramping to CHASE_PITCH_HIGHWAY 60 at
// 95 km/h. MEASURED on his drive home (instance ogb3m4-967731, 17:27:50-17:59:12 PDT, 88
// cam-probe rows, CarPlay surface): the tilt travelled 168 DEGREES with 20 direction
// reversals in 31.4 minutes, swinging the full 48-60 band.
// Through 17:33-17:36 alone: 54.5 -> 48.3 -> 48 -> 48.4 -> 52.5 -> 48.3 -> 48 -> 48.1 ->
// 52.2 -> 54.7. The horizon rose and fell with every gap in traffic.
//
// ⚠ THE SLEW LIMITER DID NOT PREVENT THIS AND A BIGGER ONE WOULD NOT EITHER.
// CAM_PITCH_SLEW_PER_S (5 deg/s) and the tau-1400 low-pass were both already in place.
// They smooth the PATH to the target; the TARGET itself was churning, because its input
// was instantaneous speed and in traffic speed never settles. Smoothing a churning target
// only adds lag to the churn. The fix has to remove the input, not filter it harder.
//
// ── PRIOR ART (fetched and citation-checked 2026-09-11) ─────────────────────────────────
// Every navigation camera whose implementation could actually be read uses a FIXED
// following pitch: Mapbox Navigation SDK `FollowingFrameOptions.defaultPitch = 45.0`,
// Google Navigation SDK 45, MapLibre Navigation iOS 45. NOT ONE drives pitch from speed.
// The two that vary it at all move it the OTHER way: MapLibre Android sets tilt from
// distance remaining to the maneuver, clamped [45,60], FALLING as the turn nears, and
// Mapbox drops pitch toward top-down near a maneuver so the turn's shape reads. Ours was
// the only design that RAISED tilt with speed — which is how a freeway ramp ended up at
// maximum zoom AND maximum tilt simultaneously, a combination nothing else can produce.
//
// ── WHY 48 AND NOT MAPBOX'S 45 ──────────────────────────────────────────────────────────
// 48 is the value already shipping today for every speed at or below 45 km/h, so the
// change reads as "the highway stops tilting further" rather than "everything moved", and
// it is within 3 degrees of the entire corpus. It is one OTA dial: move this number alone.
//
// ── WHAT PAYS FOR THE LOST HORIZON AT SPEED ─────────────────────────────────────────────
// Nothing new is needed. CHASE_ZOOM_STOPS in ConvoyMapbox.tsx already zooms OUT with speed
// (14.0 at 95 km/h, 12.8 at 180), which is the same job the pitch ramp was doing a second
// time. That doubling-up is what made the highway view extreme.
//
// ⛔ DO NOT RE-ADD A SPEED TERM. scripts/trap-check.py rule 31 and
// tools/sim-qc/chase_pitch_test.mts both fail if chasePitch starts reading its argument.
// The ZOOM ceiling and the speed-debounce that were discussed alongside this are NOT done
// and were NOT approved — do not smuggle them in here.

/** The one following-camera tilt, in degrees. OTA-tunable; the gate asserts invariance, not this value. */
export const CHASE_PITCH_FIXED = 48;

/**
 * The follow camera's tilt. Takes no input by design.
 *
 * The parameter is retained so the ~two call sites and CarMapView need no edit, and it is
 * deliberately named with a leading underscore and left unread. If you find yourself
 * wanting to read it, read the note above first — that is the defect, not the fix.
 */
export function chasePitch(_kmh?: number): number {
  return CHASE_PITCH_FIXED;
}
