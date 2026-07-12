-- C5a.4 upsert_by_external_ref: idempotent member-gated upsert.
begin;
select plan(6);

insert into public.workspace (id, name) values ('c5b00000-0000-0000-0000-000000000001', 'UpsertW1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5b00000-0000-0000-0000-000000000001', 'c5b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001', 'attio', 'rec-1', '{"stage":"lead"}'::jsonb)->>'external_id'),
  'rec-1', 'upsert returns the row');
select is((select count(*)::int from public.external_record where source = 'attio' and external_id = 'rec-1'),
  1, 'one row after first upsert');

select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001', 'attio', 'rec-1', '{"stage":"lead"}'::jsonb)->>'external_id'),
  'rec-1', 'replay returns the row');
reset role;
select is((select count(*)::int from movp_internal.movp_events
  where type = 'external.record.upserted' and workspace_id = 'c5b00000-0000-0000-0000-000000000001'),
  1, 'idempotent replay emits no second event');
set local role authenticated;

select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001', 'attio', 'rec-1', '{"stage":"won"}'::jsonb)->'payload'->>'stage'),
  'won', 'changed payload updates in place');

set local request.jwt.claims = '{"sub":"c5b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$ select public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001', 'attio', 'rec-9', '{}'::jsonb) $$,
  '42501', 'not_workspace_member', 'non-member denied');

reset role;
select * from finish();
rollback;
