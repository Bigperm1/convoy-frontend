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
// ── THE RULE (v4, 2026-09-25, fifth review) ──────────────────────────────────────────────────────────────────────
// v1 (a contiguous 15 s run at >= 15 km/h, reset below 9 km/h, 150 m from the run's first fix) never proved a drive on a
// stop-sign grid or in stop-and-go traffic. v2 (15 s credited within 120 s, 250 m of median-of-3 displacement) fixed
// that, but its median survived ONE outlier and a jump earned its own credit (review-priv3/c_logic.mts N=14). v3 added
// jump rejection, median-of-5 endpoints and span consistency, plus a SLOW congestion path (30 s of credit within 10 min,
// 300 m from the spot) — and that path un-pinned noisy walkers: 88–189 of 200 straight walkers with 8–12 m GPS noise and
// 1 in 10 single-fix 15–18 km/h readings, and 167 of 200 phones that walked 350 m and then sat in a café
// (review-priv4 walker_cadence / sit_after_walk). v4 REMOVES the slow path and judges coverage against real time:
//  • JUMPS: a fix further from the previous ACCEPTED fix than max(PARK_REARM_JUMP_FACTOR × v × Δt, v × Δt +
//    PARK_REARM_JUMP_SLACK_M) — v the mean of the two fixes' reported speeds — is rejected: no credit, not an endpoint,
//    not the reference. The first fix accepted after a jump starts a new SEGMENT; credit and displacement never span one.
//  • CREDIT: a fix at >= the entry speed (15 km/h) earns min(Δt, PARK_REARM_FIX_CREDIT_MS) only if the reported track
//    covered >= PARK_REARM_MOVE_RATIO of what the reported speeds claim — each fix claiming speed × min(real Δt,
//    PARK_REARM_CLAIM_MAX_MS) — over the last PARK_REARM_BASELINE_MS AND over its own fast run (from the fix before the
//    run, capped at the baseline). One noisy step can look fast; a walker's speed spike cannot keep up over its span.
//  • ENDPOINTS: component-wise median of PARK_REARM_ROBUST_N (5) accepted fixes — three outliers among five to move one.
//  • PROOF: within the last PARK_REARM_WINDOW_MS of the segment, >= PARK_REARM_VEHICULAR_MS of credit, >=
//    PARK_REARM_MIN_M from the first five fixes to the last five, and the last five >= PARK_REARM_MIN_M from the spot.
// A head-unit reconnect still clears the witness at once (locationPrivacy.noteCarConnected), so a CarPlay / Android
// Auto drive is live from its first fix. With no witnessed park nothing here runs; every new witness resets it.
//
// MEASURED (tools/sim-qc/park_rearm_test.mts and the review scripts, all through this module; 3 m noise unless noted):
//   proves at 1 Hz — highway pull-away 24–25 s; urban pull-away 31 s; stop-sign grids 51–71 s; stop-and-go 73 s
//   (103 s with 10 s standing); 10–20 km/h crawls 63–68 s; Jeff's real 09-19 / 09-23 drive-aways 4 / 17 s past the
//   250 m floor. At 0.5 Hz the same drives take 26–108 s, at 0.2 Hz 50–105 s (not the stop-and-go with standing).
//   stays pinned — every walker set 0 of 200: straight 1.4 m/s walkers with 8 / 10 / 12 m GPS noise and 1 in 10
//   single-fix 15–18 km/h readings, delivered at 1 Hz, 2 Hz, 2 m filter and Lite (8 m filter); walk 350 m then sit;
//   speed invalid except the spikes; Jeff's 09-25 and 08-29 walks (recorded, densified, 41 s stuck on the multipath
//   point, 14–31 s of 16 km/h readings first); two consecutive / ping-pong 400 m outliers.
// ⚠ WHAT IT COSTS: a phone-only drive (no head unit reconnects) in slow congestion — traffic averaging under 250 m per
// 2 min (2.08 m/s, 7.5 km/h) — keeps the shared position AND the driver's own marker pinned at the witnessed park
// until traffic averages above that for about 2 min, or a head unit reconnects. Jams averaging 0.6–1.3 m/s never
// prove (30 min runs). That is the safe direction: the crew sees the car where it was parked, never the person.
// ⚠ THE RESIDUAL, honestly: GPS alone cannot separate slow traffic from a walker whose reported position really moves
// at car-like speed. Brisk 2.0 m/s walkers (240 m per 2 min, 10 m under the floor) or 1 m/s drift, with white 8–12 m
// position noise, still un-pin 1–38 of 200 per set (scratch canyon_r5.mts); a moving-walkway concourse (1.9 m/s on
// average) with 8 m noise and 1 in 5 fast readings 112 of 200 (review-priv4/attacks.mts A); drift σv 2–3 m/s
// (240–360 m of wander) 6–499 of 500 (review-priv4/canyon.mts); runners at 15 km/h, cyclists, buses and trains un-pin
// in 24–65 s (review-priv3/walkers.mts A6) and the car spot then follows them. The fix for that is not in GPS: the OS
// motion classifier (iOS CMMotionActivity `automotive`, Android Activity Recognition IN_VEHICLE) — a NATIVE build-80
// item (CARPLAY.md §6c) that would also let a jam prove — HYPOTHESIS until a bench receipt.
//
// Pure: no react-native imports. The entry speed is passed in by src/locationPrivacy.ts (its owner), so this rule can
// never drift from it; tools/sim-qc/park_rearm_test.mts drives the real noteFix and pins every value below.

