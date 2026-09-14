// src/carplay/carStatus.ts — the car screen says WHAT IS MISSING (location, sign-in, network).
//
// ── WHY (build 79 car-screen messaging, 2026-09-14) ──────────────────────────────────────────
// A car session with no location permission sat on the Hairpin wordmark with no explanation.
// carPlayBootstrap.ts wrote `carDbg: 'seed:no-fg-perm'` and returned; carDbg is drawn only with
// Settings → CarPlay debug on (ConvoyCarPlay.tsx bootSurface), and no telemetry row recorded the
// permission state of a car session at all (the seed:no-fg-perm / bg:no-always / bgstart:err
// breadcrumbs go to carDbg only). A missing or unreadable token made carDataService.connectWs
// return silently, so the crew and hazards just never arrived.
//
// This module gathers the inputs (Location Services on/off, foreground permission, token state,
// netHealth, whether there is a fix), lets carStatusRule.ts pick ONE condition, and writes it to
// carStore.carStatus. carStatusCopy.ts holds the words.
//
// ── WHERE IT RENDERS — OUR SURFACE ONLY, NEVER A TEMPLATE ────────────────────────────────────
// CarBootScreen (no fix) and the lowest-priority status-pill slot over the live map. Never a
// presented CPAlertTemplate or a pushed androidx screen: a modal covers every map button and its
// dismissal would ride a JS timer that iOS pauses on a locked phone (CARPLAY.md rule 7b; memory
// carplay-dead-buttons-root-cause), and on Android Auto a push/pop has evicted the driver to the
// app drawer (memory aa-poptotemplate-evicts-driver). Our surface cannot block a button: CarPlay
// routes touches through the template layer (CARPLAY.md rule 5).
//
// ── NO TIMERS ─────────────────────────────────────────────────────────────────────────────────
// JS timers starve on the car surface (timer-starve surf=car rows; iOS pauses them while locked).
// Re-evaluation is EVENT-driven: connect, AppState changes, a fix arriving or going, carStore ticks
// (at most every TICK_REFRESH_MS), car button presses, network flips and permission results. The
// Android Auto "check your phone" window is a TIMESTAMP compared at render (carAskUntil).
//
// ── ANDROID AUTO: ASKING FROM THE CAR (build 79 native) ──────────────────────────────────────
// RNCarPlay.requestPermissions (patches/react-native-carplay, CarPlayModule.kt) launches androidx's
// CarAppPermissionActivity on the PHONE display. On build 78 the method does not exist, so
// canRequestFromCar() is false and none of this is reachable — the car just states the condition.
//
// ── RECEIPTS (logEventReliable; read PRESENCE, never absence) ────────────────────────────────
//   car-status to= from= why= surf= fix= svc= perm= bg= app= tok= net= lock=   one per TRANSITION, <= STATUS_ROWS_MAX per connect
//   aa-perm op=request|result|err|skip|unavailable kind=loc|mic ...           per car-initiated ask, <= PERM_ROWS_MAX per connect
// `car-status` records the DECISION; `car-status-drawn` (ConvoyCarPlay.tsx) records that a surface
// rendered it. Neither proves pixels reached the head unit (render can starve — build-79 gaps #2/#3).
import { AppState, NativeModules, Platform } from 'react-native';
import * as Location from 'expo-location';
import { readTokenState } from '../api';
import { netDown, subscribeNetHealth } from '../netHealth';
import { getCarState, setCarState, subscribeCarState } from './carStore';
import { startForegroundCarFeed } from '../navNotification';
import { permissionPromptBusy } from '../permissionGate';
import { logEventReliable } from '../crashBreadcrumb';
import { lockHint } from '../lockHint';
import { decideCarStatus } from './carStatusRule';

/** Same strings as the acquireBgLocation consumer tags. */
export type CarSurfaceTag = 'carplay' | 'androidauto';

const REFRESH_MIN_MS = 2_000;
const TICK_REFRESH_MS = 15_000;
// How long a car-initiated ask counts as outstanding. The promise may NEVER settle (a dialog the
// driver never answers, a host that never delivers the result) — this is the only way out, and it
// is compared against Date.now(), never waited on.
const ASK_PENDING_MS = 90_000;
// HYPOTHESIS (review correction 2, 2026-09-14): a denial that comes back this fast with nothing
// approved was answered by the OS, not the driver — Android 11+ stops showing the dialog after
// repeated denials (https://developer.android.com/training/permissions/requesting), and
// CarAppPermissionActivity returns straight through registerForActivityResult (javap of
// androidx.car.app 1.4.0-beta02). The `aa-perm op=result ms=` receipt is what tunes this.
const ASK_AUTO_DENY_MS = 1_500;
// Per CONNECT, not per process (review correction 7a): the phone process outlives many car
// sessions, and a process-wide cap would leave every later drive receipt-blind.
const STATUS_ROWS_MAX = 24;
// aa-perm rows get their OWN per-connect budget, so a driver tapping "Allow location" over and over
// cannot use up the car-status transition receipts.
const PERM_ROWS_MAX = 16;
const LOCATION_PERMS = ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'];
const MIC_PERMS = ['android.permission.RECORD_AUDIO'];

