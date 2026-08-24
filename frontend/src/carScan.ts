// Car Scan — the guided photo capture that feeds the photo -> GLB pipeline.
//
// WHY THESE EIGHT SHOTS, IN THIS ORDER
// The 2026-08-23 bake-off winner (Tripo H3.1, saved as PICK1_grc_widebody) was
// built from FOUR straight-on views: front centre, driver side, rear centre,
// passenger side. Tripo's Multi-view Images-to-3D exposes exactly four slots —
// Front / Left / Right / Back — and it wants them ORTHOGONAL. Three-quarter
// views pushed into those slots is what the earlier attempts did, and they
// reconstructed worse. So the four that feed the model are the straight-ons,
// flagged `feedsModel` below.
//
// The four 3/4 shots in between are NOT wasted: they are what a retexture pass
// and any future vendor (which may take 6 or 8 views) will need, and re-shooting
// a tester's car is not a thing we get to do twice. The walk is one clockwise
// lap so the driver never backtracks.
//
// PLATE PRIVACY: photos land in a PRIVATE, write-only bucket. The licence plate
// is masked to pure black by tools/glb-pipeline before any frame is handed to a
// third-party reconstruction service — never at capture time, because a masked
// plate would also destroy the rear-panel geometry the model needs.

import { File } from "expo-file-system";
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { logEvent } from "./crashBreadcrumb";

export const SCAN_BUCKET = "car-scans";

export type ScanSlot = "Front" | "Left" | "Right" | "Back";

export type ScanShot = {
  id: string;
  label: string;
  hint: string;
  /** Degrees clockwise around the car; 0 = standing at the nose looking back. */
  bearing: number;
  /** True for the four straight-on views Tripo actually reconstructs from. */
  feedsModel: boolean;
  slot?: ScanSlot;
};

/** One clockwise lap, starting at the nose. Straight-ons feed the model. */
export const SCAN_SHOTS: ScanShot[] = [
  { id: "front",       label: "Front",               hint: "Square to the nose. Centre the badge.",          bearing: 0,   feedsModel: true,  slot: "Front" },
  { id: "front_right", label: "Front three-quarter", hint: "Half a step round. Nose and flank together.",    bearing: 45,  feedsModel: false },
  { id: "right",       label: "Passenger side",      hint: "Square to the flank. Both wheels in frame.",     bearing: 90,  feedsModel: true,  slot: "Right" },
  { id: "rear_right",  label: "Rear three-quarter",  hint: "Half a step round. Tail and flank together.",    bearing: 135, feedsModel: false },
  { id: "rear",        label: "Rear",                hint: "Square to the tail. Centre the plate.",          bearing: 180, feedsModel: true,  slot: "Back" },
  { id: "rear_left",   label: "Rear three-quarter",  hint: "Driver side now. Tail and flank together.",      bearing: 225, feedsModel: false },
  { id: "left",        label: "Driver side",         hint: "Square to the flank. Both wheels in frame.",     bearing: 270, feedsModel: true,  slot: "Left" },
  { id: "front_left",  label: "Front three-quarter", hint: "Last one. Nose and flank together.",             bearing: 315, feedsModel: false },
];

export const SHOTS_TOTAL = SCAN_SHOTS.length;

/** Coaching that applies to every frame — the PoC's measured failure modes. */
export const SCAN_RULES = [
  "Stand three to four metres back and use the 1x lens — pinching to zoom or stepping in warps the proportions.",
  "Hold the phone at head height, tilted slightly down. The map's camera looks at the roof and hood.",
  "Even light. Open shade or overcast beats direct sun; hard shadows get baked into the paint.",
  "Nothing leaning on the car, doors and windows shut, wheels pointed straight ahead.",
];

export type CapturedShot = { shotId: string; uri: string };

export type ScanUploadResult = {
  ok: boolean;
  scanId: string;
  uploaded: number;
  failed: string[];
  error?: string;
};

