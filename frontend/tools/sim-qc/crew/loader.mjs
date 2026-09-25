// Test-only resolve hook for crew_online_test.mts: the REAL src/presenceHub.ts, src/convoyPresence.ts and
// src/carplay/carDataService.ts, with everything else they import stubbed (by module basename), and "react" replaced by a
// minimal hooks model (stubs/react.mjs) so useConvoyPresence runs under plain node.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const here = new URL("./", import.meta.url);
const LOCAL = {
  supabase: "stubs/supabase.mjs", settings: "stubs/settings.mjs",
  vehicleAssets: "stubs/vehicleAssets.mjs", crashBreadcrumb: "stubs/crashBreadcrumb.mjs",
  api: "stubs/api.mjs", netHealth: "stubs/netHealth.mjs", carStatus: "stubs/carStatus.mjs", garageStore: "stubs/garageStore.mjs",
  locationPrivacy: "stubs/locationPrivacy.mjs", carStore: "stubs/carStore.mjs",
};
export async function resolve(specifier, context, next) {
  if (specifier === "react" && context.parentURL?.includes("/frontend/src/")) {
    return { url: new URL("stubs/react.mjs", here).href, shortCircuit: true };
  }
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
