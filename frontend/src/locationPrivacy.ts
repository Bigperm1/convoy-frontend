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

// Above walking pace. The point is that anything recorded at or above this is on a road
// by construction, head unit or not.
export const DRIVING_SPEED_MS = 2.5;
// Hysteresis so a red light does not flap live<->parked mid-drive.
export const DRIVING_HYSTERESIS_MS = 90_000;
const SPOT_SAVE_THROTTLE_MS = 15_000;

let _carConnected = false;
let _lastDrivingAt = 0;
let _carSpot: { lat: number; lng: number } | null = null;
let _spotSavedAt = 0;
let _hydrated = false;

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
  const driving = (speedMs ?? 0) >= DRIVING_SPEED_MS;
  const now = Date.now();
  if (driving) {
    _lastDrivingAt = now;
    // Persisted so a suspended-app CLVisit can still tell parked from driving.
    void AsyncStorage.setItem(LAST_DRIVING_KEY, String(now)).catch(() => {});
  }
  if (!_carConnected && !driving) return;
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
  const movingNow = (live?.speed ?? 0) >= DRIVING_SPEED_MS;
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
