-- Make anonymous assignment persistence server-verifiable and keep exposure totals bounded.

create or replace function movp_internal.delivery_assignment_signing_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select secret.decrypted_secret
  from vault.decrypted_secrets secret
  where secret.name = 'movp_delivery_assignment_signing_key'
  limit 1;
$$;

revoke all on function movp_internal.delivery_assignment_signing_secret()
  from public, anon, authenticated, service_role;

create or replace function movp_internal.delivery_assignment_key_is_signed(
  p_workspace_id uuid,
  p_assignment_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_parts text[];
  signing_secret text;
  expected_signature text;
begin
  if p_workspace_id is null
    or p_assignment_key is null
    or p_assignment_key !~ '^[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{43}$'
  then
    return false;
  end if;

  signing_secret := movp_internal.delivery_assignment_signing_secret();
  if signing_secret is null then
    return false;
  end if;

  key_parts := pg_catalog.string_to_array(p_assignment_key, '.');
  expected_signature := pg_catalog.rtrim(
    pg_catalog.translate(
      pg_catalog.encode(
        extensions.hmac(
          p_workspace_id::text || ':' || key_parts[1],
          signing_secret,
          'sha256'
        ),
        'base64'
      ),
      '+/',
      '-_'
    ),
    '='
  );

  return expected_signature = key_parts[2];
end;
$$;

revoke all on function movp_internal.delivery_assignment_key_is_signed(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function movp_internal.published_experiment_variants(
  p_workspace_id uuid,
  p_experiment_id uuid,
  p_content_type_id uuid,
  p_require_fresh_eligibility boolean default false
)
returns table (
  variant_id uuid,
  variant_key text,
  content_item_id uuid,
  published_revision_id uuid,
  traffic_basis_points integer,
  variant_position integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    variant.id,
    variant.key,
    item.id,
    revision.id,
    variant.traffic_basis_points::integer,
    variant.position::integer
  from public.experiment_variant variant
  join public.content_item item
    on item.id = variant.content_item_id
    and item.workspace_id = variant.workspace_id
    and item.content_type_id = p_content_type_id
    and item.status = 'published'
    and item.published_revision_id is not null
  join public.content_revision revision
    on revision.id = item.published_revision_id
    and revision.content_item_id = item.id
    and revision.workspace_id = item.workspace_id
  where variant.workspace_id = p_workspace_id
    and variant.experiment_id = p_experiment_id
    and (
      not p_require_fresh_eligibility
      or (variant.active and variant.traffic_basis_points > 0)
    );
$$;

revoke all on function movp_internal.published_experiment_variants(uuid, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

create table movp_internal.experiment_variant_exposure (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  experiment_id uuid not null references public.experiment(id) on delete cascade,
  variant_id uuid not null,
  exposure_count bigint not null default 0 check (exposure_count >= 0),
  first_seen_at timestamptz not null default pg_catalog.now(),
  last_seen_at timestamptz not null default pg_catalog.now(),
  primary key (experiment_id, variant_id),
  foreign key (experiment_id, variant_id)
    references public.experiment_variant(experiment_id, id)
    on delete cascade
);

revoke all on table movp_internal.experiment_variant_exposure
  from public, anon, authenticated, service_role;

create or replace function public.experiment_running_workspace_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  running_count integer;
begin
  if new.status <> 'running' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.workspace_id::text, 0)
  );

  select count(*)::integer
  into running_count
  from public.experiment experiment
  where experiment.workspace_id = new.workspace_id
    and experiment.status = 'running'
    and experiment.id is distinct from new.id;

  if running_count >= 20 then
    raise exception using
      errcode = '22023',
      message = 'experiment_running_workspace_limit_exceeded';
  end if;

  return new;
end;
$$;

revoke all on function public.experiment_running_workspace_limit()
  from public, anon, authenticated, service_role;

create trigger experiment_running_workspace_limit_tg
  before insert or update of workspace_id, status on public.experiment
  for each row execute function public.experiment_running_workspace_limit();

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
    assignment_key_signed := movp_internal.delivery_assignment_key_is_signed(ws, p_assignment_key);
    assignment_hash := movp_internal.delivery_assignment_hash(experiment_row.id, p_assignment_key);

    select assignment.variant_id
    into assigned_variant_id
    from public.experiment_assignment assignment
    join movp_internal.published_experiment_variants(
      ws,
      experiment_row.id,
      base_item.content_type_id,
      false
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
          ws,
          experiment_row.id,
          base_item.content_type_id,
          true
        ) variant
      )
      select eligible.variant_id
      into assigned_variant_id
      from eligible
      where eligible.cumulative_weight > (
        (('x' || pg_catalog.substr(
          pg_catalog.md5(p_assignment_key || ':' || experiment_row.id::text),
          1,
          8
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
                ws,
                experiment_row.id,
                base_item.content_type_id,
                false
              ) variant
              where variant.variant_id = assignment.variant_id
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
        end if;

        insert into movp_internal.experiment_variant_exposure (
          workspace_id,
          experiment_id,
          variant_id,
          exposure_count,
          first_seen_at,
          last_seen_at
        ) values (
          ws,
          experiment_row.id,
          assigned_variant_id,
          1,
          pg_catalog.now(),
          pg_catalog.now()
        )
        on conflict (experiment_id, variant_id)
        do update set
          exposure_count = movp_internal.experiment_variant_exposure.exposure_count + 1,
          last_seen_at = pg_catalog.now();
      exception
        when SQLSTATE '57014' or SQLSTATE '57P01' then
          raise;
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
        ws,
        experiment_row.id,
        base_item.content_type_id,
        false
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
        pg_catalog.jsonb_agg(field.value->>'name' order by field.ordinality),
        '[]'::jsonb
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
