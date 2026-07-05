begin;
select plan(52);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

insert into public.platform_event
  (id, workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('91000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'seed.event', 'user', 'subject-seed', 'external', now(), now());

insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'SEG1', true, 'dynamic');
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('53000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', '{"op":"eq"}'::jsonb, 1, true);
insert into public.segment_membership
  (id, workspace_id, segment_id, subject_type, subject_ref, matched_rule_id) values
  ('54000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', 'user', 'subject-1',
   '53000000-0000-0000-0000-000000000001');
insert into public.segment_snapshot
  (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('55000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', now(), 'on_demand', 1);
insert into public.segment_snapshot_member
  (id, workspace_id, snapshot_id, subject_ref, matched_rule_id) values
  ('56000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '55000000-0000-0000-0000-000000000001', 'subject-1',
   '53000000-0000-0000-0000-000000000001');
insert into public.segment_recompute_run
  (id, workspace_id, segment_id, mode, added_count, removed_count, evaluated_count,
   idempotency_key, outcome_code) values
  ('57000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', 'dynamic', 1, 0, 1, 'idem-1', 'ok');

select has_table('public', 'platform_event',          'platform_event table exists');
select has_table('public', 'segment',                 'segment table exists');
select has_table('public', 'segment_rule',            'segment_rule table exists');
select has_table('public', 'segment_membership',      'segment_membership table exists');
select has_table('public', 'segment_snapshot',        'segment_snapshot table exists');
select has_table('public', 'segment_snapshot_member', 'segment_snapshot_member table exists');
select has_table('public', 'segment_recompute_run',   'segment_recompute_run table exists');

select has_column('public', 'segment_rule',            'segment_id',      'segment_rule has segment_id FK column');
select has_column('public', 'segment_membership',      'segment_id',      'segment_membership has segment_id FK column');
select has_column('public', 'segment_membership',      'matched_rule_id', 'segment_membership has matched_rule_id FK column');
select has_column('public', 'segment_snapshot',        'segment_id',      'segment_snapshot has segment_id FK column');
select has_column('public', 'segment_snapshot_member', 'snapshot_id',     'segment_snapshot_member has snapshot_id FK column');
select has_column('public', 'segment_snapshot_member', 'matched_rule_id', 'segment_snapshot_member has matched_rule_id FK column');
select has_column('public', 'segment_recompute_run',   'segment_id',      'segment_recompute_run has segment_id FK column');

select is((select count(*)::int from pg_constraint
           where conrelid = 'public.segment_rule'::regclass
             and confrelid = 'public.segment'::regclass
             and contype = 'f'),
          1, 'segment_rule.segment_id FK resolves to public.segment');

select has_index('public', 'platform_event', 'platform_event_subject_idx',   'platform_event_subject_idx exists');
select has_index('public', 'platform_event', 'platform_event_type_time_idx', 'platform_event_type_time_idx exists');

select col_is_unique('public', 'segment_membership', ARRAY['segment_id','subject_ref'],
  'segment_membership is unique on (segment_id, subject_ref)');

select is((select reporting_role from public.movp_fields
           where collection_name='segment_snapshot' and name='member_count'),
          'measure', 'segment_snapshot.member_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='added_count'),
          'measure', 'segment_recompute_run.added_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='removed_count'),
          'measure', 'segment_recompute_run.removed_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='evaluated_count'),
          'measure', 'segment_recompute_run.evaluated_count is a reporting measure');

select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='event_type'),
          'dimension', 'platform_event.event_type is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='subject_type'),
          'dimension', 'platform_event.subject_type is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='source'),
          'dimension', 'platform_event.source is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='occurred_at'),
          'dimension', 'platform_event.occurred_at is a reporting dimension');

select table_privs_are(
  'movp_internal', 'segmentation_bridged_type', 'authenticated', array[]::text[],
  'authenticated has no privileges on segmentation_bridged_type');

select throws_ok(
  $$update public.platform_event set subject_ref='x'
    where id='91000000-0000-0000-0000-000000000001'$$,
  '2F004', NULL, 'platform_event rejects UPDATE (append-only, 2F004)');
select throws_ok(
  $$delete from public.platform_event
    where id='91000000-0000-0000-0000-000000000001'$$,
  '2F004', NULL, 'platform_event rejects DELETE (append-only, 2F004)');

insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'SEG2', true, 'dynamic');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('55000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000002', now(), 'on_demand', 1);
insert into public.segment_snapshot_member (id, workspace_id, snapshot_id, subject_ref) values
  ('56000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '55000000-0000-0000-0000-000000000002', 'subject-cascade');
select lives_ok(
  $$delete from public.segment where id='52000000-0000-0000-0000-000000000002'$$,
  'parent segment delete with snapshot members SUCCEEDS (cascade, no 2F004 abort)');
select is((select count(*)::int from public.segment_snapshot_member
           where id='56000000-0000-0000-0000-000000000002'),
          0, 'cascade delete cleaned up the append-only snapshot member');

select lives_ok(
  $$select public.emit_event('account.created', NULL, '{}'::jsonb, 't')$$,
  'bridge skips (no raise) when the event has no workspace_id');
select lives_ok(
  $$select public.emit_event('account.created',
      '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 't')$$,
  'bridge skips (no raise) when the payload resolves no subject_ref');
select is((select count(*)::int from public.platform_event where event_type='account.created'),
          0, 'guarded/skipped bridge cases insert no platform_event');
insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-0000000000ff', '11111111-1111-1111-1111-111111111111',
   'SEG-companion', true, 'dynamic');
select is((select count(*)::int from public.segment
           where id='52000000-0000-0000-0000-0000000000ff'),
          1, 'a companion business insert survives the guarded (non-aborting) bridge');

insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('e1000000-0000-0000-0000-000000000001', 'account.created',
   '11111111-1111-1111-1111-111111111111',
   jsonb_build_object('id', 'user-777', 'entity_type', 'account', 'actor_ref', 'admin-1'),
   gen_random_uuid()::text, '2026-07-01T12:00:00+00'::timestamptz);
select is((select count(*)::int from public.platform_event where event_type='account.created'),
          1, 'bridged event_type fans out to exactly one platform_event');
select is((select source from public.platform_event where event_type='account.created'),
          'internal', 'bridged platform_event has source=internal');
select is((select subject_ref from public.platform_event where event_type='account.created'),
          'user-777', 'bridged subject_ref falls back to payload id via coalesce');
select is((select subject_type from public.platform_event where event_type='account.created'),
          'account', 'bridged subject_type maps from payload entity_type (F2, not hardcoded user)');
select is((select occurred_at from public.platform_event where event_type='account.created'),
          '2026-07-01T12:00:00+00'::timestamptz,
          'bridged occurred_at maps from movp_events.created_at');
insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('e1000000-0000-0000-0000-000000000002', 'note.created',
   '11111111-1111-1111-1111-111111111111',
   jsonb_build_object('id', 'note-1'), gen_random_uuid()::text, now());
select is((select count(*)::int from public.platform_event where properties->>'id'='note-1'),
          0, 'non-bridged event_type fans out no platform_event');

set local role authenticated;

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.platform_event
           where id='91000000-0000-0000-0000-000000000001'),
          1, 'a workspace member CAN SELECT platform_event');
select is((select count(*)::int from public.segment
           where id='52000000-0000-0000-0000-000000000001'),
          1, 'a workspace member CAN SELECT segment');

select lives_ok(
  $$delete from public.segment_snapshot_member where id='56000000-0000-0000-0000-000000000001'$$,
  'segment_snapshot_member direct DELETE is an RLS no-op (no error, no DELETE policy)');
select is((select count(*)::int from public.segment_snapshot_member
           where id='56000000-0000-0000-0000-000000000001'),
          1, 'segment_snapshot_member row survives a member direct DELETE (append-only via RLS)');

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.platform_event),          0, 'non-member sees zero platform_event');
select is((select count(*)::int from public.segment),                 0, 'non-member sees zero segment');
select is((select count(*)::int from public.segment_rule),            0, 'non-member sees zero segment_rule');
select is((select count(*)::int from public.segment_membership),      0, 'non-member sees zero segment_membership');
select is((select count(*)::int from public.segment_snapshot),        0, 'non-member sees zero segment_snapshot');
select is((select count(*)::int from public.segment_snapshot_member), 0, 'non-member sees zero segment_snapshot_member');
select is((select count(*)::int from public.segment_recompute_run),   0, 'non-member sees zero segment_recompute_run');

select * from finish();
rollback;
