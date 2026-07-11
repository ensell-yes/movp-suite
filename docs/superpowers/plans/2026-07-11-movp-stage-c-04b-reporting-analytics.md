# MOVP Stage C4b — Analytics RPCs + Dashboard Query Layer

> **Execution status:** completed. Post-review hardening added Yoga-safe structured errors,
> one request-bound `Domain`, actor/workspace-attributed failure events, and production-path
> masking tests. Committed source and tests are authoritative over intermediate samples.

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-11). Precondition: **C4a merged/landed** (the
> `reporting` schema + 26 generated views exist; `supabase db reset` applies
> `20260711000001_movp_generated_reporting.sql`). This plan is the second of three
> (`c4a`…`c4c`), expanding breakdown tasks C4.4 + C4.5.

**Goal:** every dashboard family has ONE bounded, workspace-gated SQL read: six
**security-invoker** RPCs aggregating over the reporting layer (five over
`reporting.v_*`; segment growth reads its base tables because `taken_at`/`segment.name`
are not reporting-tagged — RLS binds either way), two **security definer** RPCs exposing
redacted daily counts over `movp_internal` (`movp_events`, `movp_jobs`), a
`makeReportingService(ctx)` domain wrapper, and typed GraphQL custom reads — so the C4c
frontend needs exactly one GraphQL document.

**Architecture — why RPCs, not PostgREST reads:** `supabase/config.toml:35` exposes only
`schemas = ["public", "graphql_public"]` to PostgREST, so `ctx.db.from(...)` can never
reach the `reporting` schema — and day-bucketed aggregation isn't expressible through
PostgREST anyway. Public RPCs are the established shape (`workspace_job_counts`,
`20260708000004_admin_jobs.sql`). Invoker RPCs read the reporting views (their first app
consumer); definer RPCs are the only path into `movp_internal` and return **bounded
classifiers + counts only** (event `type` is a catalog key; job `kind`/`status` are
registry/enum values — never payload values, never trace ids).

**Tech stack:** Postgres 17 + pgTAP, plpgsql, `@movp/domain` (vitest integration tests
against the live local stack), `@movp/graphql` (Pothos code-first + vitest).

---

## Baselines (state so Codex knows the expected deltas)

| Gate | Baseline after C4a | After C4b |
|---|---|---|
| pgTAP (`supabase test db`) | **634 tests / 31 files** | **657 / 32** (+23 in `reporting_analytics_test.sql`) |
| definer-audit (`node scripts/check-definer-audit.mjs`) | **179 function blocks** | **187** (+8 RPCs; 2 are SECURITY DEFINER) |
| graphql-shape (`pnpm test:graphql-shape`) | passes | passes with 8 new SDL assertions |
| typecheck (`turbo run typecheck`) | 12/12 packages | 12/12 (no new package) |
| migrations | `…000001_movp_generated_reporting.sql` | +1 hand migration `20260711000002_reporting_analytics.sql` |

## Global Constraints (every task inherits these)

- **TDD, failing test first**; one commit per task; a task is done only when its gate passes.
- **Migration timestamp pre-flight (before the first apply).** Fetch `main`; if
  `supabase/migrations/` on `main` contains any filename sorting after
  `20260711000003_reporting_bi.sql`, re-timestamp C4's three migration filenames so
  they remain consecutive and sort last, and update every matching reference —
  including the reporting entry in `GENERATED_DELTAS` — before running codegen or
  applying a migration. Once any C4 migration merges, it is forward-only and must not
  be renamed; a later change gets a new migration.
- **Forward-only migrations.** C4b's only migration is
  `20260711000002_reporting_analytics.sql` (sorts after the C4a delta). Never touch a
  merged migration or the frozen baseline.
- **Every SECURITY DEFINER function:** `security definer set search_path = ''`,
  schema-qualify every object (`public.`, `movp_internal.`, `reporting.`), then
  `revoke all on function … from public, anon, authenticated;` +
  `grant execute … to authenticated;` (the `workspace_job_counts` pattern,
  `20260708000004_admin_jobs.sql:92-98`). The definer-audit gate fails any definer block
  lacking `set search_path =`.
- **Membership gate idiom:** every reporting RPC (invoker AND definer) begins with
  `if (select auth.uid()) is null or not public.is_workspace_member(ws) then raise
  exception 'not_workspace_member' using errcode = '42501'; end if;` — uniform `42501`
  lets pgTAP `throws_ok` and gives the client one bounded failure code. (For invoker
  RPCs this is belt-and-braces on top of RLS, which would otherwise return empty.)
- **Redaction:** definer RPC outputs carry ONLY `day` + bounded classifiers
  (`type`/`kind`/`status`) + `count`. No `payload`, no `trace_id`, no emails. pgTAP
  pins this by value (`::text not like '%<seeded marker>%'`).
- **Bounds:** every date-ranged RPC clamps `days` to `[1, 90]` server-side
  (`least(greatest(coalesce(days, <default>), 1), 90)`); callers cannot widen it.
- **Domain rule (workerd/Deno analog):** every read goes through `ctx.db` — the caller's
  RLS-bound client resolved at call time — never a captured or service-role client.
- **`@movp/*` imports:** bare specifiers across packages, explicit `.ts` on relative imports.

## File Structure

```text
supabase/migrations/
  20260711000002_reporting_analytics.sql   # C4b.1+C4b.2 view + 8 RPCs (ONE migration, two tasks)
supabase/tests/
  reporting_analytics_test.sql             # C4b.1+C4b.2 pgTAP (plan 23)
packages/domain/src/
  reporting.ts                             # C4b.3 makeReportingService
  types.ts                                 # C4b.3 MODIFY: ReportingService + result types + Domain.reporting
  domain.ts                                # C4b.3 MODIFY: reporting: makeReportingService(ctx)
  index.ts                                 # C4b.3 MODIFY: export
packages/domain/test/
  reporting.integration.test.ts            # C4b.3 live-stack integration
packages/graphql/src/types.ts              # C4b.4 MODIFY: request-bound reporting failure callback
packages/graphql/src/index.ts              # C4b.4 MODIFY: export ReportingFailureEvent type
packages/graphql/src/schema.ts             # C4b.4 MODIFY: Reporting* types + 8 observed queryFields
packages/graphql/test/schema.test.ts       # C4b.4 MODIFY: 8 SDL-presence assertions (graphql-shape gate)
packages/graphql/test/reporting.test.ts    # C4b.4 resolver tests (mocked domain)
supabase/functions/graphql/index.ts        # C4b.4 MODIFY: keys-only @movp/obs emission
```

## Interfaces (produced — C4c relies on these VERBATIM)

