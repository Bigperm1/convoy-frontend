// locationRuntime — the ONE JS owner of the build-79 expo-location patch surface
// (patches/expo-location+19.0.8.patch). Every native call is guarded (requireOptionalNativeModule + typeof), so on
// build 78 this module only logs what the stock API can read and changes nothing.
//
// WHY (2026-09-14, build 79 — Jeff: CarPlay / Android Auto must work like Apple Maps / Google Maps / Waze, and
// "Always" is a hard ask):
//  iOS — Apple documents CLBackgroundActivitySession (iOS 17) as what lets a When-In-Use app receive location in
//    the background. It is held while any surface holds the shared location lock (navNotification.ts
//    acquireBgLocation / releaseBgLocation). The SDK header says a NEW session "may only become active while the app
//    is foregrounded and in direct use"; whether a CarPlay-only launch counts is UNPROVEN — the iOS 18 diagnostic
//    `insufficientlyInUse` (`loc-bgsess diag inUse=`) plus the scene states (`ps=`/`cs=`) settle it on the first
//    While-Using drive. The Always prompt + CTA stay until those rows exist.
//  Android — stock expo-location refused EVERY location foreground-service start while no Activity was foregrounded
//    (LocationModule.kt:258, LocationTaskConsumer.kt:168): every car-started Android Auto session, whatever the grant.
//    The patch lets the OS decide while the 'androidauto' lock is held and records the outcome (`loc-fgs`).
//    Android's background-start exemptions do NOT include ACCESS_BACKGROUND_LOCATION, so a car-started session may
//    still be refused on "Allow all the time" — HYPOTHESIS, settled by `loc-fgs state=` from a DHU session.
import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Location from "expo-location";
import { logEventReliable } from "./crashBreadcrumb";

export type FgsStatus = {
  state: string; error?: string | null; at?: number; fg?: boolean; car?: boolean;
  fgNow?: boolean; carNow?: boolean; bgPerm?: boolean; sdk?: number;
};
type SessionStart = { available?: boolean; held?: boolean; created?: boolean; appState?: number; phoneScene?: number; carScene?: number };
type RuntimeState = {
  authorizationStatus?: number; accuracyAuthorization?: number; applicationState?: number; backgroundSession?: boolean;
  phoneScene?: number; carScene?: number;
};
type Native = {
  startBackgroundActivitySessionAsync?: () => Promise<SessionStart>;
  stopBackgroundActivitySessionAsync?: () => Promise<void>;
  getLocationRuntimeStateAsync?: () => Promise<RuntimeState>;
  setCarSessionLive?: (live: boolean) => void;
  getForegroundServiceStatusAsync?: () => Promise<FgsStatus>;
  addListener?: (event: string, fn: (e: any) => void) => { remove(): void };
};

let N: Native | null = null;
try { N = Platform.OS === "web" ? null : (requireOptionalNativeModule("ExpoLocation") as Native | null); } catch { N = null; }

// ── receipts budget ──
// Bounded: logEventReliable is a Supabase INSERT per row (the CarPlay GL retry storm lesson). The budget is per
// LOCK SESSION, not per JS runtime (review P7): the AA root never unmounts and processes live 11 h, so a
// per-runtime cap would leave every drive after the first with no loc-* rows. navNotification.ts resets it when the
// first consumer acquires an empty lock.
let rows = 0, stallRows = 0, errRows = 0;
function row(msg: string): void {
  if (rows >= 40) return;
  rows += 1;
  try { logEventReliable(msg); } catch {}
}
export function resetLocReceiptBudget(): void { rows = 0; stallRows = 0; errRows = 0; }

/** True only on a binary that carries the build-79 expo-location patch. */
export function hasLocationRuntimeNative(): boolean {
  if (Platform.OS === "ios") return typeof N?.startBackgroundActivitySessionAsync === "function";
  if (Platform.OS === "android") return typeof N?.setCarSessionLive === "function";
  return false;
}

// ── iOS: CLBackgroundActivitySession, refcounted by lock tag ──
const sessionTags = new Set<string>();
let sessionHeld = false;
let diagSub: { remove(): void } | null = null;
let lastDiag = "";
// How the held session was born (review C2): Apple — a session created while not in direct use may never activate.
// The PHONE scene state is recorded, not UIApplication.applicationState (review C7: 'active' includes the car scene).
let createdPhoneScene: number | null = null;
let lastInUse: 0 | 1 | null = null;

function ensureDiagListener(): void {
  if (diagSub || typeof N?.addListener !== "function") return;
  try {
    diagSub = N.addListener("Expo.backgroundActivitySessionDiagnostic", (d: any) => {
      lastInUse = d?.insufficientlyInUse ? 0 : 1;
      const s = `inUse=${d?.insufficientlyInUse ? 0 : 1} svc=${d?.serviceSessionRequired ? 1 : 0} denied=${d?.authorizationDenied ? 1 : 0} global=${d?.authorizationDeniedGlobally ? 1 : 0} restricted=${d?.authorizationRestricted ? 1 : 0} req=${d?.authorizationRequestInProgress ? 1 : 0}`;
      if (s === lastDiag) return;
      lastDiag = s;
      row(`loc-bgsess diag ${s} app=${AppState.currentState}`);
    });
  } catch { diagSub = null; }
}

