// cold_step_heal_test — the cold car-strip engine must step past a maneuver it never got within 25 m of,
// and must NOT skip ahead on loops, out-and-backs, parked scatter or with no odometer.
// Run: node --experimental-strip-types tools/sim-qc/cold_step_heal_test.mts
//
// Field defect (Jeff 2026-09-15, instance 1mdvgz-926948): after the 09:23:39 PDT reroute the cold engine sat on
// step 0/3 for the rest of the drive (car-strip cold rem 1671 → 2854 m, turn 61 → 1244 m, rem − turn = 1610 on
// every row) while the phone engine healed to step 2/3 rem=121m. Scenarios A-G port the route agent's scratch
// model (2026-09-15), which reproduced the stuck walk on A and G and rejected the phone rule copied as-is (it
// mis-healed the loop start). This file imports the REAL src/coldStepHeal.ts and src/tripOdometer.ts.
// The 25 m walk below is src/navNotification.ts updateNavBanner's loop, verbatim in shape.
// ⚠ Synthetic geometry. NOT a field verification — the next reroute's `cold-step-heal` + `car-strip cold` rows are.
// EXITS NON-ZERO ON FAILURE.
import { buildColdHealGeom, coldHealStep, newColdHealState, COLD_HEAL_TICKS, type ColdHealState, type ColdHealGeom } from "../../src/coldStepHeal.ts";
import { odoStart, odoAdd, odoMeters } from "../../src/tripOdometer.ts";
import type { LngLat } from "../../src/navAnchor.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

const LAT0 = 49.162, LNG0 = -122.6598, MLAT = 111320, MLNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number) => ({ lat: LAT0 + y / MLAT, lng: LNG0 + x / MLNG });
const hav = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371000, k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k, dLng = (b.lng - a.lng) * k;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
type Step = { endLat: number; endLng: number; distanceM: number };
type Route = { coords: LngLat[]; steps: Step[]; geom: ColdHealGeom };
function densify(pts: [number, number][], stepM = 25) {
  const xy: [number, number][] = [pts[0]]; const map = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; const L = Math.hypot(bx - ax, by - ay); const n = Math.max(1, Math.round(L / stepM));
    for (let k = 1; k <= n; k++) xy.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    map.push(xy.length - 1);
  }
  return { xy, map };
}
function mkRoute(xy: [number, number][], stepEnds: number[]): Route {
  const coords = xy.map(([x, y]) => { const p = ll(x, y); return [p.lng, p.lat] as LngLat; });
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const steps: Step[] = []; let prev = 0;
  for (const e of stepEnds) { const p = ll(...xy[e]); steps.push({ endLat: p.lat, endLng: p.lng, distanceM: cum[e] - cum[prev] }); prev = e; }
  return { coords, steps, geom: buildColdHealGeom(coords, steps.map((s) => ({ lat: s.endLat, lng: s.endLng }))) };
}
function walk(steps: Step[], startIdx: number, car: { lat: number; lng: number }) {
  let idx = Math.min(startIdx, steps.length - 1);
  let d = hav(car, { lat: steps[idx].endLat, lng: steps[idx].endLng });
  while (idx < steps.length - 1 && d < 25) { idx += 1; d = hav(car, { lat: steps[idx].endLat, lng: steps[idx].endLng }); }
  let rem = d; for (let i = idx + 1; i < steps.length; i++) rem += steps[i].distanceM;
  return { idx, d, rem };
}
type Tick = { x: number; y: number; v: number };
function run(r: Route, ticks: Tick[], heal: boolean, opts: { noOdo?: boolean } = {}) {
  let idx = 0; const st: ColdHealState = newColdHealState(); let odo = odoStart(); let t = 1_700_000_000_000;
  let heals = 0, maxRem = 0, lastRem = 0; const trace: string[] = [];
  for (const k of ticks) {
    const car = ll(k.x, k.y); t += 1000;
    odo = odoAdd(odo, { lat: car.lat, lng: car.lng, at: t, speedMs: k.v });
    let w = walk(r.steps, idx, car); idx = w.idx;
    if (heal) {
      const res = coldHealStep(r.geom, st, idx, r.steps.length, car, w.d, k.v, opts.noOdo ? null : odoMeters(odo));
      if (res.healed) { heals++; idx = res.idx; w = walk(r.steps, idx, car); idx = w.idx; }
    }
    maxRem = Math.max(maxRem, w.rem); lastRem = w.rem; trace.push(`${idx}:${Math.round(w.rem)}`);
  }
  return { idx, heals, maxRem: Math.round(maxRem), lastRem: Math.round(lastRem), trace };
}
function alongPath(xy: [number, number][], fromVertex: number, s: number): [number, number] {
  let acc = 0, px = xy[fromVertex][0], py = xy[fromVertex][1];
  for (let i = fromVertex; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i], [bx, by] = xy[i + 1]; const seg = Math.hypot(bx - ax, by - ay);
    if (acc + seg >= s) { const f = (s - acc) / seg; return [ax + (bx - ax) * f, ay + (by - ay) * f]; }
    acc += seg; px = bx; py = by;
  }
  return [px, py];
}