```sql
-- All return jsonb. All raise 42501 'not_workspace_member' for non-members/anon-uid.
public.reporting_task_throughput(ws uuid, days int default 30)
  -- {"avg_cycle_hours": 24.0|null, "open_count": 1, "series": [{"day":"YYYY-MM-DD","count":n}]}
public.reporting_content_funnel(ws uuid)
  -- [{"status":"draft","count":n}, ...] ordered by count desc
public.reporting_campaign_metrics(ws uuid, days int default 30)
  -- [{"metric_key":"clicks","total":n}, ...] ordered by total desc
public.reporting_segment_growth(ws uuid, days int default 90)
  -- [{"segment_id":uuid,"name":"...","points":[{"taken_at":"YYYY-MM-DD","member_count":n}]}]
public.reporting_workflow_health(ws uuid, days int default 30)
  -- [{"day":"YYYY-MM-DD","outcome":"succeeded","count":n}, ...]
public.reporting_ingest_volume(ws uuid, days int default 30)
  -- [{"day":"YYYY-MM-DD","source":"internal","count":n}, ...]
public.reporting_event_daily_counts(ws uuid, days int default 30)   -- SECURITY DEFINER
  -- [{"day":"YYYY-MM-DD","type":"task.completed","count":n}, ...]
public.reporting_job_daily_counts(ws uuid, days int default 30)     -- SECURITY DEFINER
  -- [{"day":"YYYY-MM-DD","kind":"embed","status":"done","count":n}, ...]
```

```ts
// packages/domain — Domain gains `reporting: ReportingService` (full types in C4b.3)
// packages/graphql — 8 query fields (camelCase args workspaceId: ID!, days: Int):
//   reportingTaskThroughput, reportingContentFunnel, reportingCampaignMetrics,
//   reportingSegmentGrowth, reportingWorkflowHealth, reportingIngestVolume,
//   reportingEventDailyCounts, reportingJobDailyCounts
```

---

## Task C4b.1: Invoker dashboard RPCs + the hand-authored task-cycle view

**Files**
- Create: `supabase/tests/reporting_analytics_test.sql` (the full file below — it also
  contains C4b.2's definer assertions; C4b.1 runs it and expects the definer half to
  fail, C4b.2 turns it fully green)
- Create: `supabase/migrations/20260711000002_reporting_analytics.sql` (invoker half)

**TDD steps**

- [ ] **Step 1 — write the full pgTAP file** `supabase/tests/reporting_analytics_test.sql`:

```sql
-- C4b reporting analytics RPCs: member positive, non-member 42501, anon denial,
-- date-window bounds, and definer redaction (keys/classifiers, never payload values).
begin;
select plan(23);

-- ── seed (as table owner; RLS bypassed) ──────────────────────────────────────
insert into public.workspace (id, name) values
  ('c4b00000-0000-0000-0000-000000000001', 'RepAnW1'),
  ('c4b00000-0000-0000-0000-000000000002', 'RepAnW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c4b00000-0000-0000-0000-000000000002', 'c4b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

-- tasks: two completed (24h cycles), one open. Default status/priority options are
-- seeded by the workspace-insert trigger (app-01a); pick any option row.
insert into public.task (workspace_id, title, status_id, priority_id, created_at, completed_at) values
  ('c4b00000-0000-0000-0000-000000000001', 'Done 1',
   (select id from public.task_status_option   where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '2 days', now() - interval '1 day'),
  ('c4b00000-0000-0000-0000-000000000001', 'Done 2',
   (select id from public.task_status_option   where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '3 days', now() - interval '2 days'),
  ('c4b00000-0000-0000-0000-000000000001', 'Open 1',
   (select id from public.task_status_option   where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   (select id from public.task_priority_option where workspace_id = 'c4b00000-0000-0000-0000-000000000001' limit 1),
   now() - interval '1 day', null);

-- content funnel: one draft, one published
insert into public.content_type (id, workspace_id, label, key, field_schema) values
  ('c4b00000-0000-0000-0000-0000000000c1', 'c4b00000-0000-0000-0000-000000000001', 'Article', 'article',
   '[{"name":"title","type":"text"}]'::jsonb);
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('c4b00000-0000-0000-0000-0000000000d1', 'c4b00000-0000-0000-0000-000000000001',
   'c4b00000-0000-0000-0000-0000000000c1', 'p-1', 'draft'),
  ('c4b00000-0000-0000-0000-0000000000d2', 'c4b00000-0000-0000-0000-000000000001',
   'c4b00000-0000-0000-0000-0000000000c1', 'p-2', 'published');

-- campaign metrics: 100 clicks inside the 30d window, 40 outside it
insert into public.campaign (id, workspace_id, name, status) values
  ('c4b00000-0000-0000-0000-0000000000a1', 'c4b00000-0000-0000-0000-000000000001', 'A', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 30, current_date),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 70, current_date - 1),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000a1', 'clicks', 40, current_date - 60);

-- segment growth: two snapshots on different days
insert into public.segment (id, workspace_id, name, active, mode) values
  ('c4b00000-0000-0000-0000-0000000000e1', 'c4b00000-0000-0000-0000-000000000001', 'Seg', true, 'dynamic');
insert into public.segment_snapshot (workspace_id, segment_id, taken_at, reason, member_count) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000e1', now() - interval '2 days', 'scheduled', 3),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-0000000000e1', now(), 'on_demand', 5);

-- workflow health: one succeeded, one failed (same day, two outcome groups)
insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config) values
  ('c4b00000-0000-0000-0000-000000000011', 'c4b00000-0000-0000-0000-000000000001',
   (select id from public.event_type where key = 'task.completed'), '{}'::jsonb, 'notify', '{}'::jsonb);
insert into public.workflow_run (workspace_id, source_event_id, event_type, automation_rule_id, matched, action_type, outcome) values
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-000000000098', 'task.completed',
   'c4b00000-0000-0000-0000-000000000011', true, 'notify', 'succeeded'),
  ('c4b00000-0000-0000-0000-000000000001', 'c4b00000-0000-0000-0000-000000000099', 'task.completed',
   'c4b00000-0000-0000-0000-000000000011', true, 'notify', 'failed');

-- ingest volume: two recent (internal + external), one outside the window
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-1', 'internal', now(), now()),
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-2', 'external', now() - interval '1 day', now()),
  ('c4b00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-3', 'internal', now() - interval '60 days', now());

-- internal events (3 in W1 with a payload marker that must NEVER leak, 1 in W2)
insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('c4b00000-0000-0000-0000-000000000021', 'task.completed', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-1', now()),
  ('c4b00000-0000-0000-0000-000000000022', 'task.completed', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-2', now()),
  ('c4b00000-0000-0000-0000-000000000023', 'note.created', 'c4b00000-0000-0000-0000-000000000001',
   '{"secret":"leak-me-not"}'::jsonb, 'c4b-trace-3', now() - interval '1 day'),
  ('c4b00000-0000-0000-0000-000000000024', 'task.completed', 'c4b00000-0000-0000-0000-000000000002',
   '{"secret":"other-ws"}'::jsonb, 'c4b-trace-4', now());

-- internal jobs (2 done embed jobs in W1 with a payload marker)
insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id, status) values
  ('embed', 'c4b-rep-1', '{"secret_url":"http://evil.example/1"}'::jsonb, 'c4b00000-0000-0000-0000-000000000001', 'done'),
  ('embed', 'c4b-rep-2', '{"secret_url":"http://evil.example/2"}'::jsonb, 'c4b00000-0000-0000-0000-000000000001', 'done');

-- ── member A (W1): every RPC returns the seeded aggregates ────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c4b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is((public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->>'open_count')::int,
  1, 'task throughput: open_count = 1');
select is(
  (select sum((e->>'count')::int)::int
     from jsonb_array_elements(public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->'series') e),
  2, 'task throughput: series counts sum to the 2 completed tasks');
select is((public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30)->>'avg_cycle_hours')::numeric,
  24.0, 'task throughput: avg cycle is 24h');
select is(
  (select (e->>'count')::int
     from jsonb_array_elements(public.reporting_content_funnel('c4b00000-0000-0000-0000-000000000001')) e
    where e->>'status' = 'draft'),
  1, 'content funnel: draft = 1');
select is(
  (select (e->>'total')::int
     from jsonb_array_elements(public.reporting_campaign_metrics('c4b00000-0000-0000-0000-000000000001', 30)) e
    where e->>'metric_key' = 'clicks'),
  100, 'campaign metrics: 30d window sums 100 and excludes the 60d-old row');
select is(
  (select jsonb_array_length(e->'points')
     from jsonb_array_elements(public.reporting_segment_growth('c4b00000-0000-0000-0000-000000000001', 90)) e
    where e->>'name' = 'Seg'),
  2, 'segment growth: 2 snapshot points for Seg');
select is(jsonb_array_length(public.reporting_workflow_health('c4b00000-0000-0000-0000-000000000001', 30)),
  2, 'workflow health: succeeded + failed = 2 outcome groups');
select is(
  (select sum((e->>'count')::int)::int
     from jsonb_array_elements(public.reporting_ingest_volume('c4b00000-0000-0000-0000-000000000001', 30)) e),
  2, 'ingest volume: 30d window counts 2 and excludes the 60d-old event');
select is(
  (select sum((e->>'count')::int)::int
     from jsonb_array_elements(public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)) e),
  3, 'event daily counts: 3 W1 internal events, W2 excluded');
select ok(public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)::text not like '%leak-me-not%',
  'event daily counts NEVER leak payload values');
select is(
  (select (e->>'count')::int
     from jsonb_array_elements(public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)) e
    where e->>'kind' = 'embed' and e->>'status' = 'done'),
  2, 'job daily counts: 2 done embed jobs');
select ok(public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30)::text not like '%evil.example%',
  'job daily counts NEVER leak payload values');
select lives_ok(
  $$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 100000) $$,
  'days is clamped server-side; absurd ranges do not error');

-- ── member B (member of W2 only): every RPC hard-denies W1 with 42501 ─────────
set local request.jwt.claims = '{"sub":"c4b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok($$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: task throughput');
select throws_ok($$ select public.reporting_content_funnel('c4b00000-0000-0000-0000-000000000001') $$,
  '42501', 'not_workspace_member', 'non-member denied: content funnel');
select throws_ok($$ select public.reporting_campaign_metrics('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: campaign metrics');
select throws_ok($$ select public.reporting_segment_growth('c4b00000-0000-0000-0000-000000000001', 90) $$,
  '42501', 'not_workspace_member', 'non-member denied: segment growth');
select throws_ok($$ select public.reporting_workflow_health('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: workflow health');
select throws_ok($$ select public.reporting_ingest_volume('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: ingest volume');
select throws_ok($$ select public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: event daily counts');
select throws_ok($$ select public.reporting_job_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', 'not_workspace_member', 'non-member denied: job daily counts');

-- ── anon: EXECUTE revoked entirely ────────────────────────────────────────────
reset role;
set local role anon;
select throws_ok($$ select public.reporting_task_throughput('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', null, 'anon lacks execute on the invoker RPCs');
select throws_ok($$ select public.reporting_event_daily_counts('c4b00000-0000-0000-0000-000000000001', 30) $$,
  '42501', null, 'anon lacks execute on the definer RPCs');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect RED:**

```sh
supabase test db
```
Expected: **FAIL** — `function public.reporting_task_throughput(uuid, integer) does not
exist` (and the 7 siblings). This is the fail-first proof for BOTH C4b.1 and C4b.2.

- [ ] **Step 3 — create the migration (invoker half)**
  `supabase/migrations/20260711000002_reporting_analytics.sql`:

```sql
-- C4b analytics layer: the reporting dashboards query surface.
-- Invoker RPCs aggregate over reporting.v_* (RLS binds via security_invoker views);
-- the two DEFINER RPCs (appended in C4b.2) are the only reporting path into movp_internal.

