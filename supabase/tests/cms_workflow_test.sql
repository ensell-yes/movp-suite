begin;
select plan(21);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');
insert into public.content_type (id, workspace_id, label, key, field_schema) values
  (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '11111111-1111-1111-1111-111111111111',
    'Article',
    'article',
    '[{"name":"title","type":"text"}]'::jsonb
  );

select has_table('public', 'content_approval', 'content_approval table exists');
select has_table('public', 'content_approval_vote', 'content_approval_vote table exists');
select has_table('public', 'content_publish_event', 'content_publish_event table exists');
select has_column('public', 'content_approval', 'content_item_id', 'content_approval.content_item_id (content_item relation FK)');
select has_column('public', 'content_approval', 'approved_revision_id', 'content_approval.approved_revision_id FK');
select has_column('public', 'content_approval_vote', 'approval_id', 'content_approval_vote.approval_id FK');
select has_column('public', 'content_publish_event', 'revision_id', 'content_publish_event.revision_id FK');

insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('00000001-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'i1', 'draft');
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000a1-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000', 1, '{"t":"v1"}'::jsonb, 'hash-1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.content_approval (id, workspace_id, content_item_id, state, policy, approvals_required) values
  ('000000a9-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000', 'pending', 'single', 1);

select policies_are('public', 'content_approval',
  ARRAY['content_approval_select', 'content_approval_insert', 'content_approval_update'],
  'content_approval has exactly the workflow policies (no surviving _rw)');
select policies_are('public', 'content_approval_vote',
  ARRAY['content_approval_vote_select', 'content_approval_vote_insert'],
  'content_approval_vote is SELECT+INSERT only (no surviving _rw)');
select policies_are('public', 'content_publish_event',
  ARRAY['content_publish_event_select', 'content_publish_event_insert'],
  'content_publish_event is SELECT+INSERT only (no surviving _rw)');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select ok(public.has_content_capability('11111111-1111-1111-1111-111111111111', 'approve'), 'owner has approve cap');
select ok(public.has_content_capability('11111111-1111-1111-1111-111111111111', 'publish'), 'owner has publish cap');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select ok(not public.has_content_capability('11111111-1111-1111-1111-111111111111', 'approve'), 'member lacks approve cap');
select ok(not public.has_content_capability('11111111-1111-1111-1111-111111111111', 'publish'), 'member lacks publish cap');

select throws_ok(
  $$ update public.content_approval set state='approved' where id='000000a9-0000-0000-0000-000000000000' $$,
  '42501', null, 'a member without approve cap cannot decide an approval');
select throws_ok(
  $$ insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
     values ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000','publish',
             '000000a1-0000-0000-0000-000000000000','hash-1','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '42501', null, 'a member without publish cap cannot insert a publish event');
reset role;

insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote) values
  ('11111111-1111-1111-1111-111111111111', '000000a9-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'approve');
select throws_ok(
  $$ insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote)
     values ('11111111-1111-1111-1111-111111111111','000000a9-0000-0000-0000-000000000000',
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','reject') $$,
  '23505', null, 'a voter cannot vote twice on one approval');
select throws_ok(
  $$ update public.content_approval_vote set vote='reject' where approval_id='000000a9-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_approval_vote is immutable (UPDATE raises)');
select throws_ok(
  $$ delete from public.content_approval_vote where approval_id='000000a9-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_approval_vote is immutable (DELETE raises)');
insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id) values
  ('11111111-1111-1111-1111-111111111111', '00000001-0000-0000-0000-000000000000', 'publish',
   '000000a1-0000-0000-0000-000000000000', 'hash-1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  $$ update public.content_publish_event set action='unpublish' where content_item_id='00000001-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_publish_event is immutable (UPDATE raises)');
select throws_ok(
  $$ delete from public.content_publish_event where content_item_id='00000001-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_publish_event is immutable (DELETE raises)');

select * from finish();
rollback;
