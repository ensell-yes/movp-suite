begin;
select plan(43);

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

-- Task 4: RLS matrix (still role=authenticated).
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'cccccccc-cccc-cccc-cccc-cccccccccccc');
select is((select count(*)::int from public.task_assignment
           where task_id='70000000-0000-0000-0000-000000000001'
             and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'member can assign another member');

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501', NULL, 'a non-member cannot create assignments in the workspace');

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL, 'assigning a non-member is denied (assignee must be a workspace member)');

insert into public.task_observer (workspace_id, task_id, observer_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'cccccccc-cccc-cccc-cccc-cccccccccccc');
select is((select count(*)::int from public.task_observer
           where task_id='70000000-0000-0000-0000-000000000001'
             and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'member can add another member as observer');
select throws_ok(
  $$insert into public.task_observer (workspace_id, task_id, observer_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL, 'observing a non-member is denied (observer must be a workspace member)');

insert into public.task_revision (id, workspace_id, task_id, body, content_hash, author_id)
  values ('80000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '70000000-0000-0000-0000-000000000001','rev body','hash-1',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_revision where id='80000000-0000-0000-0000-000000000001'),
          1, 'member can append a task revision');
update public.task_revision set body='mutated' where id='80000000-0000-0000-0000-000000000001';
select is((select body from public.task_revision where id='80000000-0000-0000-0000-000000000001'),
          'rev body', 'task_revision is immutable (UPDATE is a no-op - no update policy)');

insert into public.task_status_history (id, workspace_id, task_id, from_status_id, to_status_id, changed_by)
  values ('90000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '70000000-0000-0000-0000-000000000001', null,
          '50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_status_history where id='90000000-0000-0000-0000-000000000001'),
          1, 'member can append a status-history row');
update public.task_status_history set to_status_id='60000000-0000-0000-0000-000000000001'
  where id='90000000-0000-0000-0000-000000000001';
select is((select to_status_id from public.task_status_history where id='90000000-0000-0000-0000-000000000001'),
          '50000000-0000-0000-0000-000000000001', 'task_status_history is append-only (UPDATE is a no-op)');

insert into public.task_attachment (workspace_id, task_id, r2_key, filename, uploaded_by)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'ws/att-1','a.pdf','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_attachment
           where task_id='70000000-0000-0000-0000-000000000001' and r2_key='ws/att-1'),
          1, 'a member can attach to an accessible task as themselves');
select throws_ok(
  $$insert into public.task_attachment (workspace_id, task_id, r2_key, filename, uploaded_by)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'ws/att-2','b.pdf','cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501', NULL, 'a member cannot forge uploaded_by on an attachment');

delete from public.task_status_option where id='50000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.task_status_option where id='50000000-0000-0000-0000-000000000001'),
          1, 'task_status_option cannot be hard-deleted (no DELETE policy; deactivate via is_active)');

delete from public.task_assignment where task_id='70000000-0000-0000-0000-000000000001'
  and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';
select is((select count(*)::int from public.task_assignment
           where task_id='70000000-0000-0000-0000-000000000001'
             and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          0, 'a member can unassign (DELETE policy present, not a silent no-op)');
delete from public.task_observer where task_id='70000000-0000-0000-0000-000000000001'
  and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';
select is((select count(*)::int from public.task_observer
           where task_id='70000000-0000-0000-0000-000000000001'
             and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          0, 'a member can remove an observer (DELETE policy present)');

insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('70000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','T2',
   '50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');
insert into public.task_dependency (workspace_id, task_id, blocker_id) values
  ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.task_dependency
           where task_id='70000000-0000-0000-0000-000000000001'
             and blocker_id='70000000-0000-0000-0000-000000000002'),
          1, 'a member can add a same-workspace dependency (task_dependency override present)');
delete from public.task_dependency where task_id='70000000-0000-0000-0000-000000000001'
  and blocker_id='70000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.task_dependency
           where task_id='70000000-0000-0000-0000-000000000001'
             and blocker_id='70000000-0000-0000-0000-000000000002'),
          0, 'a member can remove a dependency (DELETE policy present)');

select * from finish();
rollback;
