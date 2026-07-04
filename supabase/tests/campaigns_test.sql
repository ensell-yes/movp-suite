begin;
select plan(45);

-- ── base seed (as table owner; RLS bypassed) ────────────────────────────────
-- W1 members: A (owner), C (member). B is NOT a member of W1.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- Marketing plan MP1 (owned by A).
insert into public.marketing_plan (id, workspace_id, name, owner_id, status) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'MP1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'active');
-- CAMP1: owned by A, under MP1.
insert into public.campaign (id, workspace_id, marketing_plan_id, name, owner_id, status) values
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'a0000000-0000-0000-0000-000000000001', 'CAMP1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft');
-- CAMP2: owned by C, but under MP1 (owned by A) — exercises the plan-owner branch (Task 3).
insert into public.campaign (id, workspace_id, marketing_plan_id, name, owner_id, status) values
  ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'a0000000-0000-0000-0000-000000000001', 'CAMP2',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'draft');
-- Channel + deliverable under CAMP1.
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name) values
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'email', 'Email');
insert into public.campaign_deliverable (id, workspace_id, campaign_id, channel_id, name, deliverable_type) values
  ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Launch Email', 'email');
-- Calendar event, metric, and segment under CAMP1 — seeded so the Task 3 non-member
-- 0-count assertions on these three tables are REAL RLS filters, not vacuous empty-table
-- reads (a member would also see 0 rows in an empty table).
insert into public.campaign_calendar_event (id, workspace_id, campaign_id, title, event_date, event_type) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'Launch Day', '2026-08-01', 'launch');
insert into public.campaign_metric (id, workspace_id, campaign_id, metric_key, value, measured_at) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'impressions', 1000, '2026-08-02');
insert into public.campaign_segment (id, workspace_id, campaign_id, targeting_role) values
  ('a5000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'primary');
-- F1 fixtures: a SECOND workspace W2 with its own campaign/channel/deliverable, so the
-- same-workspace-FK guards can be probed with genuinely cross-workspace references.
insert into public.workspace (id, name) values
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.marketing_plan (id, workspace_id, name, owner_id, status) values
  ('a2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'MPW2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'active');
insert into public.campaign (id, workspace_id, name, owner_id, status) values
  ('c2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'CW2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft');
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name) values
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'c2000000-0000-0000-0000-000000000002', 'email', 'W2 Email');
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('e2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'c2000000-0000-0000-0000-000000000002', 'W2 Deliverable', 'email');

-- ── Task 2: structural — tables exist ───────────────────────────────────────
select has_table('public', 'marketing_plan',         'marketing_plan table exists');
select has_table('public', 'campaign',               'campaign table exists');
select has_table('public', 'campaign_channel',       'campaign_channel table exists');
select has_table('public', 'campaign_deliverable',   'campaign_deliverable table exists');
select has_table('public', 'campaign_calendar_event','campaign_calendar_event table exists');
select has_table('public', 'campaign_metric',        'campaign_metric table exists');
select has_table('public', 'campaign_segment',       'campaign_segment table exists');

-- ── FK column names (Parts B/C depend on these EXACT names) ──────────────────
select has_column('public', 'campaign',             'marketing_plan_id', 'campaign has marketing_plan_id FK column');
select has_column('public', 'campaign_channel',     'campaign_id',       'campaign_channel has campaign_id FK column');
select has_column('public', 'campaign_deliverable', 'campaign_id',       'campaign_deliverable has campaign_id FK column');
select has_column('public', 'campaign_deliverable', 'channel_id',        'campaign_deliverable has channel_id FK column');
select has_column('public', 'campaign_metric',      'deliverable_id',    'campaign_metric has deliverable_id FK column');
select has_column('public', 'campaign_metric',      'channel_id',        'campaign_metric has channel_id FK column');

-- FK resolution: campaign.marketing_plan_id actually references public.marketing_plan.
select is((select count(*)::int from pg_constraint
           where conrelid = 'public.campaign'::regclass
             and confrelid = 'public.marketing_plan'::regclass
             and contype = 'f'),
          1, 'campaign.marketing_plan_id FK resolves to public.marketing_plan');
-- Behavioral: a dangling marketing_plan_id is rejected (proves the FK, not just a plain uuid).
select throws_ok(
  $$insert into public.campaign (workspace_id, marketing_plan_id, name)
    values ('11111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-0000000000ff', 'Dangling')$$,
  '23503', NULL, 'campaign.marketing_plan_id enforces its FK to marketing_plan');

-- ── no-duplication gate (LOAD-BEARING invariant) ────────────────────────────
select is((select count(*)::int from information_schema.columns
           where table_schema='public' and table_name='campaign_deliverable'
             and column_name in ('status','start_date','due_date','priority','assignee_user_id','description')),
          0, 'campaign_deliverable duplicates no task/scheduling state');

-- ── reporting roles (codegen writes movp_fields.reporting_role) ──────────────
select is((select reporting_role from public.movp_fields
           where collection_name='campaign_metric' and name='value'),
          'measure', 'campaign_metric.value is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='campaign_metric' and name='metric_key'),
          'dimension', 'campaign_metric.metric_key is a reporting dimension');

-- ── audit-only lifecycle triggers (RED until part 1 exists) ─────────────────
-- The seed inserted CAMP1 and one deliverable; each AFTER INSERT trigger must record
-- exactly one event with an ids/classifiers-only payload.
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          1, 'campaign.created recorded exactly one event for CAMP1');
select is((select payload->>'status' from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          'draft', 'campaign.created payload carries the status classifier');
-- entity_id is the cross-part contract key (Part C's e2e + the inbox key on it).
select is((select payload->>'entity_id' from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          'c0000000-0000-0000-0000-000000000001',
          'campaign.created payload carries entity_id = the campaign row id');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          1, 'deliverable.created recorded exactly one event');
select is((select payload->>'deliverable_type' from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          'email', 'deliverable.created payload carries the deliverable_type classifier');
-- entity_id is the cross-part contract key (Part C's e2e + the inbox key on it).
select is((select payload->>'entity_id' from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          'e0000000-0000-0000-0000-000000000001',
          'deliverable.created payload carries entity_id = the deliverable row id');
-- Audit-only: the guarded emit_event (000009) enqueues NO notify job for either event.
-- (These pass trivially before the triggers exist — no event -> no notify job — and remain
--  true after: the payloads carry no recipient_user_id/email. A FAILURE here means the
--  guarded emit_event from 000009 is not applied.)
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'campaign.created:%'),
          0, 'campaign.created is audit-only (no notify job enqueued)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'deliverable.created:%'),
          0, 'deliverable.created is audit-only (no notify job enqueued)');

-- ── Task 3: RLS matrix (role=authenticated) ─────────────────────────────────
set local role authenticated;

-- non-member B sees zero rows in every campaign table (SELECT is is_workspace_member
-- under both the blanket and the overridden policies — a contract pin).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.marketing_plan),         0, 'non-member sees zero marketing_plan');
select is((select count(*)::int from public.campaign),               0, 'non-member sees zero campaign');
select is((select count(*)::int from public.campaign_channel),       0, 'non-member sees zero campaign_channel');
select is((select count(*)::int from public.campaign_deliverable),   0, 'non-member sees zero campaign_deliverable');
select is((select count(*)::int from public.campaign_calendar_event),0, 'non-member sees zero campaign_calendar_event');
select is((select count(*)::int from public.campaign_metric),        0, 'non-member sees zero campaign_metric');
select is((select count(*)::int from public.campaign_segment),       0, 'non-member sees zero campaign_segment');

-- positive membership read: plain member C (a member of W1, owner of NEITHER CAMP1 nor MP1)
-- CAN SELECT campaign and marketing_plan rows — membership grants read (the SELECT policy is
-- is_workspace_member, unaffected by the owner-restricted UPDATE/DELETE overrides).
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          1, 'a plain member (non-owner) CAN SELECT a campaign');
select is((select count(*)::int from public.marketing_plan where id='a0000000-0000-0000-0000-000000000001'),
          1, 'a plain member (non-owner) CAN SELECT a marketing_plan');

