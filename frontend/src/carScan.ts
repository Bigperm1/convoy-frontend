// Car Scan — the guided photo capture that feeds the photo -> GLB pipeline.
//
// WHY EXACTLY FOUR SHOTS
// The 2026-08-23 bake-off winner (Tripo v3.1 Best Quality, saved as
// PICK1_grc_widebody) was generated with *Multi-view Images to 3D* from four
// views: front / left / right / back. That mode exposes exactly FOUR slots and
// wants them ORTHOGONAL — straight-on, not three-quarter. Earlier attempts that
// pushed 3/4 views into those slots reconstructed worse.
//
// So four is not a starting point to grow from, it is the tool's actual input
// shape. Asking a tester for more photos than the pipeline consumes buys nothing
// and doubles the chance of a bad frame; extra views were briefly added on the
// theory that a future vendor might take 6 or 8, which is speculation — the one
// time that was tested, a 6-view run failed outright. Add stations again only
// when a shipping pipeline actually reads them.
//
// The walk is one clockwise lap so the driver never backtracks.
//
// PLATE PRIVACY — THE HONEST VERSION (corrected 2026-08-26).
// This comment used to claim the licence plate "is masked to pure black by
// tools/glb-pipeline before any frame is handed to a third-party reconstruction
// service". THAT WAS NEVER TRUE. No such script has ever existed — tools/glb-pipeline
// holds eleven files and none of them touch a plate. A comment asserting a privacy
// control that does not exist is worse than having no control, because it stops
// anyone from asking the question again.
//
// Jeff's call, 2026-08-26, on being shown the gap: don't build the mask.
// The reasoning holds up, and it was checked rather than assumed:
//   • MEASURED on GRC2.glb, the one finished Tripo model we have (Jeff's own car):
//     the 2048x2048 basecolor is a heavily fragmented UV atlas. Sampling it found
//     body decals and trim — no legible plate anywhere. The plate does not survive
//     reconstruction as readable text, so nothing readable ships in the model.
//     (Sampled, not exhaustively scanned, and n=1 model. Re-check if a future bake
//     ever shows plate characters.)
//   • On the map the car draws a few dozen pixels tall. There is nothing to read.
//   • The plate is visible to anyone standing near the car in a public car park,
//     and the driver is deliberately photographing their own vehicle.
// Masking at CAPTURE time would also be actively harmful: it destroys the rear-panel
// geometry the reconstruction needs, which is why the original note ruled it out too.
//
// What replaces it is DISCLOSURE, not redaction: the consent screen names the
// third-party 3D service, which is what the Play / App Store data-safety
// declarations actually require. Photos still land in a PRIVATE, write-only bucket.
//
// ⚠ One thing to keep in mind when hosting a finished per-user model: the `models`
// bucket is PUBLIC (/object/public/models/...), so any GLB there is fetchable by
// anyone holding the URL. That is fine precisely because no plate is legible in the
// texture — if that ever stops being true, this decision has to be revisited.

import { File } from "expo-file-system";
import { supabase, SUPABASE_ENABLED, SUPABASE_ANON_KEY } from "./supabase";
import { api } from "./api";
import { logEvent, logEventReliable } from "./crashBreadcrumb";

export const SCAN_BUCKET = "car-scans";

