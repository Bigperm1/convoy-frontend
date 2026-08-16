// heatProbe.ts — measure the things the heat argument currently rests on.
//
// WHY THIS EXISTS (2026-08-16). Jeff drove ~2 hours on build 73 and the phone got hot
// enough that iOS refused to charge it. The analysis that followed produced a confident
// per-second work budget — ~770 JavaScript-originated native operations per second — but
// EVERY number in it is arithmetic, not measurement, and it rests on two assumptions
// nobody has checked on a real device:
//
//   1. that rAF actually runs at 60 Hz. app.json sets CADisableMinimumFrameDurationOnPhone
//      and RN's display link (RCTDisplayLink.m) sets no frame-rate cap, while BOTH MapViews
//      are hard-capped at preferredFramesPerSecond={60}. If rAF is running at 120 on a
//      ProMotion phone, half of that work is discarded before it is ever drawn — and every
//      number in the budget doubles.
//   2. that the phone is actually thermally throttling, rather than merely warm.
//
// The app reports NO temperature today, and Jeff cannot ask a tester to drive on cue
// (Say Phin has a family; this is not his job). So this has to be hands-free: it rides an
// ordinary drive and answers from Supabase, with nobody told to do anything.
//
// ⚠ IT RECORDS OBSERVATIONS, NOT CONCLUSIONS. Two instruments in this project have already
// failed review for computing their own answer from their own input (update_id, and the
// first AA-scale probe). Everything here is a COUNT of something that happened or a value
// read back from the OS. No derived verdicts, no ratios computed on-device — the
// arithmetic happens off-device where it can be corrected without shipping.
//
// HOW TO READ IT — one `heat-probe` row per 60 s of navigation:
//   raf=N        rAF callbacks in the window. ~3600 = 60 Hz. ~7200 = 120 Hz -> the budget
//                doubles and the ProMotion hypothesis is CONFIRMED.
//   dtP50/dtP95  rAF interval percentiles in ms. 16.7 = 60 Hz, 8.3 = 120 Hz. P95 exposes
//                stalls the mean would hide — a stall IS a visible camera stutter today,
//                because the pose is computed on the stalling thread.
//   cam=N        setCamera pushes. Each is a JSON encode in JS + JSON decode in native.
//   tick=N       React re-render commits of the self-car subtree.
//   batt=..      battery level 0-1, and the OS charging state.
//   ⚠ THE THERMAL TELL: level FLAT or FALLING while state=CHARGING means iOS is refusing
//   the charger — which is exactly the symptom Jeff reported, captured automatically.

import { Platform } from 'react-native';
import { logEvent } from './crashBreadcrumb';

const WINDOW_MS = 60_000;

let _on = false;
let _timer: any = null;
let _raf = 0;
let _cam = 0;
let _tick = 0;
let _last = 0;
let _dts: number[] = [];
let _ctx = '';

/** Called from the rAF step. Must stay trivial — it runs up to 120x/sec. */
export function noteFrame(now: number): void {
  if (!_on) return;
  _raf++;
  if (_last) {
    const dt = now - _last;
    // Cap the sample buffer: a 60 s window at 120 Hz is 7200 entries and we only need a
    // distribution. Keep every 4th once we have plenty.
    if (_dts.length < 900 || (_raf & 3) === 0) _dts.push(dt);
  }
  _last = now;
}

export function noteCam(): void { if (_on) _cam++; }
export function noteTick(): void { if (_on) _tick++; }

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return -1;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

async function flush(): Promise<void> {
  const raf = _raf, cam = _cam, tick = _tick;
  const dts = _dts.slice().sort((a, b) => a - b);
  _raf = 0; _cam = 0; _tick = 0; _dts = []; _last = 0;
  if (raf === 0 && cam === 0) return;   // nothing happened; do not spend an INSERT

  let batt = 'na';
  try {
    // expo-battery is already a dependency and already used by src/powerMode.ts.
    // Required lazily so a missing module can never touch the drive.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const B = require('expo-battery');
    const lvl = await B.getBatteryLevelAsync();
    const st = await B.getBatteryStateAsync();
    const NAMES: Record<number, string> = { 0: 'unknown', 1: 'unplugged', 2: 'charging', 3: 'full' };
    batt = `${typeof lvl === 'number' ? lvl.toFixed(3) : 'na'}/${NAMES[st] ?? String(st)}`;
  } catch {}

  try {
    logEvent(
      `heat-probe ${_ctx} raf=${raf} cam=${cam} tick=${tick} ` +
      `dtP50=${pct(dts, 50).toFixed(1)} dtP95=${pct(dts, 95).toFixed(1)} batt=${batt}`,
    );
  } catch {}
}

/**
 * Start sampling. Called when turn-by-turn begins; safe to call repeatedly.
 * `ctx` is free-form and goes on every row — pass whatever distinguishes the run
 * (surface, plugged state), so rows can be compared without joining another table.
 */
export function startHeatProbe(ctx: string): void {
  if (Platform.OS === 'web') return;
  _ctx = ctx;
  if (_on) return;
  _on = true;
  _raf = 0; _cam = 0; _tick = 0; _dts = []; _last = 0;
  _timer = setInterval(() => { void flush(); }, WINDOW_MS);
}

export function stopHeatProbe(): void {
  if (!_on) return;
  _on = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
  void flush();   // do not throw away a partial window — a short drive is still data
}
