-- C7.6a: anonymous published-only delivery reads and deterministic typed routes.

create or replace function movp_internal.assert_content_type_key_uniqueness()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, movp_internal
as $$
declare
  duplicate_group_count bigint;
begin
  select count(*)
  into duplicate_group_count
  from (
    select 1
    from public.content_type
    group by workspace_id, key
    having count(*) > 1
  ) duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception using
      errcode = '23505',
      message = 'content_type_key_duplicates';
  end if;
end;
$$;

revoke all on function movp_internal.assert_content_type_key_uniqueness()
  from public, anon, authenticated, service_role;

create or replace function movp_internal.is_reserved_content_type_key(p_key text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select p_key = any (
    array[
      'admin', 'api', 'auth', 'campaigns', 'content',
      'notes', 'segments', 'settings', 'tasks', 'workflows'
    ]::text[]
  );
$$;

revoke all on function movp_internal.is_reserved_content_type_key(text)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.assert_no_reserved_content_type_keys()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reserved_group_count bigint;
begin
  select count(*)
  into reserved_group_count
  from public.content_type content_type
  where movp_internal.is_reserved_content_type_key(content_type.key);

  if reserved_group_count > 0 then
    raise exception using
      errcode = '23514',
      message = 'content_type_key_reserved';
  end if;
end;
$$;

revoke all on function movp_internal.assert_no_reserved_content_type_keys()
  from public, anon, authenticated, service_role;

create or replace function movp_internal.reject_reserved_content_type_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if movp_internal.is_reserved_content_type_key(new.key) then
    raise exception using
      errcode = '23514',
      message = 'content_type_key_reserved';
  end if;

  return new;
end;
$$;

revoke all on function movp_internal.reject_reserved_content_type_key()
  from public, anon, authenticated, service_role;

select movp_internal.assert_content_type_key_uniqueness();
select movp_internal.assert_no_reserved_content_type_keys();

alter table public.content_type
  add constraint content_type_workspace_key_unique
  unique (workspace_id, key);

create trigger content_type_reserved_key_tg
  before insert or update of key on public.content_type
  for each row execute function movp_internal.reject_reserved_content_type_key();

create index content_item_delivery_status_id_idx
  on public.content_item (workspace_id, status, id);

create or replace function movp_internal.delivery_cursor_encode(p_id uuid)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.translate(
    pg_catalog.rtrim(
      pg_catalog.encode(
        pg_catalog.convert_to('v1:' || p_id::text, 'UTF8'),
        'base64'
      ),
      '='
    ),
    '+/',
    '-_'
  );
$$;

revoke all on function movp_internal.delivery_cursor_encode(uuid)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.delivery_cursor_decode(p_cursor text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  encoded text;
  decoded text;
  padding integer;
begin
  if pg_catalog.octet_length(p_cursor) < 4
    or pg_catalog.octet_length(p_cursor) > 128
    or p_cursor !~ '^[A-Za-z0-9_-]+$'
  then
    raise exception using
      errcode = '22023',
      message = 'delivery_cursor_invalid';
  end if;

  begin
    encoded := pg_catalog.translate(p_cursor, '-_', '+/');
    padding := (4 - (pg_catalog.length(encoded) % 4)) % 4;
    decoded := pg_catalog.convert_from(
      pg_catalog.decode(encoded || pg_catalog.repeat('=', padding), 'base64'),
      'UTF8'
    );

    if decoded !~ '^v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using
        errcode = '22023',
        message = 'delivery_cursor_invalid';
    end if;

    return pg_catalog.substr(decoded, 4)::uuid;
  exception
    when others then
      raise exception using
        errcode = '22023',
        message = 'delivery_cursor_invalid';
  end;
end;
$$;

revoke all on function movp_internal.delivery_cursor_decode(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if ws is null then
    raise exception using
      errcode = '22023',
      message = 'delivery_workspace_invalid';
  end if;

  if p_content_type_key is null
    or pg_catalog.octet_length(p_content_type_key) < 1
    or pg_catalog.octet_length(p_content_type_key) > 128
    or p_content_type_key !~ '^[a-z][a-z0-9_-]*$'
  then
    raise exception using
      errcode = '22023',
      message = 'delivery_content_type_key_invalid';
  end if;

  if p_slug is null
    or pg_catalog.octet_length(p_slug) < 1
    or pg_catalog.octet_length(p_slug) > 256
    or pg_catalog.strpos(p_slug, '/') > 0
    or pg_catalog.strpos(p_slug, pg_catalog.chr(92)) > 0
    or p_slug ~ '[[:cntrl:]]'
  then
    raise exception using
      errcode = '22023',
      message = 'delivery_slug_invalid';
  end if;

  select pg_catalog.jsonb_build_object(
    'item_id', item.id,
    'content_type_key', content_type.key,
    'slug', item.slug,
    'published_revision_id', revision.id,
    'published_at', item.published_at,
    'data', revision.data,
    'richtext_field_keys', (
      select coalesce(
        pg_catalog.jsonb_agg(field.value->>'name' order by field.ordinality),
        '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(content_type.field_schema) = 'array'
            then content_type.field_schema
          else '[]'::jsonb
        end
      ) with ordinality as field(value, ordinality)
      where pg_catalog.jsonb_typeof(field.value) = 'object'
        and field.value->>'type' = 'richtext'
        and field.value->>'name' ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'
    ),
    'richtext_field_keys_supported', not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(content_type.field_schema) = 'array'
            then content_type.field_schema
          else '[]'::jsonb
        end
      ) as field(value)
      where pg_catalog.jsonb_typeof(field.value) = 'object'
        and field.value->>'type' = 'richtext'
        and not coalesce(
          field.value->>'name' ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$',
          false
        )
    ),
    'meta', seo.meta,
    'jsonld', seo.jsonld
  )
  into result
  from public.content_item item
  join public.content_type content_type
    on content_type.id = item.content_type_id
    and content_type.workspace_id = item.workspace_id
  join public.content_revision revision
    on revision.id = item.published_revision_id
    and revision.content_item_id = item.id
    and revision.workspace_id = item.workspace_id
  left join public.content_seo seo
    on seo.content_item_id = item.id
    and seo.workspace_id = item.workspace_id
  where item.workspace_id = ws
    and content_type.key = p_content_type_key
    and item.slug = p_slug
    and item.status = 'published'
    and item.published_revision_id is not null
  limit 1;

  return result;
end;
$$;

revoke all on function public.get_published_by_slug(uuid, text, text)
  from public;
grant execute on function public.get_published_by_slug(uuid, text, text)
  to anon, authenticated, service_role;

create or replace function public.list_published_delivery(
  ws uuid,
  p_after text default null,
  p_until text default null,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  after_id uuid;
  until_id uuid;
  effective_limit integer;
  items jsonb;
  has_more boolean;
  last_returned_id uuid;
  next_cursor text;
begin
  if ws is null then
    raise exception using
      errcode = '22023',
      message = 'delivery_workspace_invalid';
  end if;

  if p_limit is null then
    raise exception using
      errcode = '22023',
      message = 'delivery_limit_invalid';
  end if;

  effective_limit := greatest(1, least(1000, p_limit));

  if p_after is not null then
    after_id := movp_internal.delivery_cursor_decode(p_after);
  end if;

  if p_until is not null then
    until_id := movp_internal.delivery_cursor_decode(p_until);
  end if;

  if after_id is not null and until_id is not null and after_id >= until_id then
    raise exception using
      errcode = '22023',
      message = 'delivery_cursor_invalid';
  end if;

  with candidate as (
    select
      item.id,
      content_type.key,
      item.slug,
      item.published_revision_id,
      item.published_at
    from public.content_item item
    join public.content_type content_type
      on content_type.id = item.content_type_id
      and content_type.workspace_id = item.workspace_id
    where item.workspace_id = ws
      and item.status = 'published'
      and item.published_revision_id is not null
      and (after_id is null or item.id > after_id)
      and (until_id is null or item.id <= until_id)
      and exists (
        select 1
        from public.content_revision revision
        where revision.id = item.published_revision_id
          and revision.content_item_id = item.id
          and revision.workspace_id = item.workspace_id
      )
    order by item.id
    limit effective_limit + 1
  ),
  numbered as (
    select
      candidate.*,
      pg_catalog.row_number() over (order by candidate.id) as row_number
    from candidate
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'item_id', numbered.id,
          'content_type_key', numbered.key,
          'slug', numbered.slug,
          'published_revision_id', numbered.published_revision_id,
          'published_at', numbered.published_at
        )
        order by numbered.id
      ) filter (where numbered.row_number <= effective_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*) > effective_limit,
    (
      pg_catalog.max(numbered.id::text)
        filter (where numbered.row_number <= effective_limit)
    )::uuid
  into items, has_more, last_returned_id
  from numbered;

  if has_more and last_returned_id is not null then
    next_cursor := movp_internal.delivery_cursor_encode(last_returned_id);
  end if;

  return pg_catalog.jsonb_build_object(
    'items', items,
    'next_cursor', next_cursor
  );
end;
$$;

revoke all on function public.list_published_delivery(uuid, text, text, integer)
  from public;
grant execute on function public.list_published_delivery(uuid, text, text, integer)
  to anon, authenticated, service_role;

create or replace function movp_internal.list_published_delivery_shard_bounds(
  ws uuid,
  p_urls_per_shard integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ordered as (
    select
      item.id,
      pg_catalog.row_number() over (order by item.id) as row_number
    from public.content_item item
    where item.workspace_id = ws
      and item.status = 'published'
      and item.published_revision_id is not null
      and exists (
        select 1
        from public.content_revision revision
        where revision.id = item.published_revision_id
          and revision.content_item_id = item.id
          and revision.workspace_id = item.workspace_id
      )
  ),
  grouped as (
    select
      ((ordered.row_number - 1) / p_urls_per_shard)::bigint as shard_index,
      pg_catalog.max(ordered.id::text)::uuid as end_id,
      pg_catalog.count(*) as item_count
    from ordered
    group by ((ordered.row_number - 1) / p_urls_per_shard)::bigint
  ),
  bounded as (
    select
      grouped.shard_index,
      pg_catalog.lag(grouped.end_id) over (order by grouped.shard_index) as start_id,
      grouped.end_id,
      grouped.item_count
    from grouped
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'after', movp_internal.delivery_cursor_encode(bounded.start_id),
        'until', movp_internal.delivery_cursor_encode(bounded.end_id),
        'count', bounded.item_count
      )
      order by bounded.shard_index
    ),
    '[]'::jsonb
  )
  from bounded;
$$;

revoke all on function movp_internal.list_published_delivery_shard_bounds(uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function public.list_published_delivery_shards(
  ws uuid,
  p_urls_per_shard integer default 4000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
begin
  if ws is null then
    raise exception using
      errcode = '22023',
      message = 'delivery_workspace_invalid';
  end if;

  if p_urls_per_shard is null
    or p_urls_per_shard < 1
    or p_urls_per_shard > 4000
  then
    raise exception using
      errcode = '22023',
      message = 'delivery_shard_size_invalid';
  end if;

  return movp_internal.list_published_delivery_shard_bounds(
    ws,
    p_urls_per_shard
  );
exception
  when query_canceled then
    raise exception using
      errcode = 'P5701',
      message = 'delivery_shards_timeout';
end;
$$;

revoke all on function public.list_published_delivery_shards(uuid, integer)
  from public;
grant execute on function public.list_published_delivery_shards(uuid, integer)
  to anon, authenticated, service_role;
