begin;
select plan(47);

insert into public.workspace (id, name) values
  ('d7000000-0000-0000-0000-000000000001', 'Delivery One'),
  ('d7000000-0000-0000-0000-000000000002', 'Delivery Two');

insert into public.content_type (id, workspace_id, key, label, field_schema) values
  (
    'd7010000-0000-0000-0000-000000000001',
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'Blog',
    '[{"name":"title","type":"text"},{"name":"body","type":"richText"}]'::jsonb
  ),
  (
    'd7010000-0000-0000-0000-000000000002',
    'd7000000-0000-0000-0000-000000000002',
    'blog',
    'Blog',
    '[{"name":"title","type":"text"},{"name":"body","type":"richText"}]'::jsonb
  );

insert into public.content_item (
  id,
  workspace_id,
  content_type_id,
  slug,
  status,
  published_at
) values
  (
    'd7100000-0000-0000-0000-000000000001',
    'd7000000-0000-0000-0000-000000000001',
    'd7010000-0000-0000-0000-000000000001',
    'public',
    'published',
    '2026-07-23T12:00:00Z'
  ),
  (
    'd7100000-0000-0000-0000-000000000002',
    'd7000000-0000-0000-0000-000000000001',
    'd7010000-0000-0000-0000-000000000001',
    'second',
    'published',
    '2026-07-23T12:01:00Z'
  ),
  (
    'd7100000-0000-0000-0000-000000000003',
    'd7000000-0000-0000-0000-000000000001',
    'd7010000-0000-0000-0000-000000000001',
    'draft-only',
    'draft',
    null
  ),
  (
    'd7100000-0000-0000-0000-000000000004',
    'd7000000-0000-0000-0000-000000000001',
    'd7010000-0000-0000-0000-000000000001',
    'unpublished',
    'archived',
    null
  ),
  (
    'd7100000-0000-0000-0000-000000000005',
    'd7000000-0000-0000-0000-000000000002',
    'd7010000-0000-0000-0000-000000000002',
    'foreign-only',
    'published',
    '2026-07-23T12:02:00Z'
  ),
  (
    'd7100000-0000-0000-0000-000000000006',
    'd7000000-0000-0000-0000-000000000001',
    'd7010000-0000-0000-0000-000000000001',
    'broken-pointer',
    'published',
    '2026-07-23T12:03:00Z'
  );

insert into public.content_revision (
  id,
  workspace_id,
  content_item_id,
  revision_number,
  data,
  content_hash,
  author_id
) values
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7000000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000001',
    1,
    '{"title":"Public v1","body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Published"}]}]}}'::jsonb,
    'delivery-public-v1',
    'd7a00000-0000-0000-0000-000000000001'
  ),
  (
    'd7200000-0000-0000-0000-000000000002',
    'd7000000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000001',
    2,
    '{"title":"Draft v2"}'::jsonb,
    'delivery-public-v2',
    'd7a00000-0000-0000-0000-000000000001'
  ),
  (
    'd7200000-0000-0000-0000-000000000003',
    'd7000000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000002',
    1,
    '{"title":"Second"}'::jsonb,
    'delivery-second-v1',
    'd7a00000-0000-0000-0000-000000000001'
  ),
  (
    'd7200000-0000-0000-0000-000000000004',
    'd7000000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000003',
    1,
    '{"title":"Draft only"}'::jsonb,
    'delivery-draft-v1',
    'd7a00000-0000-0000-0000-000000000001'
  ),
  (
    'd7200000-0000-0000-0000-000000000005',
    'd7000000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000004',
    1,
    '{"title":"Unpublished"}'::jsonb,
    'delivery-unpublished-v1',
    'd7a00000-0000-0000-0000-000000000001'
  ),
  (
    'd7200000-0000-0000-0000-000000000006',
    'd7000000-0000-0000-0000-000000000002',
    'd7100000-0000-0000-0000-000000000005',
    1,
    '{"title":"Foreign"}'::jsonb,
    'delivery-foreign-v1',
    'd7a00000-0000-0000-0000-000000000002'
  );

update public.content_item
set
  current_revision_id = 'd7200000-0000-0000-0000-000000000002',
  published_revision_id = 'd7200000-0000-0000-0000-000000000001'
where id = 'd7100000-0000-0000-0000-000000000001';

update public.content_item
set
  current_revision_id = 'd7200000-0000-0000-0000-000000000003',
  published_revision_id = 'd7200000-0000-0000-0000-000000000003'
where id = 'd7100000-0000-0000-0000-000000000002';

update public.content_item
set current_revision_id = 'd7200000-0000-0000-0000-000000000004'
where id = 'd7100000-0000-0000-0000-000000000003';

