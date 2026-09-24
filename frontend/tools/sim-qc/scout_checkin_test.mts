// scout_checkin_test — Scout's drive check-in (src/scoutCheckIn.ts): the moving-time clock and
// the line picker. Jeff, 2026-09-24: "build the 1.5hr drive reminder, add random things like wanna
// hear a joke or fatigue reminder or anything else". Pins: first check-in at 90 minutes of DRIVING
// (not clock time), repeat every 90, a 15-minute stop resets, a short stop does not, gaps never
// count, the picker never repeats a kind back to back, crew/destination lines only when they apply,
// every line short enough to be spoken, and the QA interval override.
import {
  CHECKIN_BANK, CHECKIN_DEFAULTS, checkInConsume, checkInStart, checkInTick, fmtEta, leadIn, pickCheckIn,
  type CheckInKind, type CheckInState,
} from "../../src/scoutCheckIn.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// Drive helper: feed one tick per second for `minutes` at `speed` m/s, starting at `t0`.
function drive(s: CheckInState, t0: number, minutes: number, speed: number, cfg = CHECKIN_DEFAULTS): { s: CheckInState; t: number; fired: number } {
  let fired = 0; let t = t0;
  for (let i = 0; i < minutes * 60; i++) {
    t += 1000;
    s = checkInTick(s, t, speed, cfg);
    if (s.due) { fired++; s = checkInConsume(s); }
  }
  return { s, t, fired };
}

// A — the clock
{
  let r = drive(checkInStart(), 0, 89, 20);
  ok("A1 89 min of driving: nothing yet", r.fired === 0 && !r.s.due);
  r = drive(r.s, r.t, 2, 20);
  ok("A2 first check-in lands at 90 min", r.fired === 1, `fired=${r.fired}`);
  r = drive(r.s, r.t, 88, 20);
  ok("A3 nothing between 91 and 179 min", r.fired === 0);
  r = drive(r.s, r.t, 3, 20);
  ok("A4 second check-in at 180 min", r.fired === 1);
  r = drive(r.s, r.t, 90, 20);
  ok("A5 third at 270 min", r.fired === 1);
}
{
  let r = drive(checkInStart(), 0, 60, 20);
  r = drive(r.s, r.t, 5, 0);                       // a 5-minute red-light/coffee-window stop
  ok("B1 a 5-min stop keeps the clock", Math.round(r.s.movingMs / 60000) === 60);
  r = drive(r.s, r.t, 31, 20);                     // (the very first tick of a leg only anchors, so 31)
  ok("B2 …and 30 more minutes fires (60 + 30)", r.fired === 1);
}
{
  let r = drive(checkInStart(), 0, 60, 20);
  r = drive(r.s, r.t, 15, 0);                      // a real break, measured from the last moving fix
  ok("B3 a 15-min stop resets the clock", r.s.movingMs === 0 && r.s.fired === 0, `movingMs=${r.s.movingMs}`);
  r = drive(r.s, r.t, 89, 20);
  ok("B4 …so the next check-in needs a fresh 90", r.fired === 0);
  r = drive(r.s, r.t, 2, 20);
  ok("B5 …and lands at 90 after the break", r.fired === 1);
}
{
  let r = drive(checkInStart(), 0, 60, 20);
  r = drive(r.s, r.t, 10, 1.0);                    // crawling below 1.5 m/s = stopped
  ok("B6 ten minutes crawling in a jam is not driving", Math.round(r.s.movingMs / 60000) === 60 && r.fired === 0);
  r = drive(r.s, r.t, 50, 1.0);
  ok("B7 …and an hour of crawling counts as a break", r.s.movingMs === 0, `movingMs=${r.s.movingMs}`);
}
{
  // A 10-minute gap in fixes (phone asleep) is unknown time — neither driving nor a break.
  let r = drive(checkInStart(), 0, 60, 20);
  let s = checkInTick(r.s, r.t + 10 * 60_000, 20);
  ok("C1 a 10-min fix gap does not count as driving", Math.round(s.movingMs / 60000) === 60);
  ok("C2 …and does not reset", s.fired === 0 && s.movingMs > 0);
  s = checkInTick(r.s, r.t + 20 * 60_000, 20);
  ok("C3 a 20-min gap is a break", s.movingMs === 0);
}
{
  const s0 = checkInTick(checkInStart(), 1000, 20);
  ok("D1 first tick only anchors", s0.movingMs === 0 && s0.lastAt === 1000);
  const s1 = checkInTick(s0, 500, 20);
  ok("D2 a backwards clock is ignored", s1.movingMs === 0);
  const s2 = checkInTick(s0, NaN, 20);
  ok("D3 NaN time is ignored", s2 === s0);
  const s3 = checkInTick(s0, 2000, NaN);
  ok("D4 NaN speed counts as stopped (from the last moving fix)", s3.movingMs === 0 && s3.stoppedSinceAt === 1000, `since=${s3.stoppedSinceAt}`);
}
{
  const qa = { ...CHECKIN_DEFAULTS, firstMin: 1, repeatMin: 1 };
  let r = drive(checkInStart(), 0, 2, 20, qa);     // fires at 1:00 (first tick anchors)
  ok("E1 QA override: fires at 1 min", r.fired === 1, `fired=${r.fired}`);
  r = drive(r.s, r.t, 2, 20, qa);                  // 2:00 and 3:00
  ok("E2 QA override: repeats every minute", r.fired === 2, `fired=${r.fired}`);
}

