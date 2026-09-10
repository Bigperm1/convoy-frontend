// trip_odometer_test — a drive is credited the distance the car COVERED, not the distance the
// route planned. Replays the four impossible rows measured in Jeff's own history.
//
// FIELD DATA (public.trips, queried 2026-09-09). Every one of these is a real stored row:
//   handle Jeff, 2026-09-06 16:28:49Z  17.22 km / 139.368 s / top_speed 0  -> 445 km/h average
//   handle Jeff, 2026-09-06 15:54:15Z  17.22 km / 139.264 s / top_speed 0  -> 445 km/h
//   handle Jeff, 2026-09-06 06:57:15Z  17.21 km / 139.737 s / top_speed 0  -> 443 km/h
//   handle Jeff, 2026-09-06 06:10:59Z  17.20 km / 139.674 s / top_speed 0  -> 443 km/h
// 68.9 km of his 1,989.5 km lifetime total, on the club leaderboard, never driven.
// Real drives from the same table must all survive the guard - they are asserted below too.
import {
  odoStart, odoAdd, odoMeters, isPlausibleDrive, haversineM, creditedDistanceM,
  ODO_MIN_STEP_M, ODO_MAX_ACC_M, ODO_MAX_GAP_S, ODO_MAX_SPEED_MS, PLAUSIBLE_MAX_AVG_KMH, ODO_MIN_TRIP_M,
} from "../../src/tripOdometer.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// A metre of latitude is ~1/111320 deg; used to build synthetic straight-line drives.
const M = 1 / 111320;
const LAT0 = 49.1191, LNG0 = -122.8328;   // Surrey BC, where these drives happened

/** Walk north at a constant speed, one fix per second. */
function drive(seconds: number, speedMs: number, startAt = 1_700_000_000_000, accM?: number) {
  let s = odoStart();
  for (let i = 0; i <= seconds; i++) {
    s = odoAdd(s, { lat: LAT0 + i * speedMs * M, lng: LNG0, at: startAt + i * 1000, accM, speedMs });
  }
  return s;
}

/** A phone sitting still, jittering by +/- `ampM`, for `seconds`. `speedMs` may be omitted. */
function parked(seconds: number, ampM: number, speedMs?: number) {
  let s = odoStart();
  for (let i = 0; i <= seconds; i++) {
    const jitter = (((i * 7919) % (2 * ampM + 1)) - ampM);   // deterministic, -amp..+amp
    s = odoAdd(s, { lat: LAT0 + jitter * M, lng: LNG0, at: 1_700_000_000_000 + i * 1000, accM: 8, speedMs });
  }
  return s;
}

// ── A. the four phantom rows are REJECTED ───────────────────────────────────────────────────
const PHANTOM = [
  { km: 17.22, s: 139.368 }, { km: 17.22, s: 139.264 },
  { km: 17.21, s: 139.737 }, { km: 17.20, s: 139.674 },
];
PHANTOM.forEach((r, i) => {
  const kmh = (r.km) / (r.s / 3600);
  ok(`A${i + 1} phantom row rejected`, !isPlausibleDrive(r.km * 1000, r.s), `${r.km} km / ${r.s}s = ${kmh.toFixed(0)} km/h`);
});
ok("A5 all four rejected", PHANTOM.every((r) => !isPlausibleDrive(r.km * 1000, r.s)));
ok("A6 they total 68.9 km", near(PHANTOM.reduce((a, r) => a + r.km, 0), 68.85, 0.05));

// ── B. Jeff's REAL drives all survive — the guard must not eat a fast drive ─────────────────
// Real rows from public.trips, same handle, same table.
const REAL = [
  { km: 32.68, s: 24.2 * 60 }, { km: 287.15, s: 136.5 * 60 }, { km: 103.90, s: 68.0 * 60 },
  { km: 312.20, s: 177.1 * 60 }, { km: 208.83, s: 100.2 * 60 }, { km: 31.90, s: 30.4 * 60 },
  { km: 1.48, s: 2.7 * 60 }, { km: 1.76, s: 2.1 * 60 }, { km: 33.85, s: 26.0 * 60 },
];
REAL.forEach((r, i) => {
  const kmh = r.km / (r.s / 3600);
  ok(`B${i + 1} real drive kept`, isPlausibleDrive(r.km * 1000, r.s), `${kmh.toFixed(0)} km/h avg`);
});
ok("B10 fastest real average is well under the cap",
  Math.max(...REAL.map((r) => r.km / (r.s / 3600))) < PLAUSIBLE_MAX_AVG_KMH,
  `max ${Math.max(...REAL.map((r) => r.km / (r.s / 3600))).toFixed(0)} km/h`);

