// Marker size at the crew OVERVIEW (Jeff, 2026-09-24, off his CarPlay photo after tapping Crew: "why is everybody's
// car oversized and Olaf's car top center is really small? We need to make sure that these are a good size,
// including mine. I think they're too big." → "Go").
//
// Every car on the map is drawn at a constant SCREEN size (self 45/50 pt, peers 44 pt) at every zoom — his own
// 2026-08-27 ask, when the self marker had shrunk to a speck beside the 44 pt peers. On a region-wide overview
// (z ≈ 9–10) that reads as oversized. This is the one rule every surface applies to every car — self, stock
// peers, scanned twins — so the crew always reads at one size:
//   • at or below OVERVIEW_ZOOM the target is OVERVIEW_PT (28 pt) for everybody, whatever their chase-view size;
//   • at or above CHASE_ZOOM the target is the marker's own chase-view size (unchanged);
//   • linear in between, quantised so a per-tick source update only changes when the size really moves.
// Pure; gate tools/sim-qc/overview_size_test.mts.

export const OVERVIEW_PT = 28;
export const OVERVIEW_ZOOM = 12;
export const CHASE_ZOOM = 14;
// Quantum for the blend factor: 0.02 → at most 50 distinct sizes across the ramp, so a slow zoom-out does not
// rewrite the source on every camera frame.
const RAMP_Q = 0.02;

/** The point size a marker should draw at for this camera zoom, given its chase-view size. */
export function overviewSizePt(chasePt: number, zoom: number): number {
  if (!(chasePt > 0)) return chasePt;
  if (!Number.isFinite(zoom)) return chasePt;
  if (zoom >= CHASE_ZOOM) return chasePt;
  if (zoom <= OVERVIEW_ZOOM) return Math.min(chasePt, OVERVIEW_PT);
  const t = Math.round(((zoom - OVERVIEW_ZOOM) / (CHASE_ZOOM - OVERVIEW_ZOOM)) / RAMP_Q) * RAMP_Q;
  const lo = Math.min(chasePt, OVERVIEW_PT);
  return Math.round((lo + (chasePt - lo) * t) * 100) / 100;
}

/** True when the camera is in the overview band, i.e. markers are drawn smaller than their chase size. */
export function isOverviewZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom < CHASE_ZOOM;
}
