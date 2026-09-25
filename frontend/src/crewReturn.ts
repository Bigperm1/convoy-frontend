// crewReturn.ts — the crew overview's way home on the phone (Jeff, 2026-09-25: "Since the compass has moved make sure you
// put a 7sec timer on the crew press to zoom back to user location"). The Crew FAB frames self + every live peer north-up
// and drops follow like a finger pan (🔒 map-crew-fit-drops-follow); the pan rule would only bring the chase back after
// PAN_RECENTER_MS (20 s). This is the crew press's own, shorter clock — map.tsx arms it right after the locked block and
// recenterNow() brings the camera back to the car. Pure module: the value is gate-checked by hazard_panel_test.
export const CREW_RETURN_MS = 7000;
