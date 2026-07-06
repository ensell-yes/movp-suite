begin;
select plan(24);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

select table_privs_are(
  'public', 'webhook_subscription', 'authenticated', array['SELECT']::text[],
  'authenticated can select webhook_subscription but cannot write directly');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select throws_ok(
  $$insert into public.webhook_subscription (workspace_id, event_type_id, url)
    values ('11111111-1111-1111-1111-111111111111', (select id from public.event_type where key='task.completed'), 'https://example.test/direct')$$,
  '42501', NULL,
  'direct authenticated insert is denied');
select throws_ok(
  $$update public.webhook_subscription set active=false where workspace_id='11111111-1111-1111-1111-111111111111'$$,
  '42501', NULL,
  'direct authenticated update is denied');
select throws_ok(
  $$delete from public.webhook_subscription where workspace_id='11111111-1111-1111-1111-111111111111'$$,
  '42501', NULL,
  'direct authenticated delete is denied');

create temp table _registered as
select public.register_webhook_subscription(
  '11111111-1111-1111-1111-111111111111',
  'task.completed',
  'https://example.test/hook',
  '{"field":"event","op":"eq","value":"task.completed"}'::jsonb
) as result;
grant select on _registered to authenticated;

select ok(
  (select (result ? 'subscription_id') and (result ? 'secret') from _registered),
  'member register returns subscription id and one-time secret');

reset role;

select ok(
  exists (
    select 1
      from public.webhook_subscription s
     where s.id = ((select result->>'subscription_id' from _registered)::uuid)
       and s.workspace_id = '11111111-1111-1111-1111-111111111111'
       and s.secret_set
       and s.secret_last_rotated_at is not null
       and s.internal_webhook_id is not null
  ),
  'public subscription row has secret metadata and internal pointer');
select ok(
  not exists (
    select 1
      from public.webhook_subscription s
     where s.id = ((select result->>'subscription_id' from _registered)::uuid)
       and to_jsonb(s)::text like '%' || (select result->>'secret' from _registered) || '%'
  ),
  'public subscription row does not persist the secret value');
select is(
  (select count(*)::int
     from movp_internal.webhooks w
     join public.webhook_subscription s on s.internal_webhook_id = w.id
    where s.id = ((select result->>'subscription_id' from _registered)::uuid)
      and w.secret = (select result->>'secret' from _registered)
      and w.managed_by = 'workflow_subscription'),
  1,
  'internal webhook row exists exactly once and stores the secret');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$select public.register_webhook_subscription('11111111-1111-1111-1111-111111111111', 'task.completed', 'https://example.test/nope', null)$$,
  '42501', NULL,
  'non-member cannot register a subscription');
select throws_ok(
  $$select public.register_webhook_subscription('11111111-1111-1111-1111-111111111111', 'not.real', 'https://example.test/nope', null)$$,
  '42501', NULL,
  'membership is checked before event type validation');

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.register_webhook_subscription('11111111-1111-1111-1111-111111111111', 'not.real', 'https://example.test/nope', null)$$,
  '22023', NULL,
  'unknown event type is rejected after membership passes');
select throws_ok(
  $$select public.register_webhook_subscription('11111111-1111-1111-1111-111111111111', 'task.completed', 'https://example.test/nope', '[]'::jsonb)$$,
  '22023', NULL,
  'subscription filter must be a JSON object when present');

create temp table _rotated as
select public.rotate_webhook_secret(
  ((select result->>'subscription_id' from _registered)::uuid),
  '11111111-1111-1111-1111-111111111111'
) as result;

select isnt(
  (select result->>'secret' from _rotated),
  (select result->>'secret' from _registered),
  'rotate returns a new one-time secret');

reset role;
select is(
  (select w.secret
     from movp_internal.webhooks w
     join public.webhook_subscription s on s.internal_webhook_id = w.id
    where s.id = ((select result->>'subscription_id' from _registered)::uuid)),
  (select result->>'secret' from _rotated),
  'rotate updates the paired internal secret');
select ok(
  not exists (
    select 1
      from public.webhook_subscription s
     where s.id = ((select result->>'subscription_id' from _registered)::uuid)
       and to_jsonb(s)::text like '%' || (select result->>'secret' from _rotated) || '%'
  ),
  'rotated secret is not persisted publicly');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$select public.rotate_webhook_secret((select (result->>'subscription_id')::uuid from _registered), '11111111-1111-1111-1111-111111111111')$$,
  '42501', NULL,
  'non-member cannot rotate a subscription');
select throws_ok(
  $$select public.set_webhook_active((select (result->>'subscription_id')::uuid from _registered), '11111111-1111-1111-1111-111111111111', false)$$,
  '42501', NULL,
  'non-member cannot deactivate a subscription');
select throws_ok(
  $$select public.set_webhook_filter((select (result->>'subscription_id')::uuid from _registered), '11111111-1111-1111-1111-111111111111', '{}'::jsonb)$$,
  '42501', NULL,
  'non-member cannot update a subscription filter');

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  not (public.set_webhook_active(
    ((select result->>'subscription_id' from _registered)::uuid),
    '11111111-1111-1111-1111-111111111111',
    false
  )).active,
  'member can deactivate the public subscription');

reset role;
select is(
  (select w.active
     from movp_internal.webhooks w
     join public.webhook_subscription s on s.internal_webhook_id = w.id
    where s.id = ((select result->>'subscription_id' from _registered)::uuid)),
  false,
  'deactivate updates the paired internal webhook');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  (public.set_webhook_active(
    ((select result->>'subscription_id' from _registered)::uuid),
    '11111111-1111-1111-1111-111111111111',
    true
  )).active,
  'member can reactivate the public subscription');
select is(
  (public.set_webhook_filter(
    ((select result->>'subscription_id' from _registered)::uuid),
    '11111111-1111-1111-1111-111111111111',
    '{"field":"event","op":"eq","value":"content.published"}'::jsonb
  )).filter,
  '{"op": "eq", "field": "event", "value": "content.published"}'::jsonb,
  'member can update the subscription filter');
select throws_ok(
  $$select public.set_webhook_filter((select (result->>'subscription_id')::uuid from _registered), '11111111-1111-1111-1111-111111111111', '[]'::jsonb)$$,
  '22023', NULL,
  'set_webhook_filter validates JSON object shape');
reset role;
select ok(
  not exists (
    select 1
      from public.webhook_subscription s
     where s.id = ((select result->>'subscription_id' from _registered)::uuid)
       and to_jsonb(s)::text like '%' || (select result->>'secret' from _registered) || '%'
  ),
  'public row still contains no old secret after management operations');

rollback;
