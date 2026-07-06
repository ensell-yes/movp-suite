-- Production retention primitives for the internal event/job spine.
-- Schedule this RPC out-of-band after deploy; do not put pg_cron state in migrations.

create or replace function public.prune_internal_retention(
  events_before timestamptz default now() - interval '90 days',
  jobs_before timestamptz default now() - interval '30 days',
  batch_limit int default 10000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs_deleted int := 0;
  v_events_deleted int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;

  if batch_limit is null or batch_limit < 1 or batch_limit > 100000 then
    raise exception 'retention_batch_limit_invalid' using errcode = '22023';
  end if;

  with doomed as (
    select id
      from movp_internal.movp_jobs
     where status in ('done', 'dead')
       and updated_at < jobs_before
     order by updated_at, id
     limit batch_limit
  ), deleted as (
    delete from movp_internal.movp_jobs j
     using doomed
     where j.id = doomed.id
     returning 1
  )
  select count(*)::int into v_jobs_deleted from deleted;

  with doomed as (
    select id
      from movp_internal.movp_events
     where created_at < events_before
     order by created_at, id
     limit batch_limit
  ), deleted as (
    delete from movp_internal.movp_events e
     using doomed
     where e.id = doomed.id
     returning 1
  )
  select count(*)::int into v_events_deleted from deleted;

  return jsonb_build_object(
    'jobs_deleted', v_jobs_deleted,
    'events_deleted', v_events_deleted,
    'events_before', events_before,
    'jobs_before', jobs_before
  );
end;
$$;

revoke all on function public.prune_internal_retention(timestamptz, timestamptz, int) from public, anon, authenticated;
grant execute on function public.prune_internal_retention(timestamptz, timestamptz, int) to service_role;
