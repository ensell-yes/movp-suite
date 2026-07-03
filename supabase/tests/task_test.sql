begin;
select plan(27);

-- Base seed (as table owner; RLS bypassed).
-- W1 members: A (owner), C (member). B is NOT a member of W1. W2 has no seeded members.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- Manual options: is_default=false so they never collide with the Task 5 seed trigger.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('50000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Seed Status', 'active', 10, false, true);
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active) values
  ('60000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Seed Priority', 5, false, true);

-- Seed task T1 in W1 (references the manual options).
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('70000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'T1',
   '50000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001');

-- Task 2: structural - tables, back-FK, uniques/guards, indexes.
select has_table('public', 'task',                'task table exists');
select has_table('public', 'task_status_option',  'task_status_option table exists');
select has_table('public', 'task_priority_option','task_priority_option table exists');
select has_table('public', 'task_revision',       'task_revision table exists');
select has_table('public', 'task_assignment',     'task_assignment table exists');
select has_table('public', 'task_observer',       'task_observer table exists');
select has_table('public', 'task_dependency',     'task_dependency table exists');
select has_table('public', 'task_status_history', 'task_status_history table exists');
select has_table('public', 'task_attachment',     'task_attachment table exists');

select is((select count(*)::int from pg_constraint where conname='task_current_revision_fk' and contype='f'),
          1, 'task.current_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='task_assignment_uniq' and contype='u'),
          1, 'task_assignment (task_id, assignee_user_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_observer_uniq' and contype='u'),
          1, 'task_observer (task_id, observer_user_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_dependency_uniq' and contype='u'),
          1, 'task_dependency (task_id, blocker_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_dependency_no_self' and contype='c'),
          1, 'task_dependency (task_id <> blocker_id) check');
select is((select count(*)::int from pg_constraint where conname='task_revision_content_uniq' and contype='u'),
          1, 'task_revision (task_id, content_hash) unique');

select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_status_option_default_uniq'),
          1, 'one-default-status partial unique index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_priority_option_default_uniq'),
          1, 'one-default-priority partial unique index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_ws_status_idx'),
          1, 'task (workspace_id, status_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_parent_idx'),
          1, 'task (parent_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_due_open_idx'),
          1, 'task (due_date) where completed_at is null index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_assignment_assignee_idx'),
          1, 'task_assignment (assignee_user_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_dependency_blocker_idx'),
          1, 'task_dependency (blocker_id) index exists');

-- Behavioral: the self-dependency check fires.
select throws_ok(
  $$insert into public.task_dependency (workspace_id, task_id, blocker_id)
    values ('11111111-1111-1111-1111-111111111111',
            '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001')$$,
  '23514', NULL, 'a task cannot depend on itself (check constraint)');

-- Behavioral: the composite unique on task_assignment fires.
insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'dddddddd-dddd-dddd-dddd-dddddddddddd');
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'dddddddd-dddd-dddd-dddd-dddddddddddd')$$,
  '23505', NULL, 'duplicate (task_id, assignee_user_id) rejected');

-- Task 3: can_access_entity('task', ...) (act as member A of W1).
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('task','70000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111'),
          true,  'member + task in ws -> true');
select is(public.can_access_entity('task','7fffffff-ffff-ffff-ffff-ffffffffffff','11111111-1111-1111-1111-111111111111'),
          false, 'member + absent task -> false');
-- Act as non-member B (not in W1).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('task','70000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false (base gate) even for an existing task');

select * from finish();
rollback;