-- task carries no reporting metadata by Stage-B design; adding it would change the frozen
-- generated baseline (movp_fields upserts). The task dashboard therefore reads this
-- hand-authored view instead.
create or replace view reporting.v_task_cycle
with (security_invoker = true) as
select id, workspace_id, status_id, priority_id, created_at, completed_at, due_date, updated_at
from public.task;
grant select on reporting.v_task_cycle to authenticated, service_role;

create or replace function public.reporting_task_throughput(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  -- Uniform membership gate (belt-and-braces over RLS): one bounded failure code.
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'avg_cycle_hours',
    (select round((avg(extract(epoch from (completed_at - created_at)) / 3600.0))::numeric, 1)
       from reporting.v_task_cycle
      where workspace_id = ws and completed_at is not null
        and completed_at >= now() - make_interval(days => d)),
    'open_count',
    (select count(*) from reporting.v_task_cycle where workspace_id = ws and completed_at is null),
    'series',
    coalesce(
      (select jsonb_agg(jsonb_build_object('day', day, 'count', c) order by day)
         from (select to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') as day, count(*) as c
                 from reporting.v_task_cycle
                where workspace_id = ws and completed_at is not null
                  and completed_at >= now() - make_interval(days => d)
                group by 1) s),
      '[]'::jsonb));
end;
$$;
revoke all on function public.reporting_task_throughput(uuid, int) from public, anon;
grant execute on function public.reporting_task_throughput(uuid, int) to authenticated;

create or replace function public.reporting_content_funnel(ws uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('status', status, 'count', c) order by c desc)
       from (select status, count(*) as c
               from reporting.v_content_item
              where workspace_id = ws
              group by status) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_content_funnel(uuid) from public, anon;
grant execute on function public.reporting_content_funnel(uuid) to authenticated;

create or replace function public.reporting_campaign_metrics(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('metric_key', metric_key, 'total', t) order by t desc)
       from (select metric_key, sum(value) as t
               from reporting.v_campaign_metric
              where workspace_id = ws and measured_at >= current_date - d
              group by metric_key) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_campaign_metrics(uuid, int) from public, anon;
grant execute on function public.reporting_campaign_metrics(uuid, int) to authenticated;

