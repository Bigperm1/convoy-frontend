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

const INTERVAL_MS = 30_000;      // 10 s → 30 s (2026-09-06: draw-cmp was 27 % of all rows)
// Stationary rows are throttled harder — a parked phone would otherwise emit all night.
// 60 s bounds it at ~60 rows/hour while still catching a wrong pin within a minute.
const SLOW_INTERVAL_MS = 60_000;
const MIN_SPEED_MS = 1.5;

const lastAt: Record<string, number> = {};

// ── CORNER TRACE (2026-09-03, Jeff: "the first corner was off the route line by a lot") ──
// The 10 s cadence above straddled that corner: the two rows either side of it showed the
// marker 4.5 m and 1.7 m from GPS and nothing in between, so a 2–3 s excursion inside the
// turn was invisible by construction. This adds a BOUNDED burst: when the GPS course swings
// ≥ CORNER_DEG within a few seconds during guidance, up to TRACE_ROWS rows at ≥ 1 s spacing
// carry the same numbers as draw-cmp, and every snap-MODE change in guidance logs once
// (route→raw at a corner = "the snap dropped"). Re-arms after TRACE_REARM_MS, so a twisty
// road costs ≤ ~5 rows per corner per surface.
const CORNER_DEG = 30;
const CORNER_ANCHOR_MS = 3000;     // heading is compared against a 0–3 s old anchor
const TRACE_ROWS = 3;            // 5 → 3 (2026-09-06)
const TRACE_MIN_GAP_MS = 1000;
const TRACE_REARM_MS = 10000;    // 15 s → 60 s (2026-09-06) → 10 s (2026-09-09: the 60 s rearm ate Jeff's roundabout AND his stop-light left — one burst per minute cannot record two corners 40 s apart)
const MODE_ROW_MIN_GAP_MS = 2000; // 2 s → 15 s (2026-09-06) → 2 s (2026-09-09: a route→raw→route flip inside 15 s left no row at all, so whether the driveway turn was drawn raw for 7 s or 0.5 s was unknowable)
const hdgAnchor: Record<string, { deg: number; at: number }> = {};
const traceState: Record<string, { left: number; lastAt: number; armedAt: number }> = {};
const lastMode: Record<string, { mode: string; at: number }> = {};
const angDelta = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

