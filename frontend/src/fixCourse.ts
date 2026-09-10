// fixCourse — the ONE rule for "does this fix carry a course?", per platform. Pure; node-gated
// by tools/sim-qc/fix_course_test.mts. src/fixCourseHere.ts binds it to Platform.OS.
//
// ── WHY (Codex 5th pass, 2026-09-09) ────────────────────────────────────────────────────
// The pose estimator (src/poseEstimator.ts) must only ever see the fix's OWN course; the display
// heading is sticky and is not evidence. Six feed sites filtered the course with `h > 0`, which
// silently threw away DUE NORTH — but a blanket `>= 0` would be wrong on Android:
//   iOS      expo-location LocationUtils.swift:30   heading = location.course  (CoreLocation: -1 = no
//            course; 0 = a real due-north course)
//   Android  expo-location LocationResults.kt:125   heading = location.bearing.toDouble(), with NO
//            hasBearing() check — and android.location.Location.getBearing() returns 0.0 when the
//            fix has no bearing. On Android, 0 is indistinguishable from "none".
// So: iOS keeps 0°; Android drops it. Losing an exact-north course on Android costs one vote among
// many; feeding a fake north into the estimator on every bearing-less fix would steer the car.

export type CoursePlatform = "ios" | "android" | "other";

/** The fix's own course in degrees (0 = north), or null when the platform reported none. */
export function rawCourseDeg(h: unknown, platform: CoursePlatform): number | null {
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  if (h < 0) return null;                          // iOS: -1 = no course
  if (platform === "android" && h === 0) return null;   // Android: 0 = no bearing (see header)
  return h;
}
