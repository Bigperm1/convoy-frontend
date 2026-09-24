// class_car_sprite_test.mts — a Silver class car is drawn as its CLASS on CarPlay / Android Auto, at the GRC sprite's size.
//
// Jeff, driving, 2026-09-23: "when I'm on the silver tier and I select, say, the exotic car, it's showing my GR Corolla
// as the avatar or car marker when it's supposed to be the exotic car." CarMapView registered the driver's flat car as
// the GR Corolla photo by paint for EVERY marker, and the class was never mirrored to the car store.
//   S1 every class with top-down art has a car-surface sprite at 44/88/132 px (the GRC photos' sizes — the nav-locked
//      sprite scale, vehiclePngScale, is tuned for exactly those), square, with the car's length filling the height
//   S2 carStore mirrors the class (selfClass ← getVehicleClass)
//   S3 CarMapView draws CLASS_TOPDOWN_CAR[class] for a 'class' marker, the GRC photo otherwise
// Run: node --experimental-strip-types tools/sim-qc/class_car_sprite_test.mts

import { readFileSync, existsSync } from "node:fs";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const pngSize = (p: string): [number, number] | null => {
  const u = new URL(p, root);
  if (!existsSync(u)) return null;
  const b = readFileSync(u);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const va = read("src/vehicleAssets.ts");
const block = (name: string) => /* keys of an object literal export */ {
  const m = new RegExp(`export const ${name}[^{]*\\{([\\s\\S]*?)\\n\\};`).exec(va);
  return m ? [...m[1].matchAll(/^\s*(\w+):\s*require\("([^"]+)"\)/gm)].map((x) => ({ key: x[1], path: x[2].replace("../", "") })) : [];
};
const classes = block("CLASS_TOPDOWN");
const car = block("CLASS_TOPDOWN_CAR");
ok("S0 read both class tables", classes.length >= 10 && car.length > 0, `${classes.length} / ${car.length}`);
const missing = classes.filter((c) => !car.some((k) => k.key === c.key)).map((c) => c.key);
ok("S1 every class has a car-surface sprite", missing.length === 0, missing.join(","));
const bad: string[] = [];
for (const c of car) {
  for (const [suf, px] of [["", 44], ["@2x", 88], ["@3x", 132]] as const) {
    const sz = pngSize(c.path.replace(/\.png$/, `${suf}.png`));
    if (!sz || sz[0] !== px || sz[1] !== px) bad.push(`${c.key}${suf}=${sz ? sz.join("x") : "missing"}`);
  }
}
ok("S1b 44 / 88 / 132 px squares, like the GRC photos", bad.length === 0, bad.join(" "));

const store = read("src/carplay/carStore.ts");
ok("S2 carStore mirrors the class", /selfClass:\s*getVehicleClass\(s\)/.test(store) && /selfClass\?:\s*string/.test(store));

const cmv = read("src/carplay/CarMapView.tsx");
ok("S3 CarMapView: a 'class' marker draws CLASS_TOPDOWN_CAR[class]",
  /s\.selfMarkerType === 'class' \? \(CLASS_TOPDOWN_CAR as any\)\[selfClassKey\]/.test(cmv)
  && /\[carFlatImg\]: selfClassCarArt \?\? getVehiclePngOrDefault\(s\.selfCarColor\)/.test(cmv));

console.log(failed ? `\nFAIL class_car_sprite (${failed})` : "\nPASS class_car_sprite");
process.exit(failed ? 1 : 0);
