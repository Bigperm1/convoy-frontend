// self_lift_rule_test — gate for src/selfLiftRule.ts: the self car is drawn ON the ground on a road and
// lifted only off it. Run: node --experimental-strip-types tools/sim-qc/self_lift_rule_test.mts
//
// Jeff, 2026-09-10: "make sure the road rule is pronounced for the car at a light and slow speeds —
// that way it should never get lifted. parking lots / driveways / parkades should be lifted."
// Section A is the red light; B–D the ways a road is known; E the lot, the driveway, the parkade;
// F what "no evidence" may and may not do; G the feature classifier; H the ease.
import {
  liftDecide, LIFT_STATE0, easeLift, isDrivableRoad, isPropertyRoad, buildingHeightOf, buildingUnder, roadEvidence,
  LIFT_OFFROAD_CONFIRM_MS, LIFT_UNKNOWN_HOLD_MS, LIFT_MAX_M, LIFT_BUILDING_MARGIN_M, LIFT_ONROAD_SPEED_MS,
  type LiftState, type LiftEvidence,
} from "../../src/selfLiftRule.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const ev = (o: Partial<LiftEvidence>): LiftEvidence => ({ speedMs: null, navDistM: null, roadHit: null, buildingH: null, ...o });
/** Run a 1 Hz sequence of evidence through the rule from t=0; returns every state. */
const run = (seq: Partial<LiftEvidence>[], lift = 10, st: LiftState = LIFT_STATE0, t0 = 0): LiftState[] => {
  const out: LiftState[] = []; let s = st;
  seq.forEach((e, i) => { s = liftDecide(s, ev(e), t0 + i * 1000, lift); out.push(s); });
  return out;
};
const CONFIRM_STEPS = Math.ceil(LIFT_OFFROAD_CONFIRM_MS / 1000);   // 3 one-second reports at 2500 ms

console.log("A. a red light on a road — the map sees the road every second; one blank second and one bad second change nothing");
{
  const seq: Partial<LiftEvidence>[] = Array.from({ length: 60 }, () => ({ speedMs: 0, roadHit: true }));
  seq[20] = { speedMs: 0, roadHit: null };            // one second with nothing rendered
  seq[35] = { speedMs: 0, roadHit: false };           // one second the box missed the road (a wobble)
  const out = run(seq);
  ok("A1 never lifted in 60 s at 0 km/h", out.every((s) => s.targetM === 0), `max ${Math.max(...out.map((s) => s.targetM))}`);
  ok("A2 the road sighting after the bad second clears the off-road timer", out[36].offRoadSince === null && out[36].why === "road");
}

console.log("B. the three signals that mean 'road', each alone, at 0 km/h");
{
  ok("B1 the map's road within the box → 0", run([{ speedMs: 0, roadHit: true }])[0].targetM === 0);
  ok("B2 on the route (6 m) while the map says no road → 0 (guidance wins)", run([{ speedMs: 0, navDistM: 6, roadHit: false }])[0].targetM === 0);
  ok("B3 at 30 km/h with no road in the box and no route → 0 (speed wins)", run([{ speedMs: 30 / 3.6, roadHit: false }])[0].targetM === 0);
  ok("B4 speed exactly at the floor counts as moving", run([{ speedMs: LIFT_ONROAD_SPEED_MS, roadHit: false }])[0].why === "speed");
  ok("B5 off the route by 40 m at 5 km/h in a lot (no road) → lifts after the confirm", run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 5 / 3.6, navDistM: 40, roadHit: false })).at(-1)!.targetM === 10);
}

console.log("C. crawling into a parking lot at 7 km/h: aisles are not roads");
{
  const out = run(Array(6).fill({ speedMs: 7 / 3.6, roadHit: false }));
  ok("C1 the first two seconds only WAIT (no pop on a glitch)", out[0].targetM === 0 && out[1].targetM === 0 && out[1].why === "offroad-wait", out[1].why);
  ok(`C2 lifted to 10 m once off-road has held ${LIFT_OFFROAD_CONFIRM_MS} ms`, out[CONFIRM_STEPS].targetM === 10 && out[CONFIRM_STEPS].why === "offroad", `${out[CONFIRM_STEPS].targetM} ${out[CONFIRM_STEPS].why}`);
  const back = liftDecide(out.at(-1)!, ev({ speedMs: 3, roadHit: true }), 99_000, 10);
  ok("C3 the first road sighting drops it to 0 at once", back.targetM === 0 && back.why === "road" && back.offRoadSince === null);
}

