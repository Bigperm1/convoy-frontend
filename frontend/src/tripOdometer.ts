// tripOdometer — how far the car ACTUALLY travelled on this drive.
//
// Dependency-free on purpose (no React, no RN, no imports) so
// `tools/sim-qc/trip_odometer_test.mts` drives this exact code under plain Node.
//
// ── WHY THIS EXISTS (measured 2026-09-09) ────────────────────────────────────────────────
// `recordTrip` credited the ROUTE'S PLANNED distance, never the distance driven. src/trips.ts
// said so out loud — "It under-reports a detour and over-reports a short-cut; if that ever
// matters, the honest upgrade is to integrate the SNAPPED positions" — and it mattered. Four
// rows in Jeff's own history, all 2026-09-06:
//
//     distance 17.22 km · duration 139 s · top_speed 0  ⇒  445 km/h average
//     distance 17.22 km · duration 139 s · top_speed 0  ⇒  445 km/h
//     distance 17.21 km · duration 140 s · top_speed 0  ⇒  443 km/h
//     distance 17.20 km · duration 140 s · top_speed 0  ⇒  443 km/h
//
// A route was plotted, arrival fired ~2 minutes later, and the full 17.2 km was banked each
// time. 68.9 km of his 1,989.5 km lifetime total is distance he never drove, and it is on the
// club leaderboard. Nothing in the app could tell the difference, because nothing was counting.
//
// ── WHY INTEGRATE FIXES RATHER THAN READ ROUTE PROGRESS ──────────────────────────────────
// Route progress resets on every reroute (Ni GR swapped routes 20+ times in one session on
// 2026-09-09), so it cannot survive a drive. Fixes can. The old objection to integrating GPS —
// "a phone parked for an hour invents hundreds of metres" — is answered by the gates below,
// not by refusing to count.
//
// This rides the LOCATION stream, deliberately: JS timers freeze on a locked phone with
// CarPlay live, but location events still run JS, so an odometer fed by fixes keeps counting
// on exactly the drives a timer-driven one would lose.

/** One position fix. `at` is epoch ms; `accM` is horizontal accuracy in metres if known;
 *  `speedMs` is the fix's own reported ground speed in m/s if known. */
export type OdoFix = { lat: number; lng: number; at: number; accM?: number; speedMs?: number };

export type OdoState = {
  /** Metres accumulated. */
  m: number;
  /** The last fix distance was measured FROM. Null until the first accepted fix. */
  anchor: OdoFix | null;
  /** Fixes refused, by reason — carried in the receipt so a wrong gate is visible. */
  skippedAcc: number;
  skippedJump: number;
  skippedGap: number;
  skippedStopped: number;
};

/**
 * Below this a step is GPS jitter, not travel.
 *
 * 5 m was NOT enough and the gate proved it: replaying a stationary phone with ordinary urban
 * noise of +/-3 m, consecutive fixes land up to 6 m apart, each one clearing a 5 m floor —
 * 121 invented metres in 140 seconds, which is 3 km/hour of standing still. That is precisely
 * the "a phone parked for an hour invents hundreds of metres" objection src/trips.ts raised
 * against integrating GPS at all. 12 m clears realistic noise while staying far below one
 * second of real driving (25 m at 90 km/h), and because the anchor is HELD below the floor,
 * a slow crawl still accumulates in 12 m quanta rather than being swallowed.
 */
export const ODO_MIN_STEP_M = 12;
/**
 * A fix reporting less than this is STOPPED, and a stopped car covers no ground no matter what
 * its coordinates do. This is the decisive gate: GPS speed is derived from Doppler, not from
 * differencing positions, so it stays near zero on a parked phone even while the fix wanders.
 * Applied only when the platform actually reports a speed; the distance floor covers the rest.
 */
export const ODO_STOPPED_MS = 0.5;
/** A fix vaguer than this cannot resolve a 12 m step, so it is not allowed to create one. */
export const ODO_MAX_ACC_M = 50;
/** Longer than this between fixes and we cannot know the path taken (tunnel, suspend, kill). */
export const ODO_MAX_GAP_S = 120;
/** 90 m/s = 324 km/h. Above this the pair is a teleport (a seed fix, a spoof, a sim jump). */
export const ODO_MAX_SPEED_MS = 90;
/** A recorded drive must clear this, matching recordTrip's own floor. */
export const ODO_MIN_TRIP_M = 500;

