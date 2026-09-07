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
// Two rules, both decided here so a Node gate can replay them:
//  1. A spot is a STOP. locationPrivacy only writes one from a fix below
//     SPOT_WRITE_MAX_SPEED_MS; a fix that merely happened to be slow (7 km/h in traffic) is
//     never the car's parking place.
//  2. A spot written while a head unit was attached (`att`) and never followed by a witnessed
//     disconnect (`hu`) is UNVERIFIED: the app died with the car still moving and cannot know
//     where the car ended up. "Absent beats exposed" (locationPrivacy's own rule): the pin is
//     dropped, the driver's own marker follows the phone, and the crew sees nothing until the
//     next drive — instead of a car parked 1.1 km from the truth for the rest of the day.
// Records written before this change carry neither field and are adopted as before.

export type PersistedSpot = { lat: number; lng: number; t?: number; hu?: 0 | 1; att?: 0 | 1; mv?: number };

export const SPOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Above this a fix is motion, not a parking place (5.4 km/h; Say Phin's frozen fix was 7). */
export const SPOT_WRITE_MAX_SPEED_MS = 1.5;

export type SpotVerdict =
  | { adopt: true; why: "ok" }
  | { adopt: false; why: "malformed" | "stale" | "unwitnessed-attached" };

/** May a persisted spot be adopted at hydrate? */
export function spotAdoptVerdict(p: unknown, now: number): SpotVerdict {
  const r = p as Partial<PersistedSpot> | null;
  if (!r || typeof r.lat !== "number" || typeof r.lng !== "number" || !isFinite(r.lat) || !isFinite(r.lng)) {
    return { adopt: false, why: "malformed" };
  }
  const at = typeof r.t === "number" && isFinite(r.t) ? r.t : 0;
  if (!(at > 0 && now - at <= SPOT_MAX_AGE_MS)) return { adopt: false, why: "stale" };
  if (r.att === 1 && r.hu !== 1) return { adopt: false, why: "unwitnessed-attached" };
  return { adopt: true, why: "ok" };
}

/** May THIS fix become the car spot? (speed in m/s; unknown speed counts as stopped). */
export function fixMayBecomeSpot(speedMs: number | undefined | null): boolean {
  const s = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
  return s < SPOT_WRITE_MAX_SPEED_MS;
}
