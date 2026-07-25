// permissionGate.ts — one queue for every OS permission prompt.
//
// WHY (Jeff, 2026-07-25): "the allow notifications like access to music/mic/location
// etc happen when you are on those pages. it seems like you get bombarded with the
// allows right when you login. maybe have them fire not right on top of each other."
//
// Two separate problems, and this file fixes the second one for good:
//
//  1. WHERE a prompt fires — that is per-call-site, and the call sites now ask on the
//     screen that actually needs the capability (location on the Map, mic on Comms,
//     Apple Music on Music, notifications on Comms where hails/messages land). Nothing
//     prompts from the app shell at login any more.
//
//  2. WHEN prompts fire relative to EACH OTHER. Even correctly-placed prompts can
//     collide: the Map mounts, Comms pre-warms, a tab switch lands, and iOS stacks the
//     dialogs — the user sees a wall of alerts and reflexively denies. Placement alone
//     cannot prevent that, because the call sites don't know about each other.
//
// So every prompt goes through `askPermission()`, which SERIALIZES them: one dialog in
// flight at a time, plus a breathing gap after each so the next sheet doesn't animate in
// on top of the last one's dismissal.
//
// IMPORTANT: only wrap the actual PROMPT. Reading a already-decided status, and any
// non-prompting work (e.g. reporting the device/push token), must NOT be queued — those
// are cheap, need no user input, and blocking them behind a dialog would stall startup.
// The helpers below make that the easy path: they check status first and return early
// without ever touching the queue when there is nothing to ask.

// Gap between consecutive prompts. Long enough that the previous sheet has finished
// dismissing (iOS animates ~0.3s) and the user registers it as a separate question,
// short enough that a first launch doesn't feel like it's stalling.
const PROMPT_GAP_MS = 900;

// The serialization chain. Each queued prompt appends to it, so N concurrent callers
// run strictly one after another. Never rejects — a throwing prompt is swallowed so one
// failure can't wedge the queue for everything behind it.
let chain: Promise<void> = Promise.resolve();
let inFlight = 0;

/** True while a prompt is on screen or its post-gap hasn't elapsed. */
export function permissionPromptBusy(): boolean {
  return inFlight > 0;
}

/**
 * Run `prompt` when no other permission dialog is on screen, then wait out a gap
 * before releasing the next one. Resolves with the prompt's value, or `fallback` if
 * it threw. Call this ONLY when you have already established that a prompt is needed.
 */
export function askPermission<T>(prompt: () => Promise<T>, fallback: T): Promise<T> {
  const run = chain.then(async () => {
    inFlight += 1;
    try {
      return await prompt();
    } catch {
      return fallback;
    } finally {
      await new Promise<void>((r) => setTimeout(r, PROMPT_GAP_MS));
      inFlight -= 1;
    }
  });
  // Keep the chain alive regardless of this link's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

/**
 * Ask for microphone access, but only if iOS/Android hasn't already decided.
 * Returns true when recording is permitted. Never prompts twice, never queues when
 * the answer is already known.
 */
export async function ensureMicPermission(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Audio } = require("expo-av");
    const perm = await Audio.getPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain || perm.status !== "undetermined") return !!perm.granted;
    const res = await askPermission(() => Audio.requestPermissionsAsync(), perm);
    return !!res?.granted;
  } catch {
    return false;
  }
}

/**
 * Ask for notification permission, but only on the very first launch (status still
 * "undetermined"). Later launches just read the saved status so the sheet never
 * reappears. Returns the final status string.
 */
export async function ensureNotificationPermission(): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Notifications = require("expo-notifications");
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "undetermined" || !perm.canAskAgain) return perm.status;
    const res = await askPermission(() => Notifications.requestPermissionsAsync(), perm);
    return res?.status ?? perm.status;
  } catch {
    return "undetermined";
  }
}

/**
 * Ask for foreground location. Same rule: only prompt when undetermined, and go
 * through the queue so it can't land on top of another sheet.
 */
export async function ensureLocationPermission(): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Location = require("expo-location");
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== "undetermined" || !perm.canAskAgain) return perm.status;
    const res = await askPermission(() => Location.requestForegroundPermissionsAsync(), perm);
    return res?.status ?? perm.status;
  } catch {
    return "undetermined";
  }
}
