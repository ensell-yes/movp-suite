begin;
select plan(9);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

delete from movp_internal.movp_jobs;
delete from movp_internal.webhooks;
delete from movp_internal.movp_events;

select ok(
  exists (select 1 from movp_internal.movp_job_kind where kind='automate'),
  'automate job kind is registered');

select public.register_webhook(
  '11111111-1111-1111-1111-111111111111',
  'task.completed',
  'https://example.test/hook',
  'secret'
);

select public.emit_event(
  'task.completed',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'same-business-id', 'recipient_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'trace-workflows-1'
);
select public.emit_event(
  'task.completed',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'same-business-id'),
  'trace-workflows-2'
);

select is((select count(*)::int from movp_internal.movp_events where type='task.completed'),
          2, 'emit_event inserts one movp_events row per call');
select is((select count(*)::int from movp_internal.movp_jobs where kind='automate'),
          2, 'emit_event enqueues one automate job per event row');
select is((select count(*)::int from movp_internal.movp_jobs where kind='notify'),
          1, 'recipient-bearing event still enqueues one notify job');
select is((select count(*)::int from movp_internal.movp_jobs where kind='webhook'),
          1, 'active registered webhook still enqueues one webhook job');
select ok((select payload ? 'webhook_id' from movp_internal.movp_jobs where kind='webhook'),
          'webhook jobs carry the internal webhook id for delivery-time classification');
select is((select count(*)::int
             from movp_internal.movp_jobs j
             join movp_internal.movp_events e on j.idempotency_key = e.id::text
            where j.kind='automate'),
          2, 'automate idempotency key equals the movp_events row id');

select col_is_unique('public', 'workflow_run', ARRAY['source_event_id','automation_rule_id'],
  'workflow_run is unique on (source_event_id, automation_rule_id)');

insert into public.automation_rule
  (id, workspace_id, trigger_event_type_id, condition, action_type, action_config)
  values (
    '62000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    (select id from public.event_type where key='task.completed'),
    '{}'::jsonb,
    'notify',
    '{}'::jsonb
  );
insert into public.workflow_run
  (id, workspace_id, source_event_id, event_type, automation_rule_id, matched, action_type, outcome)
  values (
    '63000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    (select id from movp_internal.movp_events where trace_id='trace-workflows-1'),
    'task.completed',
    '62000000-0000-0000-0000-000000000001',
    true,
    'notify',
    'enqueued'
  );

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
set local role authenticated;
select is((select count(*)::int from public.workflow_run),
          0, 'non-member sees zero workflow_run rows');

rollback;
