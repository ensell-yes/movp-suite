begin;
select plan(23);

insert into public.workspace (id, name) values
  ('a1700000-0000-0000-0000-000000000001', 'Agent write guards');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('a1700000-0000-0000-0000-000000000001', 'a1700000-0000-0000-0000-000000000002', 'member');
insert into public.campaign (id, workspace_id, name, status, owner_id) values
  ('a1700000-0000-0000-0000-000000000003', 'a1700000-0000-0000-0000-000000000001',
   'Mutable campaign', 'draft', 'a1700000-0000-0000-0000-000000000002');
insert into public.campaign_metric (id, workspace_id, campaign_id, metric_key, value) values
  ('a1700000-0000-0000-0000-000000000004', 'a1700000-0000-0000-0000-000000000001',
   'a1700000-0000-0000-0000-000000000003', 'leads', 1);
insert into public.segment (id, workspace_id, name, active, mode) values
  ('a1700000-0000-0000-0000-000000000005', 'a1700000-0000-0000-0000-000000000001',
   'Guarded segment', true, 'dynamic');
insert into public.segment_membership (id, workspace_id, segment_id, subject_ref) values
  ('a1700000-0000-0000-0000-000000000006', 'a1700000-0000-0000-0000-000000000001',
   'a1700000-0000-0000-0000-000000000005', 'subject-1');
insert into public.segment_snapshot (id, workspace_id, segment_id, reason, member_count) values
  ('a1700000-0000-0000-0000-000000000007', 'a1700000-0000-0000-0000-000000000001',
   'a1700000-0000-0000-0000-000000000005', 'on_demand', 1);
insert into public.segment_recompute_run
  (id, workspace_id, segment_id, added_count, removed_count, evaluated_count, outcome_code) values
  ('a1700000-0000-0000-0000-000000000008', 'a1700000-0000-0000-0000-000000000001',
   'a1700000-0000-0000-0000-000000000005', 1, 0, 1, 'ok');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1700000-0000-0000-0000-000000000002","role":"authenticated"}';

select lives_ok(
  $$update public.campaign set status='active' where id='a1700000-0000-0000-0000-000000000003'$$,
  'authenticated member can update a CRUD campaign');
select is((select status from public.campaign where id='a1700000-0000-0000-0000-000000000003'),
  'active', 'campaign update persisted');
select lives_ok(
  $$insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value)
    values ('a1700000-0000-0000-0000-000000000001',
            'a1700000-0000-0000-0000-000000000003', 'registrations', 2)$$,
  'authenticated member can append a campaign metric');
select throws_ok(
  $$update public.campaign_metric set value=999 where id='a1700000-0000-0000-0000-000000000004'$$,
  '42501', null, 'authenticated member cannot rewrite an append-only campaign metric');

select ok(has_table_privilege('authenticated', 'public.campaign_metric', 'SELECT'), 'campaign_metric grants SELECT');
select ok(has_table_privilege('authenticated', 'public.campaign_metric', 'INSERT'), 'campaign_metric grants INSERT');
select ok(not has_table_privilege('authenticated', 'public.campaign_metric', 'UPDATE'), 'campaign_metric denies UPDATE');
select ok(not has_table_privilege('authenticated', 'public.campaign_metric', 'DELETE'), 'campaign_metric denies DELETE');

select ok(has_table_privilege('authenticated', 'public.segment_membership', 'SELECT'), 'segment_membership grants SELECT');
select ok(not has_table_privilege('authenticated', 'public.segment_membership', 'INSERT'), 'segment_membership denies INSERT');
select ok(not has_table_privilege('authenticated', 'public.segment_membership', 'UPDATE'), 'segment_membership denies UPDATE');
select ok(not has_table_privilege('authenticated', 'public.segment_membership', 'DELETE'), 'segment_membership denies DELETE');

select ok(has_table_privilege('authenticated', 'public.segment_snapshot', 'SELECT'), 'segment_snapshot grants SELECT');
select ok(not has_table_privilege('authenticated', 'public.segment_snapshot', 'INSERT'), 'segment_snapshot denies INSERT');
select ok(not has_table_privilege('authenticated', 'public.segment_snapshot', 'UPDATE'), 'segment_snapshot denies UPDATE');
select ok(not has_table_privilege('authenticated', 'public.segment_snapshot', 'DELETE'), 'segment_snapshot denies DELETE');

select ok(has_table_privilege('authenticated', 'public.segment_recompute_run', 'SELECT'), 'segment_recompute_run grants SELECT');
select ok(not has_table_privilege('authenticated', 'public.segment_recompute_run', 'INSERT'), 'segment_recompute_run denies INSERT');
select ok(not has_table_privilege('authenticated', 'public.segment_recompute_run', 'UPDATE'), 'segment_recompute_run denies UPDATE');
select ok(not has_table_privilege('authenticated', 'public.segment_recompute_run', 'DELETE'), 'segment_recompute_run denies DELETE');

select throws_ok(
  $$update public.segment_membership set subject_ref='forged' where id='a1700000-0000-0000-0000-000000000006'$$,
  '42501', null, 'authenticated member cannot mutate materialized membership');
select throws_ok(
  $$update public.segment_snapshot set member_count=999 where id='a1700000-0000-0000-0000-000000000007'$$,
  '42501', null, 'authenticated member cannot rewrite an immutable snapshot');
select throws_ok(
  $$update public.segment_recompute_run set outcome_code='forged' where id='a1700000-0000-0000-0000-000000000008'$$,
  '42501', null, 'authenticated member cannot rewrite recompute audit');

select * from finish();
rollback;
