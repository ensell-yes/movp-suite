# MOVP App — Segmentation & Lifecycle Events Phase 6, Part D: Surfaces, Frontend & End-to-End

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Surface and present the Segmentation subsystem that **Parts A, B & C** delivered. Parts A/B/C added the seven segmentation collections config-first (so codegen ALREADY emits the full generic GraphQL/MCP/CLI create+read CRUD, `Page` types, workspace-member RLS, FTS, and TS types), the `platform_event` ingestion paths (internal bridge + external API-key/JWT), and the idempotent recompute engine (`public.evaluate_segment(seg_id)` — the injection-safe DEFINER eval used by recompute — plus the ad-hoc `movp_internal.segment_match_subjects(ws, predicate)` compiler, `public.recompute_segment(seg_id, mode default 'full', trace default null)` — defaults make the 1-arg call work — and `public.take_segment_snapshot(seg_id, reason)`). Part D adds **no new collection**. It adds: a small set of custom **READ** queries (`previewMatchingCount`, `segmentMembershipExplained`, `snapshotDiff`) + three generic-surface **enumeration bridges** the per-segment views need (`segmentSummaries`, `segmentMembers`, `segmentSnapshots`) + ONE custom **write** mutation (`createSegmentRuleVersion` — the generic `createSegmentRule` SKIPS the `segment_id` relation FK, so setting it needs a small custom op); ONE tiny custom-read RPC (`public.preview_segment_predicate`, allowed by scope, ONLY if Part C didn't already expose it); four Astro frontend routes (segment list, rule builder, membership explorer, snapshot history) rendered via `client:load` islands → same-origin `/api/*` routes → server-side `gqlRequest`; a **BI/ML metadata** verification (pgTAP); and a `[segmentation]` end-to-end slice appended to `scripts/slice-e2e.sh`. **The `campaignAudience` campaign→segment/snapshot audience seam is DEFERRED out of Part D** (no producer writes the edges yet — see Global Constraints).

**Architecture:** Segmentation collections are config-first and **NOT internal**, so — like Campaigns — the schema-driven GraphQL (`packages/graphql/src/schema.ts`), MCP (`packages/mcp/src/server.ts`), and CLI (`packages/cli/src/program.ts`) builders already emit generic surfaces for `platform_event`/`segment`/`segment_rule`/`segment_membership`/`segment_snapshot`/`segment_snapshot_member`/`segment_recompute_run` (object types `Segment`, `PlatformEvent`, `SegmentMembership`, …; `create<Pascal>` mutations; `<name>` get + `<name>s` list queries; `<name>.create`/`get`/`list` MCP tools; `movp <name> …` CLI groups). **Part D adds NO generic surface code — codegen owns it.** The custom reads bridge the generic surface's three limits (jsonb serialises to `"[object Object]"`; relation FKs resolve via the edges loader so `segment_id`/`matched_rule_id` are not queryable scalars; the generic list has only `workspaceId`/`first`/`after` — **no per-field filter**), so every per-segment view (rules/members/snapshots) needs a small BFF read — exactly the wall `campaignDetail` hit in Part 03c. The frontend reaches the backend via **server-side** GraphQL-over-HTTP only: a page's `.astro` frontmatter (SSR) calls `gqlRequest` directly, and every browser-driven interaction (preview, explanation, save) goes through a `client:load` `.tsx` island → a same-origin `/api/segments/*` route → server-side `gqlRequest` (the in-template `gqlRequest`/`getSessionToken`/`readServerEnv`/`Base.astro`/state components). **A browser cannot POST GraphQL directly** — the GraphQL endpoint is server-only via the `cloudflare:workers` env, the session token is an httpOnly cookie, and the mock sends no CORS — so the island fetches a JSON `/api/*` route that the server resolves under the caller's cookie, exactly like the committed `SearchBox.tsx` → `/api/search`.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, pgTAP, Supabase CLI. `.ts` relative imports with explicit extensions; bare `@movp/*` workspace specifiers. Pothos (`@pothos/core`) for GraphQL. Astro + GraphQL-over-HTTP (no `@movp/{auth,domain}`) for the frontend; Playwright + `@axe-core/playwright` for the a11y smoke.

**This is Part D of the Phase-6 Segmentation series.** It depends on **Parts A, B & C** (the seven collections in `@movp/core-schema`; the regenerated generic surfaces + generated `Segment*`/`PlatformEvent*`/`SegmentMembership*`/`SegmentSnapshot*`/`SegmentRecomputeRun*` types; the `platform_event` bridge + external ingestion; the recompute engine `evaluate_segment`/`recompute_segment`/`take_segment_snapshot`; the `segment_recompute` job kind) being merged first. **Precondition: the Campaigns phase (03a–03c) is also merged** — a series-wide consistency check only; **the `campaign→segment/snapshot` audience seam (`campaignAudience`) is DEFERRED out of Part D** (nothing writes those edges yet), so Part D does not depend on the `campaign` collection at runtime. **Part D authors no collection migration** (the one tiny custom-read RPC below is allowed by scope; a pgTAP *test* is not a migration).

## Global Constraints

- **Consume Parts A/B/C; do not rebuild them.** The seven segmentation tables, their RLS (workspace-member read), the generic surfaces, the ingestion paths, the recompute engine (`evaluate_segment`/`recompute_segment`/`take_segment_snapshot`), the `segment_recompute` job kind, and the generated types are fixed inputs. Do not redefine them. **Part D adds no `supabase/migrations/*.sql` collection/table** — the ONLY migration it may add is the tiny read-only `public.preview_segment_predicate` RPC (Task 1), and ONLY when Part C did not already expose it.
- **No generic surface code re-added.** Codegen owns the generic segmentation CRUD (create + get + list). Part D adds only the custom READ queries below + ONE custom rule-version WRITE (`createSegmentRuleVersion`, because the generic `createSegmentRule` SKIPS the `segment_id` relation FK — see Task 1 / F10) — no generic object types, `create*` mutations, or `<name>s` list queries authored by hand. A gate in Task 1 greps the SDL to prove no *generic* `updateSegment`/`deleteSegment` write was introduced by Part D (the one custom `createSegmentRuleVersion` is intentional).
- **`previewMatchingCount` reuses Part C's SAME injection-safe compiler — never a new unsafe path.** The preview evaluates the given predicate through **Part C's `movp_internal.segment_match_subjects(ws, predicate)`** — the exact ad-hoc compiler that reuses Part C's `compile_predicate` (the parameterized set-based query `evaluate_segment` uses) — WITHOUT writing `segment_membership`. Part D's `preview_segment_predicate` calls THAT set-returning function and returns a capped count; it authors **no new `EXECUTE`/`format`**, never string-concatenates the predicate into SQL, and never opens a second, unsafe evaluation path. **Part D builds NO SQL from the predicate** — `preview_segment_predicate` passes it as a jsonb PARAMETER to Part C's `segment_match_subjects`, so it structurally inherits that function's injection safety, which is proven by Part C's `segment_match_subjects` injection pgTAP (04c asserts a `'; drop table …` predicate leaves the table intact). There is no untrusted-SQL surface in Part D to test separately; the resolver test (Task 1) proves `previewMatchingCount` routes the predicate through the RPC unmodified.
- **Evidence/properties render ids and typed values, NOT raw PII.** `segmentMembershipExplained` selects only `id`/`event_type`/`occurred_at`/`subject_type` from `platform_event` — NEVER `properties`. `evidence` is surfaced as the event trail (ids + typed dimensions), never the raw payload. No resolver, log, or event carries a `properties`/`evidence` VALUE.
- **The campaign→segment/snapshot audience seam is DEFERRED (YAGNI — no first producer/consumer).** Nothing in the suite writes `campaign --targets_segment--> segment` or `campaign --targets_snapshot--> segment_snapshot` edges: Campaigns' `linkSegment` writes `campaign --targets--> campaign_segment` (its intent-only Part-A table), which is **unchanged**, and Part D adds no edge writer and no consumer. So Part D authors **no `campaignAudience` resolver and no `targets_segment`/`targets_snapshot` rel conventions**. **Deferred to a future campaign-targeting flow (Phase 7):** when a campaign-targeting write exists, add the `targets_segment`/`targets_snapshot` edges + a `campaignAudience` resolver (frozen-snapshot-wins over dynamic-segment) + an e2e that writes the edge and asserts the resolved audience. Until then: do NOT modify Campaigns' `linkSegment`; do NOT drop `campaign_segment`.
- **Per-request dependencies resolved at call time.** Every custom resolver reads `ctx.db` from the `GraphQLContext` at call time — never module scope (on workerd there is no per-request module instance). Part D's reads use `ctx.db` (+ `ctx.db.rpc`) only; no resolver uses `domainFrom(ctx)`/graph traversal (that was the deferred `campaignAudience`'s dependency).
- **Custom reads are member-scoped, RLS-authoritative.** Every BFF read runs through `ctx.db` under the CALLER's RLS (these are non-internal, member-readable tables — the precedent is `resolveShareLink` at `packages/graphql/src/schema.ts:343`, a committed resolver that reads `ctx.db` under the caller's client). `preview_segment_predicate` is `SECURITY DEFINER` and therefore gates on `is_workspace_member` explicitly inside the function. No service-role, no `process.env`.
- **Boundary gate.** `templates/` must stay free of `@movp/{auth,domain}` and service-role references — GraphQL-over-HTTP only. `bash scripts/check-boundary.sh` must stay green (it walks `templates/`, `*.mjs` included, and fails on a forbidden import; new files are covered automatically).

## Inputs consumed from Parts A/B/C (verify BEFORE Task 1)

Part D references Parts A/B/C by exact name; a mismatch here is a reconciliation defect, not something to work around.

**Naming invariants (load-bearing):**
- Collection `name` = snake_case DB table name: `platform_event`, `segment`, `segment_rule`, `segment_membership`, `segment_snapshot`, `segment_snapshot_member`, `segment_recompute_run`. Generated TS types are Pascal-singular: `PlatformEventRow`, `SegmentRow`, `SegmentRuleRow`, `SegmentMembershipRow`, `SegmentSnapshotRow`, `SegmentSnapshotMemberRow`, `SegmentRecomputeRunRow`.
- **Codegen snake_cases field keys → columns; relation fields → `<field>_id`.** The emitted COLUMNS are: `platform_event`(`event_type`, `subject_type`, `subject_ref`, `actor_ref`, `source`, `properties`, `occurred_at`, `ingested_at`); `segment`(`name`, `description`, `owner_ref`, `active`, `mode`); `segment_rule`(`segment_id`, `predicate`, `version`, `active`, `description`); `segment_membership`(`segment_id`, `subject_type`, `subject_ref`, `matched_rule_id`, `first_matched_at`, `evaluated_at`, `evidence`); `segment_snapshot`(`segment_id`, `taken_at`, `reason`, `rule_version_set`, `member_count`); `segment_snapshot_member`(`snapshot_id`, `subject_ref`, `matched_rule_id`, `evidence`); `segment_recompute_run`(`segment_id`, `mode`, `started_at`, `finished_at`, `added_count`, `removed_count`, `evaluated_count`, `idempotency_key`, `outcome_code`). Part D's `ctx.db` selects and the pgTAP use these snake_case names. **If Parts A/B/C emitted a column under a different name, STOP and reconcile.**
- **Generic GraphQL names (from the committed builder — load-bearing):** `plural(name) = `\`${name}s\`` (snake). List queries: `platform_events`, `segments`, `segment_rules`, `segment_memberships`, `segment_snapshots`, `segment_snapshot_members`, `segment_recompute_runs`; get queries: `segment(id)`, `platform_event(id)`, …; create mutations: `create${pascal(name)}` (`createSegment`, `createPlatformEvent`, …) whose inputs are `workspace_id` + each **non-relation** scalar (relation fields are SKIPPED). **There are NO generic `update`/`delete` mutations.** Verify with `printSchema` if in doubt.

**Generic surface shape Part D must design around (verified in `packages/graphql/src/schema.ts`, confirmed by Part 03c):**
1. Every non-relation column is exposed as a **nullable `String`** via `String(v)`. A jsonb column (`predicate`, `evidence`, `properties`, `rule_version_set`, `goal_metrics`) serialises to `"[object Object]"` — **unusable as structured data**. → the custom reads parse jsonb server-side.
2. Relation fields resolve via the **edges loader**, so FK scalars like `segment_id`/`matched_rule_id`/`snapshot_id` are **not** queryable through the generic object. → per-segment filtering cannot be done client-side over the generic list.
3. The generic list query takes only `workspaceId`/`first`/`after` (**no field filter**). Plain scalar fields (`name`, `active`, `mode`, `owner_ref`, `event_type`, `subject_ref`, `occurred_at`, `source`) ARE exposed (as `String`), so workspace-wide lists work; **every per-segment view (rules/members/snapshots) needs a BFF read** (limits 2 + 3 together).

**Engine contract (Parts A/B/C built it; Part D consumes it):**
```ts
// Recompute engine — SQL RPCs Part C exposed (consumed, not re-authored):
//   public.evaluate_segment(seg_id uuid)        -> the injection-safe DEFINER eval used by recompute
//                                                  (compiles the segment's ACTIVE stored rules; used internally)
//   movp_internal.segment_match_subjects(ws uuid, predicate jsonb) returns setof text
//                                                -> Part C's AD-HOC evaluator: the SAME injection-safe
//                                                   compiler (reusing compile_predicate) evaluate_segment
//                                                   uses, but for an arbitrary predicate. THIS is what
//                                                   the preview RPC calls — no new compiler, no EXECUTE.
//   public.recompute_segment(seg_id uuid, mode text default 'full', trace text default null)
//                                                -> synchronous on-demand recompute: eval → diff → apply
//                                                   membership (matched_rule + evidence) → emit events.
//                                                   Defaults make the 1-arg call `recompute_segment(seg)` work.
//   public.take_segment_snapshot(seg_id uuid, reason text) -> freeze current membership into
//                                                  segment_snapshot + segment_snapshot_member (immutable)
// Part D's reads use ctx.db (+ ctx.db.rpc) only. (The campaign→segment/snapshot audience seam that would
// have used domain.graph.traverse is DEFERRED — see Global Constraints — so no graph traversal here.)
```

**Evidence shape (Part B owns it; Part D renders it PII-disciplined):** `segment_membership.evidence` / `segment_snapshot_member.evidence` is jsonb holding the matching `platform_event` ids (and/or attribute values). Part D reads `evidence.event_ids` (array of `platform_event` ids) and resolves each to `{ id, event_type, occurred_at }` typed dimensions ONLY. **If Part B keyed the ids under a different name (e.g. `events`/`matched_event_ids`), reconcile the one accessor — do not surface `properties`.**

- [ ] **Precondition check** — confirm Parts A/B/C + Campaigns are merged. Run:
```bash
cd /Users/ensell/Code/supasuite
grep -q 'PlatformEventRow' packages/domain/src/generated/types.ts && echo GEN_EVENT_OK || echo GEN_EVENT_MISSING
grep -q 'SegmentRow' packages/domain/src/generated/types.ts && echo GEN_SEGMENT_OK || echo GEN_SEGMENT_MISSING
grep -q 'SegmentMembershipRow' packages/domain/src/generated/types.ts && echo GEN_MEMBERSHIP_OK || echo GEN_MEMBERSHIP_MISSING
grep -q 'SegmentSnapshotMemberRow' packages/domain/src/generated/types.ts && echo GEN_SNAPMEMBER_OK || echo GEN_SNAPMEMBER_MISSING
grep -q 'SegmentRecomputeRunRow' packages/domain/src/generated/types.ts && echo GEN_RUN_OK || echo GEN_RUN_MISSING
grep -Rnq 'evaluate_segment' supabase/migrations && echo EVAL_OK || echo EVAL_MISSING
grep -Rnq 'segment_match_subjects' supabase/migrations && echo ADHOC_COMPILER_OK || echo ADHOC_COMPILER_MISSING
grep -Rnq 'recompute_segment' supabase/migrations && echo RECOMPUTE_OK || echo RECOMPUTE_MISSING
grep -Rnq 'take_segment_snapshot' supabase/migrations && echo SNAPSHOT_OK || echo SNAPSHOT_MISSING
grep -Rnq 'bridge_event_to_platform\|segmentation_bridged_types' supabase/migrations && echo BRIDGE_OK || echo BRIDGE_CHECK
grep -Rnq 'ingest_platform_event\|ingest_key' supabase/migrations && echo INGEST_OK || echo INGEST_CHECK
grep -Rnq "segment_recompute" supabase/migrations && echo JOBKIND_OK || echo JOBKIND_MISSING
# F8: Part A emits reporting_role='measure' for the segmentation count fields into movp_fields (Task 5 depends on it).
grep -Rnq "'measure'" supabase/migrations/20260701000002_movp_generated.sql && echo MEASURE_ROLE_OK || echo MEASURE_ROLE_MISSING
# F9: the campaign table lives in Campaigns' own migration (e.g. 000017), not the generated 000002 — grep recursively.
# The Campaigns series is a series-wide precondition only; Part D's campaign audience seam is DEFERRED (no runtime dep).
grep -Rnq 'create table if not exists public.campaign ' supabase/migrations && echo CAMPAIGN_TABLE_OK || echo CAMPAIGN_TABLE_MISSING
grep -Rnq 'preview_segment_predicate' supabase/migrations && echo PREVIEW_RPC_PRESENT || echo PREVIEW_RPC_ABSENT
# ── frontend template (Part D reuses gqlRequest/getSessionToken/readServerEnv + the mock harness) ──
test -f templates/frontend-astro/src/lib/graphql.ts \
  && test -f templates/frontend-astro/src/lib/session.ts \
  && test -f templates/frontend-astro/src/lib/env.ts \
  && test -f templates/frontend-astro/tests/mock/graphql-mock.mjs \
  && test -f templates/frontend-astro/playwright.config.ts \
  || { echo FE_TEMPLATE_MISSING; exit 1; }
echo FE_TEMPLATE_OK
```
Expected: `GEN_EVENT_OK`, `GEN_SEGMENT_OK`, `GEN_MEMBERSHIP_OK`, `GEN_SNAPMEMBER_OK`, `GEN_RUN_OK`, `EVAL_OK`, `ADHOC_COMPILER_OK`, `RECOMPUTE_OK`, `SNAPSHOT_OK`, `INGEST_OK`, `JOBKIND_OK`, `MEASURE_ROLE_OK`, `CAMPAIGN_TABLE_OK`, and `FE_TEMPLATE_OK`. `ADHOC_COMPILER_OK` confirms Part C exposes `movp_internal.segment_match_subjects` (the ad-hoc compiler the preview RPC reuses); `MEASURE_ROLE_OK` confirms Part A emitted the `'measure'` reporting roles Task 5 verifies. `PREVIEW_RPC_PRESENT` vs `PREVIEW_RPC_ABSENT` decides whether Task 1 adds the tiny preview RPC migration (add it only when ABSENT). For `BRIDGE_*`/`INGEST_*`: confirm Part B wired the internal bridge (`bridge_event_to_platform`) and the external ingestion (`ingest_platform_event` + `ingest_key`) — the e2e depends on both. If any `*_MISSING`/non-zero exit fires, STOP — the prerequisite phase is not merged; this plan cannot execute.

## File Structure

```
supasuite/
  packages/
    graphql/
      src/schema.ts                              # EDIT: custom READ queries + createSegmentRuleVersion write (gated by refs.has('segment_membership'))
      test/segmentation.test.ts                   # NEW
    mcp/
      src/server.ts                               # EDIT (OPTIONAL): segment.preview_matching_count custom tool
      test/server.test.ts                         # EDIT (OPTIONAL)
    cli/
      src/program.ts                              # EDIT (OPTIONAL): `movp segment-preview` custom command
      test/program.test.ts                        # EDIT (OPTIONAL)
  supabase/
    migrations/
      20260702000001_segment_preview_predicate.sql   # NEW (ONLY if PREVIEW_RPC_ABSENT): the ONE tiny custom-read RPC
    tests/
      segmentation_bi_test.sql                    # NEW: BI/ML metadata-registry + fact-stream pgTAP (test only — NOT a migration)
  templates/
    frontend-astro/
      src/lib/segment-queries.ts                  # NEW: GraphQL documents (summaries/detail/members/snapshots/preview/explanation/diff/save-rule)
      src/pages/segments/index.astro              # NEW: segment list (SSR — counts, owner, active/mode, last recompute)
      src/pages/segments/[id]/rules.astro         # NEW: rule builder page (SSR header + <RuleBuilder client:load/> island)
      src/pages/segments/[id]/members.astro       # NEW: membership explorer page (SSR member list + <MembershipExplorer client:load/> island)
      src/pages/segments/[id]/snapshots.astro     # NEW: snapshot history (SSR trend + GET-form diff via ?a=&b= query params)
      src/components/segments/RuleBuilder.tsx     # NEW: island — typed DSL editor; Preview → /api/segments/preview; Save → /api/segments/save-rule
      src/components/segments/MembershipExplorer.tsx # NEW: island — click a member → /api/segments/explanation → evidence panel (PII-disciplined)
      src/pages/api/segments/preview.ts           # NEW: server route — getSessionToken + readServerEnv + gqlRequest(PREVIEW_MATCHING_COUNT) (mirrors api/search.ts)
      src/pages/api/segments/explanation.ts       # NEW: server route — gqlRequest(MEMBERSHIP_EXPLANATION) under the cookie token
      src/pages/api/segments/save-rule.ts         # NEW: server route (POST) — gqlRequest(CREATE_SEGMENT_RULE_VERSION) under the cookie token
      tests/e2e/segments.spec.ts                  # NEW: mock-driven Playwright + axe smoke (via /scenario)
      tests/mock/graphql-mock.mjs                 # EDIT: answer segment ops with scenario-keyed canned data
  scripts/
    slice-e2e.sh                                  # EDIT: append the [segmentation] section
```

---

### Task 1: GraphQL custom READ queries + the `createSegmentRuleVersion` write

Add the custom surface to `packages/graphql/src/schema.ts`, gated behind `refs.has('segment_membership')` (so schemas without the segmentation collections are unaffected), mirroring the committed task/collab/campaign custom-op blocks. **No generic surface code** — codegen already emits `segments`/`segment(id)`/`createSegment`/etc. The surface splits into three groups:

- **Contract-named custom reads:** `previewMatchingCount` (bounded, injection-safe preview via `ctx.db.rpc('preview_segment_predicate', …)`), `segmentMembershipExplained` (per-member explanation — matched rule version + evidence event trail, PII-disciplined), `snapshotDiff` (set difference over `segment_snapshot_member`).
- **Generic-surface enumeration bridges (forced by limits 2 + 3 — no per-segment filter):** `segmentSummaries(workspaceId)` (list view: member counts + last recompute), `segmentMembers(segmentId, first, after)` (explorer pagination), `segmentSnapshots(segmentId)` (snapshot history). Each is the same `ctx.db`-under-RLS pattern as `campaignDetail` (03c); without them the required per-segment views are not expressible over the generic surface. **Reconcile:** if Parts A/B/C exposed a per-segment generic filter or these reads, prefer those and delete the bridge.
- **One custom WRITE (`createSegmentRuleVersion(segmentId, predicate)`):** the rule builder's Save. The generic `createSegmentRule` input SKIPS the `segment_id` relation FK (relation fields are dropped by codegen), so a rule cannot be attached to its segment through the generic surface — this custom mutation inserts a `segment_rule` row with `segment_id` set and `version` = current max + 1. It is the ONLY write Part D authors; it does NOT touch Campaigns' `linkSegment`.

> **Deferred:** the `campaignAudience` campaign→segment/snapshot audience seam is DEFERRED out of Part D (no producer writes the `targets_segment`/`targets_snapshot` edges yet — see Global Constraints). Do NOT author a `campaignAudience` resolver, the two rel conventions, or `domain.graph.traverse` calls here.

**Files:**
- Edit: `packages/graphql/src/schema.ts`
- New (only if `PREVIEW_RPC_ABSENT`): `supabase/migrations/20260702000001_segment_preview_predicate.sql`
- Test: `packages/graphql/test/segmentation.test.ts`

- [ ] **Step 1 (only if `PREVIEW_RPC_ABSENT`): the tiny preview RPC migration**

`supabase/migrations/20260702000001_segment_preview_predicate.sql` — the ONE tiny custom-read RPC allowed by scope. It REUSES Part C's injection-safe compiler (never a new SQL-building path) and NEVER writes membership:
```sql
-- Part D — bounded, read-only predicate preview for the rule builder (custom READ RPC).
-- SECURITY DEFINER + explicit membership guard: the definer bypasses RLS, so we authorize the
-- caller against the segment's workspace ourselves. It compiles the AD-HOC predicate through the
-- SAME typed-DSL compiler public.evaluate_segment uses (a parameterized set-based query) and does
-- NOT concatenate the predicate into SQL. It returns a CAPPED count and writes nothing.
create or replace function public.preview_segment_predicate(seg_id uuid, predicate jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws  uuid;
  cnt integer;
  cap constant integer := 10000;   -- least-cap: preview is an order-of-magnitude, not an exact audience
begin
  select workspace_id into ws from public.segment where id = seg_id;
  if ws is null then
    return 0;
  end if;
  if not public.is_workspace_member(ws) then          -- definer bypasses RLS → gate explicitly
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Part C exposes EXACTLY movp_internal.segment_match_subjects(ws uuid, predicate jsonb) returns setof
  -- text — the AD-HOC evaluator that reuses Part C's compile_predicate (the SAME injection-safe compiler
  -- evaluate_segment uses). We call THAT set-returning function; we author NO new compiler, NO EXECUTE,
  -- and NO format() — the predicate is passed as a jsonb PARAMETER, never concatenated into SQL.
  select least(count(*), cap)::int into cnt
  from (
    select 1
    from movp_internal.segment_match_subjects(ws, predicate)   -- ← Part C's injection-safe ad-hoc compiler
    limit cap
  ) s;
  return coalesce(cnt, 0);
end;
$$;

revoke all on function public.preview_segment_predicate(uuid, jsonb) from public;
grant execute on function public.preview_segment_predicate(uuid, jsonb) to authenticated;
```
> **Reconciliation note (read before typing).** If `PREVIEW_RPC_PRESENT` fired in the precondition, DELETE this file and consume Part C's function verbatim (Part C may have already shipped `preview_segment_predicate` itself). `movp_internal.segment_match_subjects(ws, predicate)` is confirmed present by the precondition's `ADHOC_COMPILER_OK` — it is Part C's ad-hoc compiler reusing `compile_predicate`, so the preview reuses the SAME safe path and can NEVER become a second, unsafe one. If Part C's compiler signature differs (e.g. also takes `as_of`), match it and pass a NULL/now default — but do NOT author a new compiler or any `EXECUTE`/`format`.

- [ ] **Step 2: Write the failing test**

`packages/graphql/test/segmentation.test.ts`:
```ts
import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

// Every read/write under test hits ctx.db (+ ctx.db.rpc) directly; the frontend harness is MOCK-based
// (it cannot exercise the real rollup/diff/version logic), so this resolver-level test is THE gate for
// the BFF surface. The precedent for a resolver reading ctx.db is `resolveShareLink`
// (`packages/graphql/src/schema.ts:343`). No resolver under test calls a domain service, so a trivial
// @movp/domain stub suffices (the deferred campaignAudience was the only graph.traverse consumer).
vi.mock('@movp/domain', () => ({ createDomain: () => ({}) }))

// Chainable stub for ctx.db: `.from(table)` returns a thenable whose await yields { data: rows },
// `.maybeSingle()` yields { data: rows[0] ?? null }, and `.rpc(name)` yields { data: rpc[name] }.
// Filter/range args are ignored — the per-table seed is what the resolver reads (real RLS/filter
// is covered by the e2e slice, Task 6).
type DbChain = {
  select: () => DbChain; eq: () => DbChain; order: () => DbChain; in: () => DbChain
  range: () => DbChain; limit: () => DbChain
  maybeSingle: () => Promise<{ data: unknown }>
  then: (resolve: (v: { data: unknown[] }) => unknown) => unknown
}
function makeDb(tables: Record<string, unknown[]>, rpc: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const chain: DbChain = {
        select: () => chain, eq: () => chain, order: () => chain, in: () => chain,
        range: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        then: (resolve) => resolve({ data: rows }),
      }
      return chain
    },
    rpc: async (name: string) => ({ data: rpc[name] ?? null }),
  }
}

describe('segmentation GraphQL surface', () => {
  it('previewMatchingCount parses the predicate and returns the capped RPC count', async () => {
    const db = makeDb({ segment: [{ id: 's1', workspace_id: 'w1' }] }, { preview_segment_predicate: 42 })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{\\"all\\":[]}") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { previewMatchingCount: { count: number } }).previewMatchingCount.count).toBe(42)
  })

  it('previewMatchingCount returns count 0 on unparseable predicate JSON', async () => {
    const db = makeDb({ segment: [{ id: 's1', workspace_id: 'w1' }] }, { preview_segment_predicate: 7 })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{not-json") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { previewMatchingCount: { count: number } }).previewMatchingCount.count).toBe(0)
  })

  it('segmentMembershipExplained returns matched rule version + evidence trail with NO raw properties', async () => {
    const db = makeDb({
      segment_membership: [{
        id: 'm1', segment_id: 's1', subject_type: 'user', subject_ref: 'user-9',
        matched_rule_id: 'r2', first_matched_at: '2026-07-01T00:00:00Z', evaluated_at: '2026-07-02T00:00:00Z',
        evidence: { event_ids: ['ev1'] },
      }],
      segment_rule: [{ id: 'r2', version: 2, description: 'v2' }],
      platform_event: [{ id: 'ev1', event_type: 'registration.completed', occurred_at: '2026-06-30T00:00:00Z',
                         subject_type: 'user', properties: { email: 'pii@example.com' } }],
    })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { segmentMembershipExplained(segmentId: "s1", subjectRef: "user-9") {
        subjectRef matchedRuleId matchedRuleVersion firstMatchedAt evaluatedAt
        evidence { eventId eventType occurredAt } } }`,
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const e = (res.data as { segmentMembershipExplained: {
      matchedRuleVersion: number; evidence: Array<{ eventId: string; eventType: string; occurredAt: string }>
    } }).segmentMembershipExplained
    expect(e.matchedRuleVersion).toBe(2)
    expect(e.evidence).toEqual([{ eventId: 'ev1', eventType: 'registration.completed', occurredAt: '2026-06-30T00:00:00Z' }])
    // PII discipline: the serialized response must NOT carry the raw properties payload.
    expect(JSON.stringify(res.data)).not.toContain('pii@example.com')
  })

  it('snapshotDiff computes added (B\\A) and removed (A\\B) subject sets + counts', async () => {
    // Stub returns the SAME rows for every .from('segment_snapshot_member'); the resolver must
    // distinguish A vs B by the snapshot_id it filters on — so we seed two calls via two tables?
    // Instead the resolver reads twice; keep the stub simple by returning the union and letting
    // the resolver's own filter split them — here we assert the resolver's set math on distinct seeds.
    type SnapChain = {
      select: () => SnapChain
      eq: (col: string, id: string) => SnapChain
      limit: (n: number) => SnapChain
      then: (resolve: (v: { data: unknown[] }) => unknown) => unknown
    }
    const db = {
      from: (_t: string): SnapChain => {
        const byCall: Record<string, unknown[]> = {
          A: [{ subject_ref: 'x' }, { subject_ref: 'y' }],
          B: [{ subject_ref: 'y' }, { subject_ref: 'z' }],
        }
        // The resolver calls `.eq('snapshot_id', id).limit(CAP)`; capture id to pick the set.
        let picked: unknown[] = []
        const chain: SnapChain = {
          select: () => chain,
          eq: (_c, id) => { picked = byCall[id] ?? []; return chain },
          limit: () => chain,
          then: (resolve) => resolve({ data: picked }),
        }
        return chain
      },
    }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { snapshotDiff(snapshotAId: "A", snapshotBId: "B") { added removed addedCount removedCount } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const d = (res.data as { snapshotDiff: { added: string[]; removed: string[]; addedCount: number; removedCount: number } }).snapshotDiff
    expect(d.added).toEqual(['z']); expect(d.removed).toEqual(['x'])
    expect(d.addedCount).toBe(1); expect(d.removedCount).toBe(1)
  })

  it('previewMatchingCount THROWS (never reports 0) when the preview RPC fails', async () => {
    // F6: a failed RPC must be distinguishable from "0 matched". The db only needs .rpc here.
    const db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{\\"all\\":[]}") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors?.[0]?.message).toContain('segment.read_failed')
  })

  it('createSegmentRuleVersion inserts a rule with segment_id set and version = current max + 1', async () => {
    // The generic createSegmentRule SKIPS the segment_id relation FK; this custom write sets it.
    let insertedSegmentId: string | null = null
    let insertedVersion: number | null = null
    const db = {
      from(table: string) {
        const api: any = {
          select: () => api, eq: () => api, order: () => api, limit: () => api,
          maybeSingle: async () => {
            if (table === 'segment') return { data: { id: 's1', workspace_id: 'w1' } }
            if (table === 'segment_rule') return { data: { version: 2 } }   // current max version
            return { data: null }
          },
          insert: (row: any) => {
            insertedSegmentId = row.segment_id; insertedVersion = row.version
            return { select: () => ({ maybeSingle: async () => ({ data: { id: 'r3', version: row.version } }) }) }
          },
        }
        return api
      },
    }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { createSegmentRuleVersion(segmentId: "s1", predicate: "{\\"all\\":[]}") { id version } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const r = (res.data as { createSegmentRuleVersion: { id: string; version: number } }).createSegmentRuleVersion
    expect(r.version).toBe(3)                 // max(2) + 1
    expect(insertedSegmentId).toBe('s1')      // the RELATION FK the generic create would have dropped
    expect(insertedVersion).toBe(3)
  })

  it('segmentSummaries / segmentMembers / segmentSnapshots enumerate a segment under RLS', async () => {
    const db = makeDb({
      segment: [{ id: 's1', workspace_id: 'w1', name: 'S', active: true, mode: 'dynamic', owner_ref: 'owner-1' }],
      // The stub returns the same rows for every .select() on a table, so this single row carries BOTH
      // the grouped-aggregate shape segmentSummaries reads (segment_id/member_count via SQL count()) AND
      // the raw columns segmentMembers reads — each of the three queries asserts only "no errors".
      segment_membership: [{ segment_id: 's1', member_count: 2, subject_ref: 'a', subject_type: 'user', matched_rule_id: 'r1', evaluated_at: '2026-07-02T00:00:00Z' }],
      segment_recompute_run: [{ segment_id: 's1', last_finished_at: '2026-07-02T00:00:00Z' }],
      segment_snapshot: [{ id: 'snap-1', taken_at: '2026-07-01T00:00:00Z', reason: 'on_demand', member_count: 2 }],
    })
    const summaries = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentSummaries(workspaceId: "w1") { id name memberCount lastRecomputedAt } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(summaries.errors).toBeUndefined()
    const members = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentMembers(segmentId: "s1", first: 50) { items { subjectRef } nextCursor } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(members.errors).toBeUndefined()
    const snaps = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentSnapshots(segmentId: "s1") { id memberCount reason } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(snaps.errors).toBeUndefined()
  })

  it('surfaces the CUSTOM reads + createSegmentRuleVersion + codegen generic CRUD; NO generic segment write, NO campaignAudience', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    for (const q of ['previewMatchingCount(', 'segmentMembershipExplained(', 'snapshotDiff(',
                     'segmentSummaries(', 'segmentMembers(', 'segmentSnapshots(', 'createSegmentRuleVersion(']) {
      expect(sdl).toContain(q)
    }
    expect(sdl).toMatch(/type Segment\b/)          // codegen generic surface (create + read) — NOT authored here
    expect(sdl).toMatch(/\bcreateSegment\(/)
    expect(sdl).toMatch(/\bsegments\(/)
    expect(sdl).toMatch(/\bsegment_memberships\(/)
    expect(sdl).not.toMatch(/\bupdateSegment\(/)   // builder is create-only; Part D adds no generic write
    expect(sdl).not.toMatch(/\bdeleteSegment\(/)
    expect(sdl).not.toContain('campaignAudience')  // deferred out of Part D (no edge producer/consumer yet)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run segmentation
```
Expected: FAIL — `Cannot query field "previewMatchingCount" on type "Query"` (the custom ops don't exist yet); every custom-op test fails and the SDL test fails (`previewMatchingCount`/`segmentMembershipExplained`/`snapshotDiff`/`segmentSummaries`/`segmentMembers`/`segmentSnapshots`/`createSegmentRuleVersion` absent from the printed schema).

- [ ] **Step 4: Implement — edit `schema.ts`**

Add the guarded block immediately after the campaign custom block (still inside `buildSchema`, before `return builder.toSchema()`). Reuse the file's existing `GraphQLContext` and helpers. **Gotcha (inline):** every dependency (`ctx.db`, `ctx.db.rpc`) is resolved at call time from the request context — never module scope — because on workerd there is no per-request module instance. **F6 (inline):** each read/write destructures `error` and throws a coded `segment.read_failed`/`segment.write_failed` (field name + code, no VALUES) — a failed read must never masquerade as an empty result.
```ts
  // ── Segmentation Part D — custom READ queries + the campaign audience seam ──
  // Codegen owns the generic segmentation create+read CRUD. These reads bridge the generic
  // surface's limits: jsonb serialises to "[object Object]", relation FKs are not queryable
  // scalars, and the generic list has no per-field filter (see plan "Inputs consumed").
  if (refs.has('segment_membership')) {
    const CAP = 500   // bounded arrays for diff/audience — full counts always returned

    // ── previewMatchingCount: bounded, injection-safe preview (Part C compiler via RPC) ──
    const previewCount = builder.objectRef<{ count: number }>('PreviewCount').implement({
      fields: (t: any) => ({ count: t.int({ complexity: 0, resolve: (r: { count: number }) => r.count }) }),
    })
    builder.queryField('previewMatchingCount', (t: any) =>
      t.field({
        type: previewCount, nullable: false, complexity: 20,
        args: { segmentId: t.arg.id({ required: true }), predicate: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<{ count: number }> => {
          // Resolve ctx.db at call time (workerd has no per-request module instance).
          let parsed: unknown
          try { parsed = JSON.parse(String(a.predicate)) } catch { return { count: 0 } }
          // ctx.db.rpc runs under the caller; preview_segment_predicate is DEFINER + member-gated
          // and reuses Part C's SAME injection-safe compiler — never a new SQL-building path.
          const { data, error } = await ctx.db.rpc('preview_segment_predicate', {
            seg_id: String(a.segmentId), predicate: parsed,
          })
          // F6: a failed RPC must NOT masquerade as "0 matched" — throw a coded error the client can see.
          if (error) throw new Error('segment.read_failed: field=previewMatchingCount code=preview_failed')
          const n = typeof data === 'number' ? data : Number(data ?? 0)
          return { count: Number.isFinite(n) ? n : 0 }
        },
      }),
    )

    // ── segmentMembershipExplained: the per-member explanation (PII-disciplined) ──
    const evidenceEvent = builder.objectRef<{ eventId: string; eventType: string | null; occurredAt: string | null }>('EvidenceEvent').implement({
      fields: (t: any) => ({
        eventId: t.exposeID('eventId', { complexity: 0 }),
        eventType: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.eventType }),
        occurredAt: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.occurredAt }),
      }),
    })
    type ExplainShape = {
      subjectRef: string; subjectType: string | null; matchedRuleId: string | null
      matchedRuleVersion: number | null; firstMatchedAt: string | null; evaluatedAt: string | null
      evidence: Array<{ eventId: string; eventType: string | null; occurredAt: string | null }>
    }
    const explanation = builder.objectRef<ExplainShape>('MembershipExplanation').implement({
      fields: (t: any) => ({
        subjectRef: t.exposeString('subjectRef', { complexity: 0 }),
        subjectType: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.subjectType }),
        matchedRuleId: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.matchedRuleId }),
        matchedRuleVersion: t.int({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.matchedRuleVersion }),
        firstMatchedAt: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.firstMatchedAt }),
        evaluatedAt: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.evaluatedAt }),
        evidence: t.field({ type: [evidenceEvent], complexity: 0, resolve: (r: ExplainShape) => r.evidence }),
      }),
    })
    builder.queryField('segmentMembershipExplained', (t: any) =>
      t.field({
        type: explanation, nullable: true, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }), subjectRef: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<ExplainShape | null> => {
          const { data: m, error: mErr } = await ctx.db
            .from('segment_membership')
            .select('id, segment_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence')
            .eq('segment_id', String(a.segmentId)).eq('subject_ref', String(a.subjectRef))
            .maybeSingle()
          if (mErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=membership')
          if (!m) return null
          const mem = m as { subject_type: string | null; matched_rule_id: string | null
            first_matched_at: string | null; evaluated_at: string | null; evidence: unknown }
          let version: number | null = null
          if (mem.matched_rule_id) {
            const { data: rule, error: rErr } = await ctx.db
              .from('segment_rule').select('id, version').eq('id', mem.matched_rule_id).maybeSingle()
            if (rErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=rule')
            if (rule) version = Number((rule as { version: number | string }).version)
          }
          // evidence jsonb → event_ids array (Part B's shape; reconcile the key if different).
          const ev = mem.evidence as { event_ids?: unknown } | null
          const eventIds = Array.isArray(ev?.event_ids) ? (ev!.event_ids as unknown[]).map(String) : []
          let evidence: ExplainShape['evidence'] = []
          if (eventIds.length > 0) {
            // PII BOUNDARY: select ONLY typed dimensions — never `properties`.
            const { data: evs, error: eErr } = await ctx.db
              .from('platform_event').select('id, event_type, occurred_at').in('id', eventIds)
            if (eErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=evidence')
            evidence = ((evs ?? []) as Array<{ id: string; event_type: string | null; occurred_at: string | null }>)
              .map((e) => ({ eventId: e.id, eventType: e.event_type, occurredAt: e.occurred_at }))
          }
          return {
            subjectRef: String(a.subjectRef), subjectType: mem.subject_type,
            matchedRuleId: mem.matched_rule_id, matchedRuleVersion: version,
            firstMatchedAt: mem.first_matched_at, evaluatedAt: mem.evaluated_at, evidence,
          }
        },
      }),
    )

    // ── snapshotDiff: added/removed subject_refs between two snapshots ──
    type DiffShape = { added: string[]; removed: string[]; addedCount: number; removedCount: number }
    const snapshotDiff = builder.objectRef<DiffShape>('SnapshotDiff').implement({
      fields: (t: any) => ({
        added: t.field({ type: ['String'], complexity: 0, resolve: (r: DiffShape) => r.added }),
        removed: t.field({ type: ['String'], complexity: 0, resolve: (r: DiffShape) => r.removed }),
        addedCount: t.int({ complexity: 0, resolve: (r: DiffShape) => r.addedCount }),
        removedCount: t.int({ complexity: 0, resolve: (r: DiffShape) => r.removedCount }),
      }),
    })
    builder.queryField('snapshotDiff', (t: any) =>
      t.field({
        type: snapshotDiff, nullable: false, complexity: 20,
        args: { snapshotAId: t.arg.id({ required: true }), snapshotBId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<DiffShape> => {
          const load = async (snapId: string): Promise<Set<string>> => {
            // A correct diff needs BOTH full member sets — you cannot compute a true added/removed COUNT
            // from capped sets. This on-demand read is bounded by the snapshot's frozen size (≤ the segment
            // size at snapshot time), not an unbounded hot-path scan, so we load the full subject_ref set for
            // counting and cap only the RETURNED arrays below (full counts + bounded arrays; contract holds).
            const { data, error } = await ctx.db
              .from('segment_snapshot_member').select('subject_ref').eq('snapshot_id', snapId)
            if (error) throw new Error('segment.read_failed: field=snapshotDiff code=snapshot_member')
            return new Set(((data ?? []) as Array<{ subject_ref: string }>).map((r) => r.subject_ref))
          }
          const [A, B] = [await load(String(a.snapshotAId)), await load(String(a.snapshotBId))]
          const added = [...B].filter((s) => !A.has(s))     // in B (after), not in A (before)
          const removed = [...A].filter((s) => !B.has(s))   // in A (before), not in B (after)
          return { added: added.slice(0, CAP), removed: removed.slice(0, CAP),
                   addedCount: added.length, removedCount: removed.length }
        },
      }),
    )

    // ── campaignAudience: DEFERRED (Phase 7) ──
    // The campaign→segment/snapshot audience seam is deferred out of Part D: nothing writes the
    // targets_segment / targets_snapshot edges yet, so there is no producer/consumer to resolve (YAGNI).
    // When a campaign-targeting WRITE lands, add the two rel conventions + a campaignAudience resolver
    // (frozen-snapshot-wins over dynamic-segment) via domain.graph.traverse + an e2e that writes an edge
    // and asserts the resolved audience. Do NOT author it here and do NOT touch Campaigns' linkSegment.

    // ── enumeration bridges (limits 2+3: no per-segment generic filter) ──
    type SummaryShape = { id: string; name: string | null; active: boolean | null; mode: string | null
      ownerRef: string | null; memberCount: number; lastRecomputedAt: string | null }
    const summary = builder.objectRef<SummaryShape>('SegmentSummary').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.name }),
        active: t.boolean({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.active }),
        mode: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.mode }),
        ownerRef: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.ownerRef }),
        memberCount: t.int({ complexity: 0, resolve: (r: SummaryShape) => r.memberCount }),
        lastRecomputedAt: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.lastRecomputedAt }),
      }),
    })
    builder.queryField('segmentSummaries', (t: any) =>
      t.field({
        type: [summary], nullable: false, complexity: 25,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<SummaryShape[]> => {
          const ws = String(a.workspaceId)
          const { data: segs, error: sErr } = await ctx.db
            .from('segment').select('id, name, active, mode, owner_ref').eq('workspace_id', ws).order('name', { ascending: true })
          if (sErr) throw new Error('segment.read_failed: field=segmentSummaries code=segment')
          const rows = (segs ?? []) as Array<{ id: string; name: string | null; active: boolean | null; mode: string | null; owner_ref: string | null }>
          // F7: push aggregation into SQL — never fold every membership/run row in JS. Member counts via
          // PostgREST count() grouped by segment_id; last recompute via max(finished_at) grouped likewise.
          // Reconcile: if PostgREST aggregates are disabled, replace each with a BOUNDED per-segment read
          // (`{ count: 'exact', head: true }` head request / an ordered `.limit(1)`) — bounded either way,
          // never the full-table JS fold this replaced.
          const { data: memRows, error: mErr } = await ctx.db
            .from('segment_membership').select('segment_id, member_count:count()').eq('workspace_id', ws)
          if (mErr) throw new Error('segment.read_failed: field=segmentSummaries code=membership')
          const counts = new Map<string, number>()
          for (const m of (memRows ?? []) as Array<{ segment_id: string; member_count: number | string }>) counts.set(m.segment_id, Number(m.member_count))
          const { data: runRows, error: rErr } = await ctx.db
            .from('segment_recompute_run').select('segment_id, last_finished_at:finished_at.max()').eq('workspace_id', ws)
          if (rErr) throw new Error('segment.read_failed: field=segmentSummaries code=run')
          const last = new Map<string, string>()
          for (const r of (runRows ?? []) as Array<{ segment_id: string; last_finished_at: string | null }>) {
            if (r.last_finished_at) last.set(r.segment_id, r.last_finished_at)
          }
          return rows.map((s) => ({ id: s.id, name: s.name, active: s.active, mode: s.mode, ownerRef: s.owner_ref,
            memberCount: counts.get(s.id) ?? 0, lastRecomputedAt: last.get(s.id) ?? null }))
        },
      }),
    )

    type MemberEntry = { subjectRef: string; subjectType: string | null; matchedRuleId: string | null; evaluatedAt: string | null }
    const memberEntry = builder.objectRef<MemberEntry>('SegmentMemberEntry').implement({
      fields: (t: any) => ({
        subjectRef: t.exposeString('subjectRef', { complexity: 0 }),
        subjectType: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.subjectType }),
        matchedRuleId: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.matchedRuleId }),
        evaluatedAt: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.evaluatedAt }),
      }),
    })
    const memberPage = builder.objectRef<{ items: MemberEntry[]; nextCursor: string | null }>('SegmentMemberPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [memberEntry], complexity: 0, resolve: (r: any) => r.items }),
        nextCursor: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.nextCursor }),
      }),
    })
    builder.queryField('segmentMembers', (t: any) =>
      t.field({
        type: memberPage, nullable: false, complexity: 20,
        args: { segmentId: t.arg.id({ required: true }), first: t.arg.int(), after: t.arg.string() },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          const limit = Math.min(Number(a.first ?? 50), 200)
          let q = ctx.db.from('segment_membership')
            .select('subject_ref, subject_type, matched_rule_id, evaluated_at')
            .eq('segment_id', String(a.segmentId)).order('subject_ref', { ascending: true })
          if (a.after) q = q.gt('subject_ref', String(a.after))   // keyset pagination on subject_ref
          const { data, error } = await q.limit(limit + 1)         // query bounded to limit+1 rows
          if (error) throw new Error('segment.read_failed: field=segmentMembers code=membership')
          const all = (data ?? []) as Array<{ subject_ref: string; subject_type: string | null; matched_rule_id: string | null; evaluated_at: string | null }>
          const items = all.slice(0, limit).map((m) => ({ subjectRef: m.subject_ref, subjectType: m.subject_type, matchedRuleId: m.matched_rule_id, evaluatedAt: m.evaluated_at }))
          const nextCursor = all.length > limit ? items[items.length - 1]?.subjectRef ?? null : null
          return { items, nextCursor }
        },
      }),
    )

    type SnapEntry = { id: string; takenAt: string | null; reason: string | null; memberCount: number | null }
    const snapEntry = builder.objectRef<SnapEntry>('SnapshotEntry').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        takenAt: t.string({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.takenAt }),
        reason: t.string({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.reason }),
        memberCount: t.int({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.memberCount }),
      }),
    })
    builder.queryField('segmentSnapshots', (t: any) =>
      t.field({
        type: [snapEntry], nullable: false, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<SnapEntry[]> => {
          const { data, error } = await ctx.db.from('segment_snapshot')
            .select('id, taken_at, reason, member_count').eq('segment_id', String(a.segmentId)).order('taken_at', { ascending: true })
          if (error) throw new Error('segment.read_failed: field=segmentSnapshots code=snapshot')
          return ((data ?? []) as Array<{ id: string; taken_at: string | null; reason: string | null; member_count: number | null }>)
            .map((s) => ({ id: s.id, takenAt: s.taken_at, reason: s.reason, memberCount: s.member_count }))
        },
      }),
    )

    // ── createSegmentRuleVersion: the ONE custom WRITE (the rule builder's Save) ──
    // The generic createSegmentRule input SKIPS the segment_id RELATION FK, so a rule can't be attached
    // to its segment through the generic surface. This inserts a segment_rule with segment_id set and
    // version = current max + 1, under the caller's RLS (ctx.db resolved at call time).
    type RuleVersionShape = { id: string; version: number }
    const ruleVersion = builder.objectRef<RuleVersionShape>('SegmentRuleVersion').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        version: t.int({ complexity: 0, resolve: (r: RuleVersionShape) => r.version }),
      }),
    })
    builder.mutationField('createSegmentRuleVersion', (t: any) =>
      t.field({
        type: ruleVersion, nullable: true, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }), predicate: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<RuleVersionShape | null> => {
          let predicate: unknown
          try { predicate = JSON.parse(String(a.predicate)) } catch { throw new Error('segment.write_failed: field=createSegmentRuleVersion code=invalid_predicate_json') }
          const { data: seg, error: segErr } = await ctx.db
            .from('segment').select('id, workspace_id').eq('id', String(a.segmentId)).maybeSingle()
          if (segErr) throw new Error('segment.write_failed: field=createSegmentRuleVersion code=segment_lookup')
          if (!seg) return null   // RLS-invisible or absent segment → caller cannot write here
          const ws = (seg as { workspace_id: string }).workspace_id
          const { data: top, error: verErr } = await ctx.db
            .from('segment_rule').select('version').eq('segment_id', String(a.segmentId))
            .order('version', { ascending: false }).limit(1).maybeSingle()
          if (verErr) throw new Error('segment.write_failed: field=createSegmentRuleVersion code=version_lookup')
          const nextVersion = (top ? Number((top as { version: number | string }).version) : 0) + 1
          const { data: created, error: insErr } = await ctx.db
            .from('segment_rule')
            .insert({ workspace_id: ws, segment_id: String(a.segmentId), predicate, version: nextVersion, active: true })
            .select('id, version').maybeSingle()
          if (insErr || !created) throw new Error('segment.write_failed: field=createSegmentRuleVersion code=insert')
          const row = created as { id: string; version: number | string }
          return { id: row.id, version: Number(row.version) }
        },
      }),
    )
  }
