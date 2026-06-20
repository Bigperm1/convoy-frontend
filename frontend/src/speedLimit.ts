// speedLimit.ts — posted speed limit for the road the driver is on, from
// OpenStreetMap `maxspeed` tags (free, via the public Overpass API). Mirrors
// the speedCameras.ts approach: pull a radius of data around the driver, cache
// it in memory, and only re-query once they've driven out of the cached area.
//
// Unlike cameras (point nodes), speed limits live on road WAYS, and we need to
// know which road the driver is ON *right now* — so we fetch the ways WITH
// their geometry, cache them, and resolve the nearest road segment locally on
// every GPS tick. That gives a per-second-responsive limit without re-hitting
// Overpass (which rate-limits) more than once per ~30s of real movement.
//
// Replaces the old Google Roads Speed Limits lookup, which is a gated/paid
// endpoint that was disabled on this project (every call 403'd).

import { useEffect, useRef, useState } from "react";

type LimitWay = { maxspeedKmh: number; geom: { lat: number; lng: number }[] };

// ---- Tunables ----
// Multiple Overpass mirrors. overpass-api.de intermittently rejects requests
// under load (we've seen 406/429) and returns no data; a less-loaded mirror
// usually answers. fetchSpeedLimitWaysAround tries them in order.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const FETCH_RADIUS_M = 1500;    // pull maxspeed ways within ~1.5 km of the driver
const REFETCH_MOVE_M = 1000;    // re-query once they've driven > ~1 km from the last pull
const MIN_REFETCH_MS = 30000;   // and never more than once per 30s
const SNAP_TOLERANCE_M = 30;    // how close a road must be to count as "the road you're on"
const FETCH_TIMEOUT_MS = 10000; // hard per-attempt timeout so a stalled mirror can't wedge the in-flight flag

// ---- TEMP debug (remove before release) — diagnose Android no-limit ----
// Captures the last Overpass HTTP status, ways-parsed count, and snap result so
// an on-screen readout can show whether Android is failing at the network, the
// data, or the snap stage. getSpeedLimitDebug() returns one short string.
let _dbgHttp = "-";
let _dbgWays = 0;
let _dbgSnap = "no-snap";
// Nearest cached-road distance (metres) from the last resolve, so the hook can
// detect a stale cache and force a refetch. Infinity when nothing is cached.
let _lastNearestM = Infinity;
export function getSpeedLimitDebug(): string {
  return `${_dbgHttp} ways:${_dbgWays} ${_dbgSnap}`;
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Distance (metres) from point P to segment A→B, via a local equirectangular
// projection centred on P (accurate enough at street scale).
function segDistM(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const X = (lng: number) => toRad(lng - pLng) * cosLat * R;
  const Y = (lat: number) => toRad(lat - pLat) * R;
  const ax = X(aLng), ay = Y(aLat);
  const bx = X(bLng), by = Y(bLat);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((0 - ax) * dx + (0 - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// Parse an OSM maxspeed tag into km/h. Returns null for anything without a firm
// numeric limit ("none", "signals", country-implicit codes like "CA:urban"),
// so the caller treats those as "unknown" rather than guessing.
export function parseMaxspeedKmh(raw?: string): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "none" || s === "signals" || s === "variable" || s === "unposted") return null;
  let m = s.match(/^(\d+(?:\.\d+)?)$/);                 // "50" → km/h (OSM default unit)
  if (m) return Math.round(parseFloat(m[1]));
  m = s.match(/^(\d+(?:\.\d+)?)\s*km\/?h$/);            // "50 km/h"
  if (m) return Math.round(parseFloat(m[1]));
  m = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);               // "30 mph" → km/h
  if (m) return Math.round(parseFloat(m[1]) * 1.609344);
  if (s === "walk") return 7;
  return null;                                          // implicit/country codes: unknown
}

/** Fetch nearby road ways that carry a numeric maxspeed, with geometry. */
export async function fetchSpeedLimitWaysAround(
  lat: number,
  lng: number,
  radiusM = FETCH_RADIUS_M
): Promise<LimitWay[] | null> {
  const query =
    `[out:json][timeout:25];way(around:${Math.round(radiusM)},${lat},${lng})[maxspeed][highway];out tags geom;`;
  const body = "data=" + encodeURIComponent(query);
  let lastStatus = "";
  // Try each Overpass mirror in turn. overpass-api.de intermittently rejects
  // requests under load (406/429/504) and returns no data; a less-loaded mirror
  // usually answers. Each attempt gets its own hard timeout so one stalled mirror
  // can't eat the whole budget or wedge the hook's inFlight flag.
  for (const url of OVERPASS_URLS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // A descriptive User-Agent is good Overpass citizenship and dodges
          // anti-abuse layers that 403/406 a missing or generic agent (Android's
          // default OkHttp UA is the most likely cause of the 406 we saw).
          "User-Agent": "Convoy/2.0 (navigation app)",
        },
        body,
        signal: ctrl.signal,
      });
      lastStatus = "http:" + res.status;
      if (!res.ok) { continue; }                          // this mirror rejected — try the next
      const json: any = await res.json();
      const els: any[] = Array.isArray(json?.elements) ? json.elements : [];
      const ways: LimitWay[] = [];
      for (const e of els) {
        const sp = parseMaxspeedKmh(e?.tags?.maxspeed);
        if (sp == null) continue;
        const geom = Array.isArray(e.geometry)
          ? e.geometry
              .filter((p: any) => typeof p.lat === "number" && typeof p.lon === "number")
              .map((p: any) => ({ lat: p.lat, lng: p.lon }))
          : [];
        if (geom.length) ways.push({ maxspeedKmh: sp, geom });
      }
      _dbgHttp = lastStatus;                              // TEMP debug
      _dbgWays = ways.length;                             // TEMP debug
      return ways;
    } catch {
      lastStatus = "fetch-fail";                          // timeout/abort/network — try the next mirror
    } finally {
      clearTimeout(timer);
    }
  }
  // Every mirror failed — surface the last status, keep the cache, retry later.
  _dbgHttp = lastStatus || "fetch-fail";                 // TEMP debug
  _dbgWays = 0;
  return null;
}