console.log("A · 09-15 shape: a 30 m step whose end the car passes >25 m off, then a 25 s fix gap");
const A = (() => {
  const d = densify([[0, 0], [0, 30], [400, 250], [900, 500], [1250, 760], [1300, 950]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[4], d.map[5], d.map[5]]);
  const ticks: Tick[] = [[-7, -5], [-2, 0], [20, 5]].map(([x, y]) => ({ x, y, v: 6 }));
  for (let s = 120; s < 1379; s += 12) { const [x, y] = alongPath(d.xy, d.map[1], s); ticks.push({ x: x + 4, y: y - 3, v: 8 }); }
  return { r, ticks };
})();
{
  const total = A.r.steps.reduce((a, s) => a + s.distanceM, 0);
  const pre = run(A.r, A.ticks, false), post = run(A.r, A.ticks, true);
  ok("A1 pre-fix REPRODUCES the field: stuck on step 0 with rem above the whole route", pre.idx === 0 && pre.maxRem > total, `idx=${pre.idx} maxRem=${pre.maxRem} route=${Math.round(total)}`);
  ok("A2 post-fix: healed onto step 1 and rem ends below 400 m", post.idx === 1 && post.lastRem < 400, `idx=${post.idx} lastRem=${post.lastRem} heals=${post.heals}`);
  const firstHealTick = post.trace.findIndex((x) => x.startsWith("1:"));
  ok(`A3 healed within ${COLD_HEAL_TICKS + 2} fixes of the route line`, firstHealTick >= 0 && firstHealTick <= 3 + COLD_HEAL_TICKS + 2, `first step-1 tick #${firstHealTick}`);
}

console.log("B · normal drive: every step end passed within 25 m");
{
  const d = densify([[0, 0], [0, 300], [300, 300], [300, 800], [600, 800]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[2], d.map[3], d.map[4], d.map[4]]);
  const ticks = d.xy.flatMap(([x, y], i) => i === 0 ? [] : [0.33, 0.66, 1].map((f) => { const [ax, ay] = d.xy[i - 1]; return { x: ax + (x - ax) * f + 2, y: ay + (y - ay) * f - 2, v: 10 }; }));
  const pre = run(r, ticks, false), post = run(r, ticks, true);
  ok("B1 zero heals and an identical step/rem trace", post.heals === 0 && pre.trace.join() === post.trace.join(), `heals=${post.heals}`);
}

console.log("C · loop route (destination = origin): 180 s creeping with scatter at the start, then departs");
{
  const d = densify([[0, 0], [0, 400], [400, 400], [400, 0], [0, 0]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[2], d.map[3], d.map[4], d.map[4]]);
  const ticks: Tick[] = [];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < 180; i++) ticks.push({ x: rnd() * 16, y: -3 + rnd() * 16, v: 2.5 + rnd() });
  for (let y = 5; y < 380; y += 10) ticks.push({ x: 2, y, v: 10 });
  const post = run(r, ticks, true);
  ok("C1 no heal at the loop start or on the way out", post.heals === 0 && post.idx === 0, `heals=${post.heals} idx=${post.idx}`);
  ok("C2 the last step end was matched FORWARD (not onto segment 0)", r.geom.stepEndSeg[r.geom.stepEndSeg.length - 1] > 10, `stepEndSeg=${r.geom.stepEndSeg.join(",")}`);
}

