// aheadAlertRules.ts — the PURE half of the ahead-alerts feature: what an OSM tag means, when a
// zone is actually live, how far ahead we call it, and what Nova says. No imports at all, so
// tools/sim-qc/ahead_alerts_test.mts can load it under plain Node with no stub harness.
//
// Jeff, 2026-09-21: "Yes build them and stage 2 for 80. Make the chime the same as the speed ding
// but 1 ding. Give the speed cameras and playground/school zones a good heads up for distance and
// time." The fetching/announcing half lives in src/aheadAlerts.ts.
//
// ── WHAT THE OSM DATA ACTUALLY LOOKS LIKE (measured 2026-09-21, live Overpass) ────────────────
// One query over Jeff's corridor (bbox 49.00,-123.05,49.30,-122.20):
//     way[maxspeed:conditional] → 363 ways in THIRTY-FOUR distinct spellings.
// The canonical `NN @ (…)` form is a minority habit, not a rule. Real strings, verbatim, with
// their corridor counts:
//     71  '30 @ (sunrise-sunset)'              54  '30 @ (Mo-Fr 08:00-17:00; PH off; SH off)'
//     51  '30 @ (Mo-Fr 08:00-17:00; SH off)'   24  '30 @ (Mo-Fr 07:00-22:00; SH off; PH off)'
//     21  '30 @ ("school days" 07:00-22:00)'   11  '50 @ (dusk-dawn)'
//      8  '30 @ "school days":0800-1700'        6  '30 @ (School Days 08:00-17:00)'
//      5  '30 (dawn-dusk)'                      4  '30 @ (Mo-Fr 0800-1700; PH off; Sep-Jun)'
//      3  'Mo-Fr 30 @ (08:00-17:00)'            2  '30 (Mo-Fr 08:00-17:00; PH SH off)'
//      2  '30 @ dawn to dusk'                   1  '30 @ (08:00 - 17:00)'
//      1  '30 @ "school days":0800-1700;30 @ dawn-dusk'                1  '60 @ (23:00-05:00)'
//      1  'r 08:00-17:00)'      ← a truncated tag. The parser must return null, not throw.
// So: the number can come AFTER a day spec, the `@` can be missing, the separator can be `:`,
// the parens can be absent or unbalanced, "school days" can be quoted / capitalised / bare, and
// two rules can be crammed into one value with `;` — which is ALSO the separator INSIDE the
// parens for `PH off`. Everything below is written against those strings, not against the wiki.
//
// ── THE INVERTED PLAYGROUND TAG ──────────────────────────────────────────────────────────────
// 21 of the corridor's daylight tags state the NIGHT limit instead: `50 @ (dusk-dawn)` on a way
// whose base `maxspeed` is 30. Same road, same law (BC: playground zones are 30 km/h dawn→dusk,
// 365 days), opposite polarity. `night: true` records that, and the caller takes the zone's limit
// from the way's base maxspeed instead of from the conditional's number.
//
// ── WHY SCHOOL NEVER CLAIMS THE LIMIT IS IN FORCE ────────────────────────────────────────────
// 84% of the school conditionals hang on `SH off` (school holidays), and there is no public
// machine-readable BC school calendar — Canada is not among the OpenHolidays API's 36 countries.
// We cannot know it is a school day. The table below narrows to when school is PLAUSIBLY in, and
// the spoken line says "when school's in" rather than asserting the limit. Playground zones are
// the opposite: dawn-to-dusk is computable exactly, offline, from the sun.

export type AheadKind = "camera" | "railway" | "school" | "playground";

/** When a conditional limit applies. `always` = a zone with no usable window (we fall back to the kind's own rule). */
export type AheadWindow =
  | { type: "daylight"; night: boolean; civil: boolean }
  | { type: "clock"; weekdaysOnly: boolean; startMin: number; endMin: number; schoolDays: boolean }
  | { type: "always" };

