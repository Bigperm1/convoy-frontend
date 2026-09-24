// scoutCheckIn.ts — Scout's drive check-in: after 90 minutes of actual driving, and every 90
// minutes after that, Scout says one short thing — a fatigue check, a stretch, a sip of water,
// a joke, a word on the crew or on the destination. (Jeff, 2026-09-24: "build the 1.5hr drive
// reminder, add random things like wanna hear a joke or fatigue reminder or anything else".)
//
// This file is PURE — no React Native, no expo — so tools/sim-qc/scout_checkin_test.mts can pin
// the clock and the picker in Node. The wiring (car-state ticks, settings, speech, breadcrumbs)
// lives in src/scoutCheckInRuntime.ts.
//
// The clock counts MOVING time only (speed ≥ 1.5 m/s), so a traffic jam or a ferry line-up does
// not count as driving, and a stop of 15 minutes or more is a real break: the clock starts over.
// A gap in fixes longer than two minutes (phone asleep, app killed) is treated as unknown time
// and never counted; a gap of 15 minutes or more is a break too.

export type CheckInConfig = {
  firstMin: number;       // minutes of driving before the first check-in
  repeatMin: number;      // minutes of driving between check-ins after that
  movingMs: number;       // speed (m/s) at or above which the car counts as driving
  breakResetMin: number;  // a stop this long resets the clock
  maxGapMs: number;       // fixes further apart than this are a gap, not driving
};

export const CHECKIN_DEFAULTS: CheckInConfig = {
  firstMin: 90,
  repeatMin: 90,
  movingMs: 1.5,
  breakResetMin: 15,
  maxGapMs: 120_000,
};

export type CheckInState = {
  movingMs: number;              // driving time accumulated on this leg
  stoppedSinceAt: number | null; // when the current stop began (null while moving)
  lastAt: number | null;         // timestamp of the previous tick
  fired: number;                 // check-ins delivered on this leg
  due: boolean;                  // a check-in is owed and waiting for a quiet moment
};

export function checkInStart(): CheckInState {
  return { movingMs: 0, stoppedSinceAt: null, lastAt: null, fired: 0, due: false };
}

/** Feed one position tick. Returns the next state; `due` flips true when a check-in is owed. */
export function checkInTick(s: CheckInState, at: number, speedMs: number, cfg: CheckInConfig = CHECKIN_DEFAULTS): CheckInState {
  if (!Number.isFinite(at)) return s;
  const spd = Number.isFinite(speedMs) ? speedMs : 0;
  if (s.lastAt === null) return { ...s, lastAt: at, stoppedSinceAt: spd >= cfg.movingMs ? null : at };
  const dt = at - s.lastAt;
  if (dt < 0) return { ...s, lastAt: at };
  let next: CheckInState = { ...s, lastAt: at };
  if (dt > cfg.maxGapMs) {
    // Unknown time: not driving. A long enough gap is a break.
    if (dt >= cfg.breakResetMin * 60_000) next = { ...next, movingMs: 0, fired: 0, due: false };
    next.stoppedSinceAt = spd >= cfg.movingMs ? null : at;
    return next;
  }
  if (spd >= cfg.movingMs) {
    next.movingMs = s.movingMs + dt;
    next.stoppedSinceAt = null;
  } else {
    // A stop is measured from the last fix that was still moving, so a 15-minute stop is
    // 15 minutes, not 15 minutes minus one tick.
    const since = s.stoppedSinceAt ?? s.lastAt;
    next.stoppedSinceAt = since;
    if (at - since >= cfg.breakResetMin * 60_000) {
      next = { ...next, movingMs: 0, fired: 0, due: false };
    }
  }
  const thresholdMs = (cfg.firstMin + next.fired * cfg.repeatMin) * 60_000;
  if (!next.due && next.movingMs >= thresholdMs) next.due = true;
  return next;
}

/** The owed check-in was delivered (or deliberately skipped). */
export function checkInConsume(s: CheckInState): CheckInState {
  return { ...s, due: false, fired: s.fired + 1 };
}

// ── What Scout says ─────────────────────────────────────────────────────────────

export type CheckInKind = "fatigue" | "stretch" | "hydrate" | "joke" | "crew" | "destination";

export type CheckInContext = {
  minutesDriven: number;
  navigating: boolean;
  etaSeconds: number;
  destinationLabel: string;
  crewCount: number;       // cars in the convoy including the driver
  recentKinds: CheckInKind[];
  recentTexts: string[];
};