update public.content_item
set
  current_revision_id = 'd7200000-0000-0000-0000-000000000005',
  published_revision_id = 'd7200000-0000-0000-0000-000000000005'
where id = 'd7100000-0000-0000-0000-000000000004';

update public.content_item
set
  current_revision_id = 'd7200000-0000-0000-0000-000000000006',
  published_revision_id = 'd7200000-0000-0000-0000-000000000006'
where id = 'd7100000-0000-0000-0000-000000000005';

update public.content_item
set published_revision_id = 'd7200000-0000-0000-0000-000000000001'
where id = 'd7100000-0000-0000-0000-000000000006';

insert into public.content_seo (
  id,
  workspace_id,
  content_item_id,
  meta,
  jsonld,
  score,
  checklist
) values (
  'd7300000-0000-0000-0000-000000000001',
  'd7000000-0000-0000-0000-000000000001',
  'd7100000-0000-0000-0000-000000000001',
  '{"title":"SEO title","description":"Public description"}'::jsonb,
  '{"@context":"https://schema.org","@type":"Article"}'::jsonb,
  100,
  '[]'::jsonb
);

select has_function(
  'public',
  'get_published_by_slug',
  array['uuid', 'text', 'text'],
  'published item RPC exists'
);
select has_function(
  'public',
  'list_published_delivery',
  array['uuid', 'text', 'text', 'integer'],
  'published delivery list RPC exists'
);
select has_function(
  'public',
  'list_published_delivery_shards',
  array['uuid', 'integer'],
  'published delivery shard RPC exists'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_constraint
    where conname = 'content_type_workspace_key_unique'
      and conrelid = 'public.content_type'::regclass
      and contype = 'u'
  ),
  1,
  'content type keys are unique within a workspace'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_trigger
    where tgname = 'content_type_reserved_key_tg'
      and tgrelid = 'public.content_type'::regclass
      and not tgisinternal
      and tgenabled = 'O'
  ),
  1,
  'reserved content type key trigger exists and is enabled'
);

set local role anon;
select ok(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  ) is not null,
  'anon resolves a published item'
);
reset role;

select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  )->'data',
  '{"title":"Public v1","body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Published"}]}]}}'::jsonb,
  'published output uses the exact published revision data'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  )->>'published_revision_id',
  'd7200000-0000-0000-0000-000000000001',
  'published output exposes the exact published revision id'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  )->'meta',
  '{"title":"SEO title","description":"Public description"}'::jsonb,
  'published output includes item-scoped public meta'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  )->'jsonld',
  '{"@context":"https://schema.org","@type":"Article"}'::jsonb,
  'published output includes item-scoped public JSON-LD'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'draft-only'
  ),
  null::jsonb,
  'draft-only item is absent'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'unpublished'
  ),
  null::jsonb,
  'unpublished item is absent'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'public'
  )->'data'->>'title',
  'Public v1',
  'a newer current draft does not change public output'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'foreign-only'
  ),
  null::jsonb,
  'workspace-scoped resolution does not cross into a foreign workspace'
);
select is(
  public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'broken-pointer'
  ),
  null::jsonb,
  'a published pointer to another item is treated as not found'
);

create temporary table delivery_test_result (
  name text primary key,
  value jsonb not null
) on commit drop;

insert into delivery_test_result (name, value) values
  (
    'all',
    public.list_published_delivery(
      'd7000000-0000-0000-0000-000000000001',
      null,
      null,
      1000
    )
  ),
  (
    'one',
    public.list_published_delivery(
      'd7000000-0000-0000-0000-000000000001',
      null,
      null,
      1
    )
  ),
  (
    'clamped',
    public.list_published_delivery(
      'd7000000-0000-0000-0000-000000000001',
      null,
      null,
      0
    )
  ),
  (
    'shards',
    public.list_published_delivery_shards(
      'd7000000-0000-0000-0000-000000000001',
      4000
    )
  );

