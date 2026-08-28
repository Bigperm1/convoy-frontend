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
//   inst=..      per-MOUNT breakdown, `key:raf/cam` — e.g. `phone#1:3412/3390,car#3:98211/402`.
//                A trailing `!` means that mount UNMOUNTED and its counters GREW afterwards —
//                a leaked loop. Up to 4 leaked rows + top 3 live rows; a `+N!` tail counts
//                leaks that did not fit. See the block above noteFrame for the full rules.
//   ⚠ tick= was DEAD until 2026-08-28 — noteTick() had NO callers, so every historical row
//   reads tick=0 regardless of what React did. Any past conclusion drawn from tick=0
//   ("React exonerated") is unfounded. It is now wired to every setTick site in
//   SelfCarModel, so rows from this OTA onward measure real re-render commits.
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

// ── PER-INSTANCE ATTRIBUTION (2026-08-28) ────────────────────────────────────
// The counters above are MODULE-LEVEL, so they sum every SelfCarModel mount — the
// phone map's and the CarPlay map's. That was fine for "is rAF running at 120 Hz?"
// and useless for the thing we actually found: a runaway loop spinning up to
// 53,781 callbacks/second (dtP50 = dtP95 = 0.0) in ~6.8% of all monitored minutes,
// across 3+ testers and both runtimes including build 74.
//
// A summed counter cannot say WHICH loop is spinning, so no fix can be aimed. These
// maps break the total down by mount, and — the point of the exercise — keep counting
// a mount AFTER it unmounts. A retired mount whose activity GROWS past what it had at
// the moment it retired is a LEAKED loop, reported with a `!`.
//
// Hardened by a 29-agent adversarial review + a node harness BEFORE shipping; the
// naive version had all of these wrong. The rules, each one bought by a confirmed
// failure:
//   • `!` means "ticked AFTER unmount", not "unmounted this window" — hence the
//     _retiredBase snapshot. Without it every clean unmount printed as a leak.
//   • _retiredBase entries reset to 0 at every flush — the counters reset per
//     window, so in any window after retirement ANY tick is post-unmount growth.
//     Without the reset, a leak's next-window count (starting from 0) never beat
//     its old baseline and the flag vanished after one window.
//   • _retired / _retiredBase survive startHeatProbe — the probe restarts on every
//     nav start AND every CarPlay connect/disconnect (map.tsx effect deps), and a
//     leaked loop outlives all of those. Keys are globally unique per JS context
//     (monotonic seq, never reset), so retention cannot collide with a live mount.
//     Bounded: tens of short strings per app session.
//   • Activity = raf + cam, because three of the four camera-push paths are NOT
//     rAF-driven (bgTick, fix-effect snap, stale-bg fallback) — 18 real rows in
//     crash_reports show raf=0 with cam>0. A raf-only view missed those mounts
//     and could never flag a leaked 30 Hz bgTimer.
//
// ⚠ OBSERVATION ONLY, per this file's standing rule: counts and a growth flag.
// No verdict is computed on-device.
const _instRaf = new Map<string, number>();
const _instCam = new Map<string, number>();
const _retired = new Set<string>();
/** Activity (raf+cam) each retired mount had at the moment it retired, reset to 0
 *  every flush. Growth past this = post-unmount ticking = leak. */
const _retiredBase = new Map<string, number>();

/** Hard ceiling on interval samples per window. 3600 already describes the
 *  distribution fully; without a ceiling the 53k-cb/s runaway pushed ~800k entries
 *  and the per-minute slice+sort blocked the JS thread for ~650 ms MID-DRIVE. That
 *  bug was live on testers before this change — the old "cap" comment capped
 *  nothing past thinning to every 4th sample. */
const DTS_MAX = 3600;

/** Called from the rAF step. Must stay trivial — it runs up to 120x/sec (and, during
 *  the bug this exists to catch, ~50,000x/sec). */
export function noteFrame(now: number, inst?: string): void {
  if (!_on) return;
  _raf++;
  if (inst) _instRaf.set(inst, (_instRaf.get(inst) ?? 0) + 1);
  if (_last) {
    const dt = now - _last;
    // Thin to every 4th once warm, and STOP at DTS_MAX (see above).
    if (_dts.length < 900 || ((_raf & 3) === 0 && _dts.length < DTS_MAX)) _dts.push(dt);
  }
  _last = now;
}

export function noteCam(inst?: string): void {
  if (!_on) return;
  _cam++;
  if (inst) _instCam.set(inst, (_instCam.get(inst) ?? 0) + 1);
}

