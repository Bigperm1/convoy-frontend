// glb.ts — GLB parse/write, the Mapbox QC gates, and the material pass.
//
// Pure TypeScript: the only dependencies are pngjs + jpeg-js (both pure JS, using
// node:zlib underneath), so this file runs identically under `deno test` on a Mac and
// under the Supabase edge runtime. No sharp, no libvips, no WASM.
//
// QC GATES are SCAN-PIPELINE.md's, as numbers — nothing stricter:
//   TWIN  u16 indices on every primitive · < 25,000 verts total · < 65,536 verts per
//         primitive · <= 30 MB · X extent 1.9101 ± 0.05 · minY within ±0.005 of 0 ·
//         |centreX|,|centreZ| < 0.01
//   HERO  <= 30 MB · parseable (magic, a primitive) · u32 allowed
// Anything else the worker notices is a WARNING (QcReport.warnings, surfaced in the
// breadcrumb, never a failure): the hero's extent / minY / centre (the twin from the same
// generate already proved them, and failing the hero AFTER the twin is published would
// strand the tester), and a material without a metallicRoughness texture (the material
// pass then has nothing to remap and the car may read as chrome — still delivered).
// Measured on the delivered enablewhore twin (raw convert, 2026-09-01): 14,201 verts,
// u16, size X 1.9101, minY 0, centre (0.0002, _, 0.0001), 1,146,948 B.
//
// MATERIAL PASS = tools/glb-pipeline/scan_finish.py, ported 1:1 (same float32 steps,
// same rounding), plus one improvement: the BIN chunk is REBUILT from the bufferViews
// instead of appended to, so the original MR image bytes are dropped rather than left
// orphaned (scan_finish.py leaves +24 % on the twin / +13 % on the hero — measured).

import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";
import { Buffer } from "node:buffer";

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const MAX_BYTES = 30 * 1024 * 1024;
export const TWIN_MAX_VERTS = 25_000;
export const MAX_VERTS_PER_MESH = 65_536;
export const FLEET_LENGTH_X = 1.9101;
export const LENGTH_TOL = 0.05;
export const MINY_TOL = 0.005;
export const CENTRE_TOL = 0.01;

export const ROUGH_FLOOR_DEFAULT = 0.35;
export const METAL_SCALE_DEFAULT = 0.85;

// deno-lint-ignore no-explicit-any
export type GltfJson = any;

export type Glb = { json: GltfJson; bin: Uint8Array };

export function parseGlb(bytes: Uint8Array): Glb {
  if (bytes.byteLength < 20) throw new Error("glb: too short");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const total = dv.getUint32(8, true);
  if (magic !== MAGIC) throw new Error("glb: bad magic");
  if (version !== 2) throw new Error(`glb: version ${version}, want 2`);
  if (total > bytes.byteLength) throw new Error("glb: header length exceeds file");
  let off = 12;
  let json: GltfJson = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === CHUNK_BIN) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("glb: no JSON chunk");
  return { json, bin };
}

export function writeGlb(g: Glb): Uint8Array {
  const jb = new TextEncoder().encode(JSON.stringify(g.json));
  const jpad = (4 - (jb.byteLength % 4)) % 4; // JSON pads with spaces
  const bpad = (4 - (g.bin.byteLength % 4)) % 4; // BIN pads with zeros
  const total = 12 + 8 + jb.byteLength + jpad + 8 + g.bin.byteLength + bpad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let off = 12;
  dv.setUint32(off, jb.byteLength + jpad, true);
  dv.setUint32(off + 4, CHUNK_JSON, true);
  off += 8;
  out.set(jb, off);
  for (let i = 0; i < jpad; i++) out[off + jb.byteLength + i] = 0x20;
  off += jb.byteLength + jpad;
  dv.setUint32(off, g.bin.byteLength + bpad, true);
  dv.setUint32(off + 4, CHUNK_BIN, true);
  off += 8;
  out.set(g.bin, off);
  return out;
}

const COMPONENT = { 5121: "u8", 5123: "u16", 5125: "u32", 5126: "f32" } as Record<number, string>;

