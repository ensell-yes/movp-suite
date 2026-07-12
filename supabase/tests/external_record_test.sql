-- C5a.3 external_record: identity immutability, no-delete, idempotent event emission.
begin;
select plan(9);

insert into public.workspace (id, name) values
  ('c5a00000-0000-0000-0000-000000000001', 'ExtW1'),
  ('c5a00000-0000-0000-0000-000000000002', 'ExtW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5a00000-0000-0000-0000-000000000001', 'c5a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c5a00000-0000-0000-0000-000000000002', 'c5a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":true}'::jsonb);
reset role;
select is(
  (select count(*)::int from movp_internal.movp_events
     where type = 'external.record.upserted' and workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  1, 'insert emits exactly one external.record.upserted');
set local role authenticated;

insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":true}'::jsonb)
on conflict (workspace_id, source, external_id) do update
  set payload = excluded.payload, updated_at = now()
  where public.external_record.payload is distinct from excluded.payload;
reset role;
select is(
  (select count(*)::int from movp_internal.movp_events
    where type = 'external.record.upserted' and workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  1, 'same-payload replay emits no new event');
set local role authenticated;

insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":false}'::jsonb)
on conflict (workspace_id, source, external_id) do update
  set payload = excluded.payload, updated_at = now()
  where public.external_record.payload is distinct from excluded.payload;
reset role;
select is(
  (select count(*)::int from movp_internal.movp_events
    where type = 'external.record.upserted' and workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  2, 'changed payload emits one more event');
set local role authenticated;

select throws_ok(
  $$ update public.external_record set source = 'salesforce'
       where source = 'hubspot' and external_id = 'contact-1' $$,
  'P0001', 'external_ref_identity_immutable', 'source is immutable');
select throws_ok(
  $$ update public.external_record set external_id = 'contact-2'
       where source = 'hubspot' and external_id = 'contact-1' $$,
  'P0001', 'external_ref_identity_immutable', 'external_id is immutable');

create temp table _external_record_deleted as
  with deleted as (
    delete from public.external_record
     where source = 'hubspot' and external_id = 'contact-1'
     returning 1 as deleted
  )
  select deleted from deleted;
select is((select count(*)::int from _external_record_deleted), 0, 'generic delete removes no rows');
reset role;
select is(
  (select count(*)::int from public.external_record where source = 'hubspot'),
  1, 'row survives the denied delete');
set local role authenticated;

select throws_ok(
  $$ insert into public.external_record (workspace_id, source, external_id, payload)
     values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{}'::jsonb) $$,
  '23505', null, 'duplicate external identity rejected in workspace');

set local request.jwt.claims = '{"sub":"c5a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  (select count(*)::int from public.external_record where workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  0, 'member B sees no W1 external records');

reset role;
select * from finish();
rollback;