export async function holdBgActivitySession(tag: string): Promise<void> {
  if (Platform.OS !== "ios" || typeof N?.startBackgroundActivitySessionAsync !== "function") return;
  sessionTags.add(tag);
  if (sessionHeld) return;
  try {
    ensureDiagListener();
    const r = await N.startBackgroundActivitySessionAsync();
    sessionHeld = !!r?.held;
    if (r?.created) createdPhoneScene = typeof r?.phoneScene === "number" ? r.phoneScene : null;
    row(`loc-bgsess op=start tag=${tag} avail=${r?.available ? 1 : 0} held=${r?.held ? 1 : 0} created=${r?.created ? 1 : 0} uiapp=${r?.appState ?? "?"} ps=${r?.phoneScene ?? "?"} cs=${r?.carScene ?? "?"} app=${AppState.currentState}`);
    if (sessionTags.size === 0) await releaseBgActivitySession("");   // every holder left while it was starting
  } catch (e) {
    row(`loc-bgsess op=start tag=${tag} err=${String(e).replace(/\s+/g, "_").slice(0, 80)}`);
  }
}

export async function releaseBgActivitySession(tag: string): Promise<void> {
  if (Platform.OS !== "ios" || typeof N?.stopBackgroundActivitySessionAsync !== "function") return;
  if (tag) sessionTags.delete(tag);
  if (sessionTags.size > 0 || !sessionHeld) return;
  sessionHeld = false;
  lastDiag = ""; createdPhoneScene = null; lastInUse = null;
  try { await N.stopBackgroundActivitySessionAsync(); row("loc-bgsess op=stop"); } catch {}
}

/** Dead-man zero-consumer branch: drop every tag and invalidate UNCONDITIONALLY (native stop is idempotent), so a
 * tag set that drifted from _locConsumers can never pin the session (review C2/C3). */
export async function dropBgActivitySession(source: string): Promise<void> {
  if (Platform.OS !== "ios" || typeof N?.stopBackgroundActivitySessionAsync !== "function") return;
  const was = sessionHeld;
  sessionTags.clear();
  sessionHeld = false;
  lastDiag = ""; createdPhoneScene = null; lastInUse = null;
  try { await N.stopBackgroundActivitySessionAsync(); if (was) row(`loc-bgsess op=stop src=${source}`); } catch {}
}

/** iOS: whether the held session reports itself in use (iOS 18 diagnostic). null = no session or no diagnostic yet. */
export function bgSessionInUse(): boolean | null {
  return sessionHeld ? (lastInUse == null ? null : lastInUse === 1) : null;
}

/** iOS: a session created while the phone was not in direct use may never activate (Apple header). Renew it the
 * first time the PHONE scene is foregroundActive. Deviation from review C2, on purpose: the gate is the phone scene
 * state, not AppState/UIApplication 'active' — the car scene alone makes UIApplication active (P8), and renewing
 * there would invalidate a session that may be active for one that may not be. */
export async function renewBgActivitySessionIfStale(): Promise<void> {
  if (Platform.OS !== "ios" || !sessionHeld || sessionTags.size === 0) return;
  if (createdPhoneScene === 0 && lastInUse !== 0) return;
  if (typeof N?.stopBackgroundActivitySessionAsync !== "function" || typeof N?.startBackgroundActivitySessionAsync !== "function"
    || typeof N?.getLocationRuntimeStateAsync !== "function") return;
  try {
    const st = await N.getLocationRuntimeStateAsync().catch(() => null);
    if (st?.phoneScene !== 0) return;
    if (!sessionHeld || sessionTags.size === 0) return;
    await N.stopBackgroundActivitySessionAsync();
    lastDiag = ""; lastInUse = null;
    const r = await N.startBackgroundActivitySessionAsync();
    sessionHeld = !!r?.held;
    createdPhoneScene = typeof r?.phoneScene === "number" ? r.phoneScene : null;
    row(`loc-bgsess op=renew held=${r?.held ? 1 : 0} uiapp=${r?.appState ?? "?"} ps=${r?.phoneScene ?? "?"} cs=${r?.carScene ?? "?"} app=${AppState.currentState}`);
    if (sessionTags.size === 0) await releaseBgActivitySession("");
  } catch (e) {
    // The stop may have landed before the throw: re-read the native truth so the refcount never claims a session
    // that does not exist (the next acquire would then skip creating one).
    try { const st = await N.getLocationRuntimeStateAsync?.(); sessionHeld = !!st?.backgroundSession; } catch { sessionHeld = false; }
    row(`loc-bgsess op=renew err=${String(e).replace(/\s+/g, "_").slice(0, 80)} held=${sessionHeld ? 1 : 0}`);
  }
}

