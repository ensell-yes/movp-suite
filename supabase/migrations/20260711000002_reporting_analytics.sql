-- C4b analytics layer: member-gated dashboard aggregates.

create or replace view reporting.v_task_cycle
with (security_invoker = true) as
select id, workspace_id, status_id, priority_id, created_at, completed_at, due_date, updated_at
from public.task;
grant select on reporting.v_task_cycle to authenticated, service_role;

create or replace function public.reporting_task_throughput(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'avg_cycle_hours',
    (select round((avg(extract(epoch from (completed_at - created_at)) / 3600.0))::numeric, 1)
       from reporting.v_task_cycle
      where workspace_id = ws and completed_at is not null
        and completed_at >= now() - make_interval(days => d)),
    'open_count',
    (select count(*) from reporting.v_task_cycle where workspace_id = ws and completed_at is null),
    'series',
    coalesce(
      (select jsonb_agg(jsonb_build_object('day', day, 'count', count) order by day)
         from (select to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') as day, count(*) as count
                 from reporting.v_task_cycle
                where workspace_id = ws and completed_at is not null
                  and completed_at >= now() - make_interval(days => d)
                group by 1) series),
      '[]'::jsonb));
end;
$$;
revoke all on function public.reporting_task_throughput(uuid, int) from public, anon;
grant execute on function public.reporting_task_throughput(uuid, int) to authenticated;

create or replace function public.reporting_content_funnel(ws uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('status', status, 'count', count) order by count desc)
       from (select status, count(*) as count
               from reporting.v_content_item
              where workspace_id = ws
              group by status) funnel),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_content_funnel(uuid) from public, anon;
grant execute on function public.reporting_content_funnel(uuid) to authenticated;

create or replace function public.reporting_campaign_metrics(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('metric_key', metric_key, 'total', total) order by total desc)
       from (select metric_key, sum(value) as total
               from reporting.v_campaign_metric
              where workspace_id = ws and measured_at >= current_date - d
              group by metric_key) metrics),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_campaign_metrics(uuid, int) from public, anon;
grant execute on function public.reporting_campaign_metrics(uuid, int) to authenticated;

create or replace function public.reporting_segment_growth(ws uuid, days int default 90)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 90), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(
       jsonb_build_object('segment_id', segment.id, 'name', segment.name, 'points', points.points)
       order by segment.name)
       from public.segment segment
       join lateral (
         select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'taken_at', to_char(snapshot.taken_at, 'YYYY-MM-DD'),
               'member_count', snapshot.member_count)
             order by snapshot.taken_at),
           '[]'::jsonb) as points
           from public.segment_snapshot snapshot
          where snapshot.segment_id = segment.id and snapshot.workspace_id = ws
            and snapshot.taken_at >= now() - make_interval(days => d)
       ) points on true
      where segment.workspace_id = ws),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_segment_growth(uuid, int) from public, anon;
grant execute on function public.reporting_segment_growth(uuid, int) to authenticated;

create or replace function public.reporting_workflow_health(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(
       jsonb_build_object('day', day, 'outcome', outcome, 'count', count)
       order by day, outcome)
       from (select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, outcome, count(*) as count
               from reporting.v_workflow_run
              where workspace_id = ws and created_at >= now() - make_interval(days => d)
              group by 1, 2) health),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_workflow_health(uuid, int) from public, anon;
grant execute on function public.reporting_workflow_health(uuid, int) to authenticated;

create or replace function public.reporting_ingest_volume(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(
       jsonb_build_object('day', day, 'source', source, 'count', count)
       order by day, source)
       from (select to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day, source, count(*) as count
               from reporting.v_platform_event
              where workspace_id = ws and occurred_at >= now() - make_interval(days => d)
              group by 1, 2) volume),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_ingest_volume(uuid, int) from public, anon;
grant execute on function public.reporting_ingest_volume(uuid, int) to authenticated;
