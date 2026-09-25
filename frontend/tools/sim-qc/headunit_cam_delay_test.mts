// headunit_cam_delay_test — the head unit's camera under NATIVE LATENCY (Codex on round 7, [high]; 2026-09-25).
// Runs the PRODUCTION CarMapView / SelfCarModel camera code (headunit_cam_harness.mts) with every native flyTo/easeTo
// starting 0–600 ms late and ending up to 80 ms late, and gates the closed loop (src/camRepair.ts): the parked camera
// reaches and holds the owner's framing within 1.5 s of an animation's REAL end, never pumps when idle, never fights a
// pinch. Scenarios: headunit_cam_scenarios.mts runDelayScenarios (DL0 = Codex's repro exactly).
//   node --experimental-strip-types tools/sim-qc/headunit_cam_delay_test.mts
import { loadSrc } from "./headunit_cam_harness.mts";
import { runDelayScenarios } from "./headunit_cam_scenarios.mts";

const t0 = Date.now();
const res = runDelayScenarios(await loadSrc());
let fails = 0;
for (const r of res) { if (!r.pass) fails++; console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.id} ${r.name} ${r.detail}`); }
console.log(`${res.length} scenarios, ${fails} failing (${Date.now() - t0} ms)`);
console.log(fails ? `FAIL headunit_cam_delay (${fails})` : "PASS headunit_cam_delay");
process.exit(fails ? 1 : 0);