console.log("D · out-and-back on the same road, return leg 3 m over");
{
  const d = densify([[0, 0], [0, 150], [0, 600], [3, 600], [3, 150], [300, 150]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[2], d.map[4], d.map[5], d.map[5]]);
  const ticks: Tick[] = [];
  for (let y = 0; y < 590; y += 8) ticks.push({ x: 1.5 + (y % 16 === 0 ? 2 : -2), y, v: 12 });
  const pre = run(r, ticks, false), post = run(r, ticks, true);
  ok("D1 outbound leg: zero heals, same index as the plain walk", post.heals === 0 && post.idx === pre.idx, `heals=${post.heals} idx=${post.idx} walk=${pre.idx}`);
}

console.log("E · parked 60 m past a missed step end, scatter, speed 0");
{
  const d = densify([[0, 0], [0, 30], [400, 250], [900, 500], [1300, 950]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[3], d.map[4], d.map[4]]);
  const ticks = Array.from({ length: 300 }, (_, i) => ({ x: 55 + (i % 5), y: 60 + (i % 3), v: 0 }));
  ok("E1 zero heals", run(r, ticks, true).heals === 0);
}

console.log("F · A's drive with every fix delivered twice (bg task + foreground car feed)");
{
  const d = densify([[0, 0], [0, 30], [400, 250], [900, 500], [1250, 760], [1300, 950]]);
  const r = mkRoute(d.xy, [d.map[1], d.map[4], d.map[5], d.map[5]]);
  const base: Tick[] = [];
  for (let s = 120; s < 870; s += 12) { const [x, y] = alongPath(d.xy, d.map[1], s); base.push({ x, y, v: 8 }); }
  const post = run(r, base.flatMap((k) => [k, k]), true);
  ok("F1 still heals", post.idx >= 1, `idx=${post.idx} heals=${post.heals}`);
}

console.log("G · two 30 m steps (roundabout-like) both missed inside a 20 s fix gap");
{
  const d = densify([[0, 0], [0, 200], [30, 215], [60, 200], [60, 900], [300, 900]], 10);
  const r = mkRoute(d.xy, [d.map[1], d.map[2], d.map[3], d.map[4], d.map[5], d.map[5]]);
  const ticks: Tick[] = [];
  for (let y = 0; y <= 160; y += 10) ticks.push({ x: 0, y, v: 10 });
  for (let y = 330; y < 880; y += 10) ticks.push({ x: 62, y, v: 10 });
  const pre = run(r, ticks, false), post = run(r, ticks, true);
  ok("G1 pre-fix reproduces stuck", pre.idx === 0, `idx=${pre.idx}`);
  ok("G2 post-fix reaches step 3, one heal at a time, never the arrive step", post.idx === 3, `idx=${post.idx} heals=${post.heals}`);
}

console.log("H · a route swap in the middle of a count carries nothing over");
{
  // Two counted fixes on A, then (as navNotification does on a new geometry) a fresh state on a new route.
  const st = newColdHealState(); let odo = odoStart(); let t = 1_700_000_000_000;
  const feed = (r: Route, k: Tick, s: ColdHealState) => {
    const car = ll(k.x, k.y); t += 1000; odo = odoAdd(odo, { lat: car.lat, lng: car.lng, at: t, speedMs: k.v });
    const w = walk(r.steps, 0, car);
    return coldHealStep(r.geom, s, w.idx, r.steps.length, car, w.d, k.v, odoMeters(odo));
  };
  let i = 0;
  for (; i < A.ticks.length && st.streak < COLD_HEAL_TICKS - 1; i++) feed(A.r, A.ticks[i], st);
  const streakBefore = st.streak;
  const fresh = newColdHealState();
  const res = feed(A.r, A.ticks[i], fresh);
  ok("H1 mid-count (streak 2 of 3) a swap's fresh state neither inherits the count nor heals", streakBefore === COLD_HEAL_TICKS - 1 && fresh.streak === 0 && !res.healed, `streak before swap=${streakBefore}, after=${fresh.streak}`);
  const cont = feed(A.r, A.ticks[i], st);
  ok("H2 control: the OLD state would have healed on that same fix", cont.healed, `healed=${cont.healed}`);
}

console.log("I · no odometer base (a fresh JS context) → no heal");
{
  const post = run(A.r, A.ticks, true, { noOdo: true });
  ok("I1 zero heals without travelled distance", post.heals === 0 && post.idx === 0, `heals=${post.heals} idx=${post.idx}`);
}

console.log(fails === 0 ? "\nPASS cold_step_heal" : `\nFAIL cold_step_heal (${fails})`);
if (fails) process.exit(1);
