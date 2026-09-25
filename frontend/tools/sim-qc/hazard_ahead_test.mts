// hazard_ahead_test — Scout's "hazard ahead" call for crew-reported hazards (src/hazardAhead.ts): the lead scales with
// speed inside 1–2 km, the pin must be in the forward cone, the line names the kind and the distance, and map.tsx
// actually uses all of it (Jeff, 2026-09-25: "a SCOUT NOTIFICATION THAT A SPECIFIC HAZARD IS AHEAD … A GOOD DISTANCE AWAY").
//   node --experimental-strip-types tools/sim-qc/hazard_ahead_test.mts
import { readFileSync } from "node:fs";
import {
  HAZARD_AHEAD_LEAD_S, HAZARD_AHEAD_MIN_M, HAZARD_AHEAD_MAX_M, HAZARD_AHEAD_REARM_EXTRA_M, HAZARD_AHEAD_CONE_DEG, HAZARD_AHEAD_MIN_KMH,
  hazardAheadLeadM, bearingDeg, isAheadOf, hazardAheadDistance, hazardAheadKindWord, hazardAheadLine, HAZARD_AHEAD_OPENERS,
} from "../../src/hazardAhead.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };
const kmh = (v: number) => v / 3.6;

// A · the lead
ok("A1 45 s of travel, 1 km floor, 2 km cap", HAZARD_AHEAD_LEAD_S === 45 && HAZARD_AHEAD_MIN_M === 1000 && HAZARD_AHEAD_MAX_M === 2000);
ok("A2 parked / crawling / city → the 1 km floor", hazardAheadLeadM(0) === 1000 && hazardAheadLeadM(kmh(30)) === 1000 && hazardAheadLeadM(kmh(50)) === 1000);
ok("A3 100 km/h → 1250 m, 130 km/h → 1625 m", Math.round(hazardAheadLeadM(kmh(100))) === 1250 && Math.round(hazardAheadLeadM(kmh(130))) === 1625);
ok("A4 200 km/h → the 2 km cap; NaN / negative → the floor", hazardAheadLeadM(kmh(200)) === 2000 && hazardAheadLeadM(NaN) === 1000 && hazardAheadLeadM(-5) === 1000);
ok("A5 the old 500 m call is gone: every lead ≥ 1 km, and it beats 500 m by 2× at 50 km/h (36 s of warning, was 36 → now 72)", hazardAheadLeadM(kmh(50)) / (kmh(50)) >= 70);
ok("A6 re-arm needs the lead + 500 m; moving means ≥ 20 km/h", HAZARD_AHEAD_REARM_EXTRA_M === 500 && HAZARD_AHEAD_MIN_KMH === 20);

// B · the cone
ok("B1 bearing: due north / east / south / west", Math.round(bearingDeg(49, -123, 49.01, -123)) === 0 && Math.round(bearingDeg(49, -123, 49, -122.99)) === 90 && Math.round(bearingDeg(49, -123, 48.99, -123)) === 180 && Math.round(bearingDeg(49, -123, 49, -123.01)) === 270);
ok("B2 ±50° cone: 30° off is ahead, 60° off is not", HAZARD_AHEAD_CONE_DEG === 50 && isAheadOf(0, 30) && isAheadOf(0, 330) && !isAheadOf(0, 60) && !isAheadOf(0, 300));
ok("B3 behind is never ahead; wrap-around at north works", !isAheadOf(0, 180) && !isAheadOf(90, 270) && isAheadOf(350, 10) && isAheadOf(10, 350));
ok("B4 no course → no cone (the old behaviour, nothing lost on a GPS-less phone)", isAheadOf(null, 180) && isAheadOf(undefined, 90) && isAheadOf(NaN, 180));

// C · what Scout says
ok("C1 kind words: police / a crash / traffic / a road hazard / a hazard", hazardAheadKindWord("police") === "police" && hazardAheadKindWord("accident") === "a crash" && hazardAheadKindWord("traffic") === "traffic" && hazardAheadKindWord("road") === "a road hazard" && hazardAheadKindWord("zzz") === "a hazard");
ok("C2 km: 1000 → 'about 1 kilometer', 1250 → 'about 1.5 kilometers', 800 → 'about 800 meters', 1980 → 'about 2 kilometers'", hazardAheadDistance(1000, "km") === "about 1 kilometer" && hazardAheadDistance(1250, "km") === "about 1.5 kilometers" && hazardAheadDistance(800, "km") === "about 800 meters" && hazardAheadDistance(1980, "km") === "about 2 kilometers");
ok("C3 mi: 1609 → 'about a mile', 2400 → 'about a mile and a half', 1000 → 'about half a mile', 400 → 'about a quarter mile'", hazardAheadDistance(1609, "mi") === "about a mile" && hazardAheadDistance(2400, "mi") === "about a mile and a half" && hazardAheadDistance(1000, "mi") === "about half a mile" && hazardAheadDistance(400, "mi") === "about a quarter mile");
const line = hazardAheadLine("police", 1000, "km", () => 0);
ok("C4 the line names the kind and the distance and ends with 'ahead.'", line === "Heads up, police reported about 1 kilometer ahead." && hazardAheadLine("road", 1500, "km", () => 0) === "Road hazard reported about 1.5 kilometers ahead." && hazardAheadLine("accident", 1609, "mi", () => 0.99) === "Collision reported about a mile ahead.");
ok("C5 every kind has ≥ 4 openers and none of them already says 'ahead'", ["police", "accident", "traffic", "road"].every((k) => HAZARD_AHEAD_OPENERS[k].length >= 4 && HAZARD_AHEAD_OPENERS[k].every((o) => !/ahead/i.test(o))));

// D · map.tsx uses it
const mapTsx = readFileSync(new URL("../../app/(app)/map.tsx", import.meta.url), "utf8");
ok("D1 the map effect takes its lead from hazardAheadLeadM and re-arms at lead + HAZARD_AHEAD_REARM_EXTRA_M", mapTsx.includes("const leadM = hazardAheadLeadM(coords.speed ?? 0);") && mapTsx.includes("if (dM > leadM + HAZARD_AHEAD_REARM_EXTRA_M) { announced.delete(h.id); continue; }"));
ok("D2 the pin must be in the forward cone of the fix's course (course first, sticky heading as the fallback)", mapTsx.includes("const course = coords.course ?? coords.heading ?? null;") && mapTsx.includes("if (!isAheadOf(course, bearingDeg(coords.lat, coords.lng, h.lat, h.lng))) continue;"));
ok("D3 Scout speaks the kind + distance in the driver's unit, and leaves a hazard-ahead receipt", mapTsx.includes('announce(hazardAheadLine(h.kind, dM, settings.speedUnit === "mph" ? "mi" : "km"))') && mapTsx.includes("logEvent(`hazard-ahead kind=${h.kind} d=${Math.round(dM)} lead=${Math.round(leadM)}"));
ok("D4 the fixed 500 m / 800 m call is gone", !/dM <= 500 && kmh >= 20/.test(mapTsx) && !/if \(dM > 800\) \{ announced\.delete/.test(mapTsx));

console.log(fails === 0 ? "\nPASS hazard_ahead" : `\nFAIL hazard_ahead (${fails})`);
