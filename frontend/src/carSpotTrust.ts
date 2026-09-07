// carSpotTrust — is a PERSISTED car spot worth believing on the next launch? (pure, 2026-09-06)
//
// Say Phin, 2026-09-06 19:21 (WhatsApp): "Compass button puts me here but I'm not there, I'm
// home." Her rows: `draw-cmp mode=pin parked=1 hu=0 sep=1141m spotAge=25791s` — the phone
// drew (and shared) a car spot 1.1 km from where she and the car actually were. The spot had
// been written at 12:11:09, while she was still ROLLING at 7 km/h with Android Auto attached,
// and that was the last row of the drive: the process died mid-crawl, so no stop and no
// head-unit disconnect was ever seen. Seven hours later hydrate adopted the record because
// it was fresh (< 24 h) — nothing recorded that the drive's END had never been witnessed.
//
// The rules, decided here so a Node gate can replay them. They act at HYDRATE (the next
// launch), never on the write path: while the car is attached or driving the spot must keep
// FOLLOWING the car on every fix, exactly as before — OTA-AC (2026-09-06 20:1x) briefly
// gated the write path on speed instead, and Say Phin's spot then stayed at the meet while
// she drove 9.3 km home with Android Auto attached (`sep=9285m hu=1 spotAge=2804s`), and a
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

export type PersistedSpot = { lat: number; lng: number; t?: number; hu?: 0 | 1; att?: 0 | 1; mv?: number };

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
 * a 9.3 km drive home because nothing rewrote it, and she was "showing near SunTea still".
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

/** Was a fix at this speed a STOP? (m/s; unknown speed counts as stopped). Used for the
 *  persisted `mv` field's verdict above — NOT as a write gate (see the header). */
export function fixMayBecomeSpot(speedMs: number | undefined | null): boolean {
  const s = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
  return s < SPOT_WRITE_MAX_SPEED_MS;
}
