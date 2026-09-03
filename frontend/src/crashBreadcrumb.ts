// crashBreadcrumb.ts — capture fatal JS errors so tester crash logs stop being
// native-only shells (the 2026-07-17 Olaf crash: expo-updates ErrorRecovery
// rethrows the JS fatal, but Apple's .crash file shows only recovery frames).
//
// Two collectors, one delivery:
//  1. A global-handler wrap queues {message, stack} the moment a fatal fires.
//     expo-updates' recovery waits ~5s (remote-update check) before aborting,
//     which is enough for the AsyncStorage write to land.
//  2. On the NEXT launch we also harvest expo-updates' own persisted log
//     (Updates.readLogEntriesAsync) for JSRuntimeError entries — this catches
//     fatals our handler missed (e.g. bundle-load failures before install()).
// Queued reports are delivered to the Supabase `crash_reports` table
// (insert-only RLS) a few seconds after launch; until that table exists the
// insert fails quietly and reports stay queued (capped) for a later attempt.
import { Platform } from "react-native";

const QUEUE_KEY = "convoy.pendingCrashReports.v1";
const HARVEST_KEY = "convoy.crashLogHarvestedAt.v1";
// 5 -> 25. The updates-log harvest below can legitimately produce a dozen rows from one bad
// launch, and queue() keeps only the LAST MAX_QUEUE — so a cap of 5 silently threw away the
// earliest (and usually most explanatory) entries of exactly the incident being chased.
const MAX_QUEUE = 25;
// Per-launch ceiling on harvested updates-log rows, so a pathological log cannot flood.
const MAX_HARVEST = 12;
// 8000 -> 3000 (2026-07-23): a crash-looping device (Android login loop) dies
// before an 8s delayed delivery ever runs — which is why crash_reports had ZERO
// android rows across an entire week of Android crashes. 3s still keeps delivery
// out of the boot-critical window.
const DELIVER_DELAY_MS = 3000;

// ── ONE ID PER JS CONTEXT (2026-08-12) ───────────────────────────────────────
// Generated at module load, so it is constant for the life of a JS context and
// DIFFERENT for any other context in the same app.
//
// Why it exists: the CarPlay zoom buttons vanished, and the telemetry could not settle
// whether the car surface was (a) a second JS context running a different bundle or
// (b) one context remounting. Those have completely different fixes, and every argument
// from the existing data was ambiguous:
//   - Two different update_ids appeared in one window, which looked like two contexts —
//     but `created_at` is the SERVER insert time, and logEvent fires an async insert, so a
//     patchy mobile connection reorders rows across a relaunch and fakes exactly that.
//   - Identical car-probe rows appeared milliseconds apart despite a per-route dedupe ref,
//     which looked like two mounts — but a deliberate GL-failure remount (see the
//     liveAttempt key in ConvoyCarPlay) resets that ref and re-logs too.
// With an instance id both become one query: two ids overlapping in event_at = two
// contexts; one id logging twice = a remount. No inference required.
let currentHandle: string | null = null;
/** AuthProvider calls this whenever the user changes; every later row carries it. */
export function setBreadcrumbHandle(h: string | null | undefined): void {
  currentHandle = h ? String(h).slice(0, 64) : null;
}

const INSTANCE_ID = (() => {
  try {
    return Math.random().toString(36).slice(2, 8) + "-" + String(Date.now()).slice(-6);
  } catch { return "unknown"; }
})();

type Report = {
  message: string;
  stack?: string;
  is_fatal: boolean;
  late: boolean;
  platform: string;
  os_version: string;
  app_version?: string | null;
  runtime_version?: string | null;
  update_id?: string | null;
  // Added 2026-08-11 with matching nullable columns on crash_reports. A row with
  // launch_kind "emergency" means expo-updates failed to launch an update and ran the
  // embedded JS — which is invisible if you only record update_id.
  launch_kind?: string | null;
  emergency_reason?: string | null;
  channel?: string | null;
  instance_id?: string | null;
  // Signed-in handle (2026-08-21). instance_id is random per JS reload, so without
  // this a tester's report could not be pulled by name — it took an hour on 8/21 to
  // narrow one drive to "one of two users". Set by AuthProvider; null before login.
  handle?: string | null;
  // Client-side event time. created_at is the SERVER insert time and a slow connection
  // can delay it by minutes, so ordering must never be argued from created_at again.
  event_at?: string | null;
};

