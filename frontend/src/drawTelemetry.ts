// drawTelemetry — the drawn-vs-raw breadcrumb (shipped 8/20 for Jeff's drive home).
//
// The one instrument every drift report has been missing: what the MARKER showed
// vs what GPS said, per surface, with the draw mode. Emits one bounded logEvent
// row per surface every 10 s while moving (≥ ~5 km/h) — a 40-minute drive is
// ~480 rows across both surfaces, well inside the telemetry budget. Distances
// are computed here so the row is readable without post-processing.
//
// This TAPS the existing draw path — it changes nothing about what draws.

// ── WHAT THIS ROW WAS MISSING, AND WHAT IT COST (2026-08-29) ───────────────────
// The row reported this instrument's OUTPUT while hiding both its INPUTS.
//
// In `mode=pin`, `raw=` is not GPS at all — ConvoyMapbox passes `selfCar`, which when
// pinned IS the parked spot (ConvoyMapbox.tsx:2736-2746). So `d=0.0m` is a tautology
// (the pin compared against itself) and the driver's live fix — the one number needed to
// see that the marker was 345 m from the phone — appeared nowhere. Jeff's stale-pin
// report took nine agents and ten queries to settle, and one term of it (the fix's own
// horizontal accuracy) could not be settled at all, because it is never logged anywhere.
//
// So: `gps=` and `acc=` now ride EVERY row regardless of mode, `sep=` states the
// separation the 75 m pin gate actually tests, and latch/parked/hu/spotAge expose the
// locationPrivacy state that was invisible from outside that module.

import { logEvent } from "./crashBreadcrumb";
import { privacyDebug } from "./locationPrivacy";

const INTERVAL_MS = 10_000;
// Stationary rows are throttled harder — a parked phone would otherwise emit all night.
// 60 s bounds it at ~60 rows/hour while still catching a wrong pin within a minute.
const SLOW_INTERVAL_MS = 60_000;
const MIN_SPEED_MS = 1.5;

const lastAt: Record<string, number> = {};

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function reportDraw(
  surface: "phone" | "car",
  raw: { lat: number; lng: number } | null | undefined,
  drawn: { lat: number; lng: number } | null | undefined,
  mode: "route" | "road" | "raw" | "pin",
  speedMs: number | null | undefined,
  navActive: boolean,
  /** The LIVE fix, always — even when `raw` is the pin. Plus its own uncertainty. */
  gps?: { lat: number; lng: number; accM?: number | null } | null,
  /** HEADING RECEIPT (2026-09-03, Jeff: "the nose of the car does not follow the corner").
   *  Heading had no breadcrumb anywhere. `locked` = what the model is pointed at (route
   *  segment bearing while snapped, else the smoothed/raw course), `raw` = the GPS course,
   *  `route` = the projected segment's bearing (null when not snapped). Degrees, true. */
  hdg?: { locked: number | null; raw: number | null; route: number | null } | null,
): void {
  try {
    if (!raw || !drawn) return;
    const spd = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
    // ── THE SPEED FLOOR USED TO CENSOR THE EVIDENCE ──────────────────────────────
    // Dropping every sub-creep sample meant the only rows that ever survived were ones
    // carrying phantom speed, so the 2026-08-29 evidence set was a biased subset by
    // construction — it could not contain a single correct-behaviour sample to compare
    // against. A pinned marker on a STATIONARY phone is precisely the bug this
    // instrument exists to catch, so `pin` now survives the floor (on the slow
    // throttle). Everything else below creep is scatter noise and still drops.
    const slow = spd < MIN_SPEED_MS;
    if (slow && mode !== "pin") return;
    const now = Date.now();
    if (now - (lastAt[surface] ?? 0) < (slow ? SLOW_INTERVAL_MS : INTERVAL_MS)) return;
    lastAt[surface] = now;
    const d = haversineM(raw.lat, raw.lng, drawn.lat, drawn.lng);
    // Separation between the phone and what we DREW — the quantity map.tsx's 75 m
    // SELF_PIN_MIN_SEPARATION_M gate tests, and the one that says "the marker is wrong"
    // out loud instead of leaving it to be derived from two coordinates.
    const sep = gps ? haversineM(gps.lat, gps.lng, drawn.lat, drawn.lng) : null;
    const acc = typeof gps?.accM === "number" && isFinite(gps.accM) && gps.accM >= 0 ? gps.accM : null;
    // ── DO NOT LOG A STATIONARY PINNED FIX'S COORDINATES (2026-08-29) ────────────
    // `gps` is RAW coords — it has not been through shareablePosition(), so it is not
    // subject to the one privacy gate (src/locationPrivacy.ts). logEvent is a Supabase
    // INSERT carrying the user's handle, so this row leaves the device.
    //
    // Stationary + pinned is EXACTLY the walked-away case: map.tsx only pins when the
    // phone is >75 m from the car spot, which is the driver standing somewhere that is
    // not a road — their house, their office. Publishing that coordinate is the house
    // leak this whole module exists to prevent.
    //
    // It was hidden before only by accident: the MIN_SPEED_MS floor meant no stationary
    // row ever existed, so lifting that floor for `pin` rows (which the diagnosis needed)
    // opened it. Withhold the COORDINATE only — sep=, acc= and the latch/parked/hu/
    // spotAge state all still emit, and those are every diagnostic this row is for.
    // A moving pin row is on a road and keeps its coordinate.
    const hideGps = slow && mode === "pin";
    const p = privacyDebug();
    logEvent(
      `draw-cmp surf=${surface} mode=${mode} d=${d.toFixed(1)}m spd=${(spd * 3.6).toFixed(0)} nav=${navActive ? 1 : 0} ` +
        `acc=${acc == null ? "?" : acc.toFixed(0) + "m"} sep=${sep == null ? "?" : sep.toFixed(0) + "m"} ` +
        `gps=${gps && !hideGps ? gps.lat.toFixed(6) + "," + gps.lng.toFixed(6) : hideGps ? "withheld" : "?"} ` +
        `raw=${raw.lat.toFixed(6)},${raw.lng.toFixed(6)} drawn=${drawn.lat.toFixed(6)},${drawn.lng.toFixed(6)} ` +
        `latch=${p.latch ? 1 : 0} parked=${p.parked ? 1 : 0} hu=${p.hu ? 1 : 0} spotAge=${p.spotAgeS == null ? "?" : p.spotAgeS + "s"}` +
        (hdg ? ` hdg=${fmtDeg(hdg.locked)} gpsHdg=${fmtDeg(hdg.raw)} rb=${hdg.route == null ? "-" : fmtDeg(hdg.route)}` : ""),
    );
  } catch {
    // never let the instrument disturb the draw path
  }
}

function fmtDeg(v: number | null | undefined): string {
  return typeof v === "number" && isFinite(v) ? String(Math.round(((v % 360) + 360) % 360)) : "?";
}
