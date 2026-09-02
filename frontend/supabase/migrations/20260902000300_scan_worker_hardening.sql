-- 20260902000300_scan_worker_hardening.sql — grants/revokes the 2026-09-02 adversarial
-- review found assumed-but-not-recorded. APPLIED LIVE 2026-09-02 via execute_sql and read
-- back with has_function_privilege in the same call. Idempotent.
--
-- (a) claim_scan_job worked for the service role only through Supabase's DEFAULT
--     privileges (the migration revoked public/anon/authenticated and granted nothing).
--     Make the grant explicit so the next environment cannot silently differ.
grant execute on function public.claim_scan_job(text, text) to service_role;

-- (b) the trigger function had no revoke (consistency only — Postgres refuses to call a
--     trigger function directly anyway).
revoke all on function public.car_scan_enqueue() from public, anon, authenticated;

-- (c) scan_worker_tick(): missing Vault rows used to `raise warning` and return null, which
--     pg_cron records as status='succeeded' with simply no HTTP response — an invisible
--     failure. It now raises, so cron.job_run_details shows status='failed' with the text.
--     (The function body lives in supabase/ops/scan_worker_cron.sql, applied by hand; this
--     file only records that the live definition changed.)
