-- supabase/ops/cron_run_details_cleanup.sql — daily purge of pg_cron's run log (2026-09-15).
--
-- WHY: Supabase emailed 2026-09-14 that the project is depleting its Disk IO Budget (FREE plan,
-- Nano, 408 MB RAM, ~410 MB in swap all day). pg_cron logs EVERY run of 'scan-worker-tick'
-- (every 15 s = ~5,760 rows/day) into cron.job_run_details and nothing ever deleted them:
-- 75,550 rows / 12 MB on 2026-09-15. Nothing in the app, backend or edge functions reads that
-- table; SCAN-WORKER-DEPLOY.md only reads the last 3 rows to prove the tick is firing.
--
-- Applied by hand 2026-09-15 (Jeff: "do 1 and 2"): one-off delete of rows older than 1 day
-- (69,844 rows), then this schedule. Car models (storage bucket `models`), scan photos
-- (`car-scans`) and car_scan_jobs are NOT touched.
--
-- NOT RECLAIMED: the table stays 12 MB on disk and net._http_response stays ~86 MB. Both are
-- owned by supabase_admin, so `postgres` cannot VACUUM FULL them; the freed space is reused by
-- new rows instead. net._http_response is already trimmed by pg_net itself (pg_net.ttl = 6 hours).
--
-- DELIBERATELY NOT UNDER supabase/migrations/ — same reason as scan_worker_cron.sql. Idempotent:
-- same job name = upsert. Counterpart: `select cron.unschedule('cron-run-details-cleanup');`.

-- one-off (already run 2026-09-15):
-- delete from cron.job_run_details where end_time < now() - interval '1 day';

select cron.schedule(
  'cron-run-details-cleanup',
  '17 10 * * *',   -- 10:17 UTC daily = 03:17 PDT, when nobody is driving
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$
);