```
> **Reconciliation note (read before typing).** (1) The `segmentMembers` keyset pagination uses `.gt('subject_ref', after)` — if the committed `ctx.db` client lacks `.gt`, use `.range(offset, offset+limit)` with a numeric cursor. (2) `segmentSummaries` uses PostgREST aggregate selects (`member_count:count()`, `last_finished_at:finished_at.max()`) grouped by `segment_id`; if the deployment disables aggregate functions, replace each with a BOUNDED per-segment read (`{ count: 'exact', head: true }` head request / an ordered `.limit(1)`) — never restore the full-table JS fold. (3) `createSegmentRuleVersion` reads the current max `version` then inserts `version = max + 1`; if Parts A/B/C ship a DB-side version-assign trigger, drop the read and let the trigger assign it (keep the `segment_id` FK set — that is the whole point). (4) `evidence.event_ids` is Part B's assumed key — reconcile if Part B named it differently, but NEVER select `properties`. (5) `snapshotDiff` and the subject reads are `.limit(CAP)`-bounded (CAP = 500), so the diff/audience is exact up to CAP members and a bounded sample beyond — surface that bound in the UI rather than implying an exact count.

- [ ] **Step 5: Run the test + typecheck + the existing schema gate**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `segmentation.test.ts` (8 tests: previewMatchingCount ok/parse-fail/rpc-fail, membership-explained PII-disciplined, snapshotDiff set math, createSegmentRuleVersion version-increment, enumeration bridges, SDL surface) AND the existing `schema.test.ts`/`campaign.test.ts`/task/collab tests still green; `tsc --noEmit` clean.

- [ ] **Step 6 (OPTIONAL): custom MCP tool + CLI command**

Generic `segment.create/get/list` MCP tools and `movp segment create/list` CLI commands come FREE from codegen — do NOT re-add them. Optionally expose the one bounded preview read:
- MCP (`packages/mcp/src/server.ts`, after the generated-tool loop; the mocked domain in the test needs no new stub since preview goes through the RPC — mock the db/rpc instead, or scope this to the frontend only):
```ts
  server.registerTool(
    'segment.preview_matching_count',
    { title: 'Preview matching count', description: 'Bounded, read-only audience-size preview for a draft predicate',
      inputSchema: { segmentId: z.string(), predicate: z.string() } },
    async ({ segmentId, predicate }) => text(await previewMatchingCountViaRpc(segmentId, predicate)),
  )