create or replace function public.reporting_segment_growth(ws uuid, days int default 90)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 90), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  -- Reads the BASE tables, not v_segment_snapshot: `taken_at` and `segment.name` are
  -- not reporting-tagged, so the generated view does not carry them. This function is
  -- SECURITY INVOKER — RLS on both tables still binds to the caller.
  return coalesce(
    (select jsonb_agg(jsonb_build_object('segment_id', seg.id, 'name', seg.name, 'points', pts.points) order by seg.name)
       from public.segment seg
       join lateral (
         select coalesce(
           jsonb_agg(jsonb_build_object(
             'taken_at', to_char(ss.taken_at, 'YYYY-MM-DD'),
             'member_count', ss.member_count) order by ss.taken_at),
           '[]'::jsonb) as points
           from public.segment_snapshot ss
          where ss.segment_id = seg.id and ss.workspace_id = ws
            and ss.taken_at >= now() - make_interval(days => d)
       ) pts on true
      where seg.workspace_id = ws),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_segment_growth(uuid, int) from public, anon;
grant execute on function public.reporting_segment_growth(uuid, int) to authenticated;

create or replace function public.reporting_workflow_health(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('day', day, 'outcome', outcome, 'count', c) order by day, outcome)
       from (select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, outcome, count(*) as c
               from reporting.v_workflow_run
              where workspace_id = ws and created_at >= now() - make_interval(days => d)
              group by 1, 2) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_workflow_health(uuid, int) from public, anon;
grant execute on function public.reporting_workflow_health(uuid, int) to authenticated;

create or replace function public.reporting_ingest_volume(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('day', day, 'source', source, 'count', c) order by day, source)
       from (select to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day, source, count(*) as c
               from reporting.v_platform_event
              where workspace_id = ws and occurred_at >= now() - make_interval(days => d)
              group by 1, 2) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_ingest_volume(uuid, int) from public, anon;
grant execute on function public.reporting_ingest_volume(uuid, int) to authenticated;
```

- [ ] **Step 4 — apply and run, expect PARTIAL:**

```sh
supabase db reset && supabase test db
```
Expected: **PARTIAL FAIL** — assertions 1–8 (the invoker positives) pass, then the file
errors at `reporting_event_daily_counts` (function does not exist), which aborts the test
transaction; everything after reports as aborted. That failing remainder is C4b.2's
starting point.

- [ ] **Step 5 — commit.**

```sh
git add supabase/migrations/20260711000002_reporting_analytics.sql supabase/tests/reporting_analytics_test.sql
git commit -m "feat(reporting): C4b.1 dashboard invoker RPCs + hand-authored v_task_cycle (pgTAP red on definer half)"
```

---

## Task C4b.2: Definer event/job daily-count RPCs (redacted)

**Files**
- Modify: `supabase/migrations/20260711000002_reporting_analytics.sql` (append — this
  migration is NOT yet merged, so editing it is allowed; after merge it freezes)

**TDD steps**

- [ ] **Step 1 — confirm the expected failure stands** (from C4b.1 Step 4):
`supabase test db` fails with `function public.reporting_event_daily_counts(uuid, integer) does not exist`.

- [ ] **Step 2 — append to the migration:**

```sql
-- ── movp_internal analytics: SECURITY DEFINER, counts + bounded classifiers ONLY ──
-- movp_internal is not PostgREST-exposed and revoked from end-user roles (config.toml
-- schemas + internal_access_test.sql); these two RPCs are the only reporting path in.
-- Redaction: day + type/kind/status + count. NEVER payload values, NEVER trace ids.

create or replace function public.reporting_event_daily_counts(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('day', day, 'type', type, 'count', c) order by day, type)
       from (select to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') as day, e.type, count(*) as c
               from movp_internal.movp_events e
              where e.workspace_id = ws and e.created_at >= now() - make_interval(days => d)
              group by 1, 2) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_event_daily_counts(uuid, int) from public, anon, authenticated;
grant execute on function public.reporting_event_daily_counts(uuid, int) to authenticated;

create or replace function public.reporting_job_daily_counts(ws uuid, days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d int := least(greatest(coalesce(days, 30), 1), 90);
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('day', day, 'kind', kind, 'status', status, 'count', c) order by day, kind, status)
       from (select to_char(date_trunc('day', j.created_at), 'YYYY-MM-DD') as day, j.kind, j.status, count(*) as c
               from movp_internal.movp_jobs j
              where j.workspace_id = ws and j.created_at >= now() - make_interval(days => d)
              group by 1, 2, 3) s),
    '[]'::jsonb);
end;
$$;
revoke all on function public.reporting_job_daily_counts(uuid, int) from public, anon, authenticated;
grant execute on function public.reporting_job_daily_counts(uuid, int) to authenticated;
```

- [ ] **Step 3 — apply and run, expect GREEN:**

```sh
supabase db reset && supabase test db
```
Expected: **PASS — 657 tests across 32 files** (634 + 23), including both redaction
assertions and all 8 non-member denials.

- [ ] **Step 4 — gates + commit.**

```sh
node scripts/check-definer-audit.mjs      # Expected: 187 function blocks, all definers pinned (+8 RPCs)
supabase db diff                          # Expected: clean
node scripts/check-forward-only-migrations.mjs   # Expected: pass
git add supabase/migrations/20260711000002_reporting_analytics.sql
git commit -m "feat(reporting): C4b.2 definer event/job daily-count RPCs — redacted classifiers only"
```

---

## Task C4b.3: `makeReportingService(ctx)` in `@movp/domain`

**Files**
- Create: `packages/domain/src/reporting.ts`
- Create: `packages/domain/test/reporting.integration.test.ts`
- Modify: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`,
  `packages/domain/src/index.ts`

**TDD steps**

- [ ] **Step 1 — write the failing integration test**
  `packages/domain/test/reporting.integration.test.ts` (harness helpers cloned verbatim
  from `campaign.integration.test.ts` — same env, `serviceClient`, `userClient`,
  `assertOk`, `makeUser`, `makeWorkspace`, `addMember`):

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

// ── harness helpers (cloned VERBATIM from campaign.integration.test.ts) ────────
const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

