-- Recovery uses backend-verified account ownership, never an editable handle.
-- Backfill only rows that have a trusted server-issued slot.
update public.car_scan_jobs as job
set user_id = slot.user_id
from public.scan_slots as slot
where job.scan_id = slot.scan_id
  and job.user_id is null;

-- Remove client access to every overload of the old handle-based RPC.
do $$
declare
  signature text;
begin
  for signature in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'scan_jobs_for_handle'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', signature);
  end loop;
end
$$;
