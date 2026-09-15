// cam_glide_test — the follow camera's zoom/pitch glide must keep going while the car's pose ease is parked,
// and must STOP once there is nothing left to glide.
// Run: node --experimental-strip-types tools/sim-qc/cam_glide_test.mts
//
// Jeff, 2026-09-15: "the starting sequence … was not really good. especially around the round abouts" →
// "IT STUDDERED AND WAS OFF THE ROUTE LINE A BIT". Receipt (instance 1mdvgz-926948, CarPlay): guidance
// started 09:00:35 (tilt target 0 → 48); 09:00:48.124 cam-probe p=37.0 pt=48.0; 09:00:48.139 main-gap
// dt=2072 easeIdle=2072. pushCam ran only from the pose ease loop, so a parked ease froze the glide.
// Fix: SelfCarModel keeps pushing the camera at the same drawn pose while !glideSettled (src/camGlide.ts).
//
// ⚠ This gate proves the ARITHMETIC and the stop condition. It does NOT reproduce the field's 37° (that
// needs the exact park pattern, which is not logged) and it is NOT a field verification — the next drive's
// cam-probe rows are: p should reach 48 within ~10 s of guidance start even when crawling.
// EXITS NON-ZERO ON FAILURE.
import { glideStep, glideSettled, GLIDE_SETTLE_ZOOM, type GlideParams, type GlideState } from "../../src/camGlide.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
// The constants as they are in src/ConvoyMapbox.tsx (CAM_ZOOM_SLEW_PER_S, CAM_ZOOM_DEADBAND, CAM_PITCH_SLEW_PER_S,
// CAM_SMOOTH_TAU_MS). If those change, change these.
const P: GlideParams = { zoomSlewPerS: 0.5, zoomDeadband: 0.25, pitchSlewPerS: 5, tauMs: 1400 };

// The PRE-SPLIT inline pushCam arithmetic, frozen here verbatim (commit 8b66331a, src/ConvoyMapbox.tsx pushCam).
function oldInline(g: GlideState, tz: number, tp: number, dt: number): GlideState {
  const zg = g.zoomGoal;
  const zGap = tz - zg;
  const zStep = (0.5 * dt) / 1000;
  const zoomGoal = Math.abs(zGap) < 0.25 ? zg : zg + Math.max(-zStep, Math.min(zStep, zGap));
  const pg = g.pitchGoal;
  const pGap = tp - pg;
  const pStep = (5 * dt) / 1000;
  const pitchGoal = pg + Math.max(-pStep, Math.min(pStep, pGap));
  const a = 1 - Math.exp(-dt / 1400);
  let zoom = g.zoom; let pitch = g.pitch;
  zoom += (zoomGoal - zoom) * a;
  pitch += (pitchGoal - pitch) * a;
  return { zoom, pitch, zoomGoal, pitchGoal };
}

console.log("A · glideStep is the old pushCam arithmetic, verbatim");
{
  let worst = 0; let n = 0;
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 20000; i++) {
    const g: GlideState = { zoom: 12 + rnd() * 7, pitch: rnd() * 60, zoomGoal: 12 + rnd() * 7, pitchGoal: rnd() * 60 };
    const tz = 12 + rnd() * 7, tp = rnd() * 60, dt = rnd() * 200;
    const a = glideStep(g, tz, tp, dt, P), b = oldInline(g, tz, tp, dt);
    worst = Math.max(worst, Math.abs(a.zoom - b.zoom), Math.abs(a.pitch - b.pitch), Math.abs(a.zoomGoal - b.zoomGoal), Math.abs(a.pitchGoal - b.pitchGoal));
    n++;
  }
  ok("A1 20,000 random states: identical to the pre-split inline math", worst === 0, `worst diff ${worst} over ${n}`);
}

