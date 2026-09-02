// deps.ts — the REAL `Deps`: supabase-js (service role) + TripoClient + fetch.
//
// Split out of index.ts so it can be unit-tested (index.ts starts Deno.serve at import
// time). Nothing here has run against the live project from this repo — see
// SCAN-WORKER-DEPLOY.md step 4b for the integration probe that exercises every method
// below with the service role at zero credits.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Deps, Flags, Job, JobPatch, ScanSlot } from "./worker.ts";
import type { TripoApi } from "./tripo.ts";
import { MAX_BYTES } from "./glb.ts";
import type { FolderEntry } from "./manifest.ts";

/** Jobs actively holding a Tripo task (part 2, item C) — mirrors MAX_ACTIVE_TRIPO's set. */
const ACTIVE_TRIPO_STATUSES = ["generating", "converting_map", "converting_hero"] as const;

/** Storage returns HTTP 409 for an existing key. storage-js surfaces it as
 *  StorageApiError { status: 409, statusCode: <body.statusCode || body.code || "409">,
 *  code?: "ResourceAlreadyExists" | "KeyAlreadyExists" } (lib/common/fetch.ts
 *  handleError, 2.112.4); the legacy body is {statusCode:"409", error:"Duplicate",
 *  message:"The resource already exists"} (docs/guides/storage/debugging/error-codes). */
export function isDuplicateUploadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; error?: unknown };
  if (Number(e.status) === 409 || String(e.statusCode ?? "") === "409") return true;
  if (e.code === "ResourceAlreadyExists" || e.code === "KeyAlreadyExists") return true;
  if (String(e.error ?? "").toLowerCase() === "duplicate") return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
}

export type MakeDepsOptions = { fetchImpl?: typeof fetch };

