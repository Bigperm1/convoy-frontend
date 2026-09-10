// yawFeed — the pure reducer behind src/yawRate.ts: turns DeviceMotion samples into a cumulative
// yaw about the vertical, clocked by the SENSOR's own timestamps. Node-gated by
// tools/sim-qc/yaw_feed_test.mts; src/yawRate.ts only owns the subscription and the receipts.
//
// ── WHY THE SENSOR CLOCK (Codex, 2026-09-10) ─────────────────────────────────────────────
// The first adapter stamped every callback with Date.now(). Android's DeviceMotion re-dispatches
// its CACHED rotation event on every accelerometer tick (DeviceMotionModule.kt: one map packed
// from the last event of each type), so a frozen rotation sensor kept looking fresh, and bunched
// callback delivery compressed real sample intervals so legal deltas failed the plausibility
// clamp. Both platforms put the sample's own timestamp (seconds, monotonic since boot) in the
// block — iOS `data.timestamp` on rotation/rotationRate, Android `event.timestamp / 1e9` — so:
//   • a sample whose timestamp did not advance is NOT a new sample: no delta, no freshness;
//   • intervals for the mean rate come from the sensor clock, not from when JS was called;
//   • freshness is the WALL time of the last sample that actually advanced.
//
// ── TWO SOURCES, ONE SIGN, ONE CLOCK, NO LOST OR DOUBLED ANGLE ──────────────────────────
// Attitude (fused, preferred): iOS CMAttitude.yaw and Android −azimuth both grow COUNTER-clockwise
// seen from above. Rate fallback: ω·ĝ with ĝ pointing DOWN on both platforms (CoreMotion gravity
// is (0,0,−1) face-up; expo Android publishes raw − 2·gravity = (0,0,−9.8) face-up), so a
// counter-clockwise turn reads NEGATIVE there. The fallback is negated so a drive that switches
// source keeps one convention. HYPOTHESIS on the CoreMotion sign relation (derived from the
// documented frames, not measured): the estimator learns the sign per drive from the GPS course
// under THIS convention (persisted key v2 — the v1 sign was learned under the old rate·ĝ
// convention and is invalid here, Codex 4th pass), so a mistake costs a re-learn on a source
// switch, never a wrong direction from the start.
//
// OWNERSHIP. `sensorS` is the integrated-through time and only ever moves forward; every
// integration covers exactly (sensorS, t]. The attitude owns the integral while it advances.
// The GYRO takes ownership when there is no attitude, when the attitude stalls (no advance for
// YAW_ATT_STALL_S while the gyro advances — the uncovered span is reconciled ONCE from the gyro
// samples remembered while the attitude was fresh), or when the mount is near upright (the
// Euler-yaw gimbal singularity, YAW_LOCK_DEG with hysteresis). While the gyro owns, EVERY fresh
// gyro sample integrates (sensorS, t] and attitude samples only move the cursor. The attitude
// takes ownership back at an attitude sample whose cursor the gyro has already reached
// (attS ≤ sensorS): the part of its delta the gyro already covered is scaled out (uniform-rate
// assumption over ≤ one attitude interval — exact when both sources share a timestamp, as on iOS;
// bounded to one sample's rate change otherwise), and the rest is integrated. An attitude sample
// whose cursor is still AHEAD of the gyro re-seeds and waits (Codex 5th–7th passes: no interval
// is skipped and none is integrated twice). If the gyro itself dies while owning, the attitude
// takes over with the same scaled rule.
import { yawAboutGravity, attitudeDeltaDeg, type MotionPlatform } from "./yawMath.ts";

export type YawSample = {
  rotation?: { alpha?: number; beta?: number; gamma?: number; timestamp?: number } | null;
  rotationRate?: { alpha?: number; beta?: number; gamma?: number; timestamp?: number } | null;
  accelerationIncludingGravity?: { x?: number; y?: number; z?: number } | null;
  gravity?: { x?: number; y?: number; z?: number } | null;
};