-- edit-gating (RED before the override): member C is a workspace member but is NEITHER
-- CAMP1's owner (A) nor MP1's owner (A). Under the owner-restricted UPDATE policy the row
-- fails the USING clause, so C's UPDATE matches zero rows (silent no-op) — name unchanged.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.campaign set name='HIJACKED' where id='c0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          'CAMP1', 'a non-owner member cannot UPDATE a campaign (owner-restricted RLS is a no-op)');

-- positive: the campaign owner (A) CAN update CAMP1.
update public.campaign set name='CAMP1-EDITED' where id='c0000000-0000-0000-0000-000000000001';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          'CAMP1-EDITED', 'the campaign owner can UPDATE their campaign');

-- plan-owner branch: A owns MP1 but NOT CAMP2 (owned by C); A can still UPDATE CAMP2
-- because it belongs to A's marketing_plan (the OR arm of the policy).
update public.campaign set name='CAMP2-BY-PLAN-OWNER' where id='c0000000-0000-0000-0000-000000000002';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000002'),
          'CAMP2-BY-PLAN-OWNER', 'the marketing_plan owner can UPDATE a campaign under their plan');

-- marketing_plan is owner-gated too (RED before the override): member C (not MP1's owner)
-- cannot UPDATE MP1.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.marketing_plan set name='MP-HIJACK' where id='a0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select name from public.marketing_plan where id='a0000000-0000-0000-0000-000000000001'),
          'MP1', 'a non-owner member cannot UPDATE a marketing_plan (owner-restricted RLS is a no-op)');

