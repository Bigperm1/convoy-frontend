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
// The nose is the integrated heading. Never the polyline tangent.

export type PoseFix = {
  lat: number; lng: number;
  /** The fix's OWN timestamp (epoch ms), not the render clock. */
  at: number;
  accM?: number | null;
  speedMs?: number | null;
  /** GPS course, degrees true; null/undefined when the platform reports none. */
  courseDeg?: number | null;
};

/** The route-line projection of the RAW fix, when navigating and within reach. */
export type PoseRoute = { lat: number; lng: number; bearing: number; distM: number } | null;

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
  src: "gyro" | "gps" | "hold" | "none";
  fixes: number; rejected: number; maxStepM: number;
};

// ── constants (each one is a physical statement, not a tuned edge) ──────────────────────────
/** Below this the car is not moving: heading holds, position holds, GPS course is noise. */
export const POSE_MOVING_MS = 1.0;
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
    routeW: 0, errPrev: null, errPrevAt: 0, pendLat: 0, pendLng: 0, rawLat: NaN, rawLng: NaN, rawAt: 0, yawCumAtCourse: null, src: "none", fixes: 0, rejected: 0, maxStepM: 0,
  };
}

/**
 * Advance the estimate to `nowMs`. `yawDps` is the sensor yaw rate about gravity (any sign
 * convention — the sign is learned from the course), null when there is no sensor sample.
 */
export function posePredict(st: PoseState, nowMs: number, yawDps: number | null | undefined): PoseState {
  if (!st.hasFix) return { ...st, tAt: nowMs };
  const rawDt = st.tAt > 0 ? (nowMs - st.tAt) / 1000 : 0;
  if (!(rawDt > 0)) return { ...st, tAt: nowMs };
  const dt = Math.min(rawDt, POSE_MAX_DT_S);
  if (rawDt > POSE_MAX_DT_S) {
    // A gap: nothing was observed, so nothing is integrated. The next fix re-anchors.
    return { ...st, tAt: nowMs, src: "hold" };
  }
  // Speed is the estimator's ACCEPTED speed. It used to accept a caller-supplied speed, and both
  // surfaces handed in the store's latest raw speed — which poseFix would then refuse as stale a
  // moment later, too late: it had already been integrated (Codex 3rd pass).
  const spd = st.spd;
  let hdg = st.hdg;
  let src: PoseState["src"] = "hold";
  const gyroOk = typeof yawDps === "number" && Number.isFinite(yawDps) && st.yawSign !== 0;
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
    return { ...st, lat, lng, pendLat, pendLng, tAt: nowMs, src: "hold" };
  }
  if (spd >= POSE_MOVING_MS) {
    if (gyroOk) {
      hdg = norm360(hdg + (yawDps! * st.yawSign - st.yawBias) * dt);
      src = "gyro";
    } else if (st.lastCourse != null && nowMs - st.lastCourseAt <= POSE_GPS_TURN_HOLD_MS && st.gpsTurnDps !== 0) {
      hdg = norm360(hdg + st.gpsTurnDps * POSE_GPS_TURN_GAIN * dt);
      src = "gps";
    } else if (st.lastCourse != null) {
      src = "gps";
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
  return { ...st, lat, lng, hdg, tAt: nowMs, drM, pendLat, pendLng, src };
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

  if (!st.hasFix) {
    const useCourse = !stale && course != null && (spdF ?? 0) >= POSE_MOVING_MS;
    return {
      ...st, lat: f.lat, lng: f.lng, hdg: useCourse ? course! : st.hdg, spd: stale ? 0 : (spdF ?? 0),
      fixAt: f.at, tAt: st.tAt || f.at,
      hasFix: true, hdgKnown: useCourse, drM: 0,
      lastCourse: useCourse ? course : null, lastCourseAt: useCourse ? f.at : 0,
      yawCumAtCourse: useCourse && typeof yawCumDeg === "number" && Number.isFinite(yawCumDeg) ? yawCumDeg : null,
      rawLat: stale ? NaN : f.lat, rawLng: stale ? NaN : f.lng, rawAt: stale ? 0 : f.at,
      src: useCourse ? "gps" : "hold", fixes: 1,
    };
  }

  // ── position weight ────────────────────────────────────────────────────────────────────
  const acc = typeof f.accM === "number" && Number.isFinite(f.accM) && f.accM >= 0 ? f.accM : null;
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
    const err = wrap180(course - hdg);
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
    // Bias: how fast the course error is DRIFTING while the gyro says "straight". The error
    // itself is not a bias (a lagging estimate would teach the gyro to spin — positive feedback).
    if (gyro && errPrev != null && Math.abs(err) < POSE_BIAS_MAX_ERR_DEG && Math.abs(errPrev) < POSE_BIAS_MAX_ERR_DEG
        && f.at - errPrevAt > 500 && f.at - errPrevAt <= 3000
        && typeof yawIntegratedSinceLastFixDeg === "number" && Math.abs(yawIntegratedSinceLastFixDeg) / ((f.at - errPrevAt) / 1000) < POSE_BIAS_STRAIGHT_DPS) {
      const driftDps = wrap180(err - errPrev) / ((f.at - errPrevAt) / 1000);   // +ve: heading falling behind the course
      // The gyro-integrated heading gained (yaw*sign - bias)*dt; the course says it should have
      // gained `driftDps` more per second, so the bias is over-subtracting by that much.
      const biasObs = yawBias - driftDps;
      yawBias = Math.max(-POSE_BIAS_MAX_DPS, Math.min(POSE_BIAS_MAX_DPS, yawBias + (biasObs - yawBias) * POSE_BIAS_K));
    }
    if (!st.hdgKnown || Math.abs(err) > POSE_HDG_SNAP_DEG) hdg = course;   // no prior, or a wrong one
    else hdg = norm360(hdg + err * (gyro ? POSE_HDG_W_GYRO : POSE_HDG_W_GPS));
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
  if (proj && Number.isFinite(proj.distM) && proj.distM <= POSE_ROUTE_MAX_M) {
    const yaw = typeof yawDpsAbs === "number" && Number.isFinite(yawDpsAbs) ? Math.abs(yawDpsAbs) : Math.abs(st.gpsTurnDps);
    const yawK = Math.max(0, 1 - yaw / POSE_ROUTE_YAW_FREE_DPS);
    const distK = Math.max(0, 1 - proj.distM / POSE_ROUTE_MAX_M);
    target = POSE_ROUTE_W_MAX * yawK * distK;
  }
  const dt = Math.max(0, Math.min(POSE_MAX_DT_S, dtS));
  const ease = 1 - Math.exp(-dt / POSE_ROUTE_TAU_S);
  const routeW = st.routeW + (target - st.routeW) * ease;
  if (!proj || routeW <= 0.001) return { ...st, routeW };
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
  return { ...st, lat, lng, routeW };
}

export function poseOut(st: PoseState): { lat: number; lng: number; hdg: number; src: PoseState["src"]; routeW: number } | null {
  if (!st.hasFix || !Number.isFinite(st.lat) || !Number.isFinite(st.lng)) return null;
  return { lat: st.lat, lng: st.lng, hdg: norm360(st.hdg), src: st.src, routeW: st.routeW };
}
