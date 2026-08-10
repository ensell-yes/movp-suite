begin;
select plan(48);

select vault.create_secret(
  'test-delivery-assignment-signing-key-000000000000000000000001',
  'movp_delivery_assignment_signing_key'
);

create function public.experiment_delivery_signed_key_for_test(p_nonce text)
returns text
language sql
stable
set search_path = ''
as $$
  select p_nonce || '.' || pg_catalog.rtrim(
    pg_catalog.translate(
      pg_catalog.encode(
        extensions.hmac(
          'ab000000-0000-0000-0000-000000000001:' || p_nonce,
          'test-delivery-assignment-signing-key-000000000000000000000001',
          'sha256'
        ),
        'base64'
      ),
      '+/',
      '-_'
    ),
    '='
  );
$$;

select ok(
  movp_internal.delivery_assignment_key_is_signed(
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111.FQbrcE1eHCnJ3DnPuoi8mR_n4mpeL7mRmbxPIPf4nG0'
  ),
  'the verifier accepts the fixed Web Crypto HMAC assignment token vector'
);

insert into public.workspace (id, name) values
  ('ab000000-0000-0000-0000-000000000001', 'Experiment One'),
  ('ab000000-0000-0000-0000-000000000002', 'Experiment Two');

insert into public.content_type (id, workspace_id, key, label, field_schema) values
  (
    'ab010000-0000-0000-0000-000000000001',
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'Landing Page',
    '[{"name":"title","type":"text"},{"name":"body","type":"richtext"}]'::jsonb
  ),
  (
    'ab010000-0000-0000-0000-000000000002',
    'ab000000-0000-0000-0000-000000000002',
    'landing',
    'Landing Page',
    '[{"name":"title","type":"text"}]'::jsonb
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
    'ab020000-0000-0000-0000-000000000001',
    'ab000000-0000-0000-0000-000000000001',
    'ab010000-0000-0000-0000-000000000001',
    'home',
    'published',
    '2026-08-10T12:00:00Z'
  ),
  (
    'ab020000-0000-0000-0000-000000000002',
    'ab000000-0000-0000-0000-000000000001',
    'ab010000-0000-0000-0000-000000000001',
    'home-b',
    'published',
    '2026-08-10T12:01:00Z'
  ),
  (
    'ab020000-0000-0000-0000-000000000003',
    'ab000000-0000-0000-0000-000000000001',
    'ab010000-0000-0000-0000-000000000001',
    'home-draft',
    'draft',
    null
  ),
  (
    'ab020000-0000-0000-0000-000000000004',
    'ab000000-0000-0000-0000-000000000002',
    'ab010000-0000-0000-0000-000000000002',
    'home-foreign',
    'published',
    '2026-08-10T12:02:00Z'
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
    'ab030000-0000-0000-0000-000000000001',
    'ab000000-0000-0000-0000-000000000001',
    'ab020000-0000-0000-0000-000000000001',
    1,
    '{"title":"Control","body":{"type":"doc","content":[]}}'::jsonb,
    'ab-control',
    'aba00000-0000-0000-0000-000000000001'
  ),
  (
    'ab030000-0000-0000-0000-000000000002',
    'ab000000-0000-0000-0000-000000000001',
    'ab020000-0000-0000-0000-000000000002',
    1,
    '{"title":"Variant B","body":{"type":"doc","content":[]}}'::jsonb,
    'ab-variant-b',
    'aba00000-0000-0000-0000-000000000001'
  ),
  (
    'ab030000-0000-0000-0000-000000000003',
    'ab000000-0000-0000-0000-000000000001',
    'ab020000-0000-0000-0000-000000000003',
    1,
    '{"title":"Draft Variant"}'::jsonb,
    'ab-draft-variant',
    'aba00000-0000-0000-0000-000000000001'
  ),
  (
    'ab030000-0000-0000-0000-000000000004',
    'ab000000-0000-0000-0000-000000000002',
    'ab020000-0000-0000-0000-000000000004',
    1,
    '{"title":"Foreign Variant"}'::jsonb,
    'ab-foreign-variant',
    'aba00000-0000-0000-0000-000000000002'
  );