const _act = (k: string) => (_instRaf.get(k) ?? 0) + (_instCam.get(k) ?? 0);

/** A SelfCarModel mount has unmounted. Its loops SHOULD all stop; any activity
 *  growth past this moment is a leak. Deliberately NOT gated on _on: a mount that
 *  retires between drives must still be flaggable on the next drive. */
export function retireInstance(inst: string): void {
  _retired.add(inst);
  _retiredBase.set(inst, _act(inst));
}

/** `inst=` field, two separate budgets so neither class can crowd out the other
 *  (review finding: one dead-first sort + global slice let remount churn hide the
 *  live spinning mount, and silently dropped extra leaks):
 *    • up to 4 LEAKED rows (retired AND grown past baseline), busiest first, with
 *      a trailing `+N!` token when more leaks had to be dropped — a hidden corpse
 *      must be visible as a count even when it cannot be named;
 *    • the top 3 LIVE rows by activity.
 *  Format per row: `key:raf/cam`, leaked rows end with `!`. */
function instField(): string {
  const keys = new Set<string>([
    ...(_instRaf.keys() as any), ...(_instCam.keys() as any),
  ] as string[]);
  if (!keys.size) return '';
  const rows = [...(keys.values() as any)].map((k: string) => ({
    k, raf: _instRaf.get(k) ?? 0, cam: _instCam.get(k) ?? 0, act: _act(k),
    dead: _retired.has(k) && _act(k) > (_retiredBase.get(k) ?? 0),
  }));
  const dead = rows.filter((r) => r.dead).sort((a, b) => b.act - a.act);
  const live = rows.filter((r) => !r.dead).sort((a, b) => b.act - a.act);
  const fmt = (r: { k: string; raf: number; cam: number; dead: boolean }) =>
    `${r.k}:${r.raf}/${r.cam}${r.dead ? '!' : ''}`;
  const parts = [...dead.slice(0, 4).map(fmt), ...live.slice(0, 3).map(fmt)];
  if (dead.length > 4) parts.push(`+${dead.length - 4}!`);
  return ' inst=' + parts.join(',');
}
export function noteTick(): void { if (_on) _tick++; }

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return -1;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

async function flush(): Promise<void> {
  // ctx snapshotted NOW: the battery await below yields, and a carConnected flip can
  // restart the probe with a new label before this window's row is written — the old
  // read-at-template-time logged a phone segment's last window as `surface=car`.
  const ctx = _ctx;
  const raf = _raf, cam = _cam, tick = _tick;
  const dts = _dts.slice().sort((a, b) => a - b);
  const inst = instField();
  _raf = 0; _cam = 0; _tick = 0; _dts = []; _last = 0;
  _instRaf.clear(); _instCam.clear();
  // ⚠ _retired / _retiredBase are deliberately NEVER pruned mid-session — an
  // INTERMITTENT leak loses its `!` forever the moment it is forgotten. Baselines DO
  // reset to 0 here: the per-window counters just reset, so from the next window on,
  // ANY activity from a retired mount is post-unmount growth. (Both rules bought by
  // harness failures; see the block above noteFrame.)
  for (const k of [...(_retiredBase.keys() as any)] as string[]) _retiredBase.set(k, 0);
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
      `heat-probe ${ctx} raf=${raf} cam=${cam} tick=${tick} ` +
      `dtP50=${pct(dts, 50).toFixed(1)} dtP95=${pct(dts, 95).toFixed(1)} batt=${batt}${inst}`,
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
  _instRaf.clear(); _instCam.clear();
  // _retired / _retiredBase are NOT cleared. This function re-runs on every nav start
  // and every CarPlay connect/disconnect (map.tsx effect), and a leaked rAF loop
  // outlives all of those — clearing here stripped the `!` from exactly the leak
  // shape most worth catching (one that survives the end of a drive). Retention is
  // safe: mount keys are globally unique per JS context and instField only prints
  // keys with activity this window. Baselines drop to 0 so any post-restart tick
  // from a retired mount flags immediately.
  for (const k of [...(_retiredBase.keys() as any)] as string[]) _retiredBase.set(k, 0);
  _timer = setInterval(() => { void flush(); }, WINDOW_MS);
}

export function stopHeatProbe(): void {
  if (!_on) return;
  _on = false;
  if (_timer) { clearInterval(_timer); _timer = null; }
  void flush();   // do not throw away a partial window — a short drive is still data
}
