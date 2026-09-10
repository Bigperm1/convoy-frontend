// poseEstimator — a CONTINUOUS estimate of where the car is and which way it points.
//
// Dependency-free on purpose (no React, no RN, no imports) so `tools/sim-qc/pose_estimator_test.mts`
// drives this exact code under plain Node. Both surfaces (src/ConvoyMapbox.tsx, src/carplay/
// CarMapView.tsx) feed it and draw its output.
//
// ── WHY (2026-09-09, Jeff: "why is it drifting and at low speeds ... why cant this be fixed") ──
// The drawn car used to be a stack of SWITCHES: every render CHOSE one of three positions (the
// route-line projection, the nearest road, the raw fix) and one of two headings (the polyline's
// tangent, the raw GPS course), and every chooser was a threshold on ONE signal that arrives about
// once a second. The corrections layered on top (cornerBlend, cornerNose) needed two or three fixes
// of evidence before they acted — and a low-speed corner IS two or three fixes. They acted as the
// corner ended. The same corner produced the same bad row on three drives across five revisions:
//     King Rd left, raw≈49.03109,-122.29312  hdg=124 gpsHdg=136 rb=159  d = 15.9 / 10.8 / 14.8 m
// (2026-09-04, 09-05, 09-09). hdg=124 is the bisector of the two legs — the nose was the LINE's
// geometry, 35° off the road still under the car. No threshold can fix a 1–2 fix event with a gate
// clocked at 1 Hz; it can only trim its tail. So: no switches. One pose, integrated every frame.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────────
//   posePredict  every frame: heading += yaw rate × dt (gyro about gravity when the phone has one,
//                else the turn rate inferred from successive GPS courses); position dead-reckons
//                along the heading at the last known speed, capped so a lost signal cannot run the
//                car down the road on its own.
//   poseFix      each GPS fix: pull the estimate toward the fix, weighted by its ACCURACY and its
//                AGE, and refuse to trust a fix that implies an impossible jump (tonight's 00:56:48
//                i=1 fix implied 65 km/h to the next one — it was drawn as current). The course
//                corrects the heading gently when moving, and teaches the gyro its bias.
//   poseRoute    each frame: a LATERAL pull toward the route projection with a WEIGHT that falls as
//                the yaw rate rises and as the lateral distance grows. Straights ride the line;
//                corners are drawn where the car is. Nothing flips.
// The nose is the integrated heading. Never the polyline's raw tangent (the bisector failure above).
//
// ── THE ROAD HEADING (2026-09-10, Jeff: "how do the big 3 do the GPS?") ───────────────────
// With the gyro off by default (src/yawRate.ts), the only turn evidence is the GPS course, once a
// second: measured on this gate, the nose ran ~30° behind through a 15 km/h corner and popped
// 14–16° per frame at every fix; when iOS dropped the course inside the corner it did not turn at
// all. Mapbox's engine (MapboxCoreNavigation CLLocation.swift snapped(to:)) does what every vendor
// does: while the car is on the line, the puck's course IS the line's direction averaged over
// ±max(speed/2, 7.5) m around the projection (never a vertex bisector — a 7.5 m window is a 10 m
// corner), and the raw course only wins when it is qualified (≥ 3 m/s, accuracy < 20 m) AND
// disagrees with the road by more than 45°. The surfaces hand that windowed direction in as
// `roadHdg` (projectOntoRoute). ON THE NO-GYRO PATH THE HEADING IS ONE EASED, RATE-LIMITED VALUE
// (τ 0.35 s, ≤ 45°/s) chasing a single target: the convex mix, by roadK, of the last course carried
// forward by the inferred turn and the road's direction aged along the line — the fix never jolts
// it (three refuter lenses, 2026-09-10: every per-frame pop traced to the fix blending against a
// road direction one projection stale). The release (a qualified course from the NEWEST fix more
// than 45° from the road, hysteresis 30°) frees the nose and the lateral pull; a new chord that
// steps further than a car can turn, with no course to corroborate it, is held for one fix (a noisy
// projection flipping legs at a vertex) or refused outright beyond 90° (a wrong leg). Gate: section X,
// swept over noise seeds, against the same runs with the road stripped.

export type PoseFix = {
  lat: number; lng: number;
  /** The fix's OWN timestamp (epoch ms), not the render clock. */
  at: number;
  accM?: number | null;
  speedMs?: number | null;
  /** GPS course, degrees true; null/undefined when the platform reports none. */
  courseDeg?: number | null;
};

/** The route-line projection of the RAW fix, when navigating and within reach. `roadHdg` is the line's
 *  direction averaged over the vendors' window around the projection (projectOntoRoute); absent, the
 *  raw segment bearing stands in. */
export type PoseRoute = { lat: number; lng: number; bearing: number; distM: number; roadHdg?: number | null; roadHdgAhead?: number | null } | null;

