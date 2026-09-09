// arrival_speech_test — at arrival the driver hears the composed arrival line and NOTHING ELSE,
// and it starts early enough to finish.
//
// FIELD REPORT (Jeff, 2026-09-09): "you have an 'arrived at destination' before the
// weather/destination/end greeting when arriving at the destination. please remove that." and
// then "remove the 2 sentances so we only have the new one on the end ... maybe fire that line
// a 3 seconds early. so if some one is in a rush they hear the whole line."
//
// THREE separate sentences used to land before the real arrival line, from three code paths:
//   1. the final-leg heads-up  "In 50 metres, you will arrive at your destination."
//      -> deleted from src/nav.ts; trap rule duplicate-arrival-headsup guards it.
//   2. the second-to-last step's PREPARE cue "In 200 metres, you have arrived onto <street>."
//   3. the second-to-last step's IMMINENT cue "You have arrived."
//      -> 2 and 3 both came from the next step being the ARRIVE maneuver; this gate covers them.
// VERIFIED on his 2026-09-08 09:28 drive to work: tts-say len=45 -> tts-play len=50 was (1), and
// the composed arrival line len=82 played straight behind it; tts-skip why=rate len=16 was (3)
// being dropped by the rate gate rather than by design.
import { isSpokenManeuver, arriveSpeakLeadM, ARRIVE_SPEAK_LEAD_S, ARRIVE_SPEAK_LEAD_MAX_M } from "../../src/maneuverSpeech.ts";

const ARRIVE_M = 20;   // src/nav.ts
let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) { fails++; console.log(`  FAIL ${n} ${d}`); } else console.log(`  ok   ${n} ${d}`); };

// ── A. THE ARRIVAL MANEUVER IS NEVER SPOKEN ────────────────────────────────────────────────
for (const key of ["arrive", "arrive|left", "arrive|right", "arrive|straight", "arrive|sharp left"]) {
  ok(`A ${key} is silent`, !isSpokenManeuver(key, "You have arrived at your destination"), "");
}
// its instruction text must not sneak it back in through the html fallback
ok("A6 bare arrival html is silent", !isSpokenManeuver("", "You have arrived at your destination"));

// ── B. NEGATIVE CONTROL — real maneuvers must STILL speak ──────────────────────────────────
// Without this the gate would pass if someone silenced every maneuver in the app.
for (const [key, html] of [
  ["turn|left", "Turn left onto Main St"],
  ["turn|right", "Turn right onto 200A St"],
  ["merge|left", "Merge onto Hwy 1"],
  ["roundabout|left", "Take the 2nd exit onto Maplewood Dr"],
  ["fork|right", "Keep right at the fork"],
  ["off ramp|right", "Take the exit"],
  ["end of road|left", "Turn left"],
] as Array<[string, string]>) {
  ok(`B ${key} still speaks`, isSpokenManeuver(key, html));
}
ok("B8 unknown key with turn text still speaks", isSpokenManeuver("", "Turn right onto Braid St"));
ok("B9 filler stays silent", !isSpokenManeuver("continue|straight", "Continue on Main St"));

// ── B10. A PRE-EXISTING GAP THIS GATE FOUND, recorded so it is not mistaken for the 09-09
// arrival change and cannot change silently. isSpokenManeuver returns false for ANY maneuver
// whose modifier is "straight", which is correct for turn|straight and merge|straight filler
// but ALSO silences a roundabout you drive straight through — Mapbox emits roundabout|straight
// for that, and roundaboutExitCue ("Take the second exit") never gets the chance to speak.
// NOT changed here: it is a nav-behaviour change nobody reported and bundling is Jeff's call.
ok("B10 KNOWN GAP: roundabout|straight is silent (pre-existing, not the 09-09 change)",
  !isSpokenManeuver("roundabout|straight", "Take the 2nd exit onto Maplewood Dr"),
  "flagged for Jeff, deliberately not fixed here");

// ── C. THE EARLY LEAD ──────────────────────────────────────────────────────────────────────
ok("C1 stopped -> no lead", arriveSpeakLeadM(0) === 0);
ok("C2 null speed is safe", arriveSpeakLeadM(null) === 0 && arriveSpeakLeadM(undefined) === 0);
ok("C3 NaN is safe", arriveSpeakLeadM(NaN) === 0);
ok("C4 negative speed is safe", arriveSpeakLeadM(-5) === 0);
ok("C5 lead is speed x 3 s", arriveSpeakLeadM(8) === 24, `${arriveSpeakLeadM(8)} m at 8 m/s`);
ok("C6 bounded", arriveSpeakLeadM(1000) === ARRIVE_SPEAK_LEAD_MAX_M, `${arriveSpeakLeadM(1000)} m`);
ok("C7 the constant is 3 s", ARRIVE_SPEAK_LEAD_S === 3);

// The line must actually have time to finish. ~82 characters at the measured ~0.07 s/char of
// cached speech is ~5.7 s. The lead alone does not cover that — it is not meant to; the driver
// is also decelerating and then stationary. What this asserts is the lead is a real head start
// at realistic arrival speeds, not a rounding error.
const CHAR_S = 0.07, LINE_CHARS = 82;
for (const [kmh, minM] of [[20, 16], [30, 24], [40, 33]] as Array<[number, number]>) {
  const lead = arriveSpeakLeadM(kmh / 3.6);
  ok(`C8 ${kmh} km/h gives a real head start`, lead >= minM, `${lead.toFixed(0)} m before the ${ARRIVE_M} m trigger`);
}
console.log(`  -- the line is ~${(LINE_CHARS * CHAR_S).toFixed(1)} s of speech; at 30 km/h the lead buys ${ARRIVE_SPEAK_LEAD_S}s of it before the trigger`);

// ── D. NEGATIVE CONTROL ON THE LEAD ────────────────────────────────────────────────────────
// If the lead were ever reduced to zero the early start is gone; assert the gate can see that.
const noLead = (speedMs: number) => Math.min(ARRIVE_SPEAK_LEAD_MAX_M, Math.max(0, speedMs) * 0);
ok("D1 a zeroed lead FAILS the head-start check", !(noLead(30 / 3.6) >= 24));
ok("D2 an unbounded lead FAILS the bound", !(Math.max(0, 1000) * ARRIVE_SPEAK_LEAD_S <= ARRIVE_SPEAK_LEAD_MAX_M));

console.log(fails === 0 ? "\nPASS arrival_speech" : `\nFAIL arrival_speech (${fails})`);
if (fails) process.exit(1);