// ── SERVER-ISSUED SCAN SLOTS + THE RETURN LEG (2026-09-02, supersedes 08-27) ──
// Jeff: "cap them at two instances max so they can't … burn up my credits" and
// "tell me how long it would take for the photos to reach their phone."
//
// The cap: MAX_SCAN_ATTEMPTS below is device-local AsyncStorage — a reinstall
// resets it. The truth that survives reinstalls now lives on the BACKEND (Render,
// keyed by the signed-in account, not the handle): the app asks POST /api/scan/slot
// for a slot BEFORE it has a scan id at all, and the SERVER MINTS THE ID. Until
// 2026-09-02 the phone made its own id (handle + timestamp) and asked the
// register-scan edge function to bless it with the anon key — which meant the
// only identity on a scan was a self-declared handle. The slot carries the
// account's userId, the tier verdict and the used/max count, and the gate still
// FAILS CLOSED: no verdict = no upload, because the cap protects paid Tripo credits.
// Every slot request drops a carscan-slot breadcrumb (status, body, timing) so a
// tester saying "it wouldn't let me scan" is answerable from telemetry.
//
// The return leg: the pipeline publishes finished cars to the PUBLIC models
// bucket under a NAME CONVENTION —
//     scan_<scanId>.glb        the Garage hero (full quality)
//     scan_<scanId>_map.glb    the decimated map twin
// scanId is per-attempt unique (server-issued), so a second render is a NEW
// name and Mapbox's cache-by-URL can never pin the old car. The app polls with
// a HEAD request (free, public bucket) while carScanStatus === 'submitted' and
// flips itself to 'ready' — no backend column, no push infrastructure needed.
const FN_BASE = "https://pgtbjiszjglznjagolse.supabase.co/functions/v1";
const MODELS_PUBLIC = "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models";

/**
 * The gate verdict. `reason` when !ok:
 *   "cap"          — both renders used (server used/max are authoritative)
 *   "tier"         — the account's tier does not include Garage Scan (→ Ultra pitch)
 *   "signin"       — 401: the session token is finished; sign in again
 *   "bad-response" — reachable, but the body was not a verdict (status in `detail`)
 *   "threw"        — the request itself failed (network / DNS / timeout; code in `detail`)
 * `detail` is the human-readable why for the UI, never a guess: it is the HTTP
 * status or the axios error code/message that was actually observed.
 */
export type ScanGate = { ok: boolean; used: number; max: number; reason?: string; detail?: string };

/** What POST /api/scan/slot hands back on top of the gate: the id the server MINTED. */
export type ScanSlotGrant = ScanGate & { scanId?: string; userId?: string; tier?: string };

/** Ask the backend for a scan slot. FAILS CLOSED — no verdict means no upload.
 *
 *  No argument      → issue a NEW slot (the server mints the scanId).
 *  existingScanId   → re-validate the slot this lap already holds, for an upload
 *                     retry. A retry must never mint a second id: the photos that
 *                     already landed live under the first one.
 *
 *  CONTRACT (backend, 2026-09-02):
 *    200 { ok: true,  scanId, userId, used, max, tier }
 *    403 { ok: false, reason: "cap" | "tier", used, max, tier }
 *    401 → the token is finished (api.ts attaches the Bearer; it has NO 401
 *          interceptor — verified 2026-09-02 — so this maps it to "signin" itself).
 */