console.log("D. a driveway, a parkade, a tower");
{
  const drive = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: false })).at(-1)!;
  ok("D1 parked in a driveway (no road, no footprint) → the off-road lift", drive.targetM === 10);
  const parkade = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: false, buildingH: 12 })).at(-1)!;
  ok(`D2 inside a 12 m footprint → roof + ${LIFT_BUILDING_MARGIN_M} m`, parkade.targetM === 14 && parkade.why === "bld:12", `${parkade.targetM} ${parkade.why}`);
  const low = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: false, buildingH: 3 })).at(-1)!;
  ok("D3 a 3 m carport never lifts LESS than the off-road lift", low.targetM === 10);
  const tower = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: false, buildingH: 60 })).at(-1)!;
  ok(`D4 a 60 m tower is capped at ${LIFT_MAX_M}`, tower.targetM === LIFT_MAX_M);
  const arrow = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: false, buildingH: 12 }), 16).at(-1)!;
  ok("D5 the arrow's off-road lift (16) beats a 12 m roof + 2", arrow.targetM === 16);
  const inside = run(Array(CONFIRM_STEPS + 1).fill({ speedMs: 0, roadHit: null, buildingH: 9 })).at(-1)!;
  ok("D6 a footprint alone (box empty) is off-road evidence", inside.targetM === 11);
}

console.log("E. no evidence never starts a lift, and ends one only after the hold");
{
  const nothing = run(Array(30).fill({ speedMs: 0 }));
  ok("E1 30 s of nothing from the ground: still 0", nothing.every((s) => s.targetM === 0));
  const lifted: LiftState = { targetM: 10, why: "offroad", offRoadSince: 0, unknownSince: null };
  const hold = run(Array(10).fill({ speedMs: 0 }), 10, lifted, 100_000);
  const holdSteps = Math.ceil(LIFT_UNKNOWN_HOLD_MS / 1000);
  ok(`E2 a lift already up survives ${LIFT_UNKNOWN_HOLD_MS} ms of nothing…`, hold[holdSteps - 1].targetM === 10, `${hold[holdSteps - 1].targetM}`);
  ok("E3 …then comes down", hold[holdSteps].targetM === 0 && hold[holdSteps].why === "unknown", `${hold[holdSteps].targetM} ${hold[holdSteps].why}`);
  const gap = run([{ speedMs: 0, roadHit: false }, { speedMs: 0, roadHit: false }, { speedMs: 0 }, { speedMs: 0, roadHit: false }, { speedMs: 0, roadHit: false }, { speedMs: 0, roadHit: false }, { speedMs: 0, roadHit: false }]);
  ok("E4 a blank second in the middle restarts the confirm (never lift on a broken run of evidence)", gap[4].targetM === 0 && gap[5].targetM === 0 && gap[6].targetM === 10, gap.map((s) => s.targetM).join(","));
}

