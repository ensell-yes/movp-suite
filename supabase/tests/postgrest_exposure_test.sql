-- C5b.1 PostgREST exposure boundary: RLS enforces workspace isolation; internal:true is not REST hiding.
begin;
select plan(14);

select ok(not has_schema_privilege('anon', 'movp_internal', 'usage'), 'anon lacks movp_internal usage');
select ok(not has_schema_privilege('authenticated', 'movp_internal', 'usage'), 'authenticated lacks movp_internal usage');
select ok(not has_table_privilege('authenticated', 'movp_internal.ingest_idempotency', 'select'),
  'authenticated cannot select ingest_idempotency');
select ok(not has_table_privilege('anon', 'public.note', 'select'), 'anon lacks note select grant');
select ok(not has_table_privilege('anon', 'public.content_item', 'select'), 'anon lacks content_item select grant');
select ok(not has_table_privilege('anon', 'public.external_record', 'select'), 'anon lacks external_record select grant');
select ok(not has_table_privilege('anon', 'public.external_record', 'insert'), 'anon lacks external_record insert grant');
select ok(has_table_privilege('authenticated', 'public.content_item', 'select'),
  'authenticated can select content_item: internal:true is a GraphQL flag, not a REST boundary');
select ok(has_table_privilege('authenticated', 'public.external_record', 'select'),
  'authenticated can select external_record');

insert into public.workspace (id, name) values
  ('c5d00000-0000-0000-0000-000000000001', 'RestW1'),
  ('c5d00000-0000-0000-0000-000000000002', 'RestW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5d00000-0000-0000-0000-000000000001', 'c5d0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c5d00000-0000-0000-0000-000000000002', 'c5d0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');
insert into public.note (workspace_id, title, body, status) values
  ('c5d00000-0000-0000-0000-000000000001', 'W1 note', 'x', 'draft');
insert into public.content_type (id, workspace_id, key, label, field_schema) values
  ('c5d10000-0000-0000-0000-000000000001', 'c5d00000-0000-0000-0000-000000000001', 'article', 'Article', '{}'::jsonb);
insert into public.content_item (workspace_id, content_type_id, slug) values
  ('c5d00000-0000-0000-0000-000000000001', 'c5d10000-0000-0000-0000-000000000001', 'w1-article');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5d0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.note where workspace_id = 'c5d00000-0000-0000-0000-000000000001'),
  1, 'member A reads their workspace note through RLS');

set local request.jwt.claims = '{"sub":"c5d0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.note where workspace_id = 'c5d00000-0000-0000-0000-000000000001'),
  0, 'member B cannot read W1 note through RLS');
select throws_ok(
  $$ insert into public.note (workspace_id, title, body, status)
     values ('c5d00000-0000-0000-0000-000000000001', 'forged', 'x', 'draft') $$,
  '42501', null, 'member B cannot insert into W1 through RLS');
select is((select count(*)::int from public.content_item where workspace_id = 'c5d00000-0000-0000-0000-000000000001'),
  0, 'member B cannot read W1 content_item despite internal:true');
select throws_ok(
  $$ insert into public.content_item (workspace_id, content_type_id, slug)
     values ('c5d00000-0000-0000-0000-000000000001', 'c5d10000-0000-0000-0000-000000000001', 'forged-article') $$,
  '42501', null, 'member B cannot insert into W1 content_item');

reset role;
select * from finish();
rollback;
