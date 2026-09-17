// carSpotTrust — is a PERSISTED car spot worth believing on the next launch? (pure, 2026-09-06)
//
// Say Phin, 2026-09-06 19:21 (WhatsApp): "Compass button puts me here but I'm not there, I'm
// home." His rows: `draw-cmp mode=pin parked=1 hu=0 sep=1141m spotAge=25791s` — the phone
// drew (and shared) a car spot 1.1 km from where he and the car actually were. The spot had
// been written at 12:11:09, while he was still ROLLING at 7 km/h with Android Auto attached,
// and that was the last row of the drive: the process died mid-crawl, so no stop and no
// head-unit disconnect was ever seen. Seven hours later hydrate adopted the record because
// it was fresh (< 24 h) — nothing recorded that the drive's END had never been witnessed.
//
// The rules, decided here so a Node gate can replay them. They act at HYDRATE (the next
// launch), never on the write path: while the car is attached or driving the spot must keep
// FOLLOWING the car on every fix, exactly as before — OTA-AC (2026-09-06 20:1x) briefly
// gated the write path on speed instead, and Say Phin's spot then stayed at the meet while
// he drove 9.3 km home with Android Auto attached (`sep=9285m hu=1 spotAge=2804s`), and a
// phone-only driver could never record a spot at all (that path only writes while moving).
// Reverted the same night; the persisted record now carries the speed of its LAST write.
//  1. A spot is a STOP: a record whose last write happened at or above
//     SPOT_WRITE_MAX_SPEED_MS (`mv`) is motion the app never saw end — refused.
//  2. A record written while a head unit was attached (`att`) and never followed by a
//     witnessed disconnect (`hu`) is UNVERIFIED for the same reason — refused.
// "Absent beats exposed" (locationPrivacy's own rule): a refused spot leaves no pin, the
// driver's own marker follows the phone, and the crew sees nothing until the next drive —
// instead of a car parked kilometres from the truth for the rest of the day. Records written
// before these fields existed are adopted as before.

export type PersistedSpot = { lat: number; lng: number; t?: number; hu?: 0 | 1; att?: 0 | 1; mv?: number; hdg?: number };

