// carViewfinderLevel.ts — the "is the phone held right?" math for the guided viewfinder.
//
// Pure functions, no imports, no React: the whole point is that this can be run
// offline against synthetic orientations (tools-free, `node`), because a level gate
// that never goes green is worse than no gate at all — it would block capture with
// no way for the driver to understand why.
//
// ── WHY EVERY TEST HERE IS SIGN-AGNOSTIC (read before "improving" it) ──────────
// The obvious implementation is atan2 on the gravity vector to get a signed roll and
// a signed camera elevation, then gate on a target band. I did not do that, on
// purpose. expo-sensors reports `accelerationIncludingGravity`, and I have NOT
// verified on a real device which way its axes point in this SDK on each platform —
// proper acceleration is the negative of gravity, iOS and Android historically differ,
// and the W3C convention is easy to state and easy to get backwards. A gate built on
// a sign I guessed would, if the guess were wrong, be permanently red on one platform:
// the driver would stand in a car park watching a bubble that never centres.
//
// So both tests use MAGNITUDES, which hold under either convention:
//
//   roll  — the phone is not tilted sideways when the screen's X axis is horizontal,
//           i.e. |gx| is small. True whether gravity reads +y or -y.
//   aim   — the camera looks along the screen normal (Z), so the camera is level with
//           the horizon when |gz| is small, and pointed at the sky or the tarmac when
//           |gz| approaches 1. Again sign-free.
//
// What this deliberately gives up: it cannot say "you are aiming UP" vs "aiming DOWN",
// only "you are off the horizon". The UI says "Aim level" rather than a direction it
// cannot justify. It also reads an upside-down portrait as level — harmless, since the
// camera writes orientation into the image either way and nobody photographs a car
// holding the phone inverted.
//
// The coaching copy asks for the phone "tilted slightly down" (carScan.ts SCAN_RULES),
// and AIM_TOL of 0.35 admits roughly 0-20 degrees off the horizon in either direction,
// so a correctly-held phone passes comfortably.

export type Vec3 = { x: number; y: number; z: number };

export type LevelReading = {
  /** 0 = screen X axis dead horizontal, 1 = fully rolled onto its side. */
  roll: number;
  /** 0 = camera on the horizon, 1 = aimed straight up or straight down. */
  aim: number;
  /** 0 = perfectly still. Frame-to-frame movement of the normalised vector. */
  motion: number;
  /** All three within tolerance. */
  ready: boolean;
};

/** |gx| ceiling. 0.10 ~= 6 degrees of sideways tilt. */
export const ROLL_TOL = 0.1;
/** |gz| ceiling. 0.35 ~= 20 degrees off the horizon, either way. */
export const AIM_TOL = 0.35;
/** Frame-to-frame delta ceiling; above this the driver is still moving. */
export const MOTION_TOL = 0.06;

/** Unit-length copy, or null when the sample is degenerate (freefall, no sensor). */
export function normalise(g: Vec3 | null | undefined): Vec3 | null {
  if (!g) return null;
  const { x, y, z } = g;
  if (![x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const m = Math.hypot(x, y, z);
  // A phone at rest reads ~9.81 m/s^2. Anything near zero is freefall or a dead
  // sensor, and dividing by it would produce garbage that reads as "perfectly level".
  if (m < 1) return null;
  return { x: x / m, y: y / m, z: z / m };
}

/**
 * Turn a gravity sample into a level reading. `prev` is the previous NORMALISED
 * sample and supplies the steadiness term; pass null on the first frame (which then
 * reports motion 0 and is allowed to be ready, matching "the phone was already still
 * when the viewfinder opened").
 */
export function readLevel(raw: Vec3 | null | undefined, prev: Vec3 | null): LevelReading {
  const g = normalise(raw);
  if (!g) return { roll: 1, aim: 1, motion: 1, ready: false };
  const roll = Math.abs(g.x);
  const aim = Math.abs(g.z);
  const motion = prev ? Math.hypot(g.x - prev.x, g.y - prev.y, g.z - prev.z) : 0;
  return {
    roll,
    aim,
    motion,
    ready: roll <= ROLL_TOL && aim <= AIM_TOL && motion <= MOTION_TOL,
  };
}

/** Degrees off, for the on-screen readout. Magnitudes, so always >= 0. */
export function rollDegrees(roll: number): number {
  return Math.round((Math.asin(Math.min(1, Math.max(0, roll))) * 180) / Math.PI);
}
export function aimDegrees(aim: number): number {
  return Math.round((Math.asin(Math.min(1, Math.max(0, aim))) * 180) / Math.PI);
}

/**
 * The single line of guidance to show. Ordered by what most needs fixing, so the
 * driver is never given two corrections at once.
 */
export function levelHint(l: LevelReading): string {
  if (l.roll > ROLL_TOL) return "Straighten up — hold the phone level";
  if (l.aim > AIM_TOL) return "Aim level — square to the side of the car";
  if (l.motion > MOTION_TOL) return "Hold still…";
  return "Hold it there";
}
