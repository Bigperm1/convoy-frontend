// overview_size_test — the crew-overview marker size rule (src/overviewSize.ts). Jeff, 2026-09-24, off his CarPlay
// photo: "why is everybody's car oversized … We need to make sure that these are a good size, including mine." Every
// car — self 45/50 pt, peers 44 pt, scanned twins — draws at 28 pt on a region-wide overview and at its own chase
// size in the chase view, with a quantised ramp between z 12 and z 14.
import { overviewSizePt, isOverviewZoom, OVERVIEW_PT, OVERVIEW_ZOOM, CHASE_ZOOM } from "../../src/overviewSize.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

ok("A1 constants: 28 pt below z 12, own size from z 14", OVERVIEW_PT === 28 && OVERVIEW_ZOOM === 12 && CHASE_ZOOM === 14);
ok("A2 his photo's overview (z 9.6): self 45 → 28", overviewSizePt(45, 9.6) === 28);
ok("A3 peers 44 → 28 at the same zoom", overviewSizePt(44, 9.6) === 28);
ok("A4 phone self 50 → 28", overviewSizePt(50, 9.6) === 28);
ok("A5 a Vancouver–Abbotsford fit (z 7.9) is still 28, never smaller", overviewSizePt(45, 7.9) === 28);
ok("A6 chase view (z 16.6): unchanged 45", overviewSizePt(45, 16.6) === 45);
ok("A7 exactly z 14: unchanged", overviewSizePt(44, 14) === 44);
ok("A8 exactly z 12: 28", overviewSizePt(44, 12) === 28);
ok("B1 midway (z 13): halfway between 28 and 45", Math.abs(overviewSizePt(45, 13) - 36.5) < 0.6, `${overviewSizePt(45, 13)}`);
ok("B2 monotonic across the ramp", (() => { let prev = 0; for (let z = 11; z <= 15; z += 0.05) { const v = overviewSizePt(45, z); if (v + 1e-9 < prev) return false; prev = v; } return true; })());
ok("B3 quantised: z 13.001 and z 13.02 give the same size (no per-frame source churn)", overviewSizePt(45, 13.001) === overviewSizePt(45, 13.02));
ok("B4 a marker already smaller than 28 pt is left alone", overviewSizePt(20, 9) === 20);
ok("C1 bad inputs pass through", overviewSizePt(45, NaN) === 45 && overviewSizePt(0, 10) === 0);
ok("C2 isOverviewZoom", isOverviewZoom(9.6) && isOverviewZoom(13.9) && !isOverviewZoom(14) && !isOverviewZoom(NaN));

console.log(fails ? `FAIL overview_size (${fails})` : "PASS overview_size");
process.exit(fails ? 1 : 0);
