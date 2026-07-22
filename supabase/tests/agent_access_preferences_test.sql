begin;
select plan(20);

-- (1-4) Internal storage exists, enforces RLS, and is closed to application roles.
select has_table('movp_internal', 'user_agent_access', 'user_agent_access table exists');
select ok(
  (select c.relrowsecurity
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'movp_internal' and c.relname = 'user_agent_access'),
  'user_agent_access has RLS enabled');
select ok(
  not has_table_privilege('authenticated', 'movp_internal.user_agent_access', 'select')
  and not has_table_privilege('authenticated', 'movp_internal.user_agent_access', 'insert')
  and not has_table_privilege('authenticated', 'movp_internal.user_agent_access', 'update')
  and not has_table_privilege('anon', 'movp_internal.user_agent_access', 'select'),
  'application roles have no direct user_agent_access privileges');
select ok(
  has_table_privilege('service_role', 'movp_internal.user_agent_access', 'select')
  and has_table_privilege('service_role', 'movp_internal.user_agent_access', 'insert')
  and has_table_privilege('service_role', 'movp_internal.user_agent_access', 'update'),
  'service_role can evaluate and maintain preferences');

-- (5-7) Public RPC signatures expose no caller-selected user id.
select has_function('public', 'get_agent_access_preferences', array[]::text[], 'get preferences exists');
select has_function(
  'public', 'update_agent_access_preferences', array['boolean', 'boolean'], 'update preferences exists');
select has_function('public', 'evaluate_agent_access', array['uuid'], 'service evaluator exists');

-- (8) A missing row preserves the enabled-by-default rollout behavior.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  public.get_agent_access_preferences(),
  '{"cli_enabled": true, "mcp_enabled": true}'::jsonb,
  'missing caller preference defaults both settings to enabled');

-- (9-11) The caller updates and reads only its own non-null booleans.
select is(
  public.update_agent_access_preferences(false, true),
  '{"cli_enabled": true, "mcp_enabled": false}'::jsonb,
  'caller can update both preferences');
select is(
  public.get_agent_access_preferences(),
  '{"cli_enabled": true, "mcp_enabled": false}'::jsonb,
  'caller reads its persisted preferences');
select throws_ok(
  $$select public.update_agent_access_preferences(null, true)$$,
  '22023', 'agent_access_preferences_required', 'null preferences are rejected');

-- (12) Direct reads remain closed even for an authenticated caller.
select throws_ok(
  $$select * from movp_internal.user_agent_access$$,
  '42501', null, 'authenticated cannot read user_agent_access directly');

-- (13-15) A second caller gets defaults, updates itself, and cannot alter the first caller.
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  public.get_agent_access_preferences(),
  '{"cli_enabled": true, "mcp_enabled": true}'::jsonb,
  'second caller cannot observe the first caller preferences');
select is(
  public.update_agent_access_preferences(false, false),
  '{"cli_enabled": false, "mcp_enabled": false}'::jsonb,
  'second caller updates only its own row');
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  public.get_agent_access_preferences(),
  '{"cli_enabled": true, "mcp_enabled": false}'::jsonb,
  'second caller update leaves the first caller unchanged');

-- (16-18) Only service_role can evaluate a resolved user id.
select throws_ok(
  $$select public.evaluate_agent_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null, 'authenticated cannot call the service evaluator');
set local role anon;
select throws_ok(
  $$select public.evaluate_agent_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', null, 'anon cannot call the service evaluator');
set local role service_role;
select is(
  public.evaluate_agent_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '{"cli_enabled": true, "mcp_enabled": false}'::jsonb,
  'service evaluator returns the effective caller preferences');

-- Seed a PAT to prove resolve_pat carries the same effective snapshot without secret material.
reset role;
insert into public.workspace (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Agent access test');
insert into movp_internal.personal_access_token
  (user_id, default_workspace_id, name, token_hash)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'agent-access',
  encode(extensions.digest('movp_pat_agent_access', 'sha256'), 'hex'));

-- (19-20) PAT resolution adds preferences while preserving the no-secret response boundary.
set local role service_role;
select is(
  (select jsonb_build_object(
     'mcp_enabled', resolved -> 'mcp_enabled',
     'cli_enabled', resolved -> 'cli_enabled')
   from (select public.resolve_pat(
     encode(extensions.digest('movp_pat_agent_access', 'sha256'), 'hex')) as resolved) r),
  '{"cli_enabled": true, "mcp_enabled": false}'::jsonb,
  'resolve_pat includes the effective preference snapshot');
select ok(
  (select not (resolved ? 'token') and not (resolved ? 'token_hash') and resolved ->> 'status' = 'ok'
   from (select public.resolve_pat(
     encode(extensions.digest('movp_pat_agent_access', 'sha256'), 'hex')) as resolved) r),
  'augmented resolve_pat remains successful and returns no secret material');

select * from finish();
rollback;