update public.content_item
set
  current_revision_id = 'ab030000-0000-0000-0000-000000000001',
  published_revision_id = 'ab030000-0000-0000-0000-000000000001'
where id = 'ab020000-0000-0000-0000-000000000001';

update public.content_item
set
  current_revision_id = 'ab030000-0000-0000-0000-000000000002',
  published_revision_id = 'ab030000-0000-0000-0000-000000000002'
where id = 'ab020000-0000-0000-0000-000000000002';

update public.content_item
set current_revision_id = 'ab030000-0000-0000-0000-000000000003'
where id = 'ab020000-0000-0000-0000-000000000003';

update public.content_item
set
  current_revision_id = 'ab030000-0000-0000-0000-000000000004',
  published_revision_id = 'ab030000-0000-0000-0000-000000000004'
where id = 'ab020000-0000-0000-0000-000000000004';

select has_table('public', 'experiment', 'experiment table exists');
select has_table('public', 'experiment_variant', 'experiment_variant table exists');
select has_table('public', 'experiment_assignment', 'experiment_assignment table exists');
select has_table(
  'movp_internal',
  'experiment_variant_exposure',
  'bounded aggregate experiment exposure table exists'
);
select has_table(
  'movp_internal',
  'experiment_variant_exposure_daily',
  'narrow daily experiment exposure table exists'
);
select has_function(
  'public',
  'get_published_by_slug',
  array['uuid', 'text', 'text', 'text'],
  'experiment-aware published read RPC exists'
);
select has_function(
  'public',
  'get_published_by_slug',
  array['uuid', 'text', 'text', 'text', 'boolean'],
  'experiment-aware persisted published read RPC exists'
);
select has_function(
  'public',
  'reporting_experiment_exposure',
  array['uuid', 'integer'],
  'member-gated experiment exposure reporting RPC exists'
);
select has_function(
  'public',
  'prune_experiment_variant_exposure_daily_retention',
  array['date', 'integer'],
  'bounded daily exposure retention RPC exists'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'experiment'
      and indexname = 'experiment_workspace_key_uniq'
  ),
  'experiment key is unique per workspace');
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'experiment_variant'
      and indexname = 'experiment_variant_experiment_key_uniq'
  ),
  'variant key is unique per experiment');
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'experiment_assignment'
      and indexname = 'experiment_assignment_key_uniq'
  ),
  'assignment hash is unique per experiment');

insert into public.experiment (
  id,
  workspace_id,
  key,
  name,
  target_content_item_id,
  status
) values (
  'ab040000-0000-0000-0000-000000000001',
  'ab000000-0000-0000-0000-000000000001',
  'home-hero',
  'Home hero',
  'ab020000-0000-0000-0000-000000000001',
  'running'
);

insert into public.experiment_variant (
  id,
  workspace_id,
  experiment_id,
  key,
  content_item_id,
  traffic_basis_points,
  active,
  position
) values
  (
    'ab050000-0000-0000-0000-000000000001',
    'ab000000-0000-0000-0000-000000000001',
    'ab040000-0000-0000-0000-000000000001',
    'control',
    'ab020000-0000-0000-0000-000000000001',
    5000,
    true,
    0
  ),
  (
    'ab050000-0000-0000-0000-000000000002',
    'ab000000-0000-0000-0000-000000000001',
    'ab040000-0000-0000-0000-000000000001',
    'variant-b',
    'ab020000-0000-0000-0000-000000000002',
    5000,
    true,
    1
  ),
  (
    'ab050000-0000-0000-0000-000000000003',
    'ab000000-0000-0000-0000-000000000001',
    'ab040000-0000-0000-0000-000000000001',
    'draft',
    'ab020000-0000-0000-0000-000000000003',
    10000,
    false,
    2
  );

