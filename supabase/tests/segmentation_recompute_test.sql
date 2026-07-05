begin;
select plan(28);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
-- platform_event per the Part A/B contract: source ∈ {internal,external} (NEVER 'web');
-- ingested_at + subject_type are NOT NULL. Fixtures set all three.
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u1','external', now() - interval '1 day', now()),
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u2','external', now() - interval '2 days', now()),
  ('11111111-1111-1111-1111-111111111111','onboarding.completed','user','u2','external', now() - interval '1 day', now()),
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u3','external', now() - interval '30 days', now());

-- SEG1: dynamic segment; ACTIVE rule = registered.completed within 7d AND NOT onboarding.completed.
-- RECONCILED: segment.name is NOT NULL; segment_rule.workspace_id is NOT NULL (both workspaceScoped).
insert into public.segment (id, workspace_id, name, mode, active) values
  ('51000001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','SEG1','dynamic', true);
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('54000001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','51000001-0000-0000-0000-000000000000',
   jsonb_build_object('all', jsonb_build_array(
     jsonb_build_object('event','registered.completed','within', jsonb_build_object('days',7)),
     jsonb_build_object('not', jsonb_build_object('event','onboarding.completed'))
   )), 1, true);

-- ── Task 1a: evaluate_segment returns exactly {u1} with the matched rule + evidence ──
select is((select count(*)::int from public.evaluate_segment('51000001-0000-0000-0000-000000000000')),
          1, 'evaluate_segment matches exactly the one subject satisfying "registered.completed within 7d AND NOT onboarding.completed"');
select is((select subject_ref from public.evaluate_segment('51000001-0000-0000-0000-000000000000')),
          'u1', 'the matched subject is u1 (recent registration, no onboarding)');
select is((select matched_rule_id from public.evaluate_segment('51000001-0000-0000-0000-000000000000')),
          '54000001-0000-0000-0000-000000000000'::uuid, 'the match carries the pinned matched_rule_id');
select ok((select (evidence->'event_ids') <> '[]'::jsonb
             from public.evaluate_segment('51000001-0000-0000-0000-000000000000') where subject_ref='u1'),
          'the match carries evidence: the platform_event ids the rule referenced');

-- ── Task 1b: INJECTION — a malicious event_type is safely quoted, the table survives ──
insert into public.segment (id, workspace_id, name, mode, active) values
  ('51000009-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','SEGX','dynamic', true);
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('54000009-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','51000009-0000-0000-0000-000000000000',
   jsonb_build_object('event','x''; drop table public.platform_event; --',
                      'within', jsonb_build_object('days',7)), 1, true);
select is((select count(*)::int from public.evaluate_segment('51000009-0000-0000-0000-000000000000')),
          0, 'a predicate whose event_type is a SQL payload compiles to a quoted literal and matches nothing');
select isnt((select to_regclass('public.platform_event')::text), null,
          'public.platform_event survives the injection attempt (the payload was quote_literal-ed, never executed)');

-- ── Task 1c: unknown node type fails closed ──
select throws_ok(
  $$ select movp_internal.compile_predicate('{"wat":1}'::jsonb, '11111111-1111-1111-1111-111111111111'::uuid) $$);