const FATIGUE = [
  "Quick check: eyes heavy, yawning, drifting in the lane? That's your cue for a proper break, not a coffee.",
  "This is where attention starts to slip. Sit up, both hands on the wheel, and pick a spot to stop in the next half hour.",
  "If you've caught yourself missing a sign or two, that's fatigue talking. Next town, fifteen minutes out of the car.",
  "Roll your shoulders, loosen your grip, and let your eyes scan further down the road.",
  "Fresh air beats the radio. Crack a window for a minute.",
  "Blink slowly a few times and look far ahead. If the road is starting to hypnotise you, that's the break signal.",
];
const STRETCH = [
  "Shoulders back, chin up, squeeze the shoulder blades for five seconds. Twice.",
  "Point your toes and flex your ankles for a few seconds each. The pedal foot goes stiff first.",
  "Unclench your jaw and drop your shoulders. Most drivers don't notice they've been holding both.",
  "Next stop, thirty seconds of standing up straight and reaching for the sky. Your back will thank you.",
];
const HYDRATE = [
  "Sip of water if you've got one. Thirsty drivers make slower decisions.",
  "Coffee counts as half a drink. Water counts as a whole one.",
  "Long drive, dry car air. Drink something before you feel like it.",
];
const JOKES = [
  "Why don't cars ever get lost? They always follow their inner GPS.",
  "I told my car to stop drifting off. It said it was just cornering.",
  "What do you call a sleeping bull on the highway? A bulldozer.",
  "Why did the traffic light turn red? You would too if you had to change in the middle of the street.",
  "What kind of car does an egg drive? A Yolkswagen.",
  "My car's favourite music? Anything with a good brake beat.",
  "Why do bicycles fall over? They're two-tired. Which, this far in, might be you too.",
  "What did the road say to the tire? Stop pressing me.",
  "Why was the belt pulled over? It was holding up a pair of pants.",
  "How does a car get in touch? It gives you a brake call.",
  "What do you call a can opener that doesn't work? A can't opener.",
  "I'd tell you a joke about a long straight road, but it goes on forever.",
];
const CREW = [
  "How's the crew holding up? A quick check on the Comms tab at the next stop never hurts.",
  "Everyone still in formation? If someone's dropped back, a pit stop is a good way to regroup.",
  "Cruise tip: the last car sets the pace. Give them a wave at the next light.",
];
const DESTINATION = [
  "About {eta} to {dest}. You're most of the way. Keep it smooth.",
  "{dest} is {eta} out. Good time to think about where you'll park.",
  "Roughly {eta} left to {dest}. Steady as she goes.",
];

export const CHECKIN_BANK: Record<CheckInKind, string[]> = {
  fatigue: FATIGUE, stretch: STRETCH, hydrate: HYDRATE, joke: JOKES, crew: CREW, destination: DESTINATION,
};

const WEIGHTS: Record<CheckInKind, number> = { fatigue: 30, joke: 30, stretch: 15, hydrate: 10, crew: 8, destination: 12 };

export function leadIn(minutesDriven: number): string {
  const h = Math.floor(minutesDriven / 60);
  const m = Math.round(minutesDriven - h * 60);
  if (h === 0) return `${m} minutes in.`;
  if (h === 1 && m < 15) return "An hour in.";
  if (h === 1 && m >= 25 && m <= 35) return "Ninety minutes in.";
  if (m < 15) return `${h === 2 ? "Two" : h === 3 ? "Three" : h === 4 ? "Four" : String(h)} hours on the road.`;
  return `${h === 1 ? "An hour" : `${h} hours`} and a bit on the road.`;
}

export function fmtEta(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60), m = min % 60;
  if (m === 0) return h === 1 ? "an hour" : `${h} hours`;
  return `${h === 1 ? "an hour" : `${h} hours`} and ${m} minutes`;
}

/** Choose the next line. `rng` is injectable so the gate can pin the picker. */
export function pickCheckIn(ctx: CheckInContext, rng: () => number = Math.random): { kind: CheckInKind; text: string } {
  const eligible: CheckInKind[] = (Object.keys(WEIGHTS) as CheckInKind[]).filter((k) => {
    if (k === "crew" && ctx.crewCount < 2) return false;
    if (k === "destination" && !(ctx.navigating && ctx.etaSeconds > 0 && ctx.destinationLabel)) return false;
    // never the same kind twice in a row, and not the kind before that either when there is choice
    if (ctx.recentKinds.slice(-2).includes(k)) return false;
    return true;
  });
  const pool = eligible.length ? eligible : (Object.keys(WEIGHTS) as CheckInKind[]);
  const total = pool.reduce((a, k) => a + WEIGHTS[k], 0);
  let r = rng() * total;
  let kind: CheckInKind = pool[pool.length - 1];
  for (const k of pool) { r -= WEIGHTS[k]; if (r < 0) { kind = k; break; } }
  const lines = CHECKIN_BANK[kind].filter((t) => !ctx.recentTexts.includes(t));
  const bank = lines.length ? lines : CHECKIN_BANK[kind];
  let text = bank[Math.min(bank.length - 1, Math.floor(rng() * bank.length))];
  if (kind === "destination") {
    text = text.replace("{eta}", fmtEta(ctx.etaSeconds)).replace("{dest}", ctx.destinationLabel);
  }
  return { kind, text: `${leadIn(ctx.minutesDriven)} ${text}` };
}