let _surface: CarSurfaceTag | null = null;
let _unsubStore: (() => void) | null = null;
let _unsubNet: (() => void) | null = null;
let _appStateSub: { remove: () => void } | null = null;
let _inflight: Promise<void> | null = null;
let _rerun = false;
let _lastRefreshAt = 0;
let _lastTickAt = 0;
let _hadFix = false;
let _askPendingUntil = 0;
let _deniedThisSession = false;
let _blockedThisSession = false;
// Request token (review correction 2): a first ask that hangs past ASK_PENDING_MS must not land
// its late result in the middle of a second one. Bumped on every ask AND on stop.
let _askSeq = 0;
let _rows = 0;
let _permRows = 0;

function row(msg: string): void {
  if (_rows >= STATUS_ROWS_MAX) return;
  _rows += 1;
  try { logEventReliable(msg); } catch {}
}

function permRow(msg: string): void {
  if (_permRows >= PERM_ROWS_MAX) return;
  _permRows += 1;
  try { logEventReliable(msg); } catch {}
}

function carBridge(): any {
  return (NativeModules as any).RNCarPlay ?? null;
}

/** Android Auto build 79+: the car can raise a runtime-permission ask (the dialog is on the phone). */
export function canRequestFromCar(): boolean {
  if (Platform.OS !== 'android') return false;
  const b = carBridge();
  return !!b && typeof b.requestPermissions === 'function';
}

function hasFixNow(): boolean {
  const s = getCarState();
  return typeof s.selfLat === 'number' && typeof s.selfLng === 'number';
}

export function startCarStatus(surface: CarSurfaceTag): void {
  if (!_surface) { _rows = 0; _permRows = 0; }   // a new connect gets a fresh receipt budget
  _surface = surface;
  _hadFix = hasFixNow();
  if (!_unsubStore) {
    _unsubStore = subscribeCarState((s) => {
      if (!_surface) return;
      const fix = typeof s.selfLat === 'number' && typeof s.selfLng === 'number';
      if (fix !== _hadFix) { _hadFix = fix; void refreshCarStatus('fix', true); return; }
      const now = Date.now();
      if (now - _lastTickAt >= TICK_REFRESH_MS) { _lastTickAt = now; void refreshCarStatus('tick'); }
    });
  }
  if (!_unsubNet) _unsubNet = subscribeNetHealth(() => { if (_surface) void refreshCarStatus('net', true); });
  if (!_appStateSub) {
    try {
      _appStateSub = AppState.addEventListener('change', () => { if (_surface) void refreshCarStatus('appstate', true); });
    } catch {}
  }
  void refreshCarStatus('connect', true);
}

export function stopCarStatus(): void {
  _surface = null;
  try { _unsubStore?.(); } catch {}
  _unsubStore = null;
  try { _unsubNet?.(); } catch {}
  _unsubNet = null;
  try { _appStateSub?.remove(); } catch {}
  _appStateSub = null;
  _askPendingUntil = 0;
  _deniedThisSession = false;
  _blockedThisSession = false;
  _askSeq += 1;   // invalidates an ask still outstanding from this session
  try { setCarState({ carStatus: undefined, carAskUntil: undefined }); } catch {}
}

export function refreshCarStatus(why: string, force = false): Promise<void> {
  if (!_surface) return Promise.resolve();
  if (_inflight) { if (force) _rerun = true; return _inflight; }
  const now = Date.now();
  if (!force && now - _lastRefreshAt < REFRESH_MIN_MS) return Promise.resolve();
  _lastRefreshAt = now;
  const run = (async () => {
    let servicesOn: boolean | null = null;
    let perm: { granted: boolean; status: string } | null = null;
    try { servicesOn = await Location.hasServicesEnabledAsync(); } catch {}
    try {
      const p = await Location.getForegroundPermissionsAsync();
      perm = { granted: !!p.granted, status: String(p.status) };
    } catch {}
    const tok = await readTokenState();
    const surface = _surface;
    if (!surface) return;
    const t = Date.now();
    const down = netDown(t);
    const fix = hasFixNow();
    const code = decideCarStatus({
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      servicesOn,
      fgGranted: perm ? perm.granted : null,
      carCanRequest: canRequestFromCar(),
      askPendingUntil: _askPendingUntil,
      deniedThisSession: _deniedThisSession,
      blocked: _blockedThisSession,
      token: tok.state,
      netDown: down,
      hasFix: fix,
      now: t,
    });
    const prev = getCarState().carStatus;
    if (prev === code) return;
    setCarState({ carStatus: code });
    // Location just became usable. Restart ONLY the non-prompting foreground watch — it is
    // idempotent and returns without a grant (navNotification.ts startForegroundCarFeed).
    // ⚠ NOT acquireBgLocation (review correction 1, 2026-09-14): with foreground granted it calls
    // requestBackgroundPermissionsAsync, which on iOS chains the "Change to Always Allow" sheet
    // straight after the While-Using one, past permissionGate's serialization and
    // askAlwaysLocationOnce's one-time flag; and on Android expo's PermissionsService marks the
    // permission as ASKED before it looks for an Activity (PermissionsService.kt:255-270), so a
    // car-side call can poison the phone's one background ask with no dialog ever shown.
    // The consumer is already held since connect, so the stall watchdog (STALL_MS 25 s, checked
    // every 10 s) and the AppState 'active' heal rebuild the background task whenever JS timers
    // run. This restart only removes that latency when timers are starved (locked iOS,
    // backgrounded Android Auto).
    const blocked = (c: string | undefined) => !!c && c.startsWith('loc-');
    if (blocked(prev) && !blocked(code) && _surface) void startForegroundCarFeed();
    let bg = '?';
    try { bg = String((await Location.getBackgroundPermissionsAsync()).status); } catch {}   // a status READ — never prompts
    row(
      `car-status to=${code} from=${prev ?? '-'} why=${why} surf=${surface} fix=${fix ? 1 : 0}`
      + ` svc=${servicesOn == null ? '?' : servicesOn ? 1 : 0} perm=${perm?.status ?? '?'} bg=${bg}`
      + ` app=${AppState.currentState} tok=${tok.state} net=${down ? 0 : 1} lock=${await lockHint()}`,
    );
  })()
    .catch(() => {})
    .then(() => {
      _inflight = null;
      if (_rerun) { _rerun = false; void refreshCarStatus('rerun', true); }
    });
  _inflight = run;
  return run;
}