set local role anon;
select ok(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    'unsigned_attacker_key_0001',
    true
  )->'experiment' is not null,
  'anon resolves an experiment variant with an unsigned key'
);
reset role;

select is(
  (select count(*)::integer from public.experiment_assignment),
  0,
  'an unsigned anon key cannot create an assignment even when persistence is requested'
);
select is(
  coalesce((select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure), 0),
  0,
  'an unsigned anon key cannot increment aggregate experiment exposure'
);

select ok(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000001'),
    false
  )->'experiment' is not null,
  'experiment metadata is returned for a signed deterministic first-sight assignment'
);
select is(
  (select count(*)::integer from public.experiment_assignment),
  0,
  'first-sight signed assignment selects a variant without creating an assignment row'
);
select is(
  (
    select pg_catalog.jsonb_build_array(
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure),
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure_daily)
    )
  ),
  '[1,1]'::jsonb,
  'a signed first sight contributes matching aggregate and daily exposures'
);
select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000001'),
    true
  )->>'slug',
  'home',
  'variant renders under the requested public slug'
);
select ok(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000001'),
    true
  )->'experiment' is not null,
  'a returning assignment is persisted and remains experiment-backed'
);
select ok(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000001'),
    true
  )->'experiment' is not null,
  'a persisted assignment remains resolvable'
);
select is(
  (select count(*)::integer from public.experiment_assignment),
  1,
  'repeated reads reuse one persisted assignment'
);
select is(
  (select exposure_count::integer from public.experiment_assignment),
  3,
  'returning experiment reads increment the assignment exposure counter'
);
select is(
  (
    select pg_catalog.jsonb_build_array(
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure),
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure_daily)
    )
  ),
  '[4,4]'::jsonb,
  'aggregate and daily exposure counts include first sight and every signed delivery'
);
select is(
  pg_catalog.octet_length((select assignment_key_hash from public.experiment_assignment)),
  64,
  'assignment stores only a sha256-sized key hash'
);
select isnt(
  (select assignment_key_hash from public.experiment_assignment),
  public.experiment_delivery_signed_key_for_test('visitor_0000000001'),
  'assignment never stores the raw visitor key'
);

insert into public.experiment_assignment (
  workspace_id,
  experiment_id,
  variant_id,
  assignment_key_hash,
  exposure_count,
  last_seen_at
) values (
  'ab000000-0000-0000-0000-000000000001',
  'ab040000-0000-0000-0000-000000000001',
  'ab050000-0000-0000-0000-000000000002',
  movp_internal.delivery_assignment_hash(
    'ab040000-0000-0000-0000-000000000001',
  public.experiment_delivery_signed_key_for_test('visitor_variant_b_0001')
  ),
  1,
  pg_catalog.now()
);

update public.experiment_variant
set traffic_basis_points = case when key = 'control' then 10000 else 0 end
where experiment_id = 'ab040000-0000-0000-0000-000000000001';

select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_variant_b_0001'),
    true
  )->'experiment'->>'variant_id',
  'ab050000-0000-0000-0000-000000000002',
  'a persisted variant remains sticky after its traffic weight is set to zero'
);
select is(
  (
    select variant_id::text
    from public.experiment_assignment
    where assignment_key_hash = movp_internal.delivery_assignment_hash(
      'ab040000-0000-0000-0000-000000000001',
      public.experiment_delivery_signed_key_for_test('visitor_variant_b_0001')
    )
  ),
  'ab050000-0000-0000-0000-000000000002',
  'traffic ramp-down does not overwrite the sticky persisted variant'
);

select throws_ok(
  $$insert into public.experiment_variant (
      workspace_id,
      experiment_id,
      key,
      content_item_id,
      traffic_basis_points
    ) values (
      'ab000000-0000-0000-0000-000000000001',
      'ab040000-0000-0000-0000-000000000001',
      'foreign',
      'ab020000-0000-0000-0000-000000000004',
      1000
    )$$,
  '23503',
  'experiment_variant_content_workspace_mismatch',
  'variant content item must stay in the experiment workspace'
);

