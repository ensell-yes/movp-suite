-- C4a.4 reporting views: structural totality + negative isolation across every scoped view.
begin;
select plan(23);

select is((select count(*)::int from pg_catalog.pg_views
  where schemaname = 'reporting' and viewname <> 'v_task_cycle'),
  26, '26 generated reporting views exist');
select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting' and c.relkind = 'v' and c.relname <> 'v_task_cycle'
      and c.reloptions @> array['security_invoker=true']),
  26, 'every generated reporting view is security_invoker');
select is(
  (select count(*)::int from pg_catalog.pg_views v
    where v.schemaname = 'reporting' and v.viewname <> 'v_task_cycle'
      and has_table_privilege('authenticated', format('%I.%I', v.schemaname, v.viewname)::regclass, 'select')),
  26, 'authenticated can select every generated reporting view');
select is(
  (select count(*)::int from pg_catalog.pg_views v
    where v.schemaname = 'reporting'
      and has_table_privilege('anon', format('%I.%I', v.schemaname, v.viewname)::regclass, 'select')),
  0, 'anon can select none of them');
select ok(not has_schema_privilege('anon', 'reporting', 'usage'), 'anon lacks usage on schema reporting');

insert into public.workspace (id, name) values
  ('c4a00000-0000-0000-0000-000000000001', 'RepViewsW1'),
  ('c4a00000-0000-0000-0000-000000000002', 'RepViewsW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c4a00000-0000-0000-0000-000000000001', 'c4a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c4a00000-0000-0000-0000-000000000002', 'c4a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

insert into public.campaign (id, workspace_id, name, status) values
  ('c4a00000-0000-0000-0000-0000000000a1', 'c4a00000-0000-0000-0000-000000000001', 'A', 'active'),
  ('c4a00000-0000-0000-0000-0000000000b1', 'c4a00000-0000-0000-0000-000000000002', 'B', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4a00000-0000-0000-0000-000000000001', 'c4a00000-0000-0000-0000-0000000000a1', 'clicks', 30, current_date),
  ('c4a00000-0000-0000-0000-000000000001', 'c4a00000-0000-0000-0000-0000000000a1', 'clicks', 70, current_date),
  ('c4a00000-0000-0000-0000-000000000002', 'c4a00000-0000-0000-0000-0000000000b1', 'clicks', 25, current_date);

insert into public.content_type (id, workspace_id, label, key, field_schema) values
  ('c4a00000-0000-0000-0000-0000000000c1', 'c4a00000-0000-0000-0000-000000000001', 'Article', 'article',
   '[{"name":"title","type":"text"}]'::jsonb);
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('c4a00000-0000-0000-0000-0000000000d1', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'draft-1', 'draft'),
  ('c4a00000-0000-0000-0000-0000000000d2', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'draft-2', 'draft'),
  ('c4a00000-0000-0000-0000-0000000000d3', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'live-1', 'published');
insert into public.segment (id, workspace_id, name, active, mode) values
  ('c4a00000-0000-0000-0000-0000000000e1', 'c4a00000-0000-0000-0000-000000000001', 'Seg', true, 'dynamic');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('c4a00000-0000-0000-0000-0000000000f1', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000e1', now(), 'on_demand', 5);
insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config) values
  ('c4a00000-0000-0000-0000-000000000011', 'c4a00000-0000-0000-0000-000000000001',
   (select id from public.event_type where key = 'task.completed'), '{}'::jsonb, 'notify', '{}'::jsonb);
insert into public.workflow_run
  (id, workspace_id, source_event_id, event_type, automation_rule_id, matched, action_type, outcome)
values
  ('c4a00000-0000-0000-0000-000000000012', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-000000000099', 'task.completed',
   'c4a00000-0000-0000-0000-000000000011', true, 'notify', 'succeeded');
insert into public.platform_event
  (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at)
values
  ('c4a00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-1', 'internal', now(), now()),
  ('c4a00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-2', 'external', now(), now());

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from reporting.v_campaign_metric), 2, 'A sees W1 fact rows via the view');
select is((select sum(value)::int from reporting.v_campaign_metric), 100, 'measure column flows through the view');
select is((select count(*)::int from reporting.v_content_item where status = 'draft'),
  2, 'dimension column flows (funnel draft=2)');
select is((select member_count::int from reporting.v_segment_snapshot limit 1),
  5, 'segment snapshot measure visible');
select is((select count(*)::int from reporting.v_workflow_run where outcome = 'succeeded'),
  1, 'workflow outcome dimension visible');
select is((select count(*)::int from reporting.v_platform_event), 2, 'ingest facts visible');
select ok((select count(*) from reporting.v_event_type) > 0, 'global event_type catalog readable by any member');
select is(
  (select count(*)::int
     from reporting.v_campaign_metric m
     join public.campaign c on c.id = m.campaign_id),
  2, 'campaign_id join key supports a star join');

set local request.jwt.claims = '{"sub":"c4a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from reporting.v_campaign_metric), 1, 'B sees only W2 fact rows');
select is((select sum(value)::int from reporting.v_campaign_metric), 25, 'B sum excludes W1 values');
select is((select count(*)::int from reporting.v_content_item), 0, 'B sees no W1 content');
select is((select count(*)::int from reporting.v_segment_snapshot), 0, 'B sees no W1 snapshots');
select is((select count(*)::int from reporting.v_workflow_run), 0, 'B sees no W1 workflow runs');
select is((select count(*)::int from reporting.v_platform_event), 0, 'B sees no W1 platform events');

do $$
declare
  view record;
  view_leaks integer;
  total_leaks integer := 0;
begin
  for view in
    select viewname
      from pg_catalog.pg_views
     where schemaname = 'reporting' and viewname <> 'v_event_type'
  loop
    execute format(
      'select count(*)::int from reporting.%I where workspace_id = %L',
      view.viewname,
      'c4a00000-0000-0000-0000-000000000001'
    ) into view_leaks;
    total_leaks := total_leaks + view_leaks;
  end loop;
  perform set_config('c4a.total_leaks', total_leaks::text, true);
end $$;
select is(
  current_setting('c4a.total_leaks')::int,
  0,
  'member B sees zero W1 rows in every workspace-scoped reporting view'
);

set local request.jwt.claims = '{"sub":"c4a0cccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from reporting.v_campaign_metric), 0, 'a user with no membership sees zero rows');
reset role;
set local role anon;
select throws_ok(
  $$ select count(*) from reporting.v_campaign_metric $$,
  '42501', null, 'anon is denied outright (no grant, no schema usage)');
reset role;

select is((select count(*)::int from pg_catalog.pg_views where schemaname = 'reporting' and viewname = 'v_task'),
  0, 'task has no reporting view by design (no reporting metadata)');

select * from finish();
rollback;