export type PoseState = {
  lat: number; lng: number;
  hdg: number;                 // degrees, 0 = north, clockwise
  spd: number;                 // m/s, from the last fix
  tAt: number;                 // last posePredict clock (epoch ms)
  fixAt: number;               // last ACCEPTED fix time (fix clock)
  hasFix: boolean;
  hdgKnown: boolean;           // false until a usable GPS course has been seen: no direction, no dead reckoning
  drM: number;                 // metres dead-reckoned since the last accepted fix
  yawBias: number;             // deg/s, learned
  yawSign: 1 | -1 | 0;         // sensor sign vs heading convention, learned from the course; 0 = unknown
  yawAgree: number;            // evidence accumulator for yawSign
  lastCourse: number | null;   // last usable GPS course
  lastCourseAt: number;
  gpsTurnDps: number;          // turn rate inferred from successive courses (decays)
  routeW: number;              // eased lateral route weight 0..1
  errPrev: number | null;      // last course-vs-heading error, for the bias RATE (not the error itself)
  errPrevAt: number;
  pendLat: number; pendLng: number;   // fix correction still to be applied, eased out by posePredict (degrees)
  rawLat: number; rawLng: number; rawAt: number;   // the previous RAW fix, accepted or not
  yawCumAtCourse: number | null;   // the sensor's cumulative yaw when the last course was ADOPTED
  yawCumPrev: number | null;       // the sensor's cumulative yaw last consumed (delta source)
  yawCumPrevAt: number;            // …and the SENSOR time it was measured at (the clamp's clock)
  yawDpsLast: number;              // sensor-frame rate of the last consumed delta (receipts, route weight)
  roadHdg: number | null;          // the road's windowed direction at the held projection (null = none / released)
  roadHdgAhead: number | null;     // …and speed × 1 s further along the line (where the car will be at the next fix)
  roadK: number;                   // 0..1 how much the road owns the nose this frame (distance weight; 0 when released)
  roadAt: number;                  // predict-clock time the road was last handed in
  roadSetAt: number;               // predict-clock time the PROJECTION last moved (the road direction's age)
  projLat: number; projLng: number;   // the held projection, to notice when it moves
  projMovedAt: number;             // predict-clock time the projection last MOVED (the adoption clock; refuter 09-10: clocking
                                   // it from the last ADOPTION let a refused wrong-leg chord in after ~4 s of no course)
  accLast: number | null;          // horizontal accuracy of the last accepted fix (the release rule)
  roadReleased: boolean;           // the line let go of the nose (hysteresis: re-snaps only inside POSE_ROAD_RESNAP_DEG)
  roadHeld: number;                // consecutive fixes whose chord was HELD back (an implausible, uncorroborated step)
  roadSuspect: boolean;            // the CURRENT projection was held back or refused: no lateral pull toward it, and the verdict
                                   // stands until the projection moves or a qualified course speaks (Codex pass 3: a per-call
                                   // flag let the pull creep back on the next render, and an unchanged refused chord was
                                   // re-judged every frame and admitted by elapsed time alone after 4 s)
  src: "gyro" | "gps" | "road" | "hold" | "none";
  fixes: number; rejected: number; maxStepM: number;
};

// ── constants (each one is a physical statement, not a tuned edge) ──────────────────────────
/** Below this the car is not moving: heading holds, position holds, GPS course is noise. */
export const POSE_MOVING_MS = 1.0;
/** A yaw delta faster than this over its SENSOR interval is not a car turning (a wrapped sample, a sensor restart): dropped. */
export const POSE_YAW_MAX_DPS = 90;
/** Sensor-timestamped cumulative yaw, as src/yawRate.ts getYawIntegral() hands it in. */
export type PoseYaw = { cumDeg: number; atMs: number };
/** GPS course is trustworthy enough to correct heading above this (≈11 km/h). */
export const POSE_COURSE_MIN_MS = 3.0;
/** Dead reckoning without a fix stops here; beyond it the estimate waits for GPS. */
export const POSE_DR_MAX_M = 40;
/** A predict step longer than this is a gap (suspension, stall): advance the clock, not the car. */
export const POSE_MAX_DT_S = 1.5;
/** Fix weight by horizontal accuracy: sharp fixes move the estimate hard, vague ones nudge it. */
export const POSE_W_SHARP = 0.65;   // accM ≤ 10
export const POSE_W_OK = 0.40;      // accM ≤ 30
export const POSE_W_VAGUE = 0.15;   // accM > 30 or unknown-and-old
/** A fix older than this (vs the newest we have) is history, not position. */
export const POSE_FIX_STALE_MS = 2500;
/** A fix whose implied speed from the previous fix exceeds reported×1.5 + this is a jump. */
export const POSE_JUMP_SLACK_MS = 5;
export const POSE_W_JUMP = 0.12;
/** An innovation inside the fix's own noise band is jitter: follow it at half weight. */
export const POSE_INNOV_SLACK_M = 3;
/** First fix ever: take it whole. */
/** Heading correction from a GPS course: with a gyro the course only trims drift; without one it steers. */
export const POSE_HDG_W_GYRO = 0.15;
export const POSE_HDG_W_GPS = 0.7;
/** A stopped car does not move: fixes at standstill only nudge (GPS jitter must not roam the marker). */
export const POSE_W_STILL = 0.08;
/** Gyro bias is learned from how fast the course error DRIFTS on a straight, never from the error itself. */
export const POSE_BIAS_STRAIGHT_DPS = 3;
/** Gyro bias learning rate (per fix) and clamp. */
export const POSE_BIAS_K = 0.08;
export const POSE_BIAS_MAX_DPS = 6;
/** Route pull: maximum lateral weight, the yaw rate at which it is fully released, the reach. */
export const POSE_ROUTE_W_MAX = 0.3;
export const POSE_ROUTE_YAW_FREE_DPS = 12;
export const POSE_ROUTE_MAX_M = 40;
export const POSE_ROUTE_TAU_S = 0.4;
/** A fix correction is eased out over this, so a 5 m correction is a slide, never a pop. */
export const POSE_CORR_TAU_S = 0.35;
/** GPS-only turn rate: inferred between courses, clamped, decays when no new course lands. */
export const POSE_GPS_TURN_MAX_DPS = 40;
export const POSE_GPS_TURN_HOLD_MS = 1200;
/** The inferred rate is an average over the PAST second; extrapolate only half of it forward. */
export const POSE_GPS_TURN_GAIN = 0.5;
/** A course this far from the heading is not gyro drift, the heading is simply wrong: adopt the course. */
export const POSE_HDG_SNAP_DEG = 60;
/** ROAD HEADING (the vendors' rule, 2026-09-10). A qualified course that disagrees with the road by more
 *  than this says the line is wrong here: the road lets go of the nose and the lateral pull
 *  (Mapbox RouteSnappingMaxManipulatedCourseAngle = 45). */
export const POSE_ROAD_RELEASE_DEG = 45;
/** …and once released the line does not take the nose back until the course agrees within this — a
 *  course hovering at the 45° edge (a diagonal lot exit) would otherwise release and re-snap once a
 *  second, each re-snap a 45°/s swing (Codex pass 3 probe, 2026-09-10). */
