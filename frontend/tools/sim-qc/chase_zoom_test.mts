// chase_zoom_test — the follow camera may not zoom IN to 18.5 at highway speed.
// Run: node --experimental-strip-types tools/sim-qc/chase_zoom_test.mts
//
// Jeff, 2026-09-14: "the last 10 min the off ramp was terrible and the route line was stuttering
// like crazy". Approved the fix the same day: "yes. off ramp build please".
//
// THE DEFECT THIS GATE EXISTS FOR. chaseZoom returned a FLAT CORNER_ZOOM 18.5 for any step
// <= CORNER_CHAIN_M (550 m), whatever the speed. Every highway ramp is such a step. Two
// cam-probe receipts on the CarPlay surface:
//   09-11 exit (ogb3m4-967731)  17:59:42  zt=18.50 @104 km/h   the speed curve says 13.76
//   09-14 Abbotsford exit (h6sjel-844376)
//                               18:15:50  zt=13.42 @119 km/h   373 m before the exit, on the curve
//                               18:16:05  zt=18.50 @ 99 km/h   ~460 m ramp step, the curve says 13.89
//                               18:16:20  zt=18.50 @ 43 km/h   ramp end, the curve says 16.33
// The ground slid ~150-179 px/s instead of ~7-8, so every 1-3 m position correction was drawn
// ~20x bigger. ⚠ On 09-14 the JS timers were ALSO dead for the whole exit (timer-starve raf=0
// 18:16:03-18:18:36); that half is build 79's HairpinTimerPump, not this gate.
//
// PRIOR ART: Mapbox Navigation SDK maxZoom 16.35 and it EXCLUDES "on ramp"/"off ramp"/"merge"/
// "fork"/"continue" from maneuver framing; MapLibre Navigation Android and Organic Maps cap the
// follow camera at 16. Nobody zooms IN for a short, fast step.
//
// THE FIX (src/chaseZoom.ts): max(base, min(cornerTarget, cornerZoomCeiling(kmh))), with the
// ceiling 18.5 at <= 45 km/h falling linearly to 16.0 at >= 90 km/h. The speed curve is unchanged.
// WHAT IT BUYS: corrections drawn 5.7x smaller at >= 90 km/h, 1.3-2.3x at 52-67 km/h, unchanged at
// <= 45 km/h. Corners between 45 and 90 km/h (a 60 km/h arterial) ARE changed — section H.
//
// ⚠ This gate proves the ARITHMETIC. It is NOT a field verification: that is the next exit's
// cam-probe rows. Companion: scripts/trap-check.py rule "corner-zoom-no-speed-ceiling" guards
// the source text.
// EXITS NON-ZERO ON FAILURE.
import {
  chaseZoom, chaseZoomForSpeed, cornerZoomCeiling, roundaboutHoldDistM, ROUNDABOUT_HOLD_M,
  CORNER_ZOOM, CORNER_FAR_M, CORNER_NEAR_M, CORNER_CHAIN_M,
} from "../../src/chaseZoom.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const f2 = (x: number) => x.toFixed(2);
const EPS = 1e-9;

// The PRE-FIX function, frozen here verbatim (commit 667fc42b, src/ConvoyMapbox.tsx chaseZoom) so
// the gate can print the "was" column and prove each scenario really exercised the defect. It is
// NOT the code under test. It reuses the unchanged speed curve and constants.
// The corner zoom it ran at was 18.5 — frozen here, because CORNER_ZOOM itself moved to 17 on Jeff's word (2026-09-18,
// "zoom 17"). `cz` lets C3 compare today's function against the same SHAPE at today's corner zoom.
const PRE_FIX_CORNER_ZOOM = 18.5;
function preFixChaseZoom(kmh: number, distToManeuverM?: number, curStepLenM?: number, cz: number = PRE_FIX_CORNER_ZOOM) {
  const lerp = (a: number, b: number, t: number) => { const k = Math.max(0, Math.min(1, t)); return a + (b - a) * k; };
  const base = chaseZoomForSpeed(kmh);
  if (typeof distToManeuverM !== "number" || !Number.isFinite(distToManeuverM) || distToManeuverM <= 0) return base;
  if (typeof curStepLenM === "number" && Number.isFinite(curStepLenM) && curStepLenM > 0 && curStepLenM <= CORNER_CHAIN_M) return cz;
  const t = (CORNER_FAR_M - distToManeuverM) / (CORNER_FAR_M - CORNER_NEAR_M);
  return Math.max(base, lerp(base, cz, t));
}

