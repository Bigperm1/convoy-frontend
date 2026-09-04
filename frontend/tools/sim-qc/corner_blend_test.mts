// corner_blend_test.mts — numeric regression gate for src/cornerBlend.ts (2026-09-03).
// Run: node --experimental-strip-types tools/sim-qc/corner_blend_test.mts
// A–D (position): divided-highway jitter and a single 4° step stay snapped (0), a lot-entrance
// swing 16 m off the line releases (≈1), the same swing 4 m off stays snapped (0). Born from
// Codex's first second-opinion pass, which found the original rate detection inflated GPS
// jitter into a corner.
// E–H (nose, added 2026-09-04 from Olaf's corner-trace rows): the 05:52:56 sequence must have
// its HEADING clamped back toward the course, the 06:39:43 straight must NOT move POSITION,
// the eight clean bursts must come through the clamp bit-identical, and a 45° offset below
// 15 km/h must be left alone.
// I2–I4 (same day, from the Codex adversarial pass): the clamp's hold must count GPS FIXES and
// not renders — one bad fix repeated across 3 s of frames may not move the nose (I2), five real
// 1 Hz fixes still must (I3), and a course that stops updating must decay the correction (I4).
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
import { cornerBlend, cornerNose, newCornerBlendState } from "../../src/cornerBlend.ts";
const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };
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
check(maxA === 0, `A highway jitter released (${maxA.toFixed(3)}, want 0)`);
check(maxB > 0.9 && firstAbove > 0 && firstAbove < 5000, `B lot turn did not release fast (max=${maxB.toFixed(3)} at ${firstAbove}ms)`);
check(maxC === 0, `C lot turn 4 m off released (${maxC.toFixed(3)}, want 0)`);
check(maxD === 0, `D 4° step released (${maxD.toFixed(3)}, want 0)`);

// ── NOSE CLAMP (2026-09-04) — Olaf's corner-trace rows, PDT, surf=car unless noted ─────────
const wrap = (d: number) => ((((d) % 360) + 540) % 360) - 180;
/** Replay `noses` (ONE GPS FIX EACH, at ~1 Hz, rendered at 60 fps) through cornerNose.
 *  Each fix carries its OWN timestamp and every render inside that second repeats it — which is
 *  what the surfaces actually do (a 12 Hz trim ticker re-renders the same 1 Hz course sample) and
 *  what the fix-counted hold is written against. */
function replayNose(noses: number[], course: (i: number) => number, spdMs: number, fixMs = 1000) {
  const st = newCornerBlendState(); let t = 0;
  const frames = Math.round(fixMs / 16.7);
  const out: { t: number; nose: number; drawn: number; crs: number; fixAt: number }[] = [];
  for (let i = 0; i < noses.length; i++) {
    const nose = noses[i], crs = course(i);
    const fixAt = t + 16.7;   // the fix lands on this render and stands until the next one
    for (let f = 0; f < frames; f++) { t += 16.7; out.push({ t, nose, drawn: cornerNose(st, nose, crs, fixAt, spdMs, true, t), crs, fixAt }); }
  }
  return { out, st };
}
// E: 05:52:56–53:00 d=2.7/2.6/2.5/2.4/2.4 spd=23–44 hdg 134→114 gpsHdg 89–90 rb 90.
//    The nose values are the MEASURED endpoints (134, 114); the three between them are
//    projectOntoRoute's own bearingSmooth curve for prevSeg=178 / bearing=90, which reproduces
//    both endpoints exactly. Speed is the LOW end of the measured band (23 km/h = 6.4 m/s).
const noseE = [134, 129, 123, 118, 114];
const { out: outE } = replayNose(noseE, () => 90, 6.4);
const endE = outE[outE.length - 1], peakFixE = Math.max(...outE.map(r => Math.abs(wrap(r.drawn - r.nose))));
const overshootE = outE.some(r => wrap(r.nose - r.crs) > 0 && wrap(r.drawn - r.crs) < -0.5);
check(Math.abs(wrap(endE.drawn - endE.crs)) <= 20.5, `E nose still ${Math.abs(wrap(endE.drawn - endE.crs)).toFixed(1)}° off course at the end of the window (want ≤20)`);
check(peakFixE >= 10, `E clamp barely acted (peak ${peakFixE.toFixed(1)}°, want ≥10)`);
check(!overshootE, `E clamp overshot past the course — it must pull to the cone edge, never across`);
// F: 06:39:43–47 d=4.5/1.5/3.7/4.9/5.0 spd=29–44 gpsHdg 219→180 — POSITION must not move.
//    Endpoints measured; the middle course values are deliberately BUNCHED so the turn rate
//    stays ABOVE CORNER_RATE_DPS, proving it is the ≤5 m distance gate holding the snap and
//    not the rate gate quietly doing the work.
let stF = newCornerBlendState(), tF = 0, maxF = 0;
const dF = [4.5, 1.5, 3.7, 4.9, 5.0], hF = [219, 200, 190, 184, 180];
for (let i = 0; i < hF.length; i++) for (let f = 0; f < 60; f++) { tF += 16.7; maxF = Math.max(maxF, cornerBlend(stF, hF[i], dF[i], 8.0, true, tF)); }
check(maxF === 0, `F 06:39:43 straight moved the car off the line (blend ${maxF.toFixed(3)}, want 0)`);
// G: the eight CLEAN bursts must pass through the clamp untouched (identity), at both ends of
//    each window. [nose, course] pairs, straight off the receipts.
const clean: [number, number][] = [
  [153, 161], [212, 213],   // 05:52:41–45
  [215, 206], [144, 143],   // 05:54:16–20
  [52, 59], [64, 65],       // 05:54:31–35
  [212, 216], [233, 232],   // 05:54:46–50
  [238, 219], [180, 180],   // 06:39:43–47  (19° — the worst clean sample of the drive)
  [229, 222], [260, 267],   // 06:41:43–47
  [238, 224], [181, 180],   // 06:44:34–38
  [229, 230], [254, 254],   // 06:47:08–10
];
let cleanBad = 0;
for (const [nose, crs] of clean) {
  const { out } = replayNose([nose, nose, nose, nose, nose], () => crs, 11.1);  // 40 km/h, 5 s
  if (out.some(r => r.drawn !== nose)) cleanBad++;
}
check(cleanBad === 0, `G ${cleanBad}/${clean.length} clean corner samples were altered by the clamp (want 0 — it must be an identity there)`);
// H: 45° off course but only 10 km/h — the raw course spins at low speed, which is the whole
//    reason the nose is locked to the line. Must be left alone.
const { out: outH } = replayNose([135, 135, 135, 135, 135], () => 90, 2.8);
check(outH.every(r => r.drawn === 135), `H clamp fired below 15 km/h — the low-speed course spin is exactly what it must not chase`);

