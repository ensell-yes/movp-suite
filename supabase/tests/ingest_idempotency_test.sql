-- C5a.5 idempotent ingest: same key and payload dedupe; mismatched payload conflicts.
begin;
select plan(15);

insert into public.workspace (id, name) values ('c5c00000-0000-0000-0000-000000000001', 'IngW1');
insert into movp_internal.ingest_key (workspace_id, key_hash, label, active)
values ('c5c00000-0000-0000-0000-000000000001',
        encode(extensions.digest('c5c-raw-key', 'sha256'), 'hex'), 'test', true);

select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-1","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb)->>'inserted')::int,
  1, 'first submit inserts one event');
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-1","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb)->>'duplicate')::int,
  1, 'replay counts one duplicate');
select is(
  (select count(*)::int from public.platform_event where workspace_id = 'c5c00000-0000-0000-0000-000000000001'),
  1, 'replay creates no second platform event');
create temp table _ingest_idempotency_conflict as
  select public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"different","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb) as result;
select is(
  ((select result from _ingest_idempotency_conflict)->>'dropped')::int,
  1, 'same key with different payload is dropped');
select is(
  ((select result from _ingest_idempotency_conflict)->>'conflict')::int,
  1, 'same key with different payload is identified as an idempotency conflict');
select is(
  (select count(*)::int from public.platform_event where workspace_id = 'c5c00000-0000-0000-0000-000000000001'),
  1, 'conflict creates no new platform event');
select is(
  (select count(*)::int from movp_internal.movp_events
    where type = 'ingest.idempotency_conflict' and workspace_id = 'c5c00000-0000-0000-0000-000000000001'),
  1, 'conflict emits one keys-only observability event');

select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-1","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k2"}]'::jsonb)->>'inserted')::int,
  1, 'a distinct idempotency key inserts a distinct event');
select is(
  (select count(*)::int from public.platform_event where workspace_id = 'c5c00000-0000-0000-0000-000000000001'),
  2, 'a distinct key does not dedupe against k1');

select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-unkeyed","occurred_at":"2026-07-11T00:00:00Z"}]'::jsonb)->>'inserted')::int,
  1, 'an unkeyed event inserts');
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-unkeyed","occurred_at":"2026-07-11T00:00:00Z"}]'::jsonb)->>'inserted')::int,
  1, 'an unkeyed replay is not deduplicated');
select is(
  (select count(*)::int from public.platform_event where workspace_id = 'c5c00000-0000-0000-0000-000000000001'),
  4, 'unkeyed events are independent of keyed dedupe');

set local timezone = 'UTC';
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-timezone","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"timezone-k"}]'::jsonb)->>'inserted')::int,
  1, 'timezone test first submit inserts');
set local timezone = 'America/Los_Angeles';
create temp table _timezone_replay as
  select public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-timezone","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"timezone-k"}]'::jsonb) as result;
select is(((select result from _timezone_replay)->>'duplicate')::int,
  1, 'identical replay from another timezone is a duplicate');
select is(((select result from _timezone_replay)->>'conflict')::int,
  0, 'identical replay from another timezone is not a conflict');

select * from finish();
rollback;