insert into public.workspace_membership (workspace_id, user_id, role) values
  (
    'ab000000-0000-0000-0000-000000000001',
    'ab060000-0000-0000-0000-000000000001',
    'owner'
  ),
  (
    'ab000000-0000-0000-0000-000000000001',
    'ab060000-0000-0000-0000-000000000002',
    'member'
  );
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"ab060000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$update public.experiment set name = 'Member rewrite'
    where id = 'ab040000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'a workspace member without publish capability cannot rewrite an experiment'
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"ab060000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (public.reporting_experiment_exposure(
    'ab000000-0000-0000-0000-000000000001',
    30
  )->>'window_days')::integer,
  30,
  'a workspace member reads the requested bounded exposure window'
);
select is(
  (
    select (entry->>'exposure_count')::integer
    from pg_catalog.jsonb_array_elements(
      public.reporting_experiment_exposure(
        'ab000000-0000-0000-0000-000000000001',
        30
      )->'variants'
    ) entry
    where entry->>'variant_key' = 'control'
  ),
  4,
  'member reporting returns the signed delivery count for the control variant'
);
reset role;

insert into movp_internal.experiment_variant_exposure_daily (
  experiment_id,
  variant_id,
  observed_on,
  exposure_count
) values (
  'ab040000-0000-0000-0000-000000000001',
  'ab050000-0000-0000-0000-000000000001',
  current_date - 91,
  999
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"ab060000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(
  (
    select (entry->>'exposure_count')::integer
    from pg_catalog.jsonb_array_elements(
      public.reporting_experiment_exposure(
        'ab000000-0000-0000-0000-000000000001',
        100000
      )->'variants'
    ) entry
    where entry->>'variant_key' = 'control'
  ),
  4,
  'reporting clamps to ninety days and excludes stale daily exposure buckets'
);
reset role;

select is(
  public.prune_experiment_variant_exposure_daily_retention(current_date - 90, 10),
  1,
  'daily exposure retention removes bounded stale rows by observed_on'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"ab060000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok(
  $$select public.reporting_experiment_exposure(
      'ab000000-0000-0000-0000-000000000001',
      30
    )$$,
  '42501',
  'not_workspace_member',
  'a non-member cannot read experiment exposure reporting'
);
reset role;

create function public.fail_experiment_exposure_persist_test()
returns trigger
language plpgsql
as $$
begin
  raise exception 'experiment_exposure_persist_test_failure';
end;
$$;
create trigger experiment_exposure_persist_test_tg
before insert or update on movp_internal.experiment_variant_exposure
for each row execute function public.fail_experiment_exposure_persist_test();

select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_variant_b_0001'),
    true
  )->'experiment'->>'variant_key',
  'variant-b',
  'an exposure persistence failure preserves the sticky variant'
);
select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_variant_b_0001'),
    true
  )->>'experiment_assignment_error_code',
  'delivery_experiment_assignment_persist_failed',
  'exposure persistence failure returns only the bounded safe code'
);

drop trigger experiment_exposure_persist_test_tg on movp_internal.experiment_variant_exposure;
drop function public.fail_experiment_exposure_persist_test();

select ok(
  pg_get_functiondef('public.get_published_by_slug(uuid, text, text, text, boolean)'::regprocedure)
    ~ 'when SQLSTATE ''57014'' or SQLSTATE ''57P01'' then[[:space:]]+raise;',
  'query cancellation and admin shutdown are explicitly re-raised from persistence'
);
select ok(
  pg_get_functiondef('public.get_published_by_slug(uuid, text, text, text, boolean)'::regprocedure)
    ~ 'assignment_signing_secret := movp_internal\.delivery_assignment_signing_secret\(\);',
  'the delivery RPC reads and reuses the Vault signing secret once per call'
);

