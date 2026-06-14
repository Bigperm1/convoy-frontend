// speedCameras.ts — fixed speed-camera locations from OpenStreetMap (free).
//
// OSM tags fixed enforcement cameras as `highway=speed_camera` nodes. We query
// the public Overpass API for cameras AROUND the driver's current location —
// never a whole continent. A continent-wide pull would be tens of thousands of
// nodes, would hammer the free Overpass servers (they rate-limit + time out),
// and is far more data than a phone needs. Instead we fetch a generous radius
// around the user and only re-fetch once they've driven beyond it, caching the
// results in memory so panning/idling never re-queries. As you drive into new
// areas they populate; your common routes stay cached.
//
// Mobile/handheld cameras and live police are NOT in OSM — those stay
// crowdsourced via /api/hazards. This module is fixed cameras only.

import { useEffect, useRef, useState } from "react";

export type SpeedCamera = { id: string; lat: number; lng: number };

// ---- Tunables ----
const FETCH_RADIUS_M = 40000;   // pull cameras within ~40 km of the driver
const REFETCH_MOVE_M = 20000;   // only re-query once they've driven > ~20 km
const MIN_REFETCH_MS = 60000;   // and never more than once a minute
// Public Overpass instances. The main one frequently returns 429/504 when busy;
// when that happens we fall through to the next mirror in the SAME pass (rather
// than showing no cameras until the driver moves 20 km). All three speak the
// identical Overpass QL API. If every mirror is busy we return [] and try again
// on the next qualifying move.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Fetch fixed speed cameras within `radiusM` of a point from OSM Overpass.
 *
 * Returns an ARRAY on a successful response (possibly empty — that genuinely
 * means "no cameras in this radius"), or `null` when EVERY mirror failed
 * (rate-limit / gateway timeout / network error). The caller must treat `null`
 * differently from `[]`: a failure should be retried, an empty success should
 * not — see useSpeedCameras.
 */
export async function fetchSpeedCamerasAround(
  lat: number,
  lng: number,
  radiusM = FETCH_RADIUS_M
): Promise<SpeedCamera[] | null> {
  const query =
    `[out:json][timeout:25];node(around:${Math.round(radiusM)},${lat},${lng})[highway=speed_camera];out body;`;
  // Try each mirror in turn; the first that answers OK wins. A non-OK status
  // (rate-limit / gateway timeout) or a network error falls through to the next.
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) continue;
      const json: any = await res.json();
      const els: any[] = Array.isArray(json?.elements) ? json.elements : [];
      return els
        .filter((e) => e && typeof e.lat === "number" && typeof e.lon === "number")
        .map((e) => ({ id: String(e.id), lat: e.lat, lng: e.lon }));
    } catch {
      continue;
    }
  }
  return null; // every mirror failed — signal "retry", not "no cameras here"
}

/**
 * Live speed cameras around the driver. Fetches around `lat/lng`, then re-fetches
 * only after they've moved > REFETCH_MOVE_M (throttled to MIN_REFETCH_MS), so the
 * map shows cameras for the area being driven through without continent-scale
 * queries. Returns [] when disabled or before the first GPS fix.
 */
export function useSpeedCameras(
  lat: number | null | undefined,
  lng: number | null | undefined,
  enabled: boolean
): SpeedCamera[] {
  const [cameras, setCameras] = useState<SpeedCamera[]>([]);
  const centerRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastFetchRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  // Mirrors the latest `enabled` so the async fetch below can re-check it at
  // APPLY time. On a cold start the default settings (cameras ON) are live for a
  // beat before the user's persisted "off" loads from AsyncStorage; if a slow
  // Overpass fetch was kicked off in that window, it used to resolve and call
  // setCameras() even though the user has cameras OFF — the "cameras flashed on
  // then vanished while the toggle was off" bug. Guarding on this ref drops the
  // stale result instead of showing it.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) { setCameras([]); centerRef.current = null; return; }
    if (typeof lat !== "number" || typeof lng !== "number") return;

    const now = Date.now();
    const center = centerRef.current;
    const moved = center ? haversineM(center.lat, center.lng, lat, lng) : Infinity;
    if (center && moved < REFETCH_MOVE_M) return;             // still inside the fetched area
    if (now - lastFetchRef.current < MIN_REFETCH_MS) return;  // throttle
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    lastFetchRef.current = now;
    const fetchedAt = { lat, lng };
    (async () => {
      const cams = await fetchSpeedCamerasAround(lat, lng);
      // Re-check enabled at APPLY time: the user may have toggled cameras OFF
      // (or the persisted "off" finished loading) while this slow fetch was in
      // flight. Don't flash stale cameras onto a map that has them turned off.
      if (cams && enabledRef.current) {
        // Success (even if zero cameras): lock this center so we don't re-query
        // until the driver leaves the radius.
        centerRef.current = fetchedAt;
        setCameras(cams);
      }
      // cams === null → every Overpass mirror failed. Deliberately DON'T set
      // centerRef, so the distance guard stays open and the next GPS tick
      // retries (still throttled to once per MIN_REFETCH_MS). Without this, a
      // single failed fetch on app start locked cameras out for ~20km — the
      // "they showed up, then vanished after a restart and never returned" bug.
      inFlightRef.current = false;
    })();
  }, [lat, lng, enabled]);

  return cameras;
}
