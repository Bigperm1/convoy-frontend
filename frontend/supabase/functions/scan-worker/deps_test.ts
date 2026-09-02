// deps_test.ts — the REAL I/O layer (deps.ts) against duck-typed supabase-js / fetch
// stand-ins. This is the only place the production storage/DB code paths run before
// the integration probe in SCAN-WORKER-DEPLOY.md step 4b.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isDuplicateUploadError, makeDeps } from "./deps.ts";
import { FakeTripo } from "./fakes.ts";
import { MAX_BYTES } from "./glb.ts";

type UploadError = Record<string, unknown> | null;

function fakeSupa(o: { uploadError?: UploadError; listRows?: unknown[]; listError?: { message: string } | null } = {}): SupabaseClient {
  const calls: unknown[] = [];
  const supa = {
    calls,
    storage: {
      from: (bucket: string) => ({
        upload: (name: string, bytes: Uint8Array, opts: unknown) => {
          calls.push({ bucket, name, bytes: bytes.byteLength, opts });
          return Promise.resolve({ data: o.uploadError ? null : { path: name }, error: o.uploadError ?? null });
        },
        list: (prefix: string, opts: unknown) => {
          calls.push({ bucket, list: prefix, opts });
          return Promise.resolve({ data: o.listError ? null : (o.listRows ?? []), error: o.listError ?? null });
        },
        download: (path: string) => {
          calls.push({ bucket, download: path });
          return Promise.resolve({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
        },
      }),
    },
  };
  return supa as unknown as SupabaseClient;
}

const URL_BASE = "https://example.supabase.co";
const deps = (supa: SupabaseClient, fetchImpl?: typeof fetch) => makeDeps(supa, URL_BASE, new FakeTripo(), () => {}, { fetchImpl });

Deno.test("isDuplicateUploadError: every shape storage-js can hand back for an existing key", () => {
  // StorageApiError as built by lib/common/fetch.ts handleError (2.112.4) for HTTP 409:
  //   status = 409 (number), statusCode = body.statusCode || body.code || "409", code = body.code
  assert(isDuplicateUploadError({ name: "StorageApiError", message: "The resource already exists", status: 409, statusCode: "409", code: undefined }));
  assert(isDuplicateUploadError({ name: "StorageApiError", message: "The specified resource already exists.", status: 409, statusCode: "ResourceAlreadyExists", code: "ResourceAlreadyExists" }));
  assert(isDuplicateUploadError({ name: "StorageApiError", message: "The specified key already exists.", status: 409, statusCode: "KeyAlreadyExists", code: "KeyAlreadyExists" }));
  // non-JSON body fallback: statusCode = status + "", message = statusText
  assert(isDuplicateUploadError({ name: "StorageApiError", message: "Conflict", status: 409, statusCode: "409" }));
  // legacy body shape reaching the caller raw
  assert(isDuplicateUploadError({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }));
  // and the negatives
  assert(!isDuplicateUploadError({ name: "StorageApiError", message: "new row violates row-level security policy", status: 403, statusCode: "403" }));
  assert(!isDuplicateUploadError({ name: "StorageUnknownError", message: "fetch failed" }));
  assert(!isDuplicateUploadError(null));
  assert(!isDuplicateUploadError("409"));
});

Deno.test("uploadModel: ok / duplicate / throw, always upsert:false with the GLB content type", async () => {
  const ok = fakeSupa();
  assertEquals(await deps(ok).uploadModel("scan_x_map.glb", new Uint8Array(5)), "ok");
  const call = (ok as unknown as { calls: { bucket: string; name: string; opts: { upsert: boolean; contentType: string } }[] }).calls[0];
  assertEquals(call.bucket, "models");
  assertEquals(call.opts.upsert, false);
  assertEquals(call.opts.contentType, "model/gltf-binary");

  const dup = fakeSupa({ uploadError: { name: "StorageApiError", message: "The resource already exists", status: 409, statusCode: "409" } });
  assertEquals(await deps(dup).uploadModel("scan_x_map.glb", new Uint8Array(5)), "duplicate");

  const dupNew = fakeSupa({ uploadError: { name: "StorageApiError", message: "The specified key already exists.", status: 409, statusCode: "KeyAlreadyExists", code: "KeyAlreadyExists" } });
  assertEquals(await deps(dupNew).uploadModel("scan_x_map.glb", new Uint8Array(5)), "duplicate");

  const boom = fakeSupa({ uploadError: { name: "StorageApiError", message: "Internal error", status: 500, statusCode: "500" } });
  await assertRejects(() => deps(boom).uploadModel("scan_x_map.glb", new Uint8Array(5)), Error, "upload models/scan_x_map.glb: Internal error");
});

Deno.test("listScan: folder rows (metadata null) are dropped, sizes come from metadata.size, errors throw", async () => {
  const rows = [
    { name: "01-front.jpg", id: "a", updated_at: "x", created_at: "x", last_accessed_at: "x", metadata: { size: 468700, mimetype: "image/jpeg", eTag: "e", cacheControl: "c", lastModified: "x", contentLength: 468700 } },
    { name: "manifest.json", id: "b", updated_at: "x", created_at: "x", last_accessed_at: "x", metadata: { size: 376, mimetype: "application/json", eTag: "e", cacheControl: "c", lastModified: "x", contentLength: 376 } },
    { name: "nested", id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null },
  ];
  const supa = fakeSupa({ listRows: rows });
  assertEquals(await deps(supa).listScan("tester-1"), [{ name: "01-front.jpg", size: 468700 }, { name: "manifest.json", size: 376 }]);
  const call = (supa as unknown as { calls: { bucket: string; list: string }[] }).calls[0];
  assertEquals(call.bucket, "car-scans");
  assertEquals(call.list, "tester-1");
  await assertRejects(() => deps(fakeSupa({ listError: { message: "boom" } })).listScan("tester-1"), Error, "list car-scans/tester-1: boom");
  assertEquals(await deps(fakeSupa({ listRows: [] })).listScan("empty"), []);
});

Deno.test("downloadScanFile returns the bytes; modelExists/fetchModelPublic/download map HTTP statuses the way the worker expects", async () => {
  const seen: { url: string; method: string }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/missing.glb")) return Promise.resolve(new Response("", { status: 400 })); // public bucket: 400 for a missing object (probed live)
    if (url.endsWith("/expired.glb")) return Promise.resolve(new Response("", { status: 403 }));
    if (url.endsWith("/huge.glb")) return Promise.resolve(new Response("", { status: 200, headers: { "content-length": String(MAX_BYTES + 1) } }));
    if (url.endsWith("/boom.glb")) return Promise.resolve(new Response("", { status: 502 }));
    return Promise.resolve(new Response(new Uint8Array([9, 8, 7]), { status: 200 }));
  }) as typeof fetch;
  const d = deps(fakeSupa(), fetchImpl);
  assertEquals(await d.downloadScanFile("tester-1/manifest.json"), new Uint8Array([1, 2, 3]));
  assertEquals(await d.modelExists("scan_x.glb"), true);
  assertEquals(seen[0], { url: `${URL_BASE}/storage/v1/object/public/models/scan_x.glb`, method: "HEAD" });
  assertEquals(await d.modelExists("missing.glb"), false);
  assertEquals(await d.fetchModelPublic("scan_x.glb"), new Uint8Array([9, 8, 7]));
  assertEquals(await d.fetchModelPublic("missing.glb"), null);
  assertEquals(await d.download("https://tripo.example/expired.glb"), "expired");
  assertEquals(await d.download("https://tripo.example/model.glb"), new Uint8Array([9, 8, 7]));
  await assertRejects(() => d.download("https://tripo.example/huge.glb"), Error, "exceeds");
  await assertRejects(() => d.download("https://tripo.example/boom.glb"), Error, "HTTP 502");
});
