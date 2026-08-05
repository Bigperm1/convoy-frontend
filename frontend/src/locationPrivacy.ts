// locationPrivacy.ts — THE single decision point for "may this position leave the device,
// and which position is it?"
//
// ── WHY THIS FILE EXISTS (2026-07-31) ───────────────────────────────────────────
// Jeff, after disconnecting CarPlay and walking into a building: "it is supposed to stay
// on my car which is on the street a block away ... we need to take this privacy
// seriously." An audit of every outbound path found that the avatarMode contract was
// enforced in exactly ONE place — the Supabase presence payload built inline in
// app/(app)/map.tsx — while a completely separate pipeline published raw GPS:
//
//   map.tsx's foreground watcher  -> api.post("/location", {lat: pos.coords.latitude…})
//   src/visitMonitor.ts onVisit   -> api.post("/location", {lat: v.lat…})  (ghost-gated only)
//
// Neither consulted avatarMode's parked rule. The backend then writes those coordinates
// to the user document, fans them out over the WebSocket, and serves them from
// /users/nearby. So the "parked" pin was only ever a client-side RENDER preference laid
// over a server that already had the driver's real position.
//
// The user-facing promise (app/(app)/settings/privacy.tsx) is explicit:
//   "Full and Partial both keep you on the map at your car — live while you drive,
//    pinned at your car's spot when you disconnect, NEVER your real location away from
//    it. Ghost hides you completely."
// That promise is what this module enforces, for every transport, in one place.
//
// The rule that must never be re-litigated: when parked with no known car spot we share
// NOTHING. Absent beats exposed — that is the lesson of the 2026-07-20 house leak, where
// the parked branch fell back to live coordinates and drew a peer on their own home.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { getAvatarMode, getSettings, ensureSettingsLoaded } from "./settings";

// Same key map.tsx has always used, so an existing install keeps its car spot and there
// is no migration to get wrong.
const CAR_SPOT_KEY = "convoy.lastCarSpot.v1";
// Persisted so a COLD context (visitMonitor firing while the app was suspended, a
// background task) can tell "parked" from "driving" instead of guessing.
const LAST_DRIVING_KEY = "convoy.lastDrivingAt.v1";

// ── TWO SPEEDS, AND THEY DO DIFFERENT JOBS (2026-08-05) ────────────────────
// RECORD the car spot at anything above walking pace, so the pin lands where the car
// actually STOPPED rather than at the last point it was going fast. Low on purpose.
export const DRIVING_SPEED_MS = 2.5;          // ~9 km/h
// ENTERING the driving state needs a clearly VEHICULAR speed, and it LATCHES.
//
// Why not just use 9 km/h for both: that is jogging pace. A phone-only user out for a
// run would be treated as driving — broadcast live along their route, AND record a car
// spot on a footpath, putting a phantom car on a trail.
// Why not just use 30 km/h for both: then every 25 km/h residential street counts as
// parked, and the position lags through any stop-and-go below 9 km/h. Jeff asked whether
// a flat 30 would bring quirks. It would; this is the answer.
//
// So: cross the entry speed ONCE and you are driving; anything above 9 km/h keeps you
// there; 90 s with nothing above 9 km/h drops you out. A driver crosses it within seconds
// of pulling away and then city crawling holds the latch.
//
// 15 km/h (Jeff, 2026-08-05 — was 30). Lower arms the latch sooner, which helps the driver
// who never exceeds 30: a short hop entirely on 25 km/h residential streets, or shuffling
// around a car park. It clears ordinary jogging (8-12 km/h) with margin.
// ⚠ WHAT 15 NO LONGER COVERS, and 30 did: CYCLING is 15-25 km/h, and a fast runner reaches
// 15-18. Those now arm the latch, so a cyclist with the app open broadcasts live along
// their ride AND records a car spot on the bike path, which then persists as their parked
// car. If that ever shows up in the field, this constant is the dial — not the hold speed.
export const DRIVING_ENTER_SPEED_MS = 4.17;   // ~15 km/h
// Hysteresis so a red light does not flap live<->parked mid-drive.
export const DRIVING_HYSTERESIS_MS = 90_000;
const SPOT_SAVE_THROTTLE_MS = 15_000;
// The driving stamp gets the SAME throttle as the car spot. It shipped unthrottled on
// 2026-07-31 and that is a per-fix disk write — roughly 7,200 AsyncStorage writes on a
// two-hour drive, each a bridge hop plus a real write, for a value nothing reads more
// precisely than the 90 s hysteresis. Say Phin's battery screenshot the same day put
// Hairpin top of the list.
// Staleness is safe BY DIRECTION: the in-memory stamp is always exact, and only the
// PERSISTED copy lags. A lagging (older) stamp makes isParked() true SOONER, which shares
// the car spot instead of live — the private side.
const DRIVING_SAVE_THROTTLE_MS = 15_000;