// Relaunch shape (review C2, OUT OF SCOPE for build 79 — receipt only): after a jetsam/crash relaunch expo-task-manager
// restores NAV_TASK natively, but nothing re-creates the session "immediately upon launch in the background" as Apple
// requires, and the cold engine's zero-consumer state never acquires. This row counts how often that happens.
let relaunchNoted = false;
export function noteBgSessionRelaunchMissing(): void {
  if (relaunchNoted || Platform.OS !== "ios" || !hasLocationRuntimeNative() || sessionHeld) return;
  relaunchNoted = true;
  row(`loc-bgsess op=relaunch-missing app=${AppState.currentState}`);
}

// ── Android: car-session flag + FGS receipt ──
export function setCarLocationSessionLive(live: boolean): void {
  if (Platform.OS !== "android" || typeof N?.setCarSessionLive !== "function") return;
  try { N.setCarSessionLive(live); } catch {}
}

export async function readFgsStatus(): Promise<FgsStatus | null> {
  if (Platform.OS !== "android" || typeof N?.getForegroundServiceStatusAsync !== "function") return null;
  try { return await N.getForegroundServiceStatusAsync(); } catch { return null; }
}

export function fgsFailed(s: FgsStatus | null): boolean {
  return !!s && (s.state === "start-refused" || s.state === "fg-refused" || s.state === "skipped");
}

function fgsRow(tag: string, s: FgsStatus, fixAgeMs: number, at: string): void {
  row(`loc-fgs tag=${tag} at=${at} state=${s.state} fg=${s.fg ? 1 : 0} car=${s.car ? 1 : 0} fgNow=${s.fgNow ? 1 : 0} bgPerm=${s.bgPerm ? 1 : 0} sdk=${s.sdk ?? "?"} fixAge=${Math.round(fixAgeMs)} err=${String(s.error ?? "-").replace(/\s+/g, "_").slice(0, 100)}`);
}

/** Android: the FGS outcome lands asynchronously (onServiceConnected), so read it 3 s after a start — and again at
 * 30 s with the fix age (review C4): on SDK 31-33 a background-started location FGS runs WITHOUT location and never
 * throws, so `state=running sdk<34 fg=0 bgPerm=0` with fixAge>30000 is a no-location FGS. setTimeout is alive on
 * Android while an FGS or an Activity holds the process. */
export async function logFgsStatusSoon(tag: string, fixAgeMs: () => number): Promise<void> {
  if (Platform.OS !== "android" || typeof N?.getForegroundServiceStatusAsync !== "function") return;
  await new Promise((r) => setTimeout(r, 3000));
  const s = await readFgsStatus();
  if (s) fgsRow(tag, s, fixAgeMs(), "3s");
  await new Promise((r) => setTimeout(r, 27000));
  const s2 = await readFgsStatus();
  if (s2) fgsRow(tag, s2, fixAgeMs(), "30s");
}

// ── receipts (both platforms; work on build 78 with native=0) ──
export async function logLocRuntime(tag: string, started: boolean): Promise<void> {
  try {
    const fg = await Location.getForegroundPermissionsAsync().catch(() => null);
    const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
    let extra = "";
    if (Platform.OS === "ios" && typeof N?.getLocationRuntimeStateAsync === "function") {
      const s = await N.getLocationRuntimeStateAsync().catch(() => null);
      extra = ` auth=${s?.authorizationStatus ?? "?"} acc=${s?.accuracyAuthorization ?? "?"} uiapp=${s?.applicationState ?? "?"} sess=${s?.backgroundSession ? 1 : 0} ps=${s?.phoneScene ?? "?"} cs=${s?.carScene ?? "?"}`;
    }
    row(`loc-auth tag=${tag} plat=${Platform.OS} fg=${fg?.status ?? "?"} bg=${bg?.granted ? 1 : 0} started=${started ? 1 : 0} app=${AppState.currentState} native=${hasLocationRuntimeNative() ? 1 : 0}${extra}`);
  } catch {}
}

export function logStallDecision(allowed: boolean, bgGranted: boolean, nativeFgNow: boolean | null, sessionInUse: boolean | null): void {
  if (stallRows >= 12) return;
  stallRows += 1;
  try { logEventReliable(`loc-stall act=${allowed ? "rebuild" : "keep"} plat=${Platform.OS} app=${AppState.currentState} bg=${bgGranted ? 1 : 0} fgNow=${nativeFgNow == null ? "?" : nativeFgNow ? 1 : 0} sessInUse=${sessionInUse == null ? "?" : sessionInUse ? 1 : 0} native=${hasLocationRuntimeNative() ? 1 : 0}`); } catch {}
}

export function logLocStartError(e: unknown): void {
  if (errRows >= 10) return;
  errRows += 1;
  try { logEventReliable(`loc-start-err plat=${Platform.OS} app=${AppState.currentState} err=${String(e).replace(/\s+/g, "_").slice(0, 120)}`); } catch {}
}
