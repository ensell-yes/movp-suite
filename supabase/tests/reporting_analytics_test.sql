-- C4b reporting analytics RPCs: membership, bounds, and definer redaction.
begin;
select plan(23);

insert into public.workspace (id, name) values
  ('c4b00000-0000-0000-0000-000000000001', 'RepAnW1'),
  ('c4b00000-0000-0000-0000-000000000002', 'RepAnW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c4b00000-0000-0000-0000-000000000002', 'c4b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

insert into public.task (workspace_id, title, status_id, priority_id, created_at, completed_at) values
  ('c4b00000-0000-0000-0000-000000000001', 'Done 1',
   (select id from public.task_status_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '2 days', now() - interval '1 day'),
  ('c4b00000-0000-0000-0000-000000000001', 'Done 2',
   (select id from public.task_status_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '3 days', now() - interval '2 days'),
  ('c4b00000-0000-0000-0000-000000000001', 'Open 1',
   (select id from public.task_status_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '1 day', null);

insert into public.content_type (id, workspace_id, label, key, field_schema) values
  ('c4b00000-0000-0000-0000-0000000000c1', 'c4b00000-0000-0000-0000-000000000001', 'Article', 'article',
   '[{"name":"title","type":"text"}]'::jsonb);
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('c4b00000-0000-0000-0000-0000000000d1', 'c4b00000-0000-0000-0000-000000000001',
   'c4b00000-0000-0000-0000-0000000000c1', 'p-1', 'draft'),
  ('c4b00000-0000-0000-0000-0000000000d2', 'c4b00000-0000-0000-0000-000000000001',
   'c4b00000-0000-0000-0000-0000000000c1', 'p-2', 'published');

insert into public.campaign (id, workspace_id, name, status) values
  ('c4b00000-0000-0000-0000-0000000000a1', 'c4b00000-0000-0000-0000-000000000001', 'A', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 30, current_date),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 70, current_date - 1),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 40, current_date - 60);

insert into public.segment (id, workspace_id, name, active, mode) values
  ('c4b00000-0000-0000-0000-0000000000e1', 'c4b00000-0000-0000-0000-000000000001', 'Seg', true, 'dynamic');
insert into public.segment_snapshot (workspace_id, segment_id, taken_at, reason, member_count) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000e1',
   now() - interval '2 days', 'scheduled', 3),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000e1',
   now(), 'on_demand', 5);

insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config) values
  ('c4b00000-0000-0000-0000-000000000011', 'c4b00000-0000-0000-0000-000000000001',
   (select id from public.event_type where key = 'task.completed'), '{}'::jsonb, 'notify', '{}'::jsonb);
insert into public.workflow_run
  (workspace_id, source_event_id, event_type, automation_rule_id, matched, action_type, outcome)
values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-000000000098', 'task.completed',
   'c4b00000-0000-0000-0000-000000000011', true, 'notify', 'succeeded'),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-000000000099', 'task.completed',
   'c4b00000-0000-0000-0000-000000000011', true, 'notify', 'failed');

insert into public.platform_event
  (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at)
values
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-1', 'internal', now(), now()),
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-2', 'external',
   now() - interval '1 day', now()),
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-3', 'internal',
   now() - interval '60 days', now());

insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('c4b00000-0000-0000-0000-000000000021', 'task.completed', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-1', now()),
  ('c4b00000-0000-0000-0000-000000000022', 'task.completed', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-2', now()),
  ('c4b00000-0000-0000-0000-000000000023', 'note.created', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-3', now() - interval '1 day'),
  ('c4b00000-0000-0000-0000-000000000024', 'task.completed', 'c4b00000-0000-0000-0000-000000000002',
   '{"secret":"other-ws"}'::jsonb, 'c4b-trace-4', now());

insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id, status) values
  ('embed', 'c4b-rep-1', '{"secret_url":"http://evil.example/1"}'::jsonb,
   'c4b00000-0000-0000-0000-000000000001', 'done'),
  ('embed', 'c4b-rep-2', '{"secret_url":"http://evil.example/2"}'::jsonb,
   'c4b00000-0000-0000-0000-000000000001', 'done');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is((public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->>'open_count')::int,
  1, 'task throughput: open_count = 1');
select is(
  (select sum((entry->>'count')::int)::int
     from jsonb_array_elements(
       public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->'series') entry),
  2, 'task throughput: series counts sum to the 2 completed tasks');
select is((public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->>'avg_cycle_hours')::numeric,
  24.0, 'task throughput: avg cycle is 24h');
select is(
  (select (entry->>'count')::int
     from jsonb_array_elements(public.reporting_content_funnel('c4b00000-0000-0000-0000-000000000001')) entry
    where entry->>'status' = 'draft'),
  1, 'content funnel: draft = 1');
select is(
  (select (entry->>'total')::int
     from jsonb_array_elements(
       public.reporting_campaign_metrics('c4b00000-0000-0000-0000-000000000001', 30)) entry
    where entry->>'metric_key' = 'clicks'),
  100, 'campaign metrics: 30d window sums 100 and excludes the 60d-old row');
select is(
  (select jsonb_array_length(entry->'points')
     from jsonb_array_elements(public.reporting_segment_growth('c4b00000-0000-0000-0000-000000000001', 90)) entry
    where entry->>'name' = 'Seg'),
  2, 'segment growth: 2 snapshot points for Seg');
select is(jsonb_array_length(public.reporting_workflow_health('c4b00000-0000-0000-0000-000000000001', 30)),
  2, 'workflow health: succeeded + failed = 2 outcome groups');
select is(
  (select sum((entry->>'count')::int)::int
     from jsonb_array_elements(
       public.reporting_ingest_volume('c4b00000-0000-0000-0000-000000000001', 30)) entry),
  2, 'ingest volume: 30d window counts 2 and excludes the 60d-old event');
select is(
  (select sum((entry->>'count')::int)::int
     from jsonb_array_elements(
       public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)) entry),
  3, 'event daily counts: 3 W1 internal events, W2 excluded');
select ok(
  public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)::text not like '%leak-me-not%',
  'event daily counts NEVER leak payload values');
select is(
  (select (entry->>'count')::int
     from jsonb_array_elements(
       public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)) entry
    where entry->>'kind' = 'embed' and entry->>'status' = 'done'),
  2, 'job daily counts: 2 done embed jobs');
select ok(
  public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)::text not like '%evil.example%',
  'job daily counts NEVER leak payload values');
select lives_ok(
  $$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 100000) $$,
  'days is clamped server-side; absurd ranges do not error');

set local request.jwt.claims = '{"sub":"c4b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok($$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: task throughput');
select throws_ok($$ select public.reporting_content_funnel('c4b00000-0000-0000-0000-000000000001') $$,
  '42501', 'not_workspace_member', 'non-member denied: content funnel');
select throws_ok($$ select public.reporting_campaign_metrics('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: campaign metrics');
select throws_ok($$ select public.reporting_segment_growth('c4b00000-0000-0000-0000-000000000001', 90) $$,
  '42501', 'not_workspace_member', 'non-member denied: segment growth');
select throws_ok($$ select public.reporting_workflow_health('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: workflow health');
select throws_ok($$ select public.reporting_ingest_volume('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: ingest volume');
select throws_ok($$ select public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: event daily counts');
select throws_ok($$ select public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: job daily counts');

reset role;
set local role anon;
select throws_ok($$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', null, 'anon lacks execute on the invoker RPCs');
select throws_ok($$ select public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', null, 'anon lacks execute on the definer RPCs');
reset role;

select * from finish();
rollback;
