// speed_limit_snap_test — gate for src/speedLimitSnap.ts: the road you are on runs the way you are going.
// Run: node --experimental-strip-types tools/sim-qc/speed_limit_snap_test.mts
//
// Jeff's 2026-09-10 09:01:55 row: `speed-alert tier=2 mode=ding over=45 limit=50` at 95 km/h westbound on
// the Trans-Canada under the Clearbrook Road overpass (49.038018,-122.338203). OSM within 40 m: the TCH
// at 100, a ramp with no limit, Clearbrook Road at 50 crossing on the bridge. The old nearest-way rule
// picked the overpass. Section A replays that geometry; B–E are the rules around it.
import { snapSpeedLimit, SNAP_TOLERANCE_M, type LimitWay } from "../../src/speedLimitSnap.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
// a way as a straight line through (lat,lng) with a heading, ±len m
const line = (lat: number, lng: number, hdgDeg: number, lenM: number, maxspeedKmh: number, extra: Partial<LimitWay> = {}): LimitWay => {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180, toDeg = (r: number) => (r * 180) / Math.PI;
  const step = (d: number) => ({ lat: lat + toDeg((d * Math.cos(toRad(hdgDeg))) / R), lng: lng + toDeg((d * Math.sin(toRad(hdgDeg))) / (R * Math.cos(toRad(lat)))) });
  return { maxspeedKmh, geom: [step(-lenM), step(0), step(lenM)], ...extra };
};
const P = { lat: 49.038018, lng: -122.338203 };   // the car, on the highway under the overpass

console.log("A. the Clearbrook overpass: highway westbound (course 305), overpass road crossing at ~north-south");
{
  const ways: LimitWay[] = [
    line(P.lat + 0.00002, P.lng, 305, 200, 100, { highway: "motorway", oneway: true }),   // TCH, 2 m north of the car
    line(P.lat, P.lng, 20, 200, 50, { highway: "secondary", oneway: true }),                // Clearbrook Rd, crossing through the car's point
  ];
  const moving = snapSpeedLimit(P.lat, P.lng, ways, 305, 26.4);
  ok("A1 moving at 95 km/h on course 305: the limit is the highway's 100, not the overpass's 50", moving.limitKmh === 100, `got ${moving.limitKmh}`);
  ok("A2 …and the overpass is reported as the rejected crossing (for the receipt)", moving.crossing?.limitKmh === 50 && (moving.crossing?.diffDeg ?? 0) > 35, JSON.stringify(moving.crossing));
  const stopped = snapSpeedLimit(P.lat, P.lng, ways, 305, 0);
  ok("A3 stopped (course not evidence): the old nearest-way rule stands", stopped.limitKmh === 50, `got ${stopped.limitKmh}`);
  const noCourse = snapSpeedLimit(P.lat, P.lng, ways, null, 26.4);
  ok("A4 no course at all: the old nearest-way rule stands", noCourse.limitKmh === 50, `got ${noCourse.limitKmh}`);
}

console.log("B. a two-way road matches in either direction; a one-way road only its own");
{
  const twoWay = [line(P.lat, P.lng, 90, 200, 60)];                                   // drawn eastbound, two-way
  ok("B1 driving WEST on a two-way road drawn eastbound: matched", snapSpeedLimit(P.lat, P.lng, twoWay, 270, 15).limitKmh === 60);
  const oneWay = [line(P.lat, P.lng, 90, 200, 60, { oneway: true })];
  ok("B2 driving WEST against a one-way drawn eastbound: rejected (a divided road's other carriageway)", snapSpeedLimit(P.lat, P.lng, oneWay, 270, 15).limitKmh === null);
  ok("B3 driving EAST on it: matched", snapSpeedLimit(P.lat, P.lng, oneWay, 90, 15).limitKmh === 60);
}

console.log("C. the tolerance and the boundary of the course rule");
{
  const far = [line(P.lat + 0.0004, P.lng, 305, 200, 80)];                             // 44 m away
  ok("C1 a road beyond the 30 m tolerance is not the road you are on", snapSpeedLimit(P.lat, P.lng, far, 305, 20).limitKmh === null);
  ok("C2 SNAP_TOLERANCE_M is 30", SNAP_TOLERANCE_M === 30);
  const slight = [line(P.lat, P.lng, 305 + 30, 200, 80)];                              // 30° off: a gentle curve / a diverging lane
  ok("C3 a way 30° off the course still matches (curves, lane changes)", snapSpeedLimit(P.lat, P.lng, slight, 305, 20).limitKmh === 80);
  const sharp = [line(P.lat, P.lng, 305 + 40, 200, 80)];
  ok("C4 a way 40° off the course does not (a side street at a junction)", snapSpeedLimit(P.lat, P.lng, sharp, 305, 20).limitKmh === null);
  const crawl = [line(P.lat, P.lng, 305 + 90, 200, 30)];
  ok("C5 at 2 m/s the course is not evidence: a crossing road IS matched (parking, a driveway)", snapSpeedLimit(P.lat, P.lng, crawl, 305, 2).limitKmh === 30);
}

console.log("D. two candidate ways along the course: the nearer wins (a frontage road is not ruled out by direction alone)");
{
  const ways = [line(P.lat + 0.00002, P.lng, 305, 200, 100, { highway: "motorway" }), line(P.lat - 0.0002, P.lng, 305, 200, 50, { highway: "residential" })];
  const r = snapSpeedLimit(P.lat, P.lng, ways, 305, 26);
  ok("D1 the highway 2 m away beats the parallel street 22 m away", r.limitKmh === 100 && r.highway === "motorway", `got ${r.limitKmh}`);
}

console.log("E. degenerate inputs never throw");
{
  ok("E1 no ways → null, nearest Infinity", snapSpeedLimit(P.lat, P.lng, [], 305, 20).limitKmh === null && snapSpeedLimit(P.lat, P.lng, [], 305, 20).nearestM === Infinity);
  ok("E2 a single-point way is matched by plain distance", snapSpeedLimit(P.lat, P.lng, [{ maxspeedKmh: 40, geom: [{ lat: P.lat, lng: P.lng }] }], 305, 20).limitKmh === 40);
  ok("E3 NaN course is 'no course'", snapSpeedLimit(P.lat, P.lng, [line(P.lat, P.lng, 20, 100, 50)], NaN, 20).limitKmh === 50);
}

console.log(fails === 0 ? "\nPASS speed_limit_snap" : `\nFAIL speed_limit_snap (${fails})`);
if (fails) process.exit(1);
