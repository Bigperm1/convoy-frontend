// crewReturn.ts — the crew overview's way home on EVERY surface (Jeff, 2026-09-25: "Since the compass has moved make sure you
// put a 7sec timer on the crew press to zoom back to user location"). The Crew FAB frames self + every live peer north-up
// and drops follow like a finger pan (🔒 map-crew-fit-drops-follow); the pan rule would only bring the chase back after
// PAN_RECENTER_MS (20 s). This is the crew press's own, shorter clock — map.tsx arms it right after the locked block and
// recenterNow() brings the camera back to the car. The HEAD UNITS use the same value as their crewFit hold deadline
// (CarMapView 🔒 car-gesture-crewfit; Jeff, 2026-09-25: "on carplay the crew button does not have the zoom in timer on it to
// zoom back in") — the 1.8 s fly home (returnFly.ts) lands when it lapses; a stopped car comes home on its next GPS fix.
// Pure module: the value is gate-checked by hazard_panel_test G11/G12.
export const CREW_RETURN_MS = 7000;
