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
/** HEAD UNIT ONLY: how long after a fly's JS deadline it still owns the camera. The native flyTo starts when the bridge
 *  delivers the call and on the next display frame, so it ends a little AFTER the JS deadline; on iOS a 'none' write in
 *  that gap is overwritten by the fly's last frames (MapboxMap.setCamera does not cancel animations) and, parked, never
 *  re-applied (review of 1f2faada). Inside the grace a write re-aims the fly instead and the landing waits; after it the
 *  landing push is a no-op on screen. 100 ms = 6 frames. HYPOTHESIS: the dispatch-to-first-frame latency is under that —
 *  not measured on a head unit. The phone passes no grace (unchanged). */
export const RETURN_FLY_GRACE_MS = 100;

/** The camera's return-fly state: -1 = armed (fly on the next push, RETURN_FLY_MS), < -1 = armed as a RE-AIM lasting
 *  −state ms (returnFlyReaim), 0 = idle, > 0 = flying until this epoch ms. */
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

/** What pushCam should do this tick given the fly state: run the fly (for `ms`), wait for it, or push normally.
 *  graceMs (head unit): keep waiting that long past the deadline so the native fly has really ended. */
export function returnFlyStep(state: ReturnFlyState, now: number, graceMs = 0): { action: "fly" | "wait" | "push"; next: ReturnFlyState; landed: boolean; ms: number } {
  if (state < 0) {
    const ms = state === -1 ? RETURN_FLY_MS : -state;
    return { action: "fly", next: now + ms, landed: false, ms };
  }
  if (state > 0) {
    if (now < state + graceMs) return { action: "wait", next: state, landed: false, ms: 0 };
    return { action: "push", next: 0, landed: true, ms: 0 };   // the fly just ended: this push lands the frame
  }
  return { action: "push", next: 0, landed: false, ms: 0 };
}

/** A fly armed or in flight: the per-tick pushes stand down and the native flyTo owns the camera. */
export function returnFlyInFlight(state: ReturnFlyState, now: number, graceMs = 0): boolean {
  return state < 0 || (state > 0 && now < state + graceMs);
}

/**
 * RE-AIM a fly in flight (2026-09-25): the driver pressed +/- while the head unit was flying home from the Crew
 * overview. The press must answer at once and must not cut — the old path started a zoom ease the fly's pushes never
 * applied, then cut up to 4 levels at touchdown (review, 25ad00e1). A setCamera 'none' cannot stop an iOS fly
 * (MapboxMap.setCamera "does not cancel existing animations"; a new camera.fly(to:) does), and cancelling it would cut
 * the centre, pitch and heading anyway. So the next push flies AGAIN, from wherever the camera is now, to the chase
 * frame at the new framing, over the fly's remaining time (at least minMs). Armed or idle states are returned unchanged
 * (an armed fly reads the new framing when it starts). Never returns -1 (that means the full RETURN_FLY_MS).
 */
export function returnFlyReaim(state: ReturnFlyState, now: number, minMs: number, graceMs = 0): ReturnFlyState {
  if (state > 0 && now < state + graceMs) return -Math.max(2, minMs, state - now);
  return state;
}
