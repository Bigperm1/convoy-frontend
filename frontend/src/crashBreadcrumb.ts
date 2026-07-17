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
const MAX_QUEUE = 5;
const DELIVER_DELAY_MS = 8000;

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
};

function baseMeta() {
  let update_id: string | null = null;
  let runtime_version: string | null = null;
  let app_version: string | null = null;
  try {
    const U = require("expo-updates");
    update_id = U.updateId ?? null;
    runtime_version = U.runtimeVersion ?? null;
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
let installed = false;
export function installCrashBreadcrumb() {
  if (installed) return;
  installed = true;
  try {
    const EU = (global as any).ErrorUtils;
    if (!EU?.setGlobalHandler) return;
    const prev = EU.getGlobalHandler?.();
    EU.setGlobalHandler((error: any, isFatal?: boolean) => {
      try {
        if (isFatal) {
          void queue([{
            message: String(error?.message ?? error).slice(0, 2000),
            stack: String(error?.stack ?? "").slice(0, 12000),
            is_fatal: true,
            late: false,
            ...baseMeta(),
          }]);
        }
      } catch {}
      prev?.(error, isFatal);
    });
  } catch {}
  // Delivery + harvest happen well after boot so this never competes with
  // startup work (and never runs at module scope — a crash reporter must not
  // itself be able to crash the boot).
  setTimeout(() => { void deliverAndHarvest(); }, DELIVER_DELAY_MS);
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
    const fresh = entries.filter((e) =>
      e && e.timestamp > watermark && /jsruntimeerror|fatal/i.test(String(e.code ?? "")));
    if (!fresh.length) return;
    await queue(fresh.map((e): Report => ({
      message: `[updates-log ${e.code}] ${String(e.message ?? "").slice(0, 2000)}`,
      stack: e.stacktrace ? String((Array.isArray(e.stacktrace) ? e.stacktrace.join("\n") : e.stacktrace)).slice(0, 12000) : undefined,
      is_fatal: true,
      late: true,
      ...baseMeta(),
    })));
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