// Simulate the camera over time at 60 Hz. `parked(t)` = the pose ease is parked at time t (seconds).
// old: no pushes while parked; the first push after a park is clamped to dt 200 ms (pushCam's clamp).
// new: pushes continue while parked until glideSettled.
function run(T: number, tz: number, tp: number, start: GlideState, parked: (t: number) => boolean, pumpWhenParked: boolean) {
  let g = { ...start }; let lastPush = 0; let pushes = 0; let settledAt = -1; let pushesAfterSettle = 0;
  for (let i = 1; i <= Math.round(T * 60); i++) {
    const t = i / 60;
    const isParked = parked(t);
    const settled = glideSettled(g, tz, tp, P);
    if (settled && settledAt < 0) settledAt = t;
    const push = !isParked || (pumpWhenParked && !settled);
    if (!push) continue;
    const dt = Math.max(0, Math.min(200, (t - lastPush) * 1000));
    lastPush = t;
    g = glideStep(g, tz, tp, dt, P);
    pushes++;
    if (isParked && settledAt >= 0) pushesAfterSettle++;
  }
  return { g, pushes, settledAt, pushesAfterSettle };
}

console.log("B · guidance start: tilt 0 → 48, zoom 16.83 → 18.50, pose ease parked 11.07-13.14 s (the 09-15 main-gap)");
{
  const start: GlideState = { zoom: 16.83, pitch: 0, zoomGoal: 16.75, pitchGoal: 0 };
  const park = (t: number) => t >= 11.07 && t < 13.14;
  const OLD = run(13.1, 18.5, 48, start, park, false);
  const NEW = run(13.1, 18.5, 48, start, park, true);
  const FREE = run(13.1, 18.5, 48, start, () => false, false);
  ok("B1 with the pump the parked camera tracks an uninterrupted glide (pitch within 0.1°)", Math.abs(NEW.g.pitch - FREE.g.pitch) < 0.1,
     `new p=${NEW.g.pitch.toFixed(1)} uninterrupted p=${FREE.g.pitch.toFixed(1)}`);
  ok("B2 without it the glide lost the park (pitch behind at 13.1 s)", OLD.g.pitch < NEW.g.pitch - 1,
     `old p=${OLD.g.pitch.toFixed(1)} new p=${NEW.g.pitch.toFixed(1)}`);
  // Zoom: a car that stops 1 s after a 1.5-level target change (e.g. a corner zoom arriving) — parked 1-4 s.
  const zs: GlideState = { zoom: 17.0, pitch: 48, zoomGoal: 17.0, pitchGoal: 48 };
  const parkZ = (t: number) => t >= 1 && t < 4;
  const ZO = run(4, 18.5, 48, zs, parkZ, false), ZN = run(4, 18.5, 48, zs, parkZ, true);
  ok("B3 zoom: the parked glide keeps closing on a new zoom target", ZN.g.zoom > ZO.g.zoom + 0.3, `old z=${ZO.g.zoom.toFixed(2)} new z=${ZN.g.zoom.toFixed(2)}`);
}

console.log("C · the pump stops (heat bound)");
{
  // A car stopped for 60 s right after guidance started: the pump may run only until the glide settles.
  const start: GlideState = { zoom: 16.83, pitch: 0, zoomGoal: 16.75, pitchGoal: 0 };
  const R = run(60, 18.5, 48, start, () => true, true);
  ok("C1 settles within 15 s from the worst start (48° tilt + 1.7 zoom levels)", R.settledAt > 0 && R.settledAt <= 15, `settled at ${R.settledAt.toFixed(2)} s`);
  ok("C2 no pushes after it settles while parked", R.pushesAfterSettle === 0, `${R.pushesAfterSettle} pushes`);
  ok("C3 ...and the end state is on target", Math.abs(R.g.pitch - 48) <= 0.2 && Math.abs(R.g.zoomGoal - R.g.zoom) <= GLIDE_SETTLE_ZOOM, `p=${R.g.pitch.toFixed(2)} z=${R.g.zoom.toFixed(3)} zg=${R.g.zoomGoal.toFixed(3)}`);
  // A target twitch inside the zoom dead-band must not start an endless pump.
  const tw: GlideState = { zoom: 17.0, pitch: 48, zoomGoal: 17.0, pitchGoal: 48 };
  ok("C4 a 0.2-level target twitch (inside the dead-band) is already settled", glideSettled(tw, 17.2, 48, P));
  ok("C5 a 0.3-level change is not", !glideSettled(tw, 17.3, 48, P));
  ok("C6 an unclosed nose lead-in is not settled", !glideSettled(tw, 17.0, 48, P, 3) && glideSettled(tw, 17.0, 48, P, 0.3));
}

console.log(fails === 0 ? "\nPASS cam_glide" : `\nFAIL cam_glide (${fails})`);
if (fails) process.exit(1);
