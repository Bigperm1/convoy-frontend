// Test-only resolve hook for skin_unlock_test.mts: runs the REAL src/appSkin.ts, src/garageStore.ts and src/skinWave.ts,
// with settings / entitlements / tierTheme / motion / AsyncStorage stubbed, and extensionless imports resolved.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = new URL("./", import.meta.url);
const PKG = { "@react-native-async-storage/async-storage": "../garage/stubs/asyncStorage.mjs" };
const LOCAL = {
  settings: "stubs/settings.mjs",
  entitlements: "stubs/entitlements.mjs",
  tierTheme: "stubs/tierTheme.mjs",
  motion: "stubs/motion.mjs",
};
export async function resolve(specifier, context, next) {
  if (PKG[specifier]) return { url: new URL(PKG[specifier], here).href, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.includes("/frontend/src/")) {
    const base = specifier.split("/").pop();
    if (LOCAL[base]) return { url: new URL(LOCAL[base], here).href, shortCircuit: true };
    if (!/\.[a-z]+$/.test(base)) {
      for (const ext of [".ts", ".tsx"]) {
        const u = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
