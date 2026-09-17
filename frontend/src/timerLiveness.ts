// src/timerLiveness.ts
//
// ⛔ 2026-09-04/05 — "the car surface must keep working with the phone locked and the
// app not open, like Waze." Field data forced a split this file exists to measure
// honestly, instead of guessing at a single "is it frozen" bit:
//
//   Rodrigo (iOS, CarPlay), 19:14-19:19 PT (crash_reports): off-route trips posted LIVE
//   every 8-9 s (fix-driven — native location events kept reaching JS and ran the
//   off-route decision) while the 15 s route-fetch ABORT timers (setTimeout,
//   src/nav.ts ROUTE_FETCH_TIMEOUT_MS) fired 29-at-once at 19:19:25, 176-307 s late,
//   and the 60 s heat-probe setInterval reported win=577549ms. JS TIMERS were dead;
//   native location events were not.
//
//   The architect's sim run (2026-09-05, iOS 27 sim, Cmd+L lock @ 54 km/h) measured the
//   OPPOSITE split: the 15 s ribbon-trim/cam-mode receipts (setInterval/effect-driven)
//   kept cadence — timers ALIVE — while heat-probe's rAF count fell 3492->486/min and
//   nav-eta/proj froze at 27 m — LOCATION events stopped. So "JS timers dead", "rAF
//   dead" and "location dead" are THREE INDEPENDENT failure axes, not one signal, and
//   conflating any two of them would have called this exactly backwards on the sim.
//
// This module measures exactly one of those axes — JS TIMER SERVICE — off the plainest
// instrument available: a 1 s setInterval. That is deliberate, not a simplification:
// ConvoyMapbox.tsx's PUMP GUARD comment (~line 1580, sourced from the RN 0.81.5 code)
// documents that requestAnimationFrame under the New Architecture IS
// `createTimer(delay 0)` — it behaves like 60 Hz only because RCTTiming is pumped by a
// CADisplayLink, and once iOS backgrounds the app RCTTiming sets `_inBackground` and
// every 0-delay timer (rAF included) degrades to a runloop-paced NSTimer. So rAF and
// setInterval/setTimeout are normally the SAME mechanism underneath and move together
// — consistent with Rodrigo's case. But the sim run above proved they CAN diverge, so
// this module never infers timer liveness from rAF (or vice versa): `timersStarvedMs()`
// answers ONLY "has the 1 s setInterval been serviced recently", and `rafFramesInLast5s()`
// is a separate, independent counter fed from the rAF loop itself (ConvoyMapbox.tsx's
// `step()`) purely for the receipt — it never feeds a decision here.
//
// Self-starting at module load (same pattern as navNotification.ts's module-scope
// timers, e.g. `_stallTimer`) — nothing needs to import and "start" this clock, so
// wiring it in never requires touching map.tsx or any file outside the surfaces
// department's own files.
//
// LAZY require()s, not static imports (mirrors crashBreadcrumb.ts's own
// `require("./supabase")` pattern) — deliberately, for two reasons: (1) settings.ts /
// crashBreadcrumb.ts pull in AsyncStorage/react-native, which this module's actual
// arithmetic does not need, so the pure clock + rAF-window logic below stays runnable
// under plain `node --experimental-strip-types` (tools/sim-qc/timer_starve_test.mts) —
// the same reason src/offRouteGate.ts stayed dependency-free; (2) it degrades exactly
// like every other optional dependency in this codebase: `require` is undefined under
// Node's ESM loader, throws, and the try/catch leaves the debug switch at its default
// `false` and the receipt silently unsent — never a hard failure either way.
function lazySettings(): { getSettings: () => any; subscribeSettings: (fn: (s: any) => void) => () => void } | null {
  try { return require('./settings'); } catch { return null; }
}
function lazyLogEventReliable(message: string): void {
  try { require('./crashBreadcrumb').logEventReliable(message); } catch {}
}

// ── THE CLOCK ────────────────────────────────────────────────────────────────────────
let lastTickAt = Date.now();

/** Stamped by the module's own 1 s heartbeat. Exported so a test harness can drive it
 * directly without waiting on a real setInterval. Never call this from anywhere else —
 * a caller stamping it from its own timer would defeat the whole point. */
export function noteTimerTick(now: number = Date.now()): void {
  lastTickAt = now;
}

