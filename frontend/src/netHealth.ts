// src/netHealth.ts — is the network actually down? Judged ONLY from requests that really ran.
//
// ── WHY (build 79 car-screen messaging, 2026-09-14) ──────────────────────────────────────────
// The car screen needs to say "No connection" when crew and hazards stop arriving, and there is
// no network-state module in this app to ask (package.json has no netinfo / expo-network —
// checked 2026-09-14). Rather than add a native dependency, this reads the outcome of the
// requests the app already makes: the axios response interceptor (src/api.ts) and the car
// WebSocket (src/carplay/carDataService.ts).
//
// What counts as "down" (all three, deliberately conservative — a false "No connection" on a
// head unit is worse than a late one):
//   - >= NET_DOWN_MIN_FAILS consecutive network failures with no success in between,
//   - spread over >= NET_DOWN_AFTER_MS since the first failure of that streak,
//   - and the failure is axios ERR_NETWORK ("no response arrived" —
//     node_modules/axios/lib/adapters/xhr.js:124). A TIMEOUT is never offline: the Render
//     backend cold-sleeps and its first request routinely times out (see formatErr in api.ts).
//     A response with ANY status (a 500, a 401) proves the network works.
// HYPOTHESIS, flagged in the design: ERR_NETWORK also comes from DNS/TLS failures and possibly
// from iOS withholding network on a locked phone, so "offline" can still be inaccurate. The
// `car-status ... net=` field on the receipt row is how the field data would show that.
//
// No imports, no timers: the state is a few timestamps, evaluated when asked. Pure enough for
// tools/sim-qc/car_status_test.mts to drive with explicit clocks.
export const NET_DOWN_AFTER_MS = 15_000;
export const NET_DOWN_MIN_FAILS = 2;

let _okAt = 0;
let _failAt = 0;
let _streakSince = 0;
let _streakFails = 0;
let _wasDown = false;
const _listeners = new Set<(down: boolean) => void>();

export type NetOutcome = 'reached' | 'timeout' | 'network' | 'other';

export function classifyAxiosError(e: any): NetOutcome {
  if (e?.response) return 'reached';
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  // Render cold start — never "offline" (see header).
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'timeout';
  if (code === 'ERR_NETWORK' || msg === 'Network Error') return 'network';
  return 'other';
}

export function netDown(now: number = Date.now()): boolean {
  return _streakFails >= NET_DOWN_MIN_FAILS && _failAt >= _okAt && now - _streakSince >= NET_DOWN_AFTER_MS;
}

function emitIfFlipped(now: number): void {
  const d = netDown(now);
  if (d === _wasDown) return;
  _wasDown = d;
  _listeners.forEach((l) => { try { l(d); } catch {} });
}

export function noteNetOk(now: number = Date.now()): void {
  _okAt = now;
  _streakSince = 0;
  _streakFails = 0;
  emitIfFlipped(now);
}

export function noteNetFail(now: number = Date.now()): void {
  _failAt = now;
  if (_streakFails === 0) _streakSince = now;
  _streakFails += 1;
  emitIfFlipped(now);
}

export function subscribeNetHealth(fn: (down: boolean) => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function __resetNetHealthForTest(): void {
  _okAt = 0; _failAt = 0; _streakSince = 0; _streakFails = 0; _wasDown = false;
  _listeners.clear();
}