export type Metrics = {
  bytes: number;
  totalVerts: number;
  maxPrimVerts: number;
  primitives: number;
  indexTypes: string[];
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  centre: [number, number, number];
  materials: number;
  materialsWithMR: number;
  images: { index: number; mimeType?: string; bytes: number }[];
};

function accessorBounds(g: Glb, acc: GltfJson): { min: number[]; max: number[] } {
  if (Array.isArray(acc.min) && Array.isArray(acc.max) && acc.min.length === 3 && acc.max.length === 3) {
    return { min: acc.min.map(Number), max: acc.max.map(Number) };
  }
  // Fallback: read the floats (POSITION is VEC3 float32 by spec).
  const bv = g.json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? 12;
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset + base);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = dv.getFloat32(i * stride + c * 4, true);
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

export function measure(g: Glb, bytes: number): Metrics {
  const j = g.json;
  let totalVerts = 0;
  let maxPrimVerts = 0;
  let primitives = 0;
  const indexTypes: string[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of j.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      primitives++;
      const pa = j.accessors[prim.attributes?.POSITION];
      if (!pa) throw new Error("glb: primitive without POSITION");
      totalVerts += pa.count;
      if (pa.count > maxPrimVerts) maxPrimVerts = pa.count;
      if (prim.indices !== undefined) {
        const ia = j.accessors[prim.indices];
        indexTypes.push(COMPONENT[ia.componentType] ?? String(ia.componentType));
      } else {
        indexTypes.push("none");
      }
      const b = accessorBounds(g, pa);
      for (let c = 0; c < 3; c++) {
        if (b.min[c] < min[c]) min[c] = b.min[c];
        if (b.max[c] > max[c]) max[c] = b.max[c];
      }
    }
  }
  const size = [0, 1, 2].map((c) => max[c] - min[c]) as [number, number, number];
  const centre = [0, 1, 2].map((c) => (max[c] + min[c]) / 2) as [number, number, number];
  const materials = (j.materials ?? []) as GltfJson[];
  const materialsWithMR = materials.filter((m) => m?.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined).length;
  const images = ((j.images ?? []) as GltfJson[]).map((img, index) => {
    const bv = img.bufferView !== undefined ? j.bufferViews[img.bufferView] : null;
    return { index, mimeType: img.mimeType, bytes: bv ? bv.byteLength : 0 };
  });
  return {
    bytes,
    totalVerts,
    maxPrimVerts,
    primitives,
    indexTypes,
    min: min as [number, number, number],
    max: max as [number, number, number],
    size,
    centre,
    materials: materials.length,
    materialsWithMR,
    images,
  };
}

export type QcReport = { pass: boolean; failures: string[]; warnings: string[]; metrics: Metrics };

/** Size + sanity: a gate for both files. */
function basicGates(m: Metrics, failures: string[]) {
  if (m.bytes > MAX_BYTES) failures.push(`bytes ${m.bytes} > ${MAX_BYTES}`);
  if (m.primitives === 0) failures.push("no-primitives");
}

/** Fleet scale / grounding / centring: a gate for the twin, a warning for the hero. */
function geometryGates(m: Metrics, out: string[]) {
  if (Math.abs(m.size[0] - FLEET_LENGTH_X) > LENGTH_TOL) out.push(`length-x ${m.size[0].toFixed(4)} not ${FLEET_LENGTH_X}±${LENGTH_TOL}`);
  if (Math.abs(m.min[1]) > MINY_TOL) out.push(`miny ${m.min[1].toFixed(4)} not 0±${MINY_TOL}`);
  if (Math.abs(m.centre[0]) >= CENTRE_TOL) out.push(`centre-x ${m.centre[0].toFixed(4)}`);
  if (Math.abs(m.centre[2]) >= CENTRE_TOL) out.push(`centre-z ${m.centre[2].toFixed(4)}`);
}

function parseFailure(bytes: Uint8Array, e: unknown): QcReport {
  return { pass: false, failures: [`parse: ${(e as Error).message}`], warnings: [], metrics: emptyMetrics(bytes.byteLength) };
}

