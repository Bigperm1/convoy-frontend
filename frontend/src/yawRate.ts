// yawRate — the ONE owner of the device's turn about the vertical, for the pose estimator.
//
// ── WHY (2026-09-09) ──────────────────────────────────────────────────────────────────────
// At 10 km/h in a corner the drawn car had exactly one heading input: the GPS course, once a
// second, sticky-held when iOS reports none. The phone has a gyroscope that reports the car's
// yaw 20 times a second whether the car is doing 5 km/h or 100, and nothing on the marker path
// ever read it. expo-sensors is in the build-75 binary (the scan viewfinder subscribes to
// DeviceMotion today), so this ships OTA.
//
// ── WHY THE ATTITUDE, NOT A RATE SAMPLE (2026-09-10, Jeff: "the car was pointing left and right
// the whole time … overshot the corners") ─────────────────────────────────────────────────
// The first version fed the estimator ONE instantaneous rotationRate sample per render frame
// (≈12 Hz) and integrated it as rate×dt. In a moving car that sample is dominated by mount
// vibration: on the straight highway the samples at the fixes were ±33°/s (sd 21°/s) when the
// car was turning ~1°/s, so the heading random-walked between fixes and the nose wagged; in the
// city corners it ran 31° off the course for four seconds. CoreMotion's fused `attitude.yaw`
// (expo `rotation.alpha`) integrates the gyro at the sensor rate and is bounded — vibration
// oscillates and cancels instead of walking — so the DIFFERENCE of successive attitude samples is
// the clean integral of the car's yaw. The reducer that does this, clocked by the sensor's own
// timestamps, is src/yawFeed.ts (pure, node-gated); this file owns the subscription.
//
// ── RULES THIS MODULE KEEPS ───────────────────────────────────────────────────────────────
//  • NEVER `import` expo-sensors at module scope — build 73 binaries have no native module and a
//    static import strands them on every future OTA. Go through loadDeviceMotion(), which probes
//    first (see src/guidedCamera.ts header).
//  • Nav-only. start() is ref-counted by the surfaces; the subscription exists only while a drive
//    is on. A gyro at 20 Hz is cheap, but it is not free and it is not needed in free drive.
//  • No permission prompt. CMMotionManager device motion needs none; requestPermissionsAsync is
//    never called here (src/permissionGate.ts is the only place that raises a sheet).
//  • The SIGN is not assumed. Mount orientation, platform convention and axis order all vary; the
//    estimator learns the sign from the GPS course (src/poseEstimator.ts yawSign) and treats the
//    gyro as absent until it has.
//  • Receipts: `yaw-rate` on the first advancing sample of a drive and on stop, with counts. Bounded.
import { Platform } from "react-native";
import { loadDeviceMotion } from "./guidedCamera";
import { logEventReliable } from "./crashBreadcrumb";
import type { MotionPlatform } from "./yawMath";
import { yawFeedStart, yawFeedStep, yawFeedIntegral, yawFeedMeanDps, yawFeedSourceDiffDeg, type YawFeedState } from "./yawFeed";

const PLATFORM: MotionPlatform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";

const UPDATE_MS = 50;              // 20 Hz — a 90° corner at city speed is 20–40°/s; 20 Hz sees it

let _refs = 0;
let _sub: { remove?: () => void } | null = null;
let _starting = false;
let _available: boolean | null = null;
let _feed: YawFeedState = yawFeedStart();
let _firstLogged = false;

function fold(m: any): void {
  const next = yawFeedStep(_feed, m, PLATFORM, Date.now());
  if (next === _feed) return;                              // not a new sample
  _feed = next;
  if (!_firstLogged) {
    _firstLogged = true;
    const g = m?.accelerationIncludingGravity ?? m?.gravity;
    const n = Math.hypot(Number(g?.x ?? 0), Number(g?.y ?? 0), Number(g?.z ?? 0));
    const deg = (r: number | null) => (r == null ? "?" : (r * 180 / Math.PI).toFixed(0));
    // pitch= is the mount angle (±90 = phone standing upright — the Euler-yaw singularity; `lock=1` means
    // the gyro is carrying the integral for that reason). Refuter 2026-09-10: nothing had ever logged it.
    try { logEventReliable(`yaw-rate first src=${_feed.src} lock=${_feed.locked ? 1 : 0} pitch=${deg(_feed.pitchRad)} roll=${deg(_feed.rollRad)} dps=${(_feed.lastDps ?? 0).toFixed(1)} g=${n.toFixed(1)} os=${PLATFORM} interval=${UPDATE_MS}`); } catch {}
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
    try { logEventReliable(`yaw-rate stop samples=${_feed.samples} src=${_feed.src ?? "none"} lock=${_feed.locked ? 1 : 0} mdiff=${yawFeedSourceDiffDeg(_feed).toFixed(1)}`); } catch {}
  }
  _sub = null; _feed = yawFeedStart(); _firstLogged = false;
}

/** The MEAN yaw rate over the last ~400 ms of SENSOR time in deg/s (sign convention unknown to the
 *  caller), or null if none/stale. Receipts only — the estimator integrates the cumulative value. */
export function getYawRateDps(): number | null {
  return yawFeedMeanDps(_feed, Date.now());
}

/**
 * The CUMULATIVE yaw in degrees (sign-agnostic), or null when no sample has advanced in the last
 * 500 ms. Never reset by a reader: the phone and the car surface each run their own estimator,
 * and a destructive "since last call" here made the second reader see a fragment (Codex 4th
 * pass). Each estimator keeps its own cursor (poseEstimator `yawCumAtCourse`).
 *
 * INVARIANT (Codex 5th pass): stopYawRate() zeroes the integral when the LAST consumer leaves, so
 * a PoseState that outlived that stop would difference against a cursor from the old integral.
 * Today none does — both surfaces `poseStart()` the moment their drive ends and only stop the
 * sensor on that same edge. Any new consumer must reset its PoseState when it stops the sensor.
 */
export function getYawIntegralDeg(): number | null {
  return yawFeedIntegral(_feed, Date.now())?.cumDeg ?? null;
}

/**
 * The cumulative yaw WITH the SENSOR time it was measured at (ms on the sensor's monotonic clock),
 * or null when stale. posePredict clamps a delta against the sensor interval, never the render
 * interval (two renders 2 ms apart around one 50 ms sample would otherwise drop a legal turn), and
 * a frozen sensor reads as "no gyro", never as a healthy gyro reporting zero turn (Codex 2026-09-10).
 */
export function getYawIntegral(): { cumDeg: number; atMs: number } | null {
  return yawFeedIntegral(_feed, Date.now());
}

export function yawRateStats(): { available: boolean | null; samples: number; ageMs: number | null; refs: number; src: "att" | "rate" | null; locked: boolean; pitchDeg: number | null } {
  return { available: _available, samples: _feed.samples, ageMs: _feed.advancedAtMs ? Date.now() - _feed.advancedAtMs : null, refs: _refs, src: _feed.src, locked: _feed.locked, pitchDeg: _feed.pitchRad == null ? null : _feed.pitchRad * 180 / Math.PI };
}

/**
 * Fused-minus-gyro cumulative difference in degrees: the fusion (magnetometer) correction the
 * attitude has absorbed so far. Printed as `mdiff=` on pose-fix rows; its change between rows is
 * the slew rate the estimator saw. THE ONE CHECK for the magnetic-slew HYPOTHESIS (2026-09-10).
 */
export function getYawSourceDiffDeg(): number { return yawFeedSourceDiffDeg(_feed); }
