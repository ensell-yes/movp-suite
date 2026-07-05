begin;
select plan(24);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

select is((select count(*)::int from public.automation_rule where workspace_id='11111111-1111-1111-1111-111111111111'),
          3, 'workspace insert seeds three disabled workflow rule templates');
select is((select count(*)::int
             from public.automation_rule ar
             join public.event_type et on et.id = ar.trigger_event_type_id
            where ar.workspace_id='11111111-1111-1111-1111-111111111111'
              and not ar.enabled
              and (
                (et.key='deliverable.due_soon' and ar.action_type='create_task')
                or (et.key='content.approved' and ar.action_type='advance_deliverable')
                or (et.key='segment.membership_changed' and ar.action_type='recompute_segment')
              )),
          3, 'default workflow templates are disabled and bind to canonical event/action pairs');

select throws_ok(
  $$insert into public.automation_rule (workspace_id, trigger_event_type_id, condition, action_type, action_config)
    values ('11111111-1111-1111-1111-111111111111', (select id from public.event_type where key='task.completed'), '{}'::jsonb, 'bogus', '{}'::jsonb)$$,
  '23514', NULL,
  'unknown action types are rejected by the enum check');
select throws_ok(
  $$insert into public.automation_rule (workspace_id, trigger_event_type_id, condition, action_type, action_config)
    values ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{}'::jsonb, 'notify', '{}'::jsonb)$$,
  '23503', NULL,
  'unknown event type ids are rejected by the FK');
select throws_ok(
  $$insert into public.automation_rule (workspace_id, trigger_event_type_id, condition, action_type, action_config)
    values ('11111111-1111-1111-1111-111111111111', (select id from public.event_type where key='task.completed'), '[]'::jsonb, 'notify', '{}'::jsonb)$$,
  '23514', NULL,
  'condition must be a JSON object');
select throws_ok(
  $$insert into public.automation_rule (workspace_id, trigger_event_type_id, condition, action_type, action_config)
    values ('11111111-1111-1111-1111-111111111111', (select id from public.event_type where key='task.completed'), '{}'::jsonb, 'notify', '[]'::jsonb)$$,
  '23514', NULL,
  'action_config must be a JSON object');

delete from movp_internal.movp_jobs;
delete from movp_internal.movp_events;

select public.emit_event(
  'task.completed',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'task-1', 'depth', 'abc', 'email', 'redacted@example.test'),
  'trace-workflows-automation'
);

select is((select count(*)::int from movp_internal.movp_events where trace_id='trace-workflows-automation'),
          1, 'non-numeric depth does not abort the emitting transaction');
select is((select payload->>'depth' from movp_internal.movp_jobs where kind='automate' and payload->>'event_type'='task.completed'),
          '0', 'non-numeric depth falls back to 0 in automate payload');

create temp table _workflow_event_id as
select id from movp_internal.movp_events where trace_id='trace-workflows-automation';
grant select on _workflow_event_id to authenticated;

select table_privs_are(
  'movp_internal', 'movp_events', 'authenticated', array[]::text[],
  'authenticated has no direct privileges on movp_events');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select isnt(
  public.get_event((select id from _workflow_event_id),
                   '11111111-1111-1111-1111-111111111111'),
  null,
  'member can read an event in their workspace through get_event');
select ok(
  public.get_event((select id from _workflow_event_id),
                   '11111111-1111-1111-1111-111111111111')
    ?& array['id','type','workspace_id','payload','trace_id','created_at'],
  'get_event returns the audit fields needed by the worker');
select ok(
  not (public.get_event((select id from _workflow_event_id),
                        '11111111-1111-1111-1111-111111111111')->'payload' ? 'email'),
  'member get_event redacts top-level email payload values');
select is(
  public.get_event((select id from _workflow_event_id),
                   '22222222-2222-2222-2222-222222222222'),
  null,
  'wrong workspace gets null');

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  public.get_event((select id from _workflow_event_id),
                   '11111111-1111-1111-1111-111111111111'),
  null,
  'non-member gets null');

reset role;
set local request.jwt.claims = '{"role":"service_role"}';
select isnt(
  public.get_event((select id from _workflow_event_id),
                   '11111111-1111-1111-1111-111111111111'),
  null,
  'service-role worker can read an event through get_event without exposing movp_internal');
select ok(
  public.get_event((select id from _workflow_event_id),
                   '11111111-1111-1111-1111-111111111111')->'payload' ? 'email',
  'service-role get_event preserves raw payload for the worker');
reset all;

insert into movp_internal.webhooks (id, workspace_id, event_type, url, secret, active)
values (
  'aaaaaaaa-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'task.completed',
  'https://example.test/hook',
  'secret-value',
  true
);
insert into public.webhook_subscription (id, workspace_id, event_type_id, url, internal_webhook_id)
values (
  'bbbbbbbb-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  (select id from public.event_type where key='task.completed'),
  'https://example.test/hook',
  'aaaaaaaa-0000-0000-0000-000000000001'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.workflow_webhook_for_action('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111')->>'url',
  'https://example.test/hook',
  'service-role worker can resolve a managed webhook through a public RPC');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.workflow_webhook_for_action('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111')$$,
  '42501', NULL,
  'authenticated cannot execute the workflow webhook secret RPC');
reset role;

select ok(
  exists (
    select 1
      from pg_indexes
     where schemaname='movp_internal'
       and tablename='movp_events'
       and indexname='movp_events_workflow_dedupe_unique'
  ),
  'workflow chained emits are backed by a dedupe index');

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.workflow_emit_event(
  'task.due_soon',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'chained-1'),
  'trace-workflow-emit',
  'event-1:rule-emit'
);
select public.workflow_emit_event(
  'task.due_soon',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'chained-1'),
  'trace-workflow-emit',
  'event-1:rule-emit'
);
reset role;
select is(
  (select count(*)::int
     from movp_internal.movp_events
    where payload->>'workflow_dedupe' = 'event-1:rule-emit'),
  1,
  'workflow_emit_event emits exactly once for the same dedupe key');
select throws_ok(
  $$select public.workflow_emit_event('task.due_soon', '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 'trace', null)$$,
  '23514', NULL,
  'workflow_emit_event requires an explicit dedupe key');

select is((select count(*)::int
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'create_workflow_task_with_revision'),
          1,
          'workflow-specific task create RPC exists without overloading create_task_with_revision');
select throws_ok(
  $$select public.create_workflow_task_with_revision(
    '11111111-1111-1111-1111-111111111111',
    'Task',
    null,
    null,
    null,
    null,
    null,
    'Body',
    null,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )$$,
  '23514', NULL,
  'workflow task RPC requires an idempotency key');
select ok(
  exists (
    select 1
      from pg_indexes
     where schemaname='public'
       and tablename='task'
       and indexname='task_workflow_idempotency_key_unique'
  ),
  'workflow-created tasks have a unique idempotency index');

rollback;
