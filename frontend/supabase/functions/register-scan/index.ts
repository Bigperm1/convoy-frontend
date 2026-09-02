// register-scan v3 — the bucket-side gate: "does this scan id have a server-issued slot?"
//
// HISTORY. v2 (2026-08-27, Jeff: "cap them at two instances max so they can't … burn
// up my credits") counted FOLDERS per handle prefix in the private car-scans bucket.
// That was a courtesy cap: the handle is whatever the phone writes, a rename resets it,
// and a hand-made upload never calls this function at all. The 2026-09-02 review
// confirmed the hole (ROADMAP §6) and Jeff's launch rule needs a real one: Ultra
// ($14.99) includes two scans, so the slot must be bound to the ACCOUNT.
//
// NOW. The account the client cannot forge is the backend login (Render JWT, `sub` =
// user id). The backend issues the scan id (`POST /api/scan/slot`) after checking the
// account's slot count (and its tier when SCAN_REQUIRE_TIER=1) and writes the slot into
// `public.scan_slots` with its service-role key. This function answers ONE question for
// the app before it uploads — and the worker asks the same question of the table before
// it spends — "is `scanId` a slot the server issued?"
//
// TRANSITION. Testers on older JS still call this with {handle, scanId} where scanId was
// made on the phone and has no slot row. While `pipeline_flags.require_slot` is FALSE
// those fall back to the v2 folder count. Flip require_slot after the OTA is out; from
// then on a slot-less id is refused here AND by the worker.
//
// Same breadcrumb as before (carscan-registered …) so the telemetry queries keep working.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_SCANS = 2; // legacy folder-count cap only; the real cap lives on the backend
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SCAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Gate = { ok: boolean; used: number; max: number; reason?: string; slot?: boolean };

const json = (g: Gate, status = 200) => new Response(JSON.stringify(g), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body handled below
  }
  const handle = String(body?.handle ?? "").trim();
  const scanId = String(body?.scanId ?? "").trim();
  if (handle && !HANDLE_RE.test(handle)) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "bad-handle" }, 400);
  if (scanId && !SCAN_ID_RE.test(scanId)) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "bad-scan-id" }, 400);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // 1. A server-issued slot wins outright (this is the launch path).
  if (scanId) {
    const { data: slot, error } = await supa.from("scan_slots").select("scan_id,user_id,handle,released_at").eq("scan_id", scanId).maybeSingle();
    if (error) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "slot-lookup-failed" }, 503); // fail closed
    if (slot && !slot.released_at) {
      const { count } = await supa.from("scan_slots").select("scan_id", { count: "exact", head: true }).eq("user_id", slot.user_id).is("released_at", null);
      return json({ ok: true, used: count ?? 1, max: MAX_SCANS, slot: true });
    }
  }

  // 2. No slot. Allowed only while the transition flag is off (older JS).
  const { data: flags } = await supa.from("pipeline_flags").select("require_slot").eq("id", 1).maybeSingle();
  if (flags?.require_slot) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "slot-required", slot: false }, 403);
  if (!handle) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "bad-handle" }, 400);

  // 3. LEGACY v2 behaviour, verbatim: count folders for the handle prefix.
  const prefix = handle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
  const { data, error } = await supa.storage.from("car-scans").list("", { limit: 1000 });
  if (error) return json({ ok: false, used: 0, max: MAX_SCANS, reason: "list-failed" }, 503); // fail closed
  // deno-lint-ignore no-explicit-any
  const mine = (data ?? []).filter((e: any) => e?.name?.startsWith(prefix + "-"));
  // deno-lint-ignore no-explicit-any
  const already = !!scanId && mine.some((e: any) => e.name === scanId);
  const used = mine.length;
  const allowed = already || used < MAX_SCANS;
  if (allowed && !already) {
    try {
      await supa.from("crash_reports").insert({ handle, message: `carscan-registered id=${scanId || "(pre)"} used=${used + 1}/${MAX_SCANS} legacy=1` });
    } catch {
      // breadcrumb is best-effort
    }
  }
  return json({ ok: allowed, used, max: MAX_SCANS, reason: allowed ? undefined : "cap", slot: false });
});
