-- C4c.3 BI seam grants audit: cross-workspace by design, isolated from app roles.
begin;
select plan(9);

insert into public.workspace (id, name) values
  ('c4c00000-0000-0000-0000-000000000001', 'BiW1'),
  ('c4c00000-0000-0000-0000-000000000002', 'BiW2');
insert into public.campaign (id, workspace_id, name, status) values
  ('c4c00000-0000-0000-0000-0000000000a1', 'c4c00000-0000-0000-0000-000000000001', 'A', 'active'),
  ('c4c00000-0000-0000-0000-0000000000a2', 'c4c00000-0000-0000-0000-000000000002', 'B', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4c00000-0000-0000-0000-000000000001', 'c4c00000-0000-0000-0000-0000000000a1', 'clicks', 10, current_date),
  ('c4c00000-0000-0000-0000-000000000002', 'c4c00000-0000-0000-0000-0000000000a2', 'clicks', 20, current_date);

select is(reporting.setup_bi_mirror(), 27,
  'mirror creates one BI view per reporting view (26 generated + v_task_cycle)');

create role movp_bi_smoke;
grant movp_bi_smoke to postgres;
grant usage on schema extensions to movp_bi_smoke;
grant usage on schema reporting_bi to movp_bi_smoke;
grant select on all tables in schema reporting_bi to movp_bi_smoke;

set local role movp_bi_smoke;
select is((select count(*)::int from reporting_bi.v_campaign_metric), 2,
  'BI role sees both workspaces via the intentionally cross-workspace mirror');
select throws_ok($$ select count(*) from reporting.v_campaign_metric $$, '42501', null,
  'BI role cannot read the app-facing reporting schema');
select throws_ok($$ select count(*) from public.campaign_metric $$, '42501', null,
  'BI role cannot read base tables');
select throws_ok($$ select count(*) from movp_internal.movp_jobs $$, '42501', null,
  'BI role cannot reach movp_internal');
reset role;

select ok(not has_schema_privilege('authenticated', 'reporting_bi', 'usage'),
  'authenticated lacks usage on reporting_bi');
select ok(not has_schema_privilege('anon', 'reporting_bi', 'usage'),
  'anon lacks usage on reporting_bi');
select ok(not has_table_privilege('authenticated', 'reporting_bi.v_campaign_metric', 'select'),
  'authenticated cannot select the mirror');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4c0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok($$ select reporting.setup_bi_mirror() $$, '42501', null,
  'authenticated cannot invoke the mirror setup');
reset role;

select * from finish();
rollback;