/** The map twin must satisfy every Mapbox gate; the failure list names each one. */
export function qcTwin(bytes: Uint8Array): QcReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  let g: Glb;
  try {
    g = parseGlb(bytes);
  } catch (e) {
    return parseFailure(bytes, e);
  }
  const m = measure(g, bytes.byteLength);
  basicGates(m, failures);
  geometryGates(m, failures);
  for (const [i, t] of m.indexTypes.entries()) if (t !== "u16") failures.push(`indices prim${i} ${t} (want u16)`);
  if (m.totalVerts >= TWIN_MAX_VERTS) failures.push(`verts ${m.totalVerts} >= ${TWIN_MAX_VERTS}`);
  if (m.maxPrimVerts >= MAX_VERTS_PER_MESH) failures.push(`verts-per-mesh ${m.maxPrimVerts} >= ${MAX_VERTS_PER_MESH}`);
  if (m.materialsWithMR === 0) warnings.push("no-metallicRoughness-texture");
  return { pass: failures.length === 0, failures, warnings, metrics: m };
}

/** SCAN-PIPELINE.md: "Hero: <= 30 MB only". Parseable + under the cap is the gate;
 *  geometry deviations are reported as warnings so a hero can never fail AFTER the
 *  twin from the same generate was published. */
export function qcHero(bytes: Uint8Array): QcReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  let g: Glb;
  try {
    g = parseGlb(bytes);
  } catch (e) {
    return parseFailure(bytes, e);
  }
  const m = measure(g, bytes.byteLength);
  basicGates(m, failures);
  geometryGates(m, warnings);
  if (m.materialsWithMR === 0) warnings.push("no-metallicRoughness-texture");
  return { pass: failures.length === 0, failures, warnings, metrics: m };
}

function emptyMetrics(bytes: number): Metrics {
  return {
    bytes,
    totalVerts: 0,
    maxPrimVerts: 0,
    primitives: 0,
    indexTypes: [],
    min: [0, 0, 0],
    max: [0, 0, 0],
    size: [0, 0, 0],
    centre: [0, 0, 0],
    materials: 0,
    materialsWithMR: 0,
    images: [],
  };
}

// ── material pass ────────────────────────────────────────────────────────────

export type Rgba = { width: number; height: number; data: Uint8Array };

export function decodeImage(bytes: Uint8Array): { img: Rgba; format: "png" | "jpeg" } {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const p = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { img: { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) }, format: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const j = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { img: { width: j.width, height: j.height, data: j.data as Uint8Array }, format: "jpeg" };
  }
  throw new Error("image: neither PNG nor JPEG");
}