export const POSE_ROAD_RESNAP_DEG = 30;
/** CONTINUOUS release for the NOSE: while the newest fix carries a course, the road's weight fades as the road
 *  and course targets disagree — full inside this angle, none at POSE_ROAD_RELEASE_DEG. A noisy fix flipping
 *  legs at a single vertex hands in a chord 40–60° from a perfectly good course; the course wins there,
 *  without a flip (gate X1n: 51° → the course-path figure). With no course on the newest fix (iOS inside a
 *  slow corner) the road is the only evidence and keeps full weight. */
export const POSE_ROAD_AGREE_DEG = 15;
/** SHARPNESS: where the line turns more than this within the next second of travel (|roadHdgAhead − roadHdg|),
 *  a ONE-vertex line is cutting a corner the car drives as an arc, and the raw-fix projection flips legs at
 *  the vertex — the chord is worse evidence than the course there. The road's weight fades from this angle
 *  to none at POSE_ROAD_SHARP_FULL_DEG, only while the newest fix carries a course (Mapbox restricts
 *  snapping at sharp maneuvers for the same reason). A roundabout on a dense line turns ~20°/s: unaffected. */
export const POSE_ROAD_SHARP_DEG = 20;
export const POSE_ROAD_SHARP_FULL_DEG = 60;
/** A course qualifies to release the road only from a fix at least this sharp (Mapbox RouteSnappingMinimumHorizontalAccuracy = 20)
 *  and while moving ≥ POSE_COURSE_MIN_MS (Mapbox RouteSnappingMinimumSpeed = 3). */
export const POSE_ROAD_RELEASE_ACC_M = 20;
/** The nose eases onto the road's direction over this: a new direction each fix is a slide, never a pop. */
export const POSE_ROAD_TAU_S = 0.35;
/** …and never faster than this. A car's yaw rate through the tightest corners is 25–45°/s (a hairpin of
 *  radius 8 at 20 km/h is 40°/s), so the eased nose needs headroom above that to catch a real turn; 60°/s
 *  is a rate a road car does not exceed. The swing is continuous (3°/frame at 20 Hz), never a pop. */
export const POSE_ROAD_MAX_DPS = 60;
/** The road direction is the line averaged over ±poseRoadWindowM(speed) = max(speed × 1.0 s / 2, 10 m).
 *  Mapbox's interpolatedCourse span is max(speed × RouteControllerDeadReckoningTimeInterval(1.0) / 2,
 *  15 / 2 = 7.5 m); ours floors at 10 m — the tangent length of a 10 m-radius 90° corner, the tightest
 *  a car takes at 15 km/h (gate sweep: 7.5 → 10 m took the King Rd-shaped corner from 26.1° to 24.0°
 *  and the course-dropped corner from 32.8° to 27.0°, for +1.3° on a 30 m-radius sweep). */
export const POSE_ROAD_WINDOW_MIN_M = 10;
export function poseRoadWindowM(speedMs: number | null | undefined): number {
  const v = typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 0;
  return Math.max(v * 0.5, POSE_ROAD_WINDOW_MIN_M);
}
/** A road direction not refreshed within this is history (the surfaces feed it every frame while navigating). */
export const POSE_ROAD_HOLD_MS = 2500;
/** A new chord further than the car could have turned since the projection last moved (POSE_ROAD_MAX_DPS × dt),
 *  with no qualified course within the release angle of it, is a projection that jumped — not a corner. It is
 *  held back for this many fixes (a noisy fix flipping legs at a vertex) and adopted after; beyond
 *  POSE_ROAD_ADOPT_MAX_DEG from the current road/heading it is refused (the wrong leg of a loop). */
export const POSE_ROAD_HOLD_FIXES = 1;
export const POSE_ROAD_ADOPT_MAX_DEG = 90;
/** The turn a car can plausibly have made between two projections: 45°/s (the tightest city corner). Kept
 *  separate from POSE_ROAD_MAX_DPS (the ease's headroom) so a wider swing allowance never loosens adoption. */
export const POSE_ROAD_ADOPT_DPS = 45;
/** The last course is a heading target for this long (carried forward by the inferred turn while that is live). */
export const POSE_COURSE_TARGET_HOLD_MS = 2500;
/** Bias is only learned while the course error is small; a converging heading is not a bias. */
export const POSE_BIAS_MAX_ERR_DEG = 15;
/** Sign learning: agree/disagree evidence needed before the gyro is trusted. */
export const POSE_SIGN_EVIDENCE = 2;
export const POSE_SIGN_MIN_DEG = 8;

const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
export const wrap180 = (d: number) => ((((d) % 360) + 540) % 360) - 180;
export const norm360 = (d: number) => ((d % 360) + 360) % 360;

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const φ1 = toRad(aLat), φ2 = toRad(bLat), Δλ = toRad(bLng - aLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(toDeg(Math.atan2(y, x)));
}
/** Move a point `dM` metres along `hdg`. Flat-earth step, exact enough for tens of metres. */
export function stepLatLng(lat: number, lng: number, hdg: number, dM: number): { lat: number; lng: number } {
  const dLat = (dM * Math.cos(toRad(hdg))) / R;
  const dLng = (dM * Math.sin(toRad(hdg))) / (R * Math.cos(toRad(lat)));
  return { lat: lat + toDeg(dLat), lng: lng + toDeg(dLng) };
}

const curLatFor = (st: PoseState) => st.lat + st.pendLat;
const curLngFor = (st: PoseState) => st.lng + st.pendLng;

/** Seed the gyro sign learned on an earlier drive (persisted by the caller), so the FIRST corner is gyro-driven too. */
export function poseSeedYawSign(st: PoseState, sign: 1 | -1 | 0): PoseState {
  return sign === 1 || sign === -1 ? { ...st, yawSign: sign, yawAgree: sign * POSE_SIGN_EVIDENCE } : st;
}

