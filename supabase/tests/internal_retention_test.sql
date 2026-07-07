begin;
select plan(10);

insert into public.workspace (id, name)
values ('11111111-1111-1111-1111-111111111111', 'W1');

insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'task.completed', '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 'retention-old', now() - interval '120 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'task.completed', '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 'retention-recent', now() - interval '10 days');

insert into movp_internal.movp_jobs (
  id, kind, idempotency_key, payload, workspace_id, status, updated_at, next_run_at
) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'notify', 'retention-done-old', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'done', now() - interval '40 days', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'notify', 'retention-dead-old', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'dead', now() - interval '40 days', now()),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'notify', 'retention-failed-old', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'failed', now() - interval '40 days', now()),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'notify', 'retention-pending-old', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'pending', now() - interval '40 days', now()),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'notify', 'retention-running-old', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'running', now() - interval '40 days', now()),
  ('bbbbbbbb-0000-0000-0000-000000000006', 'notify', 'retention-done-recent', '{}'::jsonb, '11111111-1111-1111-1111-111111111111', 'done', now() - interval '10 days', now());

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

select throws_ok(
  $$select public.prune_internal_retention(now() - interval '90 days', now() - interval '30 days', 100)$$,
  '42501', null,
  'authenticated callers cannot prune internal retention state');

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

create temp table _retention_result as
select public.prune_internal_retention(now() - interval '90 days', now() - interval '30 days', 100) as result;

select is((select (result->>'jobs_deleted')::int from _retention_result),
          2, 'retention prunes old terminal jobs only');
select is((select (result->>'events_deleted')::int from _retention_result),
          1, 'retention prunes old events');

select throws_ok(
  $$select public.prune_internal_retention(now(), now(), 0)$$,
  '22023', null,
  'retention rejects an invalid low batch limit');
select throws_ok(
  $$select public.prune_internal_retention(now(), now(), 100001)$$,
  '22023', null,
  'retention rejects an invalid high batch limit');

reset role;

select is((select count(*)::int from movp_internal.movp_jobs where id in (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002'
)), 0, 'old done/dead jobs are gone');
select is((select count(*)::int from movp_internal.movp_jobs where id in (
  'bbbbbbbb-0000-0000-0000-000000000003',
  'bbbbbbbb-0000-0000-0000-000000000004',
  'bbbbbbbb-0000-0000-0000-000000000005'
)), 3, 'failed/pending/running jobs survive pruning');
select is((select count(*)::int from movp_internal.movp_jobs where id='bbbbbbbb-0000-0000-0000-000000000006'),
          1, 'recent terminal jobs survive pruning');
select is((select count(*)::int from movp_internal.movp_events where id='aaaaaaaa-0000-0000-0000-000000000001'),
          0, 'old event is gone');
select is((select count(*)::int from movp_internal.movp_events where id='aaaaaaaa-0000-0000-0000-000000000002'),
          1, 'recent event survives pruning');

select * from finish();
rollback;
