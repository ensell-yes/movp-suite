begin;
select plan(13);

-- Structure + grants.
select has_function('public', 'create_task_with_revision',
  array['uuid','text','uuid','uuid','uuid','date','date','text'], 'create_task_with_revision exists');
select has_function('public', 'update_task_description', array['uuid','text'], 'update_task_description exists');
select is(has_function_privilege('authenticated',
  'public.create_task_with_revision(uuid,text,uuid,uuid,uuid,date,date,text)', 'execute'),
  true, 'authenticated can execute create_task_with_revision');
select is(has_function_privilege('anon',
  'public.create_task_with_revision(uuid,text,uuid,uuid,uuid,date,date,text)', 'execute'),
  false, 'anon cannot execute create_task_with_revision');
select is(has_function_privilege('authenticated',
  'public.update_task_description(uuid,text)', 'execute'),
  true, 'authenticated can execute update_task_description');
select is(has_function_privilege('anon',
  'public.update_task_description(uuid,text)', 'execute'),
  false, 'anon cannot execute update_task_description');

-- Seed as superuser; RLS is exercised after switching to authenticated.
reset role;
insert into public.workspace (id, name)
  values ('77777777-7777-7777-7777-777777777777', 'TaskWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('77777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
insert into public.task_status_option (id, workspace_id, label, category, is_default, is_active, sort_order)
  values ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777',
          'Todo', 'backlog', false, true, 10)
  on conflict (id) do nothing;
insert into public.task_priority_option (id, workspace_id, label, is_default, is_active, rank)
  values ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777',
          'Normal', false, true, 5)
  on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select ok(
  (public.create_task_with_revision(
     '77777777-7777-7777-7777-777777777777', 'First task',
     '88888888-8888-8888-8888-888888888888', '99999999-9999-9999-9999-999999999999',
     null, null, null, 'initial body'
   ) ->> 'id') is not null,
  'create_task_with_revision returns a task with an id');

select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id
    where t.workspace_id = '77777777-7777-7777-7777-777777777777' and t.title = 'First task'),
  1, 'create writes exactly one revision');

select is(
  (select case when t.current_revision_id = r.id then 1 else 0 end
     from public.task t join public.task_revision r on r.task_id = t.id
    where t.title = 'First task'),
  1, 'current_revision_id points at revision #1');

select public.update_task_description(
  (select id from public.task where title = 'First task'), 'initial body');
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id where t.title = 'First task'),
  1, 'identical body does not add a revision');

select public.update_task_description(
  (select id from public.task where title = 'First task'), 'revised body');
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id where t.title = 'First task'),
  2, 'a changed body adds a second revision');
select is(
  (select r.content_hash from public.task t
     join public.task_revision r on r.id = t.current_revision_id where t.title = 'First task'),
  encode(extensions.digest('revised body', 'sha256'), 'hex'),
  'current_revision_id advanced to the new revision');

select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id
    where t.title = 'First task' and r.workspace_id = t.workspace_id),
  2, 'every revision inherits the task workspace_id');

select * from finish();
rollback;
