// androidAutoCrashLog.ts — the phone-side half of the ANDROID AUTO BLACK BOX.
//
// WHY THIS EXISTS. When Android Auto fails, androidx shows its "encountered an
// unexpected error / Exit" card and the real Kotlin stack trace goes ONLY to logcat.
// Capturing that has meant `adb logcat` from a laptop — in the car, while connected to
// the head unit. Jeff, 2026-07-24: "I CANT HAVE A TESTER TAKING HIS COMPUTER TO THE CAR."
// Correct. So the app records its own failure instead.
//
// The native half (AACrashLog in CarPlayService.kt, wrapping the three car entry points:
// CarPlayService.onCreate, CarPlayService.onCreateSession, CarPlaySession.onCreateScreen
// and VirtualRenderer.MapPresentation.onCreate) appends the stack trace to
// `filesDir/aa_crash.txt` and RETHROWS unchanged — purely a recorder, no behaviour change.
// Android's `filesDir` is exactly what expo-file-system exposes as `documentDirectory`,
// so no new native module is needed to read it back.
//
// This half runs on every phone-app launch: if the file exists, upload it to crash_reports
// and delete it. The tester drives, sees the AA error, and later opens the app on the
// phone — that is the entire procedure.
//
// Fails silently and never blocks startup: a diagnostic that breaks the app is worse than
// no diagnostic.
import { Platform } from "react-native";
import { logEvent } from "./crashBreadcrumb";

const FILE_NAME = "aa_crash.txt";
// Supabase rows are cheap but not unlimited, and a stack trace is the useful part.
const MAX_CHARS = 12000;

// Read the file with whichever expo-file-system API this install actually has.
// Returns null when there is nothing to report.
//
// ⚠ THE BUG THIS EXISTS TO FIX (2026-07-25). The first version of this file did:
//
//     const FS = require("expo-file-system");
//     const dir = FS.documentDirectory;
//     if (!dir) return;                     // <-- returned EVERY launch
//
// On SDK 54 / expo-file-system 19 the package's MAIN entry exports only the new
// `Paths` / `File` / `Directory` classes. `documentDirectory`, `getInfoAsync`,
// `readAsStringAsync` and `deleteAsync` moved to `expo-file-system/legacy`. So
// `dir` was always undefined and the whole black box was a silent no-op — the
// native half wrote aa_crash.txt correctly, and nothing ever read it. Zero Android
// rows had EVER reached crash_reports. A tester ran the plug-in sequence and we
// got nothing back, which is the worst possible failure mode for a diagnostic.
//
// So: try the new API, fall back to legacy, and never assume one shape again.
async function readAndClear(): Promise<string | null> {
  // ── New API (SDK 54+) ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File, Paths } = require("expo-file-system");
    if (File && Paths?.document) {
      const f = new File(Paths.document, FILE_NAME);
      if (!f.exists) return null;
      const raw: string = await f.text();
      // Delete FIRST. If the upload fails we lose one report; if we deleted only
      // on success, a row that never uploads would be re-sent every launch.
      try { f.delete(); } catch {}
      return raw;
    }
  } catch {
    // fall through to legacy
  }

  // ── Legacy API (SDK ≤53, and still shipped alongside the new one) ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FS = require("expo-file-system/legacy");
    const dir = FS?.documentDirectory;
    if (!dir) return null;
    const uri = dir + FILE_NAME;
    const info = await FS.getInfoAsync(uri);
    if (!info?.exists) return null;
    const raw: string = await FS.readAsStringAsync(uri);
    try { await FS.deleteAsync(uri, { idempotent: true }); } catch {}
    return raw;
  } catch {
    return null;
  }
}

export async function flushAndroidAutoCrashLog(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const raw = await readAndClear();
    if (!raw) return;
    const body = raw.length > MAX_CHARS ? raw.slice(-MAX_CHARS) : raw;
    if (!body.trim()) return;
    logEvent("android-auto-failure\n" + body);
  } catch {
    // no expo-file-system, no permission, malformed file — never surface to the user
  }
}
