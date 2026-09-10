// yaw_math_test — the turn rate about gravity must be the YAW, on both platforms, in any mount.
//
// Codex adversarial review 2026-09-09: expo-sensors iOS emits rotationRate as (alpha=z, beta=y,
// gamma=x) while Android emits (x, y, z). The first yawRate.ts projected (alpha,beta,gamma) as
// (x,y,z) on both — on an iPhone lying flat in a cradle it would have fed the ROLL rate into the
// pose estimator's heading and read a real corner as zero. This gate holds the per-platform mapping.
import { yawAboutGravity, omegaXYZ } from "../../src/yawMath.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const near = (a: number | null, b: number, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

// A physical rotation of 20 deg/s about the device's own Z axis, nothing else.
const PHYS = { wx: 0, wy: 0, wz: 20 };
// How each platform SERIALISES that same physical rotation (from the native sources):
const IOS = { alpha: PHYS.wz, beta: PHYS.wy, gamma: PHYS.wx };       // Swift: alpha=z, beta=y, gamma=x
const ANDROID = { alpha: PHYS.wx, beta: PHYS.wy, gamma: PHYS.wz };   // Kotlin: alpha=x, beta=y, gamma=z
const FLAT = { x: 0, y: 0, z: 9.8 };                                  // phone flat: gravity along z

ok("A1 iOS flat: yaw about gravity is the z rate", near(yawAboutGravity(IOS, FLAT, "ios"), 20), `${yawAboutGravity(IOS, FLAT, "ios")}`);
ok("A2 Android flat: yaw about gravity is the z rate", near(yawAboutGravity(ANDROID, FLAT, "android"), 20));
ok("A3 both platforms agree on the same physical rotation", near(yawAboutGravity(IOS, FLAT, "ios"), yawAboutGravity(ANDROID, FLAT, "android")!));
// NEGATIVE CONTROL — the bug: treat the iOS payload as if it were (x,y,z)
ok("A4 the old mapping would have read an iOS flat-phone yaw as ZERO", near(yawAboutGravity(IOS, FLAT, "android"), 0), `${yawAboutGravity(IOS, FLAT, "android")}`);

// Portrait in a cradle: gravity along -y; a yaw is then a rotation about the device's y axis.
const PORTRAIT = { x: 0, y: -9.8, z: 0 };
const IOS_Y = { alpha: 0, beta: 15, gamma: 0 }, AND_Y = { alpha: 0, beta: 15, gamma: 0 };
ok("B1 portrait cradle, iOS: reads the y rate (with gravity's sign)", near(yawAboutGravity(IOS_Y, PORTRAIT, "ios"), -15));
ok("B2 portrait cradle, Android: same", near(yawAboutGravity(AND_Y, PORTRAIT, "android"), -15));
// Landscape: gravity along x; the yaw is the x-axis rate — on iOS that arrives in GAMMA.
const LANDSCAPE = { x: 9.8, y: 0, z: 0 };
ok("C1 landscape, iOS: the x rate arrives in gamma", near(yawAboutGravity({ alpha: 0, beta: 0, gamma: 12 }, LANDSCAPE, "ios"), 12));
ok("C2 landscape, Android: the x rate arrives in alpha", near(yawAboutGravity({ alpha: 12, beta: 0, gamma: 0 }, LANDSCAPE, "android"), 12));
// A roll on a flat phone (rotation about x) must NOT read as yaw on either platform.
ok("D1 iOS flat, pure roll → 0 yaw", near(yawAboutGravity({ alpha: 0, beta: 0, gamma: 30 }, FLAT, "ios"), 0));
ok("D2 Android flat, pure roll → 0 yaw", near(yawAboutGravity({ alpha: 30, beta: 0, gamma: 0 }, FLAT, "android"), 0));
// A tilted mount: gravity split between y and z; only the component along gravity counts.
const TILT = { x: 0, y: -6.93, z: 6.93 };   // 45° back
const r45 = yawAboutGravity({ alpha: 10, beta: -10, gamma: 0 }, TILT, "ios");   // ωz=10, ωy=-10
ok("E1 45° tilt: yaw = (ωy·gy + ωz·gz)/|g|", near(r45, (-10 * -6.93 + 10 * 6.93) / 9.8, 1e-3), `${r45}`);
// Bad samples
ok("F1 no gravity → null", yawAboutGravity(IOS, { x: 0, y: 0, z: 0 }, "ios") === null);
ok("F2 NaN rate → null", yawAboutGravity({ alpha: NaN, beta: 0, gamma: 0 }, FLAT, "ios") === null);
ok("F3 omegaXYZ iOS permutes, Android does not", JSON.stringify(omegaXYZ({ alpha: 1, beta: 2, gamma: 3 }, "ios")) === "[3,2,1]" && JSON.stringify(omegaXYZ({ alpha: 1, beta: 2, gamma: 3 }, "android")) === "[1,2,3]");

console.log(fails === 0 ? "\nPASS yaw_math" : `\nFAIL yaw_math (${fails})`);
if (fails) process.exit(1);