-- ── Task 1d: segment_match_subjects (Part D's preview seam) reuses the SAME safe compiler ──
select is((select count(*)::int from movp_internal.segment_match_subjects(
             '11111111-1111-1111-1111-111111111111'::uuid,
             jsonb_build_object('event','x''; drop table public.platform_event; --',
                                'within', jsonb_build_object('days',7)))),
          0, 'segment_match_subjects compiles a SQL-payload predicate to a quoted literal and matches nothing');
select isnt((select to_regclass('public.platform_event')::text), null,
          'public.platform_event survives the segment_match_subjects injection attempt (Part D reuses the safe path)');

-- ── Task 2: recompute_segment (diff/apply/emit/audit) + replay idempotency + storm guard ──
select public.recompute_segment('51000001-0000-0000-0000-000000000000','full', null);

select is((select count(*)::int from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000'),
          1, 'recompute writes membership for exactly the matched subject (u1)');
select is((select matched_rule_id from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000' and subject_ref='u1'),
          '54000001-0000-0000-0000-000000000000'::uuid, 'the membership row records the matched rule');
select ok((select (evidence->'event_ids') <> '[]'::jsonb from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000' and subject_ref='u1'),
          'the membership row carries evidence');
select is((select count(*)::int from movp_internal.movp_events
             where type='segment.membership_changed'
               and payload->>'id' = '51000001-0000-0000-0000-000000000000:u1:'
                   || movp_internal.segment_rule_version_hash('51000001-0000-0000-0000-000000000000')),
          1, 'membership_changed uses the deterministic seg_id:subject_ref:rule_version_hash id');
select is((select added_count::int from public.segment_recompute_run
             where segment_id='51000001-0000-0000-0000-000000000000' order by started_at limit 1),
          1, 'the first recompute writes a segment_recompute_run audit row with added_count=1');
select is((select workspace_id from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000' and subject_ref='u1'),
          '11111111-1111-1111-1111-111111111111'::uuid,
          'segment_membership.workspace_id = the segment workspace_id (F1 — NOT NULL, threaded from ws)');
select is((select count(*)::int from movp_internal.movp_jobs where kind='notify'),
          0, 'recipient-less segment.membership_changed/segment.recomputed create no notify jobs (proves 000009 guarded emit_event is relied upon)');

-- REPLAY: same inputs -> empty diff -> no membership change, no new membership_changed event.
select public.recompute_segment('51000001-0000-0000-0000-000000000000','full', null);
select is((select count(*)::int from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000'),
          1, 'replay is idempotent: membership unchanged (0 adds/removes)');
select is((select count(*)::int from movp_internal.movp_events
             where type='segment.membership_changed' and payload->>'entity_id'='51000001-0000-0000-0000-000000000000'),
          1, 'replay emits NO new membership_changed (empty diff); the run log still records the attempt');

-- STORM: 501 matching subjects -> per-member events suppressed, membership fully applied, one recomputed.
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at)
  select '11111111-1111-1111-1111-111111111111','bulk.event','user','bulk-'||g,'external', now(), now()
  from generate_series(1,501) g;
insert into public.segment (id, workspace_id, name, mode, active) values
  ('510000b0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','SEGB','dynamic', true);
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('540000b0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','510000b0-0000-0000-0000-000000000000',
   jsonb_build_object('event','bulk.event','within', jsonb_build_object('days',30)), 1, true);
select public.recompute_segment('510000b0-0000-0000-0000-000000000000','full', null);
select is((select count(*)::int from public.segment_membership
             where segment_id='510000b0-0000-0000-0000-000000000000'),
          501, 'storm recompute still applies ALL membership rows (only the event fan-out is suppressed)');
select is((select count(*)::int from movp_internal.movp_events
             where type='segment.membership_changed' and payload->>'entity_id'='510000b0-0000-0000-0000-000000000000'),
          0, 'storm guard suppresses per-member membership_changed above the 500 threshold');
select cmp_ok((select count(*)::int from movp_internal.movp_events
             where type='segment.recomputed' and payload->>'entity_id'='510000b0-0000-0000-0000-000000000000'),
          '>=', 1, 'storm still emits one segment.recomputed carrying the counts + run_id');

-- ── Task 3: incremental enqueue trigger (referenced -> one job; burst coalesces; unreferenced -> none) ──
insert into public.segment (id, workspace_id, name, mode, active) values
  ('510000c0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','SEGR','dynamic', true);
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('540000c0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','510000c0-0000-0000-0000-000000000000',
   jsonb_build_object('event','trigger.event','within', jsonb_build_object('days',7)), 1, true);

insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t1','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'inserting a referenced event type enqueues exactly one segment_recompute job');

insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t2','external', now(), now()),
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t3','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'a same-minute burst coalesces to one job (minute-window idempotency key + on-conflict-do-nothing)');

insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','nobody.listens','user','t4','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'an event type no active dynamic segment references enqueues no additional recompute job');

-- ── Task 4: take_segment_snapshot freezes membership; later changes don't touch it ──
select public.take_segment_snapshot('51000001-0000-0000-0000-000000000000','on_demand');
select is((select count(*)::int from public.segment_snapshot_member sm
             join public.segment_snapshot s on s.id = sm.snapshot_id
             where s.segment_id='51000001-0000-0000-0000-000000000000'),
          1, 'the snapshot freezes current membership into append-only snapshot_member rows');
select is((select member_count::int from public.segment_snapshot
             where segment_id='51000001-0000-0000-0000-000000000000' order by taken_at desc limit 1),
          1, 'the snapshot records member_count');
select ok((select rule_version_set
             @> jsonb_build_array(jsonb_build_object('rule_id','54000001-0000-0000-0000-000000000000','version',1))
             from public.segment_snapshot
             where segment_id='51000001-0000-0000-0000-000000000000' order by taken_at desc limit 1),
          'the snapshot captures the active rule version set');

insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','onboarding.completed','user','u1','external', now(), now());
select public.recompute_segment('51000001-0000-0000-0000-000000000000','full', null);
select is((select count(*)::int from public.segment_snapshot_member sm
             join public.segment_snapshot s on s.id = sm.snapshot_id
             where s.segment_id='51000001-0000-0000-0000-000000000000' and sm.subject_ref='u1'),
          1, 'changing events + recomputing AFTER the snapshot does NOT alter the frozen snapshot members');

select * from finish();
rollback;
