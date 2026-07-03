begin;
select plan(6);

-- Shared seed (as the table owner; RLS bypassed).
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','dddddddd-dddd-dddd-dddd-dddddddddddd','member'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','member');

-- Labels intentionally differ from categories, so category-keyed logic is label-agnostic.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('0000000b-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Backlog','backlog',0,false,true),
  ('0000000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','In Progress','active',1,false,true),
  ('0000000d-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Shipped','done',2,false,true);
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active) values
  ('0000000e-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Normal',5,false,true);

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- Task 1: emit_event notify guard.
select public.emit_event('task.assigned','11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id','deadbeef-0000-0000-0000-000000000000',
                     'recipient_user_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  gen_random_uuid()::text);
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key='task.assigned:deadbeef-0000-0000-0000-000000000000'),
          1, 'an event carrying recipient_user_id enqueues exactly one notify job');

select public.emit_event('task.created','11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id','feedface-0000-0000-0000-000000000000'),
  gen_random_uuid()::text);
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'task.created:%'),
          0, 'an event with no recipient enqueues no notify job');

-- Task 2: insert-event triggers (task.created/assigned/observer_added).
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('00000002-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Task Two','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.created' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'inserting a task emits task.created (audit-only)');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.assigned' and payload->>'entity_id'='00000002-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'task_assignment insert emits task.assigned carrying recipient_user_id');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.observer_added' and payload->>'entity_id'='00000002-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='dddddddd-dddd-dddd-dddd-dddddddddddd'),
          1, 'task_observer insert emits task.observer_added carrying recipient_user_id');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key='task.assigned:00000002-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'the task.assigned notify job uses a per-recipient idempotency key');

select * from finish();
rollback;
