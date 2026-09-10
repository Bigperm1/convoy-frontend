// fix_course_test — a fix's own course, per platform: iOS keeps 0° (due north), Android drops it
// (Location.getBearing() is 0.0 when there is no bearing; expo-location passes it through unchecked).
// Codex 5th pass 2026-09-09: six feed sites filtered `h > 0` and threw away due north on iOS.
import { rawCourseDeg } from "../../src/fixCourse.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
ok("A1 iOS 0° is a real course (due north)", rawCourseDeg(0, "ios") === 0);
ok("A2 iOS -1 = no course", rawCourseDeg(-1, "ios") === null);
ok("A3 iOS 90 passes", rawCourseDeg(90, "ios") === 90);
ok("A4 iOS 359.9 passes", rawCourseDeg(359.9, "ios") === 359.9);
ok("B1 Android 0 = no bearing", rawCourseDeg(0, "android") === null);
ok("B2 Android 90 passes", rawCourseDeg(90, "android") === 90);
ok("B3 Android -1 = none", rawCourseDeg(-1, "android") === null);
ok("C1 NaN → null", rawCourseDeg(NaN, "ios") === null);
ok("C2 undefined → null", rawCourseDeg(undefined, "ios") === null);
ok("C3 null → null", rawCourseDeg(null, "android") === null);
ok("C4 a string → null", rawCourseDeg("90", "ios") === null);
ok("C5 Infinity → null", rawCourseDeg(Infinity, "ios") === null);
ok("D1 other platform: iOS rule (0 kept)", rawCourseDeg(0, "other") === 0);
console.log(fails === 0 ? "\nPASS fix_course" : `\nFAIL fix_course (${fails})`);
if (fails) process.exit(1);
