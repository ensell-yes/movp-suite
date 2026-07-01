begin;
select plan(5);

set local role anon;
select throws_ok(
  $$ select * from movp_internal.movp_jobs $$,
  '42501', null, 'anon cannot SELECT movp_internal.movp_jobs');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$ select * from movp_internal.movp_jobs $$,
  '42501', null, 'authenticated cannot SELECT movp_internal.movp_jobs');
select throws_ok(
  $$ insert into movp_internal.movp_jobs (kind, idempotency_key, payload)
     values ('embed','x','{}'::jsonb) $$,
  '42501', null, 'authenticated cannot INSERT movp_internal.movp_jobs');

reset role;
insert into public.workspace (id, name)
values ('22222222-2222-2222-2222-222222222222', 'VettedWs')
on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.note (workspace_id, title, body, status)
values ('22222222-2222-2222-2222-222222222222', 'Vetted', 'embed me', 'draft');

reset role;
select isnt(
  (select count(*)::int from movp_internal.movp_jobs where kind = 'embed'),
  0, 'vetted insert enqueued an embed job via the definer trigger');
select ok(true, 'internal-access invariants hold');

select * from finish();
rollback;
