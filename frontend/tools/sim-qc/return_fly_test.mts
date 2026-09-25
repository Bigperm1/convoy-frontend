// return_fly_test — the crew-overview return fly (src/returnFly.ts). Jeff, 2026-09-24: "can it do a cool animation
// where it like swivels and zooms down to where I'm driving?" The state machine pushCam follows and the aim point.
import { RETURN_FLY_MS, predictAhead, returnFlyStep } from "../../src/returnFly.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// A — the state machine
{
  const t0 = 1_000_000;
  const a = returnFlyStep(-1, t0);
  ok("A1 armed → fly, deadline = now + RETURN_FLY_MS", a.action === "fly" && a.next === t0 + RETURN_FLY_MS && !a.landed);
  const b = returnFlyStep(a.next, t0 + 500);
  ok("A2 mid-fly → wait, deadline kept", b.action === "wait" && b.next === a.next);
  const c = returnFlyStep(a.next, t0 + RETURN_FLY_MS);
  ok("A3 at the deadline → push, landed, state cleared", c.action === "push" && c.next === 0 && c.landed);
  const d = returnFlyStep(0, t0 + 5000);
  ok("A4 idle → push, not landed", d.action === "push" && d.next === 0 && !d.landed);
  ok("A5 the fly is short enough to feel like one move (≤ 2.5 s) and long enough to read (≥ 1 s)", RETURN_FLY_MS >= 1000 && RETURN_FLY_MS <= 2500);
}

// B — the aim point: where the car will be when the fly lands
{
  const p = predictAhead(49.1, -122.6, 90, 27.8, RETURN_FLY_MS);   // 100 km/h due east for 1.8 s ≈ 50 m
  const dEastM = (p.lng + 122.6) * 111320 * Math.cos((49.1 * Math.PI) / 180);
  ok("B1 100 km/h east for 1.8 s → ~50 m east", Math.abs(dEastM - 50) < 1 && Math.abs(p.lat - 49.1) < 1e-9, `${dEastM.toFixed(1)} m`);
  const n = predictAhead(49.1, -122.6, 0, 10, 1000);
  ok("B2 north at 10 m/s for 1 s → 10 m north", Math.abs((n.lat - 49.1) * 111320 - 10) < 0.05);
  const s = predictAhead(49.1, -122.6, 90, 0, RETURN_FLY_MS);
  ok("B3 parked → no prediction", s.lat === 49.1 && s.lng === -122.6);
  const u = predictAhead(49.1, -122.6, undefined, 20, RETURN_FLY_MS);
  ok("B4 no heading → no prediction", u.lat === 49.1 && u.lng === -122.6);
  const bad = predictAhead(49.1, -122.6, NaN, NaN, RETURN_FLY_MS);
  ok("B5 bad inputs → the car's own position", bad.lat === 49.1 && bad.lng === -122.6);
}

console.log(fails ? `FAIL return_fly (${fails})` : "PASS return_fly");
process.exit(fails ? 1 : 0);
