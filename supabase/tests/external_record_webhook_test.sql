-- C5 webhook delivery must be per emitted event, not per stable external-record identity.
begin;
select plan(2);

insert into public.workspace (id, name) values ('c5e00000-0000-0000-0000-000000000001', 'ExtWebhookW1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5e00000-0000-0000-0000-000000000001', 'c5e0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5e0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select public.register_webhook_subscription(
  'c5e00000-0000-0000-0000-000000000001',
  'external.record.upserted',
  'https://example.test/external-record',
  null
);
reset role;

insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5e00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"stage":"lead"}'::jsonb);
select is(
  (select count(*)::int from movp_internal.movp_jobs
    where kind = 'webhook'
      and workspace_id = 'c5e00000-0000-0000-0000-000000000001'
      and payload->>'event' = 'external.record.upserted'),
  1, 'insert enqueues one external-record webhook delivery');

update public.external_record
   set payload = '{"stage":"won"}'::jsonb
 where workspace_id = 'c5e00000-0000-0000-0000-000000000001'
   and source = 'hubspot'
   and external_id = 'contact-1';
select is(
  (select count(*)::int from movp_internal.movp_jobs
    where kind = 'webhook'
      and workspace_id = 'c5e00000-0000-0000-0000-000000000001'
      and payload->>'event' = 'external.record.upserted'),
  2, 'changed payload enqueues a second external-record webhook delivery');

select * from finish();
rollback;