```
> Gotcha: MCP/CLI resolve the db/rpc from their own request context, not a domain method — if wiring the RPC there is more than a few lines, SKIP the optional step (the GraphQL surface + frontend are the primary deliverable) and state so in the commit. If skipped, do not add `packages/mcp`/`packages/cli` to the commit.
Gate (only if implemented): `pnpm --filter @movp/mcp exec vitest run && pnpm --filter @movp/cli exec vitest run`.

- [ ] **Step 7: Commit**
```bash
git add packages/graphql/src/schema.ts packages/graphql/test/segmentation.test.ts
# add supabase/migrations/20260702000001_segment_preview_predicate.sql only if PREVIEW_RPC_ABSENT
# add packages/mcp packages/cli only if Step 6 was implemented
git commit -m "feat(graphql): segmentation custom reads (preview/explain/diff/enumerate) + createSegmentRuleVersion write"
```

---

### Task 2: Frontend — segment list + rule builder (preview count)

Add the segment list (SSR) and the rule builder (a `client:load` island: typed-DSL editor with a live `previewMatchingCount` BEFORE saving a new rule version). The **list page** mirrors `src/pages/index.astro`: SSR frontmatter reads the session token, renders `AuthFailure` when absent, else `readServerEnv()` + `gqlRequest({ endpoint, token }, QUERY, vars)`, branches on the `GqlResult` union (`!r.ok` → `ErrorRetry`, else `r.data`), `EmptyState` when empty. The **rule builder's** browser interactions (Preview, Save) **cannot POST GraphQL from the browser** — the GraphQL endpoint is server-only via the `cloudflare:workers` env, the session token is an httpOnly `sb-access-token` cookie, and the mock sends no CORS — so the island fetches same-origin JSON routes `/api/segments/preview` (POST) and `/api/segments/save-rule` (POST), each of which does the server-side `gqlRequest` under the cookie token, exactly like the committed `SearchBox.tsx` → `/api/search`. No privileged imports anywhere under `templates/`.

**Files:**
- Create: `templates/frontend-astro/src/lib/segment-queries.ts`
- Create: `templates/frontend-astro/src/pages/segments/index.astro`, `templates/frontend-astro/src/pages/segments/[id]/rules.astro`
- Create: `templates/frontend-astro/src/components/segments/RuleBuilder.tsx` (island: DSL editor + Preview + Save)
- Create: `templates/frontend-astro/src/pages/api/segments/preview.ts`, `templates/frontend-astro/src/pages/api/segments/save-rule.ts` (server routes — mirror `src/pages/api/search.ts`)
- Edit: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (add scenario-keyed segment responses)
- Test: create `templates/frontend-astro/tests/e2e/segments.spec.ts` (created here; grown in Tasks 3–4)

**Interfaces consumed (all already in the template):** `gqlRequest<T>({ endpoint, token }, QUERY, variables): Promise<GqlResult<T>>` — **3 positional args** (opts, query, variables); the result is `{ ok: true; data: T } | { ok: false; code }`, so routes branch on `r.ok` (`src/lib/graphql.ts`); `getSessionToken(cookies)` (`src/lib/session.ts`); `readServerEnv() -> { graphqlEndpoint, workspaceId }` (`src/lib/env.ts`); `Base.astro`; `src/components/states/{AuthFailure,LoadingState,EmptyState,ErrorRetry}.astro`; the `APIRoute` server-endpoint pattern in `src/pages/api/search.ts` (reads `cookies`, calls `gqlRequest`, returns `Response.json`). GraphQL ops: custom `segmentSummaries(workspaceId)` (list, SSR); generic `segment(id)` (get — SSR rule-builder header); custom `previewMatchingCount(segmentId, predicate)` (via `/api/segments/preview`); custom `createSegmentRuleVersion(segmentId, predicate)` (via `/api/segments/save-rule`). **The islands import ONLY `src/lib/*` (query docs, types) — never `@movp/*` or a server route's internals; the `/api/*` routes may import `src/lib/*` but not `@movp/{auth,domain}`/service-role (boundary gate).**

- [ ] **Step 1: GraphQL documents** — `src/lib/segment-queries.ts`:
```ts
// Custom list read (Task 1): per-segment member counts + last recompute (generic list can't filter/aggregate).
export const SEGMENT_SUMMARIES_QUERY = /* GraphQL */ `
  query SegmentSummaries($workspaceId: ID!) {
    segmentSummaries(workspaceId: $workspaceId) {
      id name active mode ownerRef memberCount lastRecomputedAt
    }
  }`