let _carConnected = false;
let _lastDrivingAt = 0;
let _carSpot: { lat: number; lng: number } | null = null;
let _spotSavedAt = 0;
let _drivingSavedAt = 0;
let _hydrated = false;
let _drivingLatched = false;

/** Hydrate the persisted car spot + driving stamp. Idempotent; safe to call anywhere. */
export async function hydrateLocationPrivacy(): Promise<void> {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const [spotRaw, drivingRaw] = await Promise.all([
      AsyncStorage.getItem(CAR_SPOT_KEY),
      AsyncStorage.getItem(LAST_DRIVING_KEY),
    ]);
    // Never clobber a fresher in-memory value written while this was in flight.
    if (spotRaw && !_carSpot) {
      const p = JSON.parse(spotRaw);
      if (typeof p?.lat === "number" && typeof p?.lng === "number") _carSpot = { lat: p.lat, lng: p.lng };
    }
    const t = drivingRaw ? Number(drivingRaw) : 0;
    if (Number.isFinite(t) && t > _lastDrivingAt) _lastDrivingAt = t;
  } catch {}
}

/** Head unit attached/detached. Owned by map.tsx, which is the only thing that knows. */
export function noteCarConnected(connected: boolean): void {
  _carConnected = !!connected;
}

/**
 * Feed every GPS fix here. Records the CAR's position whenever we can prove the phone is
 * in a moving car — head unit connected, or plainly driving. That is what makes the
 * parked pin a point on the road rather than wherever the driver happens to be standing.
 */
export function noteFix(lat: number, lng: number, speedMs?: number): void {
  if (typeof lat !== "number" || typeof lng !== "number") return;
  const spd = speedMs ?? 0;
  const now = Date.now();
  // The latch: only a vehicular speed can ARM it; once armed, above-walking keeps it.
  if (spd >= DRIVING_ENTER_SPEED_MS) _drivingLatched = true;
  else if (_lastDrivingAt > 0 && now - _lastDrivingAt >= DRIVING_HYSTERESIS_MS) _drivingLatched = false;
  const aboveWalking = spd >= DRIVING_SPEED_MS;
  const driving = _drivingLatched && aboveWalking;
  if (driving) {
    _lastDrivingAt = now;
    // Persisted so a suspended-app CLVisit can still tell parked from driving — throttled,
    // see DRIVING_SAVE_THROTTLE_MS.
    if (now - _drivingSavedAt > DRIVING_SAVE_THROTTLE_MS) {
      _drivingSavedAt = now;
      void AsyncStorage.setItem(LAST_DRIVING_KEY, String(now)).catch(() => {});
    }
  }
  // RECORD on head-unit, or on above-walking WHILE LATCHED. Gating on the LATCH rather
  // than on the 30 km/h entry speed is what makes both cases work at once: a driver who
  // has crossed 30 keeps recording right down to a crawl, so the pin lands where the car
  // actually stopped — while a jogger, never latched, records nothing and so can never
  // leave a phantom car on a footpath. Simulation caught this: gating on `aboveWalking`
  // alone let the jogger poison the spot at 10 km/h, which is exactly what the latch was
  // introduced to prevent.
  // Cost, accepted: >90 s stationary in gridlock drops the latch, and the pin then stops
  // tracking until the car next clears 30 km/h. Bounded and self-correcting — unlike a
  // phantom car on a trail, which persists as your parked location afterwards.
  if (!_carConnected && !(driving)) return;
  _carSpot = { lat, lng };
  if (now - _spotSavedAt > SPOT_SAVE_THROTTLE_MS) {
    _spotSavedAt = now;
    void AsyncStorage.setItem(CAR_SPOT_KEY, JSON.stringify(_carSpot)).catch(() => {});
  }
}