export function encodePng(img: Rgba): Uint8Array {
  const p = new PNG({ width: img.width, height: img.height, colorType: 6 });
  p.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  // colorType 2 = RGB on disk (alpha dropped), matching scan_finish.py's .convert("RGB").
  const out = PNG.sync.write(p, { colorType: 2 });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const f32 = Math.fround;

/** The remap, byte-exact with scan_finish.py:
 *      arr = uint8 -> float32 / 255.0
 *      G'  = floor + (1 - floor) * G          (float32 arithmetic, NumPy 2 promotion)
 *      B'  = clip(B * scale, 0, 1)
 *      out = uint8(arr * 255.0 + 0.5)         (truncation after +0.5 == round-half-up)
 *  R and A pass through untouched. */
export function remapMetallicRoughness(img: Rgba, roughFloor = ROUGH_FLOOR_DEFAULT, metalScale = METAL_SCALE_DEFAULT): Rgba {
  const out = new Uint8Array(img.data.length);
  const floor = f32(roughFloor);
  const oneMinus = f32(1 - roughFloor);
  const scale = f32(metalScale);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o] = img.data[o];
    const g = f32(img.data[o + 1] / 255);
    const b = f32(img.data[o + 2] / 255);
    let g2 = f32(floor + f32(oneMinus * g));
    let b2 = f32(b * scale);
    if (b2 < 0) b2 = 0;
    if (b2 > 1) b2 = 1;
    if (g2 > 1) g2 = 1;
    out[o + 1] = Math.min(255, Math.floor(f32(f32(g2 * 255) + 0.5)));
    out[o + 2] = Math.min(255, Math.floor(f32(f32(b2 * 255) + 0.5)));
    out[o + 3] = img.data[o + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

export type FinishReport = {
  remappedImages: number[];
  inBytes: number;
  outBytes: number;
  cpuMs: number;
  imageFormats: string[];
};

/** Which image indices are referenced as a metallicRoughnessTexture by any material. */
export function metallicRoughnessImages(json: GltfJson): number[] {
  const set = new Set<number>();
  for (const mat of json.materials ?? []) {
    const t = mat?.pbrMetallicRoughness?.metallicRoughnessTexture;
    if (t && typeof t.index === "number") {
      const tex = json.textures?.[t.index];
      if (tex && typeof tex.source === "number") set.add(tex.source);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Remap every MR image, then rebuild the BIN chunk so no orphaned bytes remain.
 *  A file with no MR texture is returned unchanged (see qcTwin/qcHero warnings). */
export function finishMaterial(bytes: Uint8Array, roughFloor = ROUGH_FLOOR_DEFAULT, metalScale = METAL_SCALE_DEFAULT): { bytes: Uint8Array; report: FinishReport } {
  const t0 = performance.now();
  const g = parseGlb(bytes);
  const j = g.json;
  if ((j.buffers ?? []).length !== 1) throw new Error(`glb: expected exactly one buffer, got ${(j.buffers ?? []).length}`);
  const mrImages = metallicRoughnessImages(j);
  if (mrImages.length === 0) {
    // Nothing to remap (qc* already flagged `no-metallicRoughness-texture` as a warning):
    // pass the bytes through untouched rather than fail a car the tester is waiting for.
    return { bytes, report: { remappedImages: [], inBytes: bytes.byteLength, outBytes: bytes.byteLength, cpuMs: Math.round(performance.now() - t0), imageFormats: [] } };
  }

  // 1. New payloads for the MR images (keyed by bufferView index).
  const replaced = new Map<number, Uint8Array>();
  const formats: string[] = [];
  for (const imgIdx of mrImages) {
    const img = j.images[imgIdx];
    if (img.bufferView === undefined) throw new Error(`glb: image ${imgIdx} is not embedded`);
    const bv = j.bufferViews[img.bufferView];
    const src = g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const { img: decoded, format } = decodeImage(src);
    formats.push(format);
    const remapped = remapMetallicRoughness(decoded, roughFloor, metalScale);
    replaced.set(img.bufferView, encodePng(remapped));
    img.mimeType = "image/png";
  }

  // 2. Rebuild the BIN: every bufferView in index order, 4-byte aligned.
  const views = j.bufferViews as GltfJson[];
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (let i = 0; i < views.length; i++) {
    const bv = views[i];
    if ((bv.buffer ?? 0) !== 0) throw new Error("glb: bufferView on a second buffer");
    const payload = replaced.get(i) ?? g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      cursor += pad;
    }
    bv.byteOffset = cursor;
    bv.byteLength = payload.byteLength;
    parts.push(payload);
    cursor += payload.byteLength;
  }
  const bin = new Uint8Array(cursor);
  let off = 0;
  for (const p of parts) {
    bin.set(p, off);
    off += p.byteLength;
  }
  j.buffers[0].byteLength = bin.byteLength;
  const out = writeGlb({ json: j, bin });
  return {
    bytes: out,
    report: { remappedImages: mrImages, inBytes: bytes.byteLength, outBytes: out.byteLength, cpuMs: Math.round(performance.now() - t0), imageFormats: formats },
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sum of bufferView byte lengths + alignment padding — what a rebuilt BIN must equal. */
export function expectedBinLength(json: GltfJson): number {
  let cursor = 0;
  for (const bv of json.bufferViews ?? []) {
    cursor += (4 - (cursor % 4)) % 4;
    cursor += bv.byteLength;
  }
  return cursor;
}
