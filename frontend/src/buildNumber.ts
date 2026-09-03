// ── NATIVE BUILD NUMBER (2026-09-03) ─────────────────────────────────────────
// `Constants.nativeBuildVersion` was REMOVED from expo-constants (SDK 54 CHANGELOG, PR #26329);
// it is `undefined` on both platforms, so every reader fell through to the iOS
// `buildNumber` — Android showed "v75" while running versionCode 76 (Say Phin, 09-03).
// expo-application still exposes the real one (ApplicationModule.kt Constant("nativeBuildVersion"))
// and ships in the binary via expo-notifications; the require is guarded so a binary without it
// falls back to the PLATFORM's own number from app.json, never the other platform's.
import { Platform } from "react-native";
import Constants from "expo-constants";
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