function userClient(token: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function assertOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
  return res
}

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `reporting-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const cu = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    }),
    'create user',
  )).json()
  const si = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    'sign in',
  )).json()
  return { id: cu.id as string, token: si.access_token as string }
}

async function makeWorkspace(name: string): Promise<string> {
  const rows = await (await assertOk(
    await fetch(`${env.url}/rest/v1/workspace`, {
      method: 'POST',
      headers: { ...admin, Prefer: 'return=representation' },
      body: JSON.stringify({ name }),
    }),
    'create workspace',
  )).json()
  return rows[0].id as string
}

async function addMember(ws: string, userId: string): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ workspace_id: ws, user_id: userId, role: 'member' }),
    }),
    'add member',
  )
}

// ── reporting-specific setup ───────────────────────────────────────────────────
let ws: string
let otherWs: string // the acting user is NOT a member here
let domain: ReturnType<typeof createDomain>

beforeAll(async () => {
  const user = await makeUser()
  ws = await makeWorkspace(`RepDomW-${crypto.randomUUID().slice(0, 8)}`)
  otherWs = await makeWorkspace(`RepDomX-${crypto.randomUUID().slice(0, 8)}`)
  await addMember(ws, user.id)
  const db = userClient(user.token)
  domain = createDomain({ db, userId: user.id })

  // Seed through the member's own RLS-bound client (production-shaped, no service writes).
  const { data: campaign, error: cErr } = await db
    .from('campaign')
    .insert({ workspace_id: ws, name: 'Rep A', status: 'active' })
    .select('id')
    .single()
  if (cErr || !campaign) throw new Error(`campaign seed failed: ${cErr?.message}`)
  const { error: mErr } = await db.from('campaign_metric').insert([
    { workspace_id: ws, campaign_id: campaign.id, metric_key: 'clicks', value: 30, measured_at: new Date().toISOString().slice(0, 10) },
    { workspace_id: ws, campaign_id: campaign.id, metric_key: 'clicks', value: 70, measured_at: new Date().toISOString().slice(0, 10) },
  ])
  if (mErr) throw new Error(`metric seed failed: ${mErr.message}`)

  const { data: eventType, error: eErr } = await db.from('event_type').select('id').eq('key', 'task.completed').single()
  if (eErr || !eventType) throw new Error(`event_type lookup failed: ${eErr?.message}`)
  const { data: rule, error: rErr } = await db
    .from('automation_rule')
    .insert({ workspace_id: ws, trigger_event_type_id: eventType.id, condition: {}, action_type: 'notify', action_config: {} })
    .select('id')
    .single()
  if (rErr || !rule) throw new Error(`rule seed failed: ${rErr?.message}`)
  const { error: wErr } = await db.from('workflow_run').insert([
    { workspace_id: ws, source_event_id: crypto.randomUUID(), event_type: 'task.completed', automation_rule_id: rule.id, matched: true, action_type: 'notify', outcome: 'succeeded' },
    { workspace_id: ws, source_event_id: crypto.randomUUID(), event_type: 'task.completed', automation_rule_id: rule.id, matched: true, action_type: 'notify', outcome: 'failed' },
  ])
  if (wErr) throw new Error(`workflow_run seed failed: ${wErr.message}`)
}, 60_000)

describe('domain.reporting (live stack)', () => {
  it('campaignMetrics sums the fact table through the reporting view', async () => {
    const rows = await domain.reporting.campaignMetrics({ workspaceId: ws })
    const clicks = rows.find((r) => r.metric_key === 'clicks')
    expect(clicks?.total).toBe(100)
  })

  it('workflowHealth groups outcomes by day', async () => {
    const rows = await domain.reporting.workflowHealth({ workspaceId: ws })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.outcome))).toEqual(new Set(['succeeded', 'failed']))
  })

  it('taskThroughput returns the full shape even when empty', async () => {
    const t = await domain.reporting.taskThroughput({ workspaceId: ws, days: 7 })
    expect(t.open_count).toBe(0)
    expect(t.series).toEqual([])
    expect(t.avg_cycle_hours).toBeNull()
  })

  it('eventDailyCounts returns bounded classifiers (may be empty in a fresh stack)', async () => {
    const rows = await domain.reporting.eventDailyCounts({ workspaceId: ws, days: 7 })
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['count', 'day', 'type'])
    }
  })

  it('a non-member workspace fails loud with the bounded 42501 code', async () => {
    await expect(domain.reporting.campaignMetrics({ workspaceId: otherWs })).rejects.toThrow(
      /domain\.reporting\.campaignMetrics failed \[42501\]/,
    )
  })
})
```

- [ ] **Step 2 — run it, expect RED** (live stack must be up: `supabase start`):

```sh
pnpm --filter @movp/domain exec vitest run reporting.integration
```
Expected: **FAIL** — TypeScript: `Property 'reporting' does not exist on type 'Domain'`.

- [ ] **Step 3 — add the types.** In `packages/domain/src/types.ts`, add above the
  `Domain` interface:

```ts
export interface ReportingDayCount {
  day: string
  count: number
}

export interface ReportingTaskThroughput {
  avg_cycle_hours: number | null
  open_count: number
  series: ReportingDayCount[]
}

export interface ReportingStatusCount {
  status: string
  count: number
}

export interface ReportingMetricTotal {
  metric_key: string
  total: number
}

export interface ReportingSnapshotPoint {
  taken_at: string
  member_count: number
}

export interface ReportingSegmentGrowth {
  segment_id: string
  name: string
  points: ReportingSnapshotPoint[]
}

export interface ReportingOutcomeDayCount {
  day: string
  outcome: string
  count: number
}

export interface ReportingSourceDayCount {
  day: string
  source: string
  count: number
}

export interface ReportingTypeDayCount {
  day: string
  type: string
  count: number
}

export interface ReportingJobDayCount {
  day: string
  kind: string
  status: string
  count: number
}

export interface ReportingService {
  taskThroughput(a: { workspaceId: string; days?: number }): Promise<ReportingTaskThroughput>
  contentFunnel(a: { workspaceId: string }): Promise<ReportingStatusCount[]>
  campaignMetrics(a: { workspaceId: string; days?: number }): Promise<ReportingMetricTotal[]>
  segmentGrowth(a: { workspaceId: string; days?: number }): Promise<ReportingSegmentGrowth[]>
  workflowHealth(a: { workspaceId: string; days?: number }): Promise<ReportingOutcomeDayCount[]>
  ingestVolume(a: { workspaceId: string; days?: number }): Promise<ReportingSourceDayCount[]>
  eventDailyCounts(a: { workspaceId: string; days?: number }): Promise<ReportingTypeDayCount[]>
  jobDailyCounts(a: { workspaceId: string; days?: number }): Promise<ReportingJobDayCount[]>
}
```

and add to the `Domain` interface (`types.ts:338` area):

```ts
  reporting: ReportingService
```

- [ ] **Step 4 — create `packages/domain/src/reporting.ts`:**