export async function requestScanSlot(existingScanId?: string): Promise<ScanSlotGrant> {
  // PROBE: same discipline as registerScan below — the gate decides whether a
  // tester burns one of two paid Tripo renders, so every exit records status,
  // body and timing. `id=new` is a fresh issue; `id=<scanId>` is a retry re-check.
  const t0 = Date.now();
  const idTag = existingScanId ?? "new";
  const closed = (reason: string, detail: string): ScanSlotGrant =>
    ({ ok: false, used: 0, max: MAX_SCAN_ATTEMPTS, reason, detail });
  try {
    // validateStatus: a 403 IS the verdict (cap/tier live in its body), not an
    // exception — let every status through and read it here.
    const res = await api.post("/scan/slot", existingScanId ? { scanId: existingScanId } : {}, {
      validateStatus: () => true,
    });
    const ms = Date.now() - t0;
    const j: any = res.data;
    if (res.status === 401) {
      try { logEventReliable(`carscan-slot id=${idTag} ok=0 reason=signin http=401 ms=${ms}`); } catch {}
      return closed("signin", "HTTP 401");
    }
    if (j && typeof j === "object" && typeof j.ok === "boolean") {
      const g: ScanSlotGrant = {
        ok: j.ok,
        used: typeof j.used === "number" ? j.used : 0,
        max: typeof j.max === "number" ? j.max : MAX_SCAN_ATTEMPTS,
        reason: typeof j.reason === "string" ? j.reason : undefined,
        scanId: typeof j.scanId === "string" && j.scanId ? j.scanId : undefined,
        userId: typeof j.userId === "string" && j.userId ? j.userId : undefined,
        tier: typeof j.tier === "string" ? j.tier : undefined,
      };
      // ok with no id is unusable — there is nothing to name the bucket folder.
      // Treat it as a bad response rather than inventing an id on the phone again.
      if (g.ok && !g.scanId) {
        try { logEventReliable(`carscan-slot id=${idTag} ok=0 reason=no-scanid http=${res.status} ms=${ms}`); } catch {}
        return { ...g, ok: false, reason: "bad-response", detail: `HTTP ${res.status}, ok without scanId` };
      }
      try {
        logEventReliable(`carscan-slot id=${g.scanId ?? idTag} ok=${g.ok ? 1 : 0} used=${g.used}/${g.max}`
          + ` reason=${g.reason ?? "-"} tier=${g.tier ?? "-"} http=${res.status} ms=${ms}`);
      } catch {}
      return g.ok ? g : { ...g, detail: `HTTP ${res.status}` };
    }
    const body = (() => { try { return JSON.stringify(j).slice(0, 120); } catch { return String(j).slice(0, 120); } })();
    try { logEventReliable(`carscan-slot id=${idTag} ok=0 reason=bad-response http=${res.status} ms=${ms} body=${body}`); } catch {}
    return closed("bad-response", `HTTP ${res.status}`);
  } catch (e: any) {
    // validateStatus swallows every HTTP status, so reaching here means the request
    // itself failed. Record what actually threw — a DNS failure, a TLS error, a
    // 60 s timeout (Render cold start) and a real outage are different bugs.
    const code = String(e?.code ?? "");
    const msg = String(e?.message ?? e).slice(0, 120);
    try { logEventReliable(`carscan-slot id=${idTag} ok=0 reason=threw ms=${Date.now() - t0} code=${code || "-"} err=${msg}`); } catch {}
    return closed("threw", code ? `${code}: ${msg}` : msg);
  }
}

export type ScanSlots = { used: number; max: number; tier?: string };

/** GET /api/entitlement → the server's render count for the signed-in account
 *  ({ tier, source: "server", scanSlots: { used, max } }). Null when the server did
 *  not answer with a count — callers fall back to the device-local counter and
 *  say so. Read-only, so the breadcrumb is the plain (droppable) kind. */
export async function fetchScanSlots(): Promise<ScanSlots | null> {
  const t0 = Date.now();
  try {
    const res = await api.get("/entitlement", { validateStatus: () => true });
    const ms = Date.now() - t0;
    const d: any = res.data;
    const s = d && typeof d === "object" ? d.scanSlots : undefined;
    if (res.status === 200 && s && typeof s.used === "number" && typeof s.max === "number") {
      const tier = typeof d.tier === "string" ? d.tier : undefined;
      try { logEvent(`carscan-slots used=${s.used}/${s.max} tier=${tier ?? "-"} http=200 ms=${ms}`); } catch {}
      return { used: s.used, max: s.max, tier };
    }
    try { logEvent(`carscan-slots ok=0 reason=bad-response http=${res.status} ms=${ms}`); } catch {}
    return null;
  } catch (e: any) {
    try { logEvent(`carscan-slots ok=0 reason=threw ms=${Date.now() - t0} code=${String(e?.code ?? "-")} err=${String(e?.message ?? e).slice(0, 100)}`); } catch {}
    return null;
  }
}

/**
 * @deprecated 2026-09-02 — the gate is `requestScanSlot()` (backend, JWT, server-minted
 * id). The register-scan edge function is being turned into a slot LOOKUP for the
 * pipeline; the app no longer calls it. Kept exported, unused, until the edge
 * function change lands and this can be deleted.
 *
 * Ask the server whether this handle may start (or retry) a scan. FAILS CLOSED.
 */
