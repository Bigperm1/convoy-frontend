// arrowModel.ts — runtime PRIMARY/SECONDARY recolor of the green-arrow GLB
// (Garage → Map Appearance → Arrow, 2026-07-17).
//
// The arrow model has clean material separation:
//   greenLight / greenBase / greenMid / greenDark  → the body (PRIMARY)
//   rimTop / rimSide                               → the rim  (SECONDARY)
// Each tier keeps its shading by scaling the target color by the tier's
// original per-channel ratio vs its family base — so a red arrow shades
// exactly like the green one does. The patched .glb is written once per color
// combo to the cache directory and served to Mapbox <Models> as a file:// URI.
// Fails soft everywhere: any error → null → the stock bundled arrow renders.
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";

// glTF material families. Base member FIRST (ratios computed against it).
const PRIMARY_MATS = ["greenBase", "greenLight", "greenMid", "greenDark"];
const SECONDARY_MATS = ["rimTop", "rimSide"];

// sRGB #rrggbb → linear-space [r,g,b] (glTF baseColorFactor is linear).
function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace("#", "").padEnd(6, "0");
  const c = (i: number) => Math.pow(parseInt(h.slice(i, i + 2), 16) / 255, 2.2);
  return [c(0), c(2), c(4)];
}

// ---- minimal base64 (Hermes has no Buffer; atob availability varies) ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64decode(s: string): Uint8Array {
  s = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 3 < s.length + 1; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) |
      ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
    out[o++] = (n >> 16) & 255;
    if (s[i + 2] !== undefined) out[o++] = (n >> 8) & 255;
    if (s[i + 3] !== undefined) out[o++] = n & 255;
  }
  return out.slice(0, o);
}
function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

const rd32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const wr32 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; b[o + 3] = (v >> 24) & 255; };

// Recolor one material family toward `hex`, preserving each tier's shading
// (per-channel ratio vs the family base).
// Recolor one FACTOR array (baseColorFactor OR emissiveFactor) across a material
// family toward `target` (linear rgb), preserving each tier's per-channel ratio
// vs the family's base tier. `getFactor` returns the mutable [r,g,b(,a)] array.
function recolorFactor(mats: any[], names: string[], target: number[], getFactor: (m: any) => number[] | undefined): void {
  const baseRef = getFactor(mats.find((m) => m?.name === names[0]));
  if (!baseRef) return;
  // SNAPSHOT: baseRef aliases the base tier's own array and the base is names[0]
  // (processed first) — mutating it in place would corrupt the divisor for every
  // other tier (ratio×target collapses to the original color). A copy is stable.
  const base = [...baseRef];
  for (const name of names) {
    const f = getFactor(mats.find((x) => x?.name === name));
    if (!f) continue;
    for (let k = 0; k < 3; k++) {
      const ratio = base[k] > 0.0001 ? f[k] / base[k] : 1;
      f[k] = Math.min(1, Math.max(0, target[k] * ratio));
    }
  }
}

function recolorFamily(mats: any[], names: string[], hex: string): void {
  const target = hexToLinear(hex);
  // baseColorFactor (the lit surface color)…
  recolorFactor(mats, names, target, (m) => m?.pbrMetallicRoughness?.baseColorFactor);
  // …AND emissiveFactor. The arrow is fully self-lit (modelEmissiveStrength 1),
  // and every material carries a GREEN/blue-grey emissive glow. Leaving it green
  // is why "reds aren't red / black secondary isn't black" — the glow mixed over
  // the recolored base. Recolour the glow to the SAME hue (ratios preserve each
  // tier's relative glow); a near-black target drives emissive → ~0 = truly black.
  recolorFactor(mats, names, target, (m) => m?.emissiveFactor);
}

let _stockUriPromise: Promise<string | null> | null = null;
async function stockArrowUri(moduleRef: number): Promise<string | null> {
  if (!_stockUriPromise) {
    _stockUriPromise = (async () => {
      try {
        const asset = Asset.fromModule(moduleRef);
        await asset.downloadAsync();
        return asset.localUri ?? asset.uri ?? null;
      } catch { return null; }
    })();
  }
  return _stockUriPromise;
}

/**
 * file:// URI of the arrow GLB recolored to {primary, secondary}. Cached per
 * combo. Returns null (→ caller uses the stock bundled arrow) when no colors
 * are set or anything fails.
 */
export async function getPaintedArrowUri(
  moduleRef: number,
  primary?: string,
  secondary?: string,
): Promise<string | null> {
  try {
    if (!primary && !secondary) return null;
    // v2 suffix: invalidate the buggy pre-fix cached arrows (the base-material
    // aliasing bug left only one tier recolored). Old arrow_*.glb files are
    // simply never read again; the cache dir self-cleans over time.
    const key = `${(primary || "x").replace("#", "")}_${(secondary || "x").replace("#", "")}`;
    const outPath = `${FileSystem.cacheDirectory}arrow_v3_${key}.glb`;
    const info = await FileSystem.getInfoAsync(outPath);
    if (info.exists) return outPath;

    const src = await stockArrowUri(moduleRef);
    if (!src) return null;
    const b64 = await FileSystem.readAsStringAsync(src, { encoding: FileSystem.EncodingType.Base64 });
    const bytes = b64decode(b64);

    // GLB: 12-byte header, then chunks (len, type, data). Chunk 0 is JSON.
    if (rd32(bytes, 0) !== 0x46546c67) return null; // 'glTF'
    const jsonLen = rd32(bytes, 12);
    const jsonStr = String.fromCharCode(...bytes.slice(20, 20 + jsonLen));
    const gltf = JSON.parse(jsonStr);
    const mats = gltf?.materials || [];
    if (primary) recolorFamily(mats, PRIMARY_MATS, primary);
    if (secondary) recolorFamily(mats, SECONDARY_MATS, secondary);

    // Re-encode JSON chunk (4-byte aligned, space padded) + copy the rest.
    let newJson = JSON.stringify(gltf);
    while (newJson.length % 4 !== 0) newJson += " ";
    const rest = bytes.slice(20 + jsonLen); // subsequent chunks (BIN)
    const out = new Uint8Array(20 + newJson.length + rest.length);
    out.set(bytes.slice(0, 12), 0);
    wr32(out, 8, out.length);            // total length
    wr32(out, 12, newJson.length);       // JSON chunk length
    wr32(out, 16, 0x4e4f534a);           // 'JSON'
    for (let i = 0; i < newJson.length; i++) out[20 + i] = newJson.charCodeAt(i);
    out.set(rest, 20 + newJson.length);

    await FileSystem.writeAsStringAsync(outPath, b64encode(out), { encoding: FileSystem.EncodingType.Base64 });
    return outPath;
  } catch {
    return null;
  }
}
