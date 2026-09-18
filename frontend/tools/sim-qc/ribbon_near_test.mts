// ribbon_near_test — the NEAR / FAR split of the route ribbon (2026-09-18, Jeff: "the car is smooth but
// the route line when its dissappearing in front of the car is notchy any way to smooth it out?").
//
//   node --experimental-strip-types tools/sim-qc/ribbon_near_test.mts
//
// The near piece [cut, seam] is re-drawn every frame (src/RibbonNear.tsx); the far piece [seam, end]
// only when the seam moves (src/routeRibbon.ts). These gates drive a synthetic route frame by frame the
// way the app does — per-frame cut from the drawn car, the far piece keyed on the QUANTISED cut the
// 12 Hz render sees, a render lag on top — and prove:
//   N1  the two pieces meet exactly at the seam: no gap, no overlap, every frame (core AND glow);
//   N2  the fade is never truncated by the seam (the cut can never overtake the seam between far rebuilds,
//       even with the far piece a full tick + 12 m of render lag behind);
//   N3  the far piece is rebuilt far less often than the old single source (distinct far keys);
//   N4  the per-frame near piece stays small (coordinates per build);
//   N5  every piece carries alpha; the glow fades in (0.33, 0.66, then 1) instead of a round cap;
//   N6  at the destination both pieces end cleanly (no feature past the end, nothing negative).
// A negative control re-runs N2 with the seam margin removed and must FAIL.
import { registerHooks } from "node:module";
// routeRibbon → mapboxDirections → initMapbox → @rnmapbox/maps (native). Stub the one call it makes.
// The app's sources import each other without extensions (Metro resolves them); Node needs ".ts".
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (s === "@rnmapbox/maps") return { url: "data:text/javascript,export default { setAccessToken(){} };", shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});
const rr = await import("../../src/routeRibbon.ts");
const { buildRibbonPartition, buildRibbonNearFeatures, buildRibbonFarFeatures, ribbonSeamM, ribbonSeamStepM, quantiseM, RIBBON_CASING, RIBBON_CORE } = rr;