export async function registerScan(handle: string | null | undefined, scanId: string): Promise<ScanGate> {
  // PROBE (2026-08-29): the gate decides whether a tester burns one of two paid
  // Tripo renders, and every failure path here used to collapse to the word
  // "offline" with no status, no body and no timing. A tester saying "it wouldn't
  // let me scan" was unanswerable.
  const t0 = Date.now();
  try {
    const res = await fetch(`${FN_BASE}/register-scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: handle || "anon", scanId }),
    });
    const j = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    if (j && typeof j.ok === "boolean") {
      const g = j as ScanGate;
      try { logEventReliable(`carscan-register id=${scanId} ok=${g.ok ? 1 : 0} used=${g.used}/${g.max} reason=${g.reason ?? "-"} http=${res.status} ms=${ms}`); } catch {}
      return g;
    }
    try { logEventReliable(`carscan-register id=${scanId} ok=0 reason=bad-response http=${res.status} ms=${ms}`); } catch {}
    return { ok: false, used: 0, max: MAX_SCAN_ATTEMPTS, reason: "bad-response" };
  } catch (e: any) {
    // Was a bare `catch {}` reporting "offline" — which was a GUESS. Record what
    // actually threw; a DNS failure, a TLS error and a real outage are different bugs.
    try { logEventReliable(`carscan-register id=${scanId} ok=0 reason=threw ms=${Date.now() - t0} err=${String(e?.message ?? e).slice(0, 120)}`); } catch {}
    return { ok: false, used: 0, max: MAX_SCAN_ATTEMPTS, reason: "offline" };
  }
}

export function scanHeroUrl(scanId: string): string { return `${MODELS_PUBLIC}/scan_${scanId}.glb`; }
export function scanMapUrl(scanId: string): string { return `${MODELS_PUBLIC}/scan_${scanId}_map.glb`; }

// ── HERO SHOT (2026-09-03, Jeff: the Crew/friend avatar "should be the 3D hero shot") ─────
// The pipeline makes GLBs only, so the PHONE takes the picture: the Garage's inline
// model-viewer snapshots itself once the hero has loaded (CarHero3D onSnapshot) and the JPEG
// goes to car-scans/<scanId>/hero.jpg — insert-only like the photos, a rescan is a new folder.
// car-scans is a PRIVATE bucket; a storage policy grants anon SELECT on exactly `*/hero.jpg`
// (the photos stay private), so readers fetch through the authenticated object endpoint with
// the anon key in the headers — expo-image passes them. Nothing new in `models`.
const SCAN_OBJECT_AUTH = "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object";
export function scanHeroImageSource(scanId: string): { uri: string; headers: Record<string, string> } | null {
  const key = (SUPABASE_ANON_KEY || "").trim();
  if (!scanId || !key) return null;
  return {
    uri: `${SCAN_OBJECT_AUTH}/${SCAN_BUCKET}/${encodeURIComponent(scanId)}/hero.jpg`,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  };
}
/** Upload the Garage hero snapshot (a data: URI, image/jpeg). Duplicate = fine. */
export async function uploadScanHero(scanId: string, dataUri: string): Promise<boolean> {
  if (!supabase || !scanId) return false;
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUri || "");
  if (!m) return false;
  const bin = base64ToBytes(m[1]);
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .upload(`${scanId}/hero.jpg`, bin.buffer as ArrayBuffer, { contentType: "image/jpeg", upsert: false });
  const dup = !!(error && isDuplicate(error.message));
  try { logEvent(`carscan-hero id=${scanId} kb=${Math.round(bin.byteLength / 1024)}${error && !dup ? ` err=${String(error.message).slice(0, 90)}` : ""}`); } catch {}
  return !error || dup;
}
function base64ToBytes(b64: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | chars.indexOf(clean[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

/** Poll the convention URLs for a submitted scan. Ready means BOTH files exist.
 *
 *  ⚠ BOTH, not hero-only — the 2026-08-29 review caught the race this closes: the
 *  caller writes carScanStatus:'ready' ONCE and never re-checks, so a poll landing in
 *  the gap between the two publishes would latch carScanMapUrl undefined and the map
 *  marker would stay the fleet car for the life of the install, while the "it's your
 *  marker on the map" overlay lied. The pipeline publishes the twin FIRST
 *  (SCAN-PIPELINE.md) precisely so hero-present implies twin-present — but that is a
 *  process convention, and this is the code that stops depending on it. A hero with
 *  no twin is "still building", which is simply true: the publish isn't finished. */
export async function checkScanReady(scanId: string): Promise<{ heroUrl: string; mapUrl: string } | null> {
  try {
    const head = (u: string) => fetch(u, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
    if (!(await head(scanHeroUrl(scanId)))) return null;
    const hasMap = await head(scanMapUrl(scanId));
    // PROBE: fires on the poll that first sees the hero (map=0 rows = the publish-order
    // race being survived — each one is a worker bug to chase, not a tester problem).
    try { logEventReliable(`carscan-ready id=${scanId} hero=1 map=${hasMap ? 1 : 0}`); } catch {}
    if (!hasMap) return null;
    return { heroUrl: scanHeroUrl(scanId), mapUrl: scanMapUrl(scanId) };
  } catch (e: any) {
    try { logEvent(`carscan-ready id=${scanId} threw err=${String(e?.message ?? e).slice(0, 100)}`); } catch {}
    return null;
  }
}

export type ScanSlot = "Front" | "Left" | "Right" | "Back";

export type ScanShot = {
  id: string;
  label: string;
  hint: string;
  /** Degrees clockwise around the car; 0 = standing at the nose looking back. */
  bearing: number;
  /** Which Tripo Multi-view slot this photo is fed into. */
  slot: ScanSlot;
};

/**
 * One clockwise lap, starting at the nose. All four feed the model — there are
 * no optional shots. Labels must stay UNIQUE and name the SIDE: they are read
 * outdoors, one-handed, by someone walking around a car, and the pitch screen's
 * station ring also keys off them.
 */
export const SCAN_SHOTS: ScanShot[] = [
  { id: "front", label: "Front",          hint: "Square to the nose. Centre the badge.",      bearing: 0,   slot: "Front" },
  { id: "right", label: "Passenger side", hint: "Square to the flank. Both wheels in frame.", bearing: 90,  slot: "Right" },
  { id: "rear",  label: "Rear",           hint: "Square to the tail. Centre the plate.",      bearing: 180, slot: "Back" },
  { id: "left",  label: "Driver side",    hint: "Square to the flank. Both wheels in frame.", bearing: 270, slot: "Left" },
];

export const SHOTS_TOTAL = SCAN_SHOTS.length;

/**
 * Renders a customer gets. Jeff, 2026-08-23: "they get 2 tries to finalize. if
 * they choose a 2nd render they loose the first try."
 *
 * The second is DESTRUCTIVE — it replaces the first, which cannot be recovered.
 * That is stated on the consent screen before the first photo rather than at the
 * moment it bites. The SERVER's used/max (GET /api/entitlement, POST /api/scan/slot)
 * is the count of record since 2026-09-02; this constant is the FALLBACK the UI
 * shows only when the server has not answered, and the device-local counter it
 * pairs with still resets on reinstall.
 */
export const MAX_SCAN_ATTEMPTS = 2;

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

/**
 * @deprecated 2026-09-02 — the scan id is MINTED BY THE SERVER (`requestScanSlot()`
 * returns it). Nothing in the app calls this any more; it stays exported only so the
 * old id shape stays documented next to the slot flow that replaced it.
 *
 * Filesystem/bucket-safe id: handle + local timestamp, unique per attempt.
 */
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

/**
 * A path that is already in the bucket. Measured against the live bucket
 * 2026-08-23: re-POSTing an existing path returns 409 "The resource already
 * exists" (KeyAlreadyExists). That is a SUCCESS for our purposes — the photo is
 * in there — and it is what makes the retry below safe to run blind.
 */
function isDuplicate(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("already exists") || m.includes("duplicate") || m.includes("keyalreadyexists");
}

async function uploadOne(scanId: string, shot: ScanShot, index: number, uri: string): Promise<void> {
  if (!supabase) throw new Error("Supabase client unavailable");
  // ArrayBuffer, NOT Blob/File/FormData: storage-js documents that the other
  // three "do not work as intended" on React Native, and its upload path wraps
  // anything `instanceof Blob` into FormData. File.arrayBuffer() is a native
  // read with no base64 round-trip. Photos go up at native resolution on
  // purpose — downscaling costs reconstruction detail, which is the whole point.
  const tRead = Date.now();
  const buf = await new File(uri).arrayBuffer();
  const readMs = Date.now() - tRead;
  const path = `${scanId}/${String(index + 1).padStart(2, "0")}-${shot.id}.jpg`;
  const tPut = Date.now();
  // upsert MUST stay false. The bucket policy grants INSERT only, so an upsert
  // is an UPDATE the anon key does not have — measured against the live bucket
  // 2026-08-23: `x-upsert: true` on an existing path returns 403 "new row
  // violates row-level security policy", while a plain re-POST returns a clean
  // 409. Without this, a first attempt that succeeded server-side but timed out
  // client-side would have its retry denied and the shot reported as lost —
  // when the photo was in the bucket all along.
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .upload(path, buf, { contentType: "image/jpeg", upsert: false });
  // PROBE: photos go up at NATIVE resolution on purpose, so a slow lap could be a
  // fat frame or a bad connection — bytes and ms separate those. `dup=1` is the clean
  // 409 that means the retry found the photo already there (see the upsert note above),
  // which is a SUCCESS and must never be read as a failure.
  const dup = !!(error && isDuplicate(error.message));
  try {
    logEvent(`carscan-shot id=${scanId} i=${index + 1} shot=${shot.id} kb=${Math.round(buf.byteLength / 1024)}`
      + ` readMs=${readMs} putMs=${Date.now() - tPut} dup=${dup ? 1 : 0}`
      + (error && !dup ? ` err=${String(error.message).slice(0, 100)}` : ""));
  } catch {}
  if (error && !isDuplicate(error.message)) throw new Error(error.message);
}

async function uploadManifest(scanId: string, meta: Record<string, unknown>): Promise<void> {
  if (!supabase) return;
  const body = utf8Bytes(JSON.stringify(meta, null, 2)).buffer as ArrayBuffer;
  // Same insert-only rule as the photos — see uploadOne.
  await supabase.storage
    .from(SCAN_BUCKET)
    .upload(`${scanId}/manifest.json`, body, { contentType: "application/json", upsert: false });
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
  let retries = 0;
  const tScan = Date.now();
  try { logEventReliable(`carscan-begin id=${scanId} shots=${shots.length}/${SCAN_SHOTS.length}`); } catch {}

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
      } catch (e1: any) {
        // The retry exists because one flaky frame on cellular should not cost the
        // whole lap. Record that it FIRED and why — a lap that only survives on
        // retries is a connection story we would otherwise never see.
        try { logEvent(`carscan-retry id=${scanId} i=${i + 1} shot=${shot.id} why=${String(e1?.message ?? e1).slice(0, 90)}`); } catch {}
        retries++;
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

  // Upgraded to RELIABLE + timed: this is the row we interpret by ABSENCE ("the tester
  // says they scanned and there is no record"), and plain logEvent drops pre-client rows.
  try {
    logEventReliable(`carscan id=${scanId} up=${uploaded}/${SCAN_SHOTS.length} fail=${failed.length}`
      + ` retries=${retries} ms=${Date.now() - tScan}`
      + (firstError ? ` err=${firstError.slice(0, 120)}` : ""));
  } catch {}
  return { ok: failed.length === 0, scanId, uploaded, failed, error: firstError || undefined };
}