```ts
import type {
  DomainCtx,
  ReportingMetricTotal,
  ReportingOutcomeDayCount,
  ReportingSegmentGrowth,
  ReportingService,
  ReportingSourceDayCount,
  ReportingStatusCount,
  ReportingTaskThroughput,
  ReportingTypeDayCount,
  ReportingJobDayCount,
} from './types.ts'

const fail = (op: string, code: string | undefined): never => {
  throw new Error(`domain.reporting.${op} failed [${code ?? 'unknown'}]`)
}

// Per-request rule (workerd/Deno analog): every read goes through ctx.db — the caller's
// RLS-bound client resolved at call time — never a captured or service-role client.
export function makeReportingService(ctx: DomainCtx): ReportingService {
  const rpc = async <T>(op: string, fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await ctx.db.rpc(fn, args)
    if (error) fail(op, error.code)
    return data as T
  }

  return {
    taskThroughput: (a) =>
      rpc<ReportingTaskThroughput>('taskThroughput', 'reporting_task_throughput', { ws: a.workspaceId, days: a.days ?? 30 }),
    contentFunnel: (a) =>
      rpc<ReportingStatusCount[]>('contentFunnel', 'reporting_content_funnel', { ws: a.workspaceId }),
    campaignMetrics: (a) =>
      rpc<ReportingMetricTotal[]>('campaignMetrics', 'reporting_campaign_metrics', { ws: a.workspaceId, days: a.days ?? 30 }),
    segmentGrowth: (a) =>
      rpc<ReportingSegmentGrowth[]>('segmentGrowth', 'reporting_segment_growth', { ws: a.workspaceId, days: a.days ?? 90 }),
    workflowHealth: (a) =>
      rpc<ReportingOutcomeDayCount[]>('workflowHealth', 'reporting_workflow_health', { ws: a.workspaceId, days: a.days ?? 30 }),
    ingestVolume: (a) =>
      rpc<ReportingSourceDayCount[]>('ingestVolume', 'reporting_ingest_volume', { ws: a.workspaceId, days: a.days ?? 30 }),
    eventDailyCounts: (a) =>
      rpc<ReportingTypeDayCount[]>('eventDailyCounts', 'reporting_event_daily_counts', { ws: a.workspaceId, days: a.days ?? 30 }),
    jobDailyCounts: (a) =>
      rpc<ReportingJobDayCount[]>('jobDailyCounts', 'reporting_job_daily_counts', { ws: a.workspaceId, days: a.days ?? 30 }),
  }
}
```

- [ ] **Step 5 — wire it.** In `packages/domain/src/domain.ts`, import
  `makeReportingService` from `'./reporting.ts'` and add one line to the `createDomain`
  return object:

```ts
    reporting: makeReportingService(ctx),
```

In `packages/domain/src/index.ts`, re-export alongside the other factories (the file
enumerates every export explicitly — `export { makeTaskService } …` lines followed by one
`export type { … }` block):

```ts
export { makeReportingService } from './reporting.ts'
```

and add to the existing `export type { … }` block:

```ts
  ReportingDayCount,
  ReportingJobDayCount,
  ReportingMetricTotal,
  ReportingOutcomeDayCount,
  ReportingSegmentGrowth,
  ReportingService,
  ReportingSnapshotPoint,
  ReportingSourceDayCount,
  ReportingStatusCount,
  ReportingTaskThroughput,
  ReportingTypeDayCount,
```

- [ ] **Step 6 — run, expect GREEN:**

```sh
pnpm --filter @movp/domain exec vitest run reporting.integration
```
Expected: **PASS** — 5 tests.

- [ ] **Step 7 — gates + commit.**

```sh
pnpm --filter @movp/domain test           # full domain suite against the live stack
turbo run typecheck                       # Expected: 12/12
git add packages/domain/src/reporting.ts packages/domain/src/types.ts packages/domain/src/domain.ts packages/domain/src/index.ts packages/domain/test/reporting.integration.test.ts
git commit -m "feat(domain): C4b.3 makeReportingService — typed wrappers over the 8 reporting RPCs"
```

---

## Task C4b.4: GraphQL custom reads (+ graphql-shape gate)

**Files**
- Modify: `packages/graphql/src/types.ts` (request-bound reporting failure callback)
- Modify: `packages/graphql/src/index.ts` (export the callback event type)
- Modify: `packages/graphql/src/schema.ts` (Reporting object types + 8 observed query fields)
- Modify: `packages/graphql/test/schema.test.ts` (SDL-presence assertions — this IS the
  `graphql-shape` CI gate)
- Create: `packages/graphql/test/reporting.test.ts`
- Modify: `supabase/functions/graphql/index.ts` (emit the keys-only failure event)

**TDD steps**

- [ ] **Step 1 — failing SDL assertions first.** In `packages/graphql/test/schema.test.ts`,
  inside the existing SDL describe block (after the current `expect(sdl)` assertions), add:

```ts
    // C4b reporting reads (Stage C4)
    expect(sdl).toMatch(/reportingTaskThroughput\(/)
    expect(sdl).toMatch(/reportingContentFunnel\(/)
    expect(sdl).toMatch(/reportingCampaignMetrics\(/)
    expect(sdl).toMatch(/reportingSegmentGrowth\(/)
    expect(sdl).toMatch(/reportingWorkflowHealth\(/)
    expect(sdl).toMatch(/reportingIngestVolume\(/)
    expect(sdl).toMatch(/reportingEventDailyCounts\(/)
    expect(sdl).toMatch(/reportingJobDailyCounts\(/)
    expect(sdl).toContain('type ReportingTaskThroughput')
```

- [ ] **Step 2 — run, expect RED:**

```sh
pnpm test:graphql-shape
```
Expected: **FAIL** — the new `toMatch` assertions do not find the queries.

- [ ] **Step 3 — add the request-bound observability seam.** In
  `packages/graphql/src/types.ts`, add these bounded event types and the optional
  callback to `GraphQLContext`:

```ts
export type ReportingOperation =
  | 'reportingTaskThroughput'
  | 'reportingContentFunnel'
  | 'reportingCampaignMetrics'
  | 'reportingSegmentGrowth'
  | 'reportingWorkflowHealth'
  | 'reportingIngestVolume'
  | 'reportingEventDailyCounts'
  | 'reportingJobDailyCounts'

export interface ReportingFailureEvent {
  operation: ReportingOperation
  errorCode: 'reporting_denied' | 'reporting_failed'
}

export interface GraphQLContext {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
  accessToken?: string
  assetsFnUrl?: string
  reportReportingFailure?: (event: ReportingFailureEvent) => void
}
```

Keep the existing `SupabaseClient` and `EmbeddingProvider` imports unchanged.

Export `ReportingFailureEvent` from `packages/graphql/src/index.ts`, then update the
Edge Function. The callback is created inside `Deno.serve`, so request ids and the
emitter are resolved per request rather than captured at module initialization:

```ts
import { createYoga, type ReportingFailureEvent } from '@movp/graphql'

// Inside Deno.serve, after principal resolution and before yoga.handleRequest:
const requestId = crypto.randomUUID()
const traceId = crypto.randomUUID()
const reportReportingFailure = ({ operation, errorCode }: ReportingFailureEvent): void => {
  emit({
    trace_id: traceId,
    request_id: requestId,
    surface: 'graphql',
    operation,
    error_code: errorCode,
    redaction_version: REDACTION_VERSION,
  })
}

// Add to the existing request context object passed to yoga.handleRequest:
reportReportingFailure,
```

This event is keys-only: do not include workspace ids, arguments, SQL messages, RPC
responses, or other values.

- [ ] **Step 4 — implement the observed resolvers in
  `packages/graphql/src/schema.ts`.** Extend the existing module-scope type-only import:

```ts
import type { GraphQLContext, ReportingOperation } from './types.ts'
```

Then add the wrapper inside `buildSchema` before the reporting object types:

