# MOVP App — Segmentation Phase 6, Part C: Evaluation & Recompute Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the untrusted `segment_rule.predicate` JSON DSL into a **safe, set-based query** over `public.platform_event`, and drive the whole recompute lifecycle from it. Hand-author migration `20260701000021_segmentation_recompute.sql` (sorts after Part A's `...000019` collections and Part B's `...000020` ingestion) to: (1) register the `segment_recompute` job kind and build **the SQL-injection-safe predicate compiler** `movp_internal.compile_predicate(pred jsonb, ws uuid)` + `public.evaluate_segment(seg_id uuid)`; (2) add the atomic `public.recompute_segment(seg_id, mode, trace)` that evaluates → diffs against `segment_membership` → applies → emits deterministic `segment.membership_changed` (storm-guarded) + one `segment.recomputed` + a `segment_recompute_run` audit row; (3) install the `AFTER INSERT` incremental-enqueue trigger on `public.platform_event`; (4) add `public.take_segment_snapshot(seg_id, reason)`. Then add the thin **`segment-recompute` worker** (`supabase/functions/segment-recompute/index.ts` + a `packages/flows` drain helper) that mirrors `flows-worker.ts`'s claim → try → complete loop.

**Architecture — THE UNTRUSTED PREDICATE IS THE WHOLE RISK.** `segment_rule.predicate` is a typed DSL authored by tenant users: boolean nodes (`all`/`any`/`not`), `event` leaves (`{event, within:{days}, count?}`), and `attribute` leaves (`{attribute:{key, equals}}`). It compiles to a correlated set-based query and is then `EXECUTE`d. **THE REPO HAS NO DYNAMIC-SQL PRECEDENT — every committed function is static SQL.** So this migration establishes the safe pattern EXPLICITLY and it is load-bearing: **every untrusted value binds via `format('%L', v)` (quote_literal); the only identifiers are the fixed `platform_event` column names, which are compile-time constants written in the compiler and routed through `movp_internal.safe_ident()` (a whitelist-or-`raise`, then `quote_ident`).** `event_type` / `subject_type` / `source` / property keys+values are **DATA in `platform_event` columns, NOT SQL identifiers — they ALWAYS bind as `%L` values, never `%I`.** Zero predicate content ever becomes an identifier or is string-concatenated into SQL. An unknown node type → `raise exception` (fail closed). The proof is a committed test: a predicate carrying `{"event":"x'; drop table public.platform_event; --"}` compiles to a harmless quoted string literal that matches nothing — the table survives.