async function askFromCar(perms: string[], kind: 'loc' | 'mic', why: string): Promise<{ ok: number; no: number; ms: number } | null> {
  const b = carBridge();
  if (Platform.OS !== 'android' || !b || typeof b.requestPermissions !== 'function') {
    permRow(`aa-perm op=unavailable kind=${kind}`);
    return null;
  }
  // Never stack a car-raised dialog on a phone-raised one (permissionGate serializes the phone's).
  if (permissionPromptBusy()) {
    permRow(`aa-perm op=skip kind=${kind} why=phone-prompt`);
    return null;
  }
  const started = Date.now();
  permRow(`aa-perm op=request kind=${kind} why=${why}`);
  try {
    const res: any = await b.requestPermissions(perms);   // may NEVER settle — no timer waits on it
    return {
      ok: Array.isArray(res?.approved) ? res.approved.length : 0,
      no: Array.isArray(res?.rejected) ? res.rejected.length : 0,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    permRow(`aa-perm op=err kind=${kind} code=${String(e?.code ?? '?').slice(0, 40)} msg=${String(e?.message ?? e).slice(0, 80)}`);
    return null;
  }
}

/** The Android Auto "Allow location" action. */
export async function requestLocationFromCar(why: string): Promise<void> {
  if (!_surface || !canRequestFromCar()) { void refreshCarStatus('perm-unavailable', true); return; }
  const now = Date.now();
  if (_askPendingUntil > now) return;   // one outstanding ask; its expiry is a timestamp
  _askPendingUntil = now + ASK_PENDING_MS;
  const seq = ++_askSeq;
  setCarState({ carAskUntil: _askPendingUntil });
  void refreshCarStatus('perm-request', true);
  const r = await askFromCar(LOCATION_PERMS, 'loc', why);
  if (seq !== _askSeq || !_surface) return;   // a newer ask, or a disconnect, owns the state now
  let fg = false;
  try { fg = !!(await Location.getForegroundPermissionsAsync()).granted; } catch {}
  if (r) permRow(`aa-perm op=result kind=loc ms=${r.ms} ok=${r.ok} no=${r.no} fg=${fg ? 1 : 0}`);
  _askPendingUntil = 0;
  if (r) {
    _deniedThisSession = !fg;
    _blockedThisSession = !fg && r.ok === 0 && r.ms < ASK_AUTO_DENY_MS;
  }
  setCarState({ carAskUntil: 0 });
  void refreshCarStatus('perm-result', true);
}

export type MicAskOutcome = 'blocked' | 'granted' | 'denied' | 'unavailable';

/**
 * Android Auto build 79+: ask for the mic from the car (the dialog is on the phone). Callers check
 * canRequestFromCar() first and must NOT await this for their on-screen reply — the promise can
 * take as long as the driver does, or never settle. It resolves with how the ask ended so the
 * caller can correct the message (review correction 2c).
 */
export async function requestMicFromCar(why: string): Promise<MicAskOutcome> {
  if (!canRequestFromCar()) return 'unavailable';
  const r = await askFromCar(MIC_PERMS, 'mic', why);
  if (!r) return 'unavailable';
  permRow(`aa-perm op=result kind=mic ms=${r.ms} ok=${r.ok} no=${r.no}`);
  if (r.ok > 0) return 'granted';
  return r.ms < ASK_AUTO_DENY_MS ? 'blocked' : 'denied';
}