```ts
const reportingErrorCode = (error: unknown): 'reporting_denied' | 'reporting_failed' =>
  error instanceof Error && error.message.includes('[42501]')
    ? 'reporting_denied'
    : 'reporting_failed'

const observeReporting = async <T>(
  ctx: GraphQLContext,
  operation: ReportingOperation,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read()
  } catch (error: unknown) {
    ctx.reportReportingFailure?.({ operation, errorCode: reportingErrorCode(error) })
    throw error
  }
}
```

Inside `buildSchema`, alongside the other custom-read blocks (e.g. after the
`segmentMembers`/admin query fields, before the final schema return), add:

```ts
  // ── Stage C4b: reporting dashboard reads (thin delegations to domain.reporting) ──
  const reportingDayCount = builder.objectRef<{ day: string; count: number }>('ReportingDayCount').implement({
    fields: (t) => ({
      day: t.exposeString('day'),
      count: t.exposeInt('count'),
    }),
  })

  const reportingTaskThroughput = builder
    .objectRef<{ avg_cycle_hours: number | null; open_count: number; series: { day: string; count: number }[] }>('ReportingTaskThroughput')
    .implement({
      fields: (t) => ({
        avgCycleHours: t.float({ nullable: true, resolve: (r) => r.avg_cycle_hours }),
        openCount: t.exposeInt('open_count'),
        series: t.field({ type: [reportingDayCount], resolve: (r) => r.series }),
      }),
    })

  const reportingStatusCount = builder.objectRef<{ status: string; count: number }>('ReportingStatusCount').implement({
    fields: (t) => ({
      status: t.exposeString('status'),
      count: t.exposeInt('count'),
    }),
  })

  const reportingMetricTotal = builder.objectRef<{ metric_key: string; total: number }>('ReportingMetricTotal').implement({
    fields: (t) => ({
      metricKey: t.string({ resolve: (r) => r.metric_key }),
      total: t.exposeFloat('total'),
    }),
  })

  const reportingSnapshotPoint = builder
    .objectRef<{ taken_at: string; member_count: number }>('ReportingSnapshotPoint')
    .implement({
      fields: (t) => ({
        takenAt: t.string({ resolve: (r) => r.taken_at }),
        memberCount: t.float({ resolve: (r) => r.member_count }),
      }),
    })

  const reportingSegmentGrowth = builder
    .objectRef<{ segment_id: string; name: string; points: { taken_at: string; member_count: number }[] }>('ReportingSegmentGrowth')
    .implement({
      fields: (t) => ({
        segmentId: t.id({ resolve: (r) => r.segment_id }),
        name: t.exposeString('name'),
        points: t.field({ type: [reportingSnapshotPoint], resolve: (r) => r.points }),
      }),
    })

  const reportingOutcomeDayCount = builder
    .objectRef<{ day: string; outcome: string; count: number }>('ReportingOutcomeDayCount')
    .implement({
      fields: (t) => ({
        day: t.exposeString('day'),
        outcome: t.exposeString('outcome'),
        count: t.exposeInt('count'),
      }),
    })

  const reportingSourceDayCount = builder
    .objectRef<{ day: string; source: string; count: number }>('ReportingSourceDayCount')
    .implement({
      fields: (t) => ({
        day: t.exposeString('day'),
        source: t.exposeString('source'),
        count: t.exposeInt('count'),
      }),
    })

  const reportingTypeDayCount = builder
    .objectRef<{ day: string; type: string; count: number }>('ReportingTypeDayCount')
    .implement({
      fields: (t) => ({
        day: t.exposeString('day'),
        type: t.exposeString('type'),
        count: t.exposeInt('count'),
      }),
    })

  const reportingJobDayCount = builder
    .objectRef<{ day: string; kind: string; status: string; count: number }>('ReportingJobDayCount')
    .implement({
      fields: (t) => ({
        day: t.exposeString('day'),
        kind: t.exposeString('kind'),
        status: t.exposeString('status'),
        count: t.exposeInt('count'),
      }),
    })

  type ReportingFieldBuilder = Parameters<Parameters<typeof builder.queryField>[1]>[0]
  const reportingArgs = (t: ReportingFieldBuilder) => ({
    workspaceId: t.arg.id({ required: true }),
    days: t.arg.int(),
  })

  builder.queryField('reportingTaskThroughput', (t) =>
    t.field({
      type: reportingTaskThroughput,
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingTaskThroughput', () =>
          domainFrom(ctx).reporting.taskThroughput({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingContentFunnel', (t) =>
    t.field({
      type: [reportingStatusCount],
      complexity: 5,
      args: { workspaceId: t.arg.id({ required: true }) },
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingContentFunnel', () =>
          domainFrom(ctx).reporting.contentFunnel({ workspaceId: String(a.workspaceId) })),
    }),
  )
  builder.queryField('reportingCampaignMetrics', (t) =>
    t.field({
      type: [reportingMetricTotal],
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingCampaignMetrics', () =>
          domainFrom(ctx).reporting.campaignMetrics({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingSegmentGrowth', (t) =>
    t.field({
      type: [reportingSegmentGrowth],
      complexity: 10,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingSegmentGrowth', () =>
          domainFrom(ctx).reporting.segmentGrowth({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingWorkflowHealth', (t) =>
    t.field({
      type: [reportingOutcomeDayCount],
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingWorkflowHealth', () =>
          domainFrom(ctx).reporting.workflowHealth({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingIngestVolume', (t) =>
    t.field({
      type: [reportingSourceDayCount],
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingIngestVolume', () =>
          domainFrom(ctx).reporting.ingestVolume({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingEventDailyCounts', (t) =>
    t.field({
      type: [reportingTypeDayCount],
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingEventDailyCounts', () =>
          domainFrom(ctx).reporting.eventDailyCounts({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
  builder.queryField('reportingJobDailyCounts', (t) =>
    t.field({
      type: [reportingJobDayCount],
      complexity: 5,
      args: reportingArgs(t),
      resolve: (_r, a, ctx) =>
        observeReporting(ctx, 'reportingJobDailyCounts', () =>
          domainFrom(ctx).reporting.jobDailyCounts({ workspaceId: String(a.workspaceId), days: a.days ?? undefined })),
    }),
  )
```

> Match the surrounding file's local idioms exactly (inferred Pothos callback types, the
> `domainFrom(ctx)` helper, `complexity` values). If the file's other objectRefs split
> `objectRef(...)` and `.implement(...)` into two statements, follow that instead — the
> SDL is identical either way.

- [ ] **Step 5 — run, expect GREEN:**

```sh
pnpm test:graphql-shape
```
Expected: **PASS**, including page-clamp/depth/complexity guardrail tests unchanged.

- [ ] **Step 6 — resolver behavior test** `packages/graphql/test/reporting.test.ts`
  (mocked domain; model = `campaign.test.ts`):

