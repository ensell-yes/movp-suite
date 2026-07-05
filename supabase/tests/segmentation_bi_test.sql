begin;
select plan(10);

-- ── seed (as table owner) ────────────────────────────────────────────────────
-- NOTE: the rule/snapshot ids use valid hex (…c1 / …e1); 'r'/'s' are not hex digits.
insert into public.workspace (id, name)
  values ('dddddddd-0000-0000-0000-000000000001', 'BiWs') on conflict (id) do nothing;

-- Fact stream: 3 platform_events across 2 event_types × 2 sources.
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('dddddddd-0000-0000-0000-000000000001', 'registration.completed', 'user', 'user-1', 'internal', now() - interval '2 day', now()),
  ('dddddddd-0000-0000-0000-000000000001', 'registration.completed', 'user', 'user-2', 'external', now() - interval '1 day', now()),
  ('dddddddd-0000-0000-0000-000000000001', 'onboarding.completed',   'user', 'user-1', 'internal', now(),                    now());

-- A segment + a rule (for matched_rule_id), a recompute run, a snapshot, memberships over time.
insert into public.segment (id, workspace_id, name, active, mode)
  values ('dddddddd-0000-0000-0000-0000000000a1', 'dddddddd-0000-0000-0000-000000000001', 'Registered', true, 'dynamic');
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active)
  values ('dddddddd-0000-0000-0000-0000000000c1', 'dddddddd-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-0000000000a1', '{"all":[{"event":"registration.completed"}]}'::jsonb, 1, true);
insert into public.segment_recompute_run
  (workspace_id, segment_id, mode, started_at, finished_at, added_count, removed_count, evaluated_count, idempotency_key, outcome_code)
  values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'full',
          now() - interval '1 minute', now(), 2, 0, 2, 'seed-key-1', 'ok');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count)
  values ('dddddddd-0000-0000-0000-0000000000e1', 'dddddddd-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-0000000000a1', now(), 'on_demand', 2);
insert into public.segment_membership
  (workspace_id, segment_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'user', 'user-1',
   'dddddddd-0000-0000-0000-0000000000c1', now() - interval '2 day', now() - interval '2 day', '{"event_ids":[]}'::jsonb),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'user', 'user-2',
   'dddddddd-0000-0000-0000-0000000000c1', now() - interval '1 day', now() - interval '1 day', '{"event_ids":[]}'::jsonb);

-- ── fact-stream dimensional rollup: count events by (event_type, source) ──
select is(
  (select count(*)::int from (
     select event_type, source
       from public.platform_event
      where workspace_id = 'dddddddd-0000-0000-0000-000000000001'
      group by event_type, source) g),
  3, 'platform_event rolls up into 3 (event_type,source) dimension groups');

-- ── membership-over-time: subject × segment × evaluated_at (feature-export shape) ──
select is(
  (select count(*)::int from (
     select subject_ref, segment_id, evaluated_at
       from public.segment_membership
      where segment_id = 'dddddddd-0000-0000-0000-0000000000a1') m),
  2, 'membership-over-time returns subject x segment x evaluated_at rows');

-- ── metadata registry: reporting roles (dimension vs measure) ─────────────────
select is((select reporting_role from public.movp_fields where collection_name='platform_event' and name='event_type'),
          'dimension','platform_event.event_type is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='platform_event' and name='subject_type'),
          'dimension','platform_event.subject_type is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='platform_event' and name='source'),
          'dimension','platform_event.source is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='platform_event' and name='occurred_at'),
          'dimension','platform_event.occurred_at is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='segment_snapshot' and name='member_count'),
          'measure','segment_snapshot.member_count is a measure');
select is((select reporting_role from public.movp_fields where collection_name='segment_recompute_run' and name='added_count'),
          'measure','segment_recompute_run.added_count is a measure');
select is((select reporting_role from public.movp_fields where collection_name='segment_recompute_run' and name='removed_count'),
          'measure','segment_recompute_run.removed_count is a measure');
select is((select reporting_role from public.movp_fields where collection_name='segment_recompute_run' and name='evaluated_count'),
          'measure','segment_recompute_run.evaluated_count is a measure');

select * from finish();
rollback;
