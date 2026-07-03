begin;
select plan(7);

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

select * from finish();
rollback;