```ts
import { graphql } from 'graphql'
import { describe, expect, it, vi } from 'vitest'

const reporting = {
  taskThroughput: vi.fn(async () => ({
    avg_cycle_hours: 24,
    open_count: 1,
    series: [{ day: '2026-07-10', count: 2 }],
  })),
  contentFunnel: vi.fn(async () => [{ status: 'draft', count: 3 }]),
  campaignMetrics: vi.fn(async () => [{ metric_key: 'clicks', total: 100 }]),
  segmentGrowth: vi.fn(async () => [
    { segment_id: 's-1', name: 'Seg', points: [{ taken_at: '2026-07-09', member_count: 5 }] },
  ]),
  workflowHealth: vi.fn(async () => [{ day: '2026-07-10', outcome: 'succeeded', count: 1 }]),
  ingestVolume: vi.fn(async () => [{ day: '2026-07-10', source: 'internal', count: 2 }]),
  eventDailyCounts: vi.fn(async () => [{ day: '2026-07-10', type: 'task.completed', count: 3 }]),
  jobDailyCounts: vi.fn(async () => [{ day: '2026-07-10', kind: 'embed', status: 'done', count: 2 }]),
}

vi.mock('@movp/domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDomain: () => ({ reporting }),
}))

import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const gqlSchema = buildSchema(movpSchema)
// createDomain is mocked above, so ctx.db is never dereferenced; graphql()'s
// contextValue is typed unknown, so a plain literal needs no cast.
const reportReportingFailure = vi.fn()
const ctx = { db: {}, userId: 'u-1', reportReportingFailure }

describe('reporting resolvers (C4b.4)', () => {
  it('reportingTaskThroughput maps snake_case RPC fields to the typed shape', async () => {
    reportReportingFailure.mockClear()
    const res = await graphql({
      schema: gqlSchema,
      source: `query { reportingTaskThroughput(workspaceId: "w-1", days: 7) { avgCycleHours openCount series { day count } } }`,
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(res.data?.reportingTaskThroughput).toEqual({
      avgCycleHours: 24,
      openCount: 1,
      series: [{ day: '2026-07-10', count: 2 }],
    })
    expect(reporting.taskThroughput).toHaveBeenCalledWith({ workspaceId: 'w-1', days: 7 })
    expect(reportReportingFailure).not.toHaveBeenCalled()
  })

  it('list reads return typed arrays and forward workspaceId', async () => {
    reportReportingFailure.mockClear()
    const res = await graphql({
      schema: gqlSchema,
      source: `query {
        reportingContentFunnel(workspaceId: "w-1") { status count }
        reportingCampaignMetrics(workspaceId: "w-1") { metricKey total }
        reportingSegmentGrowth(workspaceId: "w-1") { segmentId name points { takenAt memberCount } }
        reportingWorkflowHealth(workspaceId: "w-1") { day outcome count }
        reportingIngestVolume(workspaceId: "w-1") { day source count }
        reportingEventDailyCounts(workspaceId: "w-1") { day type count }
        reportingJobDailyCounts(workspaceId: "w-1") { day kind status count }
      }`,
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect((res.data?.reportingContentFunnel as unknown[]).length).toBe(1)
    expect(res.data?.reportingCampaignMetrics).toEqual([{ metricKey: 'clicks', total: 100 }])
    expect(res.data?.reportingSegmentGrowth).toEqual([
      { segmentId: 's-1', name: 'Seg', points: [{ takenAt: '2026-07-09', memberCount: 5 }] },
    ])
    expect(reporting.contentFunnel).toHaveBeenCalledWith({ workspaceId: 'w-1' })
    expect(reportReportingFailure).not.toHaveBeenCalled()
  })

  it('a domain failure surfaces as a GraphQL error, not a silent null', async () => {
    reportReportingFailure.mockClear()
    reporting.contentFunnel.mockRejectedValueOnce(new Error('domain.reporting.contentFunnel failed [42501]'))
    const res = await graphql({
      schema: gqlSchema,
      source: `query { reportingContentFunnel(workspaceId: "w-other") { status count } }`,
      contextValue: ctx,
    })
    expect(res.errors?.[0]?.message).toMatch(/\[42501\]/)
    expect(reportReportingFailure).toHaveBeenCalledTimes(1)
    expect(reportReportingFailure).toHaveBeenCalledWith({
      operation: 'reportingContentFunnel',
      errorCode: 'reporting_denied',
    })
  })
})
```

- [ ] **Step 7 — run, expect GREEN:**

```sh
pnpm --filter @movp/graphql test
```
Expected: **PASS** — new file 3 tests, existing suites unchanged.

- [ ] **Step 8 — gates + commit.**

```sh
pnpm test:graphql-shape                   # Expected: pass
turbo run typecheck                       # Expected: 12/12
git add packages/graphql/src/types.ts packages/graphql/src/index.ts packages/graphql/src/schema.ts \
        packages/graphql/test/schema.test.ts packages/graphql/test/reporting.test.ts \
        supabase/functions/graphql/index.ts
git commit -m "feat(graphql): C4b.4 typed reporting reads + keys-only failure events"
```

---

## Deferred (visible, not silent)

- **MCP/CLI reporting surfaces** — per C2/C3 precedent custom reads are GraphQL-first;
  wire agent surfaces only when an agent use-case asks (`packages/mcp/src/server.ts`
  hand-picks tools explicitly).
- **Realtime/streaming dashboard updates** — SSR reads are the v1; Supabase Realtime is
  the documented escape hatch.
- **Per-campaign / per-segment drill-down args** — `campaignDetail` and
  `segmentMembershipExplained` already exist for entity-level views; dashboards stay
  workspace-level.

## Eight-dimension self-check (C4b)

- **Correctness** — RPC output shapes stated once (Interfaces) and pinned by pgTAP value
  assertions + resolver tests; snake_case→camelCase mapping tested.
- **Safety** — definer RPCs are the only internal-table path, self-gated with
  `is_workspace_member` + `42501`; execute revoked from anon/public; invoker RPCs ride
  RLS; no schema-DSL or baseline changes.
- **Reliability** — non-member/anon paths raise a bounded, stable code (`42501`
  `not_workspace_member`); empty windows return `[]`/nulls, never SQL errors
  (`lives_ok` clamp test).
- **Observability** — every rejected reporting resolver emits exactly one request-bound,
  keys-only event with a bounded operation and `reporting_denied`/`reporting_failed`
  code, then rethrows so the GraphQL error still carries the domain code. The resolver
  Vitest pins both the emission count and preserved client failure. Output redaction is
  pinned by value.
- **Efficiency** — aggregation happens once, in SQL; existing `workspace_job_counts` is
  not duplicated (the new job RPC adds the *daily trend*, current totals stay on the C2
  read); one GraphQL document serves the whole page (C4c).
- **Performance** — every date-ranged read is clamped to ≤90 days; group-bys run over
  indexed FK/timestamp columns; no N+1 (segment growth is one lateral join).
- **Simplicity** — eight thin wrappers, one `rpc()` helper, no speculative params.
- **Usability** — camelCase GraphQL fields; `days` optional with sane defaults; one
  bounded failure code for the frontend to map.