// ── WHY update_id ALONE COULD NOT ANSWER "WHICH BUNDLE IS RUNNING" (2026-08-11) ──
// A tester lost the CarPlay zoom buttons mid-day. Telemetry showed update_id flipping to
// NULL for a whole drive, and null was read as "running the embedded bundle". It does not
// mean that. expo-updates sets the id from the LAUNCHED UPDATE, and an embedded launch has
// one too — AppController.swift assigns `mutableMap["updateId"]` for any non-nil
// launchedUpdate, and reports embedded-ness separately as
//   isEmbeddedLaunch = embeddedUpdate != nil && embeddedUpdate.updateId == launchedUpdate.updateId
// So a normal embedded launch reports a real UUID. update_id is null only when there is NO
// launched update at all: updates disabled, a dev environment, or an EMERGENCY LAUNCH,
// where expo-updates failed during launch and ran the embedded JS without an update record.
//
// Those cases need completely different fixes, and we were throwing away every field that
// tells them apart — while `runtime_version`, read from the same object two lines down,
// came through fine, which is what proves the module itself was working.
//
// Nothing here can prompt, block, or throw: these are plain constants captured at launch.
function baseMeta() {
  let update_id: string | null = null;
  let runtime_version: string | null = null;
  let app_version: string | null = null;
  let launch_kind: string | null = null;
  let emergency_reason: string | null = null;
  let channel: string | null = null;
  try {
    const U = require("expo-updates");
    update_id = U.updateId ?? null;
    runtime_version = U.runtimeVersion ?? null;
    // One field, so a single glance at a row says which of the three worlds we are in.
    launch_kind = U.isEmergencyLaunch ? "emergency"
      : U.isEmbeddedLaunch ? "embedded"
      : U.isEnabled === false ? "updates-disabled"
      : update_id ? "ota" : "unknown";
    if (U.isEmergencyLaunch && U.emergencyLaunchReason) {
      emergency_reason = String(U.emergencyLaunchReason).slice(0, 500);
    }
    channel = U.channel ?? null;
  } catch {}
  try {
    app_version = require("expo-constants").default?.expoConfig?.version ?? null;
  } catch {}
  return {
    platform: Platform.OS,
    os_version: String(Platform.Version),
    app_version,
    runtime_version,
    update_id,
    launch_kind,
    emergency_reason,
    channel,
    instance_id: INSTANCE_ID,
    handle: currentHandle,
    event_at: new Date().toISOString(),
  };
}

async function queue(reports: Report[]) {
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const cur: Report[] = raw ? JSON.parse(raw) : [];
    const next = [...cur, ...reports].slice(-MAX_QUEUE);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch {}
}

// 1) Fatal-handler wrap. Installed once from the app entry; chains the previous
// handler so RN/expo-updates recovery behavior is untouched.
// ── BUNDLE MARK ─────────────────────────────────────────────────────────────
// WHY (2026-08-13): we could not tell which JS was actually running, and it cost a
// whole day of wrong conclusions.
//
// On a CarPlay-FIRST cold launch the RN host can be created before expo-updates has
// resolved a launcher: withConvoyCarPlay's car branch calls superView(), which bypasses
// the updates react-delegate, and the host then asks for a bundle URL while
// AppController.launchAssetUrl() is still nil — so it falls through to
// [super bundleURL] = the EMBEDDED main.jsbundle. Expo's only guard against this is a
// Swift `assert`, which is compiled out under -O in Release.
//
// The process then runs OLD embedded JS while NATIVE still reports the OTA. So
// `update_id`, `launch_kind` and the on-screen version pill ALL say "ota" — every
// instrument we had measures native's INTENT, not the bundle being evaluated. That is
// how a device provably "on the OTA" drew peers with a CircleLayer that only exists in
// the embedded bundle (Jeff's green dot, 2026-08-13).
//
// This row is the missing instrument, and it works by PRESENCE, not by content:
//   • row present  → the bundle containing THIS code is the one running.
//   • row ABSENT, while the session's columns say launch_kind='ota'
//                  → that process is pinned to an older/embedded bundle.
// An old bundle cannot report on itself; its silence is the signal. So the row must
// never be lost for a boring reason — hence the queue fallback in logBundleMark below.
// A false "absent" would send the next session chasing a bug that isn't there.
//
// The stamp follows this repo's standing hardcoded-fallback pattern (see api.ts /
// supabase.ts): EAS has historically failed to inject env vars at bundle time, so a
// literal backs it up. If the env var is missing we still get a row, and the row's
// PRESENCE is the primary signal — the stamp only adds "which publish".
const SRC_MARK = "0813a";
const JS_BUNDLE_MARK = process.env.EXPO_PUBLIC_JS_MARK || SRC_MARK;
let markLogged = false;