Compilation shape per node (the compiler emits these fragments; `base` is the outer subject row):
- `event` (count ≤ 1) → `exists (select 1 from public.platform_event pe where pe.workspace_id = %L::uuid and pe.subject_ref = base.subject_ref and pe.event_type = %L and pe.occurred_at >= now() - (%L || ' days')::interval)`
- `event` (count > 1) → the same body as `(select count(*) …) >= %L`
- `attribute` → `exists (select 1 from public.platform_event pe where pe.workspace_id = %L::uuid and pe.subject_ref = base.subject_ref and pe.properties ->> %L = %L)`
- `all` → `(c1 and c2 …)`; `any` → `(c1 or c2 …)`; `not` → `(not c1)`
- Base subject set = `select distinct subject_ref from public.platform_event where workspace_id = %L::uuid`.
- Evidence = per matched subject, the `platform_event` ids whose `event_type` the matched rule references, **bounded to the 50 most recent** (a `jsonb_agg` companion pass in `evaluate_segment`, `order by pe.occurred_at desc limit 50`, so a high-activity subject's evidence — copied verbatim into snapshots — cannot bloat).

All fan-out goes through the committed `public.emit_event(ev_type, ws, payload, trace)` (writes `movp_internal.movp_events`, fires any registered webhook, and enqueues a `notify` job keyed `ev_type || ':' || payload->>'id'`). **DEPENDENCY — do not misstate it:** the base `emit_event` (migration `...000005`) enqueues the `notify` job **UNCONDITIONALLY**; the recipient guard — *skip* the notify job when the payload carries no `recipient_user_id`/`email` — is added by Task's `20260701000009_*` (guarded `emit_event`), which **IS merged before** this Segmentation migration (`...000021`). `segment.membership_changed` / `segment.recomputed` are **recipient-less signals**: they rely on `000009`'s guarded `emit_event`, so they record to `movp_events` (and fire a webhook if one is registered) but do **NOT** create dead `notify` jobs. Their deterministic ids exist so the notify layer would dedup IF a downstream consumer later attaches a recipient. A Step-0 fail-fast guard (Task 1) verifies `000009`'s guard is present before implementation begins. Jobs run on the committed `movp_internal.movp_jobs` engine (`enqueue_job` / `claim_jobs` / `complete_job`; `movp_jobs.kind` is an FK to the `movp_internal.movp_job_kind` registry).

**Tech Stack:** Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` plpgsql (recursive compiler + `EXECUTE` of assembled SQL + set-based diff), the committed `public.emit_event` / `movp_internal.{movp_events,movp_jobs,movp_job_kind}` async backbone, Part A's segmentation collections + `public.platform_event`, the definer-audit gate (`node scripts/check-definer-audit.mjs`), and the Deno edge-function worker + `packages/flows` jobs helpers (`claimDueJobs` / `completeJob` in `packages/flows/src/jobs.ts`) plus its vitest integration harness. The notify worker (`flows-worker.ts`) is **unchanged**.

**This is Part C of the Segmentation Phase 6 series.** It depends on **Part A** (`...000019` — the collections `segment` / `segment_rule` / `segment_membership` / `segment_snapshot` / `segment_snapshot_member` / `segment_recompute_run` + `public.platform_event` with its `(workspace_id, subject_ref, event_type, occurred_at)` and `(workspace_id, event_type, occurred_at)` indexes) and on **Part B** (`...000020` — event ingestion writing `platform_event`), and on the Core jobs/events backbone (`emit_event`, `enqueue_job`, `claim_jobs`, `complete_job`, `movp_job_kind`). Downstream consumers depend on the **event names verbatim** (`segment.membership_changed`, `segment.recomputed`) and the deterministic id formulas — do not rename either without updating consumers.

## Global Constraints

- **Hand-authored migration only — no codegen.** Parts A/B already generated the tables; this part adds no collection and runs no `pnpm codegen`. It is one hand-authored SQL migration + one pgTAP file, plus the worker + one integration test. Do NOT hand-edit any generated migration.
- **Exact filename, not `supabase migration new`.** The migration MUST be `supabase/migrations/20260701000021_segmentation_recompute.sql` (a wall-clock timestamp would sort wrong; A used `...000019`, B `...000020`). It is built top-to-bottom across Tasks 1–4 in dependency order: job-kind + compiler + `evaluate_segment` → `recompute_segment` → enqueue trigger → snapshots + documented cron.
- **⭐ THE COMPILER IS SQL-INJECTION-CRITICAL — establish the safe pattern and never break it.** Every untrusted value (event strings, day counts, count thresholds, property keys, property values, workspace id) interpolates ONLY via `format('%L', v)`. The only identifiers are the fixed `platform_event` column names — compile-time constants written in `compile_predicate`, routed through `movp_internal.safe_ident()` (`if ident !~ '^[a-z][a-z0-9_]*$' then raise …; return quote_ident(ident)`) and interpolated with `%s`. **No predicate content is ever an identifier, `%I`, or a `||`-concatenated SQL fragment.** Unknown node → `raise exception`. The injection pgTAP test (Task 1) is the gate that proves it.
- **All `SECURITY DEFINER` functions hardened.** Every DEFINER function: `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated`. The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits SQL on `create ... function` and FAILS any `security definer` block missing `set search_path =`. Every DEFINER below sets it — do not drop the clause. (`compile_predicate` is DEFINER per the engine security contract even though it reads no tables; the pure helpers `safe_ident` / `predicate_event_types` / `segments_referencing_event` / `segment_rule_version_hash` are SECURITY INVOKER — they run with the calling DEFINER's authority and still set `search_path = ''` for hygiene.)
- **`pg_temp` is safe with `search_path = ''` for RELATIONS.** `recompute_segment` materializes the evaluated set into `pg_temp` temp tables. Postgres implicitly searches `pg_temp` FIRST for relation names even under `search_path = ''`, and every real table is `public.`-qualified (so no `pg_temp` shadow can hijack `public.platform_event`). Temp tables are created `if not exists … on commit drop` and `truncate`d at the top of the function, so the function is re-callable within a single pgTAP transaction AND across pooled PostgREST connections. Reference them as `pg_temp._seg_eval` etc. explicitly.
- **Idempotency is DIFF-based; the deterministic id is belt-and-suspenders.** `recompute_segment` writes ONLY adds (matched ∧ absent → `insert`) and removes (present ∧ unmatched → `delete`); stable members (matched ∧ present) are left untouched (no re-stamp), so a replay with the same inputs produces an EMPTY diff → 0 membership rows change and 0 `segment.membership_changed` events. `segment.membership_changed` id = `seg_id || ':' || subject_ref || ':' || evaluated_batch` where `evaluated_batch = movp_internal.segment_rule_version_hash(seg_id)` (deterministic over the active rule set), so the notify-key `ev_type || ':' || payload->>'id'` is stable across a replay. `segment.recomputed` id = the `run_id` (unique per invocation) and the `segment_recompute_run` audit row is written on EVERY call — the run log records that a recompute ran even when the diff was empty. (Tradeoff, stated: a subject removed then re-added under the SAME rule-version hash would reuse its membership_changed id — accepted per the contract's replay-dedup priority; membership_changed carries no recipient today so no notification is actually suppressed.)
- **Storm guard.** If `added_count + removed_count > 500`, SUPPRESS the per-member `segment.membership_changed` events and set `outcome_code = 'suppressed'`; ALWAYS emit exactly one `segment.recomputed` carrying the counts + `run_id`, and ALWAYS write the audit row. Membership rows are still fully applied — only the per-member event fan-out is suppressed.
- **Incremental enqueue coalesces a burst.** The `AFTER INSERT` trigger on `public.platform_event` enqueues `segment_recompute` for each DYNAMIC active segment whose active rule references `new.event_type`, with idempotency key `seg_id || ':' || rule_version_hash || ':' || to_char(date_trunc('minute', now()),'YYYYMMDDHH24MI')`. The minute window + `enqueue_job … on conflict (kind, idempotency_key) do nothing` coalesces a same-minute burst to ONE job; a rule-version change mints a new key.
- **Deploy-time cron is NOT committed.** The periodic full-recompute `cron.schedule(...)` (with any Vault key) is applied out-of-band at deploy time so `supabase db diff` stays empty; pgTAP/e2e call `select public.recompute_segment(...)` directly. Mirror Task's `emit_due_soon` cron doc.
- **`movp_internal` is not reachable by `authenticated`.** All writes go through the DEFINER functions; pgTAP reads `movp_internal.movp_events` / `movp_jobs` as the table owner (the default test role), never as `authenticated`.
- **Worker is thin and service-role.** `recompute_segment` / `take_segment_snapshot` are `grant execute … to service_role`; the worker uses the service-role key, reads env via `Deno.env` (NOT `process.env`), and mirrors `flows-worker.ts`'s claim/try/complete loop verbatim in shape.

## File Structure

```
supasuite/
  supabase/
    migrations/
      20260701000021_segmentation_recompute.sql   # NEW hand-authored (built up across Tasks 1–4)
    tests/
      segmentation_recompute_test.sql              # NEW pgTAP (built up across Tasks 1–4)
    functions/
      segment-recompute/
        index.ts                                   # NEW Deno edge worker (Task 5)
  packages/
    flows/
      src/
        segment-recompute.ts                       # NEW drainSegmentRecompute(db, limit) (Task 5)
      test/
        segment-recompute.integration.test.ts      # NEW (clone the flows jobs integration harness)
```

**Per-task apply gate (SQL — Tasks 1–4 end with it):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: migration applies, `segmentation_recompute_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing.

**Per-task gate (Task 5 — TypeScript):**
```bash
pnpm --filter @movp/flows typecheck && pnpm --filter @movp/flows test segment-recompute.integration
```
Expected: typecheck clean; `segment-recompute.integration.test.ts` passes; existing suites unaffected. (If the repo runs flows tests via a different script, use the SAME one the existing jobs integration test runs under — see `packages/flows/package.json` `scripts`.)

---

### Task 1: Job kind + the SQL-injection-safe compiler + `evaluate_segment` + pgTAP (incl. the injection test)

**Files:**
- Create: `supabase/migrations/20260701000021_segmentation_recompute.sql`
- Create: `supabase/tests/segmentation_recompute_test.sql`

**Interfaces:**
- Consumes: Part A's `public.platform_event`, `public.segment`, `public.segment_rule`; `movp_internal.movp_job_kind`; `pg_catalog` (`quote_ident`, `format`, `jsonb_*`).
- Produces: `movp_internal.safe_ident(text) returns text` (whitelist-or-`raise` + `quote_ident`); `movp_internal.predicate_event_types(jsonb) returns text[]` (recursive walk collecting `event` strings); `movp_internal.compile_predicate(pred jsonb, ws uuid) returns text` (DEFINER, recursive, `%L`-only for values, `%s`+`safe_ident` for the fixed column idents, `raise` on unknown node); `public.evaluate_segment(seg_id uuid) returns table(subject_ref text, matched_rule_id uuid, evidence jsonb)` (DEFINER — OR the active rules, `EXECUTE` the assembled query, DISTINCT ON per subject by rule version + rule id, aggregate evidence bounded to 50 most recent); `movp_internal.segment_match_subjects(ws uuid, predicate jsonb) returns setof text` (DEFINER — the **ad-hoc predicate evaluator** wrapping the SAME injection-safe compiler, `service_role` only). **Part D (`04d`) consumes `segment_match_subjects`** for `preview_segment_predicate` / `previewMatchingCount` so Part D never builds a second, unsafe compile path.

- [ ] **Step 0: Fail-fast — confirm Task `000009`'s guarded `emit_event` is merged (mirror Campaigns `03a`)**

`segment.membership_changed` / `segment.recomputed` are recipient-less signals: they depend on Task's
`20260701000009_*` (guarded `emit_event`) SKIPPING the notify job when the payload has no
`recipient_user_id`/`email`. The base `emit_event` (`...000005`) enqueues notify UNCONDITIONALLY, so if
that guard is absent every recompute would mint DEAD notify jobs. Verify the guard exists BEFORE writing
any code:
```bash
grep -lE 'recipient_user_id|email' supabase/migrations/20260701000009_*.sql
```
Expected: prints the `20260701000009_*.sql` path (the guarded `emit_event` references `recipient_user_id`/`email`). If it prints nothing — no such file, or the guard is absent — **STOP**: the recipient-less-signal contract this part relies on is unmet, and the F3(c) pgTAP below (zero notify jobs) would fail.

- [ ] **Step 1: Write the failing pgTAP (red)**

Create `supabase/tests/segmentation_recompute_test.sql` with the shared seed + Task 1 block. `plan(9)` now; later tasks bump it. Fixtures: workspace **W1**; subjects `u1`/`u2`/`u3`; segment **SEG1** with rule **RULE1** = *"registered.completed within 7d AND NOT onboarding.completed"*; injection segment **SEGX**/**RULEX**.
```sql
begin;
select plan(9);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
-- GOTCHA: seed exactly the columns Parts A/B declared NOT NULL. platform_event per the contract is
-- (workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at,
--  ingested_at) with an id default. CROSS-PART CONTRACT: `source` is an ENUM ∈ {internal, external}
--  (NEVER 'web'); `ingested_at` and `subject_type` are NOT NULL. Every fixture below therefore sets
--  source='external', ingested_at=now(), subject_type. If Part B made actor_ref/properties NOT NULL
--  too, add them here.
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u1','external', now() - interval '1 day', now()),
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u2','external', now() - interval '2 days', now()),
  ('11111111-1111-1111-1111-111111111111','onboarding.completed','user','u2','external', now() - interval '1 day', now()),
  ('11111111-1111-1111-1111-111111111111','registered.completed','user','u3','external', now() - interval '30 days', now());

-- SEG1: dynamic segment whose ACTIVE rule = registered.completed within 7d AND NOT onboarding.completed.
-- GOTCHA: if Part A made segment.name / created_by NOT NULL, add them.
insert into public.segment (id, workspace_id, mode, active) values
  ('51000001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','dynamic', true);
insert into public.segment_rule (id, segment_id, predicate, version, active) values
  ('54000001-0000-0000-0000-000000000000','51000001-0000-0000-0000-000000000000',
   jsonb_build_object('all', jsonb_build_array(
     jsonb_build_object('event','registered.completed','within', jsonb_build_object('days',7)),
     jsonb_build_object('not', jsonb_build_object('event','onboarding.completed'))
   )), 1, true);

-- ── Task 1a: evaluate_segment returns exactly {u1} with the matched rule + evidence ──
-- u1: registered.completed 1d ago, no onboarding -> MATCH. u2: has onboarding -> excluded by NOT.
-- u3: registered.completed 30d ago (outside 7d) -> excluded.
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
insert into public.segment (id, workspace_id, mode, active) values
  ('51000009-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','dynamic', true);
insert into public.segment_rule (id, segment_id, predicate, version, active) values
  ('54000009-0000-0000-0000-000000000000','51000009-0000-0000-0000-000000000000',
   jsonb_build_object('event','x''; drop table public.platform_event; --',
                      'within', jsonb_build_object('days',7)), 1, true);
select is((select count(*)::int from public.evaluate_segment('51000009-0000-0000-0000-000000000000')),
          0, 'a predicate whose event_type is a SQL payload compiles to a quoted literal and matches nothing');
select isnt((select to_regclass('public.platform_event')::text), null,
          'public.platform_event survives the injection attempt (the payload was quote_literal-ed, never executed)');

-- ── Task 1c: unknown node type fails closed ──
-- Single-arg throws_ok asserts the statement raises ANY exception (avoids pgTAP's errcode/errmsg
-- overload ambiguity with NULLs); the compiler's `else raise` fires because {"wat":1} matches no node.
select throws_ok(
  $$ select movp_internal.compile_predicate('{"wat":1}'::jsonb, '11111111-1111-1111-1111-111111111111'::uuid) $$);

-- ── Task 1d: segment_match_subjects (Part D's preview seam) reuses the SAME safe compiler ──
-- A SQL-payload predicate compiles to a quoted literal -> 0 matches; the table survives.
select is((select count(*)::int from movp_internal.segment_match_subjects(
             '11111111-1111-1111-1111-111111111111'::uuid,
             jsonb_build_object('event','x''; drop table public.platform_event; --',
                                'within', jsonb_build_object('days',7)))),
          0, 'segment_match_subjects compiles a SQL-payload predicate to a quoted literal and matches nothing');
select isnt((select to_regclass('public.platform_event')::text), null,
          'public.platform_event survives the segment_match_subjects injection attempt (Part D reuses the safe path)');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — with only Parts A+B applied (no `...000021`), `function public.evaluate_segment(uuid) does not exist` and `function movp_internal.compile_predicate(jsonb, uuid) does not exist`, so the file errors on the first `evaluate_segment` call.

- [ ] **Step 3: Create the migration — job kind + compiler + `evaluate_segment` (green)**

Create `supabase/migrations/20260701000021_segmentation_recompute.sql` (exact path — do NOT use `supabase migration new`):
```sql
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
-- platform_event column names — NEVER predicate content. Provided + tested so the repo's first
-- dynamic-SQL surface has a proven-safe identifier primitive.
create or replace function movp_internal.safe_ident(ident text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if ident !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'segment compiler rejected unsafe identifier: %', ident;
  end if;
  return quote_ident(ident);
end; $$;

-- ── predicate_event_types: walk the DSL, collect every event-leaf event string ──
-- Used by evaluate_segment (evidence scoping) and by segments_referencing_event (Task 3).
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
-- DEFINER so it reads ALL subjects authoritatively (RLS-independent). Each active rule (pinned
-- version) becomes one UNION ALL branch over the workspace's distinct subjects; DISTINCT ON gives
-- each subject one matched_rule_id (lowest version wins -> deterministic); evidence = the subject's
-- platform_event ids whose event_type the matched rule references. Bounded by the workspace index.
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

  -- F7: `distinct on (subject_ref)` ordered by rule_version THEN matched_rule_id — equal-version ties
  --     resolve deterministically (lowest matched_rule_id wins) instead of arbitrarily.
  -- F8: evidence = the 50 MOST-RECENT referenced event ids per subject (lateral `order by occurred_at
  --     desc limit 50`), so a high-activity subject cannot bloat the evidence jsonb snapshots copy verbatim.
  -- (Keep the comments OUTSIDE the format() string: implicit string-literal concatenation must not be
  --  interrupted by trailing tokens.)
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
-- Part D's preview_segment_predicate / previewMatchingCount reuse THIS so they never build a second,
-- unsafe compile path. Wraps the SAME injection-safe compiler: the untrusted `predicate` is compiled
-- via movp_internal.compile_predicate (every value %L-bound), and `ws` binds as %L::uuid. Returns the
-- distinct matching subject_refs for an arbitrary (unsaved) predicate.
-- AUTHORIZATION BOUNDARY: DEFINER + an arbitrary `ws` arg reads ANY workspace's events, and
-- movp_internal is not reachable by `authenticated` (Global Constraint). So it is service_role ONLY;
-- Part D's authenticated preview MUST call it through a public wrapper that first authorizes the caller
-- for `ws` (Part D builds that wrapper) — the wrapper derives `ws` from the session, never trusts a
-- client-supplied workspace id.
create or replace function movp_internal.segment_match_subjects(ws uuid, predicate jsonb)
returns setof text language plpgsql security definer set search_path = '' as $$
begin
  return query execute format(
    'select distinct subject_ref from public.platform_event where workspace_id = %L::uuid and (%s)',
    ws, movp_internal.compile_predicate(predicate, ws));
end; $$;
revoke all on function movp_internal.segment_match_subjects(uuid, jsonb) from public, anon, authenticated;
grant execute on function movp_internal.segment_match_subjects(uuid, jsonb) to service_role;
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_recompute_test.sql .. ok` (9 assertions — including the `evaluate_segment` + `segment_match_subjects` injection cases and the fail-closed case); definer-audit exits 0 (`all definers pinned`); `db diff` empty.

- [ ] **Step 5: Gate — safe pattern present, no unsafe interpolation**

Run:
```bash
grep -c "movp_internal.safe_ident" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "raise exception 'unknown segment predicate node" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -cE "event_type[^=]*=[^%]*\\|\\|" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -cE "%I" supabase/migrations/20260701000021_segmentation_recompute.sql
```
Expected: first ≥ `6` (the definition + 5 column constants); second = `1` (fail-closed on unknown node); third = `0` (no predicate value is `||`-concatenated to build `event_type`); fourth = `0` (identifiers go through `safe_ident`+`%s`, never `%I` with predicate data). The injection pgTAP assertion in Step 4 is the real gate.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000021_segmentation_recompute.sql supabase/tests/segmentation_recompute_test.sql
git commit -m "feat(db): SQL-injection-safe segment predicate compiler + evaluate_segment"
```

---

### Task 2: `recompute_segment` (atomic eval → diff → apply → emit → audit) + storm guard + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000021_segmentation_recompute.sql` (append part 2)
- Edit: `supabase/tests/segmentation_recompute_test.sql` (add Task 2 block; bump `plan(9)` → `plan(21)`)

**Interfaces:**
- Consumes: `public.evaluate_segment`, `public.platform_event`, `public.segment`, `public.segment_membership`, `public.segment_recompute_run`, `public.emit_event`.
- Produces: `movp_internal.segment_rule_version_hash(uuid) returns text` (md5 over active rule versions — the `evaluated_batch` token); `public.recompute_segment(seg_id uuid, mode text default 'full', trace text default null) returns uuid` (DEFINER, `grant execute … to service_role`; **F5** — the defaults let Part D's 1-arg `recompute_segment(seg_id)` and the worker's 3-arg call both resolve to this one function). Takes a per-segment `pg_advisory_xact_lock` (**F9**) so concurrent minute-window + hourly recomputes of the same segment serialize instead of racing `unique(segment_id, subject_ref)`. Materializes the evaluated set into `pg_temp`, diffs against `segment_membership` (adds = matched ∧ absent → `insert`; removes = present ∧ unmatched → `delete`; stable → untouched), emits one deterministic `segment.membership_changed` per NET change (SUPPRESSED above 500), one `segment.recomputed` (id=`run_id`) always, and writes one `segment_recompute_run` audit row always. Returns the `run_id`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/segmentation_recompute_test.sql`: change `select plan(9);` to `select plan(21);`, and insert this block immediately BEFORE `select * from finish();`. Adds storm segment **SEGB** (501 bulk subjects) + rule **RULEB**.
```sql
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
select is((select added_count from public.segment_recompute_run
             where segment_id='51000001-0000-0000-0000-000000000000' order by started_at limit 1),
          1, 'the first recompute writes a segment_recompute_run audit row with added_count=1');
-- F1: every workspaceScoped insert threads the segment's workspace_id (NOT NULL, no default).
select is((select workspace_id from public.segment_membership
             where segment_id='51000001-0000-0000-0000-000000000000' and subject_ref='u1'),
          '11111111-1111-1111-1111-111111111111'::uuid,
          'segment_membership.workspace_id = the segment workspace_id (F1 — NOT NULL, threaded from ws)');
-- F3(c): segment.* are recipient-less -> Task 000009's GUARDED emit_event enqueues ZERO notify jobs.
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
insert into public.segment (id, workspace_id, mode, active) values
  ('510000b0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','dynamic', true);
insert into public.segment_rule (id, segment_id, predicate, version, active) values
  ('540000b0-0000-0000-0000-000000000000','510000b0-0000-0000-0000-000000000000',
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
```

Run: `supabase test db`
Expected: FAIL — `function public.recompute_segment(uuid, text, text) does not exist` (and `movp_internal.segment_rule_version_hash` does not exist), so the file errors on the first `recompute_segment` call. (The first 9 Task-1 assertions would otherwise pass.)

- [ ] **Step 2: Append `segment_rule_version_hash` + `recompute_segment` (green)**

Append to `supabase/migrations/20260701000021_segmentation_recompute.sql`:
```sql
-- ── segment_rule_version_hash: the deterministic evaluated_batch token ────────
-- md5 over the active rule ids+versions, order-stable. Used as the membership_changed
-- evaluated_batch (replay dedup) and in the incremental enqueue key (Task 3).
create or replace function movp_internal.segment_rule_version_hash(seg_id uuid)
returns text language sql stable set search_path = '' as $$
  select md5(coalesce(string_agg(sr.id::text || ':' || sr.version::text, ',' order by sr.id), ''))
  from public.segment_rule sr where sr.segment_id = seg_id and sr.active = true;
$$;

-- ── recompute_segment: atomic eval -> diff -> apply -> emit -> audit ──────────
-- One transaction (plpgsql runs in the caller's txn). Materializes evaluate_segment into pg_temp
-- (re-callable: if-not-exists + on-commit-drop + truncate). GOTCHA: pg_temp is implicitly searched
-- FIRST for RELATIONS even under search_path='' , and every real table is public.-qualified, so
-- the temp tables resolve while no pg_temp shadow can hijack public.platform_event.
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
  -- F9: serialize concurrent recomputes of the SAME segment. The minute-window incremental job and the
  -- hourly full recompute can otherwise run at once and race unique(segment_id, subject_ref) on the
  -- membership insert. pg_advisory_xact_lock (pg_catalog, always in path even under search_path='')
  -- auto-releases at commit/rollback; a second caller for the same seg_id waits, then sees an empty diff.
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
      -- Deterministic id seg_id:subject_ref:rule_version_hash -> stable across a replay (belt-and-
      -- suspenders for the notify layer). Payload carries NO recipient_user_id/email, so Task 000009's
      -- GUARDED emit_event records the event + fires any webhook but enqueues NO notify job (a domain/
      -- audit signal, not a user notification). NB: the base 000005 emit_event would enqueue one — the
      -- recipient-less contract depends on 000009 being merged (Step-0 guard + F3(c) pgTAP pin it).
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
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_recompute_test.sql .. ok` (21 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — atomic diff shape, storm threshold, deterministic id**

Run:
```bash
grep -c "create or replace function public.recompute_segment" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "added + removed) <= 500" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "grant execute on function public.recompute_segment" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "pg_temp._seg_eval" supabase/migrations/20260701000021_segmentation_recompute.sql
```
Expected: first = `1`; second = `1` (the 500 storm threshold); third = `1` (service_role can call it); fourth ≥ `3` (temp-table materialization referenced explicitly by `pg_temp`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000021_segmentation_recompute.sql supabase/tests/segmentation_recompute_test.sql
git commit -m "feat(db): recompute_segment (atomic diff/apply/emit) with storm guard + audit"
```

---

### Task 3: Incremental enqueue trigger on `platform_event` (minute-window coalesce) + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000021_segmentation_recompute.sql` (append part 3)
- Edit: `supabase/tests/segmentation_recompute_test.sql` (add Task 3 block; bump `plan(21)` → `plan(24)`)

**Interfaces:**
- Consumes: `public.enqueue_job`, `public.segment`, `public.segment_rule`, `movp_internal.predicate_event_types`, `movp_internal.segment_rule_version_hash`.
- Produces: `movp_internal.segments_referencing_event(ws uuid, evt text) returns setof uuid` (dynamic active segments whose active rule references `evt`); `public.platform_event_enqueue_recompute()` (DEFINER, AFTER INSERT on `public.platform_event`) — enqueues one `segment_recompute` per referencing segment with the minute-window idempotency key. A same-minute burst coalesces to one job; an unreferenced event type enqueues nothing.

- [ ] **Step 1: Extend the pgTAP (red)**

Change `select plan(21);` to `select plan(24);`, and insert this block before `finish()`. Adds trigger segment **SEGR**/**RULER** referencing `trigger.event`.
```sql
-- ── Task 3: incremental enqueue trigger (referenced -> one job; burst coalesces; unreferenced -> none) ──
insert into public.segment (id, workspace_id, mode, active) values
  ('510000c0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','dynamic', true);
insert into public.segment_rule (id, segment_id, predicate, version, active) values
  ('540000c0-0000-0000-0000-000000000000','510000c0-0000-0000-0000-000000000000',
   jsonb_build_object('event','trigger.event','within', jsonb_build_object('days',7)), 1, true);

insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t1','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'inserting a referenced event type enqueues exactly one segment_recompute job');

-- burst: two more same-type events in the same minute coalesce to the SAME job (minute-window key).
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t2','external', now(), now()),
  ('11111111-1111-1111-1111-111111111111','trigger.event','user','t3','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'a same-minute burst coalesces to one job (minute-window idempotency key + on-conflict-do-nothing)');

-- unreferenced type -> no new job for SEGR.
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','nobody.listens','user','t4','external', now(), now());
select is((select count(*)::int from movp_internal.movp_jobs
             where kind='segment_recompute' and payload->>'segment_id'='510000c0-0000-0000-0000-000000000000'),
          1, 'an event type no active dynamic segment references enqueues no additional recompute job');
```

Run: `supabase test db`
Expected: FAIL — no enqueue trigger exists yet, so all three inserts enqueue nothing: assertions return `0`, `0`, `0` (expected `1`,`1`,`1`). (3 failing assertions.)

- [ ] **Step 2: Append the helper + trigger (green)**

Append to `supabase/migrations/20260701000021_segmentation_recompute.sql`:
```sql
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
-- DEFINER so it runs as owner (enqueue_job + registry write are RLS-independent). The minute-window
-- key + enqueue_job's on conflict (kind, idempotency_key) do nothing dedups a burst; a rule-version
-- change mints a new key via segment_rule_version_hash.
-- F10 COST: this fires on EVERY platform_event insert, INCLUDING 500-row batch ingests. Per row it
-- runs segments_referencing_event, which is O(active dynamic segment_rules in the workspace) with a
-- per-rule predicate_event_types JSON recursion. Bound today = # active dynamic rules for the ws. A
-- FUTURE optimization (not built here): maintain a precomputed event_type -> segment_id map on rule
-- change so the trigger does a single indexed lookup instead of scanning + recursing every rule.
-- F11 CONSISTENCY: once the seg:hash:YYYYMMDDHH24MI job exists, later same-minute events for that
-- segment enqueue NOTHING (on conflict do nothing). Their changes are picked up by the NEXT minute's
-- event or by the hourly full-recompute cron (Task 4). This eventual-consistency tail is the accepted
-- tradeoff for burst-coalescing — the minute window trades immediacy for one job per segment per minute.
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
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_recompute_test.sql .. ok` (24 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — trigger present, minute-window key, selective**

Run:
```bash
grep -c "after insert on public.platform_event" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "date_trunc('minute', now())" supabase/migrations/20260701000021_segmentation_recompute.sql
grep -c "segments_referencing_event" supabase/migrations/20260701000021_segmentation_recompute.sql
```
Expected: first = `1` (one AFTER INSERT trigger); second = `1` (minute-window coalesce key); third ≥ `2` (helper defined + used by the trigger).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000021_segmentation_recompute.sql supabase/tests/segmentation_recompute_test.sql
git commit -m "feat(db): incremental segment_recompute enqueue trigger (minute-window coalesce)"
```

---

### Task 4: `take_segment_snapshot` (immutable freeze) + documented deploy-time cron + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000021_segmentation_recompute.sql` (append part 4)
- Edit: `supabase/tests/segmentation_recompute_test.sql` (add Task 4 block; bump `plan(24)` → `plan(28)`)

**Interfaces:**
- Consumes: `public.segment`, `public.segment_rule`, `public.segment_membership`, `public.segment_snapshot`, `public.segment_snapshot_member`.
- Produces: `public.take_segment_snapshot(seg_id uuid, reason text) returns uuid` (DEFINER, `grant execute … to service_role`) — freezes the current `segment_membership` into a new `segment_snapshot` (`member_count`, `rule_version_set` = the active rule versions) + append-only `segment_snapshot_member` rows. Later membership changes never mutate a taken snapshot. Plus the DOCUMENTED-only deploy-time full-recompute cron (NOT committed).

- [ ] **Step 1: Extend the pgTAP (red)**

Change `select plan(24);` to `select plan(28);`, and insert this block before `finish()`. Snapshots SEG1 (membership `{u1}`), then makes u1 stop matching and recomputes, asserting the snapshot is frozen.
```sql
-- ── Task 4: take_segment_snapshot freezes membership; later changes don't touch it ──
-- F6: reason MUST be a valid snapshot reason enum ∈ {on_demand, scheduled, campaign_launch} (NOT 'manual').
select public.take_segment_snapshot('51000001-0000-0000-0000-000000000000','on_demand');
select is((select count(*)::int from public.segment_snapshot_member sm
             join public.segment_snapshot s on s.id = sm.snapshot_id
             where s.segment_id='51000001-0000-0000-0000-000000000000'),
          1, 'the snapshot freezes current membership into append-only snapshot_member rows');
select is((select member_count from public.segment_snapshot
             where segment_id='51000001-0000-0000-0000-000000000000' order by taken_at desc limit 1),
          1, 'the snapshot records member_count');
select ok((select rule_version_set
             @> jsonb_build_array(jsonb_build_object('rule_id','54000001-0000-0000-0000-000000000000','version',1))
             from public.segment_snapshot
             where segment_id='51000001-0000-0000-0000-000000000000' order by taken_at desc limit 1),
          'the snapshot captures the active rule version set');

-- make u1 stop matching (add onboarding.completed), recompute -> u1 removed from live membership...
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('11111111-1111-1111-1111-111111111111','onboarding.completed','user','u1','external', now(), now());
select public.recompute_segment('51000001-0000-0000-0000-000000000000','full', null);
-- ...but the SNAPSHOT is immutable: u1 is still frozen in it.
select is((select count(*)::int from public.segment_snapshot_member sm
             join public.segment_snapshot s on s.id = sm.snapshot_id
             where s.segment_id='51000001-0000-0000-0000-000000000000' and sm.subject_ref='u1'),
          1, 'changing events + recomputing AFTER the snapshot does NOT alter the frozen snapshot members');
```

Run: `supabase test db`
Expected: FAIL — `function public.take_segment_snapshot(uuid, text) does not exist`, so the file errors on the first `take_segment_snapshot` call. (The first 24 assertions would otherwise pass.)

- [ ] **Step 2: Append `take_segment_snapshot` + the cron doc (green)**

Append to `supabase/migrations/20260701000021_segmentation_recompute.sql`:
```sql
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
-- (with any service key sourced from Vault, never a literal), enqueue a periodic FULL recompute for
-- every dynamic segment (the minute-window/hour key coalesces duplicates):
--   select cron.schedule('segments-full-recompute','0 * * * *', $cron$
--     select public.enqueue_job('segment_recompute',
--              id::text || ':full:' || to_char(date_trunc('hour', now()),'YYYYMMDDHH24'),
--              jsonb_build_object('segment_id', id, 'mode','full'), workspace_id)
--     from public.segment where mode='dynamic' and active=true; $cron$);
-- The worker drains those jobs and calls public.recompute_segment(...). Mirrors Task's emit_due_soon
-- cron doc. pgTAP/e2e call select public.recompute_segment(...) directly.
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_recompute_test.sql .. ok` (28 assertions); definer-audit exits 0; `db diff` empty (the cron is a `--` comment, so no `cron.*` object appears).

- [ ] **Step 4: Gate — snapshot committed, cron NOT committed**

Run:
```bash
grep -q "create or replace function public.take_segment_snapshot" supabase/migrations/20260701000021_segmentation_recompute.sql && echo FN_OK
grep -c "^ *select cron.schedule" supabase/migrations/20260701000021_segmentation_recompute.sql
```
Expected: prints `FN_OK`; the second grep prints `0` (the only `cron.schedule` mention is inside a `--` comment, never an executable statement).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000021_segmentation_recompute.sql supabase/tests/segmentation_recompute_test.sql
git commit -m "feat(db): take_segment_snapshot immutable freeze + documented full-recompute cron"
```

---

### Task 5: The `segment-recompute` worker + `packages/flows` drain helper + integration test

**Files:**
- Create: `packages/flows/src/segment-recompute.ts`
- Create: `supabase/functions/segment-recompute/index.ts`
- Create: `packages/flows/test/segment-recompute.integration.test.ts`

**Interfaces:**
- Consumes: `claimDueJobs(db, kind, lim)` / `completeJob(db, id, ok, errCode?)` from `packages/flows/src/jobs.ts` (which wrap `db.rpc('claim_jobs', {job_kind, lim})` / `db.rpc('complete_job', {job_id, ok, err_code})`); `db.rpc('recompute_segment', { seg_id, mode, trace })`.
- Produces: `drainSegmentRecompute(db, limit = 20): Promise<{ processed: number; failed: number }>` — the claim → try → `recompute_segment` → complete loop, mirroring `flows-worker.ts`. **F4:** it checks the resolved `{ error }` from `db.rpc(...)` and throws before `completeJob(true)` (supabase-js does NOT throw on a Postgres `raise`), so a failed RPC completes the job `false` and re-enters Core's retry/DLQ — never a silent `done`. Plus the thin `Deno.serve` edge handler that builds a service-role client (env via `Deno.env`) and calls it.

- [ ] **Step 1: Write the failing integration test (red)**

Create `packages/flows/test/segment-recompute.integration.test.ts` by CLONING the harness helpers (`serviceClient()`, `env`/`admin` preamble, workspace/seed helpers) from the EXISTING flows jobs integration test VERBATIM (find it under `packages/flows/test/` — the one that already exercises `enqueue_job`/`claim_jobs`/`complete_job`). Seeding uses the SERVICE-ROLE client (recompute_segment is granted to `service_role`, and the jobs engine is service-role). Then:
```ts
import { describe, expect, it } from 'vitest'
import { drainSegmentRecompute } from '../src/segment-recompute.ts'
// serviceClient() + env preamble pasted VERBATIM from the existing flows jobs integration test.

describe('segment-recompute worker', () => {
  it('claims a queued segment_recompute job, recomputes membership, and completes it', async () => {
    const db = serviceClient()
    const ws = crypto.randomUUID()
    await db.from('workspace').insert({ id: ws, name: 'Flows WS' })
    // one matching event + a dynamic segment/rule that selects it
    const subject = 'w1'
    await db.from('platform_event').insert({
      workspace_id: ws, event_type: 'purchase.completed', subject_type: 'user',
      subject_ref: subject, source: 'external', occurred_at: new Date().toISOString(),
      ingested_at: new Date().toISOString(), // NOT NULL per the cross-part contract; source ∈ {internal,external}
    })
    const seg = crypto.randomUUID()
    await db.from('segment').insert({ id: seg, workspace_id: ws, mode: 'dynamic', active: true })
    await db.from('segment_rule').insert({
      segment_id: seg, version: 1, active: true,
      predicate: { event: 'purchase.completed', within: { days: 30 } },
    })
    // enqueue a job the same way the trigger would (idempotency key is opaque to the worker)
    await db.rpc('enqueue_job', {
      job_kind: 'segment_recompute', idem_key: `${seg}:test:manual`,
      payload: { segment_id: seg, mode: 'incremental' }, ws,
    })

    const result = await drainSegmentRecompute(db, 20)
    expect(result.failed).toBe(0)
    expect(result.processed).toBeGreaterThanOrEqual(1)

    // membership was computed for the matched subject
    const { count } = await db.from('segment_membership')
      .select('*', { count: 'exact', head: true }).eq('segment_id', seg).eq('subject_ref', subject)
    expect(count).toBe(1)
    // the job reached a terminal done state (lease/DLQ/replay semantics are Core's, tested there)
    const { data: jobs } = await db.from('movp_jobs')
      .select('status').eq('kind', 'segment_recompute')
      .filter('payload->>segment_id', 'eq', seg)
    expect(jobs?.every((j) => j.status === 'done')).toBe(true)
  })

  // F4: supabase-js RESOLVES { data, error } — a Postgres `raise` does NOT throw. If the worker did not
  // check {error}, a failed RPC would complete as `done` and never retry. This pins the {error}->throw path.
  it('fails the job (not silently done) when recompute_segment raises for a missing segment', async () => {
    const db = serviceClient()
    const ws = crypto.randomUUID()
    await db.from('workspace').insert({ id: ws, name: 'Flows WS 2' })
    const missing = crypto.randomUUID() // no segment row -> recompute_segment raises no_data_found
    await db.rpc('enqueue_job', {
      job_kind: 'segment_recompute', idem_key: `${missing}:test:missing`,
      payload: { segment_id: missing, mode: 'incremental' }, ws,
    })

    const result = await drainSegmentRecompute(db, 20)
    expect(result.failed).toBe(1) // worker turned {error} into a throw -> completeJob(false)

    const { data: jobs } = await db.from('movp_jobs')
      .select('status').eq('kind', 'segment_recompute')
      .filter('payload->>segment_id', 'eq', missing)
    // The regression guard: a raised RPC must NEVER complete as 'done'. Core moves it to 'failed'
    // (retryable) or 'dead' (budget exhausted) — assert it never silently reached 'done'.
    expect(jobs?.every((j) => j.status !== 'done')).toBe(true)
  })
})
```
Run: `pnpm --filter @movp/flows test segment-recompute.integration`
Expected: FAIL — `Cannot find module '../src/segment-recompute.ts'` (the helper does not exist yet).

- [ ] **Step 2: Create the drain helper (green)**

Create `packages/flows/src/segment-recompute.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js' // MATCH jobs.ts's client type import
import { claimDueJobs, completeJob } from './jobs.ts'

interface RecomputePayload { segment_id: string; mode: string; trace_id?: string | null }

// Mirror flows-worker.ts's claim -> try -> complete loop. No `any`: payload is narrowed via a cast
// from the jobs.ts Job payload type (jsonb) to RecomputePayload.
export async function drainSegmentRecompute(
  db: SupabaseClient,
  limit = 20,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const job of await claimDueJobs(db, 'segment_recompute', limit)) {
    const p = job.payload as RecomputePayload
    try {
      // F4: supabase-js RESOLVES { data, error } — it does NOT throw on a Postgres `raise`. Check {error}
      // explicitly (mirrors packages/flows/src/jobs.ts's `if (error) throw` idiom) BEFORE completing the
      // job, or a failed RPC (e.g. a missing segment) would complete as `done` and never retry.
      const { error } = await db.rpc('recompute_segment', {
        seg_id: p.segment_id, mode: p.mode, trace: p.trace_id ?? null,
      })
      if (error) throw new Error(error.code ?? 'recompute_failed')
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }
  return { processed, failed }
}
```

- [ ] **Step 3: Create the edge worker (green)**

Create `supabase/functions/segment-recompute/index.ts` — MATCH `flows-worker.ts`'s exact `createClient` import specifier and how it resolves the `packages/flows` import (relative path vs import map). GOTCHA: read env via `Deno.env` (NOT `process.env` — empty in the edge runtime).
```ts
import { createClient } from 'jsr:@supabase/supabase-js@2' // <- replace with flows-worker.ts's exact specifier
import { drainSegmentRecompute } from '../../../packages/flows/src/segment-recompute.ts' // <- match flows-worker.ts's import path/map

Deno.serve(async () => {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return new Response('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', { status: 500 })
  const db = createClient(url, key)
  const result = await drainSegmentRecompute(db, 20)
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 4: Typecheck + run the integration test**

Run:
```bash
pnpm --filter @movp/flows typecheck && pnpm --filter @movp/flows test segment-recompute.integration
```
Expected: typecheck clean (no `any`); `segment-recompute.integration.test.ts` passes BOTH cases — (1) the happy path (job processed, membership computed, job `done`), and (2) the F4 failure path (a job for a missing segment → `result.failed === 1`, the job never reaches `done`); other flows suites unaffected. (Requires the local Supabase stack up with the `...000021` migration applied.)

- [ ] **Step 5: Gate — helper wired, no `any`, no `process.env`, mirrors the loop**

Run:
```bash
grep -q "export async function drainSegmentRecompute" packages/flows/src/segment-recompute.ts && echo HELPER_OK
grep -cE ':\s*any(\b|\[)' packages/flows/src/segment-recompute.ts
grep -c "process.env" supabase/functions/segment-recompute/index.ts
grep -c "recompute_segment" packages/flows/src/segment-recompute.ts
```
Expected: prints `HELPER_OK`; second = `0` (no `any`); third = `0` (env via `Deno.env`, not `process.env`); fourth = `1` (the loop calls `recompute_segment`).

- [ ] **Step 6: Commit**

```bash
git add packages/flows/src/segment-recompute.ts packages/flows/test/segment-recompute.integration.test.ts supabase/functions/segment-recompute/index.ts
git commit -m "feat(flows): segment-recompute worker (claim -> recompute_segment -> complete)"
```

---

## Self-Review

- **Spec coverage (Part C scope):** the SQL-injection-safe predicate compiler `movp_internal.compile_predicate` + `public.evaluate_segment` + `movp_internal.segment_match_subjects` (Part D's preview seam, reusing the same compiler) (Task 1, incl. the injection + fail-closed tests for both `evaluate_segment` and `segment_match_subjects`); the atomic `public.recompute_segment` with diff/apply/emit/audit + storm guard (Task 2); the `AFTER INSERT` incremental-enqueue trigger on `public.platform_event` with minute-window coalesce (Task 3); `public.take_segment_snapshot` immutable freeze + documented (uncommitted) full-recompute cron (Task 4); the thin `segment-recompute` worker + `packages/flows` drain helper + integration test (Task 5). Tasks 1–4 are TDD (red → green) ending with `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` + a targeted grep; Task 5 ends with typecheck + vitest + a grep gate.
- **⭐ COMPILER SAFETY RULE (the load-bearing invariant):** every predicate-derived value (event strings, `within.days`, `count`, property key, property value, workspace id) interpolates ONLY via `format('%L', v)` (quote_literal); the ONLY identifiers are the fixed `platform_event` column names, declared as compile-time constants in `compile_predicate` and routed through `movp_internal.safe_ident()` (`^[a-z][a-z0-9_]*$`-or-`raise`, then `quote_ident`) into `%s`. `event_type`/`subject_type`/`source`/property keys+values are DATA → always `%L`, never `%I`. No predicate content is ever an identifier or `||`-concatenated into SQL; an unknown node `raise`s (fail closed). Proof: the committed injection test seeds `{"event":"x'; drop table public.platform_event; --"}`, evaluates it (0 matches), and asserts `to_regclass('public.platform_event')` is non-null. `numeric` fields (`days`, `count`) are `::int`-cast in plpgsql before binding, which validates them and prevents a malformed interval.
- **`evaluate_segment` SIGNATURE + shape:** `public.evaluate_segment(seg_id uuid) returns table(subject_ref text, matched_rule_id uuid, evidence jsonb)` — DEFINER, `search_path=''`. Loads the segment's ACTIVE rules (each with its pinned `version`), compiles each to one `UNION ALL` branch over `select distinct subject_ref from public.platform_event where workspace_id = %L::uuid` (the workspace index carries the filter), `DISTINCT ON (subject_ref)` ordered by rule version **then `matched_rule_id`** (F7 — the id tiebreak makes equal-version ties deterministic), and aggregates `evidence.event_ids` = the subject's `platform_event` ids whose `event_type` the matched rule references, **bounded to the 50 most recent** via a lateral `order by occurred_at desc limit 50` (F8 — snapshot-bloat guard). Empty when the segment is unknown or has no active rules. The same injection-safe compiler is also wrapped by `movp_internal.segment_match_subjects(ws, predicate)` — the ad-hoc evaluator Part D's preview reuses.
- **`recompute_segment` SIGNATURE + atomicity:** `public.recompute_segment(seg_id uuid, mode text default 'full', trace text default null) returns uuid` — DEFINER, `search_path=''`, `grant execute … to service_role`. **F5:** the defaults let Part D's 1-arg `recompute_segment(seg_id)` AND the worker's 3-arg call resolve to this one function. **F9:** a `pg_advisory_xact_lock(hashtext(seg_id::text))` at the top serializes concurrent same-segment recomputes (minute-window incremental vs hourly full) so they cannot race `unique(segment_id, subject_ref)`; the lock auto-releases at commit/rollback. One transaction: materialize `evaluate_segment` into `pg_temp` (re-callable via `if not exists`+`on commit drop`+`truncate`; safe under `search_path=''` because `pg_temp` is implicitly searched first for relations and every real table is `public.`-qualified), diff (adds = matched ∧ absent → `insert` with `workspace_id`(F1)+`matched_rule_id`+`evidence`+`first_matched_at`/`evaluated_at`; removes = present ∧ unmatched → `delete`; stable → untouched), emit per NET change, emit one `segment.recomputed`, write one `segment_recompute_run` audit row (also `workspace_id`-threaded, F1). Returns `run_id`.
- **DETERMINISTIC EVENT-ID FORMULA:** `segment.membership_changed` id = `seg_id || ':' || subject_ref || ':' || evaluated_batch`, where `evaluated_batch = movp_internal.segment_rule_version_hash(seg_id)` (md5 over the active rule ids+versions). So the notify key `ev_type || ':' || payload->>'id'` is stable across a replay. `segment.recomputed` id = the `run_id` (unique per invocation). Idempotency is PRIMARILY the empty diff (replay → 0 adds/removes → 0 `membership_changed`); the run log (`segment.recomputed` + `segment_recompute_run`) is written on every call by design (records the attempt). Stated tradeoff: a remove-then-re-add under the same rule-version hash reuses the id — accepted per the contract's replay-dedup priority; `membership_changed` carries no recipient today, so no notification is actually suppressed.
- **STORM-GUARD THRESHOLD:** `added_count + removed_count > 500` ⇒ suppress the per-member `segment.membership_changed` fan-out and set `outcome_code = 'suppressed'`; membership rows are still fully applied; exactly one `segment.recomputed` (carrying `added`/`removed`/`evaluated`/`run_id`) and one audit row are always written. pgTAP pins it with 501 matching subjects: membership = 501, `membership_changed` = 0, `recomputed` ≥ 1.
- **ENQUEUE IDEMPOTENCY KEY:** `seg_id || ':' || movp_internal.segment_rule_version_hash(seg_id) || ':' || to_char(date_trunc('minute', now()),'YYYYMMDDHH24MI')` on `public.enqueue_job('segment_recompute', …)` with `on conflict (kind, idempotency_key) do nothing`. The minute window coalesces a same-minute burst to ONE job; a rule-version change mints a new key. The trigger is selective via `movp_internal.segments_referencing_event(ws, evt)` (dynamic active segments whose active rule references `new.event_type`), so unreferenced event types enqueue nothing.
- **Correctness / self-consistency:** every SQL sample is schema-qualified and copy-paste-ready against the pasted `emit_event`, `enqueue_job`/`claim_jobs`/`complete_job`, and the `movp_job_kind` FK (registered in Task 1). **emit_event dependency (F3):** the base `emit_event` (`…000005`) enqueues the notify job UNCONDITIONALLY (key `ev_type||':'||payload->>'id'`); the *skip-when-no-recipient* guard is Task `20260701000009`'s guarded `emit_event`, which IS merged before `…000021` — a Step-0 grep fails fast if it is absent, and an F3(c) pgTAP pins ZERO notify jobs for the recipient-less `segment.*` events. Collection/FK names match Part A verbatim, and **every workspaceScoped write threads `workspace_id`** (F1, NOT NULL, no default): `segment(workspace_id, mode, active)`, `segment_rule(segment_id, predicate, version, active)`, `segment_membership(segment_id, workspace_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence)` UNIQUE(segment_id, subject_ref), `segment_snapshot(segment_id, workspace_id, taken_at, reason, rule_version_set, member_count)`, `segment_snapshot_member(snapshot_id, workspace_id, subject_ref, matched_rule_id, evidence)`, `segment_recompute_run(segment_id, workspace_id, mode, started_at, finished_at, added_count, removed_count, evaluated_count, idempotency_key, outcome_code)`, `platform_event(workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at)` — **every `platform_event` fixture sets `source ∈ {internal, external}` (F2, never 'web') + `ingested_at` + `subject_type`**. `plan(N)` bumps 9 → 21 → 24 → 28 across the SQL tasks; Task 5's assertions are vitest and do not count. Migration is `20260701000021_*` (after A=`…000019`, B=`…000020`). All fixture UUIDs are valid hex; the two genuinely Part-A/B-schema-dependent details (extra NOT NULL columns on `platform_event`/`segment`) are flagged inline as GOTCHAs.
- **Safety / observability:** every new DEFINER (`compile_predicate`, `evaluate_segment`, `segment_match_subjects`, `recompute_segment`, `platform_event_enqueue_recompute`, `take_segment_snapshot`) sets `search_path = ''`, is fully schema-qualified, and revokes `execute` from `public`/`anon`/`authenticated` — all pass `check-definer-audit.mjs`; only `recompute_segment` + `take_segment_snapshot` + `segment_match_subjects` are granted to `service_role`. `segment_match_subjects` is service_role ONLY (it is DEFINER over an arbitrary `ws`, and `movp_internal` is not reachable by `authenticated`); Part D's authenticated preview wraps it behind a public function that authorizes the caller for `ws` first — so Part D reuses the proven-safe compiler instead of building a second unsafe path, and its injection is independently pinned by a Task-1 pgTAP (payload → 0 rows, table survives). The compiler's injection defense is the headline control (untrusted predicate → `EXECUTE`), proven by test. Failures fail HARD: unknown predicate node → `raise`; unsafe identifier → `raise`; missing segment → `raise … using errcode`. `segment.recomputed` + the audit row make every recompute (including no-op and suppressed) observable; payloads carry ids + counts + bounded `change`/`outcome` classifiers only — no free-text/PII, no raw property values. `movp_internal` is read in pgTAP as the owner only.
- **Reliability / drift:** each SQL task ends with `supabase db reset` + `db diff` empty; `drop trigger if exists` + `create or replace` keep the migration re-runnable in a fresh reset; the temp tables are `on commit drop` + `if not exists` + `truncate`d, so `recompute_segment` is re-callable within one pgTAP transaction and across pooled PostgREST connections. `recompute_segment` is safe to re-run (empty-diff idempotence). The worker checks the resolved `{ error }` from `db.rpc('recompute_segment', …)` and throws on it (F4 — supabase-js does NOT throw on a Postgres `raise`), then completes the job `false, errcode`, reusing Core's lease/DLQ/backoff (`complete_job`); an F4 integration test pins that a missing-segment job yields `failed === 1` and never reaches `done`. Core's lease/DLQ semantics are tested in Core, not re-tested here. The deploy-time cron is NOT committed so `db diff` stays clean and no secret is committed (mirrors Task's `emit_due_soon`).
- **Efficiency / performance:** `evaluate_segment` is set-based (`UNION ALL` of `exists`/`count` correlated subqueries over the workspace index) and `recompute_segment` materializes it ONCE into `pg_temp`, then does two set-based diff statements — no per-subject round-trips. The enqueue trigger does one `segments_referencing_event` scan per insert and enqueues only for referencing dynamic segments (the common non-referenced case does no `enqueue_job`). **F10 (documented cost):** that scan is O(active dynamic rules) with per-rule `predicate_event_types` JSON recursion, and it runs on EVERY `platform_event` insert including 500-row batches — a precomputed `event_type → segment_id` map is noted as a future optimization (Deferred). **F11 (documented consistency):** once the `seg:hash:minute` job exists, later same-minute events for that segment enqueue nothing (`on conflict do nothing`) and are picked up by the next event or the hourly full recompute — the accepted eventual-consistency tail. The minute-window key + storm guard bound both queue depth and event fan-out under a burst.
- **Simplicity / usability:** no speculative machinery beyond the contract — `mode` is recorded for observability but both `full`/`incremental` run the same full evaluation (a true incremental delta is Deferred, not built). `safe_ident` is the one identifier primitive and it is USED (the compiler's 5 column constants) + tested (the `^[a-z]…` whitelist raises), so it is a real security control, not YAGNI. No domain/TS service, no UI, no RLS change (reads/writes go through DEFINER functions; Part C is the engine only).
- **Deferred (intentional):** a true incremental delta algorithm (v1 re-evaluates fully; the `mode` field is forward-compat metadata); a precomputed `event_type → segment_id` map to replace the enqueue trigger's per-insert rule scan (F10 — a perf optimization, not needed for correctness at current rule counts); recipient-bearing `membership_changed` notifications (today it is an audit/signal event with a deterministic id ready for a future consumer); the pg_cron full-recompute schedule (documented, applied out-of-band); any segment→campaign wiring that consumes `movp_events` (later phase). None are needed for this DB + worker deliverable.
- **Placeholder scan:** none — every SQL and TS block is complete and copy-paste-ready; each step has an exact command + expected output. The only executor-verification notes are the two Part-A/B-schema-dependent details (extra NOT NULL columns) and the two "match `flows-worker.ts`" idioms (the `createClient` import specifier + the `packages/flows` import path/map), each flagged inline at its trigger site.