// Generic get (codegen surface): scalar fields exposed as String — for the rule-builder header.
export const SEGMENT_GET_QUERY = /* GraphQL */ `
  query Segment($id: ID!) { segment(id: $id) { id name active mode } }`
// Bounded, injection-safe preview (Task 1): audience size for a DRAFT predicate before saving.
export const PREVIEW_MATCHING_COUNT_QUERY = /* GraphQL */ `
  query PreviewMatchingCount($segmentId: ID!, $predicate: String!) {
    previewMatchingCount(segmentId: $segmentId, predicate: $predicate) { count }
  }`
// Saving a new rule version: the segment relation (segment_id) is a RELATION the generic
// createSegmentRule input SKIPS, so Part D authors the custom createSegmentRuleVersion mutation
// (Task 1). The rule builder's Save posts THIS via /api/segments/save-rule (server-side gqlRequest).
export const CREATE_SEGMENT_RULE_VERSION_MUTATION = /* GraphQL */ `
  mutation CreateSegmentRuleVersion($segmentId: ID!, $predicate: String!) {
    createSegmentRuleVersion(segmentId: $segmentId, predicate: $predicate) { id version }
  }`
```

- [ ] **Step 2: Extend the mock harness + write the failing Playwright/axe test** — the frontend test harness is **MOCK-based**: `playwright.config.ts` has `testDir: './tests/e2e'` and a `webServer` running `node tests/mock/graphql-mock.mjs`; specs drive scenarios with `fetch('/scenario?name=ok|empty|error')` then assert the rendered DOM (see `tests/e2e/frontend.spec.ts`). There is **NO** service-role REST/SQL seed helper under `templates/` — any `service_role`/`SERVICE_ROLE_KEY` reference there fails `scripts/check-boundary.sh` (which greps `*.mjs` too). Do NOT seed a database.
  - **Extend `templates/frontend-astro/tests/mock/graphql-mock.mjs`** to answer the segment operations with **scenario-keyed** canned data, mirroring how it already serves `query Notes`/`query Note` (branch on `query.includes('query SegmentSummaries')`, `'query Segment'`, `'query PreviewMatchingCount'`, `'CreateSegmentRuleVersion'`, and — for Tasks 3–4 — `'query SegmentMembers'`/`'query MembershipExplanation'`/`'query SegmentSnapshots'`/`'query SnapshotDiff'`). The mock branches by GraphQL-doc substring regardless of caller, so it answers identically whether the request comes from a page's SSR frontmatter OR from an `/api/segments/*` route's server-side `gqlRequest`. For `ok`: one summary (id `seg-1`, name `Registered-not-onboarded`, `memberCount: 3`, `mode: 'dynamic'`, `active: true`, `ownerRef: 'owner-1'`, a dated `lastRecomputedAt`); `previewMatchingCount` returns `{ count: 12 }`; `createSegmentRuleVersion` returns `{ id: 'rule-2', version: 2 }`. For `empty`: empty `segmentSummaries`. `error` is already handled globally (the mock returns `{errors:[…]}` when `scenario==='error'`).
  - **Create the spec at `templates/frontend-astro/tests/e2e/segments.spec.ts`** (INSIDE `testDir`) mirroring `tests/e2e/frontend.spec.ts` — same `beforeEach` that sets scenario `ok` + the httpOnly `sb-access-token` cookie; use `page.waitForResponse('**/api/segments/preview')` for the browser→route round-trip (as `frontend.spec.ts` does for `/api/search`). Cases:
    - `/segments` with no cookie → the AuthFailure view.
    - `/segments` (`ok`) → lists the segment (name visible, member count `3`, mode `dynamic`). `empty` → the EmptyState.
    - `/segments/seg-1/rules` (`ok`) → the `<RuleBuilder client:load/>` island renders the DSL editor controls (all/any/not + an event/attribute row); clicking **Preview** issues a POST to `/api/segments/preview` and shows the count `12`; clicking **Save** issues a POST to `/api/segments/save-rule` and shows a "saved v2" confirmation.
    - axe smoke over `/segments` and `/segments/seg-1/rules` (no serious/critical violations).
  > The mock cannot exercise `previewMatchingCount`'s real injection-safe compiler — that safety is proven by the **DEFINER RPC + resolver test** (Task 1) and the **e2e slice** (Task 6). The browser NEVER sees the GraphQL doc (it POSTs JSON to `/api/segments/*`; the server does the `gqlRequest`), so this spec asserts the rendered shape + that exactly one `/api/segments/preview` POST fires per Preview click.