export type YawFeedState = {
  cumDeg: number;                 // cumulative yaw about the vertical (counter-clockwise positive)
  sensorS: number | null;         // sensor clock (s) the integral is complete THROUGH — monotonic
  advancedAtMs: number;           // wall clock (ms) of the last sample that advanced the integral — freshness
  attS: number | null;            // sensor clock of the attitude cursor
  attPrevRad: number | null;      // the attitude cursor (null after a stall until the attitude re-seeds)
  rateS: number | null;           // sensor clock of the last advancing rotationRate sample
  rateHist: Array<[number, number]>;   // (sensor s, ccw dps) since attS while the attitude owns
  attHist: Array<[number, number]>;    // (sensor s, rad) recent attitude samples while the GYRO owns — the takeover cursor pool
  skipUntilS: number | null;           // after a takeover from a sample slightly BEHIND the integral: the gyro covered (attS, skipUntilS]
  src: "att" | "rate" | null;
  ring: Array<[number, number]>;  // (sensor ms, cum) over the last RATE_WINDOW_MS
  samples: number;
  lastDps: number | null;         // rate of the last advancing sample (receipts)
  rateCumDeg: number;             // gyro-ONLY shadow integral (ccw), always advanced: (cumDeg − rateCumDeg) is the
                                  // fused feed's magnetic/fusion correction — the receipt that settles the slew HYPOTHESIS
  pitchRad: number | null;        // last attitude pitch (rotation.beta) — mount angle, gimbal-lock guard
  rollRad: number | null;
  locked: boolean;                // attitude ignored because the mount is within YAW_LOCK_DEG of vertical
};

export const YAW_STALE_MS = 500;
export const YAW_RATE_WINDOW_MS = 400;
/** Attitude not advancing for this long while the gyro does ⇒ the rotation sensor stalled: use the gyro. */
export const YAW_ATT_STALL_S = 0.25;
/** |pitch| beyond this the Euler yaw is at its gimbal singularity (phone standing upright): use the gyro. */
export const YAW_LOCK_DEG = 80;
/** …and the guard releases only below this (hysteresis: a mount at 80° must not flip sources every sample). */
export const YAW_UNLOCK_DEG = 75;
const MIN_DT_S = 0.005;
const MAX_DT_S = 0.25;
const HIST_MAX_S = 1.0;
/** The attitude may take over while ahead of the gyro by at most this (one sensor period plus slack): the
 *  uncovered tail is scaled from its delta (uniform rate over ≤ 0.1 s); any further ahead, it waits. */
const TAKEOVER_AHEAD_S = 0.1;
/** …and a NON-zero tail may only be scaled from a FRESH cursor (span ≤ this): a stale cursor's delta says
 *  nothing about the rate in the tail (Codex 9th pass: a 0.875 s span put 1.9° into a stationary tail). */
const TAKEOVER_SPAN_MAX_S = 0.2;
/** The attitude may also take over from a sample slightly BEHIND the integral (the gyro integrated first
 *  — Codex 12th pass: a fixed −25 ms offset starved it forever); the overlap (attS, through] the gyro
 *  already covered is scaled out of the NEXT attitude delta. */
const TAKEOVER_BEHIND_S = 0.05;

export function yawFeedStart(): YawFeedState {
  return { cumDeg: 0, sensorS: null, advancedAtMs: 0, attS: null, attPrevRad: null, rateS: null, rateHist: [], attHist: [], skipUntilS: null, src: null, ring: [], samples: 0, lastDps: null, rateCumDeg: 0, pitchRad: null, rollRad: null, locked: false };
}

const clampDt = (dtS: number) => Math.max(MIN_DT_S, Math.min(MAX_DT_S, dtS));

function finish(st: YawFeedState, patch: Partial<YawFeedState>, throughS: number, cumDeg: number, nowMs: number): YawFeedState {
  const sensorMs = throughS * 1000;
  const ring = st.ring.concat([[sensorMs, cumDeg]]);
  while (ring.length > 1 && sensorMs - ring[0][0] > YAW_RATE_WINDOW_MS) ring.shift();
  return { ...st, ...patch, cumDeg, sensorS: throughS, advancedAtMs: nowMs, ring, samples: st.samples + 1 };
}