console.log("F. the road source: Streets v8 classes, the property rule, footprints");
{
  ok("F1 a street is a road", isDrivableRoad({ class: "street" }));
  ok("F2 a motorway link on a bridge is a road", isDrivableRoad({ class: "motorway_link", structure: "bridge" }));
  ok("F3 a parking aisle is NOT (the tileset's spelling)", !isDrivableRoad({ class: "service", type: "service:parking_aisle" }) && isPropertyRoad({ class: "service", type: "service:parking_aisle" }));
  ok("F3b …and the bare OSM spelling", !isDrivableRoad({ class: "service", type: "parking_aisle" }) && isPropertyRoad({ class: "service", type: "parking_aisle" }));
  ok("F4 a driveway / drive-through / parking access road is a PROPERTY", isPropertyRoad({ class: "service", type: "service:driveway" }) && isPropertyRoad({ class: "service", type: "service:drive_through" }) && isPropertyRoad({ class: "service", type: "service:parking" }));
  ok("F5 an alley IS a road (lanes behind houses)", isDrivableRoad({ class: "service", type: "service:alley" }) && !isPropertyRoad({ class: "service", type: "service:alley" }));
  ok("F6 an untyped service road IS a road", isDrivableRoad({ class: "service" }) && !isPropertyRoad({ class: "service" }));
  ok("F7 a path / rail / ferry / golf line is neither", !isDrivableRoad({ class: "path" }) && !isDrivableRoad({ class: "major_rail" }) && !isDrivableRoad({ class: "ferry" }) && !isPropertyRoad({ class: "path" }));
  ok("F8 a building: extrude 'true' with height '12' (a string) → 12", buildingHeightOf({ extrude: "true", height: "12", underground: "false" }) === 12);
  ok("F9 an un-heighted footprint → 4", buildingHeightOf({ extrude: "true", underground: "false" }) === 4);
  ok("F10 underground is not a roof", buildingHeightOf({ extrude: "true", height: 20, underground: "true" }) === null);
  ok("F11 a road / landuse feature is not a building", buildingHeightOf({ class: "parking" }) === null && buildingHeightOf({ class: "street" }) === null);
  // a 40 m square footprint around (49.05, -122.32): ±0.00018° lat, ±0.00027° lng
  const sq = (h: number, dlat = 0.00018, dlng = 0.00027, c = [49.05, -122.32]) => ({ type: "Feature", properties: { extrude: "true", height: h, underground: "false" },
    geometry: { type: "Polygon", coordinates: [[[c[1] - dlng, c[0] - dlat], [c[1] + dlng, c[0] - dlat], [c[1] + dlng, c[0] + dlat], [c[1] - dlng, c[0] + dlat], [c[1] - dlng, c[0] - dlat]]] } });
  ok("F12 inside the footprint → its height", buildingUnder(49.05, -122.32, [sq(15)]) === 15);
  ok("F13 30 m outside it → null", buildingUnder(49.0503, -122.32, [sq(15)]) === null);
  ok("F14 a hole in the footprint (courtyard) → null", buildingUnder(49.05, -122.32, [{ type: "Feature", properties: { extrude: "true", height: 9 }, geometry: { type: "Polygon", coordinates: [sq(9).geometry.coordinates[0], sq(9, 0.00005, 0.00007).geometry.coordinates[0]] } }]) === null);
  ok("F15 the tallest containing footprint wins; a non-containing tall one does not", buildingUnder(49.05, -122.32, [sq(6), sq(21), sq(60, 0.00002, 0.00003, [49.051, -122.32])]) === 21);
  ok("F16 MultiPolygon is handled", buildingUnder(49.05, -122.32, [{ type: "Feature", properties: { extrude: "true", height: 7 }, geometry: { type: "MultiPolygon", coordinates: [sq(7).geometry.coordinates] } }]) === 7);
  ok("F17 no road data loaded → UNKNOWN (never 'off road')", roadEvidence(false, null, null, null).roadHit === null);
  ok("F18 roads loaded, a drivable one 4 m away → road", roadEvidence(true, 4, null, null).roadHit === true);
  ok("F19 roads loaded, the nearest drivable one 40 m away → NOT road", roadEvidence(true, 40, null, null).roadHit === false);
  ok("F19b …but 20 m (a bad fix at a light, the 20:22 sim run) IS still the road", roadEvidence(true, 20, null, null).roadHit === true);
  ok("F20 a driveway 3 m under the car with the street 12 m away → on the property (lot=1)", roadEvidence(true, 12, 3, null).roadHit === false && roadEvidence(true, 12, 3, null).lot === true);
  ok("F21 in the lane (road 4 m) beside a driveway (7 m) → road", roadEvidence(true, 4, 7, null).roadHit === true);
  ok("F21b in the lane OVER a driveway's mouth (driveway 0 m, road 4 m) → still the road (Codex pass 2)", roadEvidence(true, 4, 0, null).roadHit === true);
  ok("F21c the right-turn pocket over a driveway mouth (driveway 1 m, road 9 m) → still the road", roadEvidence(true, 9, 1, null).roadHit === true);
  ok("F21d the driveway itself (driveway 0 m, street 10 m) → property", roadEvidence(true, 10, 0, null).roadHit === false);
  ok("F9b an aggregate outline with extrude=false and a height is NOT a roof", buildingHeightOf({ extrude: "false", height: 40 }) === null);
  ok("F22 a parking aisle 6 m away and no road within reach → off road", roadEvidence(true, null, 6, null).roadHit === false);
  ok("F23 a driveway 12 m away is not 'under' the car", roadEvidence(true, null, 12, null).roadHit === false && roadEvidence(true, null, 12, null).lot === false);
  ok("F24 the footprint height rides along", roadEvidence(true, null, null, 18).buildingH === 18);
}

console.log("G. the ease: a slide over ~1 s, never a pop, lands exactly");
{
  let v = 0, t = 0; const steps: number[] = [];
  while (t < 3) { v = easeLift(v, 10, 0.033); t += 0.033; steps.push(v); }
  const at1s = steps[Math.round(1 / 0.033) - 1];
  ok("G1 monotone, no overshoot", steps.every((x, i) => x <= 10 && (i === 0 || x >= steps[i - 1])));
  ok("G2 ≥ 90 % of the way after 1 s (tau 0.4)", at1s >= 9 && at1s < 10, at1s.toFixed(2));
  ok("G3 lands EXACTLY on the target (snap within 2 cm)", steps.at(-1) === 10);
  ok("G4 dt 0 is a no-op", easeLift(3, 10, 0) === 3);
  ok("G5 the way down is the same slide", easeLift(10, 0, 0.4) < 10 * 0.37 + 0.01 && easeLift(10, 0, 0.4) > 3.6);
}

console.log(fails === 0 ? "\nPASS self_lift_rule" : `\nFAIL self_lift_rule (${fails})`);
if (fails) process.exit(1);
