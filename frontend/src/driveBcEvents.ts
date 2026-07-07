// driveBcEvents.ts — official BC road events from the DriveBC Open511 API (free).
//
// The BC Ministry of Transportation publishes live road events — accidents,
// construction, closures, weather — via the Open511 standard at
// https://api.open511.gov.bc.ca/events (no API key). This fills the gap crew
// hazards can't: an incident shows up even when no Convoy member is near it,
// which is the thing Waze wins on today.
//
// Same fetch discipline as speedCameras.ts: pull events in a bounding box AROUND
// the driver, cache in memory, and only re-fetch once they've driven beyond it.
// It is DELIBERATELY complementary to crew hazards (/api/hazards) — police and
// mobile speed traps are NOT in any official feed and stay crowd-sourced.
//
// Coverage is BC provincial highways only, so we gate every fetch on a rough BC
// bounding box: outside BC we return [] and never hit the API. The same shape
// extends to 511 Ontario / Alberta / etc. as separate sources later.
//
// Data © the Province of British Columbia, used under the Open Government
// Licence – British Columbia (attribution shown on the Legal screen).

import { useEffect, useRef, useState } from "react";

export type RoadEventKind = "incident" | "construction" | "road" | "weather" | "event";
export type RoadEventSeverity = "MINOR" | "MODERATE" | "MAJOR" | "UNKNOWN";

export type RoadEvent = {
  id: string;
  lat: number;
  lng: number;
  kind: RoadEventKind;
  severity: RoadEventSeverity;
  headline: string;
  road?: string;
};

// ---- Tunables (mirror speedCameras.ts) ----
const FETCH_RADIUS_M = 40000; // pull events within ~40 km of the driver
const REFETCH_MOVE_M = 20000; // only re-query once they've driven > ~20 km
const MIN_REFETCH_MS = 60000; // and never more than once a minute
const OPEN511_EVENTS = "https://api.open511.gov.bc.ca/events";

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Rough British Columbia bounding box (with a small margin). DriveBC only covers
// BC, so outside this we don't bother the API.
export function inBritishColumbia(lat: number, lng: number): boolean {
  return lat >= 47.8 && lat <= 60.2 && lng >= -139.2 && lng <= -113.8;
}

const KIND_BY_TYPE: Record<string, RoadEventKind> = {
  INCIDENT: "incident",
  CONSTRUCTION: "construction",
  ROAD_CONDITION: "road",
  WEATHER_CONDITION: "weather",
  SPECIAL_EVENT: "event",
};

// Open511 geography is GeoJSON [lng, lat] — a Point, or a Line/Multi we reduce to
// its first coordinate (a representative pin near where the event starts).
function firstCoord(geometry: any): [number, number] | null {
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  if (typeof c[0] === "number" && typeof c[1] === "number") return [c[0], c[1]]; // Point
  let node: any = c;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0]; // dig into Line/Multi
  if (Array.isArray(node) && typeof node[0] === "number" && typeof node[1] === "number") {
    return [node[0], node[1]];
  }
  return null;
}

/**
 * Fetch active DriveBC events within `radiusM` of a point.
 *
 * Returns an ARRAY on success (possibly empty — genuinely "no events here"), or
 * `null` when the request failed (network / server error) so the caller can
 * retry rather than lock in an empty result. Outside BC returns [] immediately.
 */
export async function fetchDriveBcEventsAround(
  lat: number,
  lng: number,
  radiusM = FETCH_RADIUS_M
): Promise<RoadEvent[] | null> {
  if (!inBritishColumbia(lat, lng)) return [];
  // Open511 bbox = minLng,minLat,maxLng,maxLat. Convert the radius to degrees.
  const latDelta = radiusM / 111320;
  const lngDelta = radiusM / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bbox = `${(lng - lngDelta).toFixed(5)},${(lat - latDelta).toFixed(5)},${(lng + lngDelta).toFixed(5)},${(lat + latDelta).toFixed(5)}`;
  const url = `${OPEN511_EVENTS}?status=ACTIVE&bbox=${bbox}&limit=500&format=json`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const events: any[] = Array.isArray(json?.events) ? json.events : [];
    const out: RoadEvent[] = [];
    for (const e of events) {
      const coord = firstCoord(e?.geography);
      if (!coord) continue;
      out.push({
        id: String(e.id ?? `${coord[0]},${coord[1]}`),
        lat: coord[1],
        lng: coord[0],
        kind: KIND_BY_TYPE[String(e.event_type)] || "incident",
        severity: (["MINOR", "MODERATE", "MAJOR"].includes(String(e.severity))
          ? e.severity
          : "UNKNOWN") as RoadEventSeverity,
        // description carries the real detail; headline is often a generic uppercase
        // word ("CONSTRUCTION"). Prefer the fuller text for the tap card.
        headline: String(e.description || e.headline || "Road event"),
        road: Array.isArray(e.roads) && e.roads[0]?.name ? String(e.roads[0].name) : undefined,
      });
    }
    return out;
  } catch {
    return null; // network / parse error — signal "retry", not "no events here"
  }
}

/**
 * Live DriveBC road events around the driver. Same cache/refetch discipline as
 * useSpeedCameras. Returns [] when disabled, before the first fix, or outside BC.
 */
export function useDriveBcEvents(
  lat: number | null | undefined,
  lng: number | null | undefined,
  enabled: boolean
): RoadEvent[] {
  const [events, setEvents] = useState<RoadEvent[]>([]);
  const centerRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastFetchRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) { setEvents([]); centerRef.current = null; return; }
    if (typeof lat !== "number" || typeof lng !== "number") return;
    // Outside BC → clear and don't poll (the same trip may leave/enter the province).
    if (!inBritishColumbia(lat, lng)) {
      if (events.length) setEvents([]);
      centerRef.current = null;
      return;
    }

    const now = Date.now();
    const center = centerRef.current;
    const moved = center ? haversineM(center.lat, center.lng, lat, lng) : Infinity;
    if (center && moved < REFETCH_MOVE_M) return;
    if (now - lastFetchRef.current < MIN_REFETCH_MS) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    lastFetchRef.current = now;
    const fetchedAt = { lat, lng };
    (async () => {
      const evs = await fetchDriveBcEventsAround(lat, lng);
      // Re-check enabled at apply time (the persisted "off" may have loaded, or
      // the user toggled it, during a slow fetch).
      if (evs && enabledRef.current) {
        centerRef.current = fetchedAt;
        setEvents(evs);
      }
      // evs === null → request failed; leave centerRef open so the next tick retries.
      inFlightRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, enabled]);

  return events;
}
