-- 20260902000200_vault_secret.sql — the scan-worker reads its own secrets from Vault.
--
-- WHY: the runbook originally asked Jeff to copy Vault's scan_worker_key out of the SQL
-- editor and paste it into Edge Function Secrets, so the cron caller (Vault) and the
-- worker (Deno.env) would agree. Jeff, 2026-09-01: "i dont know what to do this is
-- confusing." So the worker now reads the SAME Vault row the cron reads, through this
-- one SECURITY DEFINER function, and the two can never drift. The only human paste left
-- is TRIPO_API_KEY (edge secret) — or Vault 'tripo_api_key', which the worker also checks.
--
-- APPLIED LIVE 2026-09-01 (execute_sql), verified:
--   has_function_privilege anon=false, authenticated=false, service_role=true.
-- Idempotent: `create or replace` + explicit grants.

create or replace function public.vault_secret(p_name text)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;
revoke all on function public.vault_secret(text) from public, anon, authenticated;
grant execute on function public.vault_secret(text) to service_role;
