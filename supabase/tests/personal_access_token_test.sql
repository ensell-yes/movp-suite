begin;
select plan(28);

-- seed as table owner (bypasses RLS): U in W1 AND W2 (multi-workspace); V in W3
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2'),
  ('33333333-3333-3333-3333-333333333333','W3');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('33333333-3333-3333-3333-333333333333','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','owner');
insert into public.note (id, workspace_id, title) values
  ('d1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','w1-note'),
  ('d2000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','w2-note'),
  ('d3000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','v-secret');

-- (1)(2) signatures exist
select has_function('public','create_personal_access_token',array['uuid','text','integer'],'create_personal_access_token exists');
select has_function('public','resolve_pat',array['text'],'resolve_pat exists');

-- U creates a PAT with home W1; capture the one-time result
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
create temp table _pat as
  select public.create_personal_access_token('11111111-1111-1111-1111-111111111111','main') as r;

-- (3)(4) one-time secret shape: movp_pat_ + 64 hex = 73 chars, prefixed
select is(length((select r->>'token' from _pat)), 73, 'pat token is movp_pat_ + 64 hex = 73 chars');
select ok((select (r->>'token') like 'movp_pat_%' from _pat), 'pat token carries the movp_pat_ prefix');

-- (5)(6) hash stored != raw; stored value is sha256hex of the raw token (read as table owner)
reset role;
select is(
  (select length(token_hash) from movp_internal.personal_access_token where id = (select (r->>'token_id')::uuid from _pat)),
  64, 'stored token_hash is 64 hex chars');
select ok(
  (select token_hash = encode(extensions.digest((select r->>'token' from _pat), 'sha256'), 'hex')
          and token_hash <> (select r->>'token' from _pat)
   from movp_internal.personal_access_token where id = (select (r->>'token_id')::uuid from _pat)),
  'stored hash is sha256hex of the raw token and differs from it');

-- (7) empty name -> 22023 pat_name_required
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.create_personal_access_token('11111111-1111-1111-1111-111111111111','')$$,
  '22023','pat_name_required','empty name is rejected');

-- (8) home workspace the caller is NOT a member of -> 42501 not_workspace_member
select throws_ok(
  $$select public.create_personal_access_token('33333333-3333-3333-3333-333333333333','x')$$,
  '42501','not_workspace_member','cannot mint a PAT homed in a workspace you are not a member of');

-- (9) movp_internal posture: authenticated cannot read the table directly
select throws_ok(
  $$select * from movp_internal.personal_access_token$$,
  '42501',null,'authenticated cannot SELECT movp_internal.personal_access_token directly');

-- seed MAIN (valid), EXPIRED, and REVOKED pats directly with known raw tokens for the resolve
-- tests. NB: the create-RPC result (_pat) is a temp table owned by the `authenticated` role, so
-- it must NOT be read while role = service_role; the resolve tests use literal seeded hashes.
reset role;
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','seeded-main',
   encode(extensions.digest('movp_pat_main','sha256'),'hex'));
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, expires_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','expired',
   encode(extensions.digest('movp_pat_expired','sha256'),'hex'), now() - interval '1 minute');
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, revoked_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','revoked',
   encode(extensions.digest('movp_pat_revoked','sha256'),'hex'), now());

-- (10-13) resolve_pat as service_role on the valid seeded PAT: ok + identity + no secret leak
set local role service_role;
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'status',
  'ok','valid PAT resolves ok');
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'user_id',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','resolve returns the owning user_id');
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'default_workspace_id',
  '11111111-1111-1111-1111-111111111111','resolve returns the home workspace hint');
select ok(
  (with j as (select public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) as v)
   select not (v ? 'token') and not (v ? 'token_hash') from j),
  'resolve_pat never returns secret material');

-- (14) a second resolve inside five minutes does not amplify last_used_at writes
reset role;
create temp table _last_used as
  select last_used_at from movp_internal.personal_access_token
   where token_hash = encode(extensions.digest('movp_pat_main','sha256'),'hex');
set local role service_role;
do $$ begin
  perform public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex'));
end $$;
reset role;
select is(
  (select last_used_at from movp_internal.personal_access_token
    where token_hash = encode(extensions.digest('movp_pat_main','sha256'),'hex')),
  (select last_used_at from _last_used),
  'resolve_pat throttles last_used_at writes within five minutes');

-- (15-17) not_found / expired / revoked discriminants (still service_role)
set local role service_role;
select is(public.resolve_pat('deadbeef') ->> 'status', 'not_found', 'unknown hash -> not_found');
select is(public.resolve_pat(encode(extensions.digest('movp_pat_expired','sha256'),'hex')) ->> 'status', 'expired', 'expired PAT -> expired');
select is(public.resolve_pat(encode(extensions.digest('movp_pat_revoked','sha256'),'hex')) ->> 'status', 'revoked', 'revoked PAT -> revoked');

-- (18)(19) resolve_pat is service-role only: authenticated and anon are denied
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.resolve_pat('deadbeef')$$,
  '42501',null,'authenticated cannot call resolve_pat (service-role only)');
set local role anon;
select throws_ok(
  $$select public.resolve_pat('deadbeef')$$,
  '42501',null,'anon cannot call resolve_pat (service-role only)');

-- (20) list exposes metadata, never the hash
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  public.list_personal_access_tokens()::text not like '%token_hash%'
  and (public.list_personal_access_tokens() -> 0 ? 'name'),
  'list exposes metadata, never token_hash');

-- (21) list is own-only: V sees none of U's tokens
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(jsonb_array_length(public.list_personal_access_tokens()), 0, 'list is own-only (V sees no PATs)');

-- (22) list requires a caller
set local request.jwt.claims = '{}';
select throws_ok(
  $$select public.list_personal_access_tokens()$$,
  '42501',null,'unauthenticated cannot list');

-- (23) revoke is own-only: V cannot revoke U's PAT
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  format($$select public.revoke_personal_access_token(%L)$$, (select r->>'token_id' from _pat)),
  'P0001','pat_not_found','V cannot revoke U''s PAT (own-only)');

-- (24) revoke of an unknown id -> pat_not_found
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.revoke_personal_access_token('99999999-9999-9999-9999-999999999999')$$,
  'P0001','pat_not_found','revoking an unknown id is rejected');

-- (25) U revokes its own PAT
select lives_ok(
  format($$select public.revoke_personal_access_token(%L)$$, (select r->>'token_id' from _pat)),
  'U revokes its own PAT');

-- (26-28) identity boundary + non-confinement, proven via the RLS the minted session inherits
select is((select count(*)::int from public.note where id = 'd1000000-0000-0000-0000-000000000001'), 1, 'U sees its W1 note');
select is((select count(*)::int from public.note where id = 'd2000000-0000-0000-0000-000000000002'), 1, 'U sees its W2 note too (PAT is user-scoped, NOT confined to default_workspace_id)');
select is((select count(*)::int from public.note where id = 'd3000000-0000-0000-0000-000000000003'), 0, 'U cannot see V''s private note (identity boundary)');

select * from finish();
rollback;
