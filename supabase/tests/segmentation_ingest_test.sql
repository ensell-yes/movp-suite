begin;
select plan(13);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','owner');

-- ── registry exists + is closed to anon/authenticated ───────────────────────
select has_table('movp_internal','ingest_key','movp_internal.ingest_key registry exists');
select table_privs_are('movp_internal','ingest_key','anon','{}'::text[],
  'anon has no privileges on movp_internal.ingest_key');
select table_privs_are('movp_internal','ingest_key','authenticated','{}'::text[],
  'authenticated has no privileges on movp_internal.ingest_key');

-- ── mint_ingest_key: raw key returned once (48 hex), stored hashed (64 hex) ──
select is(length(public.mint_ingest_key(
    '11111111-1111-1111-1111-111111111111','minted')), 48,
  'mint_ingest_key returns a 48-char hex raw key (24 random bytes)');
select is((select length(key_hash) from movp_internal.ingest_key
           where workspace_id='11111111-1111-1111-1111-111111111111' and label='minted'),
          64, 'mint stores a 64-char sha256 hash, never the raw key');

-- ── a known W1 key (insert the HASH of a known raw key) ──────────────────────
insert into movp_internal.ingest_key (id, workspace_id, key_hash, label, active) values
  ('000000f1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   encode(extensions.digest('rawkey-w1','sha256'),'hex'),'k1',true);

-- ── ingest: 2 valid, 1 malformed (no subject_ref/occurred_at), 1 oversized ──
-- Event #1 carries workspace_id=W2 in its payload; the key resolves W1, so it
-- MUST land in W1 (payload workspace_id ignored). Event #2 OMITS subject_type to
-- prove the RPC defaults it to 'user' (platform_event.subject_type is NOT NULL) —
-- a missing subject_type must NOT abort the batch. Call ONCE into a temp table
-- so the two count-assertions read the same result (a second call re-inserts).
create temp table _ingest_result as
  select public.ingest_platform_event('rawkey-w1', jsonb_build_array(
    jsonb_build_object('event_type','signup','subject_type','user','subject_ref','u1',
      'occurred_at','2026-07-01T00:00:00Z','properties',jsonb_build_object('plan','pro'),
      'workspace_id','22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('event_type','login','subject_ref','u2',                -- no subject_type -> defaults to 'user'
      'occurred_at','2026-07-01T00:01:00Z'),
    jsonb_build_object('event_type','bad'),                                   -- malformed
    jsonb_build_object('event_type','big','subject_ref','u3',
      'occurred_at','2026-07-01T00:02:00Z',
      'properties',jsonb_build_object('blob', repeat('x', 20000)))            -- oversized (>16KiB)
  )) as r;
select is((select r->>'inserted' from _ingest_result), '2',
  'the two valid events are inserted (inserted=2)');
select is((select r->>'dropped' from _ingest_result), '2',
  'the malformed + oversized events are dropped (dropped=2)');
select is((select count(*)::int from public.platform_event
           where workspace_id='11111111-1111-1111-1111-111111111111' and source='external'),
          2, 'both valid events land in W1 as source=external');
select is((select count(*)::int from public.platform_event
           where workspace_id='22222222-2222-2222-2222-222222222222'),
          0, 'the payload workspace_id (W2) is IGNORED — a W1 key never writes a W2 row');
select is((select subject_type from public.platform_event
           where workspace_id='11111111-1111-1111-1111-111111111111' and subject_ref='u2'),
          'user', 'a missing subject_type defaults to user (NOT NULL satisfied); the batch still commits');

-- ── batch cap + invalid key ─────────────────────────────────────────────────
select throws_ok($$
  select public.ingest_platform_event('rawkey-w1',
    (select jsonb_agg(jsonb_build_object('event_type','x','subject_ref','s',
       'occurred_at','2026-07-01T00:00:00Z')) from generate_series(1,501)))
$$, '54000', null, 'a batch over 500 events is rejected (batch_too_large)');
select throws_ok($$
  select public.ingest_platform_event('not-a-real-key', '[]'::jsonb)
$$, '28000', null, 'an unknown/inactive api key is rejected');

-- ── an UNEXPECTED insert fault must FAIL LOUD, not be silently dropped (the handler is NARROW;
--    only expected data-shape errors drop — anything else propagates and aborts the batch) ──
create function pg_temp.pe_boom() returns trigger language plpgsql as $b$
  begin raise exception 'unexpected platform_event fault' using errcode = 'P0001'; end;
$b$;
create trigger pe_boom_tg before insert on public.platform_event for each row execute function pg_temp.pe_boom();
select throws_ok($$
  select public.ingest_platform_event('rawkey-w1',
    '[{"event_type":"x","subject_type":"user","subject_ref":"s","occurred_at":"2026-07-01T00:00:00Z"}]'::jsonb)
$$, 'P0001', null, 'an UNEXPECTED insert fault propagates (fails loud) — a VALID event is never silently dropped');
drop trigger pe_boom_tg on public.platform_event;

select * from finish();
rollback;
