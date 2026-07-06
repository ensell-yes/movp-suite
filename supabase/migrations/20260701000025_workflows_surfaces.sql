-- Domain Workflows Phase 7 - Part D: scoped operator surface helpers.

create or replace function public.replay_workflow_jobs(ws uuid, only_dead boolean default true)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_workspace_member(ws) then
    raise exception 'not a workspace member' using errcode = '42501';
  end if;

  update movp_internal.movp_jobs
     set status = 'pending',
         next_run_at = now(),
         locked_by = null,
         locked_at = null,
         lease_expires_at = null,
         updated_at = now()
   where kind = 'automate'
     and workspace_id = ws
     and (case when only_dead then status = 'dead' else status in ('dead', 'failed') end);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.replay_workflow_jobs(uuid, boolean) from public, anon, authenticated;
grant execute on function public.replay_workflow_jobs(uuid, boolean) to authenticated, service_role;