export const SPOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Above this a fix is motion, not a parking place (5.4 km/h; Say Phin's frozen fix was 7). */
export const SPOT_WRITE_MAX_SPEED_MS = 1.5;
/** A driving stamp this much newer than the spot means the car left it (the stamp is saved at
 *  most every 15 s while driving, so a real departure is minutes newer, a pull-in is seconds older). */
export const DROVE_AFTER_GRACE_MS = 60_000;

export type SpotVerdict =
  | { adopt: true; why: "ok" }
  | { adopt: false; why: "malformed" | "stale" | "unwitnessed-attached" | "written-moving" | "drove-after" };

/**
 * May a persisted spot be adopted at hydrate? `lastDrivingAt` is the persisted driving stamp
 * (LAST_DRIVING_KEY): a car that was seen DRIVING more than a minute after the spot was written
 * provably left it — Say Phin 22:31, OTA-AD: a witnessed park at the meet (hu=1, mv=0) survived
 * a 9.3 km drive home because nothing rewrote it, and he was "showing near SunTea still".
 */
export function spotAdoptVerdict(p: unknown, now: number, lastDrivingAt: number = 0): SpotVerdict {
  const r = p as Partial<PersistedSpot> | null;
  if (!r || typeof r.lat !== "number" || typeof r.lng !== "number" || !isFinite(r.lat) || !isFinite(r.lng)) {
    return { adopt: false, why: "malformed" };
  }
  const at = typeof r.t === "number" && isFinite(r.t) ? r.t : 0;
  if (!(at > 0 && now - at <= SPOT_MAX_AGE_MS)) return { adopt: false, why: "stale" };
  if (typeof r.mv === "number" && isFinite(r.mv) && r.mv >= SPOT_WRITE_MAX_SPEED_MS) return { adopt: false, why: "written-moving" };
  if (r.att === 1 && r.hu !== 1) return { adopt: false, why: "unwitnessed-attached" };
  if (Number.isFinite(lastDrivingAt) && lastDrivingAt - at > DROVE_AFTER_GRACE_MS) return { adopt: false, why: "drove-after" };
  return { adopt: true, why: "ok" };
}

/** THE PARKED HEADING (2026-09-16, Jeff: "is there a way for the app to know what direction my parked car is facing
 *  and start the route in the direction I'm facing?"). The spot record carries `hdg`: the GPS course of the last
 *  fix that was still MOVING before the car stopped — immune to how the phone sits in its mount and to the car's
 *  own magnetism, and it survives overnight, which neither the 90 s course memory nor the compass does. It is wrong
 *  in exactly one case: a car REVERSED into its spot faces the other way, and that costs one early reroute, the
 *  same price today's U-turn start pays. It applies only while the car is still AT the spot: a route started more
 *  than SPOT_FACING_MAX_M from it (a parkade exit, a fix that never reached the lot) gets nothing from here and
 *  falls through to the course / compass, exactly as before. Gate: car_spot_trust_test.mts F1–F6. */
export const SPOT_FACING_MAX_M = 25;
/** A parked heading belongs to the place it was OBSERVED (the last moving fix before the stop). A spot written
 *  further than this from that observation gets no heading — a car that moved while the app was away, or was
 *  re-parked elsewhere with no moving course seen — instead of inheriting an old park's facing with a fresh 24 h
 *  life (Codex 2026-09-16). 60 m: a stop lands within a car length or two of its last moving fix. */
export const SPOT_HDG_MAX_DIST_M = 60;
/** Metres the car may CREEP (below SPOT_WRITE_MAX_SPEED_MS, above SPOT_CREEP_MIN_MS) after the heading was observed
 *  before the heading is no longer believed (Codex 2026-09-16: a three-point turn whose final leg stayed under
 *  1.5 m/s kept the approach heading — the car ended facing the other way). A normal stop creeps a car length or
 *  two past its last moving fix; a slow turn or a lot crawl covers more, and its direction is unknown. */
export const SPOT_HDG_CREEP_MAX_M = 8;
/** Below this a fix is stationary jitter, not creeping — its displacement is not counted. */
export const SPOT_CREEP_MIN_MS = 0.4;
export type SpotHeadingObs = { deg: number; at: number; lat: number; lng: number };
/** The parked-heading TRACKER, a pure reducer so a Node gate can run the production sequence (Codex round 3: the
 *  creep rule lived past the car-trust gate, which a phone-only driver's slow fixes never reach). Runs on EVERY
 *  fix, before that gate: only a fix that may write a spot may CREATE an observation (`mayWriteSpot`), but any fix
 *  may retire one by creeping. `frozen` is set by the first at-rest fix after the observation — the car has stopped,
 *  and whatever moves at walking pace after that is the PHONE leaving the car, which must not retire the facing. */
export type HeadingTrack = { obs: SpotHeadingObs | null; creepM: number; from: { lat: number; lng: number } | null; frozen: boolean };
export const HEADING_TRACK_EMPTY: HeadingTrack = { obs: null, creepM: 0, from: null, frozen: false };
export function headingTrackStep(
  t: HeadingTrack,
  fix: { lat: number; lng: number; spd: number; course: number | null | undefined; at: number },
  mayWriteSpot: boolean,
): HeadingTrack {
  const courseOk = typeof fix.course === "number" && isFinite(fix.course) && fix.course >= 0 && fix.course <= 360;
  const here = { lat: fix.lat, lng: fix.lng };
  if (mayWriteSpot && fix.spd >= SPOT_WRITE_MAX_SPEED_MS && courseOk) {
    return { obs: { deg: fix.course as number, at: fix.at, lat: fix.lat, lng: fix.lng }, creepM: 0, from: here, frozen: false };
  }
  if (!t.obs || t.frozen) return { ...t, from: here };
  if (fix.spd < SPOT_CREEP_MIN_MS) return { ...t, from: here, frozen: true };              // came to rest: the facing is decided
  if (fix.spd < SPOT_WRITE_MAX_SPEED_MS && t.from) {                                       // creeping: a slow turn, a lot crawl
    const creepM = t.creepM + spotDistanceM(t.from, here);
    return creepM > SPOT_HDG_CREEP_MAX_M ? { obs: null, creepM: 0, from: here, frozen: false } : { ...t, creepM, from: here };
  }
  return { ...t, from: here };   // a moving fix without a course: nothing to learn, nothing to retire
}
export function spotHeadingFor(obs: SpotHeadingObs | null | undefined, pos: { lat: number; lng: number }, creepM = 0): number | null {
  if (!obs || typeof obs.deg !== "number" || !isFinite(obs.deg) || obs.deg < 0 || obs.deg > 360) return null;
  if (spotDistanceM(obs, pos) > SPOT_HDG_MAX_DIST_M) return null;
  if (creepM > SPOT_HDG_CREEP_MAX_M) return null;
  return obs.deg % 360;
}
export function spotFacing(
  spot: { lat: number; lng: number; hdg?: number; t?: number } | null | undefined,
  near: { lat: number; lng: number } | null | undefined,
  now: number,
): number | null {
  if (!spot || !near) return null;
  const h = spot.hdg;
  if (typeof h !== "number" || !isFinite(h) || h < 0 || h > 360) return null;
  const at = typeof spot.t === "number" && isFinite(spot.t) ? spot.t : 0;
  if (at > 0 && now - at > SPOT_MAX_AGE_MS) return null;
  if (spotDistanceM(spot, near) > SPOT_FACING_MAX_M) return null;
  return h % 360;
}
export function spotDistanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, s)));
}

/** Was a fix at this speed a STOP? (m/s; unknown speed counts as stopped). Used for the
 *  persisted `mv` field's verdict above — NOT as a write gate (see the header). */
export function fixMayBecomeSpot(speedMs: number | undefined | null): boolean {
  const s = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
  return s < SPOT_WRITE_MAX_SPEED_MS;
}
