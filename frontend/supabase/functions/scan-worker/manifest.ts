// manifest.ts — everything the worker needs to know about a scan folder BEFORE it
// spends a credit. Pure functions, no I/O, so `deno test` covers every rule.
//
// THE MAPPING RULE (SCAN-PIPELINE.md trap 1, verified 2026-09-01 against the two
// delivered scans' `tripo history --json` payloads): Tripo's multiview endpoint takes
// NAMED views — front / left / back / right. The app writes the photos as
// 01-front / 02-right / 03-rear / 04-left and lists `shots: ["front","right","rear",
// "left"]` in manifest.json. The ONLY correct mapping is by shot id:
//     front -> front · right -> right · rear -> back · left -> left
// Feeding files positionally builds the car mirrored with no error. There is no
// `slot` field in the manifest (the doc used to say there was — corrected).

export const SCAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ShotId = "front" | "right" | "rear" | "left";
export type TripoView = "front" | "left" | "back" | "right";

export const SHOT_IDS: readonly ShotId[] = ["front", "right", "rear", "left"] as const;

/** Bucket filename for each shot — fixed by src/carScan.ts uploadOne(). */
export const SHOT_FILE: Record<ShotId, string> = {
  front: "01-front.jpg",
  right: "02-right.jpg",
  rear: "03-rear.jpg",
  left: "04-left.jpg",
};

/** Shot id -> Tripo view name. `rear` is Tripo's `back`. */
export const SHOT_TO_VIEW: Record<ShotId, TripoView> = {
  front: "front",
  right: "right",
  rear: "back",
  left: "left",
};

/** A real photo is never this small; the app uploads native-resolution JPEGs
 *  (measured 468 KB – 6.0 MB on the two delivered scans). Anything under this is a
 *  probe or a truncated upload and must never be sent to Tripo. */
export const MIN_PHOTO_BYTES = 100_000;

export type Manifest = {
  handle: string | null;
  platform?: string;
  car?: Record<string, unknown>;
  paint?: Record<string, unknown> | null;
  capturedAt?: string;
  scanId: string;
  uploaded: number;
  failed: string[];
  shots: string[];
};

/** Same transform register-scan and newScanId() use — the folder prefix IS the
 *  normalised handle, so the per-user cap keys on exactly this string. */
export function normaliseHandle(handle: string | null | undefined): string {
  return (
    String(handle ?? "anon")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "anon"
  );
}

/** Folders that are not tester scans: probes and Claude's own test uploads.
 *  VERIFIED present in the live bucket 2026-09-01: `_selftest/`, `claudetest-2026…`. */
export function isJunkScanId(id: string): boolean {
  if (!SCAN_ID_RE.test(id)) return true;
  if (id.startsWith("_")) return true;
  if (id.startsWith("claudetest-")) return true;
  return false;
}

export type ManifestResult =
  | { ok: true; manifest: Manifest; handle: string }
  | { ok: false; reason: string };

/** Parse + validate manifest.json. Tolerates both shipped shapes (with and without
 *  `paint` / `car.vehicleClass`). Rejects anything that is not a complete 4-shot lap. */
export function parseManifest(text: string, scanId: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "manifest-unparseable" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "manifest-not-object" };
  const m = raw as Record<string, unknown>;
  if (m.scanId !== scanId) return { ok: false, reason: "manifest-scanid-mismatch" };
  if (m.uploaded !== 4) return { ok: false, reason: `manifest-uploaded-${String(m.uploaded)}` };
  if (!Array.isArray(m.failed) || m.failed.length !== 0) return { ok: false, reason: "manifest-failed-shots" };
  if (!Array.isArray(m.shots)) return { ok: false, reason: "manifest-no-shots" };
  const shots = m.shots.map(String);
  for (const s of SHOT_IDS) if (!shots.includes(s)) return { ok: false, reason: `manifest-missing-${s}` };
  if (m.handle !== null && m.handle !== undefined && typeof m.handle !== "string") {
    return { ok: false, reason: "manifest-bad-handle" };
  }
  const manifest: Manifest = {
    handle: (m.handle as string | null | undefined) ?? null,
    platform: typeof m.platform === "string" ? m.platform : undefined,
    car: (m.car as Record<string, unknown>) ?? undefined,
    paint: (m.paint as Record<string, unknown> | null) ?? null,
    capturedAt: typeof m.capturedAt === "string" ? m.capturedAt : undefined,
    scanId,
    uploaded: 4,
    failed: [],
    shots,
  };
  return { ok: true, manifest, handle: normaliseHandle(manifest.handle) };
}

/** shots[] from the manifest -> {view: shotId}. REFUSES anything short of four. */
export function mapShotsToViews(shots: readonly string[]): Record<TripoView, ShotId> {
  const out: Partial<Record<TripoView, ShotId>> = {};
  for (const s of shots) {
    if (!(s in SHOT_TO_VIEW)) throw new Error(`unknown shot id "${s}"`);
    const view = SHOT_TO_VIEW[s as ShotId];
    if (out[view]) throw new Error(`duplicate shot for view ${view}`);
    out[view] = s as ShotId;
  }
  for (const v of ["front", "left", "back", "right"] as TripoView[]) {
    if (!out[v]) throw new Error(`multiview needs all four views; missing ${v}`);
  }
  return out as Record<TripoView, ShotId>;
}

export type FolderEntry = { name: string; size: number };

export type ShotCheck = { complete: boolean; missing: string[]; small: string[]; hasManifest: boolean };

/** Are all four photos + the manifest in the folder, each photo a real size? */
export function checkFolder(entries: readonly FolderEntry[]): ShotCheck {
  const byName = new Map(entries.map((e) => [e.name, e.size]));
  const missing: string[] = [];
  const small: string[] = [];
  for (const s of SHOT_IDS) {
    const f = SHOT_FILE[s];
    const size = byName.get(f);
    if (size === undefined) missing.push(f);
    else if (size < MIN_PHOTO_BYTES) small.push(`${f}:${size}`);
  }
  const hasManifest = byName.has("manifest.json");
  return { complete: missing.length === 0 && small.length === 0 && hasManifest, missing, small, hasManifest };
}

export function twinName(scanId: string): string {
  return `scan_${scanId}_map.glb`;
}
export function heroName(scanId: string): string {
  return `scan_${scanId}.glb`;
}