// The fast look-back. Walking is 1.4–1.6 m/s (a brisk 2.0 m/s at most), so a walker covers at most 1.6 × 120 = 192 m
// (2.0 × 120 = 240 m) of net displacement inside it — below PARK_REARM_MIN_M.
export const PARK_REARM_WINDOW_MS = 120_000;
// 15 s credited at >= 15 km/h within the fast window (the rule's 15 s as specified 2026-09-25, accumulated).
export const PARK_REARM_VEHICULAR_MS = 15_000;
// 250 m, as net displacement inside the fast window and as distance from the witnessed spot: above the walking bound
// (192 m, brisk 240 m) and 3.8× the largest spread of Jeff's recorded 09-25 walk (64.9 m).
export const PARK_REARM_MIN_M = 250;
// Covered >= 80 % of the claimed distance. Swept against the canyon model (200 seeds each, scratch sweep.mts): 0.7
// un-pinned 86/200 brisk (2.0 m/s) walkers with 15–17 km/h spikes, 134/200 at 2.1 m/s and 199/200 1.4 m/s σv=2
// "consistent" walkers; 0.8 → 0/200, 0/200 and 142/200. A car's Doppler speed and track agree to ~0.9+ over 10 s even
// with 3 m noise.
export const PARK_REARM_MOVE_RATIO = 0.8;
// The most one fix may credit. The feeds deliver every <= 2 s at 15 km/h: iOS ~1 Hz while moving (navNotification.ts
// drive-time note, "delivery ~1 Hz measured"), the Lite GPS phone watcher's 8 m filter at 4.17 m/s every 1.9 s. Also the
// out-of-order tolerance: an arrival up to 2 s behind the previous one is ignored, further back the clock moved.
export const PARK_REARM_FIX_CREDIT_MS = 2_000;
// The consistency baseline: 10 s spans a whole walker speed spike (2–6 s in the review model; Jeff's 09-25 26 and
// 29 km/h readings 3.9 s apart) plus honest walking on both sides; a car at 15 km/h covers 42 m in it, far above noise.
export const PARK_REARM_BASELINE_MS = 10_000;
// Jump bound max(2 × v × Δt, v × Δt + 50 m). Jeff's 08-29 multipath fix: 336.7 m in 11.54 s at a mean reported
// (7 + 51)/2 km/h = 8.1 m/s → bound 186 m → rejected (as a v2 endpoint it had un-pinned him). A real 1 Hz car step is
// v ± GPS noise; the worst accuracy in his recorded rows is 16 m, so 50 m of slack is 3× that.
export const PARK_REARM_JUMP_FACTOR = 2;
export const PARK_REARM_JUMP_SLACK_M = 50;
// Median of five: survives two outliers among the last five (the review's two-consecutive-outlier attack).
export const PARK_REARM_ROBUST_N = 5;
// The longest elapsed time one fix may CLAIM at its own speed: claim = speed × min(real Δt, this). Round 4 capped the
// claim at the 2 s CREDIT cap, so a Lite GPS walker (8 m filter, fixes 4.0–5.7 s apart) had every 8 m step "cover" a
// 15 km/h reading (8.3 m) with no noise at all; at 3 s the same step must cover 0.8 × 12.5 m and cannot. Swept 2–10 s
// (review-priv4 walker_cadence / walker_compare / sit_after_walk / attacks, review-priv3 drivers, scratch canyon_r5;
// 200 seeds): the walker sets are 0 un-pinned at every cap once the slow path is gone, but a cap of 5–10 s lets a fix
// after an unreported stop claim the stop at driving speed — 0.5 Hz noise-free grids, 0.2 Hz grids and 0.1 Hz crawls
// then never prove. 3 s keeps every round-4 fast-path proof (0.2 Hz grids 105–150 s).
export const PARK_REARM_CLAIM_MAX_MS = 3_000;

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
// Component-wise median of the given points (odd count).
function medianOf(ps: P[]): P {
  const lat = ps.map((p) => p.lat).sort((a, b) => a - b), lng = ps.map((p) => p.lng).sort((a, b) => a - b);
  const m = ps.length >> 1;
  return { lat: lat[m], lng: lng[m] };
}