// Nearest road's limit to a point, or null if the closest road is farther than
// SNAP_TOLERANCE_M (i.e. we're not confidently on any tagged road).
function nearestLimit(lat: number, lng: number, ways: LimitWay[]): number | null {
  let best = Infinity;
  let bestSpeed: number | null = null;
  for (const w of ways) {
    const g = w.geom;
    if (g.length === 1) {
      const d = haversineM(lat, lng, g[0].lat, g[0].lng);
      if (d < best) { best = d; bestSpeed = w.maxspeedKmh; }
      continue;
    }
    for (let i = 0; i + 1 < g.length; i++) {
      const d = segDistM(lat, lng, g[i].lat, g[i].lng, g[i + 1].lat, g[i + 1].lng);
      if (d < best) { best = d; bestSpeed = w.maxspeedKmh; }
    }
  }
  const snapped = best <= SNAP_TOLERANCE_M ? bestSpeed : null;
  _lastNearestM = Number.isFinite(best) ? best : Infinity;   // for stale-cache self-heal
  // TEMP debug — nearest-road distance + resolved limit, or no-snap (with the
  // nearest distance when ways exist but none are within tolerance).
  _dbgSnap = Number.isFinite(best)
    ? (snapped != null ? `snap:${Math.round(best)}m=${snapped}` : `no-snap@${Math.round(best)}m`)
    : "no-snap";
  return snapped;
}

/**
 * Posted speed limit (km/h) for the road the driver is currently on, or null
 * when unknown (no GPS, disabled, road untagged, or no road within snap range).
 * Fetches a radius of maxspeed ways around the driver and caches them; the
 * nearest-road resolution runs locally on every coordinate change.
 */
export function useSpeedLimit(
  lat: number | null | undefined,
  lng: number | null | undefined,
  enabled: boolean
): number | null {
  const [limit, setLimit] = useState<number | null>(null);
  const waysRef = useRef<LimitWay[]>([]);
  const centerRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastFetchRef = useRef<number>(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof lat !== "number" || typeof lng !== "number") {
      setLimit(null);
      waysRef.current = [];
      centerRef.current = null;
      return;
    }

    const now = Date.now();
    const center = centerRef.current;
    const moved = center ? haversineM(center.lat, center.lng, lat, lng) : Infinity;
    const needArea = !center || moved > REFETCH_MOVE_M;
    const throttleOk = now - lastFetchRef.current > MIN_REFETCH_MS;

    if (needArea && throttleOk && !inFlightRef.current) {
      inFlightRef.current = true;
      lastFetchRef.current = now;
      centerRef.current = { lat, lng };
      fetchSpeedLimitWaysAround(lat, lng)
        .then((ways) => {
          inFlightRef.current = false;
          if (ways) {
            waysRef.current = ways;
            setLimit(nearestLimit(lat, lng, ways));
          } else {
            centerRef.current = null;     // fetch failed — allow a retry after the throttle window
          }
        })
        .catch(() => { inFlightRef.current = false; centerRef.current = null; });
    }

    // Resolve against whatever is cached right now (instant; no network).
    setLimit(nearestLimit(lat, lng, waysRef.current));

    // Self-heal a stale cache: if the nearest cached road is implausibly far
    // (beyond the fetch radius), the cached ways are stale — e.g. a wedged or
    // aborted fetch left the centre kilometres behind. Drop the centre so the
    // next tick refetches around the current position. The 30s throttle still
    // applies, so this can never hammer Overpass.
    if (
      waysRef.current.length &&
      Number.isFinite(_lastNearestM) &&
      _lastNearestM > FETCH_RADIUS_M &&
      !inFlightRef.current
    ) {
      centerRef.current = null;
    }
  }, [lat, lng, enabled]);

  return limit;
}