export function poseStart(): PoseState {
  return {
    lat: NaN, lng: NaN, hdg: 0, spd: 0, tAt: 0, fixAt: 0, hasFix: false, hdgKnown: false, drM: 0,
    yawBias: 0, yawSign: 0, yawAgree: 0, lastCourse: null, lastCourseAt: 0, gpsTurnDps: 0,
    routeW: 0, errPrev: null, errPrevAt: 0, pendLat: 0, pendLng: 0, rawLat: NaN, rawLng: NaN, rawAt: 0, yawCumAtCourse: null, yawCumPrev: null, yawCumPrevAt: 0, yawDpsLast: 0,
    roadHdg: null, roadHdgAhead: null, roadK: 0, roadAt: 0, roadSetAt: 0, projLat: NaN, projLng: NaN, projMovedAt: 0, accLast: null, roadReleased: false, roadHeld: 0, roadSuspect: false,
    src: "none", fixes: 0, rejected: 0, maxStepM: 0,
  };
}

/**
 * Advance the estimate to `nowMs`. `yawDps` is the sensor yaw rate about gravity (any sign
 * convention — the sign is learned from the course), null when there is no sensor sample.
 */
/**
 * `yawCumDeg` is the sensor's CUMULATIVE yaw about the vertical (src/yawRate.ts getYawIntegralDeg),
 * or null. The estimator differences it against its own `yawCumPrev` — it never integrates a
 * rate sample: a sample once per render frame aliased the mount vibration into a random walk
 * (2026-09-10 drive, ±33°/s on a straight highway, heading 31° off in the city corners).
 */
export function posePredict(st: PoseState, nowMs: number, yaw: PoseYaw | null | undefined): PoseState {
  // A fresh, timestamped cumulative yaw — or nothing. A stale/absent sensor is "no gyro" (null),
  // never a healthy gyro reporting zero turn (Codex 2026-09-10).
  const cumOk = !!yaw && Number.isFinite(yaw.cumDeg) && Number.isFinite(yaw.atMs);
  const yawCumPrev = cumOk ? yaw!.cumDeg : null;
  const yawCumPrevAt = cumOk ? yaw!.atMs : 0;
  if (!st.hasFix) return { ...st, tAt: nowMs, yawCumPrev, yawCumPrevAt, yawDpsLast: 0 };
  const rawDt = st.tAt > 0 ? (nowMs - st.tAt) / 1000 : 0;
  if (!(rawDt > 0)) return { ...st, tAt: nowMs, yawCumPrev, yawCumPrevAt, yawDpsLast: st.yawDpsLast };
  const dt = Math.min(rawDt, POSE_MAX_DT_S);
  // The yaw the sensor accumulated since the value last consumed, judged over the SENSOR interval:
  // renders are irregular (two can land 2 ms apart around one 50 ms sample), so the render dt is
  // the wrong clock for plausibility. A delta with no new sample is zero and keeps the last rate.
  let yawDelta: number | null = null;
  let yawDpsLast = st.yawDpsLast;
  let sensorDt = 0;
  if (cumOk && st.yawCumPrev != null) {
    sensorDt = (yaw!.atMs - st.yawCumPrevAt) / 1000;
    const d = yaw!.cumDeg - st.yawCumPrev;
    if (sensorDt <= 0) {
      yawDelta = 0;                                        // no new sample yet this render
    } else if (Math.abs(d) <= POSE_YAW_MAX_DPS * sensorDt) {
      yawDelta = d; yawDpsLast = d / sensorDt;
    } else {
      yawDelta = 0; yawDpsLast = 0;                        // a wrap or a restart, not a turn: dropped
    }
  } else if (!cumOk) {
    yawDpsLast = 0;
  }
  if (rawDt > POSE_MAX_DT_S) {
    // A render gap (a JS stall): NO dead reckoning — but the sensor kept integrating through it,
    // and its delta is fresh and sensor-timestamped, so the HEADING still turns (refuter 2026-09-10:
    // dropping it lost 12° across a 2 s stall inside a corner). The next fix re-anchors position.
    const hdg = yawDelta != null && st.yawSign !== 0 && st.hdgKnown
      ? norm360(st.hdg + yawDelta * st.yawSign - st.yawBias * Math.min(sensorDt, POSE_MAX_DT_S))
      : st.hdg;
    return { ...st, hdg, tAt: nowMs, src: "hold", yawCumPrev, yawCumPrevAt, yawDpsLast: 0 };
  }
  // Speed is the estimator's ACCEPTED speed. It used to accept a caller-supplied speed, and both
  // surfaces handed in the store's latest raw speed — which poseFix would then refuse as stale a
  // moment later, too late: it had already been integrated (Codex 3rd pass).
  const spd = st.spd;
  let hdg = st.hdg;
  let src: PoseState["src"] = "hold";
  const gyroOk = yawDelta != null && st.yawSign !== 0;
  if (!st.hdgKnown) {
    // No heading yet: nothing to integrate and no direction to dead-reckon along — but the queued
    // GPS corrections MUST still land (Codex 2nd pass: an early return here froze the marker at the
    // departure point through a 20 s parking-lot crawl with 38 m queued, then surged).
    let lat = st.lat, lng = st.lng, pendLat = st.pendLat, pendLng = st.pendLng;
    if (pendLat !== 0 || pendLng !== 0) {
      const k = 1 - Math.exp(-dt / POSE_CORR_TAU_S);
      lat += pendLat * k; lng += pendLng * k; pendLat *= 1 - k; pendLng *= 1 - k;
      if (Math.abs(pendLat) < 1e-9 && Math.abs(pendLng) < 1e-9) { pendLat = 0; pendLng = 0; }
    }
    return { ...st, lat, lng, pendLat, pendLng, tAt: nowMs, src: "hold", yawCumPrev, yawCumPrevAt, yawDpsLast };
  }
  if (spd >= POSE_MOVING_MS) {
    if (gyroOk) {
      hdg = norm360(hdg + yawDelta! * st.yawSign - st.yawBias * dt);
      src = "gyro";
    } else {
      // GPS path: ONE eased heading toward ONE target. The course target is the last course carried
      // forward by the inferred turn (half gain, while live); the road target slides from roadHdg (at
      // the held projection) to roadHdgAhead (speed × 1 s further along the line) as the projection
      // ages, so a held 1 Hz projection does not pin the nose to where the car WAS (Mapbox's predicted
      // keyPoints). The two are mixed by roadK — one equilibrium, never two (refuter 2026-09-10: a
      // rate-only roadK gave the predict and the fix different equilibria, a once-a-second sawtooth).
      const courseLive = st.lastCourse != null && nowMs - st.lastCourseAt <= POSE_GPS_TURN_HOLD_MS;
      const turnDps = courseLive && st.gpsTurnDps !== 0 ? st.gpsTurnDps * POSE_GPS_TURN_GAIN : 0;
      let courseTarget: number | null = null;
      if (st.lastCourse != null && nowMs - st.lastCourseAt <= POSE_COURSE_TARGET_HOLD_MS) {
        const ageC = Math.max(0, Math.min(POSE_GPS_TURN_HOLD_MS / 1000, (nowMs - st.lastCourseAt) / 1000));
        courseTarget = norm360(st.lastCourse + turnDps * ageC);
      }
      const roadFresh = st.roadHdg != null && st.roadK > 0 && nowMs - st.roadAt <= POSE_ROAD_HOLD_MS;
      let roadK = roadFresh ? st.roadK : 0;
      let roadTarget: number | null = null;
      if (roadFresh) {
        const ageS = Math.max(0, Math.min(1, (nowMs - st.roadSetAt) / 1000));
        const ahead = st.roadHdgAhead != null ? st.roadHdgAhead : st.roadHdg!;
        roadTarget = norm360(st.roadHdg! + wrap180(ahead - st.roadHdg!) * ageS);
        // Agreement and sharpness (see POSE_ROAD_AGREE_DEG / POSE_ROAD_SHARP_DEG): both judged only while the
        // NEWEST fix carries a course — with none, the road is the only evidence and keeps full weight.
        if (courseTarget != null && st.lastCourseAt === st.fixAt) {
          const dis = Math.abs(wrap180(roadTarget - courseTarget));
          roadK *= Math.max(0, Math.min(1, 1 - (dis - POSE_ROAD_AGREE_DEG) / (POSE_ROAD_RELEASE_DEG - POSE_ROAD_AGREE_DEG)));
          const sharp = Math.abs(wrap180(ahead - st.roadHdg!));
          roadK *= Math.max(0, Math.min(1, 1 - (sharp - POSE_ROAD_SHARP_DEG) / (POSE_ROAD_SHARP_FULL_DEG - POSE_ROAD_SHARP_DEG)));
        }
      }
      const target = roadTarget != null && courseTarget != null
        ? norm360(courseTarget + wrap180(roadTarget - courseTarget) * roadK)
        : (roadTarget ?? courseTarget);
      if (target != null) {
        const pull = wrap180(target - hdg) * (1 - Math.exp(-dt / POSE_ROAD_TAU_S));
        hdg = norm360(hdg + Math.max(-POSE_ROAD_MAX_DPS * dt, Math.min(POSE_ROAD_MAX_DPS * dt, pull)));
        src = roadK >= 0.5 ? "road" : "gps";
      } else if (st.lastCourse != null) {
        src = "gps";                                          // nothing live to chase: the heading holds
      }
    }
  }
  // Dead reckoning along the heading, capped since the last accepted fix.
  let lat = st.lat, lng = st.lng, drM = st.drM;
  if (spd >= POSE_MOVING_MS && drM < POSE_DR_MAX_M) {
    const step = Math.min(spd * dt, POSE_DR_MAX_M - drM);
    const p = stepLatLng(lat, lng, hdg, step);
    lat = p.lat; lng = p.lng; drM += step;
  }
  // Ease out whatever correction the last fix left pending (frame-rate independent).
  let pendLat = st.pendLat, pendLng = st.pendLng;
  if (pendLat !== 0 || pendLng !== 0) {
    const k = 1 - Math.exp(-dt / POSE_CORR_TAU_S);
    lat += pendLat * k; lng += pendLng * k;
    pendLat *= 1 - k; pendLng *= 1 - k;
    if (Math.abs(pendLat) < 1e-9 && Math.abs(pendLng) < 1e-9) { pendLat = 0; pendLng = 0; }
  }
  return { ...st, lat, lng, hdg, yawCumPrev, yawCumPrevAt, yawDpsLast, tAt: nowMs, drM, pendLat, pendLng, src };
}

