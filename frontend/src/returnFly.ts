// The return from the crew overview (Jeff, 2026-09-24: "when the image goes … back to the navigation chase view route,
// can it do a cool animation where it like swivels and zooms down to where I'm driving?" → "Go").
//
// Both surfaces push the chase camera through ONE per-tick setCamera (ConvoyMapbox pushCam, animationMode 'none').
// When a crew overview lapses (the 7 s CREW_RETURN_MS hold on the head unit, the driver's recenter on the phone) that push used to
// take the framing back in a single frame — a deliberate cut from 2026-08-14, when the slow low-pass return looked
// stuck. Now the FIRST push after the overview is one Mapbox flyTo to the chase frame (pitch down, swivel to the
// heading, zoom in), the per-tick pushes stand down while it runs, and the next normal push lands on the frame the
// fly ended on. The fly is aimed at where the car will BE when it lands, so the hand-over does not hop.
// Pure; gate tools/sim-qc/return_fly_test.mts.

export const RETURN_FLY_MS = 1800;

/** The camera's return-fly state: -1 = armed (fly on the next push), 0 = idle, > 0 = flying until this epoch ms. */
export type ReturnFlyState = -1 | 0 | number;

/** Where the car will be after `ms` at this heading and speed (planar, fine for a few seconds). */
export function predictAhead(lat: number, lng: number, headingDeg: number | undefined, speedMs: number | undefined, ms: number): { lat: number; lng: number } {
  const v = typeof speedMs === "number" && Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 0;
  const h = typeof headingDeg === "number" && Number.isFinite(headingDeg) ? headingDeg : NaN;
  if (v === 0 || !Number.isFinite(h) || !(ms > 0)) return { lat, lng };
  const d = v * (ms / 1000);
  const rad = (h * Math.PI) / 180;
  const dLat = (d * Math.cos(rad)) / 111320;
  const dLng = (d * Math.sin(rad)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

/** What pushCam should do this tick given the fly state: run the fly, wait for it, or push normally. */
export function returnFlyStep(state: ReturnFlyState, now: number): { action: "fly" | "wait" | "push"; next: ReturnFlyState; landed: boolean } {
  if (state === -1) return { action: "fly", next: now + RETURN_FLY_MS, landed: false };
  if (state > 0) {
    if (now < state) return { action: "wait", next: state, landed: false };
    return { action: "push", next: 0, landed: true };   // the fly just ended: this push lands the frame
  }
  return { action: "push", next: 0, landed: false };
}