select is(
  jsonb_array_length((select value->'items' from delivery_test_result where name = 'all')),
  2,
  'list returns only valid published items in the requested workspace'
);
select ok(
  not exists (
    select 1
    from delivery_test_result r
    cross join lateral jsonb_array_elements(r.value->'items') item
    cross join lateral jsonb_object_keys(item) key
    where r.name = 'all'
      and key not in (
        'item_id',
        'content_type_key',
        'slug',
        'published_revision_id',
        'published_at'
      )
  ),
  'list rows expose route metadata only and never revision data'
);
select is(
  (select value->'items'->0->>'item_id' from delivery_test_result where name = 'all'),
  'd7100000-0000-0000-0000-000000000001',
  'list is ordered by immutable item id'
);
select is(
  jsonb_array_length((select value->'items' from delivery_test_result where name = 'clamped')),
  1,
  'list clamps a zero limit to one'
);
select ok(
  (select value->>'next_cursor' from delivery_test_result where name = 'one') is not null,
  'a partial list returns an opaque resume cursor'
);
select is(
  public.list_published_delivery(
    'd7000000-0000-0000-0000-000000000001',
    (select value->>'next_cursor' from delivery_test_result where name = 'one'),
    null,
    1000
  )->'items'->0->>'item_id',
  'd7100000-0000-0000-0000-000000000002',
  'resume cursor continues after the last returned item'
);
select is(
  public.list_published_delivery(
    'd7000000-0000-0000-0000-000000000001',
    (select value->>'next_cursor' from delivery_test_result where name = 'one'),
    null,
    1000
  )->>'next_cursor',
  null::text,
  'final resumed page has no further cursor'
);
select is(
  jsonb_array_length((select value from delivery_test_result where name = 'shards')),
  1,
  'small published catalog produces one shard'
);
select is(
  ((select value->0->>'count' from delivery_test_result where name = 'shards'))::integer,
  2,
  'shard count includes only valid published items'
);
select is(
  (select value->0->>'after' from delivery_test_result where name = 'shards'),
  null::text,
  'first shard has an open exclusive start'
);
select ok(
  (
    select 'statement_timeout=2s' = any (p.proconfig)
    from pg_catalog.pg_proc p
    where p.oid = 'public.list_published_delivery_shards(uuid,integer)'::regprocedure
  ),
  'shard wrapper pins a two-second statement timeout in pg_proc'
);

select throws_ok(
  $$select public.get_published_by_slug(null, 'blog', 'public')$$,
  '22023',
  'delivery_workspace_invalid',
  'null workspace fails with a stable code'
);
select throws_ok(
  $$select public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'bad/key',
    'public'
  )$$,
  '22023',
  'delivery_content_type_key_invalid',
  'invalid content type key fails with a stable code'
);
select throws_ok(
  $$select public.get_published_by_slug(
    'd7000000-0000-0000-0000-000000000001',
    'blog',
    'bad/slug'
  )$$,
  '22023',
  'delivery_slug_invalid',
  'invalid slug fails with a stable code'
);
select throws_ok(
  $$select public.list_published_delivery(
    'd7000000-0000-0000-0000-000000000001',
    'not-a-cursor',
    null,
    10
  )$$,
  '22023',
  'delivery_cursor_invalid',
  'malformed cursor fails with a stable code'
);
select throws_ok(
  $$select public.list_published_delivery(
    'd7000000-0000-0000-0000-000000000001',
    (select value->0->>'until' from delivery_test_result where name = 'shards'),
    (select value->>'next_cursor' from delivery_test_result where name = 'one'),
    10
  )$$,
  '22023',
  'delivery_cursor_invalid',
  'reversed cursor bounds fail with a stable code'
);
select throws_ok(
  $$select public.list_published_delivery(
    'd7000000-0000-0000-0000-000000000001',
    null,
    null,
    null
  )$$,
  '22023',
  'delivery_limit_invalid',
  'null list limit fails with a stable code'
);
select throws_ok(
  $$select public.list_published_delivery_shards(
    'd7000000-0000-0000-0000-000000000001',
    4001
  )$$,
  '22023',
  'delivery_shard_size_invalid',
  'oversized shard limit fails with a stable code'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    where p.oid in (
      'public.get_published_by_slug(uuid,text,text)'::regprocedure,
      'public.list_published_delivery(uuid,text,text,integer)'::regprocedure,
      'public.list_published_delivery_shards(uuid,integer)'::regprocedure
    )
      and p.prosecdef
  ),
  3,
  'all public delivery RPCs are SECURITY DEFINER'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    where p.oid in (
      'public.get_published_by_slug(uuid,text,text)'::regprocedure,
      'public.list_published_delivery(uuid,text,text,integer)'::regprocedure,
      'public.list_published_delivery_shards(uuid,integer)'::regprocedure
    )
      and 'search_path=""' = any (p.proconfig)
  ),
  3,
  'all public delivery RPCs pin an empty search path'
);
select is(
  (
    select array_agg(grants.rolename || ':' || grants.function_count order by grants.rolename)
    from (
      select roles.rolname as rolename, count(*)::text as function_count
      from pg_catalog.pg_proc p
      cross join lateral aclexplode(p.proacl) acl
      join pg_catalog.pg_roles roles on roles.oid = acl.grantee
      where p.oid in (
        'public.get_published_by_slug(uuid,text,text)'::regprocedure,
        'public.list_published_delivery(uuid,text,text,integer)'::regprocedure,
        'public.list_published_delivery_shards(uuid,integer)'::regprocedure
      )
        and acl.privilege_type = 'EXECUTE'
        and acl.grantee <> p.proowner
      group by roles.rolname
    ) grants
  ),
  array['anon:3', 'authenticated:3', 'service_role:3']::text[],
  'delivery RPC execute grants are limited to intended application roles'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    cross join lateral aclexplode(p.proacl) acl
    where p.oid in (
      'public.get_published_by_slug(uuid,text,text)'::regprocedure,
      'public.list_published_delivery(uuid,text,text,integer)'::regprocedure,
      'public.list_published_delivery_shards(uuid,integer)'::regprocedure
    )
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'PUBLIC has no execute grant on delivery RPCs'
);
select ok(
  not has_table_privilege('anon', 'public.content_type', 'select')
    and not has_table_privilege('anon', 'public.content_item', 'select')
    and not has_table_privilege('anon', 'public.content_revision', 'select')
    and not has_table_privilege('anon', 'public.content_seo', 'select'),
  'anon receives no direct delivery-table grants'
);
select ok(
  (
    select bool_and(
      not has_function_privilege('anon', signature, 'execute')
        and not has_function_privilege('authenticated', signature, 'execute')
    )
    from unnest(array[
      'movp_internal.assert_content_type_key_uniqueness()',
      'movp_internal.is_reserved_content_type_key(text)',
      'movp_internal.assert_no_reserved_content_type_keys()',
      'movp_internal.reject_reserved_content_type_key()',
      'movp_internal.delivery_cursor_encode(uuid)',
      'movp_internal.delivery_cursor_decode(text)',
      'movp_internal.list_published_delivery_shard_bounds(uuid,integer)'
    ]) signature
  ),
  'application roles cannot execute delivery internals'
);
select is(
  (select count(*)::integer from public.content_type where key = 'blog'),
  2,
  'the same content type key remains valid in different workspaces'
);