insert into public.experiment_assignment (
  workspace_id,
  experiment_id,
  variant_id,
  assignment_key_hash,
  exposure_count,
  last_seen_at
) values (
  'ab000000-0000-0000-0000-000000000001',
  'ab040000-0000-0000-0000-000000000001',
  'ab050000-0000-0000-0000-000000000001',
  movp_internal.delivery_assignment_hash(
    'ab040000-0000-0000-0000-000000000001',
    public.experiment_delivery_signed_key_for_test('visitor_retention_0001')
  ),
  1,
  pg_catalog.now() - interval '91 days'
);
select is(
  public.prune_experiment_assignment_retention(
    pg_catalog.now() - interval '90 days',
    10
  ),
  1,
  'retention removes bounded stale assignment rows by last_seen_at'
);

delete from vault.secrets
where name = 'movp_delivery_assignment_signing_key';

select ok(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_missing_secret_01'),
    true
  )->'experiment' is not null,
  'a missing Vault signing secret still resolves a deterministic experiment variant'
);
select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_missing_secret_02'),
    true
  )->>'experiment_assignment_error_code',
  'delivery_experiment_assignment_unsigned',
  'a missing Vault signing secret returns the bounded unsigned assignment code'
);
select is(
  (
    select pg_catalog.jsonb_build_array(
      (select count(*)::integer from public.experiment_assignment),
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure),
      (select sum(exposure_count)::integer from movp_internal.experiment_variant_exposure_daily)
    )
  ),
  '[2,5,5]'::jsonb,
  'missing signing secrets create neither assignment rows nor aggregate exposure counts'
);

insert into public.content_item (
  id,
  workspace_id,
  content_type_id,
  slug,
  status
)
select
  ('ab070000-0000-0000-0000-' || pg_catalog.lpad(series::text, 12, '0'))::uuid,
  'ab000000-0000-0000-0000-000000000001',
  'ab010000-0000-0000-0000-000000000001',
  'experiment-limit-' || series::text,
  'draft'
from pg_catalog.generate_series(1, 20) as series;

insert into public.experiment (
  id,
  workspace_id,
  key,
  name,
  target_content_item_id,
  status
)
select
  ('ab080000-0000-0000-0000-' || pg_catalog.lpad(series::text, 12, '0'))::uuid,
  'ab000000-0000-0000-0000-000000000001',
  'experiment-limit-' || series::text,
  'Experiment limit ' || series::text,
  ('ab070000-0000-0000-0000-' || pg_catalog.lpad(series::text, 12, '0'))::uuid,
  'running'
from pg_catalog.generate_series(1, 19) as series;

select throws_ok(
  $$insert into public.experiment (
      id,
      workspace_id,
      key,
      name,
      target_content_item_id,
      status
    ) values (
      'ab080000-0000-0000-0000-000000000020',
      'ab000000-0000-0000-0000-000000000001',
      'experiment-limit-20',
      'Experiment limit 20',
      'ab070000-0000-0000-0000-000000000020',
      'running'
    )$$,
  '22023',
  'experiment_running_workspace_limit_exceeded',
  'a workspace cannot run more than twenty experiments at once'
);

update public.experiment set status = 'paused'
where id = 'ab040000-0000-0000-0000-000000000001';

select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000002'),
    true
  )->'experiment',
  'null'::jsonb,
  'paused experiment falls back to ordinary published delivery'
);
select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home',
    public.experiment_delivery_signed_key_for_test('visitor_0000000002'),
    true
  )->'data'->>'title',
  'Control',
  'paused experiment returns the control published revision'
);
select is(
  public.get_published_by_slug(
    'ab000000-0000-0000-0000-000000000001',
    'landing',
    'home-foreign',
    public.experiment_delivery_signed_key_for_test('visitor_0000000002'),
    true
  ),
  null::jsonb,
  'experiment delivery does not cross workspace boundaries'
);

select finish();
rollback;