Run: `pnpm --filter @movp/frontend-astro exec playwright test segments` → Expected: FAIL (routes 404 — `/segments` pages + `/api/segments/*` routes not created yet).

- [ ] **Step 3: Implement the server routes, the island, and the pages**
  - **The two `/api/segments/*` routes** (server-side `gqlRequest` under the cookie token — mirror `src/pages/api/search.ts` exactly; import depth is `../../../lib/` from `src/pages/api/segments/`). NO `@movp/*` import:
```ts
// src/pages/api/segments/preview.ts
import type { APIRoute } from 'astro'
import { readServerEnv } from '../../../lib/env.ts'
import { getSessionToken } from '../../../lib/session.ts'
import { gqlRequest } from '../../../lib/graphql.ts'
import { PREVIEW_MATCHING_COUNT_QUERY } from '../../../lib/segment-queries.ts'

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = getSessionToken(cookies)
  if (!token) return Response.json({ code: 'auth_error' }, { status: 401 })
  const { segmentId, predicate } = (await request.json().catch(() => ({}))) as { segmentId?: string; predicate?: string }
  if (!segmentId || typeof predicate !== 'string') return Response.json({ code: 'bad_request' }, { status: 400 })
  const { graphqlEndpoint } = readServerEnv()   // readServerEnv, NOT process.env (workerd)
  const r = await gqlRequest<{ previewMatchingCount: { count: number } }>(
    { endpoint: graphqlEndpoint, token }, PREVIEW_MATCHING_COUNT_QUERY, { segmentId, predicate },
  )
  if (!r.ok) return Response.json({ code: r.code }, { status: r.code === 'auth_error' ? 401 : 502 })
  return Response.json({ count: r.data.previewMatchingCount.count }, { status: 200 })
}
```
```ts
// src/pages/api/segments/save-rule.ts
import type { APIRoute } from 'astro'
import { readServerEnv } from '../../../lib/env.ts'
import { getSessionToken } from '../../../lib/session.ts'
import { gqlRequest } from '../../../lib/graphql.ts'
import { CREATE_SEGMENT_RULE_VERSION_MUTATION } from '../../../lib/segment-queries.ts'

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = getSessionToken(cookies)
  if (!token) return Response.json({ code: 'auth_error' }, { status: 401 })
  const { segmentId, predicate } = (await request.json().catch(() => ({}))) as { segmentId?: string; predicate?: string }
  if (!segmentId || typeof predicate !== 'string') return Response.json({ code: 'bad_request' }, { status: 400 })
  const { graphqlEndpoint } = readServerEnv()
  const r = await gqlRequest<{ createSegmentRuleVersion: { id: string; version: number } | null }>(
    { endpoint: graphqlEndpoint, token }, CREATE_SEGMENT_RULE_VERSION_MUTATION, { segmentId, predicate },
  )
  if (!r.ok) return Response.json({ code: r.code }, { status: r.code === 'auth_error' ? 401 : 502 })
  return Response.json({ rule: r.data.createSegmentRuleVersion }, { status: 200 })
}
```
  - **The island** `src/components/segments/RuleBuilder.tsx` (mirror `SearchBox.tsx`; imports ONLY React + `src/lib/*` types — never `@movp/*`, never a route file). Preview/Save each fire ONE POST on click (no keystroke auto-fire):
