// bearing.ts — geographic bearing calculation and marker heading inference.
//
// Why this exists: GPS-reported heading (`location.coords.heading`) is the
// device's instantaneous direction of motion. On real devices it's only
// populated reliably while MOVING. When stationary (red light, parking lot,
// 0 m/s reading), iOS / Android return 0 or -1, causing the on-map car
// silhouette to snap back to "facing north" — which looks broken to drivers.
//
// Fix strategy:
//   1. Track each peer's last known coordinate in a ref keyed by user_id.
//   2. On each position update, IF the GPS heading is missing/zero AND the
//      driver has moved more than a few meters, compute bearing from the
//      previous coord to the current using the spherical-law formula:
//        θ = atan2( sin(Δλ)·cos(φ₂), cos(φ₁)·sin(φ₂) − sin(φ₁)·cos(φ₂)·cos(Δλ) )
//   3. Cache the most recent computed bearing so even when the driver stops,
//      the car silhouette KEEPS pointing in the last direction of travel
//      instead of jumping to north.
//
// Created June 2025 for the "markers always face north" bug.

const MIN_MOVE_M = 3; // distance threshold before we accept a new bearing

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function computeBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  // Normalize to [0, 360)
  return ((θ * 180) / Math.PI + 360) % 360;
}

// Per-actor state. `bearing` is the most recent good direction we have for
// this user_id, surviving stationary periods.
type LastPos = { lat: number; lng: number; bearing: number };

export class BearingTracker {
  private map = new Map<string, LastPos>();

  /**
   * Resolve the effective heading for a marker.
   *   - If the device-reported `gpsHeading` is a positive finite number, use it
   *     (this is what we want when the driver is actually moving — most accurate).
   *   - Otherwise, if we have a previous position AND have moved >= MIN_MOVE_M
   *     since then, compute bearing from prev → curr.
   *   - Otherwise return the LAST cached bearing for this id (so a parked car
   *     keeps pointing the way it was last going, not north).
   *   - Final fallback: 0.
   */
  get(id: string, lat: number, lng: number, gpsHeading?: number | null): number {
    const prev = this.map.get(id);

    // Trust GPS heading when it's present + non-zero. Some platforms report
    // -1 when unavailable; reject that too.
    if (
      typeof gpsHeading === "number" &&
      Number.isFinite(gpsHeading) &&
      gpsHeading > 0
    ) {
      this.map.set(id, { lat, lng, bearing: gpsHeading });
      return gpsHeading;
    }

    if (prev) {
      const distM = haversineMeters(prev.lat, prev.lng, lat, lng);
      if (distM >= MIN_MOVE_M) {
        const bearing = computeBearing(prev.lat, prev.lng, lat, lng);
        this.map.set(id, { lat, lng, bearing });
        return bearing;
      }
      // Below the move threshold — keep the cached bearing alive, but
      // refresh the coord so the next call has a fresh "prev" anchor.
      this.map.set(id, { lat, lng, bearing: prev.bearing });
      return prev.bearing;
    }

    // First sighting of this id, no GPS heading either. Seed at 0 but DO
    // store the coord so subsequent updates can compute deltas.
    this.map.set(id, { lat, lng, bearing: 0 });
    return 0;
  }

  /** Forget all tracked positions — call on logout / session reset. */
  reset() {
    this.map.clear();
  }
}