// ── C. the odometer measures a real drive ───────────────────────────────────────────────────
{
  const s = drive(600, 25);                    // 10 min at 90 km/h = 15 km
  ok("C1 600 s at 25 m/s ≈ 15 km", near(odoMeters(s), 15000, 60), `${odoMeters(s)} m`);
  ok("C2 nothing skipped on a clean drive", s.skippedAcc + s.skippedJump + s.skippedGap + s.skippedStopped === 0);
}
{
  const s = drive(120, 2.5);                   // slow crawl, 9 km/h -> 300 m
  ok("C3 a slow crawl still counts", near(odoMeters(s), 300, 15), `${odoMeters(s)} m`);
}

// ── D. THE PHANTOM CASE — a parked phone must integrate to ~zero ────────────────────────────
// This is what actually happened: a route was plotted, the car never moved, arrival fired.
// The FIRST version of this module failed exactly here — a 5 m floor let +/-3 m of ordinary
// urban noise invent 121 m in 140 s (3 km per hour of standing still). Hence the 12 m floor
// AND the stopped-speed gate.
{
  const s = parked(140, 3, 0);                 // the real case: GPS reports stopped
  ok("D1 parked, speed reported: EXACTLY zero", odoMeters(s) === 0, `${odoMeters(s)} m over 140 s`);
  ok("D2 and every fix was refused as stopped", s.skippedStopped === 140, `${s.skippedStopped}`);
}
{
  const s = parked(140, 3);                    // platform gives no speed: floor must carry it
  ok("D3 parked, no speed reported: still zero", odoMeters(s) === 0, `${odoMeters(s)} m`);
}
{
  const s = parked(3600, 5);                   // an HOUR parked, no speed, 5 m noise
  ok("D4 an hour parked invents nothing", odoMeters(s) === 0, `${odoMeters(s)} m over 3600 s`);
}
{
  const s = parked(3600, 3, 0.2);              // an hour parked, engine idling
  ok("D5 an hour idling invents nothing", odoMeters(s) === 0, `${odoMeters(s)} m`);
}
{
  // NEGATIVE CONTROLS, driving the REAL module — each gate must be load-bearing.
  // Noise LARGER than the 12 m floor, and no speed reported: the floor alone cannot hold
  // this, and the odometer does invent distance. That is not a bug in the test, it is the
  // honest limit of a distance-only filter, and it is exactly why the stopped gate exists.
  const noSpeed = parked(140, 20);
  ok("D6 +/-20 m noise with NO speed does accumulate (the floor alone is not enough)",
    odoMeters(noSpeed) > 0, `${odoMeters(noSpeed)} m`);
  // Same noise, but the platform reports the car stopped: must be exactly zero.
  const withSpeed = parked(140, 20, 0);
  ok("D6b the stopped gate holds it at zero anyway", odoMeters(withSpeed) === 0, `${odoMeters(withSpeed)} m`);
  ok("D6c so the two gates together are strictly stronger than either alone",
    odoMeters(noSpeed) > 0 && odoMeters(withSpeed) === 0);
}
{
  const s = parked(140, 3, 0);
  ok("D7 so the 17.2 km could never have been banked", odoMeters(s) < 500);
}

// ── E. the gates each do their job ──────────────────────────────────────────────────────────
{
  const s0 = odoStart();
  const s1 = odoAdd(s0, { lat: LAT0, lng: LNG0, at: 1000, accM: ODO_MAX_ACC_M + 1 });
  ok("E1 a too-vague fix is refused", s1.anchor === null && s1.skippedAcc === 1);
}
{
  let s = odoAdd(odoStart(), { lat: LAT0, lng: LNG0, at: 1000 });
  s = odoAdd(s, { lat: LAT0 + 5000 * M, lng: LNG0, at: 2000 });   // 5 km in 1 s
  ok("E2 a teleport claims no distance", odoMeters(s) === 0 && s.skippedJump === 1);
  ok("E3 but it RE-ANCHORS, so the drive continues from there", s.anchor?.at === 2000);
}
{
  let s = odoAdd(odoStart(), { lat: LAT0, lng: LNG0, at: 1000 });
  s = odoAdd(s, { lat: LAT0 + 1000 * M, lng: LNG0, at: 1000 + (ODO_MAX_GAP_S + 10) * 1000 });
  ok("E4 a long gap claims no distance", odoMeters(s) === 0 && s.skippedGap === 1);
}
{
  let s = odoAdd(odoStart(), { lat: LAT0, lng: LNG0, at: 1000 });
  const before = s.anchor;
  s = odoAdd(s, { lat: LAT0 + (ODO_MIN_STEP_M - 2) * M, lng: LNG0, at: 2000 });
  ok("E5 a sub-floor step adds nothing", odoMeters(s) === 0);
  ok("E6 and HOLDS the anchor so slow creep is not swallowed", s.anchor === before);
  // creeping past the floor from the SAME anchor must then register
  s = odoAdd(s, { lat: LAT0 + (ODO_MIN_STEP_M + 3) * M, lng: LNG0, at: 3000 });
  ok("E7 creeping past the floor registers", odoMeters(s) >= ODO_MIN_STEP_M, `${odoMeters(s)} m`);
}
{
  let s = odoAdd(odoStart(), { lat: LAT0, lng: LNG0, at: 5000 });
  const s2 = odoAdd(s, { lat: LAT0 + 100 * M, lng: LNG0, at: 4000 });   // clock went backwards
  ok("E8 an out-of-order fix is ignored", odoMeters(s2) === 0 && s2.anchor?.at === 5000);
}
{
  const s = odoAdd(odoStart(), { lat: NaN, lng: LNG0, at: 1000 });
  ok("E9 a NaN fix cannot poison the state", s.anchor === null && odoMeters(s) === 0);
}