let fails = 0;
const ok = (name: string, cond: boolean, detail: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}: ${detail}`); if (!cond) fails++; };

// A 6 km route near 49°N with bends, and congestion so the core has several colour runs.
const coords: [number, number][] = [];
for (let i = 0; i <= 600; i++) {
  const t = i / 600;
  coords.push([-122.6 + t * 0.07 + 0.002 * Math.sin(t * 40), 49.1 + t * 0.03 + 0.0015 * Math.cos(t * 23)]);
}
const cong = coords.slice(1).map((_, i) => (i % 150 < 40 ? "heavy" : i % 150 < 70 ? "moderate" : "low"));
const P = buildRibbonPartition(coords, cong as any, "#2DEC86")!;
const total = P.totalM;

// Metre range covered by a feature list, per kind (features are LineStrings over the partition).
const R = 6371000;
const segM = (a: number[], b: number[]) => {
  const k = Math.PI / 180, dLat = (b[1] - a[1]) * k, dLng = (b[0] - a[0]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * k) * Math.cos(b[1] * k) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const along = (pt: number[]) => {        // metre of a point ON the partition (nearest vertex segment)
  let best = Infinity, bm = 0;
  for (let i = 0; i < P.coords.length - 1; i++) {
    const a = P.coords[i], b = P.coords[i + 1], L = P.cum[i + 1] - P.cum[i];
    const dA = segM(a, pt), dB = segM(b, pt);
    if (Math.abs(dA + dB - L) < 0.05 && dA + dB < best + 1e-9) { best = dA + dB; bm = P.cum[i] + dA; }
  }
  return bm;
};
const span = (feats: any[], kind: string) => {
  const f = feats.filter((x) => x.properties.kind === kind);
  if (!f.length) return null;
  const lo = Math.min(...f.map((x) => along(x.geometry.coordinates[0])));
  const hi = Math.max(...f.map((x) => along(x.geometry.coordinates[x.geometry.coordinates.length - 1])));
  return [lo, hi];
};

// Drive it: 27.8 m/s (100 km/h) at 60 fps; the far render runs at 12 Hz on the QUANTISED cut and lags
// the frame by one tick; lead + fade as at a z14 highway camera (100 m / 150 m) and a z16.5 town one.
const drive = (fade: number, lead: number, stepM: number, marginOk: boolean) => {
  const perFrame = 27.8 / 60, framesPerTick = 5;
  let farKey: number | null = null, farKeys = 0, oldKeys = 0, lastOld: number | null = null;
  let gapOrOverlap = 0, truncated = 0, maxCoords = 0, frames = 0, worstMargin = Infinity;
  let seam = 0, renderCut = 0;
  for (let car = 0; car + lead < total - 5; car += perFrame, frames++) {
    const cut = car + lead;
    if (frames % framesPerTick === 0) {                 // the 12 Hz render: quantised cut, 1 tick late
      renderCut = quantiseM(Math.max(0, cut - perFrame * framesPerTick), stepM)!;
      seam = marginOk ? ribbonSeamM(renderCut, fade) : Math.ceil((renderCut + fade) / ribbonSeamStepM(fade)) * ribbonSeamStepM(fade);
      if (seam !== farKey) { farKey = seam; farKeys++; }
      if (renderCut !== lastOld) { lastOld = renderCut; oldKeys++; }
    }
    worstMargin = Math.min(worstMargin, seam - (cut + fade));
    if (seam < cut + fade - 0.01 && seam < total) truncated++;
    if (frames % 97 !== 0) continue;                    // geometry checks on a sample of frames
    const near = buildRibbonNearFeatures(P, { cutM: cut, fadeM: fade, endM: seam, index: 0 });
    const far = buildRibbonFarFeatures(P, { startM: seam, index: 0 });
    maxCoords = Math.max(maxCoords, near.reduce((n: number, f: any) => n + f.geometry.coordinates.length, 0));
    for (const kind of [RIBBON_CORE, RIBBON_CASING]) {
      // The near piece's LAST point must be the far piece's FIRST point (butt caps meet flush there).
      const nl = near.filter((f: any) => f.properties.kind === kind), fl = far.filter((f: any) => f.properties.kind === kind);
      if (!nl.length || !fl.length) continue;
      if (segM(nl[nl.length - 1].geometry.coordinates.at(-1), fl[0].geometry.coordinates[0]) > 0.01) gapOrOverlap++;
      // …and nothing of the near piece may lie past the seam (an overlap would double the translucent glow).
      const a = span(near, kind); if (a && a[1] > seam + 0.5) gapOrOverlap++;
    }
  }
  return { farKeys, oldKeys, gapOrOverlap, truncated, maxCoords, frames, worstMargin };
};

for (const [label, fade, lead, stepM] of [["z14 highway", 150, 100, 8], ["z16.5 town", 24, 20, 1]] as const) {
  const r = drive(fade, lead, stepM, true);
  ok(`N1 seam flush (${label})`, r.gapOrOverlap === 0, `${r.gapOrOverlap} sampled frames where the pieces do not meet within 1 cm or the near piece runs past the seam`);
  ok(`N2 fade never truncated (${label})`, r.truncated === 0, `${r.truncated}/${r.frames} frames; worst margin past the fade ${r.worstMargin.toFixed(1)} m`);
  ok(`N3 far rebuilds rare (${label})`, r.farKeys * 4 <= r.oldKeys, `far piece rebuilt ${r.farKeys}× vs the old single source ${r.oldKeys}× (quantised cut changes)`);
  ok(`N4 near piece small (${label})`, r.maxCoords <= 400, `max ${r.maxCoords} coordinates per per-frame build`);
}

// N5 — alpha everywhere, the glow ramp, solid far.
{
  const near = buildRibbonNearFeatures(P, { cutM: 1000, fadeM: 150, endM: 1500, index: 0 });
  const far = buildRibbonFarFeatures(P, { startM: 1500, index: 0 });
  const all = [...near, ...far];
  const glowAlphas = near.filter((f: any) => f.properties.kind === RIBBON_CASING).map((f: any) => f.properties.alpha);
  ok("N5 alpha on every piece", all.every((f: any) => typeof f.properties.alpha === "number"), `${all.length} features`);
  ok("N5 glow fades in", JSON.stringify(glowAlphas.slice(0, 3)) === JSON.stringify([0.33, 0.66, 1]), `glow alphas ${JSON.stringify(glowAlphas)}`);
  ok("N5 far is solid", far.every((f: any) => f.properties.alpha === 1), `far alphas ${[...new Set(far.map((f: any) => f.properties.alpha))].join(",")}`);
}

// N6 — the destination.
{
  const near = buildRibbonNearFeatures(P, { cutM: total - 30, fadeM: 150, endM: total + 400, index: 0 });
  const far = buildRibbonFarFeatures(P, { startM: total + 400, index: 0 });
  const hi = Math.max(...near.map((f: any) => along(f.geometry.coordinates[f.geometry.coordinates.length - 1])));
  ok("N6 clean at the destination", far.length === 0 && hi <= total + 0.01, `far features ${far.length}, near ends at ${hi.toFixed(1)} of ${total.toFixed(1)} m`);
}

// Negative control: without the one-step margin the per-frame cut overtakes the seam → N2 must fail.
{
  const r = drive(150, 100, 8, false);
  ok("NEG control (no seam margin must truncate the fade)", r.truncated > 0, `${r.truncated} truncated frames with the margin removed`);
}

console.log(fails ? `FAIL ribbon_near (${fails})` : "PASS ribbon_near");
process.exit(fails ? 1 : 0);