/**
 * Emit the once-per-JS-context bundle mark. Safe to call more than once.
 * Sends immediately; falls back to the persisted queue (delivered `late` on a later
 * launch) if Supabase isn't constructed yet — losing this row would read as "pinned".
 */
export function logBundleMark(): void {
  if (markLogged) return;
  markLogged = true;
  try {
    // Native's own claim about the launch, recorded ALONGSIDE the source stamp so one
    // row carries both sides of the disagreement. `tag` is the same DD·HHMM the version
    // pill prints, so a row can be matched to what a tester photographed.
    let tag = "";
    try {
      const U = require("expo-updates");
      const ts = U.createdAt ? new Date(U.createdAt) : null;
      const p2 = (n: number) => String(n).padStart(2, "0");
      tag = U.isEmbeddedLaunch ? "emb"
        : ts ? `${p2(ts.getDate())}·${p2(ts.getHours())}${p2(ts.getMinutes())}` : "";
    } catch {}
    const report = {
      message: `js-mark src=${JS_BUNDLE_MARK} native_tag=${tag || "-"}`,
      is_fatal: false,
      late: false,
      ...baseMeta(),
    };
    const { supabase } = require("./supabase");
    if (!supabase) { void queue([report]); return; }
    void supabase.from("crash_reports").insert([report]).then(
      (res: any) => { if (res?.error) void queue([report]); },
      () => { void queue([report]); },
    );
  } catch {
    // Never let the instrument break the app it is instrumenting.
  }
}

// ── OTA REGRESSION DETECTOR (8/20) ───────────────────────────────────────────
// Jeff's drift drive vanished from telemetry and the NEXT launch ran an OLDER
// update than the previous one — the expo-updates ErrorRecovery-rollback
// fingerprint, observed only by manually decoding UUIDv7 timestamps. Make it
// self-announcing: remember the last update id (UUIDv7 = lexicographically
// chronological) and emit a RELIABLE row whenever a launch runs an older one.
export function logUpdateRegression(): void {
  try {
    const U = require("expo-updates");
    const cur: string = String(U.updateId || "");
    if (!cur || U.isEmbeddedLaunch) return; // embedded fallback is its own known story
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    void AsyncStorage.getItem("convoy.lastUpdateId").then((prev: string | null) => {
      if (prev && cur < prev) {
        try {
          const { logEventReliable } = require("./crashBreadcrumb");
          logEventReliable(`ota-regressed prev=${prev} now=${cur}`);
        } catch {}
      }
      void AsyncStorage.setItem("convoy.lastUpdateId", cur);
    });
  } catch {
    // instrument must never hurt the app
  }
}

let installed = false;
// ── NON-FATAL EVENT LOG ──────────────────────────────────────────────────────
// Fire-and-forget row into the same crash_reports table with is_fatal:false.
// Built 2026-07-24 for the CarPlay "buttons not working" report, which has now
// survived three plausible-but-unverifiable theories. The one thing no amount of
// code-reading can settle is whether a tap REACHES JS at all: if it does, the bug
// is in our action; if it does not, the tap dies in the native template layer and
// no OTA can fix it. Every CarPlay button press logs one row, so the next drive
// answers that question with data instead of another hypothesis. Never throws and
// never blocks the caller's action.
export function logEvent(message: string): void {
  try {
    const { supabase } = require("./supabase");
    if (!supabase) return;
    void supabase.from("crash_reports")
      .insert([{ message, is_fatal: false, late: false, ...baseMeta() }])
      .then(() => {}, () => {});
  } catch {}
}

