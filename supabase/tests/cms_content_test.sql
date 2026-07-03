begin;
select plan(20);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

insert into public.content_type (id, workspace_id, key, label, field_schema, moderation_policy, approval_policy)
  values ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
          'page', 'Page', '[{"name":"title","type":"text","required":true}]'::jsonb, 'none', 'none');

insert into public.content_item (id, workspace_id, content_type_id, slug, status, search_text)
  values ('c1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
          'c1000000-0000-0000-0000-000000000001', 'home', 'draft', 'welcome home page');

insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
  values ('c1000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111',
          'c1000000-0000-0000-0000-0000000000a1', 1, '{"title":"Home"}'::jsonb, 'hash-rev-1',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

update public.content_item set current_revision_id = 'c1000000-0000-0000-0000-0000000000b1'
  where id = 'c1000000-0000-0000-0000-0000000000a1';

select has_table('public', 'content_type',     'content_type table exists');
select has_table('public', 'content_item',     'content_item table exists');
select has_table('public', 'content_revision', 'content_revision table exists');

select is((select count(*)::int from pg_constraint where conname='content_item_current_revision_fk' and contype='f'),
          1, 'content_item.current_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='content_item_approved_revision_fk' and contype='f'),
          1, 'content_item.approved_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='content_item_published_revision_fk' and contype='f'),
          1, 'content_item.published_revision_id back-FK exists');

select is((select count(*)::int from pg_constraint where conname='content_item_type_slug_uniq' and contype='u'),
          1, 'content_item (workspace_id, content_type_id, slug) unique');
select is((select count(*)::int from pg_constraint where conname='content_revision_number_uniq' and contype='u'),
          1, 'content_revision (content_item_id, revision_number) unique');
select is((select count(*)::int from pg_constraint where conname='content_revision_content_uniq' and contype='u'),
          1, 'content_revision (content_item_id, content_hash) unique');

select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_item_type_idx'),
          1, 'content_item (workspace_id, content_type_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_item_status_idx'),
          1, 'content_item (workspace_id, status) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_revision_item_idx'),
          1, 'content_revision (content_item_id) index exists');

select is((select count(*)::int from pg_policies where schemaname='public'
             and tablename='content_revision' and policyname='content_revision_rw'),
          0, 'blanket content_revision_rw policy dropped');
select is((select count(*)::int from pg_policies where schemaname='public'
             and tablename='content_revision' and cmd in ('UPDATE','DELETE')),
          0, 'content_revision has no UPDATE/DELETE policy (immutable)');

select throws_ok(
  $$update public.content_revision set content_hash='tampered'
     where id='c1000000-0000-0000-0000-0000000000b1'$$,
  '2F004', NULL, 'content_revision UPDATE is blocked by the immutability guard');
select throws_ok(
  $$delete from public.content_revision where id='c1000000-0000-0000-0000-0000000000b1'$$,
  '2F004', NULL, 'content_revision DELETE is blocked by the immutability guard');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'),
          true,  'member + item in ws -> true (content_item arm resolves against public.content_item)');
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000ff','11111111-1111-1111-1111-111111111111'),
          false, 'member + absent item -> false');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false (base gate) even for an existing item');

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.search_fts(
             '11111111-1111-1111-1111-111111111111', 'content_item', 'welcome', 10)),
          1, 'search_fts content_item arm returns the matching item');

select * from finish();
rollback;
