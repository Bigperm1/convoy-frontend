// src/carplay/carStatusCopy.ts — THE EXACT WORDS the car screen may show, in ONE place.
//
// ✅ APPROVED PRODUCT COPY — Jeff, 2026-09-14: "wording is good". Any NEW or CHANGED string still needs
// his OK before it ships (memory preview-ux-before-shipping). Change wording HERE only —
// carStatus.ts, CarBootScreen.tsx, ConvoyCarPlay.tsx, carActions.ts and carComms.ts all read it
// from this file, and tools/sim-qc/car_status_test.mts checks every string against the two rules
// below. (The Siri replies are native Swift and cannot import this: plugins/scout-siri/ScoutIntents.swift.)
//
// ── RULE 1 — CarPlay (iOS): state the condition, never tell the driver to touch the phone ────────
// CarPlay Developer Guide (2026-06-08) p.4, guideline 2: "Never instruct people to pick up their
// iPhone to perform a task. If there is an error condition, such as a required log in, you can let
// them know about the condition so they can take action when safe. However, alerts or messages
// must not include wording that asks people to manipulate their iPhone."
//   https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf
// HIG: "Report errors in CarPlay, not on the connected iPhone."
//   https://developer.apple.com/design/human-interface-guidelines/carplay
// So no iOS string may mention the phone, Settings, unlocking or opening the app (gate C2).
//
// ── RULE 2 — Android Auto: the phone only in a permission ask, always with "when it's safe" ─────
// Car app quality guideline VI-1: "If the user must go to the phone screen—for example, to act on
// a permission request—then the app must display a message instructing the user to only look at
// their phone screen when it's safe to do so."
//   https://developer.android.com/docs/quality-guidelines/car-app-quality
// Build 79 can raise that ask FROM the car (CarPlayModule.requestPermissions), so AA copy may name
// the phone — but only in the ask states (gate C4), and the safety clause must END inside the first
// 48 characters (gate C7) so a truncated line on the 213x107 dp AA canvas can never cut exactly the
// words VI-1 requires (review correction 4, 2026-09-14).
import type { CarStatusCode } from './carStatusRule';

export type CarStatusCopy = { title: string; detail?: string; pill: string };

/** Android Auto build 79+: the ActionStrip title that replaces the 2D/3D icon while location is askable. */
export const CAR_ALLOW_LOCATION_TITLE = 'Allow location';

const NO_POSITION = "Hairpin can't show your position";
const ASK_DETAIL = `Tap ${CAR_ALLOW_LOCATION_TITLE}. When safe, check your phone`;

const SHARED: Partial<Record<CarStatusCode, CarStatusCopy>> = {
  finding: { title: 'Finding your location…', pill: 'Finding your location…' },
  'signed-out': { title: 'Not signed in', detail: 'Crew and hazards are unavailable', pill: 'Not signed in · crew & hazards off' },
  'storage-locked': { title: 'Account not available yet', detail: 'Crew and hazards will load when it is', pill: 'Account not available yet' },
  offline: { title: 'No connection', detail: 'Crew and hazards are paused', pill: 'No connection · crew & hazards paused' },
  'loc-perm': { title: 'Location access needed', detail: `${NO_POSITION} without it`, pill: 'Location access needed' },
};

const IOS: Partial<Record<CarStatusCode, CarStatusCopy>> = {
  'loc-off': { title: 'Location Services are off', detail: NO_POSITION, pill: 'Location Services are off' },
};

const ANDROID: Partial<Record<CarStatusCode, CarStatusCopy>> = {
  'loc-off': { title: 'Location is off', detail: NO_POSITION, pill: 'Location is off' },
  'loc-perm-ask': { title: 'Location access needed', detail: ASK_DETAIL, pill: `Location needed · tap ${CAR_ALLOW_LOCATION_TITLE}` },
  // The safety clause is in the TITLE here — the line least likely to be cut (review correction 4).
  'loc-perm-asking': { title: "Check your phone when it's safe", detail: 'Allow location there so Hairpin can show your position', pill: "Check your phone when it's safe" },
  'loc-perm-denied': { title: 'Location access is off', detail: ASK_DETAIL, pill: 'Location access is off for Hairpin' },
};

export function carStatusCopy(code: CarStatusCode | undefined, platform: 'ios' | 'android'): CarStatusCopy | null {
  if (!code || code === 'ok') return null;
  if (platform === 'ios') {
    // iOS has no car-side ask; the ask states can only reach here through a bug — say the plain condition.
    const c: CarStatusCode = code === 'loc-perm-ask' || code === 'loc-perm-asking' || code === 'loc-perm-denied' ? 'loc-perm' : code;
    return IOS[c] ?? SHARED[c] ?? null;
  }
  return ANDROID[code] ?? SHARED[code] ?? null;
}

// ── CAR COMMS (the push-to-talk map button) ───────────────────────────────────────────────────
// Was: "No comms channel — pick one on the phone" and "Allow the microphone on your phone first"
// (carComms.ts until 2026-09-14) — both break RULE 1 on CarPlay and RULE 2 on Android Auto.
//   no-channel  — no crew thread/community is active
//   mic-needed  — the mic was never asked ('undetermined'), so it is not "off" (review correction 3)
//   mic-off     — asked and not granted
//   mic-asking  — Android Auto build 79+ just raised the ask from the car (the dialog is on the phone)
export type CommsCopyKind = 'no-channel' | 'mic-needed' | 'mic-off' | 'mic-asking';

const COMMS: Record<CommsCopyKind, string> = {
  'no-channel': 'No crew channel selected',
  'mic-needed': 'Microphone access needed',
  'mic-off': 'Microphone access is off for Hairpin',
  'mic-asking': "Check your phone when it's safe to allow the mic",
};

export function commsCopy(kind: CommsCopyKind, platform: 'ios' | 'android'): string {
  // CarPlay cannot raise the ask from the car, so it never says "check your phone".
  if (platform === 'ios' && kind === 'mic-asking') return COMMS['mic-needed'];
  return COMMS[kind];
}

/** Every string this module can return — the gate walks it. */
export const ALL_COMMS_KINDS: CommsCopyKind[] = ['no-channel', 'mic-needed', 'mic-off', 'mic-asking'];