export function makeDeps(supa: SupabaseClient, supabaseUrl: string, tripo: TripoApi, log: (m: string) => void, opts: MakeDepsOptions = {}): Deps {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const publicModel = (name: string) => `${supabaseUrl}/storage/v1/object/public/models/${name}`;
  return {
    now: () => new Date(),
    async flags(): Promise<Flags | null> {
      const { data, error } = await supa.from("pipeline_flags").select("enabled,daily_credit_cap,per_user_cap,min_balance,paused_reason,require_slot").eq("id", 1).maybeSingle();
      if (error || !data) {
        log(`flags unreadable: ${error?.message ?? "no row"} -> disabled`);
        return null;
      }
      // require_slot defaults to false (never spend was already the door of the older,
      // pre-slot code path) rather than trusting the column to be non-null: it's added
      // by migration 20260902002000_scan_slots.sql (NOT NULL DEFAULT false) so a live
      // project always has it, but a null/missing value here still means "the transition
      // hasn't been flipped yet" — the exact state before this column existed at all.
      return { ...(data as Flags), require_slot: Boolean((data as { require_slot?: boolean | null }).require_slot) };
    },
    async setFlags(patch) {
      const { error } = await supa.from("pipeline_flags").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw new Error(`setFlags: ${error.message}`);
    },
    async claim(tickId, scan) {
      const { data, error } = await supa.rpc("claim_scan_job", { p_tick: tickId, p_scan: scan ?? null });
      if (error) throw new Error(`claim_scan_job: ${error.message}`);
      const rows = (data ?? []) as Job[];
      return rows[0] ?? null;
    },
    async updateJob(scanId, patch: JobPatch) {
      const { error } = await supa.from("car_scan_jobs").update(patch).eq("scan_id", scanId);
      if (error) throw new Error(`updateJob: ${error.message}`);
    },
    async countUserRenders(handle, excludeScan, userId) {
      // Item F: `userId` (from the job's server-issued slot) is the real key when the
      // job has one — it cannot be forged. `handle` (the manifest's, client-supplied)
      // stays the fallback for legacy slot-less jobs and hand-seeded rows, unchanged.
      let q = supa.from("car_scan_jobs").select("scan_id", { count: "exact", head: true }).gt("credits_spent", 0).neq("scan_id", excludeScan);
      q = userId ? q.eq("user_id", userId) : q.eq("handle", handle);
      const { count, error } = await q;
      if (error) throw new Error(`countUserRenders: ${error.message}`);
      return count ?? 0;
    },
    async creditsLast24h() {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data, error } = await supa.from("car_scan_jobs").select("credits_spent").gt("generate_submitted_at", since);
      if (error) throw new Error(`creditsLast24h: ${error.message}`);
      return (data ?? []).reduce((s, r) => s + (r.credits_spent ?? 0), 0);
    },
    async breadcrumb(handle, message) {
      // Same table + shape the app's breadcrumbs use (src/crashBreadcrumb.ts: is_fatal:false, late:false).
      const { error } = await supa.from("crash_reports").insert({ handle, message: message.slice(0, 900), is_fatal: false, late: false, platform: "worker" });
      if (error) log(`breadcrumb failed: ${error.message}`);
    },
    async listScan(scanId): Promise<FolderEntry[]> {
      const { data, error } = await supa.storage.from("car-scans").list(scanId, { limit: 100 });
      if (error) throw new Error(`list car-scans/${scanId}: ${error.message}`);
      // storage-js FileObject: `metadata: FileMetadata | null` — null for folder rows
      // (lib/types.ts 2.112.4); real objects carry metadata.size.
      return (data ?? [])
        .filter((o) => o && o.name && o.metadata)
        .map((o) => ({ name: o.name, size: Number((o.metadata as { size?: number })?.size ?? 0) }));
    },
    async downloadScanFile(path) {
      const { data, error } = await supa.storage.from("car-scans").download(path);
      if (error || !data) throw new Error(`download car-scans/${path}: ${error?.message ?? "no data"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async modelExists(name) {
      const res = await fetchImpl(publicModel(name), { method: "HEAD" });
      return res.ok;
    },
    async uploadModel(name, bytes) {
      const { error } = await supa.storage.from("models").upload(name, bytes, { contentType: "model/gltf-binary", upsert: false });
      if (!error) return "ok";
      if (isDuplicateUploadError(error)) return "duplicate";
      throw new Error(`upload models/${name}: ${error.message}`);
    },
    async fetchModelPublic(name) {
      const res = await fetchImpl(publicModel(name), { cache: "no-store" });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
    async download(url, signal) {
      const res = await fetchImpl(url, { signal });
      if (res.status === 403 || res.status === 404) return "expired";
      if (!res.ok) throw new Error(`model download HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) throw new Error(`model download ${len} B exceeds ${MAX_BYTES}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getSlot(scanId): Promise<ScanSlot | null> {
      const { data, error } = await supa.from("scan_slots").select("scan_id,user_id,handle,tier,consumed_at,released_at").eq("scan_id", scanId).maybeSingle();
      if (error) throw new Error(`getSlot: ${error.message}`);
      return (data as ScanSlot | null) ?? null;
    },
    async consumeSlot(scanId) {
      const { error } = await supa.from("scan_slots").update({ consumed_at: new Date().toISOString() }).eq("scan_id", scanId).is("consumed_at", null);
      if (error) throw new Error(`consumeSlot: ${error.message}`);
    },
    async releaseSlot(scanId) {
      // No `.is('released_at', null)` guard: idempotent either way (a second release just
      // re-writes the same kind of timestamp), and item G's callers only ever release once.
      const { error } = await supa.from("scan_slots").update({ released_at: new Date().toISOString() }).eq("scan_id", scanId);
      if (error) throw new Error(`releaseSlot: ${error.message}`);
    },
    async countActiveTripo() {
      const { count, error } = await supa.from("car_scan_jobs").select("scan_id", { count: "exact", head: true }).in("status", ACTIVE_TRIPO_STATUSES);
      if (error) throw new Error(`countActiveTripo: ${error.message}`);
      return count ?? 0;
    },
    tripo,
    log,
  };
}
