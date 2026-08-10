-- Harden experiment delivery after the initial additive foundation.

create index experiment_assignment_last_seen_at_idx
  on public.experiment_assignment (last_seen_at);

create or replace function public.prune_experiment_assignment_retention(
  p_before timestamptz default pg_catalog.now() - interval '90 days',
  p_batch_limit integer default 10000
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if p_before is null or p_batch_limit < 1 or p_batch_limit > 10000 then
    raise exception using
      errcode = '22023',
      message = 'experiment_assignment_retention_request_invalid';
  end if;

  with candidates as (
    select assignment.id
    from public.experiment_assignment assignment
    where assignment.last_seen_at is null
      or assignment.last_seen_at < p_before
    order by assignment.last_seen_at nulls first, assignment.id
    limit p_batch_limit
  )
  delete from public.experiment_assignment assignment
  using candidates
  where assignment.id = candidates.id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_experiment_assignment_retention(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.prune_experiment_assignment_retention(timestamptz, integer)
  to service_role;

create or replace function public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text,
  p_assignment_key text,
  p_persist_assignment boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  base_item record;
  experiment_row record;
  assignment_hash text;
  assigned_variant_id uuid;
  selected_item record;
  experiment_active boolean := false;
  assignment_error_code text := null;
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

  if p_assignment_key is not null
    and (
      pg_catalog.octet_length(p_assignment_key) < 16
      or pg_catalog.octet_length(p_assignment_key) > 128
      or p_assignment_key !~ '^[A-Za-z0-9_-]+$'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'delivery_assignment_key_invalid';
  end if;

  select
    item.id,
    item.workspace_id,
    item.content_type_id,
    content_type.key as content_type_key,
    item.slug,
    revision.id as published_revision_id,
    item.published_at,
    revision.data,
    content_type.field_schema,
    seo.meta,
    seo.jsonld,
    null::uuid as experiment_id,
    null::text as experiment_key,
    null::uuid as variant_id,
    null::text as variant_key
  into base_item
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

  if base_item.id is null then
    return null;
  end if;

  selected_item := base_item;

  select experiment.id, experiment.key
  into experiment_row
  from public.experiment experiment
  where experiment.workspace_id = ws
    and experiment.target_content_item_id = base_item.id
    and experiment.status = 'running'
    and (experiment.starts_at is null or experiment.starts_at <= pg_catalog.now())
    and (experiment.ends_at is null or experiment.ends_at > pg_catalog.now())
  limit 1;

  experiment_active := experiment_row.id is not null;

  if experiment_active and p_assignment_key is not null then
    assignment_hash := movp_internal.delivery_assignment_hash(
      experiment_row.id,
      p_assignment_key
    );

    select assignment.variant_id
    into assigned_variant_id
    from public.experiment_assignment assignment
    join public.experiment_variant variant
      on variant.id = assignment.variant_id
      and variant.experiment_id = assignment.experiment_id
      and variant.workspace_id = assignment.workspace_id
    join public.content_item item
      on item.id = variant.content_item_id
      and item.workspace_id = assignment.workspace_id
      and item.content_type_id = base_item.content_type_id
      and item.status = 'published'
      and item.published_revision_id is not null
    join public.content_revision revision
      on revision.id = item.published_revision_id
      and revision.content_item_id = item.id
      and revision.workspace_id = item.workspace_id
    where assignment.workspace_id = ws
      and assignment.experiment_id = experiment_row.id
      and assignment.assignment_key_hash = assignment_hash
    limit 1;

    if assigned_variant_id is null then
      with eligible as (
        select
          variant.id,
          variant.traffic_basis_points::integer as weight,
          pg_catalog.sum(variant.traffic_basis_points::integer) over () as total_weight,
          pg_catalog.sum(variant.traffic_basis_points::integer) over (
            order by variant.position, variant.id
          ) as cumulative_weight
        from public.experiment_variant variant
        join public.content_item item
          on item.id = variant.content_item_id
          and item.workspace_id = variant.workspace_id
          and item.content_type_id = base_item.content_type_id
          and item.status = 'published'
          and item.published_revision_id is not null
        join public.content_revision revision
          on revision.id = item.published_revision_id
          and revision.content_item_id = item.id
          and revision.workspace_id = item.workspace_id
        where variant.workspace_id = ws
          and variant.experiment_id = experiment_row.id
          and variant.active
          and variant.traffic_basis_points > 0
      ),
      selected as (
        select eligible.id
        from eligible
        where eligible.cumulative_weight > (
          (('x' || pg_catalog.substr(
            pg_catalog.md5(p_assignment_key || ':' || experiment_row.id::text),
            1,
            8
          ))::bit(32)::bigint) % eligible.total_weight
        )
        order by eligible.cumulative_weight, eligible.id
        limit 1
      )
      select selected.id
      into assigned_variant_id
      from selected;
    end if;

    if assigned_variant_id is not null and coalesce(p_persist_assignment, false) then
      begin
        delete from public.experiment_assignment assignment
        where assignment.workspace_id = ws
          and assignment.experiment_id = experiment_row.id
          and assignment.assignment_key_hash = assignment_hash
          and not exists (
            select 1
            from public.experiment_variant variant
            join public.content_item item
              on item.id = variant.content_item_id
              and item.workspace_id = variant.workspace_id
              and item.content_type_id = base_item.content_type_id
              and item.status = 'published'
              and item.published_revision_id is not null
            where variant.id = assignment.variant_id
              and variant.experiment_id = assignment.experiment_id
              and variant.workspace_id = assignment.workspace_id
          );

        insert into public.experiment_assignment (
          workspace_id,
          experiment_id,
          variant_id,
          assignment_key_hash,
          exposure_count,
          last_seen_at
        ) values (
          ws,
          experiment_row.id,
          assigned_variant_id,
          assignment_hash,
          1,
          pg_catalog.now()
        )
        on conflict (experiment_id, assignment_key_hash)
        do update set
          exposure_count = public.experiment_assignment.exposure_count + 1,
          last_seen_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
        returning variant_id into assigned_variant_id;
      exception when others then
        selected_item := base_item;
        assigned_variant_id := null;
        assignment_error_code := 'delivery_experiment_assignment_persist_failed';
      end;
    end if;

    if assigned_variant_id is not null then
      select
        item.id,
        item.workspace_id,
        item.content_type_id,
        base_item.content_type_key as content_type_key,
        base_item.slug as slug,
        revision.id as published_revision_id,
        item.published_at,
        revision.data,
        base_item.field_schema as field_schema,
        seo.meta,
        seo.jsonld,
        experiment_row.id as experiment_id,
        experiment_row.key as experiment_key,
        variant.id as variant_id,
        variant.key as variant_key
      into selected_item
      from public.experiment_variant variant
      join public.content_item item
        on item.id = variant.content_item_id
        and item.workspace_id = variant.workspace_id
        and item.content_type_id = base_item.content_type_id
        and item.status = 'published'
        and item.published_revision_id is not null
      join public.content_revision revision
        on revision.id = item.published_revision_id
        and revision.content_item_id = item.id
        and revision.workspace_id = item.workspace_id
      left join public.content_seo seo
        on seo.content_item_id = item.id
        and seo.workspace_id = item.workspace_id
      where variant.workspace_id = ws
        and variant.experiment_id = experiment_row.id
        and variant.id = assigned_variant_id
      limit 1;

      if selected_item.id is null then
        selected_item := base_item;
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'item_id', selected_item.id,
    'content_type_key', selected_item.content_type_key,
    'slug', selected_item.slug,
    'published_revision_id', selected_item.published_revision_id,
    'published_at', selected_item.published_at,
    'data', selected_item.data,
    'richtext_field_keys', (
      select coalesce(
        pg_catalog.jsonb_agg(field.value->>'name' order by field.ordinality),
        '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(selected_item.field_schema) = 'array'
            then selected_item.field_schema
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
          when pg_catalog.jsonb_typeof(selected_item.field_schema) = 'array'
            then selected_item.field_schema
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
    'meta', selected_item.meta,
    'jsonld', selected_item.jsonld,
    'experiment_active', experiment_active,
    'experiment_assignment_error_code', assignment_error_code,
    'experiment', case
      when selected_item.experiment_id is null then null::jsonb
      else pg_catalog.jsonb_build_object(
        'experiment_id', selected_item.experiment_id,
        'experiment_key', selected_item.experiment_key,
        'variant_id', selected_item.variant_id,
        'variant_key', selected_item.variant_key
      )
    end
  );
end;
$$;

revoke all on function public.get_published_by_slug(uuid, text, text, text, boolean)
  from public;
grant execute on function public.get_published_by_slug(uuid, text, text, text, boolean)
  to anon, authenticated, service_role;

create or replace function public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text,
  p_assignment_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return public.get_published_by_slug(
    ws,
    p_content_type_key,
    p_slug,
    p_assignment_key,
    false
  );
end;
$$;

revoke all on function public.get_published_by_slug(uuid, text, text, text)
  from public;
grant execute on function public.get_published_by_slug(uuid, text, text, text)
  to anon, authenticated, service_role;

create or replace function public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return public.get_published_by_slug(ws, p_content_type_key, p_slug, null, false);
end;
$$;

revoke all on function public.get_published_by_slug(uuid, text, text)
  from public;
grant execute on function public.get_published_by_slug(uuid, text, text)
  to anon, authenticated, service_role;

drop policy if exists experiment_rw on public.experiment;
drop policy if exists experiment_select on public.experiment;
drop policy if exists experiment_publish_insert on public.experiment;
drop policy if exists experiment_publish_update on public.experiment;
drop policy if exists experiment_publish_delete on public.experiment;
create policy experiment_select on public.experiment
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy experiment_publish_insert on public.experiment
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_publish_update on public.experiment
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_publish_delete on public.experiment
  for delete to authenticated
  using (public.has_content_capability(workspace_id, 'publish'));

drop policy if exists experiment_variant_rw on public.experiment_variant;
drop policy if exists experiment_variant_select on public.experiment_variant;
drop policy if exists experiment_variant_publish_insert on public.experiment_variant;
drop policy if exists experiment_variant_publish_update on public.experiment_variant;
drop policy if exists experiment_variant_publish_delete on public.experiment_variant;
create policy experiment_variant_select on public.experiment_variant
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy experiment_variant_publish_insert on public.experiment_variant
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_variant_publish_update on public.experiment_variant
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_variant_publish_delete on public.experiment_variant
  for delete to authenticated
  using (public.has_content_capability(workspace_id, 'publish'));

drop policy if exists experiment_assignment_rw on public.experiment_assignment;
drop policy if exists experiment_assignment_select on public.experiment_assignment;
drop policy if exists experiment_assignment_publish_insert on public.experiment_assignment;
drop policy if exists experiment_assignment_publish_update on public.experiment_assignment;
drop policy if exists experiment_assignment_publish_delete on public.experiment_assignment;
create policy experiment_assignment_select on public.experiment_assignment
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy experiment_assignment_publish_insert on public.experiment_assignment
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_assignment_publish_update on public.experiment_assignment
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'publish'));
create policy experiment_assignment_publish_delete on public.experiment_assignment
  for delete to authenticated
  using (public.has_content_capability(workspace_id, 'publish'));

-- Schedule out-of-band after deploy; pg_cron state is operational, not migration state.
-- select cron.schedule('experiment-assignment-retention', '17 3 * * *',
--   $cron$ select public.prune_experiment_assignment_retention(); $cron$);
