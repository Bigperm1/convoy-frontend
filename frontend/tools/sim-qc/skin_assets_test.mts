// skin_assets_test.mts — every app skin has every per-skin map image (2026-09-23).
//
// Jeff's CarPlay photo, 2026-09-23: the destination weather bubble showed a FLAG and "12°" in a GREEN rim while he wore
// Diamond ("it shows a flag … it is green around the border when it should be diamond"). Diamond was added to the skins
// on 2026-09-22 (ab782791) but tools/wx-pin/bake.py was never re-run for it, so wxCalloutUri('diamond', …) fell back to
// the green flag for every weather kind — while telemetry had the real forecast (wx-dest id=804 Overcast t=12). The phone's
// search-result pins had the same gap (neon_place_diamond never registered). This gate fails the next time a skin is
// added without its images.
//   C1 every VisualTier (src/tierTheme.ts) × every weather kind has a baked callout
//   C2 a skin with no bubbles keeps the WEATHER (green) — the flag only ever means "no forecast"
//   C3 every VisualTier has its neon_place_<tier> pin registered on the phone map (src/ConvoyMapbox.tsx)
// Run: node --experimental-strip-types tools/sim-qc/skin_assets_test.mts

import { readFileSync } from "node:fs";
import * as wx from "../../src/wxCalloutImages.ts";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

const theme = readFileSync(new URL("../../src/tierTheme.ts", import.meta.url), "utf8");
const union = /export type VisualTier\s*=\s*([^;]+);/.exec(theme)?.[1] ?? "";
const tiers = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
ok("C0 read the skins from tierTheme.ts", tiers.length >= 4 && tiers.includes("diamond"), tiers.join(","));

const missing: string[] = [];
for (const t of tiers) for (const k of wx.WX_CALLOUT_KINDS) if (!wx.WX_CALLOUT_B64[`${t}/${k}`]) missing.push(`${t}/${k}`);
ok("C1 every skin × weather kind has a baked callout (re-run tools/wx-pin/bake.py after adding a skin)", missing.length === 0, missing.join(" "));

const b64 = (uri: string) => uri.replace("data:image/png;base64,", "");
ok("C2 an unknown skin keeps the weather, not the flag",
  b64(wx.wxCalloutUri("no-such-skin", "cloudy")) === wx.WX_CALLOUT_B64["brand/cloudy"]
  && b64(wx.wxCalloutUri("no-such-skin", "cloudy")) !== wx.WX_CALLOUT_B64["brand/none"]);
ok("C2b Diamond's cloudy bubble is its own (not the green one)",
  b64(wx.wxCalloutUri("diamond", "cloudy")) === wx.WX_CALLOUT_B64["diamond/cloudy"]
  && wx.WX_CALLOUT_B64["diamond/cloudy"] !== wx.WX_CALLOUT_B64["brand/cloudy"]);

const mbx = readFileSync(new URL("../../src/ConvoyMapbox.tsx", import.meta.url), "utf8");
const noPin = tiers.filter((t) => !mbx.includes(`name="neon_place_${t}"`));
ok("C3 every skin's search-result pin (neon_place_<tier>) is registered on the phone map", noPin.length === 0, noPin.join(","));

console.log(failed ? `\nFAIL skin_assets (${failed})` : "\nPASS skin_assets");
process.exit(failed ? 1 : 0);
