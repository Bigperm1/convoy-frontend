// parkRearm.ts — after a WITNESSED park, what it takes to believe the phone is driving again (privacy, 2026-09-25).
//
// Jeff, 2026-09-25: "i think the connection is following me after the carplay dissconnect. it should not follow me
// when i discconect from car play... this is a privacy concern. fix it and lock it." Asked what followed him:
// "My icon moved on the map."
//
// ── WHAT HAPPENED (crash_reports, handle Jeff, update 01a0d804, SELECT only; times UTC) ───────────────────────────
//   17:08:20.898  carplay-disconnect app=background nav=0 fix=1        → a witnessed park (locationPrivacy _parkWitnessed)
//   17:12:34.136  draw-cmp surf=phone mode=pin … gps=withheld … latch=0 parked=1 hu=1   (pinned at the car spot)
//   17:12:46.676  aa-appstate state=active                              (he opened the app, walking)
//   17:12:56.093  draw-cmp surf=car mode=raw spd=10 … gps=49.173237,-122.665995 latch=0 parked=1 hu=1
//   17:13:10.094  draw-cmp surf=phone mode=raw spd=26 acc=14m … gps=49.173337,-122.665408 latch=1 parked=0 hu=0
//   17:14:14.089  draw-cmp surf=phone mode=raw spd=7 acc=16m … gps=49.173417,-122.666179 latch=1 parked=0 hu=0 spotAge=59s
// ONE fix at >= DRIVING_ENTER_SPEED_MS (15 km/h) armed the driving latch, and in the SAME noteFix call `driving`
// cleared the witnessed park — so shareablePosition shared LIVE coordinates, the marker left the car and drew him
// walking, and the car spot itself was rewritten at his walking position (spotAge=59s at 17:14:14). No two of the
// recorded positions in that stretch (the car spot 49.172938,-122.666060 and the three gps= fixes) are more than 65 m
// apart, and the 26 km/h reading came 14 s and 44 m after a 10 km/h one (3.1 m/s average).
// Walking with a phone reports vehicular speeds more than once: 08-29 20:00:46–20:01:17Z (same handle) read 9, 16,
// 12 and 7 km/h while the positions drifted 67 m in 20.5 s, then ONE multipath fix 338 m away at 51 km/h
// (20:01:28.633, 49.173307,-122.660864) and the same coordinate again 41 s later at 49 km/h (20:02:09.411).
//
// ── THE RULE (v2, 2026-09-25 review) ─────────────────────────────────────────────────────────────────────────────
// v1 (a contiguous 15 s run at >= 15 km/h, reset below 9 km/h, 150 m from the run's first fix) never proved a real
// drive on a stop-sign grid with blocks under ~160 m or in stop-and-go traffic (review script s_edges.mts: 20 blocks of
// 100 m at 30 km/h "STILL PINNED after 370 s / 2000 m"), and its two-point displacement let ONE outlier supply the
// distance. v2 looks at the last PARK_REARM_WINDOW_MS of fixes and re-arms only when ALL of these hold:
//  • VEHICULAR TIME: >= PARK_REARM_VEHICULAR_MS of it credited to fixes at >= the entry speed (15 km/h). A fix earns
//    credit only if it actually MOVED at least PARK_REARM_MOVE_RATIO of what its own speed claims since the previous
//    fix (a phone stuck on a multipath coordinate while reporting 50 km/h earns nothing), and at most
//    PARK_REARM_FIX_CREDIT_MS per fix (a fix after a gap cannot claim the gap). Stops do not reset anything.
//  • NET DISPLACEMENT: >= PARK_REARM_MIN_M between the window's start and now, both taken as the component-wise MEDIAN
//    of three fixes (the window's first three, the last three), so one outlier can supply neither end.
//  • AWAY FROM THE CAR: the robust current position is >= PARK_REARM_MIN_M from the witnessed car spot.
// A head-unit reconnect still clears the witness at once (locationPrivacy.noteCarConnected), so a CarPlay / Android
// Auto drive is live from its first fix. With no witnessed park nothing here runs; every new witness resets it.
//
// Pure: no react-native imports. The entry speed is passed in by src/locationPrivacy.ts (its owner), so this rule can
// never drift from it; gate tools/sim-qc/park_rearm_test.mts drives the real noteFix (his walks, grids, stop-and-go,
// a highway pull-away, outliers) and pins these values.