/** Filesystem/bucket-safe id: handle + local timestamp, unique per attempt. */
export function newScanId(handle?: string | null): string {
  const who =
    (handle || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${who}-${stamp}`;
}

/**
 * A Storage 4xx here almost always means the INSERT policy was never applied —
 * the bucket refuses the shipped anon key and every shot fails identically.
 * Say that plainly instead of surfacing "new row violates row-level security".
 */
function humanise(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("row-level security") || m.includes("violates") || m.includes("unauthorized")) {
    return "Storage rejected the upload — the car-scans policy has not been applied yet.";
  }
  if (m.includes("bucket not found")) return "The car-scans bucket does not exist yet.";
  if (m.includes("payload too large") || m.includes("exceeded")) return "One photo is over the 12 MB limit.";
  if (m.includes("mime")) return "Storage rejected the file type (expects JPEG).";
  return msg;
}

/**
 * Hermes ships NO TextEncoder — Expo's runtime installs URL / URLSearchParams /
 * TextDecoder but not this one, and reaching for it is what silently broke
 * Spotify login (see the write-up at src/spotify.ts:82). The manifest carries a
 * handle and a model name, either of which can be non-ASCII, so this is a real
 * UTF-8 encode rather than a charCode pass. Verified against Node's Buffer.
 */
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { out.push(c); continue; }
    if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); continue; }
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
        continue;
      }
      out.push(0xef, 0xbf, 0xbd);            // lone high surrogate -> U+FFFD
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { out.push(0xef, 0xbf, 0xbd); continue; }
    out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

async function uploadOne(scanId: string, shot: ScanShot, index: number, uri: string): Promise<void> {
  if (!supabase) throw new Error("Supabase client unavailable");
  // ArrayBuffer, NOT Blob/File/FormData: storage-js documents that the other
  // three "do not work as intended" on React Native, and its upload path wraps
  // anything `instanceof Blob` into FormData. File.arrayBuffer() is a native
  // read with no base64 round-trip. Photos go up at native resolution on
  // purpose — downscaling costs reconstruction detail, which is the whole point.
  const buf = await new File(uri).arrayBuffer();
  const path = `${scanId}/${String(index + 1).padStart(2, "0")}-${shot.id}.jpg`;
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .upload(path, buf, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(error.message);
}

async function uploadManifest(scanId: string, meta: Record<string, unknown>): Promise<void> {
  if (!supabase) return;
  const body = utf8Bytes(JSON.stringify(meta, null, 2)).buffer as ArrayBuffer;
  await supabase.storage
    .from(SCAN_BUCKET)
    .upload(`${scanId}/manifest.json`, body, { contentType: "application/json", upsert: true });
}

/**
 * Upload a completed set. Each shot gets one retry — a single flaky frame on
 * cellular should not cost the tester the whole lap.
 */
export async function uploadScan(
  scanId: string,
  shots: CapturedShot[],
  meta: Record<string, unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanUploadResult> {
  if (!SUPABASE_ENABLED || !supabase) {
    return { ok: false, scanId, uploaded: 0, failed: [], error: "Supabase is not configured on this build." };
  }
  const failed: string[] = [];
  let uploaded = 0;
  let firstError = "";

  for (let i = 0; i < SCAN_SHOTS.length; i++) {
    const shot = SCAN_SHOTS[i];
    const got = shots.find((s) => s.shotId === shot.id);
    if (!got) {
      failed.push(shot.label);
      continue;
    }
    try {
      try {
        await uploadOne(scanId, shot, i, got.uri);
      } catch {
        await uploadOne(scanId, shot, i, got.uri); // one retry
      }
      uploaded++;
    } catch (e: any) {
      failed.push(shot.label);
      if (!firstError) firstError = humanise(String(e?.message ?? e));
    }
    onProgress?.(uploaded, SCAN_SHOTS.length);
  }

  if (uploaded > 0) {
    try {
      await uploadManifest(scanId, { ...meta, scanId, uploaded, failed, shots: SCAN_SHOTS.map((s) => s.id) });
    } catch {
      /* the photos are what matter; a missing manifest is recoverable */
    }
  }

  logEvent(`carscan id=${scanId} up=${uploaded}/${SCAN_SHOTS.length} fail=${failed.length}`);
  return { ok: failed.length === 0, scanId, uploaded, failed, error: firstError || undefined };
}
