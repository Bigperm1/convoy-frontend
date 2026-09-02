// tripo.ts — a thin client for the four Tripo REST calls the worker makes.
//
// EVERY payload here is copied from what tripo-cli 0.3.1 actually sent for the two
// delivered scans (`tripo history --json`, read 2026-09-01), not from the docs site:
//   generate : POST /v3/generation/multiview-to-model
//              { inputs: [{front: <tok>}, {left: <tok>}, {back: <tok>}, {right: <tok>}],
//                model: "v3.1-20260211" }
//              (bare file tokens — the `file_…` string /v3/files returns — in the
//              CLI's fixed order front, left, back, right; pbr/texture/export_uv are
//              SERVER defaults, echoed back in task.input, never sent)
//   convert  : POST /v3/models/convert
//              { input: <gen task id>, format: "GLTF", texture_size, face_limit,
//                export_orientation: "-x", scale_factor: 1.9101, pivot_to_center_bottom: true }
//   task     : GET  /v3/tasks/<id>  -> data.{status, progress, output.model_url}
//              (output key VERIFIED from task.json output_fields: ["model_url", …])
//   balance  : GET  /v3/account/balance -> data.balance
//   upload   : POST /v3/files multipart field `file` -> data.file_token
// Envelope: { code: 0, data } — any non-zero code is an error (dist/core/client.js).
// Insufficient credits is API code 2010 (dist/knowledge/error-catalog.js).

import type { TripoView } from "./manifest.ts";

export const TRIPO_BASE_URL_DEFAULT = "https://openapi.tripo3d.ai";
export const TRIPO_MODEL = "v3.1-20260211";
export const TRIPO_CODE_INSUFFICIENT_CREDITS = 2010;

/** SCAN-PIPELINE.md "The commands" — the map twin recipe. 20,000 faces lands ~14–16k
 *  verts with u16 indices, which is the ONLY thing Mapbox will draw (trap 3). */
export const TWIN_CONVERT = {
  format: "GLTF",
  face_limit: 20000,
  texture_size: 1024,
  export_orientation: "-x",
  scale_factor: 1.9101,
  pivot_to_center_bottom: true,
} as const;

/** The hero recipe. u32 indices are fine here — the Garage hero is WebView-rendered. */
export const HERO_CONVERT = {
  format: "GLTF",
  face_limit: 150000,
  texture_size: 2048,
  export_orientation: "-x",
  scale_factor: 1.9101,
  pivot_to_center_bottom: true,
} as const;

export type ConvertParams = typeof TWIN_CONVERT | typeof HERO_CONVERT;

export type TaskStatus = "queued" | "running" | "success" | "failed" | "cancelled" | "banned" | "expired" | "unknown";

export type TripoTask = {
  task_id: string;
  status: TaskStatus;
  progress?: number;
  output?: Record<string, unknown>;
  credits_consumed?: number;
};

export class TripoError extends Error {
  code?: number;
  httpStatus: number;
  constructor(message: string, httpStatus: number, code?: number) {
    super(message);
    this.name = "TripoError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export class InsufficientCredits extends TripoError {
  constructor(message: string, httpStatus: number) {
    super(message, httpStatus, TRIPO_CODE_INSUFFICIENT_CREDITS);
    this.name = "InsufficientCredits";
  }
}

/** Did Tripo's application layer itself refuse this request? A TripoError carrying an
 *  API `code` means the envelope came back parsed with a non-zero code — the request
 *  was processed and rejected, so no task exists and nothing was charged (Tripo's
 *  documented contract; the worker rolls its ledger back on exactly this case).
 *  Everything else — timeout / abort, network failure, a non-JSON body from a proxy —
 *  is AMBIGUOUS: the task may well have been created, and the caller must never
 *  re-POST on it. There is NO task-listing endpoint to reconcile with: tripo-cli 0.3.1
 *  only has `POST /v3/tasks/list {task_ids}` (lookup by ids you already know). */
export function isDefiniteRejection(e: unknown): boolean {
  return e instanceof TripoError && typeof e.code === "number";
}

export type TripoClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Outer budget (the tick's AbortController). Combined with the per-request timeout. */
  signal?: AbortSignal;
};

export interface TripoApi {
  uploadFile(bytes: Uint8Array, filename: string): Promise<string>;
  generateMultiview(views: Record<TripoView, string>): Promise<string>;
  convert(input: string, params: ConvertParams): Promise<string>;
  getTask(id: string): Promise<TripoTask>;
  balance(): Promise<number>;
}

export class TripoClient implements TripoApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly signal?: AbortSignal;

