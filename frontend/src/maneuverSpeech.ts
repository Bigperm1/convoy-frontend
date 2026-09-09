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
  if (modifier === "straight") return false;
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
