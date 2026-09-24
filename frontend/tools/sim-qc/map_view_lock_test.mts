// map_view_lock_test.mts — Free's arrow and Silver's class car keep the map 2D on every surface (2026-09-23).
//
// Jeff, driving, 2026-09-23: "when I go to the garage and I click on the free tier arrow top down and go back to the
// map, it's showing on CarPlay that it's in 3D, but it needs to be stuck on 2D. Also, with the silver tier, it needs to
// be 2D as well and no 3D because that's the gate for the tiers." Telemetry: `garage-drive car=arrow`, then CarPlay
// cam-probe p=48 (pitched) until his own view tap. Runs the REAL src/mapViewMode.ts (the one bus the phone map,
// CarPlay, Android Auto and the nav start/teardown all use) with settings + the Garage store stubbed.
//   V1 the 2D arrow (arrowPick unset or 'arrow'): route start's 3D is not granted; the button answers 2D and changes nothing
//   V2 the class car: same
//   V3 a 3D car on the road (the 3D arrow, the 3D class car = marker 'car', a scan): route start goes 3D, the button toggles
//   V4 switching 2D car → 3D car mid-drive brings back the 3D the route asked for, and tells the surfaces; and back again
//   V5 route end (reset) is 2D for everyone, as before
// Run: node --experimental-strip-types tools/sim-qc/map_view_lock_test.mts

import { register } from "node:module";
register("./viewlock/loader.mjs", import.meta.url);

const settings: any = await import(new URL("./viewlock/stubs/settings.mjs", import.meta.url).href);
const garage: any = await import(new URL("./viewlock/stubs/garageStore.mjs", import.meta.url).href);
const mv: any = await import("../../src/mapViewMode.ts");

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const seen: boolean[] = [];
mv.subscribeMapView2D((v: boolean) => seen.push(v));
const routeStart = () => mv.setMapView2D(false);     // navNotification startNavBanner
const routeEnd = () => mv.resetMapView2D();          // the universal teardown

// V1 — Free: the 2D arrow.
settings.__set({ selfMarkerType: "arrow" });
garage.__set({});
routeStart();
ok("V1 2D arrow (no pick recorded): route start stays 2D", mv.isMapView2D() === true && mv.isMapView2DLocked() === true);
ok("V1b the view button answers 2D and changes nothing", mv.toggleMapView2D() === true && mv.isMapView2D() === true);
garage.__set({ arrowPick: "arrow" });
ok("V1c 2D arrow picked explicitly: still 2D", mv.isMapView2D() === true);
routeEnd();

// V2 — Silver: the class car.
settings.__set({ selfMarkerType: "class", vehicleClass: "exotic" });
routeStart();
ok("V2 class car: route start stays 2D", mv.isMapView2D() === true && mv.isMapView2DLocked() === true);
ok("V2b the view button answers 2D", mv.toggleMapView2D() === true && mv.isMapView2D() === true);
routeEnd();

// V3 — Gold / Ultra cars follow the drive exactly as before.
for (const [label, s, g] of [
  ["3D arrow", { selfMarkerType: "arrow" }, { arrowPick: "arrow3d" }],
  ["3D class car", { selfMarkerType: "car" }, {}],
  ["scan", { selfMarkerType: "car", carScanStatus: "ready", carScanId: "x" }, {}],
] as const) {
  settings.__set(s); garage.__set(g);
  ok(`V3 ${label}: idle is 2D`, mv.isMapView2D() === true && mv.isMapView2DLocked() === false);
  routeStart();
  ok(`V3 ${label}: route start goes 3D`, mv.isMapView2D() === false);
  ok(`V3 ${label}: the button toggles to 2D and back`, mv.toggleMapView2D() === true && mv.toggleMapView2D() === false);
  routeEnd();
}

// V4 — the car changes mid-drive.
settings.__set({ selfMarkerType: "class" }); garage.__set({});
routeStart();
seen.length = 0;
settings.__set({ selfMarkerType: "car" });           // Garage → the 3D class car
ok("V4 class car → 3D class car mid-route: the route's 3D comes back, surfaces told", mv.isMapView2D() === false && seen.at(-1) === false);
settings.__set({ selfMarkerType: "arrow" });          // → the 2D arrow
ok("V4b → 2D arrow mid-route: flat again, surfaces told", mv.isMapView2D() === true && seen.at(-1) === true);
garage.__set({ arrowPick: "arrow3d" });               // → the 3D arrow
ok("V4c → 3D arrow: 3D again", mv.isMapView2D() === false && seen.at(-1) === false);
const n = seen.length;
settings.__set({ selfMarkerType: "arrow", unrelated: 1 });
ok("V4d an unrelated settings write does not re-notify", seen.length === n);

// V5 — route end.
routeEnd();
ok("V5 route end: 2D", mv.isMapView2D() === true);

console.log(failed ? `\nFAIL map_view_lock (${failed})` : "\nPASS map_view_lock");
process.exit(failed ? 1 : 0);