// ── DEBUG-ONLY FORCED STARVATION (2026-09-05, architect's addendum) ─────────────────
// The field freeze cannot be reproduced in the simulator (measured above: a sim lock
// starves rAF and location, not timers — the opposite axis). So `timersStarvedMs()` can
// be forced to report "starved" to exercise the fix-driven marker/camera bypass and the
// off-route hold against a NORMAL location replay in the sim, without a multi-minute
// real background freeze.
//
// HOW TO TRIGGER IT: Settings -> Developer -> turn ON "Debug overlays" (this reveals a
// second row) -> turn ON "Force timer starvation" underneath it. Nested behind a
// developer-only screen AND a second toggle specifically so it cannot be hit by
// accident; both default OFF, and this is a brand-new settings key so every existing
// install (including ones with old persisted JSON that predates this field) gets the
// default via `{...DEFAULT_SETTINGS, ...parsed}` — see settings.ts. Never read from
// anywhere except this module.
// Codex adversarial review (2026-09-05) caught a hidden persisted override: enable
// Debug overlays + Force timer starvation, then disable Debug overlays alone — the
// force ROW disappears from the UI but `debugForceTimerStarve` stays `true` in
// storage, and this subscription used to read that field on its own, so the override
// kept firing across restarts with Debug overlays OFF and no visible control. The fix
// is this pure helper: the override is honoured ONLY while BOTH flags read true, and
// it is re-derived from both fields on every settings emission (never latched), so
// flipping either one off in the same tick turns it off immediately.
// 🔒 NAV-LOCK begin timer-debug-force — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
export function effectiveDebugForce(debugOverlays: unknown, debugForceTimerStarve: unknown): boolean {
  return debugOverlays === true && debugForceTimerStarve === true;
}
// 🔒 NAV-LOCK end timer-debug-force

let _debugForce = false;
{
  const s = lazySettings();
  if (s) {
    try { const cur = s.getSettings(); _debugForce = effectiveDebugForce(cur.debugOverlays, cur.debugForceTimerStarve); } catch {}
    try { s.subscribeSettings((next: any) => { _debugForce = effectiveDebugForce(next.debugOverlays, next.debugForceTimerStarve); }); } catch {}
  }
}

/** Test-only escape hatch (tools/sim-qc/timer_starve_test.mts) — the app itself must
 * never call this; it always goes through the real settings.ts subscription above. */
export function __setDebugForceForTest(v: boolean): void { _debugForce = v; }

// Sane sentinel instead of Number.MAX_SAFE_INTEGER (2026-09-05, same Codex review):
// MAX_SAFE_INTEGER arithmetic (e.g. `now - lastTickAt` reconstructions, or a future
// caller doing dt math) risks overflow/NaN surprises, and a huge inhuman number in a
// crash_reports row invites exactly the "is this a real freeze" confusion the forced
// switch exists to avoid. 999999 ms (~16.7 min) is comfortably past every real
// threshold in this file (STARVE_LOG_THRESHOLD_MS=3000, and offRouteGate.ts's
// TIMERS_STARVED_RECEIPT_MS — a RECEIPT threshold, it never blocks a trip) while still
// reading as an obvious sentinel, not a measurement.
export const FORCED_STARVE_DT_MS = 999999;

/** ms since the 1 s heartbeat last ticked — the ONLY signal this returns. Forced to
 * FORCED_STARVE_DT_MS while the sim-only debug switch above is on (both `debugOverlays`
 * AND `debugForceTimerStarve` must be true — see effectiveDebugForce). */
// 🔒 NAV-LOCK begin timer-starved-signal — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
export function timersStarvedMs(now: number = Date.now()): number {
  if (_debugForce) return FORCED_STARVE_DT_MS;
  return Math.max(0, now - lastTickAt);
}
// 🔒 NAV-LOCK end timer-starved-signal

// ── rAF SIDE CHANNEL (diagnostic only — never feeds a decision) ─────────────────────
// Tumbling (not sliding) 5 s windows: O(1) per frame with bounded memory even under the
// measured rAF-runaway pathology (raf-runaway-spin-heat: up to 52,839 callbacks/s on
// iOS) — a timestamp array would blow up there. Approximate by construction (a frame
// landing right after a window rotates is undercounted by up to one window's worth),
// which is fine for a breadcrumb that only needs to show "roughly alive" vs "silent".
const RAF_WINDOW_MS = 5000;
// Lazily seeded by the FIRST call (either function), never by module-load wall-clock —
// so there is no phantom window between import time and the first real rAF frame, and a
// synthetic clock (a test) never has to race the real Date.now() the module happened to
// load at. `null` reads honestly as "never seen a frame yet".
let rafWindowStart: number | null = null;
let rafWindowCount = 0;
let rafPrevWindowCount = 0;

