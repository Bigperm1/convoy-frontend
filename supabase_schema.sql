-- Convoy hazards table — paste this whole block into the
-- Supabase SQL editor for project pgtbjiszjglznjagolse and click "Run".
-- It is idempotent (safe to re-run).

create extension if not exists pgcrypto;

create table if not exists public.hazards (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('police','accident','road','traffic')),
  lat double precision not null,
  lng double precision not null,
  reporter_handle text,
  confirms integer not null default 1,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists hazards_expires_idx on public.hazards (expires_at);
create index if not exists hazards_created_idx on public.hazards (created_at desc);

-- Enable Row Level Security and add open policies (anon key only).
alter table public.hazards enable row level security;

drop policy if exists "hazards_read"   on public.hazards;
drop policy if exists "hazards_insert" on public.hazards;
drop policy if exists "hazards_update" on public.hazards;

create policy "hazards_read"   on public.hazards for select using (true);
create policy "hazards_insert" on public.hazards for insert with check (true);
create policy "hazards_update" on public.hazards for update using (true) with check (true);

-- Add to the realtime publication so postgres_changes works
do $$
begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin
      execute 'alter publication supabase_realtime add table public.hazards';
    exception when duplicate_object then null; end;
  end if;
end $$;
