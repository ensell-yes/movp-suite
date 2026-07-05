-- Segmentation Phase 6 — Part C: Evaluation & Recompute Engine.
-- Sorts AFTER Part A's 20260701000019_* (collections + platform_event) and Part B's
-- 20260701000020_* (ingestion). Built top-to-bottom: job kind + compiler + evaluate_segment
-- (Task 1) -> recompute_segment (Task 2) -> incremental enqueue trigger (Task 3) -> snapshots +
-- documented cron (Task 4). THE COMPILER IS SQL-INJECTION-CRITICAL: this is the repo's first
-- dynamic SQL, so the safe pattern is explicit and load-bearing (see compile_predicate).

-- (1) Register the job kind. movp_jobs.kind is an FK to this registry; no constraint change.
insert into movp_internal.movp_job_kind (kind) values ('segment_recompute')
  on conflict (kind) do nothing;

-- ── safe_ident: the ONLY path by which any identifier reaches the SQL string ──
-- Whitelist-or-raise, then quote_ident. The compiler feeds it ONLY compile-time-constant
-- platform_event column names — NEVER predicate content.
create or replace function movp_internal.safe_ident(ident text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if ident !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'segment compiler rejected unsafe identifier: %', ident;
  end if;
  return quote_ident(ident);
end; $$;

-- ── predicate_event_types: walk the DSL, collect every event-leaf event string ──
create or replace function movp_internal.predicate_event_types(pred jsonb)
returns text[] language plpgsql immutable set search_path = '' as $$
declare acc text[] := '{}'; child jsonb;
begin
  if pred is null or jsonb_typeof(pred) <> 'object' then return acc; end if;
  if pred ? 'event' then
    acc := acc || array[pred->>'event'];
  elsif pred ? 'all' then
    for child in select * from jsonb_array_elements(pred->'all') loop
      acc := acc || movp_internal.predicate_event_types(child); end loop;
  elsif pred ? 'any' then
    for child in select * from jsonb_array_elements(pred->'any') loop
      acc := acc || movp_internal.predicate_event_types(child); end loop;
  elsif pred ? 'not' then
    acc := acc || movp_internal.predicate_event_types(pred->'not');
  end if;  -- attribute leaves reference no event_type
  return acc;
end; $$;

-- ── compile_predicate: untrusted jsonb -> a WHERE-condition string, injection-safe ──
-- SAFETY CONTRACT (do not weaken): every predicate-derived value binds via format('%L', v)
-- (quote_literal). The ONLY identifiers are the platform_event column names, which are
-- compile-time constants declared HERE and routed through movp_internal.safe_ident() into %s.
-- event_type / property key / property value are DATA (columns/jsonb keys) -> ALWAYS %L, never an identifier.
-- Unknown node -> raise (fail closed). No predicate content is ever concatenated into SQL.
create or replace function movp_internal.compile_predicate(pred jsonb, ws uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  child jsonb;
  parts text[] := '{}';
  evt   text;
  days_int int;
  cnt   int;
  prop_key text;
  prop_val text;
  -- fixed platform_event column identifiers (compile-time constants; safe_ident-guarded).
  col_ws    constant text := movp_internal.safe_ident('workspace_id');
  col_sub   constant text := movp_internal.safe_ident('subject_ref');
  col_type  constant text := movp_internal.safe_ident('event_type');
  col_occ   constant text := movp_internal.safe_ident('occurred_at');
  col_props constant text := movp_internal.safe_ident('properties');
begin
  if pred is null or jsonb_typeof(pred) <> 'object' then
    raise exception 'segment predicate node must be a json object, got: %', jsonb_typeof(pred);
  end if;

  if pred ? 'all' then
    for child in select * from jsonb_array_elements(pred->'all') loop
      parts := parts || movp_internal.compile_predicate(child, ws); end loop;
    if array_length(parts,1) is null then return 'true'; end if;   -- empty AND = true
    return '(' || array_to_string(parts, ' and ') || ')';

  elsif pred ? 'any' then
    for child in select * from jsonb_array_elements(pred->'any') loop
      parts := parts || movp_internal.compile_predicate(child, ws); end loop;
    if array_length(parts,1) is null then return 'false'; end if;  -- empty OR = false
    return '(' || array_to_string(parts, ' or ') || ')';

  elsif pred ? 'not' then
    return '(not ' || movp_internal.compile_predicate(pred->'not', ws) || ')';

  elsif pred ? 'event' then
    evt      := pred->>'event';                                    -- DATA -> %L (quote_literal)
    days_int := coalesce((pred->'within'->>'days')::int, 3650);    -- ::int validates numeric; ~10y default
    cnt      := coalesce((pred->>'count')::int, 1);                -- ::int validates numeric
    if cnt <= 1 then
      return format(
        'exists (select 1 from public.platform_event pe '
        'where pe.%s = %L::uuid and pe.%s = base.subject_ref and pe.%s = %L '
        'and pe.%s >= now() - (%L || '' days'')::interval)',
        col_ws, ws, col_sub, col_type, evt, col_occ, days_int);
    else
      return format(
        '(select count(*) from public.platform_event pe '
        'where pe.%s = %L::uuid and pe.%s = base.subject_ref and pe.%s = %L '
        'and pe.%s >= now() - (%L || '' days'')::interval) >= %L',
        col_ws, ws, col_sub, col_type, evt, col_occ, days_int, cnt);
    end if;

  elsif pred ? 'attribute' then
    prop_key := pred->'attribute'->>'key';                         -- jsonb KEY -> %L value, never an identifier
    prop_val := pred->'attribute'->>'equals';                      -- DATA -> %L
    if prop_key is null then raise exception 'attribute node requires a key'; end if;
    return format(
      'exists (select 1 from public.platform_event pe '
      'where pe.%s = %L::uuid and pe.%s = base.subject_ref and pe.%s ->> %L = %L)',
      col_ws, ws, col_sub, col_props, prop_key, prop_val);

  else
    raise exception 'unknown segment predicate node: %', pred;     -- fail closed
  end if;
end; $$;
revoke all on function movp_internal.compile_predicate(jsonb, uuid) from public, anon, authenticated;

-- ── evaluate_segment: OR the active rules, EXECUTE the assembled query, tag rule + evidence ──
create or replace function public.evaluate_segment(seg_id uuid)
returns table(subject_ref text, matched_rule_id uuid, evidence jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  rule record;
  branches text[] := '{}';
  sql text;
begin
  select s.workspace_id into ws from public.segment s where s.id = seg_id;
  if ws is null then return; end if;                    -- unknown segment -> empty set
  for rule in
    select id, predicate, version from public.segment_rule
     where segment_id = seg_id and active = true order by version
  loop
    branches := branches || format(
      'select base.subject_ref, %L::uuid as matched_rule_id, %L::int as rule_version, '
      '       %L::text[] as ev_types '
      'from (select distinct subject_ref from public.platform_event where workspace_id = %L::uuid) base '
      'where %s',
      rule.id, rule.version, movp_internal.predicate_event_types(rule.predicate), ws,
      movp_internal.compile_predicate(rule.predicate, ws));
  end loop;
  if array_length(branches,1) is null then return; end if;  -- no active rules -> matches nobody

  -- F7: distinct on (subject_ref) ordered by rule_version THEN matched_rule_id — deterministic ties.
  -- F8: evidence = the 50 MOST-RECENT referenced event ids per subject (lateral order by desc limit 50).
  sql := format(
    'with u as ( %s ), '
    'matched as ( '
    '  select distinct on (subject_ref) subject_ref, matched_rule_id, rule_version, ev_types '
    '  from u order by subject_ref, rule_version, matched_rule_id '
    ') '
    'select m.subject_ref, m.matched_rule_id, '
    '  jsonb_build_object(''event_ids'', coalesce(ev.ids, ''[]''::jsonb)) '
    'from matched m '
    'left join lateral ( '
    '  select jsonb_agg(t.id order by t.occurred_at desc) as ids '
    '  from ( select pe.id, pe.occurred_at from public.platform_event pe '
    '         where pe.workspace_id = %L::uuid and pe.subject_ref = m.subject_ref '
    '           and pe.event_type = any(m.ev_types) '
    '         order by pe.occurred_at desc limit 50 ) t '
    ') ev on true',
    array_to_string(branches, ' union all '), ws);
  return query execute sql;
end; $$;
revoke all on function public.evaluate_segment(uuid) from public, anon, authenticated;

-- ── segment_match_subjects: ad-hoc predicate evaluator (Part D's PREVIEW seam) ─
-- Reuses the SAME injection-safe compiler. service_role ONLY (DEFINER over arbitrary ws;
-- Part D wraps it behind a public function that authorizes the caller for ws first).
create or replace function movp_internal.segment_match_subjects(ws uuid, predicate jsonb)
returns setof text language plpgsql security definer set search_path = '' as $$
begin
  -- The compiled fragment correlates to `base.subject_ref` (same as evaluate_segment), so the
  -- outer query MUST expose a `base` subject set — not a bare `from public.platform_event`.
  return query execute format(
    'select base.subject_ref '
    'from (select distinct subject_ref from public.platform_event where workspace_id = %L::uuid) base '
    'where (%s)',
    ws, movp_internal.compile_predicate(predicate, ws));
end; $$;
revoke all on function movp_internal.segment_match_subjects(uuid, jsonb) from public, anon, authenticated;
grant execute on function movp_internal.segment_match_subjects(uuid, jsonb) to service_role;

-- ── segment_rule_version_hash: the deterministic evaluated_batch token ────────
create or replace function movp_internal.segment_rule_version_hash(seg_id uuid)
returns text language sql stable set search_path = '' as $$
  select md5(coalesce(string_agg(sr.id::text || ':' || sr.version::text, ',' order by sr.id), ''))
  from public.segment_rule sr where sr.segment_id = seg_id and sr.active = true;
$$;

-- ── recompute_segment: atomic eval -> diff -> apply -> emit -> audit ──────────
create or replace function public.recompute_segment(seg_id uuid, mode text default 'full', trace text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  run_id uuid := gen_random_uuid();
  batch text;
  started timestamptz := now();
  added int := 0;
  removed int := 0;
  matched_total int := 0;
  outcome text;
  r record;
begin
  select s.workspace_id into ws from public.segment s where s.id = seg_id;
  if ws is null then
    raise exception 'segment % not found', seg_id using errcode = 'no_data_found';
  end if;
  -- F9: serialize concurrent recomputes of the SAME segment (minute-window vs hourly full) so they
  -- cannot race unique(segment_id, subject_ref). pg_advisory_xact_lock auto-releases at commit/rollback.
  perform pg_advisory_xact_lock(hashtext(seg_id::text));
  batch := movp_internal.segment_rule_version_hash(seg_id);

  create temp table if not exists _seg_eval
    (subject_ref text, matched_rule_id uuid, evidence jsonb) on commit drop;
  create temp table if not exists _seg_added (subject_ref text, matched_rule_id uuid) on commit drop;
  create temp table if not exists _seg_removed (subject_ref text) on commit drop;
  truncate pg_temp._seg_eval; truncate pg_temp._seg_added; truncate pg_temp._seg_removed;

  insert into pg_temp._seg_eval (subject_ref, matched_rule_id, evidence)
    select subject_ref, matched_rule_id, evidence from public.evaluate_segment(seg_id);
  select count(*) into matched_total from pg_temp._seg_eval;

  -- ADDS: matched now, not currently a member. Resolve subject_type from the subject's newest event.
  with ins as (
    insert into public.segment_membership
      (segment_id, workspace_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence)
    select seg_id, ws,                                    -- F1: workspace_id is NOT NULL, no default
           coalesce((select pe.subject_type from public.platform_event pe
                      where pe.workspace_id = ws and pe.subject_ref = e.subject_ref
                      order by pe.occurred_at desc limit 1), 'unknown'),
           e.subject_ref, e.matched_rule_id, now(), now(), e.evidence
    from pg_temp._seg_eval e
    where not exists (select 1 from public.segment_membership m
                       where m.segment_id = seg_id and m.subject_ref = e.subject_ref)
    returning subject_ref, matched_rule_id)
  insert into pg_temp._seg_added (subject_ref, matched_rule_id) select subject_ref, matched_rule_id from ins;

  -- REMOVES: present now, no longer matched.
  with del as (
    delete from public.segment_membership m
     where m.segment_id = seg_id
       and not exists (select 1 from pg_temp._seg_eval e where e.subject_ref = m.subject_ref)
    returning m.subject_ref)
  insert into pg_temp._seg_removed (subject_ref) select subject_ref from del;

  select count(*) into added from pg_temp._seg_added;
  select count(*) into removed from pg_temp._seg_removed;

  -- STORM GUARD: above threshold, suppress per-member events (membership is still applied).
  if (added + removed) <= 500 then
    for r in
      select subject_ref, matched_rule_id, 'added'::text as change from pg_temp._seg_added
      union all
      select subject_ref, null::uuid, 'removed'::text from pg_temp._seg_removed
    loop
      -- Deterministic id seg_id:subject_ref:rule_version_hash. Payload carries NO recipient_user_id/email,
      -- so Task 000009's GUARDED emit_event records the event + fires any webhook but enqueues NO notify job.
      perform public.emit_event('segment.membership_changed', ws,
        jsonb_build_object('id', seg_id::text || ':' || r.subject_ref || ':' || batch,
                           'entity_type','segment','entity_id', seg_id,
                           'subject_ref', r.subject_ref, 'matched_rule_id', r.matched_rule_id,
                           'change', r.change),
        trace);
    end loop;
    outcome := case when (added + removed) = 0 then 'noop' else 'applied' end;
  else
    outcome := 'suppressed';   -- storm: per-member events suppressed; recomputed still fires
  end if;

  -- One run summary per invocation (id = run_id -> unique; carries counts even when suppressed/noop).
  perform public.emit_event('segment.recomputed', ws,
    jsonb_build_object('id', run_id::text, 'entity_type','segment','entity_id', seg_id,
                       'mode', mode, 'added', added, 'removed', removed,
                       'evaluated', matched_total, 'outcome', outcome),
    trace);

  insert into public.segment_recompute_run
    (segment_id, workspace_id, mode, started_at, finished_at, added_count, removed_count, evaluated_count,
     idempotency_key, outcome_code)
  values
    (seg_id, ws, mode, started, now(), added, removed, matched_total,   -- F1: workspace_id NOT NULL
     seg_id::text || ':' || batch, outcome);

  return run_id;
end; $$;
revoke all on function public.recompute_segment(uuid, text, text) from public, anon, authenticated;
grant execute on function public.recompute_segment(uuid, text, text) to service_role;

-- ── segments_referencing_event: dynamic active segments whose active rule references evt ─
create or replace function movp_internal.segments_referencing_event(ws uuid, evt text)
returns setof uuid language sql stable set search_path = '' as $$
  select distinct sr.segment_id
  from public.segment_rule sr
  join public.segment s on s.id = sr.segment_id
  where s.workspace_id = ws and s.mode = 'dynamic' and s.active = true and sr.active = true
    and evt = any(movp_internal.predicate_event_types(sr.predicate));
$$;

-- ── AFTER INSERT enqueue: coalesce a burst to one job per referencing segment per minute ─
-- F10 COST: fires on EVERY platform_event insert (incl. batch ingests); per row O(active dynamic rules).
-- F11 CONSISTENCY: once the seg:hash:minute job exists, later same-minute events enqueue nothing and are
-- picked up by the next minute's event or the hourly full-recompute cron (accepted eventual-consistency tail).
create or replace function public.platform_event_enqueue_recompute()
returns trigger language plpgsql security definer set search_path = '' as $$
declare seg_id uuid;
begin
  for seg_id in
    select movp_internal.segments_referencing_event(new.workspace_id, new.event_type)
  loop
    perform public.enqueue_job(
      'segment_recompute',
      seg_id::text || ':' || movp_internal.segment_rule_version_hash(seg_id) || ':'
        || to_char(date_trunc('minute', now()),'YYYYMMDDHH24MI'),
      jsonb_build_object('segment_id', seg_id, 'mode','incremental'),
      new.workspace_id);
  end loop;
  return new;
end; $$;
revoke all on function public.platform_event_enqueue_recompute() from public, anon, authenticated;
drop trigger if exists platform_event_enqueue_recompute_tg on public.platform_event;
create trigger platform_event_enqueue_recompute_tg after insert on public.platform_event
  for each row execute function public.platform_event_enqueue_recompute();

-- ── take_segment_snapshot: immutable freeze of current membership ─────────────
create or replace function public.take_segment_snapshot(seg_id uuid, reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  snap_id uuid := gen_random_uuid();
  rule_versions jsonb;
  cnt int;
begin
  select s.workspace_id into ws from public.segment s where s.id = seg_id;
  if ws is null then
    raise exception 'segment % not found', seg_id using errcode = 'no_data_found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('rule_id', sr.id, 'version', sr.version) order by sr.id),
                  '[]'::jsonb)
    into rule_versions from public.segment_rule sr where sr.segment_id = seg_id and sr.active = true;
  select count(*) into cnt from public.segment_membership where segment_id = seg_id;

  insert into public.segment_snapshot (id, segment_id, workspace_id, taken_at, reason, rule_version_set, member_count)
    values (snap_id, seg_id, ws, now(), reason, rule_versions, cnt);   -- F1: workspace_id NOT NULL
  insert into public.segment_snapshot_member (snapshot_id, workspace_id, subject_ref, matched_rule_id, evidence)
    select snap_id, ws, subject_ref, matched_rule_id, evidence         -- F1: workspace_id NOT NULL
    from public.segment_membership where segment_id = seg_id;   -- append-only; never updated later
  return snap_id;
end; $$;
revoke all on function public.take_segment_snapshot(uuid, text) from public, anon, authenticated;
grant execute on function public.take_segment_snapshot(uuid, text) to service_role;

-- ── DEPLOY-TIME CRON (documentation only — NOT applied by this migration) ────
-- Schedule out-of-band so `supabase db diff` stays empty and no secret is committed. At deploy time
-- (with any service key sourced from Vault, never a literal), enqueue a periodic FULL recompute:
--   select cron.schedule('segments-full-recompute','0 * * * *', $cron$
--     select public.enqueue_job('segment_recompute',
--              id::text || ':full:' || to_char(date_trunc('hour', now()),'YYYYMMDDHH24'),
--              jsonb_build_object('segment_id', id, 'mode','full'), workspace_id)
--     from public.segment where mode='dynamic' and active=true; $cron$);
-- The worker drains those jobs and calls public.recompute_segment(...). pgTAP/e2e call it directly.
