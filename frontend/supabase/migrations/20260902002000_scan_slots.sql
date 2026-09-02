-- 20260902002000_scan_slots.sql — server-issued scan slots: the thing the worker trusts.
--
-- WHY (review 2026-09-02 + Jeff's launch rule "Ultra $14.99 includes two scans"):
-- today identity is `manifest.handle`, written by the phone; a rename or a hand-made
-- upload gets unlimited renders. The account the client CANNOT forge is the backend
-- login (Render, JWT `sub` = user id, verified by get_current_user). So the BACKEND
-- issues the scan id after checking the account's slot count (and, when
-- SCAN_REQUIRE_TIER=1, its tier), and writes the slot here with the service-role key
-- it already holds (convoy-backend/supabase_admin.py). register-scan and the worker
-- then refuse any folder whose scan_id has no slot row.
--
-- RevenueCat is NOT in the app yet (verified: 0 hits in package.json/yarn.lock,
-- paywall is a stub) — `tier` is set by the backend (admin endpoint now; RevenueCat
-- webhook when the SDK ships). Enforcement is a backend switch, not a schema change.
--
-- Service role only. No policies on purpose.

create table public.scan_slots (
  scan_id     text primary key
              check (scan_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  user_id     text not null,                 -- backend account id (uuid4), never the handle
  handle      text,                          -- snapshot at issue time, for humans/telemetry
  tier        text,                          -- snapshot at issue time
  issued_at   timestamptz not null default now(),
  consumed_at timestamptz,                   -- set by the worker when it takes the job
  released_at timestamptz                    -- set if the render FAILED (slot given back)
);
alter table public.scan_slots enable row level security;
create index scan_slots_user on public.scan_slots (user_id);

-- Transition switch: while testers are still on JS that does not request a slot,
-- the worker accepts slot-less folders. Flip AFTER the OTA is out.
alter table public.pipeline_flags add column if not exists require_slot boolean not null default false;
