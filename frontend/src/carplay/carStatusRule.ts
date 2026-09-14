// src/carplay/carStatusRule.ts — WHICH message the car screen shows. Pure: no imports, no RN,
// so tools/sim-qc/car_status_test.mts runs it unmodified under plain Node and holds every branch.
//
// ── WHY (build 79 car-screen messaging, 2026-09-14) ──────────────────────────────────────────
// Before this, a car session with no location permission sat on the Hairpin wordmark with no
// explanation: carPlayBootstrap.ts wrote `carDbg: 'seed:no-fg-perm'` and returned, and carDbg is
// only drawn with Settings → CarPlay debug on. A signed-out or storage-locked token made
// carDataService.connectWs return silently. The words live in carStatusCopy.ts; the inputs are
// gathered in carStatus.ts; this file only picks the condition.
//
// PRIORITY (first match wins): location off > no permission > signed out > storage locked >
// offline > finding > ok. Location first because without it nothing on the car screen works;
// a failed READ (null) never invents a message (R17 in the gate).
export type CarStatusCode =
  | 'ok'
  | 'finding'
  | 'loc-off'
  | 'loc-perm'
  | 'loc-perm-ask'
  | 'loc-perm-asking'
  | 'loc-perm-denied'
  | 'signed-out'
  | 'storage-locked'
  | 'offline';

export type CarStatusInputs = {
  platform: 'ios' | 'android';
  /** Location.hasServicesEnabledAsync — null when the read failed. */
  servicesOn: boolean | null;
  /** Foreground location permission granted — null when the read failed. */
  fgGranted: boolean | null;
  /** Android Auto build 79+: RNCarPlay.requestPermissions exists, so the car can raise the ask. */
  carCanRequest: boolean;
  /** Epoch ms until an outstanding car-initiated ask counts as pending (a timestamp, never a timer). */
  askPendingUntil: number;
  /** A car-initiated ask this connect came back without the grant. */
  deniedThisSession: boolean;
  /** Review correction 2 (2026-09-14): the ask came back denied with no dialog (Android 11+
   *  "don't ask again" — https://developer.android.com/training/permissions/requesting), so
   *  offering the button again would be a dead tap. */
  blocked: boolean;
  token: 'ok' | 'missing' | 'unreadable';
  netDown: boolean;
  hasFix: boolean;
  now: number;
};

export function decideCarStatus(i: CarStatusInputs): CarStatusCode {
  // With Location Services off, iOS ALSO reports the app's permission as denied — so this must
  // come first or the car would ask for a permission the driver already gave.
  if (i.servicesOn === false) return 'loc-off';
  if (i.fgGranted === false) {
    if (i.platform === 'android' && i.blocked) return 'loc-perm';
    if (i.platform === 'android' && i.carCanRequest) {
      if (i.askPendingUntil > i.now) return 'loc-perm-asking';
      return i.deniedThisSession ? 'loc-perm-denied' : 'loc-perm-ask';
    }
    return 'loc-perm';
  }
  if (i.token === 'missing') return 'signed-out';
  if (i.token === 'unreadable') return 'storage-locked';
  if (i.netDown) return 'offline';
  if (!i.hasFix) return 'finding';
  return 'ok';
}

/** Worth the live-map status pill: a persistent condition, not "all fine" or "still finding". */
export function isSlotStatus(c: CarStatusCode | undefined): boolean {
  return !!c && c !== 'ok' && c !== 'finding';
}

/** The Android Auto "Allow location" action belongs on the strip. */
export function isAskableStatus(c: CarStatusCode | undefined): boolean {
  return c === 'loc-perm-ask' || c === 'loc-perm-asking' || c === 'loc-perm-denied';
}
