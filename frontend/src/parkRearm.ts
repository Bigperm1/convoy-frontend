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
// apart, and the 26 km/h reading came 14 s and 44 m after a 10 km/h one (3.1 m/s average). Whether he was in a car
// for those seconds is not in the data; that the marker and the spot left the car on that evidence is.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────────────────────
// While a witnessed park stands, the latch may re-arm (and the witness clear) only on SUSTAINED vehicular evidence:
//  • a RUN starts at the first fix >= the entry speed (DRIVING_ENTER_SPEED_MS, 15 km/h);
//  • a fix below the hold speed (DRIVING_SPEED_MS, 9 km/h) ends the run — a red light starts it over;
//  • so does a gap of more than PARK_REARM_MAX_GAP_MS with no fix at all (nothing was "held" through it);
//  • the park is re-armed on a fix >= the entry speed once the run has lasted PARK_REARM_SUSTAIN_MS AND that fix is
//    at least PARK_REARM_MIN_M in a straight line from the run's first fix.
// A head-unit reconnect still clears the witness at once (locationPrivacy.noteCarConnected, unchanged), so a normal
// CarPlay / Android Auto drive is live from its first fix. With no witnessed park nothing here runs.
//
// Pure: no react-native imports. The two speeds are passed in by src/locationPrivacy.ts (their owner), so this rule
// can never drift from them; gate tools/sim-qc/park_rearm_test.mts drives the real noteFix with Jeff's fixes.

// 15 s of continuous vehicular fixes (the rule as specified 2026-09-25). His rows show vehicular readings at
// 17:13:10.094 (26 km/h) and 17:13:13.947 (29 km/h); draw-cmp is throttled, so how long they lasted is NOT known —
// the displacement below is what refuses that episode on any duration. A car at 36 km/h reaches 150 m in 15 s.
export const PARK_REARM_SUSTAIN_MS = 15_000;
// 150 m straight-line from the run's first fix (as specified 2026-09-25). Measured against his episode: no two
// recorded positions more than 64.9 m apart — a 2.3× margin; a car at 20 km/h covers 150 m in 27 s.
export const PARK_REARM_MIN_M = 150;
// A fix must keep arriving for the run to count as "held". iOS delivers this app's navigation feeds at ~1 Hz while
// moving (navNotification.ts drive-time location note, "delivery ~1 Hz measured"); the Lite GPS phone watcher's 8 m
// distance filter at the 15 km/h entry speed (4.17 m/s) passes a fix every ~2 s. 5 s = more than two missed fixes on
// the slowest feed.
export const PARK_REARM_MAX_GAP_MS = 5_000;

export type ParkRearm = {
  /** Feed every fix while a witnessed park stands. True once the re-arm is PROVEN (and stays true until reset). */
  note(now: number, lat: number, lng: number, spdMs: number): boolean;
  /** Forget the run (the witness is gone — a connect, or the park was re-armed). */
  reset(): void;
};

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function createParkRearm(speeds: { enterMs: number; holdMs: number }): ParkRearm {
  let run: { t0: number; lat0: number; lng0: number; lastAt: number } | null = null;
  let proven = false;
  return {
    note(now, lat, lng, spdMs) {
      if (proven) return true;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
      const spd = Number.isFinite(spdMs) ? spdMs : 0;
      if (run && (now - run.lastAt > PARK_REARM_MAX_GAP_MS || now < run.lastAt)) run = null;   // not held (or the clock went back)
      if (spd < speeds.holdMs) { run = null; return false; }                                   // stopped / walking: start over
      if (!run) {
        if (spd < speeds.enterMs) return false;                                                // 9–15 km/h cannot START a run
        run = { t0: now, lat0: lat, lng0: lng, lastAt: now };
        return false;
      }
      run.lastAt = now;
      if (spd >= speeds.enterMs && now - run.t0 >= PARK_REARM_SUSTAIN_MS && metres(run.lat0, run.lng0, lat, lng) >= PARK_REARM_MIN_M) {
        proven = true;
        run = null;
      }
      return proven;
    },
    reset() { run = null; proven = false; },
  };
}