export function carSpot(): { lat: number; lng: number } | null {
  return _carSpot;
}

/** Parked = not attached to a head unit and not driving recently. */
export function isParked(): boolean {
  return !_carConnected && Date.now() - _lastDrivingAt >= DRIVING_HYSTERESIS_MS;
}

export type ShareResult =
  | { share: false; reason: "ghost" | "no-car-spot" }
  | { share: true; status: "live" | "parked"; lat: number; lng: number; heading: number; speed: number };

/**
 * THE decision. Every outbound transport must route through this — presence, the REST
 * /location post, CLVisit arrivals, and anything added later.
 *
 * `live` is the phone's true position. It is returned ONLY while the driver is provably
 * with the car; otherwise the caller gets the car's own spot, or nothing at all.
 */
export function shareablePosition(
  live?: { lat: number; lng: number; heading?: number; speed?: number } | null,
): ShareResult {
  if (getAvatarMode(getSettings()) === "ghost") return { share: false, reason: "ghost" };

  // ── THE 90-SECOND HOLE, AND WHY POSITION AND STATUS SPLIT HERE ──────────────
  // The original rule used the SAME hysteresis for both: parked = not connected and
  // not driving within 90 s, and while not-parked it published live coordinates. So
  // for the first 90 seconds after switching the engine off, the walk from the car
  // into the building was published live. Simulation caught it; the tightened rule
  // below closes it with nothing lost.
  //
  // POSITION: live only while we can PROVE the phone is in the car — a head unit is
  // attached, or it is moving above walking pace right now. Otherwise the car's own
  // spot. This costs nothing at a red light, because noteFix updates the spot on every
  // moving fix, so the spot IS where the car is standing. It is the walk-away case,
  // and only that case, whose answer changes.
  //
  // STATUS keeps the 90 s hysteresis, because that flag only drives how peers DRAW you
  // (0.5 opacity when parked). Flapping the label at every red light is the cosmetic
  // churn the hysteresis was added for — and a label is not a location.
  // "Provably in the car": the latch plus current movement. A jogger fails the latch, so
  // walking-pace-and-above alone can no longer publish a live position.
  const movingNow = _drivingLatched && (live?.speed ?? 0) >= DRIVING_SPEED_MS;
  const inCar = _carConnected || movingNow;
  const status: "live" | "parked" = isParked() ? "parked" : "live";

  if (inCar && live && typeof live.lat === "number" && typeof live.lng === "number") {
    return { share: true, status, lat: live.lat, lng: live.lng, heading: live.heading ?? 0, speed: live.speed ?? 0 };
  }
  const spot = _carSpot;
  if (!spot) return { share: false, reason: "no-car-spot" };   // absent beats exposed
  return { share: true, status, lat: spot.lat, lng: spot.lng, heading: 0, speed: 0 };
}

/**
 * Async form for COLD callers (visitMonitor, background tasks). getSettings() reads a
 * module cache that starts at DEFAULT_SETTINGS — which is `partial`, NOT ghost — so a
 * context that has not loaded settings yet would treat a ghost user as sharing. Awaiting
 * the load first is what makes this fail closed. Also hydrates the car spot, without
 * which a cold parked decision could only ever return "no-car-spot".
 */
export async function shareablePositionAsync(
  live?: { lat: number; lng: number; heading?: number; speed?: number } | null,
): Promise<ShareResult> {
  try {
    await ensureSettingsLoaded();
    await hydrateLocationPrivacy();
  } catch {
    return { share: false, reason: "ghost" };   // can't prove consent -> don't share
  }
  return shareablePosition(live);
}