alter table public.content_type
  drop constraint content_type_workspace_key_unique;
insert into public.content_type (id, workspace_id, key, label, field_schema) values (
  'd7010000-0000-0000-0000-000000000003',
  'd7000000-0000-0000-0000-000000000001',
  'blog',
  'Duplicate Blog',
  '[]'::jsonb
);
select throws_ok(
  $$select movp_internal.assert_content_type_key_uniqueness()$$,
  '23505',
  'content_type_key_duplicates',
  'duplicate-key preflight fails with a stable counts-only code'
);
delete from public.content_type
where id = 'd7010000-0000-0000-0000-000000000003';
alter table public.content_type
  add constraint content_type_workspace_key_unique
  unique (workspace_id, key);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_constraint
    where conname = 'content_type_workspace_key_unique'
      and conrelid = 'public.content_type'::regclass
      and contype = 'u'
  ),
  1,
  'duplicate-key test restores the unique constraint'
);

alter table public.content_type disable trigger content_type_reserved_key_tg;
insert into public.content_type (id, workspace_id, key, label, field_schema) values (
  'd7010000-0000-0000-0000-000000000004',
  'd7000000-0000-0000-0000-000000000001',
  'admin',
  'Reserved Admin',
  '[]'::jsonb
);
alter table public.content_type enable trigger content_type_reserved_key_tg;
select throws_ok(
  $$select movp_internal.assert_no_reserved_content_type_keys()$$,
  '23514',
  'content_type_key_reserved',
  'reserved-key preflight fails with a stable code'
);
delete from public.content_type
where id = 'd7010000-0000-0000-0000-000000000004';
select throws_ok(
  $$insert into public.content_type (id, workspace_id, key, label, field_schema)
    values (
      'd7010000-0000-0000-0000-000000000005',
      'd7000000-0000-0000-0000-000000000001',
      'admin',
      'Reserved Admin',
      '[]'::jsonb
    )$$,
  '23514',
  'content_type_key_reserved',
  'reserved-key trigger rejects direct insert'
);
select throws_ok(
  $$update public.content_type
    set key = 'admin'
    where id = 'd7010000-0000-0000-0000-000000000001'$$,
  '23514',
  'content_type_key_reserved',
  'reserved-key trigger rejects direct update'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_trigger
    where tgname = 'content_type_reserved_key_tg'
      and tgrelid = 'public.content_type'::regclass
      and not tgisinternal
      and tgenabled = 'O'
  ),
  1,
  'reserved-key test leaves the trigger enabled'
);

create or replace function movp_internal.list_published_delivery_shard_bounds(
  ws uuid,
  p_urls_per_shard integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $test$
begin
  raise exception using
    errcode = '57014',
    message = 'simulated_query_cancel';
end;
$test$;

select throws_ok(
  $$select public.list_published_delivery_shards(
    'd7000000-0000-0000-0000-000000000001',
    4000
  )$$,
  'P5701',
  'delivery_shards_timeout',
  'public shard wrapper deterministically maps query cancellation'
);

select * from finish();
rollback;
