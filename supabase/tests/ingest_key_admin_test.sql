begin;

select plan(11);

insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
create temp table _key as
  select public.create_ingest_key('11111111-1111-1111-1111-111111111111','ci') as r;

select is(length((select r->>'raw_key' from _key)), 48, 'raw key is 48 hex chars');

reset role;
select is(
  (select length(key_hash) from movp_internal.ingest_key where id = (select (r->>'key_id')::uuid from _key)),
  64,
  'stored key_hash is 64 hex chars'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  public.list_ingest_keys('11111111-1111-1111-1111-111111111111')::text not like '%key_hash%'
  and (public.list_ingest_keys('11111111-1111-1111-1111-111111111111') -> 0 ? 'label'),
  'list exposes label, never key_hash'
);

set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select throws_ok(
  $$select public.create_ingest_key('11111111-1111-1111-1111-111111111111','x')$$,
  '42501',
  null,
  'member cannot create key'
);
select throws_ok(
  $$select public.list_ingest_keys('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  null,
  'member cannot list keys (denied, not empty)'
);
select throws_ok(
  format($$select public.rotate_ingest_key(%L, '11111111-1111-1111-1111-111111111111')$$, (select r->>'key_id' from _key)),
  '42501',
  null,
  'member cannot rotate key'
);
select throws_ok(
  format($$select public.revoke_ingest_key(%L, '11111111-1111-1111-1111-111111111111')$$, (select r->>'key_id' from _key)),
  '42501',
  null,
  'member cannot revoke key'
);

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.rotate_ingest_key('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111')$$,
  'P0001',
  'ingest_key_not_found',
  'rotate on a missing key raises P0001'
);

select public.revoke_ingest_key((select (r->>'key_id')::uuid from _key), '11111111-1111-1111-1111-111111111111');
select throws_ok(
  format($$select public.rotate_ingest_key(%L, '11111111-1111-1111-1111-111111111111')$$, (select r->>'key_id' from _key)),
  'P0001',
  'ingest_key_not_found',
  'rotating a revoked key is rejected'
);
reset role;
select is(
  (select active from movp_internal.ingest_key where id = (select (r->>'key_id')::uuid from _key)),
  false,
  'revoked key remains inactive after rejected rotate'
);

select is(
  (select length(key_hash) from movp_internal.ingest_key where id = (select (r->>'key_id')::uuid from _key)),
  64,
  'rejected rotate does not clear the stored hash'
);

select * from finish();
rollback;