export type ConditionalRule = {
  limitKmh: number;
  kind: "school" | "playground" | "other";
  window: AheadWindow;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1 · PARSING `maxspeed:conditional`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Split on `;` only at paren depth 0, so `(Mo-Fr 08:00-17:00; SH off)` stays one rule. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** "08:00" | "0800" | "8:00" → minutes since local midnight, or null. */
function clockToMin(h: string, m: string): number | null {
  const hh = parseInt(h, 10), mm = parseInt(m, 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

const DAYLIGHT_RE = /(sunrise|sunset|dawn|dusk)/i;
const SCHOOL_RE = /school/i;

/**
 * Parse one `maxspeed:conditional` value. Returns null for anything without a firm number and a
 * recognisable window — a truncated tag, an implicit code, junk — so a bad tag is silently skipped
 * rather than announced or thrown.
 */
export function parseMaxspeedConditional(raw?: string | null): ConditionalRule | null {
  if (!raw || typeof raw !== "string") return null;
  // Only the FIRST rule. The one corridor way that carries two ('…"school days":0800-1700;30 @
  // dawn-dusk') is tagging one physical zone twice, not two zones, so taking the first is right and
  // taking both would double-announce it.
  const one = splitTopLevel(raw)[0];
  if (!one) return null;
  const s = one.trim().replace(/\.+$/, "");            // '30 @ (sunrise-sunset).' — 4 ways carry the full stop

  // The condition is whatever sits inside a BALANCED (…); failing that, whatever follows the first
  // `@`. 'r 08:00-17:00)' has neither a `(` nor an `@`, so it falls through to null — measured, and
  // the reason this is not a single regex.
  let cond = "";
  let head = "";
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open >= 0 && close > open) {
    cond = s.slice(open + 1, close);
    head = s.slice(0, open);
  } else {
    const at = s.indexOf("@");
    if (at < 0) return null;
    head = s.slice(0, at);
    cond = s.slice(at + 1);
  }
  cond = cond.trim();
  if (!cond) return null;

  // The number lives in the head ('30 @ …', 'Mo-Fr 30 @ …'), so the head's day words come along as
  // extra condition text — that is how 'Mo-Fr 30 @ (08:00-17:00)' keeps its Mo-Fr.
  const num = /(\d+(?:\.\d+)?)\s*(mph)?/i.exec(head.replace(/@/g, " "));
  if (!num) return null;
  let limitKmh = Math.round(parseFloat(num[1]) * (num[2] ? 1.609344 : 1));
  if (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > 200) return null;
  const all = (head + " " + cond).trim();

  // Daylight first: it is unambiguous and BC's playground rule.
  const dl = DAYLIGHT_RE.exec(cond);
  if (dl) {
    // Which end is named FIRST decides the polarity: 'dusk-dawn' / 'sunset-sunrise' state the NIGHT
    // limit, 'dawn-dusk' / 'sunrise-sunset' the daytime one.
    const first = dl[1].toLowerCase();
    const night = first === "dusk" || first === "sunset";
    // Honour the tag's own wording: dawn/dusk is civil twilight (BC's statute says dawn to dusk),
    // sunrise/sunset is the geometric disc. They differ by ~30 minutes at this latitude.
    const civil = /dawn|dusk/i.test(cond);
    return { limitKmh, kind: "playground", window: { type: "daylight", night, civil } };
  }

  const weekdaysOnly = /\bmo\s*-\s*fr\b/i.test(all);
  const schoolDays = SCHOOL_RE.test(all);
  // 'HH:MM-HH:MM', 'HHMM-HHMM', '08:00 - 17:00' — one regex over all three, since the corridor has
  // all three.
  const cm = /(\d{1,2})\s*:?\s*(\d{2})\s*(?:-|–|to)\s*(\d{1,2})\s*:?\s*(\d{2})/.exec(cond);
  if (cm) {
    const startMin = clockToMin(cm[1], cm[2]);
    const endMin = clockToMin(cm[3], cm[4]);
    if (startMin != null && endMin != null && startMin !== endMin) {
      // School-shaped = says so, or is a weekday window, or is a daytime window that sits entirely
      // inside 07:00-22:00. '60 @ (23:00-05:00)' is none of those and stays "other".
      const daytime = startMin >= 7 * 60 && endMin <= 22 * 60 && endMin > startMin;
      const kind = schoolDays || weekdaysOnly || daytime ? "school" : "other";
      return { limitKmh, kind, window: { type: "clock", weekdaysOnly, startMin, endMin, schoolDays } };
    }
  }
  if (schoolDays || weekdaysOnly) {
    return { limitKmh, kind: "school", window: { type: "clock", weekdaysOnly, startMin: 0, endMin: 24 * 60, schoolDays } };
  }
  return { limitKmh, kind: "other", window: { type: "always" } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2 · SUN TIMES — local, offline, no network, no key
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The standard NOAA sunrise equation (the one SunCalc implements). Everything here is UTC
// milliseconds, so the daylight test never touches a timezone — the one part of this feature that
// CAN be exactly right is kept exactly right.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588, J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

/** Sun altitude at the horizon event, in degrees. */
export const ALT_SUNRISE_DEG = -0.833;   // the disc's upper limb, with refraction
export const ALT_CIVIL_DEG = -6;         // civil twilight — "dawn" and "dusk" in law and in the tags

function toDays(ms: number): number { return ms / DAY_MS - 0.5 + J1970 - J2000; }
function fromJulian(j: number): number { return (j + 0.5 - J1970) * DAY_MS; }

/**
 * UTC ms of the rise/set pair bracketing `nowMs` at `altDeg`. null inside a polar day or night
 * (the sun never reaches that altitude) — callers treat that as "no daylight window", never as
 * "it is dark".
 */
export function sunTimesMs(nowMs: number, lat: number, lng: number, altDeg: number): { rise: number; set: number } | null {
  const lw = RAD * -lng, phi = RAD * lat;
  const d = toDays(nowMs);
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = RAD * (357.5291 + 0.98560028 * ds);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  const jNoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosW = (Math.sin(RAD * altDeg) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (!(cosW >= -1 && cosW <= 1)) return null;         // polar day/night — also catches NaN
  const w = Math.acos(cosW);
  const jSet = J2000 + (0.0009 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const jRise = jNoon - (jSet - jNoon);
  return { rise: fromJulian(jRise), set: fromJulian(jSet) };
}

/** True between the day's rise and set at `altDeg`. */
export function isDaylight(nowMs: number, lat: number, lng: number, altDeg: number): boolean {
  const t = sunTimesMs(nowMs, lat, lng, altDeg);
  if (!t) return false;
  return nowMs >= t.rise && nowMs <= t.set;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3 · THE BC SCHOOL-YEAR TABLE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// HARDCODED AND APPROXIMATE, on purpose, and the spoken line is written so that being wrong costs
// nothing. Districts set their own spring break and non-instructional days and publish them as
// PDFs; there is no feed. What this table buys is silence in July, at Christmas, and on the stat
// holidays — the cases where a "school zone ahead" callout would be pure noise. What it does NOT
// buy is certainty, which is why nothing downstream says the limit is in force.

/** Date-of-month of the `n`th `weekday` (0=Sun) of `month0` (0=Jan). */
function nthWeekday(year: number, month0: number, weekday: number, n: number): number {
  const first = new Date(year, month0, 1).getDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** Easter Sunday (Anonymous Gregorian algorithm) as [month0, day]. */
function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month - 1, ((h + l - 7 * m + 114) % 31) + 1];
}

/** The BC statutory holidays that fall on a weekday inside the school year, as `MM-DD` keys. */
function bcSchoolClosures(year: number): Set<string> {
  const key = (m0: number, d: number) => `${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const out = new Set<string>();
  out.add(key(1, nthWeekday(year, 1, 1, 3)));          // Family Day — 3rd Monday of February (BC)
  out.add(key(9, nthWeekday(year, 9, 1, 2)));          // Thanksgiving — 2nd Monday of October
  out.add(key(10, 11));                                 // Remembrance Day
  const [em, ed] = easter(year);
  const good = new Date(year, em, ed - 2), mon = new Date(year, em, ed + 1);
  out.add(key(good.getMonth(), good.getDate()));        // Good Friday
  out.add(key(mon.getMonth(), mon.getDate()));          // Easter Monday
  // Victoria Day — the Monday on or before May 24.
  const may24 = new Date(year, 4, 24);
  out.add(key(4, 24 - ((may24.getDay() + 6) % 7)));
  return out;
}

/**
 * Is BC school plausibly in session on this LOCAL date? Weekends, summer, winter break, the common
 * spring-break window and the stat holidays are out. Deliberately conservative at the edges: the
 * first week of September and the last week of June are counted IN.
 */
export function bcSchoolDayLikely(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const y = d.getFullYear(), m0 = d.getMonth(), day = d.getDate();
  if (m0 === 6 || m0 === 7) return false;                                  // July, August
  // September starts the day after Labour Day (first Monday).
  if (m0 === 8 && day <= nthWeekday(y, 8, 1, 1)) return false;
  if (m0 === 11 && day >= 20) return false;                                // winter break
  if (m0 === 0 && day <= 3) return false;
  if (m0 === 2 && day >= 14 && day <= 29) return false;                    // spring break — two weeks, district-dependent
  const key = `${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return !bcSchoolClosures(y).has(key);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4 · IS THE ZONE LIVE RIGHT NOW?
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Jeff's instruction was Mo-Fr 08:00-17:00 for school zones, and the tags cannot be trusted to
// agree: the corridor carries 07:00-22:00, 08:00-17:00, 09:00-17:00 and 00:00-24:00 for the same
// kind of zone. The announce window is the INTERSECTION of the tag's own hours with this clamp, so
// a narrower tag (09:00-17:00) is honoured and a wider one (07:00-22:00) cannot make the app talk
// about a school at 9 pm.
export const SCHOOL_CLAMP_START_MIN = 8 * 60;
export const SCHOOL_CLAMP_END_MIN = 17 * 60;

export type ZoneWhen = { kind: "school" | "playground"; window: AheadWindow };

/**
 * Should we announce this zone right now? `now` is a local Date (the device's clock, i.e. the
 * driver's local time — the only timezone that matters for a school bell), `nowMs`/lat/lng feed the
 * sun. Outside the window this returns false and the caller says nothing at all.
 */
export function zoneActive(z: ZoneWhen, now: Date, nowMs: number, lat: number, lng: number): boolean {
  if (z.kind === "playground") {
    const alt = z.window.type === "daylight" && !z.window.civil ? ALT_SUNRISE_DEG : ALT_CIVIL_DEG;
    return isDaylight(nowMs, lat, lng, alt);
  }
  // School.
  if (!bcSchoolDayLikely(now)) return false;
  let start = SCHOOL_CLAMP_START_MIN, end = SCHOOL_CLAMP_END_MIN;
  if (z.window.type === "clock") {
    start = Math.max(start, z.window.startMin);
    end = Math.min(end, z.window.endMin);
  }
  if (end <= start) return false;
  const min = now.getHours() * 60 + now.getMinutes();
  return min >= start && min < end;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5 · THE HEADS-UP — how far ahead, and how far off the nose
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Jeff, 2026-09-21: "Give the speed cameras and playground/school zones a good heads up for
// distance and time."
//
// WHAT IT WAS: a FIXED 100 m radius (app/(app)/map.tsx, the map-speedcam-voice-alert region) — 7.2 s
// of warning at 50 km/h and 3.6 s at 100. That is the complaint.
//
// WHAT IT IS NOW: the same shape nav.ts already uses for turn callouts (nav.ts:1290-1291,
//   imminentM = clamp(spd * IMMINENT_LEAD_S, 60, 250), prepareM = clamp(spd * PREPARE_LEAD_S, 150, 1200)),
// i.e. a constant TIME, clamped. 20 s, floor 200 m, cap 450 m:
//     30 km/h  →  8.33 m/s × 20 =  167 m → floor  200 m → 24.0 s of warning
//     50 km/h  → 13.89 m/s × 20 =  278 m →         278 m → 20.0 s
//    100 km/h  → 27.78 m/s × 20 =  556 m → cap    450 m → 16.2 s
// So every speed gets 16–24 s — roughly a `prepareM` turn cue, which is what "a good heads up"
// means in this app's own vocabulary.
//
// WHY THE CAP IS 450 AND NOT 500: the zone data rides the speed-limit pipeline's Overpass round
// trip (src/speedLimit.ts — FETCH_RADIUS_M 1500, REFETCH_MOVE_M 1000), so the GUARANTEED forward
// coverage is 1500 − 1000 = 500 m, less whatever the in-flight fetch takes. 450 m keeps the lead
// inside that floor with margin at every speed, and the cap only binds above 81 km/h (450/20 =
// 22.5 m/s) — a speed at which school and playground zones do not legally exist. Speed cameras
// come from src/speedCameras.ts's own 40 km cache and have no such frontier at all.
export const AHEAD_LEAD_S = 20;
export const AHEAD_LEAD_MIN_M = 200;
export const AHEAD_LEAD_MAX_M = 450;

export function aheadLeadM(speedMs: number | null | undefined): number {
  const spd = typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 0;
  return Math.min(AHEAD_LEAD_MAX_M, Math.max(AHEAD_LEAD_MIN_M, spd * AHEAD_LEAD_S));
}

/** Below this we are parked or crawling and a "400 m ahead" callout is meaningless. */
export const AHEAD_MIN_SPEED_KMH = 15;

// ── THE FORWARD CORRIDOR ─────────────────────────────────────────────────────────────────────
// A plain radius test cannot be used for railway crossings. MEASURED 2026-09-21 at Jeff's 09-20
// departure point (49.242496,-123.003784): `node[railway=level_crossing]` returns 0 within 2 km,
// 26 within 4 km and 277 within 8 km — they cluster in rail corridors and yards. A 450 m circle is
// 0.64 km²; at that density it would sit on a crossing a large fraction of the time while driving
// a road that never touches the tracks. The existing hazard alert even says so in its own comment
// ("distance-only (no heading cone yet) … a forward-cone filter can be added later").
//
// ⛔ THE 12° CONE WAS THE NEXT STREET OVER (2026-09-22, this feature's first field day, OTA
// 01a0c6c4). It opened at 30 m + along × tan 12°: a 73 m half-width at 200 m, 94 m at 300, 126 m
// at 450 — and a Burnaby block is 100–200 m. Measured from crash_reports that day: 21 alerts on
// two drives (Olaf f1gdt9 13, Say Phin zziett 8), 21/21 kind=railway, `off=` mean 62 m / median 58
// / max 109, only 4 of 21 within 30 m of the driving line. Four fit an exact OSM node to 1–10 m
// once the fix is moved along its heading to the alert instant: a rail spur across a service road
// (n3423769912, off 57), a MINIATURE TOURIST railway over a service path (n12960108594, off 105 —
// Olaf was chimed at for a model railway), Wood Street (n6179357475, off 48) and Robson Road
// (n976349382, off 94). The road each car was actually on, map-matched from its own fixes, never
// came within 25 m of any of them. Rate: Olaf one chime per 90 s, Say Phin four in 37 s. Jeff:
// "FIX ALL ISSUES". The fixtures are the 21 real rows, in tools/sim-qc/ahead_alerts_test.mts.
//
// So the corridor is now TWO rules, and the route one wins whenever there is a route:
//   • THE ROUTE GATE — the feature must lie within ROUTE_GATE_M of the active route's polyline and
//     its along-ROUTE distance from the car must be inside the lead. The route is the road the
//     driver is about to be on: a crossing on the next street over is never within 25 m of it, and
//     a crossing 450 m ahead round a bend is exactly on it where any tangent cone misses. 25 m
//     because speedLimitSnap's SNAP_TOLERANCE_M is 30 for "the road you're on" and offRouteGate's
//     ONROUTE_M is 25 for "on the line" — the tighter one, since a false alert is the complaint.
//     Read-only: the feed consumes NavRoute.coordinates and writes nothing back.
//   • THE FREE-DRIVE CONE — no route (or the car has left it): 25 m at the bumper opening at 5°
//     (tan 0.0875): 42.5 m at 200, 51 m at 300, 64 m at 450. Against the same 21 rows it keeps 6, not
//     21 (the gate pins that). It stays a cone at all because a genuine crossing 450 m ahead on a
//     curve is legitimately off the instantaneous tangent; narrower would lose those.
export const CONE_HALF_MIN_M = 25;
export const CONE_TAN = 0.0875;   // tan(5°)
export const ROUTE_GATE_M = 25;
// The route describes the road under the car only while the car is on it. Past this the app is
// about to reroute anyway (src/offRouteGate.ts REROUTE_DISTANCE_M = 80) and the old polyline says
// nothing about where the car is going, so the cone takes over until the new route lands.
export const ROUTE_CAR_MAX_M = 80;

const EARTH_R = 6371000;

/**
 * Along-track (positive = ahead) and cross-track (absolute) metres from the car to a point, using
 * the car's course as the axis. Returns null without a usable course — a stationary GPS fix has no
 * heading, and guessing one would point the cone at a wall.
 */
export function forwardOffsets(
  lat: number, lng: number, courseDeg: number | null | undefined,
  tLat: number, tLng: number
): { alongM: number; crossM: number } | null {
  if (typeof courseDeg !== "number" || !Number.isFinite(courseDeg) || courseDeg < 0) return null;
  const cosLat = Math.cos(lat * RAD);
  const east = (tLng - lng) * RAD * cosLat * EARTH_R;
  const north = (tLat - lat) * RAD * EARTH_R;
  const h = courseDeg * RAD;                       // compass bearing: 0 = north, clockwise
  const alongM = north * Math.cos(h) + east * Math.sin(h);
  const crossM = Math.abs(-north * Math.sin(h) + east * Math.cos(h));
  return { alongM, crossM };
}

/** Is a point inside the forward corridor for this lead distance? */
export function inCorridor(alongM: number, crossM: number, leadM: number): boolean {
  if (!(alongM > 0) || alongM > leadM) return false;
  return crossM <= CONE_HALF_MIN_M + alongM * CONE_TAN;
}

/** How far past the thing we must get before it can alert again (a return trip re-arms it). */
export function rearmM(leadM: number): number { return leadM * 2; }

// ── THE ROUTE GATE ───────────────────────────────────────────────────────────────────────────
// The active route's decoded geometry, [lng, lat] pairs exactly as NavRoute.coordinates carries
// them (src/mapboxDirections.ts decodePolyline5LngLat, GeoJSON order). Consumed, never mutated.
export type RouteLine = readonly (readonly [number, number])[];

type RouteSeg = { ax: number; ay: number; bx: number; by: number; len: number; cum: number; hdgOk: boolean };
/** The part of the route that can matter this tick, in metres east/north of the car. */
export type RouteWindow = {
  segs: RouteSeg[];
  lat: number; lng: number; kx: number; ky: number;   // the car, and degrees → local metres
  carAlong: number;                                   // route metres at the car's own projection
  carCross: number;                                   // metres from the car to the route
};

// Route metres at every vertex, computed ONCE per polyline object. A route's coordinates never
// change for its life and a reroute is a new array, so identity is the cache key — a 300 km drive
// is tens of thousands of vertices and this must not be walked per fix on four surfaces.
const _cumCache = new WeakMap<object, Float64Array>();
function cumulativeM(poly: RouteLine): Float64Array {
  const hit = _cumCache.get(poly);
  if (hit) return hit;
  const cum = new Float64Array(poly.length);
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const cl = Math.cos(((a[1] + b[1]) / 2) * RAD);
    acc += Math.hypot((b[0] - a[0]) * RAD * cl * EARTH_R, (b[1] - a[1]) * RAD * EARTH_R);
    cum[i] = acc;
  }
  _cumCache.set(poly, cum);
  return cum;
}

function projectOnSeg(s: RouteSeg, x: number, y: number): { t: number; d: number } {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2)) : 0;
  return { t, d: Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy)) };
}

/**
 * The route segments within `reachM` of the car and the car's own place on the route. null when
 * there is no usable route here — fewer than two vertices, nothing within reach, or the car more
 * than ROUTE_CAR_MAX_M off the line — and the caller falls back to the free-drive cone.
 * One pass over the polyline: four comparisons per segment, trigonometry only for the kept few.
 */
export function buildRouteWindow(
  poly: RouteLine | null | undefined, lat: number, lng: number,
  courseDeg: number | null | undefined, reachM: number,
): RouteWindow | null {
  if (!poly || poly.length < 2) return null;
  const cum = cumulativeM(poly);
  const kx = RAD * Math.cos(lat * RAD) * EARTH_R, ky = RAD * EARTH_R;
  const course = typeof courseDeg === "number" && Number.isFinite(courseDeg) && courseDeg >= 0 ? courseDeg * RAD : null;
  const segs: RouteSeg[] = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lng) * kx, by = (b[1] - lat) * ky;
    // Keep any segment whose box touches the reach box — a long rural straight can cross the box
    // with BOTH ends outside it, and dropping that one would drop the road under the car.
    if (Math.max(ax, bx) < -reachM || Math.min(ax, bx) > reachM || Math.max(ay, by) < -reachM || Math.min(ay, by) > reachM) continue;
    const len = cum[i + 1] - cum[i];
    // Does this leg run the way the car is going? The return carriageway of a divided road, or the
    // homeward leg of a loop, passes within metres and is NOT the leg the car is on.
    let hdgOk = true;
    if (course != null && len > 0) {
      let diff = Math.abs(Math.atan2(bx - ax, by - ay) - course);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      hdgOk = diff <= Math.PI / 2;
    }
    segs.push({ ax, ay, bx, by, len, cum: cum[i], hdgOk });
  }
  if (!segs.length) return null;
  // The car's own place: nearest segment, with a leg running against the course pushed back by
  // ROUTE_GATE_M so the same-direction leg wins any near tie.
  let bi = -1, bt = 0, bScore = Infinity, bd = Infinity;
  for (let k = 0; k < segs.length; k++) {
    const { t, d } = projectOnSeg(segs[k], 0, 0);
    const score = d + (segs[k].hdgOk ? 0 : ROUTE_GATE_M);
    if (score < bScore) { bScore = score; bd = d; bi = k; bt = t; }
  }
  if (bi < 0 || bd > ROUTE_CAR_MAX_M) return null;
  return { segs, lat, lng, kx, ky, carAlong: segs[bi].cum + bt * segs[bi].len, carCross: bd };
}

/**
 * Along-ROUTE metres from the car to a point (positive = further along the route) and the point's
 * perpendicular distance to the route. Where the route passes a point more than once, the nearest
 * pass AHEAD of the car inside the gate wins — a loop route must call the crossing at 300 m, not
 * at the 5 km return. With no such pass, the nearest pass is reported so the receipt can say why.
 */
export function routeOffsets(win: RouteWindow, lat: number, lng: number): { alongM: number; crossM: number } {
  const x = (lng - win.lng) * win.kx, y = (lat - win.lat) * win.ky;
  let best: { alongM: number; crossM: number } | null = null;
  let nearest: { alongM: number; crossM: number } | null = null;
  for (const s of win.segs) {
    const { t, d } = projectOnSeg(s, x, y);
    const alongM = s.cum + t * s.len - win.carAlong;
    if (!nearest || d < nearest.crossM) nearest = { alongM, crossM: d };
    if (d <= ROUTE_GATE_M && alongM > 0 && (!best || alongM < best.alongM)) best = { alongM, crossM: d };
  }
  return best ?? (nearest as { alongM: number; crossM: number });
}

/** The route gate itself: on the line, and ahead of the car inside the lead. */
export function inRouteGate(alongM: number, crossM: number, leadM: number): boolean {
  return alongM > 0 && alongM <= leadM && crossM <= ROUTE_GATE_M;
}

// ── PICKING THE ONE THING TO CALL OUT ────────────────────────────────────────────────────────
// A feature is a point (a camera, a level crossing) or a road segment (a school/playground zone,
// which is tagged on the WAY, so its nearest vertex is where the zone starts from here). One hit
// per tick, the nearest qualifying one, so two things 40 m apart never talk over each other.

export type AheadFeature = {
  id: string;
  kind: AheadKind;
  lat: number;
  lng: number;
  /** Zone ways carry their geometry; the nearest vertex inside the corridor is the hit. */
  geom?: { lat: number; lng: number }[];
  /** The zone's own limit (km/h) for the spoken line. null for cameras and crossings. */
  limitKmh?: number | null;
  /** Present on zones: when the limit is actually in force. */
  when?: ZoneWhen;
};

export type AheadHit = { feature: AheadFeature; lat: number; lng: number; alongM: number; crossM: number; leadM: number; via: "route" | "cone" };

/**
 * What one scan looked at and threw away — the receipt that lets the next drive prove a crossing
 * was NOT missed. Until 2026-09-22 there was a row only when a hit was picked, so a silent drive
 * past a real crossing and a drive with no crossings near it looked identical.
 */
export type AheadScanStats = {
  considered: number;                 // features inside the lead box, switched on, in force
  rejected: number;                   // of those, thrown out by the corridor
  via: "route" | "cone" | "none";     // which corridor ran ("none": no route and no course — nothing can be aimed)
  rejects: { id: string; kind: AheadKind; alongM: number; crossM: number }[];   // closest to the corridor first
};
export const REJECTS_PER_SCAN = 8;

/** Straight-line metres to the nearest point of a feature — used for the re-arm test, not for the alert. */
export function featureDistM(f: AheadFeature, lat: number, lng: number): number {
  const cosLat = Math.cos(lat * RAD);
  const d = (p: { lat: number; lng: number }) =>
    Math.hypot((p.lng - lng) * RAD * cosLat * EARTH_R, (p.lat - lat) * RAD * EARTH_R);
  let best = d(f);
  for (const p of f.geom ?? []) best = Math.min(best, d(p));
  return best;
}

/**
 * The nearest feature inside the corridor that is switched on and (for a zone) actually in force
 * right now. With a route, and the car on it, the corridor is THE ROUTE GATE and `alongM` is
 * along-route metres — the distance the spoken line then says; otherwise it is the free-drive cone
 * off the car's course. Returns null when there is nothing to say — including when the car is too
 * slow for the callout to mean anything, or has neither a route nor a course to aim with. `stats`,
 * when given, is filled with what the scan considered and rejected: the receipt.
 */
export function pickAheadHit(
  features: AheadFeature[],
  lat: number, lng: number,
  courseDeg: number | null | undefined,
  speedMs: number | null | undefined,
  now: Date, nowMs: number,
  isOn: (kind: AheadKind) => boolean,
  route?: RouteLine | null,
  stats?: AheadScanStats,
): AheadHit | null {
  const kmh = (speedMs ?? 0) * 3.6;
  if (!(kmh >= AHEAD_MIN_SPEED_KMH)) return null;
  const leadM = aheadLeadM(speedMs);
  const win = buildRouteWindow(route, lat, lng, courseDeg, leadM + ROUTE_GATE_M);
  const via: "route" | "cone" = win ? "route" : "cone";
  const hasCourse = typeof courseDeg === "number" && Number.isFinite(courseDeg) && courseDeg >= 0;
  if (stats) { stats.via = win ? "route" : hasCourse ? "cone" : "none"; stats.considered = 0; stats.rejected = 0; stats.rejects = []; }
  // Cheap bounding reject before any trigonometry. The cache holds thousands of features and this
  // runs per fix on four surfaces; a degree box costs two subtractions and throws away everything
  // that is not within the lead in either axis.
  const dLat = leadM / 111320;
  const dLng = dLat / Math.max(0.05, Math.cos(lat * RAD));
  let best: AheadHit | null = null;
  for (const f of features) {
    if (!isOn(f.kind)) continue;
    if (f.when && !zoneActive(f.when, now, nowMs, lat, lng)) continue;
    const pts = f.geom && f.geom.length ? f.geom : [{ lat: f.lat, lng: f.lng }];
    let seen = false;
    let keep: { lat: number; lng: number; alongM: number; crossM: number } | null = null;
    let nearestRej: { alongM: number; crossM: number } | null = null;
    for (const p of pts) {
      if (Math.abs(p.lat - lat) > dLat || Math.abs(p.lng - lng) > dLng) continue;
      seen = true;
      const o = win ? routeOffsets(win, p.lat, p.lng) : forwardOffsets(lat, lng, courseDeg, p.lat, p.lng);
      if (!o) continue;
      const ok = win ? inRouteGate(o.alongM, o.crossM, leadM) : inCorridor(o.alongM, o.crossM, leadM);
      if (ok) { if (!keep || o.alongM < keep.alongM) keep = { lat: p.lat, lng: p.lng, alongM: o.alongM, crossM: o.crossM }; }
      else if (!nearestRej || o.crossM < nearestRej.crossM) nearestRej = o;
    }
    if (!seen) continue;
    if (stats) stats.considered += 1;
    if (keep) {
      if (!best || keep.alongM < best.alongM) best = { feature: f, lat: keep.lat, lng: keep.lng, alongM: keep.alongM, crossM: keep.crossM, leadM, via };
    } else if (stats) {
      stats.rejected += 1;
      if (nearestRej) stats.rejects.push({ id: f.id, kind: f.kind, alongM: nearestRej.alongM, crossM: nearestRej.crossM });
    }
  }
  if (stats && stats.rejects.length > 1) {
    stats.rejects.sort((a, b) => a.crossM - b.crossM);
    if (stats.rejects.length > REJECTS_PER_SCAN) stats.rejects.length = REJECTS_PER_SCAN;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6 · WHAT NOVA SAYS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Short, because the line has to LAND before the thing it describes: at the 200 m floor the driver
// has ~24 s, but at the 450 m cap and 100 km/h only 16 s, and Nova may be queued behind a turn
// callout. Every line carries the distance, so "distance and time" are both served — the distance
// is spoken, the time is the 20 s lead that chose the moment.
//
// The school wording is Jeff's requirement verbatim — "thirty when school's in" — and it is
// deliberately a hedge, not a statement of the limit: see the school-calendar note at the top.

/** Spell a limit for TTS so "30" is never read as a year or a street number. */
export function spellLimit(kmh: number, mph: boolean): string {
  const v = mph ? Math.round((kmh / 1.609344) / 5) * 5 : kmh;
  const ones = ["zero", "ten", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (v % 10 === 0 && v < 100) return ones[v / 10];
  return String(v);
}

/**
 * The spoken line. `distText` is already formatted in the driver's unit by the caller (nav.ts's
 * formatDistance), which is also what the turn callouts speak, so the two read alike.
 */
/** The five camera lines the old speed-camera effect used, now carrying the distance. Rotates
 *  rather than randomising so a drive cannot say the same one twice in a row. */
const CAMERA_LINES = [
  (d: string) => `Speed camera ahead in ${d}.`,
  (d: string) => `Heads up — speed camera in ${d}.`,
  (d: string) => `Speed camera in ${d}, watch your speed.`,
  (d: string) => `Camera in ${d} — ease off a touch.`,
  (d: string) => `Speed camera in ${d}, keep it legal.`,
];
let _cameraLineAt = 0;
export function pickCameraLine(distText: string): string {
  const f = CAMERA_LINES[_cameraLineAt % CAMERA_LINES.length];
  _cameraLineAt += 1;
  return f(distText);
}

export function aheadLine(kind: AheadKind, distText: string, limitKmh: number | null, mph: boolean): string {
  switch (kind) {
    case "school":
      return `School zone ahead in ${distText} — ${spellLimit(limitKmh ?? 30, mph)} when school's in.`;
    case "playground":
      return `Playground zone ahead in ${distText} — ${spellLimit(limitKmh ?? 30, mph)} until dusk.`;
    case "railway":
      return `Railway crossing ahead in ${distText}.`;
    case "camera":
      // THE CAMERA LINE KEPT ITS CHARACTER (2026-09-21). The effect this replaced picked at random
      // from five: "Speed camera ahead." / "Heads up, speed camera coming up." / "Speed camera
      // ahead, watch your speed." / "Camera ahead — ease off a touch." / "Speed camera just ahead,
      // keep it legal." Flattening that to one sentence would have been a quiet downgrade nobody
      // asked for, so the variants live on with the distance folded in. Zones get ONE line each on
      // purpose — theirs carries a limit, and a limit should always sound the same.
      return pickCameraLine(distText);
  }
}
