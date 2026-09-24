// Test-only resolve hook for map_view_lock_test.mts: the REAL src/mapViewMode.ts with settings and garageStore stubbed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = new URL("./", import.meta.url);
const LOCAL = { settings: "stubs/settings.mjs", garageStore: "stubs/garageStore.mjs" };
export async function resolve(specifier, context, next) {
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
