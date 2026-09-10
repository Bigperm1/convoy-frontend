// fixCourseHere — src/fixCourse.ts bound to the running platform. The pure rule lives apart so
// tools/sim-qc/fix_course_test.mts can hold it without react-native.
import { Platform } from "react-native";
import { rawCourseDeg, type CoursePlatform } from "./fixCourse";

const PLATFORM: CoursePlatform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";

/** The fix's own course (deg), or null when this platform reported none. Feed ONLY this to the pose estimator. */
export function rawCourseHere(h: unknown): number | null {
  return rawCourseDeg(h, PLATFORM);
}
