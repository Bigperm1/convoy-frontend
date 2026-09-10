// yawMath — the car's turn rate about gravity from a DeviceMotion sample. Pure; node-gated by
// `tools/sim-qc/yaw_math_test.mts`. src/yawRate.ts is the only caller.
//
// ── THE AXIS TRAP (Codex adversarial review, 2026-09-09) ─────────────────────────────────
// expo-sensors' TypeScript comments say rotationRate.alpha is "rotation in X axis". The native
// code does not agree with itself across platforms:
//   iOS      DeviceMotionModule.swift:107-110   alpha = rotationRate.z, beta = y, gamma = x
//   Android  DeviceMotionModule.kt:239-241      alpha = values[0] = x, beta = y, gamma = z
// while accelerationIncludingGravity is x, y, z on both. Projecting (alpha, beta, gamma) onto
// (gx, gy, gz) as if it were (ωx, ωy, ωz) is right on Android and WRONG on iOS: with the phone flat
// in a cradle (gravity along z) it returns the ROLL rate, and a real yaw reads as zero. A learned
// sign cannot repair a permuted axis. So the order is normalised per platform before the dot product.
//
// Yaw about the gravity axis = ω · ĝ. The sign convention still varies (Android publishes gravity
// as raw − 2·gravity, i.e. flipped), which src/poseEstimator.ts learns from the GPS course.

export type RotationRate = { alpha: number; beta: number; gamma: number };
export type Vec3 = { x: number; y: number; z: number };
export type MotionPlatform = "ios" | "android" | "other";

/** rotationRate as a device-frame angular velocity (ωx, ωy, ωz) in deg/s, per platform. */
export function omegaXYZ(r: RotationRate, platform: MotionPlatform): [number, number, number] {
  return platform === "ios" ? [r.gamma, r.beta, r.alpha] : [r.alpha, r.beta, r.gamma];
}

/**
 * Turn rate about gravity in deg/s, or null when the sample cannot say (no gravity vector,
 * non-finite components). Sign convention is platform/mount dependent — the caller learns it.
 */
export function yawAboutGravity(r: RotationRate | null | undefined, g: Vec3 | null | undefined, platform: MotionPlatform): number | null {
  if (!r || !g) return null;
  const gx = Number(g.x), gy = Number(g.y), gz = Number(g.z);
  if (![gx, gy, gz].every(Number.isFinite)) return null;
  const n = Math.hypot(gx, gy, gz);
  if (!(n > 0.5)) return null;                       // free fall / a bad sample: no "down"
  const [wx, wy, wz] = omegaXYZ(r, platform);
  if (![wx, wy, wz].every(Number.isFinite)) return null;
  return (wx * gx + wy * gy + wz * gz) / n;
}