// claim = the metres this fix's own speed says it covered since the previous fix: speed × the REAL elapsed time
// (capped at PARK_REARM_CLAIM_MAX_MS), never the credit cap.
type Fix = { t: number; lat: number; lng: number; spd: number; claim: number; credit: number };

export function createParkRearm(speeds: { enterMs: number }): ParkRearm {
  // Accepted fixes of the CURRENT SEGMENT, oldest first (pruned to PARK_REARM_WINDOW_MS). A segment ends at a jump.
  let seg: Fix[] = [];
  let prev: Fix | null = null;          // the last ACCEPTED fix (the jump test's reference)
  let bridging = false;                 // a fix was rejected since `prev`: the next accepted one starts a new segment
  let proven = false;
  const creditIn = (fixes: Fix[]) => fixes.reduce((s2, f) => s2 + f.credit, 0);
  return {
    note(now, lat, lng, spdMs, spot) {
      if (proven) return true;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(now)) return false;
      const spd = Number.isFinite(spdMs) && spdMs > 0 ? spdMs : 0;
      if (prev && now <= prev.t) {
        // Out of order by up to one fix interval (a burst, two writers): ignore this fix. Further back: the clock
        // moved — start over.
        if (prev.t - now > PARK_REARM_FIX_CREDIT_MS) { seg = []; prev = null; bridging = false; }
        else return false;
      }
      let credit = 0;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        const d = metres(prev, { lat, lng });
        const v = (prev.spd + spd) / 2;                              // the trapezoid: both ends' reported speeds
        if (d > Math.max(PARK_REARM_JUMP_FACTOR * v * dt, v * dt + PARK_REARM_JUMP_SLACK_M)) {
          bridging = true;                                           // a JUMP: no credit, not an endpoint, not the reference
          return false;
        }
        if (bridging) { seg = []; bridging = false; }                // the first fix after a jump starts a new segment
      }
      const dt = prev && seg.length ? now - prev.t : 0;
      const claim = spd * (Math.min(dt, PARK_REARM_CLAIM_MAX_MS) / 1000);
      if (dt > 0 && spd >= speeds.enterMs) {
        // CONSISTENCY, measured over spans — never one step (one noisy step can look fast): the reported track must
        // have covered >= PARK_REARM_MOVE_RATIO of what the reported speeds claim (a) over the last
        // PARK_REARM_BASELINE_MS, and (b) over the fast-reading RUN this fix belongs to, from the fix before the run
        // (capped at the same baseline, so a long run on a curving road is not judged chord-against-arc). A walker's
        // 2–6 s speed spike rides a baseline of honest walking and passes (a); the run alone cannot hide from (b).
        let base = -1;
        for (let i = seg.length - 1; i >= 0; i--) if (seg[i].t <= now - PARK_REARM_BASELINE_MS) { base = i; break; }
        let run = seg.length;
        while (run > 0 && seg[run - 1].spd >= speeds.enterMs) run--;
        const runBase = Math.max(run > 0 ? run - 1 : 0, base);    // (a segment that starts fast: its own first fix)
        const covers = (from: number) => {
          let claimed = claim;
          for (let i = from + 1; i < seg.length; i++) claimed += seg[i].claim;
          return metres(seg[from], { lat, lng }) >= PARK_REARM_MOVE_RATIO * claimed;
        };
        if (base >= 0 && covers(base) && covers(runBase)) credit = Math.min(dt, PARK_REARM_FIX_CREDIT_MS);
      }
      const f: Fix = { t: now, lat, lng, spd, claim, credit };
      prev = f;
      seg.push(f);
      while (seg.length && seg[0].t < now - PARK_REARM_WINDOW_MS) seg.shift();
      // The proof — the last PARK_REARM_WINDOW_MS of this segment (seg holds nothing older).
      const R = PARK_REARM_ROBUST_N;
      if (seg.length < R) return false;
      const here = medianOf(seg.slice(-R));
      const spotFar = !spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lng) || metres(spot, here) >= PARK_REARM_MIN_M;
      if (creditIn(seg) >= PARK_REARM_VEHICULAR_MS && metres(medianOf(seg.slice(0, R)), here) >= PARK_REARM_MIN_M && spotFar) proven = true;
      if (proven) { seg = []; prev = null; bridging = false; }
      return proven;
    },
    reset() { seg = []; prev = null; bridging = false; proven = false; },
  };
}