/** Fold a GPS fix in. Rejects out-of-order fixes; down-weights vague, stale and impossible ones. */
/**
 * `yawCumDeg` is the sensor's CUMULATIVE integrated yaw (src/yawRate.ts getYawIntegralDeg), or null.
 * The estimator differences it against its own cursor when a course is adopted, so a rejected or
 * stale fix consumes nothing and two estimators sharing one sensor never see each other's fragments.
 */
export function poseFix(st: PoseState, f: PoseFix, yawCumDeg?: number | null): PoseState {
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng) || !Number.isFinite(f.at)) return st;
  if (st.hasFix && f.at <= st.fixAt) return { ...st, rejected: st.rejected + 1 };
  const spdF = typeof f.speedMs === "number" && Number.isFinite(f.speedMs) && f.speedMs >= 0 ? f.speedMs : null;
  const course = typeof f.courseDeg === "number" && Number.isFinite(f.courseDeg) && f.courseDeg >= 0 ? norm360(f.courseDeg) : null;
  // ── FRESHNESS, decided once, before anything else (Codex 2nd + 3rd pass) ─────────────────
  // Age is measured against the prediction clock, not just ordering: a fix delivered late — a
  // background hand-off, a remount replaying a cached fix — is newer than the last one and still
  // seconds old. It says where the car WAS. A stale fix may nudge the position; it may NOT adopt a
  // speed, a course, renew the dead-reckoning budget, mark the heading known, or serve as the
  // previous raw fix for plausibility. This applies to the FIRST fix as much as any other.
  const ageMs = st.tAt > 0 ? st.tAt - f.at : 0;
  const stale = ageMs > POSE_FIX_STALE_MS;
  const spd = stale ? st.spd : (spdF ?? st.spd);
  const acc = typeof f.accM === "number" && Number.isFinite(f.accM) && f.accM >= 0 ? f.accM : null;

  if (!st.hasFix) {
    const useCourse = !stale && course != null && (spdF ?? 0) >= POSE_MOVING_MS;
    return {
      ...st, lat: f.lat, lng: f.lng, hdg: useCourse ? course! : st.hdg, spd: stale ? 0 : (spdF ?? 0),
      fixAt: f.at, tAt: st.tAt || f.at,
      hasFix: true, hdgKnown: useCourse, drM: 0,
      lastCourse: useCourse ? course : null, lastCourseAt: useCourse ? f.at : 0,
      yawCumAtCourse: useCourse && typeof yawCumDeg === "number" && Number.isFinite(yawCumDeg) ? yawCumDeg : null,
      rawLat: stale ? NaN : f.lat, rawLng: stale ? NaN : f.lng, rawAt: stale ? 0 : f.at,
      accLast: stale ? null : acc,
      src: useCourse ? "gps" : "hold", fixes: 1,
    };
  }

  // ── position weight ────────────────────────────────────────────────────────────────────
  let w = acc == null ? POSE_W_OK : acc <= 10 ? POSE_W_SHARP : acc <= 30 ? POSE_W_OK : POSE_W_VAGUE;
  const dtFix = (f.at - st.fixAt) / 1000;
  const budgetMs = Math.max(spd, st.spd) * 1.5 + POSE_JUMP_SLACK_MS;
  // Innovation: how far this fix lands from where the ESTIMATE says the car is (dead reckoning
  // has already moved it). A stale or outlier fix shows up here as an impossible implied speed.
  const jumpM = haversineM(curLatFor(st), curLngFor(st), f.lat, f.lng);
  const estImpliedMs = dtFix > 0 ? jumpM / dtFix : Infinity;
  const estImplausible = dtFix > 0 && dtFix <= 3 && estImpliedMs > budgetMs && jumpM > 12;
  // ...but compare the fix against the PREVIOUS RAW FIX too. If fix-to-fix motion is plausible
  // while the estimate is the one out of budget, the ESTIMATE is behind (it trusted an earlier
  // outlier) and must CATCH UP — otherwise every later fix looks like a jump and the drawn car is
  // locked out of ever re-joining the road (the gate found exactly this on Jeff's King Rd rows).
  const dtRaw = Number.isFinite(st.rawLat) ? (f.at - st.rawAt) / 1000 : 0;
  const rawM = Number.isFinite(st.rawLat) ? haversineM(st.rawLat, st.rawLng, f.lat, f.lng) : 0;
  const rawImplausible = dtRaw > 0 && dtRaw <= 3 && rawM / dtRaw > budgetMs && rawM > 12;
  const jump = estImplausible && rawImplausible;
  const catchUp = estImplausible && !rawImplausible;
  if (jump) w = Math.min(w, POSE_W_JUMP);
  else if (catchUp) w = Math.max(w, POSE_W_SHARP);
  else if (jumpM < (acc ?? 10) * 0.8 + POSE_INNOV_SLACK_M) w *= 0.4;   // jitter, not motion
  if (spd < POSE_MOVING_MS && st.spd < POSE_MOVING_MS) w = Math.min(w, POSE_W_STILL);
  // The stale cap wins over everything above — a catch-up toward where the car WAS is not a catch-up.
  if (stale) w = Math.min(w, POSE_W_VAGUE * 0.5);
  // The correction is QUEUED and eased out by posePredict — the drawn car slides, it does not pop.
  // (Measured against the estimate INCLUDING what is still pending, so two fixes in a row do not
  // double-count the same residual.)
  const curLat = st.lat + st.pendLat, curLng = st.lng + st.pendLng;
  const pendLat = st.pendLat + (f.lat - curLat) * w;
  const pendLng = st.pendLng + (f.lng - curLng) * w;
  const lat = st.lat, lng = st.lng;

  // ── heading ────────────────────────────────────────────────────────────────────────────
  let hdg = st.hdg, yawBias = st.yawBias, yawSign = st.yawSign, yawAgree = st.yawAgree;
  let lastCourse = st.lastCourse, lastCourseAt = st.lastCourseAt, gpsTurnDps = st.gpsTurnDps;
  let errPrev = st.errPrev, errPrevAt = st.errPrevAt;
  let adopted = false;
  let yawCumAtCourse = st.yawCumAtCourse;
  if (course != null && !stale && (spd >= POSE_COURSE_MIN_MS || (!st.hdgKnown && spd >= POSE_MOVING_MS))) {
    adopted = true;
    const errCourse = wrap180(course - hdg);
    // Gyro yaw integrated since the LAST ADOPTED course — this estimator's own cursor.
    const yawIntegratedSinceLastFixDeg =
      typeof yawCumDeg === "number" && Number.isFinite(yawCumDeg) && st.yawCumAtCourse != null ? yawCumDeg - st.yawCumAtCourse : null;
    yawCumAtCourse = typeof yawCumDeg === "number" && Number.isFinite(yawCumDeg) ? yawCumDeg : null;
    // Learn the gyro's sign: when both the gyro and the course saw a real turn, do they agree?
    if (typeof yawIntegratedSinceLastFixDeg === "number" && Number.isFinite(yawIntegratedSinceLastFixDeg) && lastCourse != null) {
      const courseDelta = wrap180(course - lastCourse);
      if (Math.abs(courseDelta) >= POSE_SIGN_MIN_DEG && Math.abs(yawIntegratedSinceLastFixDeg) >= POSE_SIGN_MIN_DEG) {
        yawAgree += Math.sign(courseDelta) === Math.sign(yawIntegratedSinceLastFixDeg) ? 1 : -1;
        yawAgree = Math.max(-POSE_SIGN_EVIDENCE - 1, Math.min(POSE_SIGN_EVIDENCE + 1, yawAgree));
        if (yawAgree >= POSE_SIGN_EVIDENCE) yawSign = 1;
        else if (yawAgree <= -POSE_SIGN_EVIDENCE) yawSign = -1;
      }
    }
    const gyro = st.src === "gyro" && yawSign !== 0;
    const err = errCourse;
    // Bias: how fast the course error is DRIFTING while the gyro says "straight". The error
    // itself is not a bias (a lagging estimate would teach the gyro to spin — positive feedback).
    if (gyro && errPrev != null && Math.abs(errCourse) < POSE_BIAS_MAX_ERR_DEG && Math.abs(errPrev) < POSE_BIAS_MAX_ERR_DEG
        && f.at - errPrevAt > 500 && f.at - errPrevAt <= 3000
        && typeof yawIntegratedSinceLastFixDeg === "number" && Math.abs(yawIntegratedSinceLastFixDeg) / ((f.at - errPrevAt) / 1000) < POSE_BIAS_STRAIGHT_DPS) {
      const driftDps = wrap180(errCourse - errPrev) / ((f.at - errPrevAt) / 1000);   // +ve: heading falling behind the course
      // The gyro-integrated heading gained (yaw*sign - bias)*dt; the course says it should have
      // gained `driftDps` more per second, so the bias is over-subtracting by that much.
      const biasObs = yawBias - driftDps;
      yawBias = Math.max(-POSE_BIAS_MAX_DPS, Math.min(POSE_BIAS_MAX_DPS, yawBias + (biasObs - yawBias) * POSE_BIAS_K));
    }
    // THE NO-GYRO FIX NEVER JOLTS THE HEADING (refuters 2026-09-10): posePredict eases it toward this
    // course / the road every frame. Only a first heading (adoption) or a heading that is simply WRONG
    // (> POSE_HDG_SNAP_DEG off, with no road owning the nose — a stop, a U-turn off the line) snaps.
    const roadOwned = !gyro && st.roadHdg != null && st.roadK > 0 && st.tAt - st.roadAt <= POSE_ROAD_HOLD_MS;
    if (!st.hdgKnown) hdg = course;
    else if (gyro) hdg = Math.abs(err) > POSE_HDG_SNAP_DEG ? course : norm360(hdg + err * POSE_HDG_W_GYRO);
    else if (!roadOwned && Math.abs(err) > POSE_HDG_SNAP_DEG) hdg = course;
    errPrev = wrap180(course - hdg); errPrevAt = f.at;
    const dtCourse = lastCourse != null ? (f.at - lastCourseAt) / 1000 : 0;
    if (lastCourse != null && dtCourse > 0.25 && dtCourse <= 3) {
      gpsTurnDps = Math.max(-POSE_GPS_TURN_MAX_DPS, Math.min(POSE_GPS_TURN_MAX_DPS, wrap180(course - lastCourse) / dtCourse));
    } else if (dtCourse > 3) gpsTurnDps = 0;
    lastCourse = course; lastCourseAt = f.at;
  } else if (course == null || spd < POSE_COURSE_MIN_MS) {
    // No usable course: the heading holds and the inferred turn rate is no longer evidence.
    if (f.at - lastCourseAt > POSE_GPS_TURN_HOLD_MS) gpsTurnDps = 0;
  }
  const stepM = haversineM(curLat, curLng, curLat + (pendLat - st.pendLat), curLng + (pendLng - st.pendLng));
  return {
    ...st, lat, lng, hdg, spd, fixAt: f.at, drM: stale ? st.drM : 0, yawBias, yawSign, yawAgree,
    hdgKnown: st.hdgKnown || adopted,
    yawCumAtCourse,
    lastCourse, lastCourseAt, gpsTurnDps, errPrev, errPrevAt, pendLat, pendLng,
    rawLat: stale ? st.rawLat : f.lat, rawLng: stale ? st.rawLng : f.lng, rawAt: stale ? st.rawAt : f.at, fixes: st.fixes + 1,
    accLast: stale ? st.accLast : acc,
    rejected: st.rejected, maxStepM: Math.max(st.maxStepM, stepM),
  };
}