// ── I: THE HOLD MUST COUNT FIXES, NOT FRAMES (2026-09-04 Codex adversarial pass, [high]) ────
// I2: ONE bad course fix, 45° off, re-rendered for 3 s at 60 fps with the SAME fix timestamp —
//     which is what a 12 Hz trim ticker does to a 1 Hz course between fixes. The old hold
//     measured render time, so this alone satisfied it and rotated the nose off a single GPS
//     observation. Must now be an exact identity. Ages stay under NOSE_COURSE_STALE_MS (3000)
//     for every frame here (last age 2989 ms), so it is the DISTINCT-FIX gate being tested,
//     not staleness.
let stI2 = newCornerBlendState(), tI2 = 0, alteredI2 = 0, worstI2 = 0;
const fixAtI2 = 16.7;
for (let f = 0; f < 180; f++) {
  tI2 += 16.7;
  const drawn = cornerNose(stI2, 135, 90, fixAtI2, 11.1, true, tI2);   // 40 km/h, snapped, 45° off
  if (drawn !== 135) { alteredI2++; worstI2 = Math.max(worstI2, Math.abs(wrap(drawn - 135))); }
}
check(alteredI2 === 0, `I2 one bad fix moved the nose on ${alteredI2}/180 frames (worst ${worstI2.toFixed(1)}°) — the hold is counting RENDERS again`);
check(stI2.offN === 1, `I2 counted ${stI2.offN} distinct fixes from one fix timestamp (want 1)`);
// I3: the real 05:52:56 sequence, distinct fix timestamps at 1 Hz — must STILL release, to E's
//     numbers. The gate has to reject one repeated sample without rejecting five real ones.
const { out: outI3, st: stI3 } = replayNose(noseE, () => 90, 6.4);
const endI3 = outI3[outI3.length - 1], peakFixI3 = Math.max(...outI3.map(r => Math.abs(wrap(r.drawn - r.nose))));
check(Math.abs(wrap(endI3.drawn - endI3.crs)) <= 20.5, `I3 1 Hz replay left the nose ${Math.abs(wrap(endI3.drawn - endI3.crs)).toFixed(1)}° off course (want ≤20)`);
check(peakFixI3 >= 10, `I3 1 Hz replay barely clamped (peak ${peakFixI3.toFixed(1)}°, want ≥10)`);
check(stI3.offN >= 2, `I3 engaged off ${stI3.offN} distinct fixes (want ≥2)`);
// I4: the course FREEZES mid-clamp (feed paused / screen-off handoff). After five real fixes have
//     engaged the clamp, no new fix arrives — the correction must decay out, not hold the nose
//     rotated forever. NOSE_COURSE_STALE_MS = 3000, so ~3 s in it is stale and the fall tau (500 ms)
//     takes it to the deadband.
const stI4 = replayNose(noseE, () => 90, 6.4).st;
let tI4 = outI3[outI3.length - 1].t, frozenAt = outI3[outI3.length - 1].fixAt, lastDrawnI4 = 0;
for (let f = 0; f < 360; f++) { tI4 += 16.7; lastDrawnI4 = cornerNose(stI4, 114, 90, frozenAt, 6.4, true, tI4); }  // 6 s, no new fix
check(lastDrawnI4 === 114 && stI4.hdgFix === 0, `I4 a frozen course kept the nose corrected (drawn ${lastDrawnI4.toFixed(1)} vs nose 114, hdgFix ${stI4.hdgFix.toFixed(2)}) — stale course must decay`);

console.log(`E 05:52:56 nose end=${endE.drawn.toFixed(1)}° vs course ${endE.crs} (off ${Math.abs(wrap(endE.drawn - endE.crs)).toFixed(1)}°, want ≤20) peakFix=${peakFixE.toFixed(1)}° | F 06:39:43 position blend max=${maxF.toFixed(3)} (want 0) | G clean samples altered=${cleanBad}/${clean.length} (want 0) | H low-speed altered=${outH.some(r => r.drawn !== 135) ? 'YES' : 'no'} (want no)`);
console.log(`I2 one repeated fix: frames altered=${alteredI2}/180 (want 0) offN=${stI2.offN} (want 1) | I3 1 Hz replay end off course=${Math.abs(wrap(endI3.drawn - endI3.crs)).toFixed(1)}° peakFix=${peakFixI3.toFixed(1)}° offN=${stI3.offN} (want ≥2) | I4 frozen course drawn=${lastDrawnI4.toFixed(1)} hdgFix=${stI4.hdgFix.toFixed(2)} (want 114 / 0)`);
if (fails.length) { console.error(`\nFAIL (${fails.length}):\n  ` + fails.join("\n  ")); process.exit(1); }
console.log("PASS — all 11 scenarios");
