begin;
select plan(24);

-- generated collection tables + columns ------------------------------------
select has_table('public', 'note', 'note table exists');
select has_table('public', 'tag', 'tag table exists');
select has_column('public', 'note', 'workspace_id', 'note is workspace-scoped');
select has_column('public', 'note', 'title', 'note has title');
select has_column('public', 'note', 'body', 'note has body');
select has_column('public', 'note', 'status', 'note has status');
select has_column('public', 'note', 'search_vector', 'note has FTS column');
select has_column('public', 'tag', 'name', 'tag has name');
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public' and tablename = 'note' and indexname = 'note_search_idx'),
  1, 'note FTS GIN index exists');

-- shared search + graph infrastructure -------------------------------------
select has_table('public', 'search_chunk', 'search_chunk exists');
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public' and tablename = 'search_chunk' and indexname = 'search_chunk_hnsw'),
  1, 'search_chunk HNSW index exists');
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'match_chunks'),
  1, 'match_chunks function exists');
select has_table('public', 'edges', 'edges graph table exists');

-- internal jobs queue, denied to authenticated -----------------------------
select has_table('movp_internal', 'movp_jobs', 'movp_jobs lives in movp_internal');
select table_privs_are(
  'movp_internal', 'movp_jobs', 'authenticated', array[]::text[],
  'authenticated has no privileges on movp_jobs');

-- metadata registry (codegen INSERTs) --------------------------------------
select has_table('public', 'movp_collections', 'movp_collections exists');
select has_table('public', 'movp_fields', 'movp_fields exists');
select is(
  (select count(*)::int from public.movp_collections where name in ('note', 'tag')),
  2, 'both collections are registered');
select is(
  (select count(*)::int from public.movp_fields where collection_name = 'note'),
  4, 'all four note fields are registered');
select is(
  (select reporting_role from public.movp_fields where collection_name = 'note' and name = 'status'),
  'dimension', 'status reporting role is recorded');

-- FTS + embed-enqueue triggers fire on insert ------------------------------
insert into public.workspace (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Acme');
insert into public.note (id, workspace_id, title, body)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'Hello', 'World body');
select isnt(
  (select search_vector from public.note where id = '22222222-2222-2222-2222-222222222222'),
  null, 'FTS trigger populated search_vector');
select is(
  (select count(*)::int from movp_internal.movp_jobs
   where kind = 'embed' and idempotency_key like 'note:%:body:%'),
  1, 'embed enqueue trigger created exactly one job');

-- generated RLS: member sees the row, non-member sees zero ------------------
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.note), 1, 'member sees the note via RLS');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.note), 0, 'non-member sees zero notes via RLS');

select * from finish();
rollback;
