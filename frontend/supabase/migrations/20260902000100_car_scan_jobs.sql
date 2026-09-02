-- 20260902000100_car_scan_jobs.sql — the scan worker's state of record + the new-scan trigger.
--
-- VERSION: 14-digit like every row in the live ledger (supabase_migrations.schema_migrations
-- on pgtbjiszjglznjagolse, read 2026-09-01: 20260717220432 … 20260824032822). `supabase db push`
-- applies EVERY pending file in version order and records the version as the unique id,
-- so this is the ONLY new file under migrations/ — the cron schedule lives in
-- supabase/ops/scan_worker_cron.sql and is applied by hand at the runbook's step 6.
--
-- Safe with the scan-worker function undeployed: pipeline_flags.enabled defaults to
-- FALSE, so nothing spends until a human flips it (SCAN-WORKER-DEPLOY.md, last step).
--
-- WHY A TABLE AND NOT THE BUCKET: register-scan counts FOLDERS to cap uploads; this
-- table caps RENDERS (paid). Both stay. scan_id is the primary key, the trigger inserts
-- ON CONFLICT DO NOTHING, and the worker submits a Tripo generate in exactly one
-- transition guarded by tripo_gen_task IS NULL — per-scan single run, enforced twice.
--
-- INTENT BEFORE SPEND: paid_call / paid_call_started_at are written in the SAME row
-- update that adds the credits, immediately BEFORE each Tripo POST, and cleared in the
-- update that stores the task id. A marker with no task id == the tick died inside the
-- POST; the worker never re-POSTs on it (worker.ts lostResponse).

create type public.car_scan_status as enum (
  'queued', 'fetching', 'generating', 'converting_map', 'converting_hero',
  'done', 'failed', 'skipped'
);

