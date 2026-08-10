-- Surface signed-assignment failures and expose bounded experiment exposure reporting.

create or replace function movp_internal.delivery_assignment_signature_matches(
  p_expected text,
  p_actual text
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  byte_index integer;
  difference integer := 0;
  expected_bytes bytea;
  actual_bytes bytea;
begin
  if p_expected is null
    or p_actual is null
    or pg_catalog.octet_length(p_expected) <> 43
    or pg_catalog.octet_length(p_actual) <> 43
  then
    return false;
  end if;

  expected_bytes := pg_catalog.convert_to(p_expected, 'UTF8');
  actual_bytes := pg_catalog.convert_to(p_actual, 'UTF8');
  for byte_index in 0..42 loop
    difference := difference | (
      pg_catalog.get_byte(expected_bytes, byte_index)
      # pg_catalog.get_byte(actual_bytes, byte_index)
    );
  end loop;
  return difference = 0;
end;
$$;

revoke all on function movp_internal.delivery_assignment_signature_matches(text, text)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.delivery_assignment_key_is_signed(
  p_workspace_id uuid,
  p_assignment_key text,
  p_signing_secret text
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  key_parts text[];
  expected_signature text;
begin
  if p_workspace_id is null
    or p_signing_secret is null
    or p_assignment_key is null
    or p_assignment_key !~ '^[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{43}$'
  then
    return false;
  end if;

  key_parts := pg_catalog.string_to_array(p_assignment_key, '.');
  expected_signature := pg_catalog.rtrim(
    pg_catalog.translate(
      pg_catalog.encode(
        extensions.hmac(
          p_workspace_id::text || ':' || key_parts[1],
          p_signing_secret,
          'sha256'
        ),
        'base64'
      ),
      '+/',
      '-_'
    ),
    '='
  );

  return movp_internal.delivery_assignment_signature_matches(
    expected_signature,
    key_parts[2]
  );
end;
$$;

revoke all on function movp_internal.delivery_assignment_key_is_signed(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.delivery_assignment_key_is_signed(
  p_workspace_id uuid,
  p_assignment_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select movp_internal.delivery_assignment_key_is_signed(
    p_workspace_id,
    p_assignment_key,
    movp_internal.delivery_assignment_signing_secret()
  );
$$;

revoke all on function movp_internal.delivery_assignment_key_is_signed(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.increment_experiment_exposure_daily_counts(
  p_counts jsonb,
  p_observed_on date
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  with retained as (
    select entry.key as observed_on, (entry.value #>> '{}')::bigint as exposure_count
    from pg_catalog.jsonb_each(coalesce(p_counts, '{}'::jsonb)) entry
    where entry.key >= (p_observed_on - 89)::text
  ),
  incremented as (
    select
      retained.observed_on,
      retained.exposure_count
        + case when retained.observed_on = p_observed_on::text then 1 else 0 end as exposure_count
    from retained
    union all
    select p_observed_on::text, 1
    where not exists (
      select 1 from retained where retained.observed_on = p_observed_on::text
    )
  )
  select coalesce(
    pg_catalog.jsonb_object_agg(incremented.observed_on, incremented.exposure_count),
    '{}'::jsonb
  )
  from incremented;
$$;

revoke all on function movp_internal.increment_experiment_exposure_daily_counts(jsonb, date)
  from public, anon, authenticated, service_role;

alter table movp_internal.experiment_variant_exposure
  add column daily_exposure_counts jsonb not null default '{}'::jsonb;

create or replace function movp_internal.experiment_exposure_daily_counts_valid(p_counts jsonb)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_counts) = 'object'
    and (select count(*) from pg_catalog.jsonb_each(p_counts)) <= 90
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_counts) entry
      where entry.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or pg_catalog.jsonb_typeof(entry.value) <> 'number'
        or entry.value #>> '{}' !~ '^[0-9]+$'
    );
$$;

revoke all on function movp_internal.experiment_exposure_daily_counts_valid(jsonb)
  from public, anon, authenticated, service_role;

alter table movp_internal.experiment_variant_exposure
  add constraint experiment_variant_exposure_daily_counts_valid
  check (movp_internal.experiment_exposure_daily_counts_valid(daily_exposure_counts));

create or replace function public.reporting_experiment_exposure(
  ws uuid,
  days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d integer := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'window_days', d,
    'variants', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'experiment_id', experiment.id,
          'experiment_key', experiment.key,
          'variant_id', variant.id,
          'variant_key', variant.key,
          'exposure_count', coalesce(windowed.exposure_count, 0)
        )
        order by experiment.key, variant.position, variant.id
      )
      from movp_internal.experiment_variant_exposure exposure
      join public.experiment experiment
        on experiment.id = exposure.experiment_id
        and experiment.workspace_id = exposure.workspace_id
      join public.experiment_variant variant
        on variant.id = exposure.variant_id
        and variant.experiment_id = exposure.experiment_id
        and variant.workspace_id = exposure.workspace_id
      left join lateral (
        select coalesce(sum((entry.value #>> '{}')::bigint), 0) as exposure_count
        from pg_catalog.jsonb_each(exposure.daily_exposure_counts) entry
        where entry.key >= (current_date - (d - 1))::text
      ) windowed on true
      where exposure.workspace_id = ws
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.reporting_experiment_exposure(uuid, integer)
  from public, anon;
grant execute on function public.reporting_experiment_exposure(uuid, integer)
  to authenticated;

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
  assignment_key_signed boolean := false;
  assignment_signing_secret text;
begin
  if ws is null then
    raise exception using errcode = '22023', message = 'delivery_workspace_invalid';
  end if;

  if p_content_type_key is null
    or pg_catalog.octet_length(p_content_type_key) < 1
    or pg_catalog.octet_length(p_content_type_key) > 128
    or p_content_type_key !~ '^[a-z][a-z0-9_-]*$'
  then
    raise exception using errcode = '22023', message = 'delivery_content_type_key_invalid';
  end if;

  if p_slug is null
    or pg_catalog.octet_length(p_slug) < 1
    or pg_catalog.octet_length(p_slug) > 256
    or pg_catalog.strpos(p_slug, '/') > 0
    or pg_catalog.strpos(p_slug, pg_catalog.chr(92)) > 0
    or p_slug ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'delivery_slug_invalid';
  end if;

  if p_assignment_key is not null
    and (
      pg_catalog.octet_length(p_assignment_key) < 16
      or pg_catalog.octet_length(p_assignment_key) > 172
      or p_assignment_key !~ '^[A-Za-z0-9_.-]+$'
    )
  then
    raise exception using errcode = '22023', message = 'delivery_assignment_key_invalid';
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
    assignment_signing_secret := movp_internal.delivery_assignment_signing_secret();
    assignment_key_signed := movp_internal.delivery_assignment_key_is_signed(
      ws,
      p_assignment_key,
      assignment_signing_secret
    );
    if not assignment_key_signed then
      assignment_error_code := 'delivery_experiment_assignment_unsigned';
    end if;
    assignment_hash := movp_internal.delivery_assignment_hash(experiment_row.id, p_assignment_key);

    select assignment.variant_id
    into assigned_variant_id
    from public.experiment_assignment assignment
    join movp_internal.published_experiment_variants(
      ws, experiment_row.id, base_item.content_type_id, false
    ) variant on variant.variant_id = assignment.variant_id
    where assignment.workspace_id = ws
      and assignment.experiment_id = experiment_row.id
      and assignment.assignment_key_hash = assignment_hash
    limit 1;

    if assigned_variant_id is null then
      with eligible as (
        select
          variant.variant_id,
          variant.traffic_basis_points as weight,
          pg_catalog.sum(variant.traffic_basis_points) over () as total_weight,
          pg_catalog.sum(variant.traffic_basis_points) over (
            order by variant.variant_position, variant.variant_id
          ) as cumulative_weight
        from movp_internal.published_experiment_variants(
          ws, experiment_row.id, base_item.content_type_id, true
        ) variant
      )
      select eligible.variant_id
      into assigned_variant_id
      from eligible
      where eligible.cumulative_weight > (
        (('x' || pg_catalog.substr(
          pg_catalog.md5(p_assignment_key || ':' || experiment_row.id::text), 1, 8
        ))::bit(32)::bigint) % eligible.total_weight
      )
      order by eligible.cumulative_weight, eligible.variant_id
      limit 1;
    end if;

    if assigned_variant_id is not null and assignment_key_signed then
      begin
        if coalesce(p_persist_assignment, false) then
          delete from public.experiment_assignment assignment
          where assignment.workspace_id = ws
            and assignment.experiment_id = experiment_row.id
            and assignment.assignment_key_hash = assignment_hash
            and not exists (
              select 1
              from movp_internal.published_experiment_variants(
                ws, experiment_row.id, base_item.content_type_id, false
              ) variant
              where variant.variant_id = assignment.variant_id
            );

          insert into public.experiment_assignment (
            workspace_id, experiment_id, variant_id, assignment_key_hash, exposure_count, last_seen_at
          ) values (
            ws, experiment_row.id, assigned_variant_id, assignment_hash, 1, pg_catalog.now()
          )
          on conflict (experiment_id, assignment_key_hash)
          do update set
            exposure_count = public.experiment_assignment.exposure_count + 1,
            last_seen_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
          returning variant_id into assigned_variant_id;
        end if;

        insert into movp_internal.experiment_variant_exposure (
          workspace_id,
          experiment_id,
          variant_id,
          exposure_count,
          first_seen_at,
          last_seen_at,
          daily_exposure_counts
        ) values (
          ws,
          experiment_row.id,
          assigned_variant_id,
          1,
          pg_catalog.now(),
          pg_catalog.now(),
          movp_internal.increment_experiment_exposure_daily_counts('{}'::jsonb, current_date)
        )
        on conflict (experiment_id, variant_id)
        do update set
          exposure_count = movp_internal.experiment_variant_exposure.exposure_count + 1,
          last_seen_at = pg_catalog.now(),
          daily_exposure_counts = movp_internal.increment_experiment_exposure_daily_counts(
            movp_internal.experiment_variant_exposure.daily_exposure_counts,
            current_date
          );
      exception
        when SQLSTATE '57014' or SQLSTATE '57P01' then raise;
        when others then
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
        variant.variant_id as variant_id,
        variant.variant_key as variant_key
      into selected_item
      from movp_internal.published_experiment_variants(
        ws, experiment_row.id, base_item.content_type_id, false
      ) variant
      join public.content_item item on item.id = variant.content_item_id
      join public.content_revision revision on revision.id = variant.published_revision_id
      left join public.content_seo seo
        on seo.content_item_id = item.id
        and seo.workspace_id = item.workspace_id
      where variant.variant_id = assigned_variant_id
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
        pg_catalog.jsonb_agg(field.value->>'name' order by field.ordinality), '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(selected_item.field_schema) = 'array'
          then selected_item.field_schema else '[]'::jsonb end
      ) with ordinality as field(value, ordinality)
      where pg_catalog.jsonb_typeof(field.value) = 'object'
        and field.value->>'type' = 'richtext'
        and field.value->>'name' ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'
    ),
    'richtext_field_keys_supported', not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(selected_item.field_schema) = 'array'
          then selected_item.field_schema else '[]'::jsonb end
      ) as field(value)
      where pg_catalog.jsonb_typeof(field.value) = 'object'
        and field.value->>'type' = 'richtext'
        and not coalesce(field.value->>'name' ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$', false)
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
