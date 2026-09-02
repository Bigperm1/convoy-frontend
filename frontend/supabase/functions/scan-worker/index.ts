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
// SECRETS (Deno.env only — nothing in this repo):
//   SCAN_WORKER_KEY   shared with Vault 'scan_worker_key' for the cron caller
//   TRIPO_API_KEY     tsk_… (pay-as-you-go; 50 credits = $0.50 per car)
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
import { runTick } from "./worker.ts";
import { TripoClient } from "./tripo.ts";
import { makeDeps } from "./deps.ts";

const TICK_BUDGET_MS = 130_000; // under the 150 s free-plan wall clock (docs: functions/limits)

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const workerKey = Deno.env.get("SCAN_WORKER_KEY") ?? "";
  const tripoKey = Deno.env.get("TRIPO_API_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!workerKey || !tripoKey || !supabaseUrl || !serviceKey) {
    // Refuse to claim anything when misconfigured — fail closed before touching a job.
    return new Response(JSON.stringify({ ok: false, error: "misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!constantTimeEqual(req.headers.get("x-worker-key") ?? "", workerKey)) {
    return new Response("unauthorized", { status: 401 });
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
  const tickId = `${new Date().toISOString()}#${crypto.randomUUID().slice(0, 8)}`;
  const log = (m: string) => console.log(`scan-worker ${tickId} ${m}`);
  try {
    const supa = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
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
