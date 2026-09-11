// maneuverSpeech — WHICH maneuvers Nova says out loud, and how early the arrival line starts.
// Dependency-free on purpose (no React, no RN, no imports) so tools/sim-qc/arrival_speech_test.mts
// drives this exact code under plain Node. src/nav.ts imports it.

// "Less intrusive Nova" filter. Maneuvers that just mean "keep going" aren't
// worth a spoken callout — speaking them ("continue straight for 2 km") is the
// nagging the driver complained about. We skip ONLY these, so real turns,
// merges, ramps, forks, roundabouts and U-turns still speak.
export const SILENT_MANEUVERS = new Set([
  "straight", "continue", "name_change", "name-change", "depart",
  // "arrive" (Jeff, 2026-09-09: "remove the 2 sentances so we only have the new one on the end
  // with the weather/destination/end greeting"). On the SECOND-TO-LAST step the next step is the
  // arrival maneuver, so the ordinary cue path spoke it twice more before the real arrival line:
  //   prepare   -> "In 200 metres, you have arrived onto <street>."   (also broken grammar)
  //   imminent  -> "You have arrived."
  // Both came from maneuverVerb's "arrive|*" entries. That is the second-to-last corner Jeff
  // heard them on. The composed arrival line is now the ONLY thing spoken at arrival; the
  // "arrive|*" verbs stay in the table because the on-screen banner still uses them.
  "arrive",
]);
// Decide whether a maneuver is worth speaking. A known non-actionable maneuver
// is silenced. For an empty/unknown maneuver we fall back to the instruction
// text and speak ONLY if it clearly describes a real maneuver — so we never
// drop a genuine turn that arrived without a maneuver code, but still stay quiet
// on "Continue on Main St" filler.
export function isSpokenManeuver(maneuver?: string, html?: string): boolean {
  const m = (maneuver || "").toLowerCase();
  // maneuver may be a joined Mapbox key ("type|modifier", e.g. "continue|straight",
  // "depart|left", "turn|straight") or a bare legacy token ("straight"). Split so
  // the SILENT set matches on the TYPE half regardless of modifier.
  const type = m.split("|")[0];
  const modifier = m.split("|")[1] || "";
  // A "straight" modifier means no real turn (e.g. "turn|straight", "merge|straight"
  // continuing ahead) — treat as non-actionable filler, same as continue/straight.
  // ⚠ A ROUNDABOUT IS ALWAYS ACTIONABLE, WHATEVER THE MODIFIER (2026-09-09). Mapbox emits
  // roundabout|straight for one you drive straight THROUGH, and the blanket straight-modifier
  // rule below silenced it — so roundaboutExitCue ("Take the second exit") never got to speak
  // on exactly the roundabouts that need it most. Found by tools/sim-qc/arrival_speech_test.mts
  // while gating the arrival change; pre-existing since 5ce2fb7, not part of that change.
  if (modifier === "straight" && type !== "roundabout" && type !== "rotary") return false;
  if (type && SILENT_MANEUVERS.has(type)) return false;
  if (m && !SILENT_MANEUVERS.has(m)) return true;
  const h = (html || "").toLowerCase();
  return /\b(turn|merge|exit|ramp|fork|u-?turn|roundabout|keep (?:left|right))\b/.test(h);
}

// ── HOW EARLY THE ARRIVAL LINE STARTS (Jeff, 2026-09-09) ────────────────────────────────
// "maybe fire that line a 3 seconds early. so if some one is in a rush they hear the whole
// line." The arrival line is three sentences (~82 chars on his 2026-09-08 drive, ~6 s from
// cache), so a driver who stops on the trigger and opens the door hears a fraction of it.
// Returns the EXTRA metres before the normal arrival trigger at which the speech should start.
// Bounded so an unusual approach speed cannot start it a block out; 60 m is 3 s at 72 km/h,
// well above any real arrival speed. The distance this is compared against is `remaining`
// ALONG THE ROUTE, never crow-fly, so 60 m out already means the final approach.
export const ARRIVE_SPEAK_LEAD_S = 3;
export const ARRIVE_SPEAK_LEAD_MAX_M = 60;
export function arriveSpeakLeadM(speedMs: number | null | undefined): number {
  const v = typeof speedMs === "number" && Number.isFinite(speedMs) ? Math.max(0, speedMs) : 0;
  return Math.min(ARRIVE_SPEAK_LEAD_MAX_M, v * ARRIVE_SPEAK_LEAD_S);
}

// ── THE RATE GATE, AND THE ONE LINE THAT MUST OUTRANK IT (Jeff, 2026-09-11) ─────────────
// A 1.5 s gate stops callout spam. It is right for prepare cues and wrong for exactly one clip:
// the IMMINENT turn callout, the "Turn left." you hear as you reach the intersection.
//
// FIELD RECEIPT, his 2026-09-11 drive to the highway ("Scout cut off the turn left onto highway
// towards Vancouver"), crash_reports, UTC:
//   21:16:55.416  route-swap steps=3          (a reroute landed)
//   21:16:56.341  tts-say len=38 / tts-play len=43   (the NEW route's prepare cue starts, 6.7 s long)
//   21:16:57.385  tts-skip why=rate len=11    <- "Turn left." DROPPED, 1.04 s inside the gate
//   21:17:03.014  tts-done len=43
//   21:17:04.336  watch-tap step=1 kind=now d=33     (he was AT the turn)
// The reroute's own prepare cue ate its own first turn. This is the same family as the arrival
// line losing to a prepare cue on 2026-09-03 (tools/sim-qc/arrival_speech_test.mts header), and
// the same remedy: the clip a driver cannot afford to miss does not queue behind courtesy.
//
// PRIORITY DOES NOT INTERRUPT. It skips this gate only; the clip still queues behind whatever is
// playing and the same-text dedupe still applies. On the trace above that puts "Turn left." at
// ~21:17:03 — a second before the turn instead of never.
export const SPEAK_RATE_GATE_MS = 1500;
/** True when the rate gate would DROP this line. `priority` is the imminent turn callout and the
 *  arrival line; everything else (prepare cues, reroute chatter) is droppable by design. */
export function speakRateSkips(nowMs: number, lastSpokeAtMs: number, priority: boolean): boolean {
  if (priority) return false;
  return nowMs - lastSpokeAtMs < SPEAK_RATE_GATE_MS;
}

/** The arrival line is spoken at most once per DESTINATION — not per step, not per route.
 *  (Codex adversarial review, 2026-09-09, [high].) The first version cleared its flag alongside
 *  `announcedRef`, which is cleared on every STEP ADVANCE and on every route key change. Crossing
 *  the 25 m advancement threshold on the final approach therefore re-armed the early speech and the
 *  driver heard the whole arrival line twice — on an ordinary approach, with no reroute — and
 *  because the utterance had already been consumed the second one could even pick a different
 *  closer, so exact-text dedupe would not have caught it either. Keying on the destination keeps a
 *  same-destination reroute quiet while a genuinely new destination still speaks. */
export function arrivalAlreadySpokenFor(prev: { dest: string } | null | undefined, destId: string): boolean {
  return !!prev && !!destId && prev.dest === destId;
}
