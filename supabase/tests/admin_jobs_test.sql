begin;

select plan(8);

insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','member');

insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id, status) values
  ('webhook','k-dead','{"secret_url":"https://evil.example/leak"}','11111111-1111-1111-1111-111111111111','dead'),
  ('webhook','k-failed','{}','11111111-1111-1111-1111-111111111111','failed');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50)::text not like '%evil.example%',
  'dead-job listing does not leak payload values'
);
select ok(
  public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50) -> 0 -> 'payload_keys' ? 'secret_url',
  'dead-job listing exposes payload keys'
);
select is(
  (public.workspace_job_counts('11111111-1111-1111-1111-111111111111') ->> 'dead')::int,
  1,
  'counts dead=1'
);

set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select throws_ok(
  $$select public.workspace_job_counts('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  null,
  'non-member denied job counts'
);
select throws_ok(
  $$select public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50)$$,
  '42501',
  null,
  'non-member denied dead-job list'
);
select throws_ok(
  $$select public.replay_dead_jobs('11111111-1111-1111-1111-111111111111', null)$$,
  '42501',
  null,
  'non-member denied replay'
);

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  public.replay_dead_jobs('11111111-1111-1111-1111-111111111111', null),
  1,
  'replay resets exactly the 1 dead job'
);
reset role;
select is(
  (select status from movp_internal.movp_jobs where idempotency_key = 'k-failed'),
  'failed',
  'replay leaves failed jobs untouched (dead-only contract)'
);

select * from finish();
rollback;