// ── F. purity + the maths ───────────────────────────────────────────────────────────────────
{
  const a = odoStart();
  const b = odoAdd(a, { lat: LAT0, lng: LNG0, at: 1000 });
  ok("F1 odoAdd does not mutate", a.anchor === null && b.anchor !== null);
  ok("F2 haversine 1 km north", near(haversineM(LAT0, LNG0, LAT0 + 1000 * M, LNG0), 1000, 2));
  ok("F3 haversine is zero for a point", haversineM(LAT0, LNG0, LAT0, LNG0) === 0);
}

// ── G. negative controls for isPlausibleDrive ───────────────────────────────────────────────
ok("G1 zero distance is not a drive", !isPlausibleDrive(0, 600));
ok("G2 zero duration is not a drive", !isPlausibleDrive(5000, 0));
ok("G3 exactly at the cap is allowed", isPlausibleDrive(PLAUSIBLE_MAX_AVG_KMH * 1000, 3600));
ok("G4 just over the cap is refused", !isPlausibleDrive(PLAUSIBLE_MAX_AVG_KMH * 1000 + 1000, 3600));
ok("G5 the old code path would have ACCEPTED the phantom (proves the gate is load-bearing)",
  PHANTOM.every((r) => r.km * 1000 >= 500));   // the ONLY old guard was distance >= 500 m

// ── H. THE SEAM — a MEASURED ZERO must never fall back to the planned route ─────────────────
// Codex adversarial review, 2026-09-09: the first version of the fix treated travelledM === 0
// as "no reading" and fell back to the route. A driver who plots a 5 km route, never moves and
// presses End was credited 5 km at 150 km/h average — the ORIGINAL phantom bug, alive inside
// its own fix, and now reachable from the End button too.
{
  const z = creditedDistanceM(5000, 0);
  ok("H1 a measured ZERO is authoritative", z.m === 0 && z.src === "odo", `${z.m} m src=${z.src}`);
  ok("H2 and is therefore below the record floor", z.m < ODO_MIN_TRIP_M);
  ok("H3 the 5 km route is NOT credited", z.m !== 5000);
}
{
  const r = creditedDistanceM(5000, undefined);
  ok("H4 no reading at all falls back to the route", r.m === 5000 && r.src === "route");
  const n = creditedDistanceM(5000, null);
  ok("H5 null is also 'no reading'", n.m === 5000 && n.src === "route");
  const nan = creditedDistanceM(5000, Number.NaN);
  ok("H6 NaN is 'no reading', not zero", nan.m === 5000 && nan.src === "route");
}
{
  const p = creditedDistanceM(5000, 4820);
  ok("H7 a real reading wins over the route", p.m === 4820 && p.src === "odo");
  const longer = creditedDistanceM(5000, 6100);
  ok("H8 a detour is credited ABOVE the planned route", longer.m === 6100 && longer.src === "odo");
}
{
  // the four phantom rows, replayed through the whole decision
  const stationary = creditedDistanceM(17220, 0);
  ok("H9 Jeff's 17.2 km phantom is credited 0 m", stationary.m === 0);
  ok("H10 and would be skipped, not banked", stationary.m < ODO_MIN_TRIP_M);
}

console.log(fails === 0 ? "\nPASS trip_odometer" : `\nFAIL trip_odometer (${fails})`);
if (fails) process.exit(1);