```tsx
import { useState } from 'react'

type Group = 'all' | 'any' | 'not'
type View =
  | { kind: 'idle' } | { kind: 'loading' }
  | { kind: 'previewed'; count: number } | { kind: 'saved'; version: number }
  | { kind: 'error'; code: string }

export default function RuleBuilder({ segmentId }: { segmentId: string }) {
  const [group, setGroup] = useState<Group>('all')
  const [value, setValue] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })
  const predicate = () => JSON.stringify({ [group]: value ? [{ event: value }] : [] })

  async function post(path: string): Promise<Response | null> {
    try {
      return await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segmentId, predicate: predicate() }),
      })
    } catch { setView({ kind: 'error', code: 'network_error' }); return null }
  }
  async function preview() {
    setView({ kind: 'loading' })
    const res = await post('/api/segments/preview'); if (!res) return
    if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
    if (!res.ok) return setView({ kind: 'error', code: 'preview_failed' })
    const body = (await res.json()) as { count: number }
    setView({ kind: 'previewed', count: body.count })
  }
  async function save() {
    setView({ kind: 'loading' })
    const res = await post('/api/segments/save-rule'); if (!res) return
    if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
    if (!res.ok) return setView({ kind: 'error', code: 'save_failed' })
    const body = (await res.json()) as { rule: { version: number } | null }
    setView(body.rule ? { kind: 'saved', version: body.rule.version } : { kind: 'error', code: 'save_failed' })
  }

  return (
    <div>
      <fieldset>
        <legend>Match</legend>
        {(['all', 'any', 'not'] as Group[]).map((g) => (
          <label key={g}><input type="radio" name="group" checked={group === g} onChange={() => setGroup(g)} /> {g}</label>
        ))}
        <label htmlFor="cond">Event</label>
        <input id="cond" value={value} onChange={(e) => setValue(e.target.value)} />
      </fieldset>
      <button type="button" onClick={() => void preview()}>Preview</button>
      <button type="button" onClick={() => void save()}>Save</button>
      {view.kind === 'loading' && <p data-testid="rule-loading" role="status" aria-live="polite">Working…</p>}
      {view.kind === 'previewed' && <p data-testid="rule-preview">~{view.count} subjects match</p>}
      {view.kind === 'saved' && <p data-testid="rule-saved" role="status">Saved v{view.version}</p>}
      {view.kind === 'error' && <p data-testid="rule-error" role="alert">Failed ({view.code}).</p>}
    </div>
  )
}
```
  - **The pages** (SSR frontmatter; reconcile the exact `Base.astro`/`states/*` import paths against `src/pages/index.astro`):
    - `src/pages/segments/index.astro` → SSR `SEGMENT_SUMMARIES_QUERY` (token→`AuthFailure` when absent; `!r.ok`→`ErrorRetry`); render a table of segments (name, member count, owner, active/mode badge, last recompute). `EmptyState` when empty; each row links to `/segments/{id}/members` and `/segments/{id}/rules`. Keyboard-focusable rows; `active`/`mode` as text badges (not colour-only) for a11y.
    - `src/pages/segments/[id]/rules.astro` → SSR `SEGMENT_GET_QUERY` (id from `Astro.params.id`) for the header, then mount `<RuleBuilder client:load segmentId={id} />`. `AuthFailure` when no token; `ErrorRetry` on `!r.ok`. The island owns Preview/Save; the page issues no browser GraphQL.
Run: `pnpm --filter @movp/frontend-astro exec playwright test segments` → Expected: PASS (list + rule-builder preview `~12 subjects match` + save `Saved v2` + axe).