create table public.car_scan_jobs (
  scan_id               text primary key
                        check (scan_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  handle                text,                       -- normalised like register-scan's prefix (CLIENT-SUPPLIED via manifest.json)
  status                public.car_scan_status not null default 'queued',
  shots                 text[],                     -- manifest.shots, persisted at queued->fetching; drives the shot->view mapping
  tripo_file_tokens     jsonb,                      -- {front,left,back,right} file tokens (keyed by VIEW)
  tripo_gen_task        text,                       -- set exactly once; never resubmitted
  tripo_map_task        text,
  tripo_hero_task       text,
  credits_spent         int  not null default 0,    -- conservative ledger (Tripo refunds failed tasks)
  convert_retries       int  not null default 0,    -- max 1 per job (expired model URL)
  attempts              int  not null default 0,    -- errors in the current state; 5 => failed
  waits                 int  not null default 0,    -- photos-still-arriving waits; 20 => failed
  state_polls           int  not null default 0,    -- polls in the current state; reset per transition; 60 (gen) / 30 (convert) => timeout
  next_run_at           timestamptz not null default now(),
  lease_until           timestamptz,
  locked_by             text,
  paid_call             text check (paid_call in ('gen', 'map', 'hero')),  -- intent marker (see header)
  paid_call_started_at  timestamptz,
  twin_pending_sha256   text,                       -- sha256 of the twin about to be uploaded; pre-flight reclaims a match
  twin_sha256           text,
  hero_sha256           text,
  twin_published_at     timestamptz,
  hero_published_at     timestamptz,
  last_error            text,
  reason                text,
  generate_submitted_at timestamptz,
  map_submitted_at      timestamptz,
  hero_submitted_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Service role only. No policies on purpose: the shipped anon key gets nothing.
alter table public.car_scan_jobs enable row level security;
create index car_scan_jobs_runnable on public.car_scan_jobs (status, next_run_at);
create index car_scan_jobs_handle   on public.car_scan_jobs (handle);

-- The kill switch + spend caps. ONE row, id = 1.
create table public.pipeline_flags (
  id               int primary key check (id = 1),
  enabled          boolean not null default false,  -- FALSE until the runbook's last step
  daily_credit_cap int     not null default 300,    -- 6 cars / $3 per rolling 24 h
  per_user_cap     int     not null default 2,      -- renders per handle (matches register-scan MAX_SCANS)
  min_balance      int     not null default 100,    -- never generate below this + 50
  finish_hero      boolean not null default true,   -- reserved: switch the hero material pass off without a redeploy
  paused_reason    text,
  updated_at       timestamptz not null default now()
);
insert into public.pipeline_flags (id) values (1) on conflict do nothing;
alter table public.pipeline_flags enable row level security;

-- One claimable job per tick: non-terminal, lease expired, due; oldest first;
-- SKIP LOCKED so two overlapping ticks can never take the same row. p_scan pins one
-- job (the runbook smoke test) and ignores next_run_at but never the lease.
--
-- ONE FETCHING LEASE AT A TIME: `fetching` is the state that reads the spend caps
-- (per-user, daily, balance) and buys the generate. Ticks overlap (cron 30 s, tick up to
-- 130 s ≈ 5 concurrent workers), so two `fetching` jobs running at once could each read
-- the caps before the other's spend landed. The claim therefore hands out a `fetching`
-- row only when no other `fetching` row holds a live lease, and claims are serialised
-- with a transaction-scoped advisory lock so that check is atomic. Polls of the other
-- states are unaffected and still run in parallel.
create or replace function public.claim_scan_job(p_tick text, p_scan text default null)
returns setof public.car_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.claim_scan_job'));
  return query
  update public.car_scan_jobs j
     set lease_until = now() + interval '170 seconds',
         locked_by   = p_tick,
         updated_at  = now()
   where j.scan_id = (
     select c.scan_id
       from public.car_scan_jobs c
      where c.status not in ('done', 'failed', 'skipped')
        and (c.lease_until is null or c.lease_until < now())
        and ((p_scan is not null and c.scan_id = p_scan) or (p_scan is null and c.next_run_at <= now()))
        and not (c.status = 'fetching' and exists (
              select 1 from public.car_scan_jobs f
               where f.status = 'fetching'
                 and f.lease_until > now()
                 and f.scan_id <> c.scan_id))
      order by c.updated_at
      limit 1
      for update skip locked
   )
  returning j.*;
end
$$;
revoke all on function public.claim_scan_job(text, text) from public, anon, authenticated;

-- NEW-SCAN DETECTION: the app uploads the four photos THEN manifest.json
-- (src/carScan.ts uploadScan). An INSERT of <scanId>/manifest.json into car-scans
-- enqueues the scan. The worker re-checks the folder itself, so either upload order
-- is tolerated. (postgres holds TRIGGER on storage.objects — verified 2026-09-01.)
create or replace function public.car_scan_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.bucket_id = 'car-scans' and new.name like '%/manifest.json' then
    insert into public.car_scan_jobs (scan_id, status)
    values (split_part(new.name, '/', 1), 'queued')
    on conflict (scan_id) do nothing;
  end if;
  return new;
exception when others then
  -- Never let a bookkeeping failure reject a tester's upload.
  raise warning 'car_scan_enqueue: %', sqlerrm;
  return new;
end
$$;
drop trigger if exists car_scan_enqueue on storage.objects;
create trigger car_scan_enqueue
  after insert on storage.objects
  for each row execute function public.car_scan_enqueue();

-- Belt and braces: the hand-delivered scans can never be touched or re-spent.
-- credits_spent = 50 so the per-user cap counts them as the renders they were.
insert into public.car_scan_jobs (scan_id, handle, status, reason, credits_spent, twin_published_at, hero_published_at)
values
  ('jeff-20260829-141551',        'jeff',        'done', 'manual-delivered-20260829', 50, '2026-08-29T22:30:00Z', '2026-08-29T22:30:00Z'),
  ('enablewhore-20260901-185736', 'enablewhore', 'done', 'manual-delivered-20260901', 50, '2026-09-02T03:44:00Z', '2026-09-02T03:45:30Z')
on conflict (scan_id) do nothing;

-- Folders that exist in the bucket today but are not scans: pre-mark them so the
-- worker never even lists them.
insert into public.car_scan_jobs (scan_id, status, reason)
values ('claudetest-20260821-000001', 'skipped', 'junk'),
       ('claudetest-20260822-000002', 'skipped', 'junk')
on conflict (scan_id) do nothing;
