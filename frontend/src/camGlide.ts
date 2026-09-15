// camGlide — the follow camera's zoom/pitch GLIDE, and when it is finished (2026-09-15).
//
// Split out of SelfCarModel.pushCam (src/ConvoyMapbox.tsx) for the same reason as chaseZoom.ts: a
// rule that decides behaviour must live where tools/sim-qc can import it. Import nothing from
// 'react-native' here. glideStep is the pushCam arithmetic MOVED VERBATIM (goal slews toward the
// target at a bounded rate with a zoom dead-band, the applied value low-passes toward the goal);
// the constants stay in ConvoyMapbox.tsx and are passed in.
//
// WHY glideSettled EXISTS. Jeff, 2026-09-15: "the starting sequence … was not really good.
// especially around the round abouts … IT STUDDERED". pushCam only runs from the pose ease loop
// (step), from bgTick while an ease is in flight, or from a snap. So whenever the car's pose ease
// PARKS — the car is crawling or stopped and no new pose arrived — the camera's zoom/pitch glide
// froze mid-flight and resumed with the next pose: a hitch, then a jump. Field receipt, instance
// 1mdvgz-926948: guidance started 09:00:35 (tilt target 0 → 48); 09:00:48.124 cam-probe p=37.0
// pt=48.0 — 13.1 s in, where an uninterrupted glide is at ~47.4 — and 09:00:48.139 main-gap
// dt=2072 easeIdle=2072 (the ease parked for 2 s at 7 km/h, 50 m before roundabout 1).
// THE FIX: while the pose ease is parked, SelfCarModel keeps the frame loop alive and pushes the
// camera at the car's CURRENT drawn pose until glideSettled() says there is nothing left to glide.
// The car does not move (same pose), so camera and marker stay locked together; only zoom, pitch and
// the nose lead-in finish. Bounded: from a 1-level gap the low-pass settles to GLIDE_SETTLE_ZOOM in
// ~5 s, then the loop parks exactly as before.
// Gate: tools/sim-qc/cam_glide_test.mts.

export type GlideParams = {
  zoomSlewPerS: number;   // CAM_ZOOM_SLEW_PER_S
  zoomDeadband: number;   // CAM_ZOOM_DEADBAND
  pitchSlewPerS: number;  // CAM_PITCH_SLEW_PER_S
  tauMs: number;          // CAM_SMOOTH_TAU_MS
};

export type GlideState = { zoom: number; pitch: number; zoomGoal: number; pitchGoal: number };

/** One pushCam glide step (verbatim arithmetic). dtMs is the caller's clamped frame interval. */
export function glideStep(g: GlideState, targetZoom: number, targetPitch: number, dtMs: number, p: GlideParams): GlideState {
  const zGap = targetZoom - g.zoomGoal;
  const zStep = (p.zoomSlewPerS * dtMs) / 1000;
  const zoomGoal = Math.abs(zGap) < p.zoomDeadband ? g.zoomGoal : g.zoomGoal + Math.max(-zStep, Math.min(zStep, zGap));
  const pGap = targetPitch - g.pitchGoal;
  const pStep = (p.pitchSlewPerS * dtMs) / 1000;
  const pitchGoal = g.pitchGoal + Math.max(-pStep, Math.min(pStep, pGap));
  const a = 1 - Math.exp(-dtMs / p.tauMs);
  return { zoomGoal, pitchGoal, zoom: g.zoom + (zoomGoal - g.zoom) * a, pitch: g.pitch + (pitchGoal - g.pitch) * a };
}

/** Below these the remaining glide is invisible (~1.4 % scale, a fifth of a degree). */
export const GLIDE_SETTLE_ZOOM = 0.02;
export const GLIDE_SETTLE_PITCH = 0.2;
export const GLIDE_SETTLE_HDG = 0.5;

/**
 * True when another glide step would change nothing visible: the zoom goal is held by the dead-band,
 * the pitch goal has reached its target, the applied values have caught their goals, and the nose
 * lead-in (degrees between the camera heading and the car heading; pass 0 when off) has closed.
 */
export function glideSettled(g: GlideState, targetZoom: number, targetPitch: number, p: GlideParams, hdgLagDeg = 0): boolean {
  const zoomGoalHeld = Math.abs(targetZoom - g.zoomGoal) < p.zoomDeadband;
  const pitchGoalHeld = Math.abs(targetPitch - g.pitchGoal) <= GLIDE_SETTLE_PITCH;
  return zoomGoalHeld && pitchGoalHeld
    && Math.abs(g.zoomGoal - g.zoom) <= GLIDE_SETTLE_ZOOM
    && Math.abs(g.pitchGoal - g.pitch) <= GLIDE_SETTLE_PITCH
    && Math.abs(hdgLagDeg) <= GLIDE_SETTLE_HDG;
}