/** Call from the rAF loop itself (ConvoyMapbox.tsx `step()`), once per frame. */
export function noteRafFrame(now: number = Date.now()): void {
  if (rafWindowStart == null || now - rafWindowStart >= RAF_WINDOW_MS) {
    rafPrevWindowCount = rafWindowStart == null ? 0 : rafWindowCount;
    rafWindowCount = 0;
    rafWindowStart = now;
  }
  rafWindowCount++;
}

/** Frames counted over roughly the last 5-10 s (see the tumbling-window note above). 0
 * before the first frame ever, or once the current window itself has gone stale for 2
 * window-lengths, so a long-dead rAF loop reports 0 instead of a frozen historical count. */
export function rafFramesInLast5s(now: number = Date.now()): number {
  if (rafWindowStart == null || now - rafWindowStart >= RAF_WINDOW_MS * 2) return 0;
  return rafWindowCount + rafPrevWindowCount;
}

// ── BOUNDED RECEIPT ──────────────────────────────────────────────────────────────────
// Absence-interpreted (a missing row reads as "never starved"), so logEventReliable per
// RULES.md ("Instrument absence-interpreted rows with logEventReliable").
const STARVE_LOG_THRESHOLD_MS = 3000;
const STARVE_LOG_EVERY_MS = 10000;
let lastStarveLogAt = 0;

// Pure formatter so a forced-vs-real receipt can be exercised in plain Node
// (tools/sim-qc/timer_starve_test.mts) without a real logEventReliable call. `forced`
// must ALWAYS be stamped explicitly — 2026-09-05 Codex review's point exactly: the
// field must never have to infer "was this a sim run" from the dt value alone.
export function buildStarveLogLine(dt: number, surf: 'phone' | 'car', raf: number, forced: boolean): string {
  return `timer-starve dt=${dt} surf=${surf} raf=${raf} forced=${forced ? 1 : 0}`;
}

/**
 * Call from a FIX path (never from a timer/rAF loop — the whole point is this must
 * still run when timers are dead: native location delivery is not a JS timer). Returns
 * the current starvation figure so callers can reuse it for their own bypass decision
 * without a second Date.now()/timersStarvedMs() call.
 */
export function maybeLogTimerStarve(surf: 'phone' | 'car', now: number = Date.now()): number {
  const dt = timersStarvedMs(now);
  if (dt > STARVE_LOG_THRESHOLD_MS && now - lastStarveLogAt > STARVE_LOG_EVERY_MS) {
    lastStarveLogAt = now;
    lazyLogEventReliable(buildStarveLogLine(dt, surf, rafFramesInLast5s(now), _debugForce));
  }
  return dt;
}

// ── NATIVE TIMER PUMP RECEIPT (build 79, iOS, 2026-09-14) ────────────────────────────
// modules/hairpin-system/ios/HairpinTimerPump.mm services RN's timer queue from the CarPlay
// screen's display link while RN's own link (bound to the built-in display, RN 0.81.5
// RCTDisplayLink.m:32) is silent — the mechanism behind every `timer-starve surf=car` row
// (2,263 rows dt>60 s, 50 iOS instances, raf=0 on all, 21 d to 09-13).
//   inst/why   hooks installed (why = the RN selector/ivar that did not match, or
//              no-class-in-binary / no-stats; '-' when ok)
//   car/fps    CarPlay-screen link live, at its max refresh; dbg = bench launch-arg bits
//              (1 starve, 2 bind-main, 4 no-pump); onMain = the pump's link is on the PHONE
//              screen (must be 0 unless dbg>0)
//   main/drop  RN link ticks since last row (0 while the display is off) / bench-dropped ticks
//   carT/drv   car ticks / JS timer passes the pump ran (drv≈carT display off, ≈0 display on)
//   fresh      car ticks skipped because RN's link was live (the display-on heat check)
//   paused     car ticks skipped because RN had nothing scheduled
//   ep/maxMs/nowMs  takeover episodes / longest / current;  mp = RN link paused now
//   stuck      a queued pass not run within 1 s (JS thread busy or its run loop gone) — informational
//   as/cs/pd   UIApplication state (0 active 1 inactive 2 background) / car scene
//              activationState / protected data (0 = locked WITH a passcode; a phone with no
//              passcode never reads 0); -1 = unknown
//   tbg/tp     RCTTiming _inBackground / _paused read from the ivars (-1 unreadable) — settles
//              whether a silent minute was an armed link (tbg=0 tp=0) or RCTTiming's own state
//   ps         most-foreground phone scene (0 foregroundActive 1 foregroundInactive 2 background)
//   drvFg/skipFg  pump passes made while ps=0 (must stay ≈0) / car ticks held back by the 1 s
//              phone-foreground rule
// FIX path only (native location delivery is not a JS timer), ≤1 row/60 s, only while a car
// link is live — plus one row per JS load if the hooks refused or the class is missing.
type PumpNumKey = 'fps' | 'dbg' | 'mainTicks' | 'mainDropped' | 'carTicks' | 'drives' | 'skipFresh'
  | 'skipPaused' | 'starveEp' | 'starveMaxMs' | 'starvingMs' | 'sinceMainMs' | 'stuck' | 'appState'
  | 'carScene' | 'protectedData' | 'timingBg' | 'timingPaused' | 'phoneScene' | 'drivesPhoneFg' | 'skipPhoneFg';
