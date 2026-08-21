// drawTelemetry — the drawn-vs-raw breadcrumb (shipped 8/20 for Jeff's drive home).
//
// The one instrument every drift report has been missing: what the MARKER showed
// vs what GPS said, per surface, with the draw mode. Emits one bounded logEvent
// row per surface every 10 s while moving (≥ ~5 km/h) — a 40-minute drive is
// ~480 rows across both surfaces, well inside the telemetry budget. Distances
// are computed here so the row is readable without post-processing.
//
// This TAPS the existing draw path — it changes nothing about what draws.

import { logEvent } from "./crashBreadcrumb";

const INTERVAL_MS = 10_000;
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
): void {
  try {
    if (!raw || !drawn) return;
    const spd = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
    if (spd < MIN_SPEED_MS) return; // parked/crawling — scatter there is a separate, known story
    const now = Date.now();
    if (now - (lastAt[surface] ?? 0) < INTERVAL_MS) return;
    lastAt[surface] = now;
    const d = haversineM(raw.lat, raw.lng, drawn.lat, drawn.lng);
    logEvent(
      `draw-cmp surf=${surface} mode=${mode} d=${d.toFixed(1)}m spd=${(spd * 3.6).toFixed(0)} nav=${navActive ? 1 : 0} ` +
        `raw=${raw.lat.toFixed(6)},${raw.lng.toFixed(6)} drawn=${drawn.lat.toFixed(6)},${drawn.lng.toFixed(6)}`,
    );
  } catch {
    // never let the instrument disturb the draw path
  }
}
