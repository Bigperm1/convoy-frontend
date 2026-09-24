// border_units_test — the speed-unit border rule (src/borderUnits.ts): the car's own position says
// km/h or mph with no network call. Jeff, 2026-09-24: "go ship the border rule". Every named place
// below is a real coordinate; the dead band, Point Roberts, the Gulf Islands, the Juan de Fuca split,
// the irregular eastern border and the Mexican zone must all hold.
import { borderSide, borderUnit } from "../../src/borderUnits.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// A — the 49th-parallel stretch (BC mainland → Manitoba)
ok("A1 Abbotsford → km/h", borderUnit(49.05, -122.33, "mph") === "kmh");
ok("A2 Sumas WA (1.1 km south of the line) → mph", borderUnit(48.99, -122.26, "kmh") === "mph");
ok("A3 Vancouver → km/h", borderUnit(49.28, -123.12, "mph") === "kmh");
ok("A4 Bellingham → mph", borderUnit(48.75, -122.48, "kmh") === "mph");
ok("A5 Seattle → mph", borderUnit(47.6, -122.33, "kmh") === "mph");
ok("A6 Calgary → km/h", borderUnit(51.05, -114.07, "mph") === "kmh");
ok("A7 Sweetgrass MT (Coutts crossing) → mph", borderUnit(48.99, -111.96, "kmh") === "mph");
ok("A8 Winnipeg → km/h", borderUnit(49.9, -97.14, "mph") === "kmh");
ok("A9 Pembina ND (Emerson crossing) → mph", borderUnit(48.966, -97.24, "kmh") === "mph");
ok("A10 Houston → mph", borderUnit(29.76, -95.4, "kmh") === "mph");
ok("A11 Dallas → mph", borderUnit(32.78, -96.8, "kmh") === "mph");

// B — the dead band along 0 Avenue: GPS noise must not flip the tile
ok("B1 0 Ave Langley, on km/h → stays km/h", borderUnit(49.0009, -122.55, "kmh") === "kmh");
ok("B2 0 Ave Langley, on mph → stays mph", borderUnit(49.0009, -122.55, "mph") === "mph");
ok("B3 Boundary Rd Sumas side (49.9985) → stays", borderSide(48.9985, -122.27) === null);
ok("B4 just past the band north (49.0025) → ca", borderSide(49.0025, -122.55) === "ca");
ok("B5 just past the band south (48.9975) → us", borderSide(48.9975, -122.55) === "us");

// C — Point Roberts vs the islands west of the meridian
ok("C1 Point Roberts → mph", borderUnit(48.985, -123.05, "kmh") === "mph");
ok("C2 Tsawwassen ferry terminal → km/h", borderUnit(49.006, -123.13, "mph") === "kmh");
ok("C3 Galiano Island → km/h", borderUnit(48.93, -123.45, "mph") === "kmh");
ok("C4 Victoria → km/h", borderUnit(48.43, -123.37, "mph") === "kmh");
ok("C5 Sooke → km/h", borderUnit(48.37, -123.73, "mph") === "kmh");
ok("C6 Port Angeles → mph", borderUnit(48.12, -123.43, "kmh") === "mph");
ok("C7 Portland → mph", borderUnit(45.52, -122.68, "kmh") === "mph");
ok("C8 San Francisco → mph", borderUnit(37.77, -122.42, "kmh") === "mph");

// D — east of Lake of the Woods: only the unambiguous latitudes decide
ok("D1 Toronto → keeps current (km/h)", borderUnit(43.65, -79.38, "kmh") === "kmh");
ok("D2 Toronto → keeps current (mph)", borderUnit(43.65, -79.38, "mph") === "mph");
ok("D3 Detroit → keeps current", borderSide(42.33, -83.05) === null);
ok("D4 New York → mph", borderUnit(40.71, -74.0, "kmh") === "mph");
ok("D5 Miami → mph", borderUnit(25.76, -80.19, "kmh") === "mph");
ok("D6 Thunder Bay (48.38, east of the meridian) → keeps", borderSide(48.38, -89.25) === null);
ok("D7 Churchill MB → km/h", borderUnit(58.77, -94.17, "mph") === "kmh");

// E — the Mexican zone and the far south keep the current unit
ok("E1 San Diego → keeps", borderSide(32.72, -117.16) === null);
ok("E2 El Paso → keeps", borderSide(31.76, -106.49) === null);
ok("E3 Phoenix → mph", borderUnit(33.45, -112.07, "kmh") === "mph");
ok("E4 Cancún → keeps", borderSide(21.16, -86.85) === null);
ok("E5 Los Angeles → mph", borderUnit(34.05, -118.24, "kmh") === "mph");

// F — bad input keeps the current unit
ok("F1 NaN → keeps", borderUnit(NaN, -122, "kmh") === "kmh");
ok("F2 Infinity → keeps", borderUnit(49, Infinity, "mph") === "mph");

console.log(fails === 0 ? "\nPASS border_units" : `\nFAIL border_units (${fails})`);
if (fails) process.exit(1);
