// chase_pitch_test — the follow camera's TILT must not move with speed.
//
// Jeff, 2026-09-11: "my goal here is to be as close to as the mapbox other maps view and
// smoothness ... seems like everybody is at a fixed pitch and cieling of around 16" then
// "i agree with the pitch change. go".
//
// THE DEFECT THIS GATE EXISTS FOR, measured on instance ogb3m4-967731 (his drive home,
// 17:27:50-17:59:12 PDT, 88 cam-probe rows on the CarPlay surface): the tilt travelled
// 168 DEGREES with 20 direction reversals in 31.4 minutes, swinging 48-60 with every gap
// in traffic. CAM_PITCH_SLEW_PER_S and the low-pass were already in place; they smooth the
// PATH, not the TARGET, and the target was instantaneous speed.
//
// PRIOR ART (fetched + citation-checked the same day): Mapbox Navigation SDK
// `defaultPitch = 45.0`, Google Navigation SDK 45, MapLibre Navigation iOS 45 — every
// readable implementation uses a FIXED following pitch, and the two that vary it (MapLibre
// Android, Mapbox near a maneuver) LOWER it toward top-down as a turn approaches. Nothing
// in the corpus raises tilt with speed.
//
// ⚠ This gate asserts INVARIANCE, not the value. The value is one OTA dial; if Jeff wants
// 45 or 52 the constant moves and this file keeps passing. What must never come back is a
// speed term. Companion: scripts/trap-check.py rule 31 guards the call site's source text.
import { chasePitch, CHASE_PITCH_FIXED } from "../../src/chasePitch.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── A · speed invariance ──────────────────────────────────────────────────────
{
  // The real speed range of the drive that produced the defect, plus the extremes the
  // zoom table covers (0 parked, 180 the widest stop) and the values either side of the
  // two thresholds the old ramp keyed on (CHASE_KMH_CITY 45, CHASE_KMH_HIGHWAY 95).
  const speeds = [0, 5, 8, 15, 20, 24, 32, 39, 44, 45, 46, 50, 62, 68, 73, 83,
                  91, 94, 95, 96, 99, 104, 107, 111, 118, 128, 140, 160, 180, 240];
  const vals = speeds.map((v) => chasePitch(v));
  const first = vals[0];
  ok("A1 every speed returns the same tilt", vals.every((v) => v === first),
     `distinct=${[...new Set(vals)].join(",")}`);
  ok("A2 it is the exported constant", first === CHASE_PITCH_FIXED, `got ${first}`);
  ok("A3 total travel across the whole speed sweep is 0 deg",
     vals.reduce((t, v, i) => (i ? t + Math.abs(v - vals[i - 1]) : 0), 0) === 0);
}

// ── B · the old ramp's thresholds are dead ────────────────────────────────────
{
  // The ramp used to break at 45 and 95 km/h. Crossing either must now be a no-op —
  // this is the assertion that fails first if someone re-adds the lerp.
  ok("B1 crossing the old city threshold changes nothing", chasePitch(44) === chasePitch(46));
  ok("B2 crossing the old highway threshold changes nothing", chasePitch(94) === chasePitch(96));
  ok("B3 city speed equals highway speed", chasePitch(20) === chasePitch(128));
}

// ── C · the value is sane for a pitched 3D map ────────────────────────────────
{
  // Not a taste assertion — these are hard bounds. Mapbox rejects pitch > 60 outright, 0
  // is the flat/2D view which the nav path must never return (flatView handles that at the
  // call site), and the corpus sits at 45.
  ok("C1 within Mapbox's legal pitch range", CHASE_PITCH_FIXED > 0 && CHASE_PITCH_FIXED <= 60,
     String(CHASE_PITCH_FIXED));
  ok("C2 within 10 deg of the corpus (Mapbox/Google/MapLibre iOS all 45)",
     Math.abs(CHASE_PITCH_FIXED - 45) <= 10, `${CHASE_PITCH_FIXED} vs 45`);
  ok("C3 no argument is required", chasePitch() === CHASE_PITCH_FIXED);
}

// ── D · the field trace replayed ──────────────────────────────────────────────
{
  // The 88 speeds from ogb3m4-967731's cam-probe rows, in order. Under the old ramp this
  // produced 168 deg of travel and 20 reversals; it must now produce zero of both.
  const drive = [10, 39, 50, 49, 33, 20, 48, 24, 5, 30, 16, 16, 20, 128, 96, 92, 99, 113,
    68, 29, 41, 48, 65, 32, 24, 46, 62, 78, 66, 24, 39, 73, 75, 75, 74, 83, 95, 94, 105,
    118, 91, 69, 11, 50, 64, 62, 32, 54, 66, 45, 12, 48, 8, 41, 50, 52, 12, 44, 53, 69,
    91, 93, 96, 101, 87, 69, 79, 79, 107, 111, 95, 87, 8, 44, 66, 63, 58, 67, 83, 48, 39,
    15, 42, 62, 68, 73, 71, 77];
  const p = drive.map((v) => chasePitch(v));
  let travel = 0, reversals = 0;
  for (let i = 1; i < p.length; i++) travel += Math.abs(p[i] - p[i - 1]);
  for (let i = 2; i < p.length; i++) {
    const a = p[i - 1] - p[i - 2], b = p[i] - p[i - 1];
    if (a * b < 0) reversals += 1;
  }
  ok(`D1 the 09-11 drive replays with 0 deg of tilt travel (was 168)`, travel === 0, `got ${travel}`);
  ok(`D2 and 0 direction reversals (was 20)`, reversals === 0, `got ${reversals}`);
  ok("D3 the trace is the real one, 88 samples", drive.length === 88, String(drive.length));
}

console.log(fails === 0 ? "\nPASS chase_pitch" : `\nFAIL chase_pitch (${fails})`);
if (fails) process.exit(1);