/** Integrate a (sensor s, ccw dps) history over (fromS, toS]: each sample's rate owns the interval ending at it. */
function integrateHist(hist: Array<[number, number]>, fromS: number, toS: number): number {
  let deg = 0, prevT = fromS;
  for (const [t, r] of hist) {
    if (t <= fromS) continue;
    const tt = Math.min(t, toS);
    if (tt > prevT) deg += r * clampDt(tt - prevT);
    prevT = tt;
    if (t >= toS) break;
  }
  return deg;
}

/** Fold one DeviceMotion sample. Returns the same state object when the sample is not new. */
export function yawFeedStep(st: YawFeedState, m: YawSample | null | undefined, platform: MotionPlatform, nowMs: number): YawFeedState {
  if (!m) return st;
  const att = Number(m.rotation?.alpha);
  const attTsRaw = Number(m.rotation?.timestamp);
  const rateTsRaw = Number(m.rotationRate?.timestamp);
  const pitch = Number(m.rotation?.beta), roll = Number(m.rotation?.gamma);
  const pitchRad = Number.isFinite(pitch) ? pitch : st.pitchRad;
  const rollRad = Number.isFinite(roll) ? roll : st.rollRad;
  // GIMBAL GUARD (with hysteresis): Euler yaw is singular with the phone's y axis vertical (an
  // upright cradle) — there a rock of the mount reads as a swing of yaw.
  const pitchDeg = pitchRad == null ? null : Math.abs(pitchRad) * 180 / Math.PI;
  const locked = pitchDeg == null ? st.locked : (st.locked ? pitchDeg > YAW_UNLOCK_DEG : pitchDeg > YAW_LOCK_DEG);
  const hasAtt = Number.isFinite(att) && !locked;
  // A source's sample is new only when its OWN timestamp advanced. No timestamp at all (unknown
  // platform): the wall clock stands in, honestly.
  const attTs = hasAtt ? (Number.isFinite(attTsRaw) ? attTsRaw : nowMs / 1000) : null;
  const attNew = attTs != null && (st.attS == null || attTs > st.attS);
  const rateTs = m.rotationRate ? (Number.isFinite(rateTsRaw) ? rateTsRaw : nowMs / 1000) : null;
  const rateNew = rateTs != null && (st.rateS == null || rateTs > st.rateS);
  let ccw: number | null = null;
  let rateCumDeg = st.rateCumDeg;
  if (rateNew) {
    const yaw = yawAboutGravity(m.rotationRate as any, (m.accelerationIncludingGravity ?? m.gravity) as any, platform);
    if (yaw != null) {
      ccw = -yaw;                                                    // see "TWO SOURCES, ONE SIGN"
      if (st.rateS != null) rateCumDeg += ccw * clampDt(rateTs! - st.rateS);   // the shadow integral, always
    }
  }
  const meta = { pitchRad, rollRad, locked, rateCumDeg };
  let cur: YawFeedState = { ...st, ...meta };
  let advanced = false;

  // ── 1. The gyro, when it owns or must take over ───────────────────────────────────────────
  if (rateNew && ccw != null) {
    const through = cur.sensorS ?? -Infinity;
    const attStalled = cur.attS != null && !attNew && rateTs! - cur.attS > YAW_ATT_STALL_S;
    if (cur.src === "rate" || !hasAtt || attStalled) {
      let cumDeg = cur.cumDeg;
      if (rateTs! > through) {
        if (cur.src === "rate") {
          cumDeg += ccw * clampDt(rateTs! - through);
        } else if (cur.sensorS != null) {
          // The SWITCH: reconcile everything the gyro saw since the integral was last complete,
          // exactly once, from the remembered history (Codex 4th pass: no lost angle).
          cumDeg += integrateHist(cur.rateHist.concat([[rateTs!, ccw]]), through, rateTs!);
        }
      }
      // The attitude cursor is void after a switch: the span it would claim is now the gyro's.
      const keep = cur.src === "rate";
      cur = finish(cur, { rateS: rateTs!, attPrevRad: keep ? cur.attPrevRad : null, attS: keep ? cur.attS : null, rateHist: [], attHist: keep ? cur.attHist : [], src: "rate", lastDps: ccw }, Math.max(rateTs!, through), cumDeg, nowMs);
      advanced = true;
    } else {
      // Attitude owns and is fresh: remember the gyro sample for a possible switch.
      cur = { ...cur, rateS: rateTs!, rateHist: cur.rateHist.concat([[rateTs!, ccw]]).filter(([t]) => rateTs! - t <= HIST_MAX_S) };
    }
  }

  // ── 2. The attitude ───────────────────────────────────────────────────────────────────────
  if (attNew) {
    const through = cur.sensorS ?? -Infinity;
    if (cur.src !== "rate") {
      // The attitude owns (or nothing does yet): integrate its delta from the cursor.
      let cumDeg = cur.cumDeg, lastDps: number | null = null;
      if (cur.attPrevRad != null && cur.attS != null) {
        const d = attitudeDeltaDeg(cur.attPrevRad, att);
        const span = attTs! - cur.attS;
        // A takeover from behind left (attS, skipUntilS] already covered by the gyro: scale it out
        // (uniform rate over ≤ one period).
        const skip = cur.skipUntilS != null && cur.skipUntilS > cur.attS ? Math.min(cur.skipUntilS, attTs!) : cur.attS;
        const frac = span > 0 ? Math.max(0, Math.min(1, (attTs! - skip) / span)) : 1;
        if (d != null) { cumDeg += d * frac; lastDps = d / clampDt(span); }
      }
      // Keep every remembered gyro sample that lies AFTER this attitude's time: a late attitude
      // (stamped behind gyro samples already buffered) must not erase the history a later stall
      // reconciliation needs (Codex 11th pass: 2.25° lost).
      const newThrough = Math.max(attTs!, through);
      let rateHist = cur.rateHist.filter(([t]) => t > attTs! + 1e-9);
      if (ccw != null && !rateHist.some(([t]) => t === rateTs!)) rateHist = rateHist.concat([[rateTs!, ccw]]);
      return finish(cur, { attS: attTs!, attPrevRad: att, rateHist, attHist: [], skipUntilS: null, src: "att", lastDps }, newThrough, cumDeg, nowMs);
    }
    // The gyro owns. Recent attitude samples are kept as a CURSOR POOL (Codex 8th pass: with the
    // attitude a fixed 75 ms ahead of the gyro, a single cursor was forever 25 ms ahead of the
    // integral and the attitude could never take back ownership). On takeover the uncovered span
    // (through, attTs] is built from what the attitude itself MEASURED: full deltas between
    // consecutive pooled samples that lie after `through`, plus the first partial piece
    // (through, p0] scaled from the latest cursor at or before `through` — only when that cursor is
    // FRESH (span ≤ TAKEOVER_SPAN_MAX_S; Codex 9th/10th passes: a stale delta says nothing about the
    // rate in the tail, so with a stale cursor that piece is skipped, losing at most one sample).
    const EPS = 1e-6;
    const attHist = cur.attHist.concat([[attTs!, att]]).filter(([t]) => attTs! - t <= HIST_MAX_S);
    const gyroDead = cur.rateS == null || attTs! - cur.rateS > YAW_ATT_STALL_S;
    let cursor: [number, number] | null = null;
    for (let i = attHist.length - 2; i >= 0; i--) { if (attHist[i][0] <= through + EPS) { cursor = attHist[i]; break; } }
    const after = attHist.filter(([t]) => t > through + EPS);           // pooled samples in the uncovered span, incl. this one
    // This sample AT the integrated-through time (iOS: both streams share data.timestamp, the gyro
    // just integrated to it) — or within one period BEHIND it (Codex 12th pass: independent clocks
    // with the gyro slightly ahead) — is a zero-length piece: the clean handoff. The overlap the
    // gyro already covered, (attTs, through], is scaled out of the NEXT attitude delta.
    if (after.length === 0 && attTs! >= through - TAKEOVER_BEHIND_S - EPS) {
      return finish(cur, { attS: attTs!, attPrevRad: att, rateHist: [], attHist: [], skipUntilS: attTs! < through - EPS ? through : null, src: "att", lastDps: cur.lastDps }, through, cur.cumDeg, nowMs);
    }
    const p0 = after[0];
    const firstPiece = p0 ? Math.max(0, p0[0] - through) : 0;             // (through, p0] — the only assumption-bearing piece
    // Take over when the uncovered first piece is nothing, or short AND scalable from a fresh cursor;
    // with a stale cursor and a live gyro, WAIT — the gyro will cover the piece within a period. With
    // a dead gyro take over regardless (the piece is skipped if unscalable: ≤ one sample lost).
    const spanFresh = cursor != null && p0 != null && p0[0] - cursor[0] <= TAKEOVER_SPAN_MAX_S + EPS;
    const pieceOk = firstPiece <= EPS || (firstPiece <= TAKEOVER_AHEAD_S + EPS && spanFresh);
    const canTakeOver = p0 != null && (gyroDead || (cursor != null && pieceOk));
    if (canTakeOver) {
      let cumDeg = cur.cumDeg, lastDps: number | null = null;
      if (cursor != null && firstPiece > EPS) {
        const span = p0[0] - cursor[0];
        if (span <= TAKEOVER_SPAN_MAX_S + EPS) {                            // fresh cursor: scale the partial piece
          const d = attitudeDeltaDeg(cursor[1], p0[1]);
          if (d != null && span > 0) cumDeg += d * Math.min(1, firstPiece / span);
        }                                                                    // stale cursor: skip the piece (≤ one sample)
      }
      for (let i = 1; i < after.length; i++) {                             // measured deltas inside the span
        const d = attitudeDeltaDeg(after[i - 1][1], after[i][1]);
        if (d != null) { cumDeg += d; lastDps = d / clampDt(after[i][0] - after[i - 1][0]); }
      }
      if (lastDps == null && cursor != null) { const d = attitudeDeltaDeg(cursor[1], att); if (d != null) lastDps = d / clampDt(attTs! - cursor[0]); }
      return finish(cur, { attS: attTs!, attPrevRad: att, rateHist: [], attHist: [], skipUntilS: null, src: "att", lastDps }, Math.max(attTs!, through), cumDeg, nowMs);
    }
    // Not yet: pool this sample and wait (never advance over an unfilled interval).
    return { ...cur, attS: attTs!, attPrevRad: att, attHist };
  }
  if (advanced) return cur;
  return cur.rateS !== st.rateS || cur.rateHist !== st.rateHist || locked !== st.locked || pitchRad !== st.pitchRad ? cur : st;
}

/** The timestamped cumulative yaw, or null when nothing fresh has arrived in YAW_STALE_MS. */
export function yawFeedIntegral(st: YawFeedState, nowMs: number): { cumDeg: number; atMs: number } | null {
  if (st.sensorS == null || nowMs - st.advancedAtMs > YAW_STALE_MS) return null;
  return { cumDeg: st.cumDeg, atMs: st.sensorS * 1000 };
}

/** Mean rate over the ring (deg/s, counter-clockwise positive), or null when stale / too short a window. */
export function yawFeedMeanDps(st: YawFeedState, nowMs: number): number | null {
  if (st.sensorS == null || nowMs - st.advancedAtMs > YAW_STALE_MS) return null;
  if (st.ring.length < 2) return st.lastDps;
  const [t0, c0] = st.ring[0]; const [t1, c1] = st.ring[st.ring.length - 1];
  if (t1 - t0 < 80) return st.lastDps;
  return (c1 - c0) / ((t1 - t0) / 1000);
}

/** The fused feed minus the gyro-only shadow: the fusion/magnetic correction accumulated so far (deg). */
export function yawFeedSourceDiffDeg(st: YawFeedState): number { return st.cumDeg - st.rateCumDeg; }
