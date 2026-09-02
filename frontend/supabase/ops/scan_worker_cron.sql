-- supabase/ops/scan_worker_cron.sql — the heartbeat: pg_cron every 30 s -> pg_net -> scan-worker.
--
-- DELIBERATELY NOT UNDER supabase/migrations/: `supabase db push` applies every pending
-- migration in one go, and this schedule must only start AFTER the function is deployed
-- and smoke-tested. Apply it by hand at SCAN-WORKER-DEPLOY.md step 6:
--   supabase db query --linked -f supabase/ops/scan_worker_cron.sql
-- (or paste into the SQL editor). It is idempotent: re-running replaces the schedule.
-- Its counterpart is `select cron.unschedule('scan-worker-tick');`.
--
-- APPLY LAST, after (1) the three Vault secrets exist, (2) the edge secrets are set and
-- (3) scan-worker is deployed and answers {idle:'disabled'} to the smoke POST.
-- pipeline_flags.enabled is still FALSE at this point: the cron ticks land as
-- {idle:'disabled'} until the runbook's final UPDATE.
--
-- VERIFIED 2026-09-01 on pgtbjiszjglznjagolse: pg_cron 1.6.4 and pg_net 0.20.0 are
-- available and NOT installed; Postgres 17.6 (sub-minute schedules need >= 15.1.1.61).
-- '30 seconds' is documented pg_cron syntax (docs/guides/cron/quickstart).

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

-- The caller. Reads project_url / anon_key / scan_worker_key from Vault at call time,
-- so no secret is ever stored in cron.job.command (which is readable in the dashboard).
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
    raise warning 'scan_worker_tick: vault secrets missing (project_url/anon_key/scan_worker_key)';
    return null;
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
select cron.schedule('scan-worker-tick', '30 seconds', $$select public.scan_worker_tick()$$);
