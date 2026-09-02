-- supabase/ops/scan_worker_cron_15s.sql — launch sizing v3 (2026-09-02): the heartbeat
-- tightened from every 30 s to every 15 s. IDENTICAL to scan_worker_cron.sql except the
-- schedule literal — same function body, same job name (so re-running EITHER file
-- upserts the one 'scan-worker-tick' job; do not run both expecting two jobs).
--
-- WHY: worker.ts's poll `wait()` sets `next_run_at = now + POLL_S`. pg_cron's '30 seconds'
-- schedule fires on a fixed wall-clock grid (…:00, :30, :00…), not "30 s after the row
-- became due" — a row whose next_run_at landed a few hundred ms AFTER a grid mark (the
-- normal case: the tick that set it also spent time doing real work) missed that mark by
-- an epsilon and had to wait a FULL EXTRA cron cycle. Observed live, same job, one poll
-- state, POLL_S=30 the whole time: a generate polled at 00:24:19 and again at 00:25:19 —
-- a dead 60 s apart, with an `idle:empty` tick logged in between. The review that found
-- this: "the worker handles ONE job per tick and each job effectively polls every OTHER
-- tick." A 15 s grid (this file) + POLL_S=20 (worker.ts, not a multiple of 15) bounds the
-- worst case to one skipped 15 s mark instead of one skipped 30 s cycle.
--
-- DELIBERATELY NOT UNDER supabase/migrations/ — see scan_worker_cron.sql's header for why
-- the schedule is applied by hand, never by `db push`. Idempotent: re-running replaces the
-- schedule (same job name = upsert). Counterpart: `select cron.unschedule('scan-worker-tick');`.
--
-- VERIFIED 2026-09-01 on pgtbjiszjglznjagolse: pg_cron 1.6.4, Postgres 17.6 (sub-minute
-- schedules need >= 15.1.1.61 — this project qualifies). '15 seconds' is documented
-- pg_cron syntax (docs/guides/cron/quickstart), same as the '30 seconds' it replaces.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

-- The caller. Reads project_url / anon_key / scan_worker_key from Vault at call time,
-- so no secret is ever stored in cron.job.command (which is readable in the dashboard).
-- Identical body to scan_worker_cron.sql's — only the schedule below differs.
create or replace function public.scan_worker_tick()
returns bigint
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_url  text;
  v_anon text;
  v_key  text;
begin
  select decrypted_secret into v_url  from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_anon from vault.decrypted_secrets where name = 'anon_key';
  select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'scan_worker_key';
  if v_url is null or v_anon is null or v_key is null then
    -- raise, don't warn: a warning + null return is recorded by pg_cron as status='succeeded'
    -- with no HTTP response at all — invisible. An exception shows up as status='failed'
    -- with this text in cron.job_run_details.return_message (2026-09-02 review).
    raise exception 'scan_worker_tick: vault secrets missing (project_url/anon_key/scan_worker_key)';
  end if;
  return net.http_post(
    url                  := v_url || '/functions/v1/scan-worker',
    headers              := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || v_anon,
                              'x-worker-key',  v_key),
    body                 := jsonb_build_object('source', 'pg_cron', 'at', now()),
    timeout_milliseconds := 150000
  );
end
$$;
revoke all on function public.scan_worker_tick() from public, anon, authenticated;

-- Idempotent schedule: re-running this file replaces the job (same name = upsert).
select cron.unschedule('scan-worker-tick')
 where exists (select 1 from cron.job where jobname = 'scan-worker-tick');
select cron.schedule('scan-worker-tick', '15 seconds', $$select public.scan_worker_tick()$$);
