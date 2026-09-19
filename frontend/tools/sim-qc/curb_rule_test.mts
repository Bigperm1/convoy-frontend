// curb_rule_test — when the app may swap in a route that ARRIVES ON THE DRIVER'S SIDE (src/mapboxDirections.ts curbVerdict).
//
//   node --experimental-strip-types tools/sim-qc/curb_rule_test.mts
//
// Jeff, 2026-09-18: "your call on 1" — after John's 09-16 drive (Ni GR, build 78): "If my destination is on the left,
// makes a u turn instead". His receipts, one `curb …` row per decision:
//   11:27:02  curb TAKEN    extra_s=19   extra_m=55     base_m=2925   — a cheap, fair win
//   13:33:55  curb TAKEN    extra_s=18   extra_m=2243   base_m=17599  — a 2.2 km detour to save one road crossing
//   13:58:12  curb TAKEN    extra_s=-131 extra_m=-1665                — a curb route that turned him back the way he came
// The rule now: never take a curb route that ADDS a U-turn, and each budget (20 s, 10 % of the trip, 250 m) rejects on its
// own. The old rule (distance rejected only if BOTH > 250 m AND > 15 %) is the negative control.
import { registerHooks } from "node:module";
// mapboxDirections → initMapbox → @rnmapbox/maps (native). Stub the one call it makes; Node needs ".ts" on relative imports.
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (s === "@rnmapbox/maps") return { url: "data:text/javascript,export default { setAccessToken(){} };", shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});
const { curbVerdict, countUturns, CURB_MAX_EXTRA_S, CURB_MAX_EXTRA_M } = await import("../../src/mapboxDirections.ts");

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

const step = (type: string, modifier?: string) => ({ distance: 100, duration: 10, maneuver: { type, modifier } });
const plain = [step("depart"), step("turn", "right"), step("turn", "left"), step("arrive", "left")];
const withUturn = [step("depart"), step("turn", "right"), step("continue", "uturn"), step("arrive", "right")];
const route = (s: number, m: number, steps = plain) => ({ duration_s: s, distance_m: m, steps });

// The old rule, verbatim from nav.ts before 2026-09-18 (for the controls).
const oldTake = (best: any, alt: any) => {
  const extra = alt.duration_s - best.duration_s, extraM = alt.distance_m - best.distance_m;
  const tooSlow = extra > 20 || extra > best.duration_s * 0.10;
  const tooFar = extraM > 250 && extraM > best.distance_m * 0.15;
  return !(tooSlow || tooFar);
};

console.log("U-turns are counted from the maneuvers");
ok("U1 a plain route has none", countUturns(route(100, 1000)) === 0);
ok("U2 continue|uturn counts", countUturns(route(100, 1000, withUturn)) === 1);
ok("U3 turn|uturn counts", countUturns({ steps: [step("turn", "uturn")] }) === 1);
ok("U4 bad input is 0", countUturns(null) === 0 && countUturns({}) === 0);

console.log("John's receipts (09-16)");
{
  const best = route(379 - 19, 2925 - 55), alt = route(379, 2925);
  const v = curbVerdict(best, alt);
  ok("J1 +19 s / +55 m, no U-turn: TAKEN (a fair win stays)", v.take, `extra ${v.extraS}s ${v.extraM}m`);
}
{
  const best = route(1606 - 18, 17599 - 2243), alt = route(1606, 17599);
  const v = curbVerdict(best, alt);
  ok("J2 +18 s / +2,243 m: REJECTED (was TAKEN)", !v.take, `extra ${v.extraS}s ${v.extraM}m`);
  ok("J2 control: the old rule took it", oldTake(best, alt));
}
{
  const best = route(1302 + 131, 12439 + 1665), alt = route(1302, 12439, withUturn);
  const v = curbVerdict(best, alt);
  ok("J3 shorter but adds a U-turn: REJECTED (was TAKEN)", !v.take && v.addsUturn, `extra ${v.extraS}s ${v.extraM}m uturn=${v.addsUturn}`);
  ok("J3 control: the old rule took it", oldTake(best, alt));
}
console.log("Each budget rejects on its own");
ok("B1 +21 s rejected", !curbVerdict(route(1000, 10000), route(1000 + CURB_MAX_EXTRA_S + 1, 10000)).take);
ok("B2 +11 % of a short trip rejected", !curbVerdict(route(100, 1000), route(111, 1000)).take);
ok("B3 +251 m rejected even on a long trip", !curbVerdict(route(1000, 50000), route(1005, 50000 + CURB_MAX_EXTRA_M + 1)).take);
ok("B4 +5 s / +80 m, no U-turn: TAKEN", curbVerdict(route(1000, 10000), route(1005, 10080)).take);
ok("B5 a U-turn the base route already had does not count against the curb route",
  curbVerdict(route(1000, 10000, withUturn), route(1005, 10080, withUturn)).take);

console.log(fails === 0 ? "\nPASS curb_rule" : `\nFAIL curb_rule (${fails})`);
if (fails) process.exit(1);