// The look-back. Walking is 1.4–1.6 m/s (a brisk 2.0 m/s at most), so a walker covers at most 1.6 × 120 = 192 m
// (2.0 × 120 = 240 m) of net displacement inside it — below PARK_REARM_MIN_M whatever the GPS says about speed.
export const PARK_REARM_WINDOW_MS = 120_000;
// 15 s credited at >= 15 km/h (the rule's 15 s as specified 2026-09-25, now accumulated instead of contiguous).
// Computed for the slowest case the gate drives, stop-and-go peaking at 20 km/h every 20 s (a half-sine): the speed is
// >= 15 km/h for 1 − 2·asin(0.75)/π = 46 % of the time, so 15 s accrue in ~33 s.
export const PARK_REARM_VEHICULAR_MS = 15_000;
// 250 m, both as net displacement inside the window and as distance from the witnessed spot. Above the walking bound
// (192 m, brisk 240 m) and 3.8× the largest spread of Jeff's recorded 09-25 walk (64.9 m); a car averaging the
// slowest gated stop-and-go (2/π × 20 km/h = 3.5 m/s) covers it in 71 s, a 100 m stop-sign grid at 30 km/h
// (≈ 5.7 m/s average with 3 s stops) in ~44 s, a pull-away at 1 m/s² to 40 km/h in ~28 s.
export const PARK_REARM_MIN_M = 250;
// A fix is credited only if it moved >= half of speed × Δt since the previous fix. Real fixes at >= 15 km/h move
// >= 4.2 m/s against a few metres of GPS noise; Jeff's 09-25 walk moved 3.1 m/s while reading 26 km/h (7.2 m/s) → 0.43.
export const PARK_REARM_MOVE_RATIO = 0.5;
// The most one fix may credit. The feeds deliver every <= 2 s at 15 km/h: iOS ~1 Hz while moving (navNotification.ts
// drive-time note, "delivery ~1 Hz measured"), the Lite GPS phone watcher's 8 m filter at 4.17 m/s every 1.9 s.
export const PARK_REARM_FIX_CREDIT_MS = 2_000;

export type ParkRearm = {
  /** Feed every fix while a witnessed park stands. True once the re-arm is PROVEN (and stays true until reset). */
  note(now: number, lat: number, lng: number, spdMs: number, spot?: { lat: number; lng: number } | null): boolean;
  /** Forget everything (a new witness, a connect, or no witness any more). */
  reset(): void;
};

type P = { lat: number; lng: number };
export function metres(a: P, b: P): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const med3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
const median3 = (x: P, y: P, z: P): P => ({ lat: med3(x.lat, y.lat, z.lat), lng: med3(x.lng, y.lng, z.lng) });

export function createParkRearm(speeds: { enterMs: number }): ParkRearm {
  let fixes: { t: number; lat: number; lng: number; credit: number }[] = [];
  let prev: { t: number; lat: number; lng: number } | null = null;
  let proven = false;
  return {
    note(now, lat, lng, spdMs, spot) {
      if (proven) return true;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(now)) return false;
      const spd = Number.isFinite(spdMs) ? spdMs : 0;
      if (prev && now < prev.t) { fixes = []; prev = null; }                    // the clock went back: start over
      let credit = 0;
      if (prev && spd >= speeds.enterMs) {
        const dt = now - prev.t;
        if (dt > 0 && metres(prev, { lat, lng }) >= PARK_REARM_MOVE_RATIO * spd * (dt / 1000)) credit = Math.min(dt, PARK_REARM_FIX_CREDIT_MS);
      }
      prev = { t: now, lat, lng };
      fixes.push({ t: now, lat, lng, credit });
      while (fixes.length && fixes[0].t < now - PARK_REARM_WINDOW_MS) fixes.shift();
      const n = fixes.length;
      if (n < 3) return false;
      let vehicular = 0;
      for (const f of fixes) vehicular += f.credit;
      if (vehicular < PARK_REARM_VEHICULAR_MS) return false;
      const from = median3(fixes[0], fixes[1], fixes[2]);
      const here = median3(fixes[n - 3], fixes[n - 2], fixes[n - 1]);
      if (metres(from, here) < PARK_REARM_MIN_M) return false;
      if (spot && Number.isFinite(spot.lat) && Number.isFinite(spot.lng) && metres(spot, here) < PARK_REARM_MIN_M) return false;
      proven = true;
      fixes = []; prev = null;
      return true;
    },
    reset() { fixes = []; prev = null; proven = false; },
  };
}
