// scan-worker — the automatic photo -> car pipeline (SCAN-PIPELINE.md "Automation").
//
// Jeff, 2026-09-01: "this pipeline is not suppose to have any manual input, it is
// suppose to be all automatic from the photos sent to the delivery of the 3d image and
// 2d twin back to the device it was sent from."
//
// HOW IT RUNS: pg_cron (every 30 s) -> public.scan_worker_tick() -> net.http_post to
// this function with the anon JWT (satisfies the gateway, verify_jwt stays true) plus
// x-worker-key (must equal the SCAN_WORKER_KEY edge secret). One tick advances ONE job
// by ONE state (worker.ts) and returns a JSON summary that lands in
// cron.job_run_details / net._http_response for free.
//
// SECRETS (nothing in this repo). Resolved by resolveSecrets() below:
//   SCAN_WORKER_KEY   Vault 'scan_worker_key' FIRST (the cron caller reads the same row),
//                     Deno.env as fallback — so the two can never drift (Jeff 2026-09-01:
//                     copying the key between two dashboard pages was the confusing step)
//   TRIPO_API_KEY     Deno.env first (set with `supabase secrets set --env-file`), then
//                     Vault 'tripo_api_key'. tsk_… pay-as-you-go; 50 credits = $0.50 per car
//   TRIPO_BASE_URL    optional; the dry-run points it at the local stub
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform. The service
//   role reads the private `car-scans` bucket and writes the public `models` bucket
//   DIRECTLY — fetch-scan / publish-model and their x-publish-key are not involved.
//
// BODY (optional JSON): { "scan": "<scanId>" } pins the tick to one job — the runbook's
// smoke test — still subject to flags, lease, and every spend guard.
//
// The real I/O layer lives in deps.ts (unit-tested); this file only wires it up.

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { runTick, TICK_BUDGET_MS } from "./worker.ts";
import { TripoClient } from "./tripo.ts";
import { makeDeps } from "./deps.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type SecretSource = "vault" | "env" | "missing";

/** One Vault RPC read, `.trim()`'d (item 8: a pasted secret with trailing whitespace must
 *  not silently mismatch `constantTimeEqual`). No isolate-lifetime cache — a rotated
 *  secret (Vault `vault.update_secret` or a `supabase secrets set`) must take effect on
 *  the very next tick, not require a redeploy to bust a stale cache. One extra RPC per
 *  15 s tick is nothing. */
async function readVaultSecret(supa: SupabaseClient, name: string): Promise<string> {
  try {
    const { data, error } = await supa.rpc("vault_secret", { p_name: name });
    if (error || typeof data !== "string") return "";
    return data.trim();
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const supa: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const tickId = `${new Date().toISOString()}#${crypto.randomUUID().slice(0, 8)}`;
  const log = (m: string) => console.log(`scan-worker ${tickId} ${m}`);

  // SCAN_WORKER_KEY is Vault-FIRST (the cron caller reads the same Vault row, so the two
  // can never drift); Deno.env is the fallback. Resolved and compared BEFORE touching the
  // Tripo key at all — the auth check needs only this one secret, so an unauthenticated
  // caller never causes a Tripo-key lookup.
  const vaultWorkerKey = await readVaultSecret(supa, "scan_worker_key");
  const envWorkerKey = (Deno.env.get("SCAN_WORKER_KEY") ?? "").trim();
  const workerKey = vaultWorkerKey || envWorkerKey;
  const workerKeySrc: SecretSource = vaultWorkerKey ? "vault" : envWorkerKey ? "env" : "missing";
  log(`secret worker_key resolved=${workerKeySrc}`); // never the value
  if (!workerKey) {
    log("misconfigured: worker_key missing (checked vault:scan_worker_key, env:SCAN_WORKER_KEY)");
    return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!constantTimeEqual(req.headers.get("x-worker-key") ?? "", workerKey)) {
    return new Response("unauthorized", { status: 401 });
  }

  // TRIPO_API_KEY is env-FIRST (set with `supabase secrets set --env-file`), Vault as
  // fallback. Resolved only now that the caller is authenticated.
  const envTripoKey = (Deno.env.get("TRIPO_API_KEY") ?? "").trim();
  const vaultTripoKey = envTripoKey ? "" : await readVaultSecret(supa, "tripo_api_key");
  const tripoKey = envTripoKey || vaultTripoKey;
  const tripoKeySrc: SecretSource = envTripoKey ? "env" : vaultTripoKey ? "vault" : "missing";
  log(`secret tripo_key resolved=${tripoKeySrc}`); // never the value
  if (!tripoKey) {
    // Refuse to claim anything when misconfigured — fail closed before touching a job.
    log("misconfigured: tripo_key missing (checked env:TRIPO_API_KEY, vault:tripo_api_key)");
    return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let body: { scan?: string; source?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  const scan = typeof body?.scan === "string" && body.scan.length > 0 ? body.scan : undefined;

  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(new Error("tick budget exceeded")), TICK_BUDGET_MS);
  try {
    const tripo = new TripoClient({ apiKey: tripoKey, baseUrl: Deno.env.get("TRIPO_BASE_URL") ?? undefined, signal: controller.signal });
    const result = await runTick(makeDeps(supa, supabaseUrl, tripo, log), { tickId, scan, signal: controller.signal });
    return new Response(JSON.stringify({ tick: tickId, source: body?.source ?? "http", ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    log(`tick threw: ${String((e as Error)?.message ?? e)}`);
    return new Response(JSON.stringify({ tick: tickId, ok: false, error: String((e as Error)?.message ?? e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  } finally {
    clearTimeout(budget);
  }
});
