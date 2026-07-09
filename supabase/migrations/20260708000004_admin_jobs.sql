-- C2.4 member-facing jobs and DLQ operations.

create or replace function public.workspace_job_counts(ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_object_agg(status, c)
    from (
      select status, count(*) as c
      from movp_internal.movp_jobs
      where workspace_id = ws
      group by status
    ) s
  ), '{}'::jsonb);
end;
$$;

create or replace function public.workspace_dead_jobs(ws uuid, lim int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'kind', j.kind,
        'attempts', j.attempts,
        'last_error_code', j.last_error_code,
        'updated_at', j.updated_at,
        'payload_keys', (
          select coalesce(jsonb_agg(k), '[]'::jsonb)
          from jsonb_object_keys(j.payload) as k
        )
      )
      order by j.updated_at desc, j.id
    )
    from (
      select *
      from movp_internal.movp_jobs
      where workspace_id = ws and status = 'dead'
      order by updated_at desc, id
      limit least(greatest(coalesce(lim, 50), 1), 200)
    ) j
  ), '[]'::jsonb);
end;
$$;

create or replace function public.replay_dead_jobs(ws uuid, job_kind text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if auth.uid() is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  update movp_internal.movp_jobs
     set status = 'pending',
         next_run_at = now(),
         locked_by = null,
         locked_at = null,
         lease_expires_at = null,
         updated_at = now()
   where workspace_id = ws
     and status = 'dead'
     and (replay_dead_jobs.job_kind is null or kind = replay_dead_jobs.job_kind);

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.workspace_job_counts(uuid) from public, anon, authenticated;
revoke all on function public.workspace_dead_jobs(uuid, int) from public, anon, authenticated;
revoke all on function public.replay_dead_jobs(uuid, text) from public, anon, authenticated;

grant execute on function public.workspace_job_counts(uuid) to authenticated;
grant execute on function public.workspace_dead_jobs(uuid, int) to authenticated;
grant execute on function public.replay_dead_jobs(uuid, text) to authenticated;
