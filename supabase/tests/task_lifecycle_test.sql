begin;
select plan(2);

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

select * from finish();
rollback;
