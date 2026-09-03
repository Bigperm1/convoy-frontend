// ── BUILD NUMBERS (2026-09-03) ────────────────────────────────────────────────
// Two different questions, two different answers:
//
// releaseBuildNumber() — WHAT THE CREW SEES. One number for both platforms, by Jeff's
//   rule ("it will be too confusing if they are mismatched on the pill for android and
//   ios"). It is the iOS buildNumber from app.json by convention, and the rule that keeps
//   it honest is that iOS buildNumber and Android versionCode are cut TOGETHER at the same
//   number (CLAUDE.md). Build 75 is the one exception on record (Android re-cut as 76 after
//   Play rejected the first AAB) — the pill still says 75 on Android on purpose.
//
// nativeBuildNumber() — WHAT THE BINARY IS. For telemetry (the push roster) only, never
//   for display. `Constants.nativeBuildVersion` was REMOVED from expo-constants (SDK 54
//   CHANGELOG, PR #26329) and is undefined on both platforms, so this reads
//   expo-application's value (module present via expo-notifications; guarded) and falls
//   back to the running platform's own app.json number.
import { Platform } from "react-native";
import Constants from "expo-constants";

export function releaseBuildNumber(): string | undefined {
  const cfg: any = Constants.expoConfig;
  const v = cfg?.ios?.buildNumber ?? cfg?.android?.versionCode;
  return v == null || v === "" ? undefined : String(v);
}

export function nativeBuildNumber(): string | undefined {
  try {
    const app = require("expo-application");
    const v = app?.nativeBuildVersion;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && isFinite(v)) return String(v);
  } catch {}
  const cfg: any = Constants.expoConfig;
  const v = Platform.OS === "android" ? cfg?.android?.versionCode : cfg?.ios?.buildNumber;
  return v == null || v === "" ? undefined : String(v);
}