// F — the picker
{
  const ctx = { minutesDriven: 90, navigating: false, etaSeconds: 0, destinationLabel: "", crewCount: 1, recentKinds: [] as CheckInKind[], recentTexts: [] as string[] };
  const seen = new Set<CheckInKind>();
  let seed = 1;
  const rng = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) seen.add(pickCheckIn(ctx, rng).kind);
  ok("F1 solo, no route: fatigue/joke/stretch/hydrate only", !seen.has("crew") && !seen.has("destination") && seen.has("joke") && seen.has("fatigue"), [...seen].join(","));
  const ctx2 = { ...ctx, crewCount: 3, navigating: true, etaSeconds: 2400, destinationLabel: "Whistler" };
  const seen2 = new Set<CheckInKind>(); let sawDest = "";
  for (let i = 0; i < 300; i++) { const p = pickCheckIn(ctx2, rng); seen2.add(p.kind); if (p.kind === "destination") sawDest = p.text; }
  ok("F2 with crew + route: crew and destination appear", seen2.has("crew") && seen2.has("destination"));
  ok("F3 destination line carries the ETA and the label", sawDest.includes("40 minutes") && sawDest.includes("Whistler"), sawDest);
  let kinds: CheckInKind[] = []; let repeat = false;
  for (let i = 0; i < 100; i++) { const p = pickCheckIn({ ...ctx2, recentKinds: kinds }, rng); if (kinds.length && kinds[kinds.length - 1] === p.kind) repeat = true; kinds = [...kinds, p.kind].slice(-4); }
  ok("F4 never the same kind twice in a row", !repeat);
  const lengths = (Object.keys(CHECKIN_BANK) as CheckInKind[]).flatMap((k) => CHECKIN_BANK[k].map((t) => t.length));
  ok("F5 every line is short enough to be spoken (≤ 150 chars)", Math.max(...lengths) <= 150, `max=${Math.max(...lengths)}`);
  const bad = (Object.keys(CHECKIN_BANK) as CheckInKind[]).flatMap((k) => CHECKIN_BANK[k]).filter((t) => /[*#_`\n]/.test(t));
  ok("F6 no markdown or line breaks in any line", bad.length === 0);
  ok("F7 lead-in at 90 min", leadIn(90) === "Ninety minutes in.", leadIn(90));
  ok("F8 lead-in at 120 / 180 min", leadIn(120) === "Two hours on the road." && leadIn(180) === "Three hours on the road.", `${leadIn(120)} / ${leadIn(180)}`);
  ok("F9 lead-in at 45 min (QA)", leadIn(45) === "45 minutes in.", leadIn(45));
  ok("F10 eta formats", fmtEta(2400) === "40 minutes" && fmtEta(3600) === "an hour" && fmtEta(4500) === "an hour and 15 minutes", `${fmtEta(4500)}`);
  const p = pickCheckIn({ ...ctx, recentTexts: CHECKIN_BANK.joke.slice(0, -1), recentKinds: ["fatigue", "stretch"] }, () => 0.5);
  ok("F11 recent texts are avoided while any fresh one remains", p.kind !== "joke" || p.text.endsWith(CHECKIN_BANK.joke[CHECKIN_BANK.joke.length - 1]));
}

console.log(fails === 0 ? "\nPASS scout_checkin" : `\nFAIL scout_checkin (${fails})`);
if (fails) process.exit(1);