// ── Ground flow on screen ─────────────────────────────────────────────────────────────────
// Mapbox renders the world 512 logical px wide at zoom 0 (512-px tiles). The equator is
// 40,075,016.686 m, so one logical px at z0 on the equator is 40075016.686 / 512 = 78,271.517 m.
// Web Mercator shrinks that by cos(latitude), and each zoom level halves it:
//     m/px = 78271.517 * cos(lat) / 2^z
// "px" here is the logical point the phone and the CarPlay layout both use, not a device pixel.
// LAT is the Abbotsford exit on Highway 1 (~49.05 N), the 09-14 receipt.
const LAT = 49.05;
const mPerPx = (z: number) => (78271.517 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z;
const pxPerS = (kmh: number, z: number) => (kmh / 3.6) / mPerPx(z);

// Step lengths from the receipts.
const RAMP_0914_M = 450;         // the ~460 m ramp step, rounded down (stays under 550 either way)
const HIGHWAY_STEP_0914_M = 229871; // step 6/12 on 09-14, 15:55:50 -> 18:16:03
const CITY_LONG_STEP_M = 2000;

// ── A · the 09-14 Abbotsford exit ─────────────────────────────────────────────────────────
console.log("A · 09-14 Abbotsford exit (h6sjel-844376)");
{
  // 18:15:50: 119 km/h, 373 m from the exit on the 230 km highway step. Must be the speed curve.
  const zA1 = chaseZoom(119, 373, HIGHWAY_STEP_0914_M);
  ok("A1 119 km/h, 373 m to the exit on the long step = the speed curve (unchanged)",
     Math.abs(zA1 - chaseZoomForSpeed(119)) < EPS && Math.abs(zA1 - preFixChaseZoom(119, 373, HIGHWAY_STEP_0914_M)) < EPS,
     `z=${f2(zA1)} curve=${f2(chaseZoomForSpeed(119))}`);
  ok("A2 ...and that is the 13.42 the field row logged", Math.abs(zA1 - 13.42) < 0.005, f2(zA1));
  const zFar = chaseZoom(119, 5000, HIGHWAY_STEP_0914_M);
  ok("A3 119 km/h far from any maneuver = the speed curve", Math.abs(zFar - chaseZoomForSpeed(119)) < EPS, f2(zFar));

  // 18:16:05: 99 km/h on the ramp step. Sample the whole step, gore to end.
  let worst = 0, worstWas = 99;
  for (let d = RAMP_0914_M; d > 0; d -= 5) {
    worst = Math.max(worst, chaseZoom(99, d, RAMP_0914_M));
    worstWas = Math.min(worstWas, preFixChaseZoom(99, d, RAMP_0914_M));
  }
  ok("A4 99 km/h anywhere on the 450 m ramp step <= 16.05", worst <= 16.05, `max z=${f2(worst)} (was ${f2(worstWas)})`);
  ok("A5 the scenario really was the defect before the fix (was 18.5)", Math.abs(worstWas - PRE_FIX_CORNER_ZOOM) < EPS, f2(worstWas));
  ok("A6 ...and still tightens above the 99 km/h speed curve (13.89)", worst > chaseZoomForSpeed(99) + 1,
     `z=${f2(worst)} curve=${f2(chaseZoomForSpeed(99))}`);

  // 18:16:20: 43 km/h near the ramp end. The car has slowed, so the corner zoom may return.
  const zA7 = chaseZoom(43, 60, RAMP_0914_M);
  ok("A7 43 km/h on the ramp step (the car has slowed): the corner zoom is back", zA7 >= CORNER_ZOOM - 0.2, `z=${f2(zA7)} (CORNER_ZOOM ${CORNER_ZOOM})`);

  const flow = pxPerS(99, chaseZoom(99, 300, RAMP_0914_M));
  const flowWas = pxPerS(99, preFixChaseZoom(99, 300, RAMP_0914_M));
  ok("A8 99 km/h on the ramp: corrections drawn >= 5x smaller than before", flowWas / flow >= 5,
     `${flow.toFixed(1)} px/s (was ${flowWas.toFixed(1)}, ${(flowWas / flow).toFixed(1)}x)`);
}

// ── B · the 09-11 exit ────────────────────────────────────────────────────────────────────
console.log("B · 09-11 exit (ogb3m4-967731)");
{
  let worst = 0;
  for (let d = 540; d > 0; d -= 5) worst = Math.max(worst, chaseZoom(104, d, 540));
  ok("B1 104 km/h on a short step <= 16.05", worst <= 16.05, `max z=${f2(worst)} (was ${f2(preFixChaseZoom(104, 300, 540))})`);
  ok("B2 the 09-11 speed curve value is the 13.76 the memory cites", Math.abs(chaseZoomForSpeed(104) - 13.76) < 0.005,
     f2(chaseZoomForSpeed(104)));
}

// ── C · city corners are unchanged ────────────────────────────────────────────────────────
console.log("C · city corners unchanged");
{
  ok("C1 30 km/h, 70 m to the maneuver on a long step = CORNER_ZOOM", Math.abs(chaseZoom(30, 70, CITY_LONG_STEP_M) - CORNER_ZOOM) < EPS,
     f2(chaseZoom(30, 70, CITY_LONG_STEP_M)));
  ok("C2 30 km/h on a short step = CORNER_ZOOM", Math.abs(chaseZoom(30, 150, 200) - CORNER_ZOOM) < EPS, f2(chaseZoom(30, 150, 200)));
  // At <= 45 km/h the ceiling IS CORNER_ZOOM, so the new function must be bit-identical to the
  // old one for every distance and step length. This is the "city corners keep zooming in" rule.
  let diffs = 0, worstDiff = 0;
  const dists = [undefined, -5, 0, 0.5, 1, 10, 50, 69, 70, 71, 100, 175, 279, 280, 281, 400, 1000, 1e5];
  const steps = [undefined, -1, 0, 1, 50, 200, 450, 549, 550, 551, 1000, 2000, HIGHWAY_STEP_0914_M];
  for (let v = 0; v <= 45; v += 0.5) for (const d of dists) for (const L of steps) {
    const a = chaseZoom(v, d, L), b = preFixChaseZoom(v, d, L, CORNER_ZOOM);
    if (a !== b) { diffs++; worstDiff = Math.max(worstDiff, Math.abs(a - b)); }
  }
  ok("C3 at every speed <= 45 km/h the result is bit-identical to the pre-fix function", diffs === 0,
     `${diffs} differing samples, worst ${worstDiff}`);
}

// ── D · never below the speed curve, never above the corner zoom or the ceiling ───────────
console.log("D · bounds sweep");
{
  let below = 0, aboveCorner = 0, aboveCeil = 0, n = 0;
  const dists = [undefined, 0, 1, 10, 35, 70, 120, 200, 279, 280, 300, 550, 1000, 1e5];
  const steps = [undefined, 0, 50, 300, 450, 550, 551, 800, 5000, HIGHWAY_STEP_0914_M];
  for (let v = 0; v <= 220; v += 0.5) for (const d of dists) for (const L of steps) {
    const z = chaseZoom(v, d, L), base = chaseZoomForSpeed(v);
    n++;
    if (z < base - EPS) below++;
    if (z > CORNER_ZOOM + EPS) aboveCorner++;
    if (z > Math.max(base, cornerZoomCeiling(v)) + EPS) aboveCeil++;
  }
  ok("D1 never below the speed curve", below === 0, `${below}/${n}`);
  ok("D2 never above CORNER_ZOOM", aboveCorner === 0, `${aboveCorner}/${n}`);
  ok("D3 never above the speed-aware ceiling", aboveCeil === 0, `${aboveCeil}/${n}`);
  // Without a maneuver the function is the pure speed curve, bit-identical to before.
  let freeDiff = 0;
  for (let v = 0; v <= 220; v += 0.5) if (chaseZoom(v) !== chaseZoomForSpeed(v) || chaseZoom(v) !== preFixChaseZoom(v)) freeDiff++;
  ok("D4 no maneuver (free drive / cruise) = the speed curve, unchanged", freeDiff === 0, `${freeDiff} differing`);
  ok("D5 parked = 17, the FOLLOW_ZOOM invariant in ConvoyMapbox.tsx", chaseZoom(0) === 17 && chaseZoom(0, 50, 100) >= 17, f2(chaseZoom(0)));
  // Garbage speeds must not produce NaN.
  const junk = [NaN, -10, Infinity].map((v) => chaseZoom(v as number, 100, 300));
  ok("D6 NaN / negative / Infinity speed never yields NaN", junk.every((z) => Number.isFinite(z)), junk.map(f2).join(","));
}

// ── E · the ceiling itself ────────────────────────────────────────────────────────────────
console.log("E · ceiling shape");
{
  ok("E1 18.5 at <= 45 km/h", cornerZoomCeiling(0) === CORNER_ZOOM && cornerZoomCeiling(45) === CORNER_ZOOM);
  ok("E2 16.0 at >= 90 km/h", cornerZoomCeiling(90) === 16 && cornerZoomCeiling(150) === 16);
  ok("E3 within 0.4 of the published follow ceilings (Mapbox 16.35, MapLibre/Organic Maps 16) at highway speed",
     Math.abs(cornerZoomCeiling(100) - 16.35) <= 0.4, f2(cornerZoomCeiling(100)));
  let nonMono = 0;
  for (let v = 0; v < 200; v += 0.1) if (cornerZoomCeiling(v + 0.1) > cornerZoomCeiling(v) + EPS) nonMono++;
  ok("E4 non-increasing in speed", nonMono === 0, `${nonMono}`);
  // Continuity in SPEED for the whole function, not just the ceiling: over 0.1 km/h the result may
  // move at most 0.1 * 0.0556 (the ceiling's slope, which is steeper than any speed-table segment).
  let worstJump = 0, at = "";
  for (const [d, L] of [[300, 450], [70, 2000], [150, 2000], [260, 2000], [30, 540]] as const) {
    for (let v = 0; v < 200; v += 0.1) {
      const j = Math.abs(chaseZoom(v + 0.1, d, L) - chaseZoom(v, d, L));
      if (j > worstJump) { worstJump = j; at = `${v.toFixed(1)} km/h d=${d} L=${L}`; }
    }
  }
  ok("E5 continuous in speed: no step larger than 0.006 per 0.1 km/h", worstJump <= 0.006, `worst ${worstJump.toFixed(5)} at ${at}`);
}

// ── F · a car braking down the ramp ───────────────────────────────────────────────────────
console.log("F · decelerating 110 -> 40 km/h over 20 s along a 450 m ramp");
{
  // Linear deceleration from 110 to 40 km/h over 20 s = 3.5 km/h/s, integrated for position at
  // 60 Hz. Mean speed 75 km/h x 20 s = 416.7 m, so the car ends ~33 m before the ramp's maneuver,
  // still on the step. This is the 09-14 shape (99 -> 43 km/h in 15 s).
  const HZ = 60, T = 20, V0 = 110, V1 = 40;
  let s = 0, prevZ = NaN, maxRate = 0, reversals = 0, zStart = 0, zEnd = 0, prevV = V0;
  for (let i = 0; i <= HZ * T; i++) {
    const t = i / HZ;
    const v = V0 + (V1 - V0) * (t / T);
    if (i > 0) s += ((prevV + v) / 2 / 3.6) / HZ;
    prevV = v;
    const z = chaseZoom(v, RAMP_0914_M - s, RAMP_0914_M);
    if (i === 0) zStart = z;
    if (i > 0) {
      maxRate = Math.max(maxRate, Math.abs(z - prevZ) * HZ);
      if (z < prevZ - EPS) reversals++;
    }
    prevZ = z; zEnd = z;
  }
  ok("F1 the car is still on the ramp step at the end", RAMP_0914_M - s > 0, `${(RAMP_0914_M - s).toFixed(1)} m left`);
  ok("F2 max |dz/dt| <= 0.6 levels/s", maxRate <= 0.6, `${maxRate.toFixed(3)} levels/s`);
  ok("F3 zoom never falls while the car slows (no reversal)", reversals === 0, `${reversals} reversals`);
  ok("F4 starts capped (<= 16.05 at 110 km/h)", zStart <= 16.05, f2(zStart));
  ok("F5 ends with the corner zoom back (40 km/h)", zEnd >= CORNER_ZOOM - 0.2, f2(zEnd));
}

// ── G · the 09-03 exit-gore yo-yo cannot come back ────────────────────────────────────────
console.log("G · chain hold still hands over without a drop (09-03)");
{
  // 09-03: the exit maneuver sits at the GORE; the step then advances onto a short ramp step with
  // the next maneuver 483 m away. Before the chain hold, the target fell to the speed curve there
  // and climbed back 280 m before the ramp's end ("in, out, in"). With the ceiling, the last value
  // before the gore (long highway step, ~1 m to go) must equal the first value on the ramp step.
  let worstDrop = 0, at = "";
  for (const v of [30, 45, 60, 76, 85, 90, 100, 120]) {
    const before = chaseZoom(v, 1, 12000);
    const after = chaseZoom(v, 483, 483);
    const drop = before - after;
    if (drop > worstDrop) { worstDrop = drop; at = `${v} km/h ${f2(before)} -> ${f2(after)}`; }
  }
  ok("G1 no drop at the gore -> ramp step advance, at any speed", worstDrop <= EPS, worstDrop ? at : "0");
  ok("G2 the 09-03 case (76 km/h) still holds above its speed curve (14.9)",
     chaseZoom(76, 483, 483) > chaseZoomForSpeed(76) + 1, `${f2(chaseZoom(76, 483, 483))} vs ${f2(chaseZoomForSpeed(76))}`);
  // Across the whole ramp at a steady speed, the target must not move at all (hold, not yo-yo).
  let spread = 0;
  for (const v of [50, 76, 100]) {
    let lo = 99, hi = -99;
    for (let d = 483; d > 0; d -= 3) { const z = chaseZoom(v, d, 483); lo = Math.min(lo, z); hi = Math.max(hi, z); }
    spread = Math.max(spread, hi - lo);
  }
  ok("G3 steady speed along the ramp step: the target is flat (a hold)", spread <= EPS, `spread ${spread}`);
}

// ── H · what the ceiling does NOT cover (disclosed, asserted so it cannot drift silently) ─────
console.log("H · the middle band and the city band");
{
  // 60 km/h corner on a long step, 70 m out: the ceiling bites (17.67), so this corner IS changed.
  const z60 = chaseZoom(60, 70, CITY_LONG_STEP_M);
  ok("H1 60 km/h corner: capped at the ceiling (16.67), changed from 18.5", Math.abs(z60 - cornerZoomCeiling(60)) < EPS && preFixChaseZoom(60, 70, CITY_LONG_STEP_M) === PRE_FIX_CORNER_ZOOM,
     `z=${f2(z60)} was ${f2(preFixChaseZoom(60, 70, CITY_LONG_STEP_M))}`);
  // Middle band gain against the original 18.5 (with CORNER_ZOOM 17 since 2026-09-18): 52 km/h ~3.1x, 67 km/h ~4.0x, highway 5.7x.
  const ratio = (v: number) => 2 ** (preFixChaseZoom(v, 300, RAMP_0914_M) - chaseZoom(v, 300, RAMP_0914_M));
  ok("H2 52 km/h ramp: correction scale 3.0-3.3x smaller", ratio(52) >= 3.0 && ratio(52) <= 3.3, `${ratio(52).toFixed(2)}x`);
  ok("H3 67 km/h ramp: correction scale 3.8-4.1x smaller", ratio(67) >= 3.8 && ratio(67) <= 4.1, `${ratio(67).toFixed(2)}x`);
  ok("H4 >= 90 km/h ramp: 5.7x smaller", Math.abs(ratio(99) - 2 ** 2.5) < 1e-6, `${ratio(99).toFixed(2)}x`);
}

// ── I · roundabout hold (09-15 roundabout 2) ────────────────────────────────────────────
console.log("I · roundabout hold (09-15 roundabout 2, instance 1mdvgz-926948)");
{
  // 09:01:19.509 cam-probe zt=16.95 @22 km/h on step 2 (turn=30380m): the step advanced 25 m before the
  // ring entry, so the corner zoom was gone for the whole loop.
  const STEP2_M = 30380;
  const zWas = chaseZoom(22, STEP2_M, STEP2_M);
  ok("I1 the defect reproduces without the hold: zt = the speed curve (16.95)", Math.abs(zWas - 16.95) < 0.005 && zWas === preFixChaseZoom(22, STEP2_M, STEP2_M), f2(zWas));
  let lo = 99;
  for (let d = 0; d <= ROUNDABOUT_HOLD_M; d += 2) lo = Math.min(lo, chaseZoom(22, STEP2_M, STEP2_M, d));
  ok("I2 with the hold: 18.5 anywhere within ROUNDABOUT_HOLD_M of the ring entry at 22 km/h", Math.abs(lo - CORNER_ZOOM) < EPS, f2(lo));
  ok("I3 43 km/h exiting, 70 m from the entry: still 18.5 (ceiling is 18.5 at <= 45 km/h)", Math.abs(chaseZoom(43, STEP2_M, STEP2_M, 70) - CORNER_ZOOM) < EPS, f2(chaseZoom(43, STEP2_M, STEP2_M, 70)));
  ok("I4 past the hold (81 m): releases to the speed curve", chaseZoom(43, STEP2_M, STEP2_M, 81) === chaseZoomForSpeed(43), f2(chaseZoom(43, STEP2_M, STEP2_M, 81)));
  ok("I5 a fast rotary still obeys the speed ceiling (100 km/h -> 16.0)", Math.abs(chaseZoom(100, STEP2_M, STEP2_M, 20) - 16) < EPS, f2(chaseZoom(100, STEP2_M, STEP2_M, 20)));
  let diffs = 0;
  for (let v = 0; v <= 220; v += 1) for (const d of [undefined, 10, 70, 300, 1000]) for (const L of [undefined, 200, 450, 2000]) {
    if (chaseZoom(v, d, L) !== chaseZoom(v, d, L, undefined)) diffs++;
  }
  ok("I6 no roundabout distance = bit-identical to the 3-argument call", diffs === 0, `${diffs} differing`);
  // roundaboutHoldDistM: types and bad input.
  const S = { lat: 49.03478, lng: -122.29268 };
  const car25 = { lat: S.lat - 25 / 111320, lng: S.lng };   // 25 m south of the entry
  const dRb = roundaboutHoldDistM("roundabout|left", S.lat, S.lng, car25.lat, car25.lng);
  ok("I7 roundabout|left 25 m out -> ~25 m", typeof dRb === "number" && Math.abs(dRb - 25) < 0.2, String(dRb?.toFixed(2)));
  ok("I8 rotary and 'roundabout turn' count", roundaboutHoldDistM("rotary", S.lat, S.lng, car25.lat, car25.lng) !== undefined
     && roundaboutHoldDistM("roundabout turn|right", S.lat, S.lng, car25.lat, car25.lng) !== undefined);
  ok("I9 turn / exit roundabout / empty / junk do not count", [
    roundaboutHoldDistM("turn|left", S.lat, S.lng, car25.lat, car25.lng),
    roundaboutHoldDistM("exit roundabout|left", S.lat, S.lng, car25.lat, car25.lng),
    roundaboutHoldDistM("", S.lat, S.lng, car25.lat, car25.lng),
    roundaboutHoldDistM(undefined, S.lat, S.lng, car25.lat, car25.lng),
    roundaboutHoldDistM("roundabout|left", 0, 0, car25.lat, car25.lng),
    roundaboutHoldDistM("roundabout|left", S.lat, S.lng, NaN, car25.lng),
  ].every((x) => x === undefined));
}

// ── The before/after table for Jeff ───────────────────────────────────────────────────────
console.log("\nBEFORE / AFTER (zoom target, ground flow at lat 49.05)");
console.log("  scenario                                   km/h  was z   was px/s   now z   now px/s  curve");
const rows: [string, number, number | undefined, number | undefined][] = [
  ["09-14 18:15:50 highway, 373 m to exit",      119, 373, HIGHWAY_STEP_0914_M],
  ["09-14 18:16:05 ramp step (450 m)",           99,  300, RAMP_0914_M],
  ["09-14 ramp, braking (450 m step)",           70,  200, RAMP_0914_M],
  ["09-14 18:16:20 ramp end (450 m step)",       43,  60,  RAMP_0914_M],
  ["09-11 17:59:42 ramp step",                   104, 300, 540],
  ["city corner, 70 m to the turn",              30,  70,  CITY_LONG_STEP_M],
  ["arterial corner, 70 m to the turn",          60,  70,  CITY_LONG_STEP_M],
  ["arterial short step (200 m)",                60,  150, 200],
  ["city short step (200 m)",                    30,  150, 200],
];
for (const [label, v, d, L] of rows) {
  const was = preFixChaseZoom(v, d, L), now = chaseZoom(v, d, L);
  console.log(`  ${label.padEnd(42)} ${String(v).padStart(4)}  ${f2(was).padStart(5)}  ${pxPerS(v, was).toFixed(1).padStart(8)}   ${f2(now).padStart(5)}  ${pxPerS(v, now).toFixed(1).padStart(8)}  ${f2(chaseZoomForSpeed(v))}`);
}

console.log(fails === 0 ? "\nPASS chase_zoom" : `\nFAIL chase_zoom (${fails})`);
if (fails) process.exit(1);