/**
 * logEvent that cannot be lost for a boring reason. Plain logEvent DROPS the row when
 * the Supabase client is not constructed yet (`if (!supabase) return`) — which is the
 * normal state while app-root bootstraps run, i.e. exactly when a CarPlay-first cold
 * launch executes carPlayBootstrap. For an instrument whose ABSENCE is read as a
 * signal, that silent drop makes absence lie ("the code never ran" vs "it ran too
 * early to report"). Same fallback as logBundleMark: on a missing client or a failed
 * insert, persist to the crash queue and deliver `late` on a later launch.
 * Use for receipts/bails whose absence will be interpreted; keep plain logEvent for
 * high-volume breadcrumbs where losing one row is meaningless.
 */
/**
 * Awaitable twin of logEventReliable for the one caller that must know the row is
 * on the server BEFORE it destroys the queue the fallback would use: Reset app data.
 * Resolves when the insert settles (never rejects); queueOnFail=false drops the row
 * rather than writing it into a store that is about to be wiped.
 */
export async function logEventReliableAsync(message: string, queueOnFail = true): Promise<void> {
  try {
    const report = { message, is_fatal: false, late: false, ...baseMeta() };
    const { supabase } = require("./supabase");
    if (!supabase) { if (queueOnFail) await queue([report]); return; }
    const res: any = await supabase.from("crash_reports").insert([report]);
    if (res?.error && queueOnFail) await queue([report]);
  } catch {}
}

// Seed the handle from the cached profile at module load (2026-08-21 review): the
// AuthProvider effect only runs once /auth/me answers, so boot rows, Android Auto
// cold-connect rows and headless contexts — the ones you most want by name — would
// stay null. Reads the key directly; importing auth.tsx here would pull the Google
// sign-in native module into the headless car context.
(() => {
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    void AsyncStorage.getItem("convoy_user").then((raw: string | null) => {
      try {
        const u = raw ? JSON.parse(raw) : null;
        if (currentHandle == null && u && typeof u.handle === "string" && u.handle) currentHandle = u.handle.slice(0, 64);
      } catch {}
    }, () => {});
  } catch {}
})();

export function logEventReliable(message: string): void {
  try {
    const report = { message, is_fatal: false, late: false, ...baseMeta() };
    const { supabase } = require("./supabase");
    if (!supabase) { void queue([report]); return; }
    void supabase.from("crash_reports").insert([report]).then(
      (res: any) => { if (res?.error) void queue([report]); },
      () => { void queue([report]); },
    );
  } catch {}
}