- [ ] **Step 4: Boundary gate**
Run: `bash scripts/check-boundary.sh`
Expected: clean (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`).

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/segment-queries.ts templates/frontend-astro/src/pages/segments/index.astro templates/frontend-astro/src/pages/segments/\[id\]/rules.astro templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/segments.spec.ts
git commit -m "feat(frontend): segment list + rule builder (typed DSL + preview matching count)"
```

---

### Task 3: Frontend — membership explorer + snapshot history

Add the membership explorer (paginated members + a per-member explanation panel showing the matched rule version and the evidence event trail — ids/typed values, NEVER raw PII) and the snapshot history (snapshots over time as a member-count trend + `snapshotDiff` between two). Both use the enumeration bridges (`segmentMembers`, `segmentSnapshots`) + the detail reads (`segmentMembershipExplained`, `snapshotDiff`).

**Files:**
- Create: `templates/frontend-astro/src/pages/segments/[id]/members.astro`, `templates/frontend-astro/src/pages/segments/[id]/snapshots.astro`
- Edit: `templates/frontend-astro/src/lib/segment-queries.ts` (add the members/explanation/snapshots/diff docs)
- Edit: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (scenario-keyed `SegmentMembers`/`MembershipExplanation`/`SegmentSnapshots`/`SnapshotDiff`)
- Test: extend `templates/frontend-astro/tests/e2e/segments.spec.ts`

- [ ] **Step 1: Add GraphQL documents** to `src/lib/segment-queries.ts`:
```ts
// Paginated members for ONE segment (bridge — generic list has no segment filter).
export const SEGMENT_MEMBERS_QUERY = /* GraphQL */ `
  query SegmentMembers($segmentId: ID!, $first: Int, $after: String) {
    segmentMembers(segmentId: $segmentId, first: $first, after: $after) {
      items { subjectRef subjectType matchedRuleId evaluatedAt }
      nextCursor
    }
  }`
// Per-member explanation: matched rule version + evidence event trail (ids + typed dimensions ONLY).
export const MEMBERSHIP_EXPLANATION_QUERY = /* GraphQL */ `
  query MembershipExplanation($segmentId: ID!, $subjectRef: String!) {
    segmentMembershipExplained(segmentId: $segmentId, subjectRef: $subjectRef) {
      subjectRef matchedRuleId matchedRuleVersion firstMatchedAt evaluatedAt
      evidence { eventId eventType occurredAt }
    }
  }`
// Snapshots over time (member-count trend) for the history view.
export const SEGMENT_SNAPSHOTS_QUERY = /* GraphQL */ `
  query SegmentSnapshots($segmentId: ID!) {
    segmentSnapshots(segmentId: $segmentId) { id takenAt reason memberCount }
  }`
// Diff between two snapshots (added / removed subject refs + counts).
export const SNAPSHOT_DIFF_QUERY = /* GraphQL */ `
  query SnapshotDiff($snapshotAId: ID!, $snapshotBId: ID!) {
    snapshotDiff(snapshotAId: $snapshotAId, snapshotBId: $snapshotBId) {
      added removed addedCount removedCount
    }
  }`
```

- [ ] **Step 2: Failing test** — extend `tests/e2e/segments.spec.ts` and the mock: the `ok` scenario returns for `SegmentMembers` two members (`user-9`, `user-8`) with `nextCursor: null`; for `MembershipExplanation` (`subjectRef: 'user-9'`) `matchedRuleVersion: 2` and one evidence event `{ eventId: 'ev1', eventType: 'registration.completed', occurredAt: <date> }` — **and the mock's canned evidence object carries NO `properties` field** (proving the surface never exposes it); for `SegmentSnapshots` two snapshots (`member_count` 2 then 3, dated) ; for `SnapshotDiff` `{ added: ['user-8'], removed: [], addedCount: 1, removedCount: 0 }`. Cases:
    - `/segments/seg-1/members` (`ok`) → lists the two members; clicking `user-9` opens the explanation panel showing "matched rule v2" and the evidence event `registration.completed` (id/date). Assert the DOM contains **no** email-shaped string (PII discipline): `expect(await page.content()).not.toMatch(/@example\.com/)`.
    - `/segments/seg-1/snapshots` (`ok`) → renders the two snapshots as a member-count trend (`2` then `3`); selecting the two and clicking **Diff** shows `+1 added` (`user-8`) / `0 removed`.
    - `empty` → EmptyState on both routes.
    - axe smoke over both routes.
Run: `pnpm --filter @movp/frontend-astro exec playwright test segments` → Expected: FAIL (routes 404).

- [ ] **Step 3: Implement**
  - `src/pages/segments/[id]/members.astro` → `SEGMENT_MEMBERS_QUERY` (id from params, `first: 50`); render a paginated list (subjectRef + matchedRuleId + evaluatedAt) with a "Load more" using `nextCursor`. Each member row is a keyboard-focusable button that fetches `MEMBERSHIP_EXPLANATION_QUERY` (via a small client fetch to the same GraphQL endpoint OR an on-navigate query param) and renders the panel: **matched rule version** + an **evidence trail** table (event id + event type + occurred-at). The evidence renders ids/typed values ONLY — the query never selects `properties`, so there is nothing to leak. `EmptyState` when there are no members.
  - `src/pages/segments/[id]/snapshots.astro` → `SEGMENT_SNAPSHOTS_QUERY`; render snapshots as a member-count trend (a small bar/sparkline or an ordered list with counts — text labels for a11y). Two `<select>`s (snapshot A / snapshot B) + a **Diff** button that posts `SNAPSHOT_DIFF_QUERY` and renders added/removed counts + the (capped) subject lists. `EmptyState` when there are no snapshots.
Run: `pnpm --filter @movp/frontend-astro exec playwright test segments` → Expected: PASS.

- [ ] **Step 4: Boundary gate** — `bash scripts/check-boundary.sh` → clean.

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/segment-queries.ts templates/frontend-astro/src/pages/segments/\[id\]/members.astro templates/frontend-astro/src/pages/segments/\[id\]/snapshots.astro templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/segments.spec.ts
git commit -m "feat(frontend): membership explorer (evidence, PII-disciplined) + snapshot history (diff)"
```

---

### Task 4: Playwright/axe (mock-driven) + boundary + build gate

Consolidate the accessibility + performance + boundary gates across all four routes. Add the axe smoke over every route (if not already asserted per-task), a **network assertion** pinning `previewMatchingCount` to exactly ONE request per Preview click (bounds server work), and the final boundary + Astro build gates.

**Files:**
- Edit: `templates/frontend-astro/tests/e2e/segments.spec.ts` (axe over all four + the preview network assertion)

- [ ] **Step 1: Add the axe + network assertions** — extend `tests/e2e/segments.spec.ts`:
  - axe smoke (no serious/critical) over `/segments`, `/segments/seg-1/rules`, `/segments/seg-1/members`, `/segments/seg-1/snapshots` (add any route not already covered in Tasks 2–3).
  - **Preview single-request assertion (performance gate):** count GraphQL POSTs whose body includes `query PreviewMatchingCount`; assert exactly ONE per Preview click (no auto-fire on keystroke, no double-submit):
```ts
  let previewReqs = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && (r.postData() ?? '').includes('query PreviewMatchingCount')) previewReqs++
  })
  await page.goto('/segments/seg-1/rules')
  await page.getByRole('button', { name: /preview/i }).click()
  await expect(page.getByText(/12/)).toBeVisible()
  expect(previewReqs).toBe(1)
```
Run: `pnpm --filter @movp/frontend-astro exec playwright test segments` → Expected: PASS (all four routes render + axe clean + exactly one preview request).

- [ ] **Step 2: Boundary + build gate**
Run:
```bash
bash scripts/check-boundary.sh && pnpm --filter @movp/frontend-astro build
```
Expected: boundary grep clean; Astro build succeeds (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`).

- [ ] **Step 3: Commit**
```bash
git add templates/frontend-astro/tests/e2e/segments.spec.ts
git commit -m "test(frontend): segmentation axe smoke + preview single-request + boundary/build gate"
```

---

### Task 5: BI/ML metadata verification (pgTAP)

Prove the segmentation phase is the suite's **primary BI/ML consumer**: `platform_event` is the fact stream with conformed dimensions, membership is a subject × segment × time fact, and the registry (`public.movp_fields`) reports the roles. This is a **test only** — no migration. It seeds events/runs/snapshots/memberships and asserts the reporting roles + a fact-stream rollup + a membership-over-time shape.

**Files:**
- Create: `supabase/tests/segmentation_bi_test.sql`

- [ ] **Step 1: Write the failing pgTAP**

`supabase/tests/segmentation_bi_test.sql` (runs as the table owner — RLS bypassed):
```sql
begin;
select plan(10);

-- ── seed (as table owner) ────────────────────────────────────────────────────
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
  values ('dddddddd-0000-0000-0000-0000000000r1', 'dddddddd-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-0000000000a1', '{"all":[{"event":"registration.completed"}]}'::jsonb, 1, true);
insert into public.segment_recompute_run
  (workspace_id, segment_id, mode, started_at, finished_at, added_count, removed_count, evaluated_count, idempotency_key, outcome_code)
  values ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'full',
          now() - interval '1 minute', now(), 2, 0, 2, 'seed-key-1', 'ok');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count)
  values ('dddddddd-0000-0000-0000-0000000000s1', 'dddddddd-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-0000000000a1', now(), 'on_demand', 2);
insert into public.segment_membership
  (workspace_id, segment_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'user', 'user-1',
   'dddddddd-0000-0000-0000-0000000000r1', now() - interval '2 day', now() - interval '2 day', '{"event_ids":[]}'::jsonb),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'user', 'user-2',
   'dddddddd-0000-0000-0000-0000000000r1', now() - interval '1 day', now() - interval '1 day', '{"event_ids":[]}'::jsonb);

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
-- Field NAMES are the snake_case codegen columns. If Parts A/B/C registered camelCase
-- keys (e.g. 'occurredAt'), reconcile these `name=` literals.
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
```

- [ ] **Step 2: Run to verify — it PASSES against the merged Parts A/B/C**

Run:
```bash
supabase db reset && supabase test db
```
Expected: `segmentation_bi_test.sql .. ok` (10 assertions). This test is red-by-construction ONLY if Parts A/B/C are missing/misnamed (a column/role mismatch fails a specific assertion) — that is the reconciliation signal. If the seed itself errors, a column name is wrong (see "Inputs consumed") — fix the literal to match Part A's column, do NOT change the schema. Every other test file still `ok`.

> TDD note: this task has no product code to make green (Part D authors no collection migration). Its "red" state is a genuine assertion failure surfacing a Part A/B/C naming/role mismatch; its "green" state confirms the BI/ML metadata. Treat a failure as a reconciliation task against Parts A/B/C, not as a Part D code change.

- [ ] **Step 3: Commit**
```bash
git add supabase/tests/segmentation_bi_test.sql
git commit -m "test(db): segmentation BI/ML metadata verification (fact rollup + membership-over-time + movp_fields roles)"
```

---

### Task 6: End-to-end `[segmentation]` slice

Append a `[segmentation]` section to `scripts/slice-e2e.sh` implementing the roadmap verification. Base rows (`segment`, `segment_rule`, ingest keys) are created via `psql` so required FK columns (`segment_id`), the predicate jsonb, and key hashes are set deterministically — the committed generic `create<Pascal>` mutation SKIPS relation fields and emits no update mutation. The behaviours under test (recompute, snapshot, RLS reads, redaction) go through the real RPC/GraphQL/REST surfaces.

**Files:**
- Modify: `scripts/slice-e2e.sh` (insert the `[segmentation]` section immediately BEFORE the `echo "== [8] internal not exposed via PostgREST API =="` line)

