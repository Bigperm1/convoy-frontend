// ribbon_anchor_test.mts — numeric gate for the route-line CUT ANCHOR (2026-09-05).
// Run: node --experimental-strip-types tools/sim-qc/ribbon_anchor_test.mts   (exits non-zero on failure)
//
// Jeff's 4-hour CarPlay drive: `ribbon-trim surf=car … anchorOff=417 (avg) lag=-249` on 807
// receipts — the line started hundreds of metres from the car. The anchor search was hinted by
// `fracDrawn × totalM`, a fraction measured on the projection line applied to the ribbon's own
// partition; the lengths differ by ~1 %, so past ~25 km the hint was outside its own ±250 m
// window and the cut fell back to the same wrong metre. anchorCutM never uses a foreign
// fraction: last anchor as the hint, one global search when there is none.
import { alongMOnPartition, anchorCutM, type CutAnchorHint, type AnchorPartition } from "../../src/ribbonAnchor.ts";

// A partition the way routeRibbon.buildRibbonPartition measures one (haversine cumulative
// metres), without the colour runs the anchor never reads.
function buildPartition(coords: [number, number][]): AnchorPartition {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [ln0, la0] = coords[i - 1], [ln1, la1] = coords[i];
    const dLat = toRad(la1 - la0), dLng = toRad(ln1 - ln0);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la0)) * Math.cos(toRad(la1)) * Math.sin(dLng / 2) ** 2;
    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  }
  return { coords, cum, totalM: cum[cum.length - 1] };
}

const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };
const LAT0 = 49.2, LNG0 = -122.9, M_PER_DEG_LAT = 111320;

// A straight 40 km road running north, a dense point every 25 m.
const N = 1601;
const coords: [number, number][] = [];
for (let i = 0; i < N; i++) coords.push([LNG0, LAT0 + (i * 25) / M_PER_DEG_LAT]);
const part = buildPartition(coords);
const totalM = part.totalM;
// The projection line is 1.5 % SHORTER (a coarser polyline): the fraction the app hands the
// anchor search is measured on it.
const projLenM = totalM * 0.978;   // ~2.2 %: at 30 km the hint lands ~670 m ahead, outside its own window by ~420 m — Jeff's signature

// Positions are given by VERTEX INDEX so the truth is the partition's own cumulative metre
// (haversine) — a degrees→metres constant would disagree with it by ~0.1 %, 34 m at 30 km.
function carAtIdx(p: AnchorPartition, idx: number, lateralM = 0): { lat: number; lng: number; m: number } {
  const [ln, la] = p.coords[idx];
  return { lat: la, lng: ln + lateralM / (M_PER_DEG_LAT * Math.cos((la * Math.PI) / 180)), m: p.cum[idx] };
}

// A: 30 km into the drive — the OLD hint (frac × totalM) misses by ~1.5 % of 30 km.
const car = carAtIdx(part, 1200);                          // 30 km in
const carM = car.m;
const foreignHint = (carM / projLenM) * totalM;           // what the surfaces used to pass
const oldLocal = alongMOnPartition(part, car.lat, car.lng, foreignHint, 250);
const oldCutBase = (oldLocal && oldLocal.distM <= 80) ? oldLocal.m : foreignHint;
const oldErr = Math.abs(oldCutBase - carM);
check(oldErr > 300,
  `A model is wrong: the old hint at 30 km only missed by ${oldErr.toFixed(0)} m (want >300 m — Jeff's receipts averaged 417)`);
const nRest = 0; void nRest;
check(!!oldLocal && oldLocal.distM > 300,
  `A old windowed search should return a far-off point (window edge): anchorOff=${oldLocal ? oldLocal.distM.toFixed(0) : "null"} (want >300, the receipts' signature)`);

// B: the new anchor with NO prior hint → one global search, on the car.
const b = anchorCutM(part, car.lat, car.lng, null, part, foreignHint);
check(b.src === "global" && Math.abs(b.m - carM) < 1 && b.distM < 1,
  `B first anchor: src=${b.src} m=${b.m.toFixed(1)} (want global, within 1 m of ${carM}) distM=${b.distM.toFixed(1)}`);

// C: next frame, 20 m further, with the hint from B → local search, on the car.
const car2 = carAtIdx(part, 1201);                         // one vertex (25 m) on
const c = anchorCutM(part, car2.lat, car2.lng, b.hint, part, foreignHint + 25);
check(c.src === "prev" && Math.abs(c.m - car2.m) < 1,
  `C hinted anchor: src=${c.src} m=${c.m.toFixed(1)} (want prev, within 1 m of ${car2.m.toFixed(1)})`);

// D: a NEW partition (route swap) → the stale hint is ignored (keyed by partition) → global again.
const part2 = buildPartition(coords.slice(400));
const car3 = carAtIdx(part2, 800);                         // the same spot, 400 vertices in on the new partition
const d = anchorCutM(part2, car3.lat, car3.lng, c.hint, part2, 0);
check(d.src === "global" && Math.abs(d.m - car3.m) < 1,
  `D after a swap: src=${d.src} m=${d.m.toFixed(1)} (want global, ${car3.m.toFixed(1)})`);

// E: the car 120 m off the line (genuinely not on it) → fallback metre, distM reported, hint kept.
const off = carAtIdx(part, 1200, 120);
const e = anchorCutM(part, off.lat, off.lng, c.hint, part, foreignHint);
check(e.src === "fallback" && e.m === foreignHint && e.distM > 100 && e.hint === c.hint,
  `E off the line: src=${e.src} m=${e.m.toFixed(0)} distM=${e.distM.toFixed(0)} hintKept=${e.hint === c.hint} (want fallback, the old metre, >100, kept)`);

// F: an out-and-back route (two legs 30 m apart): with the previous anchor as the hint the
// local search must stay on the OUTBOUND leg, never jump to the return leg 30 m away.
const outback: [number, number][] = [];
for (let i = 0; i < 801; i++) outback.push([LNG0, LAT0 + (i * 25) / M_PER_DEG_LAT]);                       // out, 20 km
const dLng = 30 / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180));
for (let i = 800; i >= 0; i--) outback.push([LNG0 + dLng, LAT0 + (i * 25) / M_PER_DEG_LAT]);              // back, 30 m east
const partOB = buildPartition(outback);
let hint: CutAnchorHint = null;
let jumped = false;
for (let i = 200; i <= 600; i++) {                        // 5 → 15 km along the outbound leg, one vertex per frame
  const pos = carAtIdx(partOB, i, 3);   // 3 m east of the outbound leg (lane offset), i.e. 27 m from the return leg
  const a = anchorCutM(partOB, pos.lat, pos.lng, hint, partOB, pos.m);
  hint = a.hint;
  if (Math.abs(a.m - pos.m) > 5) { jumped = true; break; }
}
check(!jumped, `F out-and-back: the anchor jumped to the return leg (30 m away) with a previous-anchor hint`);

console.log(
  `A old hint @30km err=${oldErr.toFixed(0)}m anchorOff=${oldLocal ? oldLocal.distM.toFixed(0) : "-"}m (field avg 417) | ` +
  `B global src=${b.src} err=${Math.abs(b.m - carM).toFixed(2)}m | C prev src=${c.src} err=${Math.abs(c.m - car2.m).toFixed(2)}m | ` +
  `D swap src=${d.src} | E off-line src=${e.src} distM=${e.distM.toFixed(0)} | F out-and-back jumped=${jumped}`,
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
