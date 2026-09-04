// corner_blend_test.mts — numeric regression gate for src/cornerBlend.ts (2026-09-03).
// Run: node --experimental-strip-types tools/sim-qc/corner_blend_test.mts
// Four scenarios that must hold: divided-highway jitter and a single 4° step stay snapped (0),
// a lot-entrance swing 16 m off the line releases (≈1), the same swing 4 m off stays snapped (0).
// Born from Codex's first second-opinion pass, which found the original rate detection inflated
// GPS jitter into a corner.
import { cornerBlend, newCornerBlendState } from "../../src/cornerBlend.ts";
// A: divided highway — heading 95 with ±2° GPS jitter at 1 Hz, line 35 m away, 90 km/h, snapped. Want 0.
let st = newCornerBlendState(), t = 0, maxA = 0;
for (let i = 0; i < 30; i++) { const h = 95 + ((i % 2) ? 2 : -2); for (let f = 0; f < 60; f++) { t += 16.7; maxA = Math.max(maxA, cornerBlend(st, h, 35, 25, true, t)); } }
// B: lot entrance — course 124→136→150→165→180→(90) over ~5 s at 24 km/h, line 16 m off. Want ≈1 quickly.
let st2 = newCornerBlendState(), t2 = 0, maxB = 0, firstAbove = -1;
const hs = [124, 124, 136, 150, 165, 180, 90, 88, 87];
for (const h of hs) { for (let f = 0; f < 60; f++) { t2 += 16.7; const b = cornerBlend(st2, h, 16, 6.7, true, t2); maxB = Math.max(maxB, b); if (firstAbove < 0 && b > 0.5) firstAbove = t2; } }
// C: same lot turn but the car is only 4 m off the line — must stay snapped (d ≤ 6).
let st3 = newCornerBlendState(), t3 = 0, maxC = 0;
for (const h of hs) { for (let f = 0; f < 60; f++) { t3 += 16.7; maxC = Math.max(maxC, cornerBlend(st3, h, 4, 6.7, true, t3)); } }
// D: highway with a single 4° step between two 1 Hz fixes (the Codex case) — want 0.
let st4 = newCornerBlendState(), t4 = 0, maxD = 0;
for (const h of [95, 95, 99, 99, 99, 95, 95]) { for (let f = 0; f < 60; f++) { t4 += 16.7; maxD = Math.max(maxD, cornerBlend(st4, h, 35, 25, true, t4)); } }
console.log(`A highway jitter max=${maxA.toFixed(3)} (want 0) | B lot turn max=${maxB.toFixed(3)} first>0.5 at ${firstAbove >= 0 ? (firstAbove/1000).toFixed(1)+'s' : 'never'} (want ≈1, early) | C lot turn 4m off max=${maxC.toFixed(3)} (want 0) | D 4° step max=${maxD.toFixed(3)} (want 0)`);