  constructor(opts: TripoClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? TRIPO_BASE_URL_DEFAULT).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.signal = opts.signal;
  }

  private signalFor(): AbortSignal {
    const t = AbortSignal.timeout(this.timeoutMs);
    return this.signal ? AbortSignal.any([t, this.signal]) : t;
  }

  private async send<T>(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...headers },
      body,
      signal: this.signalFor(),
    });
    let envelope: { code?: number; data?: T; message?: string } | null = null;
    try {
      envelope = await res.json();
    } catch {
      throw new TripoError(`HTTP ${res.status} with non-JSON body from ${path}`, res.status);
    }
    if (!res.ok || !envelope || envelope.code !== 0) {
      const code = envelope?.code;
      const msg = envelope?.message ?? `HTTP ${res.status}`;
      if (code === TRIPO_CODE_INSUFFICIENT_CREDITS) throw new InsufficientCredits(msg, res.status);
      throw new TripoError(`${path}: ${msg}`, res.status, code);
    }
    return envelope.data as T;
  }

  async uploadFile(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "image/jpeg" }), filename);
    const data = await this.send<{ file_token: string }>("POST", "/v3/files", form);
    if (!data?.file_token) throw new TripoError("upload returned no file_token", 200);
    return data.file_token;
  }

  /** Views are sent in the CLI's fixed order front, left, back, right — as one-key
   *  objects, exactly as buildMultiviewToModel() emits them. */
  async generateMultiview(views: Record<TripoView, string>): Promise<string> {
    const order: TripoView[] = ["front", "left", "back", "right"];
    for (const v of order) if (!views[v]) throw new TripoError(`missing view ${v}`, 0);
    const payload = { inputs: order.map((v) => ({ [v]: views[v] })), model: TRIPO_MODEL };
    const data = await this.send<{ task_id: string }>(
      "POST",
      "/v3/generation/multiview-to-model",
      JSON.stringify(payload),
      { "Content-Type": "application/json" },
    );
    if (!data?.task_id) throw new TripoError("generate returned no task_id", 200);
    return data.task_id;
  }

  async convert(input: string, params: ConvertParams): Promise<string> {
    if ((params as Record<string, unknown>).quad) throw new TripoError("quad is forbidden (trap 4)", 0);
    const payload = { input, ...params };
    const data = await this.send<{ task_id: string }>("POST", "/v3/models/convert", JSON.stringify(payload), {
      "Content-Type": "application/json",
    });
    if (!data?.task_id) throw new TripoError("convert returned no task_id", 200);
    return data.task_id;
  }

  async getTask(id: string): Promise<TripoTask> {
    const data = await this.send<TripoTask>("GET", `/v3/tasks/${encodeURIComponent(id)}`);
    const status = (data?.status ?? "unknown") as TaskStatus;
    return { ...data, task_id: data?.task_id ?? id, status };
  }

  async balance(): Promise<number> {
    const data = await this.send<{ balance: number | string }>("GET", "/v3/account/balance");
    const n = Number(data?.balance);
    if (!Number.isFinite(n)) throw new TripoError("balance not numeric", 200);
    return n;
  }
}

/** The GLB url out of a finished task. `model_url` is what both delivered scans
 *  returned (task.json output_fields); `pbr_model` is the documented legacy key. */
export function modelUrlOf(task: TripoTask): string | null {
  const o = task.output ?? {};
  for (const k of ["model_url", "model", "pbr_model", "base_model"]) {
    const v = o[k];
    if (typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") return (v as { url: string }).url;
  }
  return null;
}