function cornerTrace(
  surface: string,
  raw: { lat: number; lng: number },
  drawn: { lat: number; lng: number },
  mode: string,
  spd: number,
  navActive: boolean,
  gps: { lat: number; lng: number; accM?: number | null } | null | undefined,
  hdg: HdgReceipt | null | undefined,
): void {
  if (!navActive) return;
  const now = Date.now();
  // Snap-mode transitions in guidance (bounded).
  const lm = lastMode[surface];
  if (!lm) lastMode[surface] = { mode, at: 0 };
  else if (lm.mode !== mode) {
    if (now - lm.at >= MODE_ROW_MIN_GAP_MS) {
      const d = haversineM(raw.lat, raw.lng, drawn.lat, drawn.lng);
      logEvent(`snap-mode surf=${surface} from=${lm.mode} to=${mode} d=${d.toFixed(1)}m spd=${(spd * 3.6).toFixed(0)}` + hdgExtra(hdg));
      lastMode[surface] = { mode, at: now };
    } else lastMode[surface] = { mode, at: lm.at };
  }
  const h = typeof hdg?.raw === "number" && isFinite(hdg.raw) ? hdg.raw : (typeof hdg?.locked === "number" && isFinite(hdg.locked) ? hdg.locked : null);
  if (h == null || spd < MIN_SPEED_MS) return;
  const a = hdgAnchor[surface];
  if (!a) { hdgAnchor[surface] = { deg: h, at: now }; return; }
  const t = traceState[surface] ?? (traceState[surface] = { left: 0, lastAt: 0, armedAt: 0 });
  if (Math.abs(angDelta(a.deg, h)) >= CORNER_DEG && t.left === 0 && now - t.armedAt >= TRACE_REARM_MS) {
    t.left = TRACE_ROWS; t.armedAt = now; t.lastAt = 0;
  }
  if (now - a.at >= CORNER_ANCHOR_MS) hdgAnchor[surface] = { deg: h, at: now };
  if (t.left > 0 && now - t.lastAt >= TRACE_MIN_GAP_MS) {
    t.left -= 1; t.lastAt = now;
    const d = haversineM(raw.lat, raw.lng, drawn.lat, drawn.lng);
    const sep = gps ? haversineM(gps.lat, gps.lng, drawn.lat, drawn.lng) : null;
    logEvent(
      `corner-trace surf=${surface} i=${TRACE_ROWS - t.left} mode=${mode} d=${d.toFixed(1)}m sep=${sep == null ? "?" : sep.toFixed(0) + "m"} spd=${(spd * 3.6).toFixed(0)} ` +
        `raw=${raw.lat.toFixed(6)},${raw.lng.toFixed(6)} drawn=${drawn.lat.toFixed(6)},${drawn.lng.toFixed(6)}` +
        hdgExtra(hdg),
    );
  }
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

/**
 * The heading receipt. 2026-09-09 additions, because every field a corner diagnosis needed was
 * MISSING from the rows on Jeff's drive home: `rbAll`/`distM` (the projection even when NOT
 * snapped — `rb=` used to print `-` exactly when it mattered), `hd`/`latch`/`gate` (the snap gate's
 * inputs, not just its output), `rate`/`age` (cornerBlend's dilution denominator), `fixAge` (how old
 * the fix the row was drawn from actually is), and `est` — what the pose estimator drew, with its
 * source (gyro / gps / hold) and route weight, so old-vs-new is one query.
 */
export type HdgReceipt = {
  locked: number | null; raw: number | null; route: number | null; fix?: number | null; fixN?: number | null;
  rbAll?: number | null; distM?: number | null;
  hd?: number | null; latch?: boolean | null; gate?: string | null;
  rate?: number | null; age?: number | null;
  fixAge?: number | null;
  est?: { lat: number; lng: number; hdg: number; src: string; routeW: number; yaw?: number | null; dOld?: number | null } | null;
};
function hdgExtra(hdg: HdgReceipt | null | undefined): string {
  if (!hdg) return "";
  let s = ` hdg=${fmtDeg(hdg.locked)} gpsHdg=${fmtDeg(hdg.raw)} rb=${hdg.route == null ? (hdg.rbAll == null ? "-" : fmtDeg(hdg.rbAll) + "u") : fmtDeg(hdg.route)} fix=${fmtFix(hdg.fix)} nfx=${typeof hdg.fixN === "number" ? hdg.fixN : "?"}`;
  if (typeof hdg.distM === "number" && isFinite(hdg.distM)) s += ` distM=${hdg.distM.toFixed(1)}`;
  if (typeof hdg.hd === "number" && isFinite(hdg.hd)) s += ` hd=${Math.round(hdg.hd)}`;
  if (typeof hdg.latch === "boolean") s += ` latch=${hdg.latch ? 1 : 0}`;
  if (hdg.gate) s += ` gate=${hdg.gate}`;
  if (typeof hdg.rate === "number" && isFinite(hdg.rate)) s += ` rate=${hdg.rate.toFixed(1)}`;
  if (typeof hdg.age === "number" && isFinite(hdg.age)) s += ` age=${Math.round(hdg.age)}`;
  if (typeof hdg.fixAge === "number" && isFinite(hdg.fixAge)) s += ` fixAge=${Math.round(hdg.fixAge)}`;
  if (hdg.est) {
    const e = hdg.est;
    s += ` est=${e.lat.toFixed(6)},${e.lng.toFixed(6)} estHdg=${fmtDeg(e.hdg)} src=${e.src} rw=${e.routeW.toFixed(2)}`;
    if (typeof e.yaw === "number" && isFinite(e.yaw)) s += ` yaw=${e.yaw.toFixed(1)}`;
    if (typeof e.dOld === "number" && isFinite(e.dOld)) s += ` dOld=${e.dOld.toFixed(1)}`;
  }
  return s;
}

// ── POSE-FIX ROW (2026-09-09): one row per accepted fix INSIDE A TURN (or the last 500 m), bounded ──
// This is the receipt the corner diagnosis never had: the fix's age and accuracy, the course, the
// estimator's heading and yaw source, drawn-vs-fix, the projection distance and the route weight.
// 2026-09-10: 40 rows per DRIVE was spent by the departure corners (all 80 gone by 09:02 on a
// 25-minute drive), leaving the exit roundabout and the arrival with no rows at all. A sliding
// window keeps the receipts where the corners are: ≤ 12 rows per minute, ≤ 400 per drive.
const POSE_ROWS_PER_MIN = 12;
const POSE_ROWS_MAX = 400;
let _poseRows = 0;
let _poseRowTimes: number[] = [];
/** Called by both surfaces when guidance STARTS, so every drive gets a fresh budget. (Codex review
 *  2026-09-09: the budget used to reset only on a navActive false->true seen by reportPoseFix itself,
 *  which the callers never delivered — after 40 rows no later drive in the session logged anything.) */
export function resetPoseFixBudget(): void { _poseRows = 0; _poseRowTimes = []; }
export function reportPoseFix(surface: "phone" | "car", navActive: boolean, f: {
  fixAge: number; acc: number | null; course: number | null; spd: number;
  estHdg: number; yaw: number | null; src: string; drawnVsFixM: number; distM: number | null; routeW: number; dOld?: number | null;
  // 2026-09-10 receipts for the two open HYPOTHESES: ys = which sensor feed carried the yaw
  // (att = fused attitude, rate = gyro fallback), mdiff = fused-minus-gyro cumulative degrees (its
  // change between rows is the magnetic slew), pitch = mount angle (±90 = upright, the Euler-yaw singularity).
  ys?: string | null; mdiff?: number | null; pitch?: number | null; lock?: boolean;
  // 2026-09-10 the road heading: road = the line's direction owning the nose (°), rk = how much (0..1), rel = released
  road?: number | null; rk?: number | null; rel?: boolean;
}): void {
  try {
    if (!navActive || _poseRows >= POSE_ROWS_MAX) return;
    const now = Date.now();
    while (_poseRowTimes.length && now - _poseRowTimes[0] > 60_000) _poseRowTimes.shift();
    if (_poseRowTimes.length >= POSE_ROWS_PER_MIN) return;
    _poseRowTimes.push(now);
    _poseRows += 1;
    logEvent(
      `pose-fix surf=${surface} fixAge=${Math.round(f.fixAge)} acc=${f.acc == null ? "?" : f.acc.toFixed(0)} course=${fmtDeg(f.course)} spd=${(f.spd * 3.6).toFixed(0)} ` +
      `estHdg=${fmtDeg(f.estHdg)} yaw=${f.yaw == null ? "?" : f.yaw.toFixed(1)} src=${f.src} dFix=${f.drawnVsFixM.toFixed(1)} ` +
      `distM=${f.distM == null ? "?" : f.distM.toFixed(1)} rw=${f.routeW.toFixed(2)}${typeof f.dOld === "number" && isFinite(f.dOld) ? ` dOld=${f.dOld.toFixed(1)}` : ""}` +
      ` ys=${f.ys ?? "?"}${typeof f.mdiff === "number" && isFinite(f.mdiff) ? ` mdiff=${f.mdiff.toFixed(1)}` : ""}${typeof f.pitch === "number" && isFinite(f.pitch) ? ` pitch=${f.pitch.toFixed(0)}` : ""}${f.lock ? " lock=1" : ""}` +
      `${typeof f.road === "number" && isFinite(f.road) ? ` road=${f.road.toFixed(0)}` : ""}${typeof f.rk === "number" && isFinite(f.rk) ? ` rk=${f.rk.toFixed(2)}` : ""}${f.rel ? " rel=1" : ""}`,
    );
  } catch {}
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
   *  `route` = the projected segment's bearing (null when not snapped). Degrees, true.
   *  `fix` = the NOSE COURSE CLAMP correction currently applied to `locked`, signed degrees
   *  (2026-09-04, src/cornerBlend.ts cornerNose). `fix=0` means the clamp is idle — the nose is
   *  within 20° of the course; a non-zero value is how far it was pulled back toward the course.
   *  The field is printed whenever `hdg` is supplied, so a MISSING `fix=` means an old bundle,
   *  not an idle clamp.
   *  `fixN` → `nfx=` = how many DISTINCT over-cone GPS course fixes are currently backing that
   *  correction (2026-09-04). It exists because the first version's hold counted RENDERS, so one
   *  bad fix held across 1.5 s could move the nose with no second observation behind it; the gate
   *  now needs ≥2 fixes spanning ≥1 s. `nfx=` is what makes that auditable from a drive instead of
   *  from a code read: `fix=` non-zero with `nfx=` 0 or 1 would mean the gate is broken. */
  hdg?: HdgReceipt | null,
): void {
  try {
    if (!raw || !drawn) return;
    const spd = typeof speedMs === "number" && isFinite(speedMs) ? speedMs : 0;
    // Corner trace + snap-mode rows run BEFORE the 10 s throttle (they have their own bounds).
    try { cornerTrace(surface, raw, drawn, mode, spd, navActive, gps, hdg); } catch {}
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
        `latch=${p.latch ? 1 : 0} parked=${p.parked ? 1 : 0} hu=${p.hu ? 1 : 0} spotAge=${p.spotAgeS == null ? "?" : p.spotAgeS + "s"}${p.spotDrop ? ` spotDrop=${p.spotDrop}` : ""}` +
        hdgExtra(hdg),
    );
  } catch {
    // never let the instrument disturb the draw path
  }
}

function fmtDeg(v: number | null | undefined): string {
  return typeof v === "number" && isFinite(v) ? String(Math.round(((v % 360) + 360) % 360)) : "?";
}

/** Signed, NOT wrapped to 0..360 — the sign is the whole point (which way the nose was pulled). */
function fmtFix(v: number | null | undefined): string {
  return typeof v === "number" && isFinite(v) ? v.toFixed(1) : "?";
}