/**
 * Lateral pull toward the route projection. Weight is a CONTINUOUS function of the yaw rate
 * and the lateral distance — never a flip. `dtS` is the frame interval.
 */
export function poseRoute(st: PoseState, proj: PoseRoute, yawDpsAbs: number | null | undefined, dtS: number): PoseState {
  if (!st.hasFix) return st;
  let target = 0;
  let roadHdg: number | null = null, roadHdgAhead: number | null = null, roadK = 0;
  let released = false, roadHeld = 0, roadSetAt = st.roadSetAt;
  let suspect = false;
  const moved = !!proj && (proj.lat !== st.projLat || proj.lng !== st.projLng);
  if (proj && Number.isFinite(proj.distM) && proj.distM <= POSE_ROUTE_MAX_M) {
    const yaw = typeof yawDpsAbs === "number" && Number.isFinite(yawDpsAbs) ? Math.abs(yawDpsAbs) : Math.abs(st.gpsTurnDps);
    const yawK = Math.max(0, 1 - yaw / POSE_ROUTE_YAW_FREE_DPS);
    const distK = Math.max(0, 1 - proj.distM / POSE_ROUTE_MAX_M);
    // No `roadHdg` handed in = no road heading at all (the raw segment bearing is NEVER the nose —
    // the bisector failure in the header); the lateral pull alone, as before.
    const chord = typeof proj.roadHdg === "number" && Number.isFinite(proj.roadHdg) ? norm360(proj.roadHdg) : null;
    const chordAhead = typeof proj.roadHdgAhead === "number" && Number.isFinite(proj.roadHdgAhead) ? norm360(proj.roadHdgAhead) : chord;
    // THE NEWEST FIX'S course, qualified per the vendors (moving ≥ 3 m/s, a KNOWN accuracy < 20 m). A course
    // from an earlier fix is not evidence about this projection (refuter: a 2.5 s-old entry-leg course
    // released the road mid-corner exactly when iOS had dropped the course — the case the road is for).
    const courseNew = st.lastCourse != null && st.lastCourseAt === st.fixAt && st.tAt - st.lastCourseAt <= POSE_ROAD_HOLD_MS ? st.lastCourse : null;
    const courseQualified = courseNew != null && st.spd >= POSE_COURSE_MIN_MS && st.accLast != null && st.accLast < POSE_ROAD_RELEASE_ACC_M;
    const prevFresh = st.roadHdg != null && st.tAt - st.roadAt <= POSE_ROAD_HOLD_MS;
    suspect = st.roadSuspect;
    if (chord == null) {
      roadHdg = null; roadHdgAhead = null; suspect = false;
    } else if (!moved && (prevFresh || st.roadSuspect)) {
      // The SAME projection as last render: what was decided about it stands — an adopted road is held, a
      // held chord stays held, a refused one stays refused — until the projection moves or a qualified
      // course arrives with a fix (a fix that lands moves the projection). Never re-judged by elapsed time.
      roadHdg = st.roadHdg; roadHdgAhead = st.roadHdgAhead ?? st.roadHdg; roadHeld = st.roadHeld;
    } else {
      // ADOPT the new projection's chord? Only a step a car could have turned since the projection last
      // moved, or one a qualified course corroborates. Beyond that: hold one fix (a noisy fix flipped
      // legs at a vertex), and beyond POSE_ROAD_ADOPT_MAX_DEG refuse it (the wrong leg of a loop).
      const ref = prevFresh ? st.roadHdg! : (st.hdgKnown ? st.hdg : null);
      const stepDeg = ref == null ? 0 : Math.abs(wrap180(chord - ref));
      const dtMoved = st.projMovedAt > 0 ? Math.max(0.25, (st.tAt - st.projMovedAt) / 1000) : 1;
      const corroborated = courseQualified && Math.abs(wrap180(courseNew! - chord)) <= POSE_ROAD_RELEASE_DEG;
      if (corroborated) {
        roadHdg = chord; roadHdgAhead = chordAhead; roadHeld = 0; roadSetAt = st.tAt; suspect = false;
      } else if (stepDeg > POSE_ROAD_ADOPT_MAX_DEG) {
        // judged BEFORE the elapsed-turn allowance: time alone never admits the wrong leg of a loop
        roadHdg = null; roadHdgAhead = null; roadHeld = 0; suspect = true;
      } else if (stepDeg <= POSE_ROAD_ADOPT_DPS * dtMoved) {
        roadHdg = chord; roadHdgAhead = chordAhead; roadHeld = 0; roadSetAt = st.tAt; suspect = false;
      } else if (prevFresh && st.roadHeld < POSE_ROAD_HOLD_FIXES) {
        roadHdg = st.roadHdg; roadHdgAhead = st.roadHdgAhead ?? st.roadHdg; roadHeld = st.roadHeld + 1; suspect = true;
      } else {
        roadHdg = chord; roadHdgAhead = chordAhead; roadHeld = 0; roadSetAt = st.tAt; suspect = false;
      }
    }
    // THE VENDORS' RELEASE, with hysteresis, judged on the adopted road with the newest fix's course.
    released = st.roadReleased;
    if (roadHdg != null && courseQualified) {
      const diff = Math.abs(wrap180(courseNew! - roadHdg));
      released = st.roadReleased ? diff > POSE_ROAD_RESNAP_DEG : diff > POSE_ROAD_RELEASE_DEG;
    }
    if (!released && !suspect) target = POSE_ROUTE_W_MAX * yawK * distK;   // a suspect projection pulls nothing
    if (roadHdg != null && !released) roadK = distK;
  } else {
    suspect = false;
  }
  const dt = Math.max(0, Math.min(POSE_MAX_DT_S, dtS));
  const ease = 1 - Math.exp(-dt / POSE_ROUTE_TAU_S);
  const routeW = st.routeW + (target - st.routeW) * ease;
  const next: PoseState = {
    ...st, routeW, roadHdg, roadHdgAhead, roadK, roadReleased: !!proj && released, roadHeld, roadSuspect: !!proj && suspect,
    roadAt: roadHdg != null ? st.tAt : st.roadAt,
    roadSetAt,
    projLat: proj ? proj.lat : NaN, projLng: proj ? proj.lng : NaN,
    projMovedAt: moved ? st.tAt : st.projMovedAt,
  };
  if (!proj || routeW <= 0.001) return next;
  // LATERAL ONLY (Codex review 2026-09-09). The projection the surfaces hand in is of the RAW FIX,
  // and it is held between fixes; the estimate dead-reckons FORWARD between fixes. Pulling toward the
  // point itself dragged the car BACK along the road every frame (reproduced: 5.6–11.9 m of error on
  // a straight at 30 m/s with perfect 1 Hz fixes). Only the component perpendicular to the route's
  // tangent is a lane error; the along-route component is the estimate being ahead, and correct.
  const k = 1 - Math.exp(-dt * routeW * 4);
  const cos = Math.cos(toRad(st.lat));
  const ex = (proj.lng - st.lng) * cos * 111320, ey = (proj.lat - st.lat) * 111320;   // metres, est -> proj
  const tb = toRad(proj.bearing); const tx = Math.sin(tb), ty = Math.cos(tb);         // unit tangent
  const along = ex * tx + ey * ty;
  const px = ex - along * tx, py = ey - along * ty;                                    // perpendicular part
  const lat = st.lat + (py * k) / 111320;
  const lng = st.lng + (px * k) / (111320 * cos);
  return { ...next, lat, lng };
}

export function poseOut(st: PoseState): { lat: number; lng: number; hdg: number; src: PoseState["src"]; routeW: number; yawDps: number } | null {
  if (!st.hasFix || !Number.isFinite(st.lat) || !Number.isFinite(st.lng)) return null;
  return { lat: st.lat, lng: st.lng, hdg: norm360(st.hdg), src: st.src, routeW: st.routeW, yawDps: st.yawDpsLast };
}
