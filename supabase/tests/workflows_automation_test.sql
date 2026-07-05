begin;
select plan(7);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

delete from movp_internal.movp_jobs;
delete from movp_internal.movp_events;

select public.emit_event(
  'task.completed',
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id', 'task-1', 'depth', 'abc'),
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

rollback;
