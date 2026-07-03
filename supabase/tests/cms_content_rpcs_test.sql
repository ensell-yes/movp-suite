begin;
select plan(16);

select has_function('public', 'create_content_with_revision',
  array['uuid','uuid','text','jsonb','text','text','text'], 'create_content_with_revision exists');
select has_function('public', 'update_content',
  array['uuid','jsonb','text','text','text'], 'update_content exists');
select is(has_function_privilege('authenticated',
  'public.create_content_with_revision(uuid,uuid,text,jsonb,text,text,text)', 'execute'),
  true, 'authenticated can execute create_content_with_revision');
select is(has_function_privilege('anon',
  'public.create_content_with_revision(uuid,uuid,text,jsonb,text,text,text)', 'execute'),
  false, 'anon cannot execute create_content_with_revision');
select is(has_function_privilege('authenticated',
  'public.update_content(uuid,jsonb,text,text,text)', 'execute'),
  true, 'authenticated can execute update_content');
select is(has_function_privilege('anon',
  'public.update_content(uuid,jsonb,text,text,text)', 'execute'),
  false, 'anon cannot execute update_content');

reset role;
insert into public.workspace (id, name)
  values ('77777777-7777-7777-7777-777777777777', 'CmsWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('77777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
insert into public.content_type (id, workspace_id, key, label, field_schema)
  values ('c7000000-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
          'page', 'Page', '[{"name":"title","type":"text"}]'::jsonb)
  on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select ok(
  (public.create_content_with_revision(
     '77777777-7777-7777-7777-777777777777', 'c7000000-0000-0000-0000-000000000001', 'about',
     '{"title":"About"}'::jsonb, 'hash-A', 'About', ''
   ) ->> 'id') is not null,
  'create_content_with_revision returns an item with an id');

select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id
    where ci.workspace_id = '77777777-7777-7777-7777-777777777777' and ci.slug = 'about'),
  1, 'create writes exactly one revision');

select is(
  (select case when ci.current_revision_id = r.id and r.revision_number = 1 then 1 else 0 end
     from public.content_item ci join public.content_revision r on r.content_item_id = ci.id
    where ci.slug = 'about'),
  1, 'current_revision_id points at revision #1 (revision_number = 1)');

select public.update_content(
  (select id from public.content_item where slug = 'about'),
  '{"title":"About"}'::jsonb, 'hash-A', 'About v2', '');
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id where ci.slug = 'about'),
  1, 'identical hash does not add a revision (dedupe)');
select is(
  (select ci.search_text from public.content_item ci where ci.slug = 'about'),
  'About v2', 'dedupe path still updates search_text');

select public.update_content(
  (select id from public.content_item where slug = 'about'),
  '{"title":"About Us"}'::jsonb, 'hash-B', 'About Us', '');
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id where ci.slug = 'about'),
  2, 'a changed hash adds a second revision');
select is(
  (select r.revision_number::int from public.content_item ci
     join public.content_revision r on r.id = ci.current_revision_id where ci.slug = 'about'),
  2, 'current advanced to revision_number 2');
select is(
  (select r2.parent_id from public.content_item ci
     join public.content_revision r2 on r2.id = ci.current_revision_id where ci.slug = 'about'),
  (select r1.id from public.content_revision r1 join public.content_item ci on ci.id = r1.content_item_id
    where ci.slug = 'about' and r1.revision_number = 1),
  'revision #2 parent_id points at revision #1');
select is(
  (select r.content_hash from public.content_item ci
     join public.content_revision r on r.id = ci.current_revision_id where ci.slug = 'about'),
  'hash-B', 'current revision carries the passed hash');

select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id
    where ci.slug = 'about' and r.workspace_id = ci.workspace_id),
  2, 'every revision inherits the item workspace_id (workspace-scoped)');

select * from finish();
rollback;
