// ribbonAnchor — where the route line's CUT is anchored on the ribbon's own metres.
// Dependency-free on purpose (no React, no RN, no imports): `tools/sim-qc/ribbon_anchor_test.mts`
// drives this exact code under plain Node. src/routeRibbon.ts re-exports everything here.
export type LngLat = [number, number];
/** The slice of a RibbonPartition the anchor needs: vertices, cumulative metres, total. */
export type AnchorPartition = { coords: LngLat[]; cum: number[]; totalM: number };

/**
 * Metres along THIS partition's own line for a point, plus its lateral distance. This is
 * what the route-line cut must be computed in (2026-09-03): `frac × totalM` from a
 * projection onto a DIFFERENT polyline (the precision-5 nav polyline vs the dense
 * `coordinates` the ribbon is built from) drifts by the two lengths' difference — a
 * percent of the distance driven, i.e. tens of metres mid-route — and the eased fraction
 * lagged the eased marker on its own clock. Anchoring the cut to the DRAWN car on the
 * ribbon's own metres removes both by construction. `nearM ± spanM` keeps the search local
 * so a parallel leg 60 m away (divided highway, out-and-back) cannot capture the anchor.
 */
export function alongMOnPartition(
  p: AnchorPartition, lat: number, lng: number, nearM?: number | null, spanM = 250,
): { m: number; distM: number } | null {
  const n = p.coords.length;
  if (n < 2) return null;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(lat));
  const X = (ln: number) => toRad(ln - lng) * cosLat * R;
  const Y = (la: number) => toRad(la - lat) * R;
  const lo = typeof nearM === "number" && Number.isFinite(nearM) ? nearM - spanM : -Infinity;
  const hi = typeof nearM === "number" && Number.isFinite(nearM) ? nearM + spanM : Infinity;
  let bestD2 = Infinity, bestM = 0;
  // Start at the first segment that can reach the window (binary search on cum) instead of
  // walking every vertex of a 40 km partition per frame (Codex rescue 2026-09-06); the loop
  // still stops at the window's far end.
  let start = 1;
  if (lo > -Infinity) {
    let a = 1, b = n - 1;
    while (a < b) { const mid = (a + b) >> 1; if (p.cum[mid] < lo) a = mid + 1; else b = mid; }
    start = Math.max(1, a);
  }
  let px = X(p.coords[start - 1][0]), py = Y(p.coords[start - 1][1]);
  for (let i = start; i < n; i++) {
    const cx = X(p.coords[i][0]), cy = Y(p.coords[i][1]);
    const s0 = p.cum[i - 1], s1 = p.cum[i];
    if (s0 > hi) break;
    if (s1 >= lo && s0 <= hi) {
      const dx = cx - px, dy = cy - py, len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(px * dx + py * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = px + t * dx, qy = py + t * dy, d2 = qx * qx + qy * qy;
      if (d2 < bestD2) { bestD2 = d2; bestM = s0 + t * (s1 - s0); }
    }
    px = cx; py = cy;
  }
  if (bestD2 === Infinity) return null;
  return { m: Math.max(0, Math.min(p.totalM, bestM)), distM: Math.sqrt(bestD2) };
}

/**
 * THE CUT ANCHOR (2026-09-05, Jeff: "the route line is way too far away from the car" — his
 * 4-hour CarPlay drive: `anchorOff` averaged 417 m over 807 receipts, max 1268 m, `lag` −249 m).
 * `alongMOnPartition` needs a hint so a parallel leg cannot capture the anchor, and both
 * surfaces fed it `fracDrawn × totalM` — a FRACTION measured on one line (the projection's)
 * applied to ANOTHER (this partition). The two lengths differ by about a percent, so the
 * hint drifts a percent of the distance driven: past ~25 km it is outside its own ±250 m
 * window, the windowed search returns the window's far end (lateral distance = hundreds of
 * metres, i.e. the receipts above), the >80 m guard rejects it and the code fell back to
 * the same wrong metre — plus the lead. The line then started hundreds of metres from the
 * car. The phone's rows read 1 m only because its drives were short.
 *
 * This helper never uses a foreign fraction as the hint. The hint is the LAST anchor found
 * on THIS partition (the car cannot move 250 m between frames), and with no usable hint
 * (nav start, a route swap, the anchor lost) it runs ONE global search — cheap, a linear
 * pass over the partition — and stays local from then on. `fallbackM` (the old metre) is
 * used only when the car is genuinely >80 m off this line. The receipt field `hint=` says
 * which path anchored; `tools/sim-qc/ribbon_anchor_test.mts` is the gate.
 */
export type CutAnchorHint = { key: unknown; m: number } | null;
export type CutAnchor = { m: number; distM: number; src: "prev" | "global" | "fallback"; hint: CutAnchorHint };
export function anchorCutM(
  p: AnchorPartition, lat: number, lng: number, hint: CutAnchorHint, key: unknown, fallbackM: number, spanM = 250,
): CutAnchor {
  const local = (hint && hint.key === key) ? alongMOnPartition(p, lat, lng, hint.m, spanM) : null;
  let best = local;
  let src: CutAnchor["src"] = "prev";
  if (!best || best.distM > 80) {
    const g = alongMOnPartition(p, lat, lng, null);
    if (g && (!best || g.distM < best.distM)) { best = g; src = "global"; }
  }
  if (best && best.distM <= 80) return { m: best.m, distM: best.distM, src, hint: { key, m: best.m } };
  // Off this line: keep the old metre for the cut, keep the last good hint (it will re-seed
  // the local search the moment the car is back within 80 m), and say so.
  return { m: fallbackM, distM: best ? best.distM : Infinity, src: "fallback", hint: hint && hint.key === key ? hint : null };
}

