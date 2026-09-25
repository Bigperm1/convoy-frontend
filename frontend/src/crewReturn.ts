// crewReturn.ts — the crew overview's way home on EVERY surface (Jeff, 2026-09-25: "Since the compass has moved make sure you
// put a 7sec timer on the crew press to zoom back to user location"). The Crew FAB frames self + every live peer north-up
// and drops follow like a finger pan (🔒 map-crew-fit-drops-follow); the pan rule would only bring the chase back after
// PAN_RECENTER_MS (20 s). This is the crew press's own, shorter clock — map.tsx arms it right after the locked block and
// recenterNow() brings the camera back to the car. The HEAD UNITS use the same value as their crewFit hold deadline
// (CarMapView 🔒 car-gesture-crewfit; Jeff, 2026-09-25: "on carplay the crew button does not have the zoom in timer on it to
// zoom back in") — the 1.8 s fly home (returnFly.ts) lands when it lapses, MOVING OR STOPPED (2026-09-25: a stopped car
// used to wait for its next GPS fix — 09-20, +23.75 s; see crewReturnDue below).
// Pure module: the value is gate-checked by hazard_panel_test G11/G12; the edge by tools/sim-qc/car_zoom_step_test.mts.
import { isOverviewZoom } from "./overviewSize.ts";

export const CREW_RETURN_MS = 7000;
/** The head unit's crewFit easeTo into the overview (CarMapView 🔒 car-gesture-crewfit; was the literal 600). While it
 *  runs, a lockstep 'none' push cannot take the camera back on iOS — MapboxMap.setCamera(to:) "does not cancel existing
 *  animations" — so a return inside this window goes by a short fly, which does (CarMapView getCam, 2026-09-25). */
export const CREW_FIT_EASE_MS = 600;

/**
 * The head unit's crew-hold EXPIRY EDGE, evaluated on every camera push (CarMapView getCam → SelfCarModel.pushCam).
 * Moved verbatim out of 🔒 car-getcam (2026-09-25) so the sim gate replays the real rule. On the push where the hold
 * (camHoldUntilRef) is over but was on at the previous push: snap the chase zoom, and — the first time after a crew
 * overview, if the map is still zoomed out (below CHASE_ZOOM) — fly home (returnFly.ts). `wasActive` false after it,
 * and `overview` false, so the edge can fire only ONCE per Crew press whatever path pushes next: no second fly when
 * the car pulls away right after a parked return.
 */
export function crewReturnEdge(wasActive: boolean, overview: boolean, holdUntil: number, now: number, liveZoom: number | null | undefined):
  { wasActive: boolean; overview: boolean; snap: boolean; fly: boolean } {
  const holdActive = now < holdUntil;
  let snap = false, fly = false, ov = overview;
  if (wasActive && !holdActive) {
    snap = true;
    if (ov) {
      ov = false;
      if (typeof liveZoom === "number" && isOverviewZoom(liveZoom)) fly = true;
    }
  }
  return { wasActive: holdActive, overview: ov, snap, fly };
}

/**
 * A lapsed (or ended — zoom / recenter / compass zero the deadline) crew hold whose edge has not run yet: the camera
 * owes the way home. The parked pump's trigger (CarMapView carCamJob): a stopped car has no pose ease, so without it
 * nothing pushed the camera and the overview held until the car moved (09-20: tap 14:46:48.524 → first camera push
 * 14:47:12.274, +23.75 s). A deadline compared on every tick, never a lone setTimeout.
 */
export function crewReturnDue(wasActive: boolean, holdUntil: number, now: number): boolean {
  return wasActive && now >= holdUntil;
}
