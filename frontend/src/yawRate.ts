// yawRate — the ONE owner of the device's turn rate about gravity, for the pose estimator.
//
// ── WHY (2026-09-09) ──────────────────────────────────────────────────────────────────────
// At 10 km/h in a corner the drawn car had exactly one heading input: the GPS course, once a
// second, sticky-held when iOS reports none. The phone has a gyroscope that reports the car's
// yaw rate 20 times a second whether the car is doing 5 km/h or 100, and nothing on the marker
// path ever read it. expo-sensors is in the build-75 binary (the scan viewfinder subscribes to
// DeviceMotion today), so this ships OTA.
//
// ── RULES THIS MODULE KEEPS ───────────────────────────────────────────────────────────────
//  • NEVER `import` expo-sensors at module scope — build 73 binaries have no native module and a
//    static import strands them on every future OTA. Go through loadDeviceMotion(), which probes
//    first (see src/guidedCamera.ts header).
//  • Nav-only. start() is ref-counted by the surfaces; the subscription exists only while a drive
//    is on. A gyro at 20 Hz is cheap, but it is not free and it is not needed in free drive.
//  • No permission prompt. CMMotionManager device motion needs none; requestPermissionsAsync is
//    never called here (src/permissionGate.ts is the only place that raises a sheet).
//  • The SIGN of the rate is not assumed. Mount orientation, platform convention and axis order
//    all vary; the estimator learns the sign from the GPS course (src/poseEstimator.ts yawSign)
//    and treats the gyro as absent until it has. This module only projects the rate onto gravity
//    so the phone's orientation in the cradle does not matter.
//  • Receipts: `yaw-rate` on the first sample of a drive and on stop, with counts. Bounded.
import { Platform } from "react-native";
import { loadDeviceMotion } from "./guidedCamera";
import { logEventReliable } from "./crashBreadcrumb";
import { yawAboutGravity, type MotionPlatform } from "./yawMath";

const PLATFORM: MotionPlatform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";

const UPDATE_MS = 50;              // 20 Hz — a 90° corner at city speed is 20–40°/s; 20 Hz sees it
const STALE_MS = 500;              // no sample for this long ⇒ "no gyro" (the estimator falls back to GPS)

let _refs = 0;
let _sub: { remove?: () => void } | null = null;
let _starting = false;
let _available: boolean | null = null;
let _yawDps: number | null = null;
let _at = 0;
let _samples = 0;
let _cumDeg = 0;                   // CUMULATIVE integrated yaw (sign-agnostic); each estimator keeps its own cursor
let _firstLogged = false;

function fold(m: any): void {
  // ⚠ Axis order is PER PLATFORM (iOS emits alpha=z, beta=y, gamma=x — see src/yawMath.ts). The
  // projection lives in that pure module so tools/sim-qc/yaw_math_test.mts can hold the mapping.
  const yaw = yawAboutGravity(m?.rotationRate, m?.accelerationIncludingGravity ?? m?.gravity, PLATFORM);
  if (yaw == null) return;
  const n = Math.hypot(Number(m?.accelerationIncludingGravity?.x ?? m?.gravity?.x ?? 0), Number(m?.accelerationIncludingGravity?.y ?? m?.gravity?.y ?? 0), Number(m?.accelerationIncludingGravity?.z ?? m?.gravity?.z ?? 0));
  const now = Date.now();
  if (_at > 0) {
    const dt = Math.min(0.25, (now - _at) / 1000);
    _cumDeg += yaw * dt;
  }
  _yawDps = yaw; _at = now; _samples += 1;
  if (!_firstLogged) {
    _firstLogged = true;
    try { logEventReliable(`yaw-rate first dps=${yaw.toFixed(1)} g=${n.toFixed(1)} os=${PLATFORM} interval=${UPDATE_MS}`); } catch {}
  }
}

/** Begin listening (ref-counted). Safe to call from both surfaces; idempotent. */
export function startYawRate(): void {
  _refs += 1;
  if (_sub || _starting) return;
  const DeviceMotion = loadDeviceMotion();
  if (!DeviceMotion) { _available = false; return; }
  _starting = true;
  (async () => {
    try {
      if (!(await DeviceMotion.isAvailableAsync())) { _available = false; return; }
      _available = true;
      if (_refs <= 0) return;                                // stopped before we got here
      try { DeviceMotion.setUpdateInterval(UPDATE_MS); } catch {}
      _sub = DeviceMotion.addListener(fold);
    } catch {
      _available = false;
    } finally {
      _starting = false;
    }
  })();
}

/** Release one reference; the subscription ends with the last one. */
export function stopYawRate(): void {
  _refs = Math.max(0, _refs - 1);
  if (_refs > 0) return;
  try { _sub?.remove?.(); } catch {}
  if (_sub) {
    try { logEventReliable(`yaw-rate stop samples=${_samples}`); } catch {}
  }
  _sub = null; _yawDps = null; _at = 0; _samples = 0; _cumDeg = 0; _firstLogged = false;
}

/** The latest yaw rate in deg/s (sign convention unknown to the caller), or null if none/stale. */
export function getYawRateDps(): number | null {
  if (_yawDps == null || Date.now() - _at > STALE_MS) return null;
  return _yawDps;
}

/**
 * The CUMULATIVE integrated yaw in degrees (sign-agnostic), or null with no sensor. Never reset by
 * a reader: the phone and the car surface each run their own estimator, and a destructive
 * "since last call" here made the second reader see a fragment (Codex 4th pass). Each estimator
 * keeps its own cursor (poseEstimator `yawCumAtCourse`) and differences this itself.
 *
 * INVARIANT (Codex 5th pass): stopYawRate() zeroes the integral when the LAST consumer leaves, so
 * a PoseState that outlived that stop would difference against a cursor from the old integral.
 * Today none does — both surfaces `poseStart()` the moment their drive ends (CarMapView "a drive
 * ended: the next one starts clean"; ConvoyMapbox likewise) and only stop the sensor on that same
 * edge. Any new consumer must reset its PoseState when it stops the sensor.
 */
export function getYawIntegralDeg(): number | null {
  return _at === 0 ? null : _cumDeg;
}

export function yawRateStats(): { available: boolean | null; samples: number; ageMs: number | null; refs: number } {
  return { available: _available, samples: _samples, ageMs: _at ? Date.now() - _at : null, refs: _refs };
}
