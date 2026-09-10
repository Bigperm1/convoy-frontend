// tools/sim-qc/watch_taps_test.mts — the wrist-tap rule. One rule, in TypeScript, so the
// watch never carries a second copy of the maths (trap rule `watch-haptic-math-in-swift`).
import { tapSideFor, tapStart, tapDecide, WATCH_NOW_M, WATCH_PREPARE_MIN_M, WATCH_PREPARE_MAX_M, WATCH_PREPARE_LEAD_S } from "../../src/watchTaps.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// A. side from the Mapbox maneuver key
ok("A1 turn|left → left", tapSideFor("turn|left") === "left");
ok("A2 turn|slight right → right", tapSideFor("turn|slight right") === "right");
ok("A3 roundabout|straight → generic", tapSideFor("roundabout|straight") === "generic");
ok("A4 turn|uturn → generic", tapSideFor("turn|uturn") === "generic");
ok("A5 undefined → generic", tapSideFor(undefined) === "generic");
// arrive|left means "the destination is on your left", not "turn left" — a left-turn haptic there
// tells the driver to turn where there is no turn.
ok("A6 arrive|left → generic", tapSideFor("arrive|left") === "generic");
ok("A7 depart|right → generic", tapSideFor("depart|right") === "generic");

// B. a 50 km/h approach: prepare once at the speed-scaled lead, now once at 40 m, nothing else
{
  let st = tapStart(); const spd = 13.9; const taps: Array<[number, string]> = [];
  for (let d = 600, t = 0; d >= 0; d -= spd, t += 1000) {
    const r = tapDecide(st, { stepIdx: 3, distM: d, speedMs: spd, nowMs: t }); st = r.st;
    if (r.tap) taps.push([Math.round(d), r.tap]);
  }
  const lead = Math.min(WATCH_PREPARE_MAX_M, Math.max(WATCH_PREPARE_MIN_M, spd * WATCH_PREPARE_LEAD_S));
  ok("B1 exactly two taps", taps.length === 2, JSON.stringify(taps));
  ok("B2 first is prepare, at or under the lead", taps[0]?.[1] === "prepare" && taps[0][0] <= lead, `${taps[0]} lead=${lead.toFixed(0)}`);
  ok("B3 second is now, at or under WATCH_NOW_M", taps[1]?.[1] === "now" && taps[1][0] <= WATCH_NOW_M, `${taps[1]}`);
}
// C. crawling (8 km/h): lead clamps to the minimum, still two taps
{
  let st = tapStart(); const spd = 2.2; const taps: string[] = [];
  for (let d = 300, t = 0; d >= 0; d -= spd, t += 1000) { const r = tapDecide(st, { stepIdx: 0, distM: d, speedMs: spd, nowMs: t }); st = r.st; if (r.tap) taps.push(`${r.tap}@${Math.round(d)}`); }
  ok("C1 two taps at a crawl", taps.length === 2, taps.join(" "));
  ok("C2 prepare fired at ≤ the minimum lead", parseInt(taps[0]?.split("@")[1] ?? "999") <= WATCH_PREPARE_MIN_M, taps[0]);
}
// D. a new step resets the flags; the same step never re-taps
{
  let st = tapStart();
  let r = tapDecide(st, { stepIdx: 1, distM: 30, speedMs: 10, nowMs: 0 }); st = r.st;
  ok("D1 entering a step already inside NOW_M taps now once", r.tap === "now");
  r = tapDecide(st, { stepIdx: 1, distM: 20, speedMs: 10, nowMs: 2000 }); st = r.st;
  ok("D2 same step, no second now", r.tap === null);
  r = tapDecide(st, { stepIdx: 2, distM: 500, speedMs: 10, nowMs: 3000 }); st = r.st;
  ok("D3 next step starts clean (no tap at 500 m)", r.tap === null && st.stepIdx === 2 && !st.prepared && !st.fired);
}
// E. minimum gap: prepare and now cannot land inside 1.5 s of each other (a short step)
{
  let st = tapStart();
  let r = tapDecide(st, { stepIdx: 5, distM: 100, speedMs: 20, nowMs: 0 }); st = r.st;
  ok("E1 prepare at 100 m / 72 km/h", r.tap === "prepare");
  r = tapDecide(st, { stepIdx: 5, distM: 35, speedMs: 20, nowMs: 800 }); st = r.st;
  ok("E2 now suppressed inside the gap", r.tap === null);
  r = tapDecide(st, { stepIdx: 5, distM: 15, speedMs: 20, nowMs: 1600 }); st = r.st;
  ok("E3 now fires once the gap has passed", r.tap === "now");
}
// F. garbage in → no tap
{
  let st = tapStart();
  const r = tapDecide(st, { stepIdx: 0, distM: NaN, speedMs: 10, nowMs: 0 });
  ok("F1 NaN distance → null", r.tap === null);
}
// G. degenerate inputs that must still behave (a lost fix, an overshot turn)
{
  // NaN speed: the lead clamps to the minimum rather than vanishing, so the prepare still fires.
  let st = tapStart(); const taps: string[] = [];
  for (let d = 300, t = 0; d >= 0; d -= 10, t += 1000) { const r = tapDecide(st, { stepIdx: 0, distM: d, speedMs: NaN, nowMs: t }); st = r.st; if (r.tap) taps.push(`${r.tap}@${Math.round(d)}`); }
  ok("G1 NaN speed still taps (lead clamps to min)", taps.length === 2 && taps[0].startsWith("prepare") && taps[1].startsWith("now"), taps.join(" "));
}
{
  // Past the turn (the projection can go negative): the now tap must still land, exactly once.
  let st = tapStart();
  let r = tapDecide(st, { stepIdx: 9, distM: -12, speedMs: 15, nowMs: 0 }); st = r.st;
  ok("G2 negative distM → now fires once", r.tap === "now");
  r = tapDecide(st, { stepIdx: 9, distM: -40, speedMs: 15, nowMs: 5000 }); st = r.st;
  ok("G2b and never again on that step", r.tap === null);
}
console.log(fails === 0 ? "\nPASS watch_taps" : `\nFAIL watch_taps (${fails})`);
if (fails) process.exit(1);
