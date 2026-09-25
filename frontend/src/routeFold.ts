// routeFold.ts — THE FOLD escape for the phone's windowed route projection (2026-09-24, John's 18:57 CarPlay photo:
// "the car under the route line"). Pure: no React Native, gated by tools/sim-qc/ribbon_fold_test.mts.
//
// His reroute went right onto King George Boulevard, U-turned 239 m up and came back SOUTH past the same corner; he
// turned LEFT at the corner, straight onto the return leg. projectOntoRoute's travel window (±1.5 × metres moved,
// floor 10 m) was sitting on the outbound leg at the corner, and the corner vertex — an interior optimum of that
// window — stayed the nearest thing IN the window as he drove away: 12, 22, 36 … 76 m at the light, 114 m before
// PROJ_WINDOW_ABANDON_M (120) finally let the global scan run 50 s later. Meanwhile the drawn car, the cut and the
// step machine on the phone all read the corner. (Receipts: `ribbon-trim surf=phone … anchorOff=73 hint=prev
// proj=72`, `proj=101`; `snap-mode … rb=276u fix=-106.4 … distM=48.0` while gpsHdg=180.)
//
// The rule: a windowed answer more than PROJ_FOLD_M off the line is not a corner (a corner keeps the car within a
// few metres of the line) — look at the whole line once, and take it only when it is PROJ_FOLD_GAIN× closer. A GPS
// spike off a single road finds the same segment either way (no change); a divided road's other carriageway is
// ~10–15 m away and never trips PROJ_FOLD_M; the fold does, immediately.
export const PROJ_FOLD_M = 30;
export const PROJ_FOLD_GAIN = 2;
/** True when the whole-line answer should replace the window's. Squared distances, as the projection keeps them. */
export function foldPrefersGlobal(windowD2: number, globalD2: number): boolean {
  if (!(windowD2 > PROJ_FOLD_M * PROJ_FOLD_M)) return false;
  return globalD2 * PROJ_FOLD_GAIN * PROJ_FOLD_GAIN < windowD2;
}