**Interfaces consumed (committed slice helpers/vars — use EXACTLY these names):** `post_graphql` (owner's global `$TOKEN`); `post_graphql_as` (token-scoped — defined by the `[collab]` block above; reuse, do NOT redefine); `json_get`; `psql "$DB_URL"`; `$API_URL`, `$ANON_KEY`, `$SERVICE_ROLE_KEY`; `$WS` (workspace id — NOT `$WS_ID`), `$USER_ID` (owner), `$USER2_ID` (member), `$TOKEN2` (member JWT). Also: `public.emit_event`, the bridge, `public.recompute_segment`/`public.take_segment_snapshot`, `movp_internal.movp_events`, `movp_internal.ingest_key`, the ingest Edge Function.

- [ ] **Step 1: Add the `[segmentation]` section** to `scripts/slice-e2e.sh`:
```bash
echo "== [segmentation] (a) internal bridge: emit registration.completed -> platform_event (source internal) =="
SUBJ="$USER_ID"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "select public.emit_event('$WS','registration.completed', jsonb_build_object('subject_type','user','subject_ref','$SUBJ','email','pii@example.com'));"
BRIDGED="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and event_type='registration.completed' and source='internal' and subject_ref='$SUBJ';" | tr -d '[:space:]')"
[ "${BRIDGED:-0}" -ge 1 ] || { echo "internal bridge did not land a platform_event (got $BRIDGED)"; exit 1; }
# a non-bridged type produces no platform_event row
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('$WS','some.unbridged.type', jsonb_build_object('subject_ref','$SUBJ'));"
UNBRIDGED="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and event_type='some.unbridged.type';" | tr -d '[:space:]')"
[ "${UNBRIDGED:-1}" -eq 0 ] || { echo "a non-allow-listed type leaked into platform_event (got $UNBRIDGED)"; exit 1; }

echo "== [segmentation] (b) external ingest: a WS-A key writes A only; a WS-B write is rejected =="
WS_B="$(psql "$DB_URL" -tAc "insert into public.workspace (id, name) values (gen_random_uuid(), 'SegWsB') returning id;" | tr -d '[:space:]')"
[ -n "$WS_B" ] || { echo "failed to create WS_B"; exit 1; }
INGEST_KEY="e2e-ingest-secret-$$"
# Register the key for WS-A ($WS). RECONCILE the hash expr + column names against Part B's ingest_key.
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into movp_internal.ingest_key (workspace_id, key_hash, active) values ('$WS', encode(digest('$INGEST_KEY','sha256'),'hex'), true) on conflict do nothing;"
# Drive Part B's committed API-key ingestion RPC directly via psql — SELF-CONTAINED (the base slice
# serves only graphql/mcp/index-embeddings, not ingest; the edge fn is the production surface, unit-
# tested in Part B). The RPC resolves the workspace from the KEY HASH, so the forged events[].workspace_id
# (WS_B) is IGNORED — this is the exact tenancy boundary under test. Dollar-quote the JSON to avoid
# single-quote nesting. RECONCILE the RPC name/arg order against Part B's ingest_platform_event.
EVENTS_JSON="[{\"event_type\":\"product.viewed\",\"subject_type\":\"user\",\"subject_ref\":\"ext-1\",\"occurred_at\":\"$(date -u +%FT%TZ)\",\"workspace_id\":\"$WS_B\"}]"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.ingest_platform_event('$INGEST_KEY', \$seg\$$EVENTS_JSON\$seg\$::jsonb);" >/dev/null
EXT_A="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and source='external' and subject_ref='ext-1';" | tr -d '[:space:]')"
[ "${EXT_A:-0}" -ge 1 ] || { echo "external ingest did not write to the key's workspace A (got $EXT_A)"; exit 1; }
EXT_B="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS_B';" | tr -d '[:space:]')"
[ "${EXT_B:-1}" -eq 0 ] || { echo "a WS-A key wrote a platform_event into WS-B (forged workspace_id honoured; got $EXT_B)"; exit 1; }

echo "== [segmentation] (c) segment+rule -> recompute -> membership (matched_rule + evidence); re-run idempotent =="
SEG_ID="44444444-dddd-0000-0000-000000000001"
RULE_ID="55555555-dddd-0000-0000-000000000001"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.segment (id, workspace_id, name, owner_ref, active, mode) values ('$SEG_ID','$WS','E2E Seg','$USER_ID', true, 'dynamic') on conflict (id) do nothing;" \
  -c "insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values ('$RULE_ID','$WS','$SEG_ID','{\"all\":[{\"event\":\"registration.completed\"}]}'::jsonb, 1, true) on conflict (id) do nothing;"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
MEMBERS="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID' and subject_ref='$SUBJ';" | tr -d '[:space:]')"
[ "${MEMBERS:-0}" -ge 1 ] || { echo "recompute did not admit the registered subject (got $MEMBERS)"; exit 1; }
MATCHED="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID' and subject_ref='$SUBJ' and matched_rule_id='$RULE_ID';" | tr -d '[:space:]')"
[ "${MATCHED:-0}" -ge 1 ] || { echo "membership row missing matched_rule_id=$RULE_ID"; exit 1; }
# idempotency: re-run changes 0 membership rows and emits 0 NEW membership_changed events
CHANGED1="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='segment.membership_changed' and payload->>'segment_id'='$SEG_ID';" | tr -d '[:space:]')"
COUNT1="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
CHANGED2="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='segment.membership_changed' and payload->>'segment_id'='$SEG_ID';" | tr -d '[:space:]')"
COUNT2="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID';" | tr -d '[:space:]')"
[ "${COUNT1:-0}" = "${COUNT2:-1}" ] || { echo "re-run changed membership rows ($COUNT1 -> $COUNT2)"; exit 1; }
[ "${CHANGED1:-0}" = "${CHANGED2:-1}" ] || { echo "re-run emitted new membership_changed events ($CHANGED1 -> $CHANGED2)"; exit 1; }

echo "== [segmentation] (d) snapshot freezes membership; later events do not change the frozen set =="
psql "$DB_URL" -tAc "select public.take_segment_snapshot('$SEG_ID','on_demand');" >/dev/null
SNAP_ID="$(psql "$DB_URL" -tAc "select id from public.segment_snapshot where segment_id='$SEG_ID' order by taken_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$SNAP_ID" ] || { echo "take_segment_snapshot produced no snapshot"; exit 1; }
FROZEN1="$(psql "$DB_URL" -tAc "select count(*) from public.segment_snapshot_member where snapshot_id='$SNAP_ID';" | tr -d '[:space:]')"
# a new registered subject arrives + recompute; the FROZEN snapshot must not change
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('$WS','registration.completed', jsonb_build_object('subject_type','user','subject_ref','$USER2_ID'));"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
FROZEN2="$(psql "$DB_URL" -tAc "select count(*) from public.segment_snapshot_member where snapshot_id='$SNAP_ID';" | tr -d '[:space:]')"
[ "${FROZEN1:-0}" = "${FROZEN2:-1}" ] || { echo "snapshot member set changed after later events ($FROZEN1 -> $FROZEN2)"; exit 1; }

echo "== [segmentation] (e) RLS: a non-member sees 0 rows on every segmentation collection =="
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-seg-outsider@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN3="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-seg-outsider@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$TOKEN3" ] || { echo "failed to mint outsider token"; exit 1; }
for COLL in segments platform_events segment_memberships segment_snapshots; do
  OUT="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{${COLL}(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
  echo "$OUT" | grep -q "$SEG_ID" && { echo "non-member saw a row on $COLL: $OUT"; exit 1; }
done
# internal tables reject anon/authenticated direct access
IK="$(curl -sS "$API_URL/rest/v1/ingest_key?select=key_hash" -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY")"
echo "$IK" | grep -q 'key_hash' && { echo "ingest_key was readable by an authenticated user: $IK"; exit 1; }

echo "== [segmentation] (f) redaction: segmentation events carry field names not PII values =="
LEAK="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type like 'segment.%' and payload::text like '%pii@example.com%';" | tr -d '[:space:]')"
[ "${LEAK:-1}" -eq 0 ] || { echo "a segment.* event leaked a PII property value (found $LEAK)"; exit 1; }
```

- [ ] **Step 2: Gate**

Run:
```bash
bash -n scripts/slice-e2e.sh && bash scripts/slice-e2e.sh
```
Expected: `bash -n` clean (no syntax error); the slice ends `slice-e2e: PASS` with every `[segmentation]` assertion passing: (a) internal bridge lands the row + a non-bridged type does not; (b) external key writes WS-A + a forged WS-B write is rejected (0 rows in WS-B); (c) recompute admits the subject with `matched_rule_id` + re-run is idempotent (0 membership changes, 0 new `segment.membership_changed`); (d) the frozen snapshot is unchanged by later events; (e) the outsider sees 0 rows on every collection + `ingest_key` is unreadable; (f) no `segment.*` event carries the PII sentinel.

> **Reconciliation gotchas (inline):** (1) `public.emit_event(ws, type, payload)` arg order/signature is Part A/Core's — reconcile if it differs. (2) The internal bridge allow-list MUST include `registration.completed` (Part B's `segmentation_bridged_types`); if it does not, step (a) fails — reconcile the allow-list, don't weaken the assertion. (3) `segment.membership_changed` payload keys the segment under `segment_id` (roadmap "Lifecycle events") — if Part B named it differently, adjust the two `payload->>'segment_id'` selectors. (4) Step (b)'s ingest endpoint/path/key-header + `ingest_key` hash expression + `recompute_segment`/`take_segment_snapshot` signatures are Part B/C's contract — reconcile each against the merged migrations; the DB-level assertions (WS-A row present, WS-B rows = 0) are the gate regardless of the transport. (5) The redaction check (f) assumes `properties` carrying `pii@example.com` from step (a) — if the bridge drops `properties`, seed the sentinel on the emitted event instead.

- [ ] **Step 3: Commit**
```bash
git add scripts/slice-e2e.sh
git commit -m "test(e2e): segmentation slice (bridge, external ingest tenancy, recompute idempotency, snapshot, RLS, redaction)"
```

---

## Self-Review

- **Spec coverage (Part D scope):** the contract-named custom READ queries — `previewMatchingCount` (bounded, injection-safe preview), `segmentMembershipExplained` (matched rule version + evidence trail, PII-disciplined), `snapshotDiff` (set difference) — plus the three generic-surface enumeration bridges the per-segment views require (`segmentSummaries`/`segmentMembers`/`segmentSnapshots`) and the `createSegmentRuleVersion` write mutation (Task 1, optional MCP/CLI) — the `campaignAudience` seam is DEFERRED (no edge producer/consumer yet); the ONE tiny allowed read RPC `public.preview_segment_predicate` (only when Part C didn't expose it); four Astro routes — segment list, rule builder (preview count), membership explorer (evidence, PII-disciplined), snapshot history (diff) (Tasks 2–4); the BI/ML metadata pgTAP (Task 5); the `[segmentation]` e2e slice (Task 6). **No generic surface code is authored — codegen owns segmentation CRUD** (Task 1's SDL gate asserts no Part-D `updateSegment`/`deleteSegment` and that generic `segments`/`createSegment` remain codegen's). Each task ends in a machine-checkable gate.
- **Correctness:** `previewMatchingCount` reuses the SAME injection-safe compiler `evaluate_segment` uses (a parameterized set-based query, never string-built SQL) and writes nothing; `segmentMembershipExplained` returns the matched rule VERSION + evidence as `platform_event` ids/typed dimensions; `snapshotDiff` computes B\A (added) / A\B (removed) with full counts; all BFF logic is proven by a resolver-level test against a stubbed `ctx.db` (Task 1), since the frontend harness is mock-based; the pgTAP asserts the fact-stream dimensional rollup, the membership-over-time shape, and the registry roles; the e2e verifies the full roadmap (internal bridge + non-bridged no-op, external tenancy, recompute matched_rule/evidence + idempotency, snapshot immutability, RLS, redaction).
- **Safety:** custom reads run under the caller's RLS (member-scoped, non-internal tables) with no service-role/`process.env`; `preview_segment_predicate` is DEFINER but gates on `is_workspace_member` explicitly (definer bypasses RLS); evidence NEVER selects `properties` (PII boundary); the campaign-audience seam is DEFERRED (no edges written; Campaigns' `linkSegment` and `campaign_segment` untouched); the e2e asserts cross-tenant ingestion isolation (a WS-A key cannot write WS-B), non-member 0-rows on every collection, `ingest_key` unreadable by authenticated users, and PII-free `segment.*` events; the frontend honours the boundary (`check-boundary.sh` green).
- **Reliability:** `segmentSummaries` batches membership counts + last-run across ALL segments in two reads (no N+1); `segmentMembers` is keyset-paginated + capped (`min(first,200)`); `snapshotDiff` caps returned arrays at 500 while returning full counts; `previewMatchingCount` tolerates unparseable predicate JSON (returns 0, no throw); the e2e uses deterministic `psql` seeds for FK-bearing rows and asserts idempotent re-run (0 membership changes, 0 new events).
- **Observability:** events are Parts B/C's; the e2e asserts emitted event types/counts by name (`segment.membership_changed`) without logging payload values, and the redaction gate (f) proves no `segment.*` event carries a PII property value.
- **Efficiency / Performance:** the list uses two batched reads (not N+1 per segment); per-segment views use scoped BFF reads bounded by `first`/CAP; the rule-builder preview fires exactly ONCE per Preview click (Playwright network assertion) — no keystroke auto-fire — and the RPC caps its scan at 10 000; only per-segment joins/jsonb go through custom reads, workspace-wide enumeration where possible stays on the generic surface.
- **Simplicity:** four contract-named/seam reads + three enumeration bridges that exist ONLY because the generic list has no per-segment filter (relation FKs unqueryable + jsonb stringified — the same wall `campaignDetail` hit), each documented and reconcilable; ONE tiny read RPC (added only when absent); no new collection, migration table, queue, or generic surface; the seam is two additive rel-name conventions on the existing `edges` graph, not a new join table.
- **Usability:** every page states its auth-failure/loading/empty/error-retry states and keyboard/aria behaviour (list rows keyboard-focusable, active/mode as text badges not colour-only; explanation panel opened by a focusable button; snapshot diff via labelled selects); a mock-driven Playwright + axe smoke (via `/scenario`) covers all four routes; the membership explorer's evidence renders ids/typed values with a DOM assertion that no email-shaped PII string appears.
- **Reconciliation surfaced (not hidden):** the three enumeration bridges + `preview_segment_predicate`'s internal compiler name + the `evidence.event_ids` key + the ingest endpoint/key-header + the `emit_event`/`recompute_segment`/`take_segment_snapshot` signatures + the `segment.membership_changed` payload key + the snake_case column/role literals are each flagged as reconciliation points against Parts A/B/C — a mismatch is a reconciliation task, not a Part D code change; the rule-builder SAVE is explicitly reconciled to A/B/C's rule-version mutation (the generic create can't set the `segment` relation), with the in-scope preview fully delivered.
