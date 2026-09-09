// self_lift_lead_test — the route line must be cut ahead of where the self car is DRAWN,
// not where it is. The self model is rendered SELF_MODEL_LIFT_M metres in the AIR so the 3D
// buildings' depth buffer cannot eat it, and on a pitched camera that moves it FORWARD up the
// road by a screen distance that doubles with every zoom level.
//
// FIELD REPORT: Jeff's CarPlay head unit, 2026-09-07 exit 90 — "i was told the route line was
// fixed but it wasnt, especially when taking the off ramp from the highway". OTA-W (pitch
// compensation) and OTA-Z (cut anchor) had each already "fixed" it. Both were about the LEAD,
// and the lead was already correct: his receipts put the cut ~35 screen pt ahead at BOTH the
// highway frame and the ramp frame. What moved was the CAR.
//
// MEASURED (this is the receipt, not a derivation): two simulator frames at an IDENTICAL pinned
// camera — zoom 16.5, pitch 57, 402x874 pt — one with the 10 m lift and one with it zeroed, with
// ground-anchored control markers that did not change by a single pixel. The drawn car moved
// 17.2 pt up-screen; the model below predicts 15.3.
import { routeTrimLeadM, leadShiftedByLift, selfLiftScreenPt, SELF_MODEL_LIFT_M, SELF_ARROW_LIFT_M } from "../../src/routeTrim.ts";

const D_OF = (H: number) => 1.5 * H;                       // Mapbox cameraToCenterDistance, fov 36.87
const mpd = (z: number, lat: number) => (78271.516964 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
/** screen pt above the camera target for a GROUND point s metres ahead */
const groundPt = (s: number, z: number, lat: number, p: number, H: number) => {
  const d = D_OF(H), x = s / mpd(z, lat), pr = (p * Math.PI) / 180;
  return (d * x * Math.cos(pr)) / (d + x * Math.sin(pr));
};
/** screen pt above the target for a point at altitude h metres over the target */
const liftPt = (h: number, z: number, lat: number, p: number, H: number) => {
  const d = D_OF(H), x = h / mpd(z, lat), pr = (p * Math.PI) / 180;
  return (d * x * Math.sin(pr)) / (d - x * Math.cos(pr));
};

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) { fails++; console.log(`  FAIL ${n} ${d}`); } else console.log(`  ok   ${n} ${d}`); };
const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t;

// ── A. THE ADDITIVE CONTRACT — no caller that omits the lift may change ─────────────────────
ok("A1 lift omitted == lift 0", routeTrimLeadM(17, 49, 0) === routeTrimLeadM(17, 49, 0, 0, 874));
ok("A2 pitch 0 / z17 unchanged (40 dp x 0.39173 m/dp)", near(routeTrimLeadM(17, 49, 0), 15.669, 0.01), `${routeTrimLeadM(17, 49, 0).toFixed(3)} m`);
ok("A3 a flat camera hides the lift entirely", leadShiftedByLift(100, SELF_MODEL_LIFT_M, 17, 49, 0, 874) === 100);
ok("A4 no viewport height -> no correction (old callers)", leadShiftedByLift(100, SELF_MODEL_LIFT_M, 18.26, 49, 56, 0) === 100);

// ── B. THE CUT MOVES UP-SCREEN BY EXACTLY THE LIFT'S SHIFT ─────────────────────────────────
for (const [z, p, H, lead] of [[18.26, 56, 265, 12], [14.14, 59, 265, 219], [16.5, 57, 874, 40], [17, 45, 400, 30]] as Array<[number, number, number, number]>) {
  const shift = selfLiftScreenPt(SELF_MODEL_LIFT_M, z, 49.03, p, H);
  const moved = leadShiftedByLift(lead, SELF_MODEL_LIFT_M, z, 49.03, p, H);
  const before = groundPt(lead, z, 49.03, p, H), after = groundPt(moved, z, 49.03, p, H);
  ok(`B z=${z} p=${p} cut rises by the lift exactly`, near(after - before, shift, 0.02),
    `${(after - before).toFixed(2)} vs lift ${shift.toFixed(2)} pt`);
}

// ── C. AGAINST THE SIMULATOR A/B ────────────────────────────────────────────────────────────
const MEASURED_SHIFT_PT = 17.2;
const predicted = selfLiftScreenPt(SELF_MODEL_LIFT_M, 16.5, 49.1124, 57, 874);
ok("C model reproduces the measured 17.2 pt A/B shift", near(predicted, MEASURED_SHIFT_PT, 2.5), `pred ${predicted.toFixed(1)} pt`);