-- DELETE edit-gating (RED before the override): member C (neither CAMP1's owner nor MP1's
-- owner) DELETE on CAMP1 is filtered out by the owner-restricted DELETE USING clause — a
-- silent no-op, so the row is still present afterward. (CAMP1 was renamed CAMP1-EDITED above.)
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
delete from public.campaign where id='c0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          1, 'a non-owner member cannot DELETE a campaign (owner-restricted RLS is a no-op)');

-- positive: the campaign owner (A) CAN DELETE their campaign (cascades to its channel/deliverable).
delete from public.campaign where id='c0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          0, 'the campaign owner can DELETE their campaign');

-- ── F1: same-workspace FK integrity — a W1 child referencing a W2 parent is REJECTED ────
-- Runs as authenticated W1-member A (role/claim still set from above): the child's own
-- workspace (W1) passes the blanket is_workspace_member INSERT policy, but the same-workspace-FK
-- trigger rejects the cross-workspace parent reference (errcode 23514). This is the exact F1
-- attack: a W1 member creating a W1 child that points at another workspace's campaign/channel/deliverable.
select throws_ok(
  $$insert into public.campaign_channel (workspace_id, campaign_id, channel_type)
    values ('11111111-1111-1111-1111-111111111111','c2000000-0000-0000-0000-000000000002','email')$$,
  '23514', NULL, 'a W1 campaign_channel cannot reference a W2 campaign (same-workspace FK guard)');
select throws_ok(
  $$insert into public.campaign_deliverable (workspace_id, campaign_id, channel_id, name, deliverable_type)
    values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002',
            'd2000000-0000-0000-0000-000000000002','Bad','email')$$,
  '23514', NULL, 'a W1 campaign_deliverable cannot reference a W2 channel (same-workspace FK guard)');
select throws_ok(
  $$insert into public.campaign_metric (workspace_id, campaign_id, deliverable_id, metric_key, value)
    values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002',
            'e2000000-0000-0000-0000-000000000002','clicks',5)$$,
  '23514', NULL, 'a W1 campaign_metric cannot reference a W2 deliverable (same-workspace FK guard)');
-- parent-side guard: a W1 campaign cannot reference a W2 marketing_plan (covers the plan-owner
-- authz branch). The BEFORE trigger fires before the RLS with-check, so this is 23514, not authz.
select throws_ok(
  $$insert into public.campaign (workspace_id, marketing_plan_id, name)
    values ('11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000002','Cross-Plan')$$,
  '23514', NULL, 'a W1 campaign cannot reference a W2 marketing_plan (same-workspace FK guard on the parent)');

select * from finish();
rollback;
