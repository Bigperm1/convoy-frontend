<!-- ═════════ RULE #1 — READ THIS BEFORE ANYTHING ELSE ═════════ -->
# 🛑 NO GUESSING. NO THEORIZING. NO HALLUCINATING.

**Every claim is VERIFIED, or the word HYPOTHESIS is said out loud. No exceptions.**

- **VERIFIED** = I ran the query · read the file · measured it · asked Jeff — and I can show the receipt.
- Reading code and reasoning about it is **NOT** verification. Neither is *"it would explain the symptom."*
- **Never** state a root cause, a fix, or a conclusion I have not tested. Not even a likely-sounding one.
- **Check the instrumentation that ALREADY EXISTS** before inventing an explanation. It usually answers it.
- Separate cleanly: *what the data shows* vs *what I don't know*. Put the unknowns in writing.
- **"I don't know — here is the ONE check that would settle it"** is a GOOD answer.
  A confident wrong answer costs a day and burns trust.

> Jeff, 2026-08-21, in caps: **"ABSOLUTLEY STOP GUESSING, NO THEORYIZING, NO HALLUCENATIONS."**
> Trigger: I declared `ADVANCE_THRESHOLD_M = 25` the root cause of a stuck step index — from a code read alone,
> presented as a finding. The `turn=` breadcrumb, **already in the logs**, refuted it in a single query.
> The instrumentation existed. I guessed instead of reading it. Then I did it again with the timezone.
<!-- ═════════ END RULE #1 ═════════ -->

# Convoy — Hazards Table Setup (Supabase)

This file documents the schema the **Convoy** app expects in your Supabase
project for the community-driven hazards system. You've already created
the table and enabled Realtime / RLS. The block below is for reference,
plus a small **migration** to add the `disputes` column required for the
new community moderation feature.

---

## Required schema

```sql
-- Run this only if you haven't created the table yet.
create table if not exists public.hazards (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('police','accident','road','traffic')),
  lat              double precision not null,
  lng              double precision not null,
  reporter_handle  text,
  confirms         integer not null default 1,
  disputes         integer not null default 0,         -- NEW (community moderation)
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '30 minutes')
);

-- Helpful indexes
create index if not exists hazards_expires_at_idx on public.hazards (expires_at);
create index if not exists hazards_created_at_idx on public.hazards (created_at desc);
```

## Migration — add `disputes` column (run this once)

If your existing `hazards` table doesn't have a `disputes` column yet, run:

```sql
alter table public.hazards
  add column if not exists disputes integer not null default 0;
```

The app will gracefully no-op if the column is missing (it will still
expire the hazard early instead), but adding the column unlocks proper
community downvoting.

## RLS policies

You mentioned you've already enabled Read + Insert. For the dispute /
confirm features to work, **Update** must also be allowed for any
authenticated user (we only update the `confirms` and `disputes`
counters). Suggested policy:

```sql
alter table public.hazards enable row level security;

-- Anyone (including anon) can read non-expired hazards
create policy "hazards_read"   on public.hazards for select using (true);

-- Anyone can insert
create policy "hazards_insert" on public.hazards for insert with check (true);

-- Anyone can bump confirms / disputes
create policy "hazards_update" on public.hazards for update using (true) with check (true);
```

> If you want to lock this down (e.g. only authenticated users), wrap
> the policies with `auth.role() = 'authenticated'`.

## Realtime

Make sure **Realtime** is enabled on the `hazards` table (Supabase
Dashboard → Database → Replication → toggle `hazards`). The app
subscribes to `INSERT` and `UPDATE` events so new hazards + counter
changes appear instantly on every driver's map.

## Auto-cleanup (optional — recommended)

To purge expired hazards automatically you can add a scheduled function:

```sql
-- pg_cron version (if pg_cron is enabled in your project)
select cron.schedule(
  'purge_expired_hazards',
  '*/5 * * * *',
  $$delete from public.hazards where expires_at < now() - interval '5 minutes';$$
);
```

Otherwise the app filters out expired hazards client-side via the
`expires_at` check, so this is purely housekeeping.