// ── D. JEFF'S TWO FRAMES, BEFORE AND AFTER ──────────────────────────────────────────────────
// 470x265 pt head unit; lead metres are his own logged `lead=` values.
const HU = 265, LAT = 49.03;
type Frame = { name: string; z: number; p: number; loggedLead: number };
const FRAMES: Frame[] = [
  { name: "highway 19:31:41", z: 14.14, p: 59, loggedLead: 219 },
  { name: "exit ramp 19:32:41", z: 18.26, p: 56, loggedLead: 12 },
];
const noseGap = (f: Frame, leadM: number) => {
  const carCentre = liftPt(SELF_MODEL_LIFT_M, f.z, LAT, f.p, HU);
  const halfCar = groundPt(22.5 * mpd(f.z, LAT), f.z, LAT, f.p, HU);   // CARPLAY_CAR_PT 45 -> half
  return groundPt(leadM, f.z, LAT, f.p, HU) - (carCentre + halfCar);
};
const results: Record<string, { before: number; after: number }> = {};
for (const f of FRAMES) {
  const lift = selfLiftScreenPt(SELF_MODEL_LIFT_M, f.z, LAT, f.p, HU);
  const before = noseGap(f, f.loggedLead);
  const after = noseGap(f, leadShiftedByLift(f.loggedLead, SELF_MODEL_LIFT_M, f.z, LAT, f.p, HU));
  results[f.name] = { before, after };
  console.log(`  -- ${f.name}: car drawn ${lift.toFixed(1)} pt up-screen; nose gap ${before.toFixed(1)} -> ${after.toFixed(1)} pt`);
}
ok("D1 the DEFECT reproduces: the ramp drew the line under the car", results["exit ramp 19:32:41"].before < 0,
  `${results["exit ramp 19:32:41"].before.toFixed(1)} pt`);
ok("D2 the FIX clears it: positive road ahead of the nose on the ramp", results["exit ramp 19:32:41"].after >= 8,
  `${results["exit ramp 19:32:41"].after.toFixed(1)} pt`);
ok("D3 the highway was never broken and must stay put (< 4 pt change)",
  Math.abs(results["highway 19:31:41"].after - results["highway 19:31:41"].before) < 4,
  `${results["highway 19:31:41"].before.toFixed(1)} -> ${results["highway 19:31:41"].after.toFixed(1)} pt`);
ok("D4 the highway keeps a real gap", results["highway 19:31:41"].after > 15, `${results["highway 19:31:41"].after.toFixed(1)} pt`);

// ── E. THE ARROW SKIN IS LIFTED HIGHER (16 m), SO IT MUST ALSO CLEAR ───────────────────────
// This is the assertion that killed the first, additive version of the fix: the arrow is drawn
// ~94 pt up-screen at z18.26 and adding the lift's ground-equivalent left only 3.7 pt of road.
const arrowNoseGap = (z: number, p: number, leadM: number) =>
  groundPt(leadM, z, LAT, p, HU)
  - (selfLiftScreenPt(SELF_ARROW_LIFT_M, z, LAT, p, HU) + groundPt(22.5 * mpd(z, LAT), z, LAT, p, HU));
const arrowBefore = arrowNoseGap(18.26, 56, 12);
const arrowAfter = arrowNoseGap(18.26, 56, leadShiftedByLift(12, SELF_ARROW_LIFT_M, 18.26, LAT, 56, HU));
console.log(`  -- arrow skin on the ramp: nose gap ${arrowBefore.toFixed(1)} -> ${arrowAfter.toFixed(1)} pt`);
ok("E1 the arrow was broken worse than the car", arrowBefore < results["exit ramp 19:32:41"].before);
ok("E2 the arrow skin clears on the ramp too", arrowAfter >= 15, `${arrowAfter.toFixed(1)} pt`);
ok("E3 car and arrow end up with the SAME gap (screen-space by construction)",
  near(arrowAfter, results["exit ramp 19:32:41"].after, 1.5));

// ── F. RAILS — a pathological camera must never NaN or explode the cut ──────────────────────
for (const [n, v] of [["pitch 85 z20", leadShiftedByLift(30, SELF_MODEL_LIFT_M, 20, LAT, 85, 200)],
                      ["NaN zoom", leadShiftedByLift(30, SELF_MODEL_LIFT_M, NaN, LAT, 56, 265)],
                      ["negative lift", leadShiftedByLift(30, -5, 18, LAT, 56, 265)]] as Array<[string, number]>) {
  ok(`F ${n} stays finite and railed`, Number.isFinite(v) && v >= 0 && v <= 500, `${v}`);
}
ok("F4 routeTrimLeadM never exceeds the 500 m cap", routeTrimLeadM(9, LAT, 59, SELF_ARROW_LIFT_M, 265) <= 500);

// ── G. NEGATIVE CONTROL — prove this gate can SEE the regression ─────────────────────────────
// If the compensation is ever removed (leadShiftedByLift -> identity), D2 must fail. Assert it so a
// green run cannot mean "the check is blind", which is exactly how this defect shipped twice.
const brokenAfter = noseGap(FRAMES[1], FRAMES[1].loggedLead + 0);
ok("G1 with the compensation removed, the ramp check FAILS", !(brokenAfter >= 8), `${brokenAfter.toFixed(1)} pt`);
ok("G2 the ADDITIVE version (ground-equivalent, not screen-space) fails for the arrow",
  !(arrowNoseGap(18.26, 56, 12 + 42.4) >= 15), "the version the gate rejected");

console.log(fails === 0 ? "\nPASS self_lift_lead" : `\nFAIL self_lift_lead (${fails})`);
if (fails) process.exit(1);
