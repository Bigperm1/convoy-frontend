// ribbon_lead_test.mts — numeric regression gate for the pitch compensation added to
// src/routeTrim.ts on 2026-09-04 (field report: Olaf, CarPlay, 90 km/h, AI route — "the
// route ribbon visibly covered the self car" at a highway chase pitch. See the
// routeTrim.ts REVISED note for the full reasoning; this is HYPOTHESIS, not yet
// field-verified — this file only proves the ARITHMETIC does what the comment claims).
// Run: node --experimental-strip-types tools/sim-qc/ribbon_lead_test.mts
//
// Z/LAT below are the field report's own numbers (`ribbon-trim surf=car z=15.76 …`).
import assert from "node:assert/strict";
import { routeTrimLeadM, routeTrimFadeM, routeTrimLeadDp } from "../../src/routeTrim.ts";

const Z = 15.76, LAT = 49.24; // Olaf's field report

// 1. PITCH 0 MUST BE UNCHANGED. This exact value was computed from routeTrimLeadM(Z, LAT)
// BEFORE the pitch parameter existed (the unpitched formula: TRIM_LEAD_DP * metersPerDp),
// then hard-coded here per instruction — it is the one number in this file NOT derived
// from the code under test. Also matches the field telemetry's own `lead=55` (rounded).
const PRE_CHANGE_LEAD_0 = 55.253983267062594;
const lead0 = routeTrimLeadM(Z, LAT, 0);
assert.ok(
  Math.abs(lead0 - PRE_CHANGE_LEAD_0) < 1e-9,
  `pitch=0 changed the lead: ${lead0} vs ${PRE_CHANGE_LEAD_0} — existing callers must see zero behaviour change`,
);
// Omitting pitchDeg entirely (every caller before 2026-09-04) must be bit-identical to
// passing 0 explicitly.
assert.equal(routeTrimLeadM(Z, LAT), lead0, "omitting pitchDeg must equal pitchDeg=0");

// 2. THE HYPOTHESIS: pitch 57° (the field report's cam-probe `p=55-59`) must compensate
// the lead by at least 1.8x.
const lead57 = routeTrimLeadM(Z, LAT, 57);
assert.ok(
  lead57 >= 1.8 * lead0,
  `pitch=57 only compensated ${(lead57 / lead0).toFixed(3)}x, want >= 1.8x`,
);

// leadDp is the SCREEN-space value before the metres conversion — what the `leadDp=`
// receipt field prints. At pitch 0 it must be exactly TRIM_LEAD_DP (60).
assert.equal(routeTrimLeadDp(0), 60, "routeTrimLeadDp(0) must equal TRIM_LEAD_DP (60)");
assert.ok(routeTrimLeadDp(57) >= 60 * 1.8, "routeTrimLeadDp(57) did not compensate enough");

// 3. THE RAILS STILL BIND with a pitch term in the mix.
// Floor: at a high zoom (metersPerDp collapses toward 0), even a pitch-inflated dp value
// must still floor at TRIM_MIN_M (20 m) — not report some vanishing gap.
assert.equal(routeTrimLeadM(20, 0, 0), 20, "TRIM_MIN_M floor did not bind at pitch=0");
assert.equal(routeTrimLeadM(20, 0, 57), 20, "TRIM_MIN_M floor did not bind at pitch=57");
// Cap: pick a zoom where pitch=0 sits just under the 500 m cap, then confirm pitch=57
// pushes it OVER and the rail clamps it back to exactly 500 (no runaway).
const nearCapAtPitch0 = routeTrimLeadM(13.5, 0, 0);
assert.ok(nearCapAtPitch0 < 500, `test zoom picked wrong — already at the cap: ${nearCapAtPitch0}`);
assert.equal(routeTrimLeadM(13.5, 0, 57), 500, "TRIM_MAX_M cap did not bind with pitch present");

// FADE rides the same compensation for the same reason (identical metersPerDp mechanism,
// see routeTrim.ts) — same ratio, and unchanged at pitch 0.
const fade0 = routeTrimFadeM(Z, LAT, 0);
const fade57 = routeTrimFadeM(Z, LAT, 57);
assert.ok(
  fade57 >= 1.8 * fade0,
  `fade pitch compensation only ${(fade57 / fade0).toFixed(3)}x, want >= 1.8x`,
);
assert.equal(routeTrimFadeM(Z, LAT), fade0, "omitting pitchDeg on fade must equal pitchDeg=0");

console.log(
  `PASS — lead0=${lead0.toFixed(2)}m lead57=${lead57.toFixed(2)}m (${(lead57 / lead0).toFixed(3)}x) ` +
  `leadDp0=${routeTrimLeadDp(0)} leadDp57=${routeTrimLeadDp(57).toFixed(1)} ` +
  `fade0=${fade0.toFixed(2)}m fade57=${fade57.toFixed(2)}m floor=20 cap=500 all bound correctly`,
);