export function odoStart(): OdoState {
  return { m: 0, anchor: null, skippedAcc: 0, skippedJump: 0, skippedGap: 0, skippedStopped: 0 };
}

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Fold one fix in. Pure: returns a NEW state, never mutates.
 *
 * The anchor is held (not advanced) while a step is below ODO_MIN_STEP_M, so creeping in
 * traffic still accumulates once the car has genuinely moved that far — advancing the anchor on
 * every sub-floor fix would silently swallow slow driving, which is the failure mode that
 * makes people distrust an odometer.
 */
export function odoAdd(s: OdoState, f: OdoFix): OdoState {
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng) || !Number.isFinite(f.at)) return s;
  if (typeof f.accM === "number" && Number.isFinite(f.accM) && f.accM > ODO_MAX_ACC_M) {
    return { ...s, skippedAcc: s.skippedAcc + 1 };
  }
  if (!s.anchor) return { ...s, anchor: f };

  const dt = (f.at - s.anchor.at) / 1000;
  if (!(dt > 0)) return s;                                  // out-of-order or duplicate fix
  // STOPPED: re-anchor so drift while standing still can never add up to a step.
  if (typeof f.speedMs === "number" && Number.isFinite(f.speedMs) && f.speedMs < ODO_STOPPED_MS) {
    return { ...s, anchor: f, skippedStopped: s.skippedStopped + 1 };
  }
  if (dt > ODO_MAX_GAP_S) {                                 // re-anchor, claim nothing
    return { ...s, anchor: f, skippedGap: s.skippedGap + 1 };
  }

  const d = haversineM(s.anchor.lat, s.anchor.lng, f.lat, f.lng);
  if (d / dt > ODO_MAX_SPEED_MS) {                          // teleport: re-anchor, claim nothing
    return { ...s, anchor: f, skippedJump: s.skippedJump + 1 };
  }
  if (d < ODO_MIN_STEP_M) return s;                         // jitter: HOLD the anchor

  return { ...s, m: s.m + d, anchor: f };
}

/** Metres travelled, rounded to a whole metre. */
export function odoMeters(s: OdoState): number {
  return Math.max(0, Math.round(s.m));
}

/**
 * Did the car actually cover the distance being claimed for it?
 *
 * This is the guard that would have refused all four of Jeff's 445 km/h rows. It is deliberately
 * generous — 200 km/h AVERAGE over the whole drive, not a top speed — so it can only ever reject
 * a row that is physically impossible, never a fast one. Jeff's real drives sit at 106-126 km/h
 * average, his fastest recorded top speed is 165.8 km/h.
 */
export const PLAUSIBLE_MAX_AVG_KMH = 200;
export function isPlausibleDrive(distanceM: number, durationS: number): boolean {
  if (!(distanceM > 0)) return false;
  if (!(durationS > 0)) return false;
  return (distanceM / 1000) / (durationS / 3600) <= PLAUSIBLE_MAX_AVG_KMH;
}

/**
 * WHAT DISTANCE A FINISHED DRIVE IS WORTH.
 *
 * Extracted so tools/sim-qc/trip_odometer_test.mts can hold the line on the exact seam that
 * nearly shipped the original bug back: an odometer reading of ZERO is a MEASUREMENT, not a
 * missing value. Treating `0` as "no reading" fell back to the planned route distance, so a
 * driver who plotted a 5 km route, never moved and pressed End was credited the full 5 km —
 * the same phantom mileage the odometer exists to prevent, at 150 km/h, sailing through the
 * plausibility guard. Only `null`/`undefined`/NaN mean "no odometer ran here".
 */
export function creditedDistanceM(
  routeM: number, travelledM: number | null | undefined,
): { m: number; src: "odo" | "route" } {
  const hasReading = typeof travelledM === "number" && Number.isFinite(travelledM) && travelledM >= 0;
  if (hasReading) return { m: travelledM as number, src: "odo" };
  return { m: Number.isFinite(routeM) && routeM > 0 ? routeM : 0, src: "route" };
}