export type TimerPumpStats = Partial<Record<PumpNumKey, number>> & {
  installed?: boolean; why?: string; bound?: boolean; car?: boolean; mainPaused?: boolean; onMain?: boolean;
};

function lazyHairpinSystem(): any {
  try { return require('../modules/hairpin-system').HairpinSystem; } catch { return null; }
}
function lazyAppState(): string {
  try { return String(require('react-native').AppState.currentState ?? '?'); } catch { return '?'; }
}

export const TIMER_PUMP_LOG_EVERY_MS = 60000;
let lastPumpLogAt = 0;
let lastPump: TimerPumpStats | null = null;

export function buildTimerPumpLine(cur: TimerPumpStats, prev: TimerPumpStats | null, app: string): string {
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const d = (k: PumpNumKey): number => Math.max(0, Math.round(num(cur[k]) - num(prev ? prev[k] : 0)));
  const v = (k: PumpNumKey): number => Math.round(num(cur[k]));
  const s = (k: PumpNumKey): number => (typeof cur[k] === 'number' && Number.isFinite(cur[k]) ? Math.round(cur[k] as number) : -1);
  return `timer-pump inst=${cur.installed ? 1 : 0} why=${cur.why ? cur.why : '-'} bound=${cur.bound ? 1 : 0} ` +
    `car=${cur.car ? 1 : 0} fps=${v('fps')} dbg=${v('dbg')} ` +
    `main=${d('mainTicks')} drop=${d('mainDropped')} carT=${d('carTicks')} drv=${d('drives')} ` +
    `fresh=${d('skipFresh')} paused=${d('skipPaused')} ep=${d('starveEp')} maxMs=${v('starveMaxMs')} ` +
    `nowMs=${v('starvingMs')} sinceMain=${v('sinceMainMs')} mp=${cur.mainPaused ? 1 : 0} stuck=${d('stuck')} ` +
    `as=${s('appState')} cs=${s('carScene')} pd=${s('protectedData')} tbg=${s('timingBg')} tp=${s('timingPaused')} ` +
    `ps=${s('phoneScene')} drvFg=${d('drivesPhoneFg')} skipFg=${d('skipPhoneFg')} onMain=${cur.onMain ? 1 : 0} app=${app} first=${prev ? 0 : 1}`;
}

/** FIX path only (src/carplay/carStore.ts setCarSelfPosition). No-op on Android, on web, under
 * Node, and on any binary without the native pump Function (build ≤78). */
export function maybeLogTimerPump(now: number = Date.now()): void {
  if (now - lastPumpLogAt < TIMER_PUMP_LOG_EVERY_MS) return;
  lastPumpLogAt = now;   // stamp first: a throwing native call is not retried on every fix
  const HS = lazyHairpinSystem();
  if (!HS || typeof HS.timerPumpStats !== 'function') return;
  let st: TimerPumpStats | null = null;
  try { st = HS.timerPumpStats() as TimerPumpStats | null; } catch { return; }
  if (!st) return;
  const refused = !st.installed && lastPump == null;
  if (st.car || refused) lazyLogEventReliable(buildTimerPumpLine(st, lastPump, lazyAppState()));
  lastPump = st;
}

// ── START THE CLOCK ──────────────────────────────────────────────────────────────────
// 🔒 NAV-LOCK begin timer-heartbeat — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)
let _timer: ReturnType<typeof setInterval> | null = null;
function start(): void {
  if (_timer != null) return;
  lastTickAt = Date.now();
  _timer = setInterval(() => noteTimerTick(), 1000);
}
start();
// 🔒 NAV-LOCK end timer-heartbeat
