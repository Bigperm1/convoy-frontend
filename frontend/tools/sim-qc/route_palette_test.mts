// route_palette_test.mts — the route-line colour choices stay tellable apart and never read as traffic (2026-09-23).
//
// Jeff, 2026-09-23: "in settings for the route line spectrum it doesnt really work... maybe had like 20 more
// selectable colours that dont overlap the current selection.. remove the spectrum". The spectrum is gone; twenty
// measured swatches replace it (app/(app)/settings/route-color.tsx). This gate re-measures them from the source, so
// the next swatch added can't quietly duplicate one, vanish on the day map, or look like the congestion colours drawn
// ON the route (mapboxDirections.ts CONGESTION_COLOR — DESIGN.md: a route line that reads as traffic is the one thing
// the route colour must never do).
//   R1 every MORE swatch is ≥ 10.5 ΔE2000 from every other swatch (presets included)
//   R2 every MORE swatch is ≥ 22 from each traffic colour (moderate / heavy / severe)
//   R3 every MORE swatch is ≥ 14 from the day map's land / park / roads / water / white (sampled 2026-09-23)
//   R4 there are 30 swatches, no duplicates, and the spectrum (locationX) is gone
// Run: node --experimental-strip-types tools/sim-qc/route_palette_test.mts

import { readFileSync } from "node:fs";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

const src = readFileSync(new URL("../../app/(app)/settings/route-color.tsx", import.meta.url), "utf8");
const block = (name: string) => {
  const m = new RegExp(`const ${name}: Swatch\\[\\] = \\[([\\s\\S]*?)\\];`).exec(src);
  return m ? [...m[1].matchAll(/name: "([^"]+)", hex: "(#[0-9A-Fa-f]{6})"/g)].map((x) => ({ name: x[1], hex: x[2] })) : [];
};
const PRESETS = block("PRESETS");
const MORE = block("MORE");
const dirs = readFileSync(new URL("../../src/mapboxDirections.ts", import.meta.url), "utf8");
const cong = /const CONGESTION_COLOR[^{]*\{([\s\S]*?)\};/.exec(dirs)?.[1] ?? "";
const TRAFFIC = ["moderate", "heavy", "severe"].map((k) => new RegExp(`${k}:\\s*"(#[0-9A-Fa-f]{6})"`).exec(cong)?.[1] ?? "");
const MAP = { land: "#F0EAD8", park: "#AEEAA8", road: "#A2A2C0", road2: "#BAC0D8", water: "#96D8FC", white: "#FCFCFC" };

// sRGB → CIELAB (D65) → CIEDE2000.
type Lab = [number, number, number];
function lab(hex: string): Lab {
  const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const rad = (d: number) => (d * Math.PI) / 180;
function de2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360, h2p = ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dth)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const all = [...PRESETS, ...MORE];
ok("R4 30 swatches (10 presets + 20 more), no duplicate hex",
  PRESETS.length === 10 && MORE.length === 20 && new Set(all.map((s) => s.hex.toLowerCase())).size === 30,
  `${PRESETS.length}+${MORE.length}`);
ok("R4b the spectrum is gone (no nativeEvent.locationX tap mapping)", !/nativeEvent\.locationX/.test(src));
ok("R4c read the three traffic colours", TRAFFIC.every((h) => /^#/.test(h)), TRAFFIC.join(","));

const close: string[] = [], traffic: string[] = [], hidden: string[] = [];
for (const s of MORE) {
  const l = lab(s.hex);
  for (const o of all) if (o !== s && de2000(l, lab(o.hex)) < 10.5) close.push(`${s.name}~${o.name} ${de2000(l, lab(o.hex)).toFixed(1)}`);
  for (const t of TRAFFIC) if (de2000(l, lab(t)) < 22) traffic.push(`${s.name}~${t} ${de2000(l, lab(t)).toFixed(1)}`);
  for (const [k, m] of Object.entries(MAP)) if (de2000(l, lab(m)) < 14) hidden.push(`${s.name}~${k} ${de2000(l, lab(m)).toFixed(1)}`);
}
ok("R1 every new swatch is tellable from every other swatch (ΔE2000 ≥ 10.5)", close.length === 0, close.join(" "));
ok("R2 no new swatch reads as traffic (ΔE2000 ≥ 22 from yellow/orange/red)", traffic.length === 0, traffic.join(" "));
ok("R3 every new swatch stands out on the day map (ΔE2000 ≥ 14)", hidden.length === 0, hidden.join(" "));

console.log(failed ? `\nFAIL route_palette (${failed})` : "\nPASS route_palette");
process.exit(failed ? 1 : 0);