export function installCrashBreadcrumb() {
  if (installed) return;
  installed = true;
  try {
    const EU = (global as any).ErrorUtils;
    if (!EU?.setGlobalHandler) return;
    const prev = EU.getGlobalHandler?.();
    EU.setGlobalHandler((error: any, isFatal?: boolean) => {
      const msg = String(error?.message ?? error);
      // SAFETY NET (2026-07-18): the supabase Realtime "cannot add `presence`
      // callbacks ... after `subscribe()`" double-join race is GENUINELY benign —
      // it only means presence didn't attach on this device — yet it was reaching
      // the global handler as a FATAL (escaping the per-call-site try/catch via a
      // render-path/race) and killing the app for the whole crew. It must NEVER be
      // fatal. Swallow it here (log a breadcrumb, do NOT propagate to the default
      // handler / expo-updates ErrorRecovery). Every OTHER error passes through
      // untouched. This backstops both call sites no matter which race fires.
      const benignRealtime = /cannot add `?(?:presence|postgres_changes|broadcast|system)`? callbacks/i.test(msg);
      // SAFETY NET #2 (2026-07-31): `new NativeEventEmitter()` requires a non-null
      // argument. Jeff: "I click on Spotify and it crashes" — and it kept crashing
      // across three fixes because this is not one bug, it is a CLASS of bug.
      //
      // Several libraries construct a NativeEventEmitter at MODULE SCOPE against a
      // native module they never null-check — in this bundle alone: @rnmapbox's
      // RNMBXLocationModule and RNMBXOfflineModule (both module scope), plus
      // RNMBXLogging, RNCarPlay and MusicKit inside constructors. If any of those
      // modules is absent in the JS context doing the import — a headless background
      // task, a CarPlay/car-session context, a partially-initialised bridge — the
      // IMPORT ITSELF throws, uncaught, before any of our code runs.
      //
      // It is never a logic error and never actionable at the throw site: it means
      // "this native module is not registered here". The correct behaviour is to lose
      // that one feature, not the app — and critically NOT to reach expo-updates'
      // ErrorRecovery, which treats it as a bad bundle and ROLLS BACK, stranding the
      // user on old JS. That rollback is what made this look unfixable: each fix
      // shipped fine and the crash loop kept reverting the device off it.
      //
      // Swallow it and record the STACK, which names the module (the frame above the
      // emitter is the requiring package), so the specific offender can be guarded.
      const nativeEmitterNull = /NativeEventEmitter.*non-null argument|Native module cannot be null/i.test(msg);
      if (nativeEmitterNull) {
        try {
          void queue([{
            message: "SWALLOWED native-emitter-null: " + msg.slice(0, 400),
            stack: String(error?.stack ?? "").slice(0, 4000),
            is_fatal: false, late: false, ...baseMeta(),
          }]);
        } catch {}
        return; // app survives — do NOT propagate to ErrorRecovery
      }
      if (benignRealtime) {
        try {
          void queue([{
            message: "SWALLOWED benign-realtime: " + msg.slice(0, 1500),
            stack: String(error?.stack ?? "").slice(0, 4000),
            is_fatal: false, late: false, ...baseMeta(),
          }]);
        } catch {}
        return; // app survives — do not call prev()
      }
      try {
        if (isFatal) {
          const report: Report = {
            message: msg.slice(0, 2000),
            stack: String(error?.stack ?? "").slice(0, 12000),
            is_fatal: true,
            late: false,
            ...baseMeta(),
          };
          void queue([report]);
          // ALSO deliver right now, fire-and-forget: expo-updates' recovery holds
          // the process a few seconds on iOS, and even on Android the insert often
          // wins the race against process death. The queued copy stays as backup;
          // the near-duplicate on success is a price worth paying for visibility
          // (2026-07-23: an entire week of Android crashes produced ZERO rows
          // because delivery only ran 8s after a SUCCESSFUL launch).
          try {
            const { supabase } = require("./supabase");
            if (supabase) void supabase.from("crash_reports").insert([{ ...report }]);
          } catch {}
        }
      } catch {}
      prev?.(error, isFatal);
    });
  } catch {}
  // Delivery + harvest happen well after boot so this never competes with
  // startup work (and never runs at module scope — a crash reporter must not
  // itself be able to crash the boot).
  setTimeout(() => { void deliverAndHarvest(); reportCarPlayHostCeiling(); }, DELIVER_DELAY_MS);
}

// BUILD 75 — the CarPlay host plugin (plugins/withConvoyCarPlay.js) writes a marker to
// the App Group defaults when a cold CarPlay connect waits past its host ceiling. That
// launch may be running stale JS or none at all, so it cannot report itself; THIS launch
// reports it, then clears it. Absent on binaries before 75 (getSharedDefaults missing).
const CARPLAY_DIAG_SUITE = "group.com.sw0rdfisch.convoy";
const CARPLAY_DIAG_KEY = "convoy.carplay.hostCeiling.v1";
function reportCarPlayHostCeiling(): void {
  if (Platform.OS !== "ios") return;
  try {
    const { HairpinSystem } = require("../modules/hairpin-system");
    if (!HairpinSystem || typeof HairpinSystem.getSharedDefaults !== "function") return;
    const raw = HairpinSystem.getSharedDefaults(CARPLAY_DIAG_SUITE, CARPLAY_DIAG_KEY);
    if (!raw) return;
    let d: any = null;
    try { d = JSON.parse(String(raw)); } catch {}
    const age = d?.ts ? Math.round((Date.now() - Number(d.ts)) / 1000) : -1;
    logEventReliable(`carplay-host-ceiling ticks=${d?.ticks ?? "?"} hostReady=${d?.hostReady ? 1 : 0} scene=${d?.sceneState ?? "?"} ageS=${age}`);
    try { HairpinSystem.removeSharedDefaults?.(CARPLAY_DIAG_SUITE, CARPLAY_DIAG_KEY); } catch {}
  } catch {}
}

