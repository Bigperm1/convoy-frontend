-- 20260902003000_car_scan_jobs_user_id.sql — persists the backend account id on the
-- job row itself, once a server-issued scan slot (20260902002000_scan_slots.sql) has
-- supplied one.
--
-- WHY A COLUMN AND NOT A JOIN: worker.ts's per-user cap (item F) and the
-- release-on-failure rule (item G) both need to know, for a JOB already in flight,
-- "does this job hold a consumed slot, and for which account" — cheaply, on every
-- tick, without a second round trip to scan_slots per job. stepQueued copies
-- scan_slots.user_id onto the job in the SAME commit that consumes the slot
-- (queued -> fetching); a legacy slot-less job (require_slot was false at the time)
-- simply never gets one, and keeps counting against its manifest handle as before.
--
-- Idempotent: `add column if not exists` / `create index if not exists`.

alter table public.car_scan_jobs add column if not exists user_id text;
create index if not exists car_scan_jobs_user on public.car_scan_jobs (user_id);
