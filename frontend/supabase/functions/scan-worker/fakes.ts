// fakes.ts — in-memory Deps for `deno test` and the dry run. Nothing here talks to
// Supabase or Tripo; the dry run swaps in a real TripoClient pointed at the local stub.

import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";
import type { Deps, Flags, Job, JobPatch, JobStatus } from "./worker.ts";
import type { FolderEntry, TripoView } from "./manifest.ts";
import type { ConvertParams, TripoApi, TripoTask } from "./tripo.ts";
import { TripoError } from "./tripo.ts";
import { writeGlb } from "./glb.ts";

export const FAKE_EPOCH = "2026-09-02T12:00:00Z";

export function newJob(scanId: string, over: Partial<Job> = {}): Job {
  const now = new Date(FAKE_EPOCH).toISOString();
  return {
    scan_id: scanId,
    handle: null,
    status: "queued",
    shots: null,
    tripo_file_tokens: null,
    tripo_gen_task: null,
    tripo_map_task: null,
    tripo_hero_task: null,
    credits_spent: 0,
    convert_retries: 0,
    attempts: 0,
    waits: 0,
    state_polls: 0,
    next_run_at: now,
    lease_until: null,
    locked_by: null,
    paid_call: null,
    paid_call_started_at: null,
    twin_pending_sha256: null,
    twin_sha256: null,
    hero_sha256: null,
    twin_published_at: null,
    hero_published_at: null,
    last_error: null,
    reason: null,
    generate_submitted_at: null,
    map_submitted_at: null,
    hero_submitted_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

export const DEFAULT_FLAGS: Flags = { enabled: true, daily_credit_cap: 300, per_user_cap: 2, min_balance: 100, paused_reason: null };

/** Scripted Tripo: each task succeeds after `pollsToSuccess` polls; outputs point at fake:// urls. */
export class FakeTripo implements TripoApi {
  calls: { method: string; body: unknown }[] = [];
  tasks = new Map<string, { type: string; polls: number; params?: unknown; fail?: string }>();
  pollsToSuccess = 1;
  balanceValue = 1890;
  failNextGenerate: Error | null = null;
  failGenerateStatus: string | null = null;
  /** LOST REPLY: the task IS created (Tripo charged) but the POST throws (timeout/abort/network). */
  loseNextGenerate = false;
  loseNextConverts = 0;
  /** DEFINITE rejection: throws a TripoError carrying an API code; no task is created. */
  rejectNextConverts = 0;
  /** AMBIGUOUS rejection (item 4): a 5xx that STILL carries a parsed JSON code — must be
   *  treated like a lost reply (retry-once / never-re-POST-a-generate), never rolled back. */
  reject5xxNextConverts = 0;
  reject5xxNextGenerate = false;
  /** Every task ever created, in order — the receipt for "how many times were we charged". */
  created: string[] = [];
  modelUrls: Record<string, string> = { twin: "fake://twin.glb", hero: "fake://hero.glb" };
  private n = 0;

  uploadFile(bytes: Uint8Array, filename: string): Promise<string> {
    this.calls.push({ method: "POST /v3/files", body: { filename, bytes: bytes.byteLength } });
    return Promise.resolve(`file_${filename.replace(/\W/g, "")}_${bytes.byteLength}`);
  }
  generateMultiview(views: Record<TripoView, string>): Promise<string> {
    const payload = { inputs: (["front", "left", "back", "right"] as TripoView[]).map((v) => ({ [v]: views[v] })), model: "v3.1-20260211" };
    this.calls.push({ method: "POST /v3/generation/multiview-to-model", body: payload });
    if (this.failNextGenerate) {
      const e = this.failNextGenerate;
      this.failNextGenerate = null;
      return Promise.reject(e);
    }
    if (this.reject5xxNextGenerate) {
      this.reject5xxNextGenerate = false;
      return Promise.reject(new TripoError("/v3/generation/multiview-to-model: upstream error", 502, 2003));
    }
    const id = `gen-${++this.n}`;
    this.tasks.set(id, { type: "multiview_to_model", polls: 0, fail: this.failGenerateStatus ?? undefined });
    this.created.push(id);
    if (this.loseNextGenerate) {
      this.loseNextGenerate = false;
      return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
    }
    return Promise.resolve(id);
  }
  convert(input: string, params: ConvertParams): Promise<string> {
    this.calls.push({ method: "POST /v3/models/convert", body: { input, ...params } });
    if (this.rejectNextConverts > 0) {
      this.rejectNextConverts--;
      return Promise.reject(new TripoError("/v3/models/convert: invalid input", 400, 2002));
    }
    if (this.reject5xxNextConverts > 0) {
      this.reject5xxNextConverts--;
      return Promise.reject(new TripoError("/v3/models/convert: upstream error", 502, 2003));
    }
    const id = `${params.face_limit === 20000 ? "map" : "hero"}-${++this.n}`;
    this.tasks.set(id, { type: "convert_model", polls: 0, params });
    this.created.push(id);
    if (this.loseNextConverts > 0) {
      this.loseNextConverts--;
      return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
    }
    return Promise.resolve(id);
  }
  getTask(id: string): Promise<TripoTask> {
    const t = this.tasks.get(id);
    if (!t) return Promise.reject(new Error(`no such task ${id}`));
    t.polls++;
    if (t.polls < this.pollsToSuccess) return Promise.resolve({ task_id: id, status: "running", progress: 50 });
    if (t.fail) return Promise.resolve({ task_id: id, status: t.fail as TripoTask["status"] });
    const which = id.startsWith("map") ? "twin" : "hero";
    const output = t.type === "convert_model" ? { model_url: this.modelUrls[which] } : { model_url: "fake://gen.glb", rendered_image_url: "fake://gen.webp" };
    return Promise.resolve({ task_id: id, status: "success", progress: 100, output });
  }
  balance(): Promise<number> {
    this.calls.push({ method: "GET /v3/account/balance", body: null });
    return Promise.resolve(this.balanceValue);
  }
}

export type FakeWorldOptions = {
  jobs?: Job[];
  flags?: Flags | null;
  carScans?: Record<string, Uint8Array>; // "<scan>/<file>" -> bytes
  models?: Record<string, Uint8Array>; // published name -> bytes
  fakeUrls?: Record<string, Uint8Array>; // fake://… -> bytes (Tripo model downloads)
  tripo?: TripoApi;
  now?: Date;
  /** Real public-bucket HEAD for names not in `models` (dry run only). */
  publicModelBase?: string;
  quiet?: boolean;
  /** Force upload() to report duplicate for these names (409 simulation). */
  duplicateOn?: Set<string>;
  /** The bytes the bucket "already had" for a duplicateOn name (default: a foreign 3-byte file). */
  duplicateBytes?: Record<string, Uint8Array>;
  /** Make download() report expired N times for a url. */
  expireOnce?: Set<string>;
};

/** Everything the worker can observe or change, in memory, with a controllable clock. */
export class FakeWorld {
  jobs: Map<string, Job>;
  flags: Flags | null;
  carScans: Map<string, Uint8Array>;
  models: Map<string, Uint8Array>;
  fakeUrls: Map<string, Uint8Array>;
  breadcrumbs: { handle: string | null; message: string }[] = [];
  logs: string[] = [];
  publishOrder: string[] = [];
  tripo: TripoApi;
  clock: Date;
  publicModelBase?: string;
  quiet: boolean;
  duplicateOn: Set<string>;
  duplicateBytes: Map<string, Uint8Array>;
  expireOnce: Set<string>;

  constructor(o: FakeWorldOptions = {}) {
    this.jobs = new Map((o.jobs ?? []).map((j) => [j.scan_id, structuredClone(j)]));
    this.flags = o.flags === undefined ? { ...DEFAULT_FLAGS } : o.flags;
    this.carScans = new Map(Object.entries(o.carScans ?? {}));
    this.models = new Map(Object.entries(o.models ?? {}));
    this.fakeUrls = new Map(Object.entries(o.fakeUrls ?? {}));
    this.tripo = o.tripo ?? new FakeTripo();
    this.clock = o.now ?? new Date(FAKE_EPOCH);
    this.publicModelBase = o.publicModelBase;
    this.quiet = o.quiet ?? true;
    this.duplicateOn = o.duplicateOn ?? new Set();
    this.duplicateBytes = new Map(Object.entries(o.duplicateBytes ?? {}));
    this.expireOnce = o.expireOnce ?? new Set();
  }

  advance(seconds: number) {
    this.clock = new Date(this.clock.getTime() + seconds * 1000);
  }

  job(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  }

  deps(): Deps {
    // deno-lint-ignore no-this-alias
    const w = this;
    return {
      now: () => new Date(w.clock.getTime()),
      flags: () => Promise.resolve(w.flags ? { ...w.flags } : null),
      setFlags(patch) {
        if (!w.flags) throw new Error("flags unreadable");
        w.flags = { ...w.flags, ...patch };
        return Promise.resolve();
      },
      claim(tickId, scan) {
        const now = w.clock.getTime();
        const terminal: JobStatus[] = ["done", "failed", "skipped"];
        // Mirror of claim_scan_job(): at most ONE live lease in `fetching` at a time.
        const fetchingLeased = [...w.jobs.values()].some((j) => j.status === "fetching" && !!j.lease_until && new Date(j.lease_until).getTime() > now);
        const candidates = [...w.jobs.values()]
          .filter((j) => !terminal.includes(j.status))
          .filter((j) => !j.lease_until || new Date(j.lease_until).getTime() < now)
          .filter((j) => (scan ? j.scan_id === scan : new Date(j.next_run_at).getTime() <= now))
          .filter((j) => !(j.status === "fetching" && fetchingLeased))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        const j = candidates[0];
        if (!j) return Promise.resolve(null);
        j.lease_until = new Date(now + 170_000).toISOString();
        j.locked_by = tickId;
        j.updated_at = w.clock.toISOString();
        return Promise.resolve(structuredClone(j));
      },
      updateJob(scanId, patch: JobPatch) {
        const j = w.job(scanId);
        Object.assign(j, patch);
        return Promise.resolve();
      },
      countUserRenders(handle, excludeScan) {
        return Promise.resolve([...w.jobs.values()].filter((j) => j.handle === handle && j.credits_spent > 0 && j.scan_id !== excludeScan).length);
      },
      creditsLast24h() {
        const since = w.clock.getTime() - 24 * 3600 * 1000;
        return Promise.resolve(
          [...w.jobs.values()].filter((j) => j.generate_submitted_at && new Date(j.generate_submitted_at).getTime() > since).reduce((s, j) => s + j.credits_spent, 0),
        );
      },
      breadcrumb(handle, message) {
        w.breadcrumbs.push({ handle, message });
        if (!w.quiet) console.log(`  crumb  ${message}`);
        return Promise.resolve();
      },
      listScan(scanId) {
        const out: FolderEntry[] = [];
        for (const [path, bytes] of w.carScans) {
          if (path.startsWith(scanId + "/")) out.push({ name: path.slice(scanId.length + 1), size: bytes.byteLength });
        }
        return Promise.resolve(out);
      },
      downloadScanFile(path) {
        const b = w.carScans.get(path);
        if (!b) return Promise.reject(new Error(`download car-scans/${path}: not found`));
        return Promise.resolve(b);
      },
      async modelExists(name) {
        if (w.models.has(name)) return true;
        if (w.publicModelBase) {
          const res = await fetch(`${w.publicModelBase}/${name}`, { method: "HEAD" });
          return res.ok;
        }
        return false;
      },
      uploadModel(name, bytes) {
        if (w.models.has(name) || w.duplicateOn.has(name)) {
          if (!w.models.has(name)) w.models.set(name, w.duplicateBytes.get(name) ?? new Uint8Array([1, 2, 3])); // a foreign file unless told otherwise
          return Promise.resolve("duplicate");
        }
        w.models.set(name, bytes);
        w.publishOrder.push(name);
        if (!w.quiet) console.log(`  WOULD PUBLISH models/${name} (${bytes.byteLength} B, upsert:false)`);
        return Promise.resolve("ok");
      },
      fetchModelPublic(name) {
        return Promise.resolve(w.models.get(name) ?? null);
      },
      async download(url, signal) {
        if (w.expireOnce.has(url)) {
          w.expireOnce.delete(url);
          return "expired";
        }
        if (url.startsWith("fake://")) {
          const b = w.fakeUrls.get(url);
          return b ? b : "expired";
        }
        const res = await fetch(url, { signal });
        if (res.status === 403 || res.status === 404) return "expired";
        if (!res.ok) throw new Error(`download HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      tripo: w.tripo,
      log(m) {
        w.logs.push(m);
        if (!w.quiet) console.log(`  ${m}`);
      },
    };
  }
}

// ── synthetic GLB (for tests that must not depend on scratchpad fixtures) ─────

export type TestGlbOptions = {
  verts?: number; // total vertex count (>= 3)
  indexType?: 5123 | 5125;
  sizeX?: number;
  minY?: number;
  centreX?: number;
  withMR?: boolean;
  mrFormat?: "png";
};

/** A valid glTF 2.0 GLB: one mesh, one primitive, POSITION/NORMAL/TEXCOORD_0, indices,
 *  one material with a baseColor + metallicRoughness PNG, all bufferViews embedded. */
export function makeTestGlb(o: TestGlbOptions = {}): Uint8Array {
  const verts = Math.max(3, o.verts ?? 3);
  const indexType = o.indexType ?? 5123;
  const sizeX = o.sizeX ?? 1.9101;
  const minY = o.minY ?? 0;
  const centreX = o.centreX ?? 0;
  const withMR = o.withMR ?? true;
  const pos = new Float32Array(verts * 3);
  for (let i = 0; i < verts; i++) {
    pos[i * 3] = centreX - sizeX / 2 + (sizeX * i) / (verts - 1);
    pos[i * 3 + 1] = minY + (i % 2) * 0.66;
    pos[i * 3 + 2] = -0.467 + (0.934 * ((i * 7) % verts)) / verts;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts; i++) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], pos[i * 3 + c]);
      max[c] = Math.max(max[c], pos[i * 3 + c]);
    }
  }
  const triCount = Math.max(1, verts - 2);
  const idxCount = triCount * 3;
  const idx = indexType === 5123 ? new Uint16Array(idxCount) : new Uint32Array(idxCount);
  for (let t = 0; t < triCount; t++) {
    idx[t * 3] = 0;
    idx[t * 3 + 1] = t + 1;
    idx[t * 3 + 2] = t + 2;
  }
  const normals = new Float32Array(verts * 3).fill(0);
  for (let i = 0; i < verts; i++) normals[i * 3 + 1] = 1;
  const uv = new Float32Array(verts * 2).fill(0.5);
  const png = (w: number, h: number, fill: [number, number, number, number]) => {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
      p.data[i * 4] = fill[0] + (i % 3);
      p.data[i * 4 + 1] = fill[1] + (i % 5);
      p.data[i * 4 + 2] = fill[2] + (i % 7);
      p.data[i * 4 + 3] = fill[3];
    }
    const out = PNG.sync.write(p);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };
  const base = png(4, 4, [120, 40, 40, 255]);
  const mr = png(4, 4, [255, 100, 200, 255]);

  const views: { bytes: Uint8Array; target?: number }[] = [
    { bytes: new Uint8Array(pos.buffer), target: 34962 },
    { bytes: new Uint8Array(normals.buffer), target: 34962 },
    { bytes: new Uint8Array(uv.buffer), target: 34962 },
    { bytes: new Uint8Array(idx.buffer), target: 34963 },
    { bytes: base },
    { bytes: mr },
  ];
  const bufferViews: Record<string, number>[] = [];
  let cursor = 0;
  const parts: Uint8Array[] = [];
  for (const v of views) {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      cursor += pad;
    }
    const bv: Record<string, number> = { buffer: 0, byteOffset: cursor, byteLength: v.bytes.byteLength };
    if (v.target) bv.target = v.target;
    bufferViews.push(bv);
    parts.push(v.bytes);
    cursor += v.bytes.byteLength;
  }
  const bin = new Uint8Array(cursor);
  let off = 0;
  for (const p of parts) {
    bin.set(p, off);
    off += p.byteLength;
  }
  const json = {
    asset: { version: "2.0", generator: "scan-worker test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: verts, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: verts, type: "VEC2" },
      { bufferView: 3, componentType: indexType, count: idxCount, type: "SCALAR" },
    ],
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
    images: [{ bufferView: 4, mimeType: "image/png" }, { bufferView: 5, mimeType: "image/png" }],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [
      {
        pbrMetallicRoughness: withMR ? { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } } : { baseColorTexture: { index: 0 } },
      },
    ],
  };
  return writeGlb({ json, bin });
}

export function bytesOf(n: number, fill = 0x42): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

export const ENABLEWHORE_MANIFEST = JSON.stringify({
  handle: "Enablewhore",
  platform: "ios",
  car: { year: "2024", make: "Toyota", model: "GR Corolla", color: "Icecap White", vehicleClass: null },
  capturedAt: "2026-09-02T01:57:37.242Z",
  scanId: "enablewhore-20260901-185736",
  uploaded: 4,
  failed: [],
  shots: ["front", "right", "rear", "left"],
});

/** A complete, realistic car-scans folder for `scanId` (sizes from the live bucket). */
export function seedFolder(scanId: string, manifest?: string): Record<string, Uint8Array> {
  if (manifest === undefined) {
    const m = JSON.parse(ENABLEWHORE_MANIFEST);
    m.scanId = scanId;
    m.handle = scanId.split("-")[0]; // the app's newScanId() prefixes the folder with the normalised handle
    manifest = JSON.stringify(m);
  }
  return {
    [`${scanId}/01-front.jpg`]: bytesOf(468700),
    [`${scanId}/02-right.jpg`]: bytesOf(790526),
    [`${scanId}/03-rear.jpg`]: bytesOf(835831),
    [`${scanId}/04-left.jpg`]: bytesOf(640865),
    [`${scanId}/manifest.json`]: new TextEncoder().encode(manifest),
  };
}

export function pngBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