// 2) Harvest expo-updates' persisted JSRuntimeError entries (last 24h),
// watermarked so each entry is queued once.
async function harvestUpdatesLog() {
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    const U = require("expo-updates");
    if (typeof U.readLogEntriesAsync !== "function") return;
    const entries: any[] = (await U.readLogEntriesAsync(24 * 3600 * 1000)) ?? [];
    const watermark = Number((await AsyncStorage.getItem(HARVEST_KEY)) ?? 0);
    // ── WHY THIS NO LONGER FILTERS TO JS FATALS (2026-08-12) ──────────────────
    // It used to keep only /jsruntimeerror|fatal/, and that discarded the entire reason
    // this log is worth reading. Jeff's app keeps coming up on the EMBEDDED bundle — no
    // zoom buttons, no new telemetry, the version reading back as the bare runtime — and
    // every diagnostic I added was blind to it BY CONSTRUCTION, because those diagnostics
    // ship in an OTA and the failing launch runs pre-OTA JS. Instrumenting the failure from
    // inside the failure cannot work.
    //
    // But expo-updates keeps its OWN log natively, and it SURVIVES the launch. So a later
    // NORMAL launch — running current JS — can read why the PREVIOUS launch fell back.
    // The diagnostic no longer has to be present while the fault happens, which is the
    // whole knot. Every entry is kept now: the interesting codes here are things like
    // NoUpdatesAvailable, UpdateFailedToLoad, AssetsFailedToLoad and the emergency-launch
    // reason, none of which match the old filter.
    // OLDEST FIRST, capped — and the watermark advances only past what was actually
    // sent, so a backlog drains over successive launches instead of being skipped
    // forever (`.slice(-N)` + max-watermark used to drop everything older than the
    // newest N, permanently). The entry's own timestamp rides in the message so a row
    // can be attributed to the launch it describes, not the one that harvested it.
    const fresh = entries
      .filter((e) => e && Number(e.timestamp) > watermark)
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(0, MAX_HARVEST);
    if (!fresh.length) return;
    await queue(fresh.map((e): Report => {
      const code = String(e.code ?? "");
      return {
        message: `[updates-log ${code} @${Number(e.timestamp) || 0}] ${String(e.message ?? "").slice(0, 2000)}`,
        stack: e.stacktrace ? String((Array.isArray(e.stacktrace) ? e.stacktrace.join("\n") : e.stacktrace)).slice(0, 12000) : undefined,
        // Only a real JS fatal is a crash; the rest are launch diagnostics and must not
        // masquerade as crashes in the table.
        is_fatal: /jsruntimeerror|fatal/i.test(code),
        late: true,
        ...baseMeta(),
      };
    }));
    const newest = Math.max(...fresh.map((e) => Number(e.timestamp) || 0));
    await AsyncStorage.setItem(HARVEST_KEY, String(newest));
  } catch {}
}

async function deliverAndHarvest() {
  await harvestUpdatesLog();
  try {
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const pending: Report[] = raw ? JSON.parse(raw) : [];
    if (!pending.length) return;
    const { supabase } = require("./supabase");
    if (!supabase) return; // keep queued; try again next launch
    const { error } = await supabase.from("crash_reports").insert(
      pending.map((r) => ({ ...r, late: true })),
    );
    if (!error) await AsyncStorage.removeItem(QUEUE_KEY);
  } catch {}
}
