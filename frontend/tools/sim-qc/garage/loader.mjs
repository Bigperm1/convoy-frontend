// Test-only resolve hook: stub the native / network edges of the garage modules, and let
// extensionless relative imports (Metro style) find their .ts file.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = new URL("./", import.meta.url);
const PKG = {
  "@react-native-async-storage/async-storage": "stubs/asyncStorage.mjs",
  "expo-file-system": "stubs/expoFileSystem.mjs",
};
// Local modules (by basename, imported from frontend/src) replaced by stubs.
const LOCAL = {
  api: "stubs/api.mjs",
  settings: "stubs/settings.mjs",
  supabase: "stubs/supabase.mjs",
  crashBreadcrumb: "stubs/crash.mjs",
  appSkin: "stubs/appSkin.mjs",
  entitlements: "stubs/entitlements.mjs",
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
