# MOVP App — Marketing Planning & Campaigns Phase 5, Part C: Surfaces, Frontend & End-to-End

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Surface and present the Campaigns subsystem that **Parts A & B** delivered. Parts A/B added the seven campaign collections config-first (so codegen ALREADY emits the full generic GraphQL/MCP/CLI create+read CRUD, `Page` types, workspace-member RLS, FTS, and TS types), the campaign lifecycle/bridge triggers (`campaign.created`/`campaign.started`, `deliverable.assigned`/`deliverable.completed`, `public.scan_campaigns()`), and the custom `campaign` domain service (whose custom reads are `deliverableSchedule` and its batched sibling `deliverableSchedules`). Part C adds **no new collection and no new migration**. It adds: three **custom GraphQL READ queries** (`deliverableSchedule` and its batched `deliverableSchedules` over Part B's domain reads, and `campaignDetail` — a per-campaign BFF read forced by the generic surface's limitations, resolved via `ctx.db` under the caller's RLS); five Astro frontend routes (campaign list, campaign detail, timeline/Gantt, marketing calendar, deliverable board — the last **reuses the Task board**); a **reporting star-schema verification** (pgTAP); and a `[campaigns]` end-to-end slice appended to `scripts/slice-e2e.sh`.

**Architecture:** Campaigns are config-first and **NOT internal**, so — unlike Task/CMS — the schema-driven GraphQL (`packages/graphql/src/schema.ts`), MCP (`packages/mcp/src/server.ts`), and CLI (`packages/cli/src/program.ts`) builders already emit generic surfaces for `marketing_plan`/`campaign`/`campaign_deliverable`/`campaign_channel`/`campaign_calendar_event`/`campaign_metric`/`campaign_segment` (object types `Campaign`, `CampaignDeliverable`, …; `create<Pascal>` mutations; `<name>` get + `<name>s` list queries; `<name>.create`/`get`/`list` MCP tools; `movp <name> …` CLI groups). **Part C adds NO generic surface code — codegen owns it.** The ONLY new surface is a small set of custom READ queries. The frontend reaches the backend via GraphQL-over-HTTP only (the in-template `gqlRequest`/`getSessionToken`/`readServerEnv`/`Base.astro`/state components), consuming the generic reads + the custom reads + the **Task phase's** `comments` query (`entity_type='campaign'`, added by 01c) + Task's `taskBoard` query. The deliverable board is a **thin wrapper** over the Task board component, filtered to the campaign's backing tasks (recovered via the `implemented_by` edge).

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, pgTAP, Supabase CLI. `.ts` relative imports with explicit extensions; bare `@movp/*` workspace specifiers. Pothos (`@pothos/core`) for GraphQL. Astro + GraphQL-over-HTTP (no `@movp/{auth,domain}`) for the frontend; Playwright + `@axe-core/playwright` for the a11y smoke.

**This is Part C of the Phase-5 Campaigns series.** It depends on **Parts A & B** (the campaign collections in `@movp/core-schema`; the regenerated generic surfaces + generated `Campaign*`/`MarketingPlan*`/`CampaignDeliverable*`/`CampaignMetric*`/… types; the `campaign` domain service with `deliverableSchedule`; the lifecycle/bridge triggers; `public.scan_campaigns()`) being merged first. **Precondition: the Task phase (01a–01c) is also merged** — Part C reuses the Task board component, the `comments` read query (01c added it; 05b added only `addComment`), and `createTask`/`assignTask`/`transitionTask` in the e2e slice. **Part C authors no migration.**

## Global Constraints

- **Consume Parts A & B; do not rebuild them.** The seven campaign tables, their RLS (workspace-member read; owner-only campaign UPDATE), the generic surfaces, the lifecycle/bridge triggers, `public.scan_campaigns()`, the `implemented_by`/`observer`/`produces` edge conventions, and the generated types are fixed inputs. Do not redefine them. **Part C adds no `supabase/migrations/*.sql` file** (a new pgTAP *test* under `supabase/tests/` is not a migration and is allowed).
- **No generic surface code re-added.** Codegen owns the generic campaign CRUD (create + get + list). Part C adds only the custom READ queries below — no generic object types, `create*` mutations, or `<name>s` list queries authored by hand. A gate in Task 1 greps the SDL to prove no generic write mutation for campaigns was introduced by Part C.
- **The `CampaignService.deliverableSchedule`/`deliverableSchedules` signatures are fixed contracts** (see "Inputs consumed"). Part C's `deliverableSchedule`/`deliverableSchedules` GraphQL queries resolve `domainFrom(ctx).campaign.deliverableSchedule(deliverableId)` / `.deliverableSchedules(deliverableIds)` verbatim; they do not add or rename a domain method.
- **Per-request dependencies resolved at call time.** Every custom resolver reads `ctx.db` (and `domainFrom(ctx)`) from the `GraphQLContext` at call time — never module scope. `domainFrom(ctx)` builds a fresh `createDomain({ db: ctx.db, userId: ctx.userId })` per request (existing pattern).
- **Custom reads are member-scoped, RLS-authoritative.** `campaignDetail` reads `public.campaign`/`campaign_deliverable`/`campaign_channel`/`campaign_metric` via `ctx.db` under the CALLER's RLS (these are non-internal, member-readable tables — reading them directly is legitimate; the real precedent is `resolveShareLink` at `packages/graphql/src/schema.ts:343`, a committed resolver that reads `ctx.db` under the caller's client). No service-role, no `process.env`.
- **Boundary gate.** `templates/` must stay free of `@movp/{auth,domain}` and service-role references — GraphQL-over-HTTP only. `bash scripts/check-boundary.sh` must stay green (it walks `templates/` and fails on a forbidden import; new files are covered automatically).
- **Deliverable board REUSES the Task board.** Extract 01c's Task board column-rendering markup **VERBATIM** into a shared presentational component and have BOTH `tasks/board.astro` and `campaigns/[id]/board.astro` import it. Do NOT re-implement the board or invent its markup (01c does not pin the markup — the source of truth is 01c's committed `tasks/board.astro`). The refactor of `tasks/board.astro` must be behaviour-preserving: 01c's Playwright board spec passes GREEN before AND after the extraction.

## Inputs consumed from Parts A & B (verify BEFORE Task 1)

Part C references Parts A/B by exact name; a mismatch here is a reconciliation defect, not something to work around.

**Naming invariants (load-bearing):**
- Collection `name` = snake_case DB table name: `marketing_plan`, `campaign`, `campaign_deliverable`, `campaign_channel`, `campaign_calendar_event`, `campaign_metric`, `campaign_segment`. Generated TS types are Pascal-singular: `CampaignRow`, `MarketingPlanRow`, `CampaignDeliverableRow`, `CampaignChannelRow`, `CampaignCalendarEventRow`, `CampaignMetricRow`, `CampaignSegmentRow`.
- **Codegen snake_cases field keys → columns.** The spec's design excerpts write some keys camelCase (`marketingPlan`, `startDate`, `goalMetrics`, `metricKey`, `measuredAt`); the emitted COLUMNS are snake_case: `marketing_plan_id`, `start_date`, `end_date`, `goal_metrics`, `metric_key`, `measured_at`, `value`, `channel_type`, `event_date`, `deliverable_type`, `campaign_id`, `channel_id`, `deliverable_id`, `owner_id`. Part C's `ctx.db` selects and the reporting test use these snake_case column names. **If Parts A/B emitted a column under a different name, STOP and reconcile.**
- **Generic GraphQL names (from the committed builder — load-bearing):** `plural(name) = `\`${name}s\`` (snake). So the list queries are `campaigns`, `marketing_plans`, `campaign_deliverables`, `campaign_channels`, `campaign_calendar_events`, `campaign_metrics`, `campaign_segments`; the get queries are `campaign(id)`, `campaign_deliverable(id)`, …; the create mutations are `create${pascal(name)}` (`createCampaign`, `createMarketingPlan`, …) with `${pascal(name)}CreateInput` inputs whose fields are `workspace_id` + each **non-relation** scalar (relation fields are skipped in the input). **There are NO generic `update`/`delete` mutations** (the builder emits `create` only). Verify these names with `printSchema` if in doubt.

**Generic surface shape Part C must design around (verified in `packages/graphql/src/schema.ts`):**
1. Every non-relation column is exposed as a **nullable `String`** via `String(v)`. A jsonb column (`goal_metrics`) therefore serialises to `"[object Object]"` through the generic object — **unusable as structured data**. → `campaignDetail` parses `goal_metrics` server-side.
2. Relation fields resolve via the **edges loader**, so FK scalars like `campaign_id` are **not** queryable through the generic object. → per-campaign filtering cannot be done client-side over the generic list; `campaignDetail` filters by `campaign_id` server-side via `ctx.db`.
3. The generic list query takes only `workspaceId`/`first`/`after` (no field filter). `id` and plain scalar fields (`name`, `title`, `event_date`, `channel_type`, `status`, `priority`, `rank`, `start_date`, `end_date`) ARE exposed (as `String`), so workspace-wide lists (campaign list, calendar milestones, deliverable enumeration) work off the generic surface; only per-campaign joins/jsonb need `campaignDetail`.

**Domain service contract (Part B built it; Part C consumes it):**
```ts
// packages/domain/src/types.ts (Part B) — consumed, not re-authored
export interface DeliverableSchedule {
  taskId: string
  startDate: string | null   // the backing task's start_date
  dueDate: string | null     // the backing task's due_date
}
export interface CampaignService {
  // Recovers the deliverable's backing Task via the implemented_by edge
  // (src_type='campaign_deliverable', src_id=deliverableId, rel='implemented_by', dst_type='task')
  // and returns that task's dates, or null when unlinked/inaccessible under RLS.
  deliverableSchedule(deliverableId: string): Promise<DeliverableSchedule | null>
  // Batched: ONE edges read + ONE task read for ALL ids; returns an entry per LINKED
  // deliverable (unlinked/inaccessible ids are omitted). Consumed by the timeline/calendar
  // so those views issue a SINGLE schedule request instead of an N-per-deliverable fan-out.
  deliverableSchedules(deliverableIds: string[]): Promise<Array<DeliverableSchedule & { deliverableId: string }>>
}
// Part B wired `domain.campaign` as the GENERIC CollectionService AUGMENTED with
// deliverableSchedule + deliverableSchedules (it retains `.create`/`.get`/`.list`, so service(domain,'campaign')
// still resolves). `domain.graph.traverse` and `domain.collab` are the committed services.
```

**Lifecycle assumptions Part C relies on (Part B):** inserting a `campaign` emits `campaign.created` into `movp_internal.movp_events`; the bridge maps Task's `task.assigned`/`task.completed` on a deliverable's backing task → `deliverable.assigned`/`deliverable.completed`; `public.scan_campaigns()` flips `status='scheduled' AND start_date <= today` campaigns to `active`, emits `campaign.started` once, and re-running emits nothing; `campaign_deliverable` carries **no** schedule/status/assignee columns (the no-duplication invariant).

- [ ] **Precondition check** — confirm Parts A & B are merged. Run:
```bash
cd /Users/ensell/Code/supasuite
grep -q 'CampaignRow' packages/domain/src/generated/types.ts && echo GEN_CAMPAIGN_OK || echo GEN_CAMPAIGN_MISSING
grep -q 'CampaignDeliverableRow' packages/domain/src/generated/types.ts && echo GEN_DELIV_OK || echo GEN_DELIV_MISSING
grep -q 'CampaignMetricRow' packages/domain/src/generated/types.ts && echo GEN_METRIC_OK || echo GEN_METRIC_MISSING
grep -Rnq 'deliverableSchedule' packages/domain/src && echo DOMAIN_SCHEDULE_OK || echo DOMAIN_SCHEDULE_MISSING
grep -Rnq 'scan_campaigns' supabase/migrations && echo SCAN_OK || echo SCAN_MISSING
grep -Rnq "deliverable.assigned\|deliverable\\.completed" supabase/migrations && echo BRIDGE_OK || echo BRIDGE_CHECK
grep -Rnq "create table if not exists public.campaign " supabase/migrations/20260701000002_movp_generated.sql && echo TABLE_OK || echo TABLE_MISSING
# ── Task phase (01a–01c) must be merged — Part C reuses the Task board, the comments read, and task mutations ──
grep -q 'taskBoard(' packages/graphql/src/schema.ts \
  && grep -q 'createTask(' packages/graphql/src/schema.ts \
  && grep -q 'comments(' packages/graphql/src/schema.ts \
  && test -f templates/frontend-astro/src/pages/tasks/board.astro \
  && test -f templates/frontend-astro/src/lib/task-queries.ts \
  && grep -Rnq 'task_status_option' supabase/migrations \
  || { echo TASK_SURFACE_MISSING; exit 1; }
echo TASK_SURFACE_OK
```
Expected: `GEN_CAMPAIGN_OK`, `GEN_DELIV_OK`, `GEN_METRIC_OK`, `DOMAIN_SCHEDULE_OK`, `SCAN_OK`, `TABLE_OK`, and `TASK_SURFACE_OK`. `TASK_SURFACE_OK` gates the **Task phase (01a–01c)**: the `taskBoard`/`createTask`/`comments` GraphQL fields, `tasks/board.astro`, `src/lib/task-queries.ts`, and `public.task_status_option` must all be present — a `TASK_SURFACE_MISSING` + non-zero exit means 01c is not in the tree yet and this plan cannot execute (Part C reuses the Task board, the `comments` read, and `createTask`/`assignTask`/`transitionTask`). For `BRIDGE_*`: confirm Part B wired the Flows/bridge that maps `task.assigned`/`task.completed` → `deliverable.*` (the e2e depends on it). If any check fails, STOP — the prerequisite phase is not merged; this plan cannot execute.

## File Structure

```
supasuite/
  packages/
    graphql/
      src/schema.ts                              # EDIT: deliverableSchedule + campaignDetail custom READ queries (gated by refs.has('campaign_deliverable'))
      test/campaign.test.ts                       # NEW
    mcp/
      src/server.ts                               # EDIT (OPTIONAL): campaign.deliverable_schedule custom tool
      test/server.test.ts                         # EDIT (OPTIONAL)
    cli/
      src/program.ts                              # EDIT (OPTIONAL): `movp campaign schedule <deliverable>` custom command
      test/program.test.ts                        # EDIT (OPTIONAL)
  templates/
    frontend-astro/
      src/lib/campaign-queries.ts                 # NEW: GraphQL documents (list/detail/timeline/calendar/board + reused comments/taskBoard)
      src/pages/campaigns/index.astro             # NEW: campaign list (prioritization view)
      src/pages/campaigns/[id].astro              # NEW: campaign detail (brief, target-vs-actual, stakeholders, deliverables/channels, discussion)
      src/pages/campaigns/timeline.astro          # NEW: timeline / Gantt (backing-task dates)
      src/pages/campaigns/calendar.astro          # NEW: marketing calendar
      src/pages/campaigns/[id]/board.astro        # NEW: deliverable board (REUSES the Task board)
      src/components/TaskBoardColumns.astro        # NEW: markup extracted VERBATIM from 01c's tasks/board.astro (shared by both boards)
      src/pages/tasks/board.astro                 # EDIT: consume TaskBoardColumns (behaviour-preserving)
      tests/e2e/campaigns.spec.ts                 # NEW: mock-driven Playwright + axe smoke (via /scenario) over list/detail/timeline/calendar/board
      tests/mock/graphql-mock.mjs                 # EDIT: answer campaign ops (Campaigns/campaignDetail/deliverableSchedules/taskBoard/comments) with scenario-keyed canned data
  supabase/
    tests/
      campaign_reporting_test.sql                 # NEW: reporting star-schema pgTAP (test only — NOT a migration)
  scripts/
    slice-e2e.sh                                  # EDIT: append the [campaigns] section
```

---

### Task 1: GraphQL custom READ queries — `deliverableSchedule` (+ batched `deliverableSchedules`) + `campaignDetail`

Add three custom READ queries to `packages/graphql/src/schema.ts`, gated behind `refs.has('campaign_deliverable')` (so schemas without the campaign collections are unaffected), mirroring the committed task/collab custom-op blocks. **No generic surface code** — codegen already emits `campaigns`/`campaign(id)`/`createCampaign`/etc. `deliverableSchedule` (single) and `deliverableSchedules` (batched — ONE edges read + ONE task read, for the timeline/calendar) resolve Part B's domain reads; `campaignDetail` is a per-campaign BFF read that bridges the generic surface's stringify-scalars + edge-relations + no-filter shape (see "Inputs consumed"), resolved via `ctx.db` under the caller's RLS.

**Files:**
- Edit: `packages/graphql/src/schema.ts`
- Test: `packages/graphql/test/campaign.test.ts`

**Interfaces produced (GraphQL):**
- `deliverableSchedule(deliverableId: ID!): DeliverableSchedule` (nullable) — `{ taskId, startDate, dueDate }`.
- `deliverableSchedules(deliverableIds: [ID!]!): [DeliverableScheduleEntry!]!` (batched) — one entry per LINKED deliverable `{ deliverableId, taskId, startDate, dueDate }`; resolves Part B's `campaign.deliverableSchedules` (ONE edges read + ONE task read). Consumed by the timeline/calendar to avoid an N-request fan-out.
- `campaignDetail(campaignId: ID!): CampaignDetail` (nullable) — brief scalars + parsed `goalMetrics` targets + `actuals` rollup (`sum(value)` by `metric_key`) + per-campaign `deliverables` (each with its backing `taskId`) + `channels` + `stakeholders` (owner + observer ids).

- [ ] **Step 1: Write the failing test**

`packages/graphql/test/campaign.test.ts`:
```ts
import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
  deliverableSchedule: vi.fn(async () => ({ taskId: 'task-1', startDate: '2026-07-01', dueDate: '2026-07-10' })),
  deliverableSchedules: vi.fn(async () => [{ deliverableId: 'd1', taskId: 'task-1', startDate: '2026-07-01', dueDate: '2026-07-10' }]),
  traverse: vi.fn(async () => [] as Array<{ type: string; id: string }>),
}))

// deliverableSchedule/deliverableSchedules route to the mocked domain. campaignDetail reads
// ctx.db directly; the frontend harness is MOCK-based (it cannot exercise the real rollup/edge-
// batch logic), so campaignDetail's BFF logic is proven HERE against a stubbed ctx.db — this is
// THE gate for the BFF read. The real precedent for a resolver reading ctx.db is `resolveShareLink`
// (`packages/graphql/src/schema.ts:343`).
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    campaign: { deliverableSchedule: mocks.deliverableSchedule, deliverableSchedules: mocks.deliverableSchedules },
    graph: { traverse: mocks.traverse },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }

// Chainable stub for ctx.db: `.from(table)` returns a thenable whose await yields { data: rows },
// and `.maybeSingle()` yields { data: rows[0] ?? null }. Filter args are ignored — the per-table
// seed is what the resolver reads (real RLS/filtering is covered by the e2e slice, Task 6).
type DbChain = {
  select: () => DbChain; eq: () => DbChain; order: () => DbChain; in: () => DbChain
  maybeSingle: () => Promise<{ data: unknown }>
  then: (resolve: (v: { data: unknown[] }) => unknown) => unknown
}
function makeDb(tables: Record<string, unknown[]>): { from: (t: string) => DbChain } {
  return {
    from(table) {
      const rows = tables[table] ?? []
      const chain: DbChain = {
        select: () => chain, eq: () => chain, order: () => chain, in: () => chain,
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        then: (resolve) => resolve({ data: rows }),
      }
      return chain
    },
  }
}

describe('campaign GraphQL surface', () => {
  it('deliverableSchedule routes to campaign.deliverableSchedule', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedule(deliverableId: "d1") { taskId startDate dueDate } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.deliverableSchedule).toHaveBeenCalledWith('d1')
    expect((res.data as { deliverableSchedule: { taskId: string } }).deliverableSchedule.taskId).toBe('task-1')
  })

  it('deliverableSchedule returns null for an unlinked deliverable', async () => {
    mocks.deliverableSchedule.mockResolvedValueOnce(null as never)
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedule(deliverableId: "d2") { taskId } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { deliverableSchedule: unknown }).deliverableSchedule).toBeNull()
  })

  it('deliverableSchedules routes to campaign.deliverableSchedules (ONE batched call)', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedules(deliverableIds: ["d1","d2"]) { deliverableId taskId startDate dueDate } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.deliverableSchedules).toHaveBeenCalledTimes(1)
    expect(mocks.deliverableSchedules).toHaveBeenCalledWith(['d1', 'd2'])
    const rows = (res.data as { deliverableSchedules: Array<{ deliverableId: string }> }).deliverableSchedules
    expect(rows[0].deliverableId).toBe('d1')
  })

  it('campaignDetail parses goal targets, rolls up actuals by metric_key, batches taskIds, resolves stakeholders', async () => {
    mocks.traverse.mockResolvedValueOnce([{ type: 'user', id: 'user-obs' }, { type: 'task', id: 'task-x' }])
    const db = makeDb({
      campaign: [{
        id: 'c1', workspace_id: 'w1', name: 'C', brief: 'B', status: 'active',
        priority: 'high', rank: 3, start_date: '2026-07-01', end_date: '2026-07-31',
        owner_id: 'owner-1', marketing_plan_id: 'mp1',
        goal_metrics: [{ metric_key: 'clicks', target_value: 100, unit: 'count' }],
      }],
      campaign_deliverable: [{ id: 'd1', name: 'D1' }],
      edges: [{ src_id: 'd1', dst_id: 'task-1' }],
      campaign_channel: [{ id: 'ch1', channel_type: 'email', name: 'Email' }],
      campaign_metric: [{ metric_key: 'clicks', value: 30 }, { metric_key: 'clicks', value: 70 }],
    })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { campaignDetail(campaignId: "c1") {
        id goalMetrics { metricKey targetValue unit } actuals { metricKey total }
        deliverables { id taskId } channels { id channelType }
        stakeholders { ownerId observerIds } } }`,
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const d = (res.data as { campaignDetail: {
      goalMetrics: unknown; actuals: unknown; deliverables: unknown; channels: unknown; stakeholders: unknown
    } }).campaignDetail
    expect(d.goalMetrics).toEqual([{ metricKey: 'clicks', targetValue: '100', unit: 'count' }])
    expect(d.actuals).toEqual([{ metricKey: 'clicks', total: 100 }])            // 30 + 70 rolled up by metric_key
    expect(d.deliverables).toEqual([{ id: 'd1', taskId: 'task-1' }])            // backing taskId batched from edges
    expect(d.channels).toEqual([{ id: 'ch1', channelType: 'email' }])
    expect(d.stakeholders).toEqual({ ownerId: 'owner-1', observerIds: ['user-obs'] }) // owner FK + observer edge
  })

  it('surfaces the CUSTOM reads + the codegen generic CRUD, but Part C adds NO generic write for campaigns', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    // Part C's custom reads present
    expect(sdl).toMatch(/\bdeliverableSchedule\(/)
    expect(sdl).toMatch(/type DeliverableSchedule\b/)
    expect(sdl).toMatch(/\bdeliverableSchedules\(/)
    expect(sdl).toMatch(/type DeliverableScheduleEntry\b/)
    expect(sdl).toMatch(/\bcampaignDetail\(/)
    expect(sdl).toMatch(/type CampaignDetail\b/)
    // codegen's generic campaign surface (create + read) is present — NOT authored here
    expect(sdl).toMatch(/type Campaign\b/)
    expect(sdl).toMatch(/\bcreateCampaign\(/)
    expect(sdl).toMatch(/\bcampaigns\(/)
    expect(sdl).toMatch(/\bcampaign_deliverables\(/)
    // the builder emits create-only; Part C introduces no generic update/delete for campaigns
    expect(sdl).not.toMatch(/\bupdateCampaign\(/)
    expect(sdl).not.toMatch(/\bdeleteCampaign\(/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run campaign
```
Expected: FAIL — `Cannot query field "deliverableSchedule" on type "Query"` (the custom reads don't exist yet); the `deliverableSchedules` and `campaignDetail` tests also fail (those fields absent), and the SDL test fails (`deliverableSchedule`/`deliverableSchedules`/`campaignDetail` absent from the printed schema).

- [ ] **Step 3: Implement — edit `schema.ts`**

Add the guarded block immediately after the task custom block (still inside `buildSchema`, before `return builder.toSchema()`). The generic campaign object types (`refs.get('campaign')` etc.) already exist from the generic loop; do NOT re-implement them. Reuse the file's existing `GraphQLContext`, `domainFrom`, and `Row` helpers. **Gotcha (inline):** every dependency (`ctx.db`, `domainFrom(ctx)`) is resolved at call time from the request context — never module scope — because on workerd there is no per-request module instance.
```ts
  // ── Campaigns Part C — custom READ queries (only when the campaign collections exist) ──
  // Codegen owns the generic campaign create+read CRUD. These two reads bridge the generic
  // surface's limits: jsonb serialises to "[object Object]", relation FKs are not queryable
  // scalars, and the generic list has no per-field filter (see plan "Inputs consumed").
  if (refs.has('campaign_deliverable')) {
    // Local row shapes for the ctx.db reads (avoid `any` in resolver bodies; the Pothos
    // builder callbacks keep the file's existing `t: any` convention).
    type GoalMetric = { metric_key?: string; target_value?: number | string | null; unit?: string | null }
    type CampaignRowLite = {
      id: string; workspace_id: string; name: string | null; brief: string | null
      status: string | null; priority: string | null; rank: number | string | null
      start_date: string | null; end_date: string | null; owner_id: string | null
      marketing_plan_id: string | null; goal_metrics: unknown
    }

    const deliverableSchedule = builder
      .objectRef<{ taskId: string; startDate: string | null; dueDate: string | null }>('DeliverableSchedule')
      .implement({
        fields: (t: any) => ({
          taskId: t.exposeID('taskId', { complexity: 0 }),
          startDate: t.string({ nullable: true, complexity: 0, resolve: (r: { startDate: string | null }) => r.startDate }),
          dueDate: t.string({ nullable: true, complexity: 0, resolve: (r: { dueDate: string | null }) => r.dueDate }),
        }),
      })

    builder.queryField('deliverableSchedule', (t: any) =>
      t.field({
        type: deliverableSchedule, nullable: true, complexity: 5,
        args: { deliverableId: t.arg.id({ required: true }) },
        // The one custom DOMAIN read (Part B). Recovers the backing task's dates via the
        // implemented_by edge; null when unlinked/inaccessible under the caller's RLS.
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).campaign.deliverableSchedule(String(a.deliverableId)),
      }),
    )

    // ── deliverableSchedules: the BATCHED sibling (timeline/calendar use THIS, not the
    // singular one per deliverable). Part B's campaign.deliverableSchedules does ONE edges read
    // + ONE task read; each entry carries its deliverableId so the client maps back. ──
    const deliverableScheduleEntry = builder
      .objectRef<{ deliverableId: string; taskId: string; startDate: string | null; dueDate: string | null }>('DeliverableScheduleEntry')
      .implement({
        fields: (t: any) => ({
          deliverableId: t.exposeID('deliverableId', { complexity: 0 }),
          taskId: t.exposeID('taskId', { complexity: 0 }),
          startDate: t.string({ nullable: true, complexity: 0, resolve: (r: { startDate: string | null }) => r.startDate }),
          dueDate: t.string({ nullable: true, complexity: 0, resolve: (r: { dueDate: string | null }) => r.dueDate }),
        }),
      })

    builder.queryField('deliverableSchedules', (t: any) =>
      t.field({
        type: [deliverableScheduleEntry], nullable: false, complexity: 10,
        args: { deliverableIds: t.arg({ type: ['ID'], required: true }) },
        // Resolved at call time from ctx (workerd has no per-request module instance).
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).campaign.deliverableSchedules((a.deliverableIds as unknown[]).map(String)),
      }),
    )

    // ── campaignDetail: the per-campaign BFF read (detail + board pages) ──
    const metricTarget = builder.objectRef<{ metricKey: string; targetValue: string | null; unit: string | null }>('MetricTarget').implement({
      fields: (t: any) => ({
        metricKey: t.exposeString('metricKey', { complexity: 0 }),
        targetValue: t.string({ nullable: true, complexity: 0, resolve: (r: { targetValue: string | null }) => r.targetValue }),
        unit: t.string({ nullable: true, complexity: 0, resolve: (r: { unit: string | null }) => r.unit }),
      }),
    })
    const metricActual = builder.objectRef<{ metricKey: string; total: number }>('MetricActual').implement({
      fields: (t: any) => ({
        metricKey: t.exposeString('metricKey', { complexity: 0 }),
        total: t.float({ complexity: 0, resolve: (r: { total: number }) => r.total }),
      }),
    })
    const deliverableBrief = builder.objectRef<{ id: string; name: string | null; taskId: string | null }>('CampaignDeliverableBrief').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: { name: string | null }) => r.name }),
        taskId: t.string({ nullable: true, complexity: 0, resolve: (r: { taskId: string | null }) => r.taskId }),
      }),
    })
    const channelBrief = builder.objectRef<{ id: string; channelType: string | null; name: string | null }>('CampaignChannelBrief').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        channelType: t.string({ nullable: true, complexity: 0, resolve: (r: { channelType: string | null }) => r.channelType }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: { name: string | null }) => r.name }),
      }),
    })
    const stakeholders = builder.objectRef<{ ownerId: string | null; observerIds: string[] }>('CampaignStakeholders').implement({
      fields: (t: any) => ({
        ownerId: t.string({ nullable: true, complexity: 0, resolve: (r: { ownerId: string | null }) => r.ownerId }),
        observerIds: t.field({ type: ['ID'], complexity: 0, resolve: (r: { observerIds: string[] }) => r.observerIds }),
      }),
    })
    type CampaignDetailShape = {
      id: string; name: string | null; brief: string | null; status: string | null
      priority: string | null; rank: string | null; startDate: string | null; endDate: string | null
      ownerId: string | null; marketingPlanId: string | null
      goalMetrics: Array<{ metricKey: string; targetValue: string | null; unit: string | null }>
      actuals: Array<{ metricKey: string; total: number }>
      deliverables: Array<{ id: string; name: string | null; taskId: string | null }>
      channels: Array<{ id: string; channelType: string | null; name: string | null }>
      stakeholders: { ownerId: string | null; observerIds: string[] }
    }
    const campaignDetail = builder.objectRef<CampaignDetailShape>('CampaignDetail').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.name }),
        brief: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.brief }),
        status: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.status }),
        priority: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.priority }),
        rank: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.rank }),
        startDate: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.startDate }),
        endDate: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.endDate }),
        ownerId: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.ownerId }),
        marketingPlanId: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.marketingPlanId }),
        goalMetrics: t.field({ type: [metricTarget], complexity: 0, resolve: (r: CampaignDetailShape) => r.goalMetrics }),
        actuals: t.field({ type: [metricActual], complexity: 0, resolve: (r: CampaignDetailShape) => r.actuals }),
        deliverables: t.field({ type: [deliverableBrief], complexity: 0, resolve: (r: CampaignDetailShape) => r.deliverables }),
        channels: t.field({ type: [channelBrief], complexity: 0, resolve: (r: CampaignDetailShape) => r.channels }),
        stakeholders: t.field({ type: stakeholders, complexity: 0, resolve: (r: CampaignDetailShape) => r.stakeholders }),
      }),
    })

    builder.queryField('campaignDetail', (t: any) =>
      t.field({
        type: campaignDetail, nullable: true, complexity: 15,
        args: { campaignId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<CampaignDetailShape | null> => {
          const campaignId = String(a.campaignId)
          // All reads run under the caller's RLS (member-scoped, non-internal tables).
          const { data: c } = await ctx.db
            .from('campaign')
            .select('id, workspace_id, name, brief, status, priority, rank, start_date, end_date, owner_id, marketing_plan_id, goal_metrics')
            .eq('id', campaignId)
            .maybeSingle()
          if (!c) return null
          const camp = c as CampaignRowLite

          const { data: delivRows } = await ctx.db
            .from('campaign_deliverable').select('id, name').eq('campaign_id', campaignId).order('id', { ascending: true })
          const delivs = (delivRows ?? []) as Array<{ id: string; name: string | null }>

          // Batch the backing-task ids for ALL deliverables in ONE edges read (avoid N+1).
          const delivIds = delivs.map((d) => d.id)
          const edgeMap = new Map<string, string>()
          if (delivIds.length > 0) {
            const { data: edges } = await ctx.db
              .from('edges').select('src_id, dst_id')
              .eq('rel', 'implemented_by').eq('src_type', 'campaign_deliverable').eq('dst_type', 'task')
              .in('src_id', delivIds)
            for (const e of (edges ?? []) as Array<{ src_id: string; dst_id: string }>) edgeMap.set(e.src_id, e.dst_id)
          }

          const { data: chanRows } = await ctx.db
            .from('campaign_channel').select('id, channel_type, name').eq('campaign_id', campaignId).order('id', { ascending: true })
          const { data: metricRows } = await ctx.db
            .from('campaign_metric').select('metric_key, value').eq('campaign_id', campaignId)

          // Roll up sum(value) by metric_key (the actuals side of target-vs-actual).
          const totals = new Map<string, number>()
          for (const m of (metricRows ?? []) as Array<{ metric_key: string | null; value: number | string | null }>) {
            const key = m.metric_key ?? ''
            const v = typeof m.value === 'string' ? Number(m.value) : (m.value ?? 0)
            totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(v) ? v : 0))
          }

          // Observers via the campaign→user observer edge (owner is the FK owner_id).
          const observers = await domainFrom(ctx).graph.traverse({
            workspaceId: camp.workspace_id, srcType: 'campaign', srcId: campaignId, rel: 'observer', depth: 1,
          })
          const observerIds = observers.filter((n) => n.type === 'user').map((n) => n.id)

          const goals: GoalMetric[] = Array.isArray(camp.goal_metrics) ? (camp.goal_metrics as GoalMetric[]) : []

          return {
            id: camp.id,
            name: camp.name,
            brief: camp.brief,
            status: camp.status,
            priority: camp.priority,
            rank: camp.rank == null ? null : String(camp.rank),
            startDate: camp.start_date,
            endDate: camp.end_date,
            ownerId: camp.owner_id,
            marketingPlanId: camp.marketing_plan_id,
            goalMetrics: goals.map((g) => ({
              metricKey: String(g.metric_key ?? ''),
              targetValue: g.target_value == null ? null : String(g.target_value),
              unit: g.unit ?? null,
            })),
            actuals: [...totals.entries()].map(([metricKey, total]) => ({ metricKey, total })),
            deliverables: delivs.map((d) => ({ id: d.id, name: d.name, taskId: edgeMap.get(d.id) ?? null })),
            channels: ((chanRows ?? []) as Array<{ id: string; channel_type: string | null; name: string | null }>)
              .map((ch) => ({ id: ch.id, channelType: ch.channel_type, name: ch.name })),
            stakeholders: { ownerId: camp.owner_id, observerIds },
          }
        },
      }),
    )
  }
```

> **Reconciliation note (read before typing).** `campaignDetail` is a documented deviation from "add only `deliverableSchedule`": the committed generic surface serialises jsonb to `"[object Object]"`, resolves relations via the edges loader (so `campaign_id` is not a queryable scalar), emits **create-only** mutations, and offers no per-field list filter — so a real per-campaign detail (goal-metrics targets, per-campaign metrics/deliverables/channels, stakeholders) is not expressible over the generic surface. `campaignDetail` reads the non-internal, member-readable tables via `ctx.db` under RLS (the same pattern as `resolveShareLink` at `packages/graphql/src/schema.ts:343`, a committed resolver that reads `ctx.db` under the caller's client). If Parts A/B chose a different exposure (a JSON scalar for `goal_metrics`, FK scalars, or a per-campaign generic filter), prefer that and delete `campaignDetail`. The column names in the selects (`goal_metrics`, `metric_key`, `channel_type`, `start_date`, `end_date`, `marketing_plan_id`, `owner_id`) are the snake_case codegen columns — reconcile if Part A emitted different names.

- [ ] **Step 4: Run the test + typecheck + the existing schema gate**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `campaign.test.ts` (5 tests: 2 `deliverableSchedule` routing/null, 1 `deliverableSchedules` batched routing, 1 `campaignDetail` resolver against the stubbed ctx.db, 1 SDL surface) AND the existing `schema.test.ts`/`relations.test.ts`/task/collab tests still green; `tsc --noEmit` clean.

- [ ] **Step 5 (OPTIONAL): custom MCP tool + CLI command**

Generic `campaign.create/get/list` MCP tools and `movp campaign create/list` CLI commands come FREE from codegen (campaigns are non-internal) — do NOT re-add them. Optionally expose the one custom read:
- MCP (`packages/mcp/src/server.ts`, after the generated-tool loop; test in `packages/mcp/test/server.test.ts` adds a `campaign: { deliverableSchedule }` stub to the mocked domain and asserts `task`-style):
```ts
  server.registerTool(
    'campaign.deliverable_schedule',
    { title: 'Deliverable schedule', description: "A deliverable's backing-task start/due dates (via the implemented_by edge)", inputSchema: { deliverableId: z.string() } },
    async ({ deliverableId }) => text(await domain.campaign.deliverableSchedule(deliverableId)),
  )
```
- CLI (`packages/cli/src/program.ts`, a `campaign` subcommand alongside the generic group; the generic `movp campaign create/list` already exist from codegen, so extend rather than redefine — add ONLY the custom subcommand):
```ts
  program.command('campaign-schedule')
    .description("Show a deliverable's backing-task schedule")
    .requiredOption('--deliverable <id>', 'campaign_deliverable id')
    .action(async (o: { deliverable: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.campaign.deliverableSchedule(o.deliverable)))
    })
```
> Gotcha: the generic CLI loop already registers a `campaign` group for the generic CRUD; a second `program.command('campaign')` would collide. Register the custom read under a distinct name (`campaign-schedule`) OR attach it to the existing group via the builder's collection hook — do NOT call `program.command('campaign')` twice. If OPTIONAL steps are skipped, state so in the commit and move on.
Gate (only if implemented): `pnpm --filter @movp/mcp exec vitest run && pnpm --filter @movp/cli exec vitest run`.

- [ ] **Step 6: Commit**
```bash
git add packages/graphql/src/schema.ts packages/graphql/test/campaign.test.ts
# add packages/mcp packages/cli only if Step 5 was implemented
git commit -m "feat(graphql): campaign deliverableSchedule + campaignDetail custom reads"
```

---

### Task 2: Frontend — campaign list + campaign detail

Add the campaign list (prioritization view) and the campaign detail (brief, target-vs-actual, stakeholders, deliverables/channels, discussion). Each page mirrors `src/pages/index.astro` / `tasks/index.astro`: read the session token, render `AuthFailure` when absent, else `readServerEnv()` + `gqlRequest({ endpoint, token }, QUERY, vars)` and branch on the `GqlResult` union (`!r.ok` → `ErrorRetry`, else use `r.data`), with `EmptyState` when the list is empty. GraphQL-over-HTTP only — no privileged imports.

**Files:**
- Create: `templates/frontend-astro/src/lib/campaign-queries.ts`
- Create: `templates/frontend-astro/src/pages/campaigns/index.astro`, `templates/frontend-astro/src/pages/campaigns/[id].astro`
- Edit: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (add scenario-keyed campaign responses)
- Test: create `templates/frontend-astro/tests/e2e/campaigns.spec.ts` (created here; grown in Tasks 3–4)

**Interfaces consumed (all already in the template):** `gqlRequest<T>({ endpoint, token }, QUERY, variables): Promise<GqlResult<T>>` — **3 positional args** (opts, query, variables); the result is a discriminated union `{ ok: true; data: T } | { ok: false; code }`, so pages branch on `r.ok` (mirroring `src/pages/index.astro`) (`src/lib/graphql.ts`); `getSessionToken(cookies)` (`src/lib/session.ts`); `readServerEnv() -> { graphqlEndpoint, workspaceId }` (`src/lib/env.ts`); `Base.astro`; `src/components/states/{AuthFailure,LoadingState,EmptyState,ErrorRetry}.astro`. GraphQL ops: generic `campaigns(workspaceId, first)` (list); custom `campaignDetail(campaignId)` (Task 1); the **Task phase's** `comments(workspaceId, entityType, entityId)` read query (01c added the read; 05b added only `addComment`) — reused verbatim with `entityType: "campaign"`.

- [ ] **Step 1: GraphQL documents** — `src/lib/campaign-queries.ts`:
```ts
// Generic list (codegen surface): scalar fields exposed as String — sort client-side.
export const CAMPAIGNS_QUERY = /* GraphQL */ `
  query Campaigns($workspaceId: ID!, $first: Int) {
    campaigns(workspaceId: $workspaceId, first: $first) {
      items { id name status priority rank start_date end_date }
      nextCursor
    }
  }`
// Custom per-campaign read (Task 1): target-vs-actual + stakeholders + deliverables/channels.
export const CAMPAIGN_DETAIL_QUERY = /* GraphQL */ `
  query CampaignDetail($campaignId: ID!) {
    campaignDetail(campaignId: $campaignId) {
      id name brief status priority rank startDate endDate ownerId marketingPlanId
      goalMetrics { metricKey targetValue unit }
      actuals { metricKey total }
      deliverables { id name taskId }
      channels { id channelType name }
      stakeholders { ownerId observerIds }
    }
  }`
// Discussion reuses the Task phase's comments read query (01c added it; entity_type='campaign').
export const CAMPAIGN_COMMENTS_QUERY = /* GraphQL */ `
  query CampaignComments($workspaceId: ID!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: "campaign", entityId: $entityId) {
      id body author_id created_at
    }
  }`
```

- [ ] **Step 2: Extend the mock harness + write the failing Playwright/axe test** — the frontend test harness is **MOCK-based**: `playwright.config.ts` has `testDir: './tests/e2e'` and a `webServer` running `node tests/mock/graphql-mock.mjs`; specs drive scenarios with `fetch('/scenario?name=ok|empty|error')` then assert the rendered DOM (see `tests/e2e/frontend.spec.ts`). There is **NO** service-role REST/SQL seed helper under `templates/` — and any `service_role`/`SERVICE_ROLE_KEY` reference there fails `scripts/check-boundary.sh` (which greps `*.mjs` too). Do NOT seed a database.
  - **Extend `templates/frontend-astro/tests/mock/graphql-mock.mjs`** to answer the campaign operations with **scenario-keyed** canned data, mirroring how it already serves `query Notes`/`query Note` (branch on `query.includes('query Campaigns')`, `'query CampaignDetail'`, `'query CampaignComments'`, and — for Tasks 3–4 — `'query Deliverables'`/`'query DeliverableSchedules'`/`'query CalendarEvents'`/`'query TaskBoard'`). For `ok`: return one campaign (id `camp-1`), one `campaignDetail` with `goalMetrics=[{metricKey:'clicks',targetValue:'100',unit:'count'}]`, `actuals=[{metricKey:'clicks',total:40}]`, one `email` channel, one deliverable `{id:'d1',taskId:'task-1'}`, `stakeholders={ownerId:'owner-1',observerIds:[]}`, and one `campaign` comment. For `empty`: empty `items`/null detail. `error` is already handled globally (the mock returns `{errors:[…]}` when `scenario==='error'`).
  - **Create the spec at `templates/frontend-astro/tests/e2e/campaigns.spec.ts`** (INSIDE `testDir` — a path outside `tests/e2e/` is not run) mirroring `tests/e2e/frontend.spec.ts`. Cases (drive `fetch('/scenario?name=…')` then assert the DOM):
    - `/campaigns` with no cookie → the AuthFailure view.
    - `/campaigns` (`ok`) → lists the campaign (name visible); a sort control reorders by `rank`/`priority`/`status`. `empty` → the EmptyState.
    - `/campaigns/camp-1` (`ok`) → renders the brief, a target-vs-actual row (`clicks 40 / 100`), the stakeholders (owner id), the deliverables + channels sections, and the discussion thread (≥1 comment).
    - axe smoke over `/campaigns` and `/campaigns/camp-1` (no serious/critical violations).
  > The mock cannot exercise `campaignDetail`'s real rollup/edge-batch logic — that BFF logic is proven by the **resolver-level test in `packages/graphql/test/campaign.test.ts`** (Task 1); this spec proves only that the pages render the shapes the resolver returns.
Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns` → Expected: FAIL (routes 404 — `/campaigns` pages not created yet; the mock returns data but no route renders it).

- [ ] **Step 3: Implement the pages**
  - `src/pages/campaigns/index.astro` → `CAMPAIGNS_QUERY`; render a table/list of campaigns with client-side sort controls for `rank` (numeric — `parseFloat` the stringified value), `priority`, `status`, `start_date` (the prioritization view). `EmptyState` when `items` is empty; each row links to `/campaigns/{id}`. Keyboard-focusable sort controls with `aria-pressed`/`aria-sort`.
  - `src/pages/campaigns/[id].astro` → `CAMPAIGN_DETAIL_QUERY` (id from `Astro.params.id`) + `CAMPAIGN_COMMENTS_QUERY` (`entityId` = the id). Render: the brief; a **target-vs-actual** table joining `goalMetrics` (targets) to `actuals` by `metricKey` (show target, actual, and a variance/percent); **stakeholders** (owner id + observer ids); **deliverables** (name + a link to `/campaigns/{id}/board`) and **channels** (channel type + name); the **discussion thread** (comments). If `campaignDetail` is null, render `EmptyState`/`ErrorRetry` appropriately.
Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns` → Expected: PASS (list + detail + axe).

- [ ] **Step 4: Boundary gate**
Run: `bash scripts/check-boundary.sh`
Expected: clean (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`).

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/campaign-queries.ts templates/frontend-astro/src/pages/campaigns/index.astro templates/frontend-astro/src/pages/campaigns/\[id\].astro templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/campaigns.spec.ts
git commit -m "feat(frontend): campaign list + detail (target-vs-actual, stakeholders, discussion)"
```

---

### Task 3: Frontend — timeline / Gantt + marketing calendar

Add the timeline/Gantt (deliverables plotted by their BACKING TASK's dates + calendar-event milestones) and the marketing calendar (calendar events + deliverable due dates across the period). Both enumerate deliverables/events off the generic list surface (`id`/scalar fields work) and resolve backing-task dates via the **batched** `deliverableSchedules(deliverableIds)` — ONE request for all deliverables, NOT a per-deliverable fan-out.

**Files:**
- Create: `templates/frontend-astro/src/pages/campaigns/timeline.astro`, `templates/frontend-astro/src/pages/campaigns/calendar.astro`
- Edit: `templates/frontend-astro/src/lib/campaign-queries.ts` (add the enumeration + batched schedule docs)
- Edit: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (scenario-keyed `Deliverables`/`DeliverableSchedules`/`CalendarEvents`)
- Test: extend `templates/frontend-astro/tests/e2e/campaigns.spec.ts`

- [ ] **Step 1: Add GraphQL documents** to `src/lib/campaign-queries.ts`:
```ts
// Enumerate deliverables (generic list — id + name scalars are exposed).
export const DELIVERABLES_QUERY = /* GraphQL */ `
  query Deliverables($workspaceId: ID!, $first: Int) {
    campaign_deliverables(workspaceId: $workspaceId, first: $first) { items { id name } nextCursor }
  }`
// ALL deliverables' backing-task schedules in ONE batched request (custom read — avoids the
// N-request per-deliverable fan-out). Each entry carries its deliverableId to map back.
export const DELIVERABLE_SCHEDULES_QUERY = /* GraphQL */ `
  query DeliverableSchedules($deliverableIds: [ID!]!) {
    deliverableSchedules(deliverableIds: $deliverableIds) { deliverableId taskId startDate dueDate }
  }`
// Calendar-event milestones (generic list — title/event_date/event_type scalars).
export const CALENDAR_EVENTS_QUERY = /* GraphQL */ `
  query CalendarEvents($workspaceId: ID!, $first: Int) {
    campaign_calendar_events(workspaceId: $workspaceId, first: $first) {
      items { id title event_date event_type }
      nextCursor
    }
  }`
```

- [ ] **Step 2: Failing test** — extend `tests/e2e/campaigns.spec.ts` and the mock: the `ok` scenario also returns one `CalendarEvents` item (`event_type='launch'`, a dated `event_date`) and one batched `DeliverableSchedules` entry for the seeded deliverable (`{deliverableId:'d1',taskId:'task-1',startDate,dueDate}`). Cases: `/campaigns/timeline` renders a row for the deliverable positioned by its backing-task dates AND the calendar milestone; `/campaigns/calendar` renders the milestone and the deliverable due date within the shown period; axe smoke over both. **Network assertion (performance gate):** count GraphQL POSTs to the mock whose body includes `query DeliverableSchedules` and assert EXACTLY ONE for `/campaigns/timeline` (the batched read, not an N-per-deliverable fan-out):
```ts
  let scheduleReqs = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && (r.postData() ?? '').includes('query DeliverableSchedules')) scheduleReqs++
  })
  await page.goto('/campaigns/timeline')
  expect(scheduleReqs).toBe(1)
```
Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns` → Expected: FAIL (routes 404).

- [ ] **Step 3: Implement**
  - `src/pages/campaigns/timeline.astro` → run `DELIVERABLES_QUERY`, collect the deliverable ids, then issue ONE `DELIVERABLE_SCHEDULES_QUERY` with `{ deliverableIds }` (a single batched request — NOT one call per deliverable), plus `CALENDAR_EVENTS_QUERY`. Build a `Map<deliverableId, { startDate, dueDate }>` from the batched result. Render a simple horizontal Gantt: one bar per deliverable spanning `startDate`→`dueDate` (deliverables with no schedule entry go in an "unscheduled" group), and milestone markers from calendar events. Bound the deliverable fetch with a sensible `first` (e.g. 100).
  - `src/pages/campaigns/calendar.astro` → `CALENDAR_EVENTS_QUERY` + the deliverable `dueDate`s from the SAME batched `DELIVERABLE_SCHEDULES_QUERY`, grouped by date across the visible period. `EmptyState` when there is nothing dated.
Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns` → Expected: PASS.

- [ ] **Step 4: Boundary gate** — `bash scripts/check-boundary.sh` → clean.

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/campaign-queries.ts templates/frontend-astro/src/pages/campaigns/timeline.astro templates/frontend-astro/src/pages/campaigns/calendar.astro templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/campaigns.spec.ts
git commit -m "feat(frontend): campaign timeline/Gantt + marketing calendar (backing-task dates)"
```

---

### Task 4: Frontend — deliverable board (REUSE the Task board) + Playwright/axe + boundary gate

Build the deliverable board as a **thin wrapper** over the Task board: extract 01c's Task board column-rendering markup **VERBATIM** into a shared `TaskBoardColumns.astro`, refactor `tasks/board.astro` to consume it (behaviour-preserving — 01c's `tests/e2e/tasks.spec.ts` GREEN before AND after), then have `campaigns/[id]/board.astro` fetch the Task board and filter it to the campaign's backing tasks. Do NOT re-implement the board, and do NOT invent its markup — 01c never pins the board markup, so the source of truth is 01c's committed `tasks/board.astro`.

**Files:**
- Create: `templates/frontend-astro/src/components/TaskBoardColumns.astro` (markup extracted VERBATIM from 01c's `tasks/board.astro`)
- Edit: `templates/frontend-astro/src/pages/tasks/board.astro` (consume the component — behaviour-preserving)
- Create: `templates/frontend-astro/src/pages/campaigns/[id]/board.astro`
- Edit: `templates/frontend-astro/src/lib/campaign-queries.ts` (re-export `TASK_BOARD_QUERY`)
- Edit: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (scenario-keyed `TaskBoard` with a linked + an unlinked task)
- Test: extend `templates/frontend-astro/tests/e2e/campaigns.spec.ts`; re-run `tests/e2e/tasks.spec.ts`

- [ ] **Step 1: Failing test** — extend `tests/e2e/campaigns.spec.ts`: have the mock's `ok` `TaskBoard` return two tasks — `task-1` (linked to the seeded deliverable via `implemented_by`, so it appears in `campaignDetail.deliverables[].taskId`) and `task-2` (unlinked). Assert `/campaigns/camp-1/board` renders the Task board columns showing ONLY `task-1` and NOT `task-2` (proving the filter). axe smoke over the board route. Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns` → Expected: FAIL (route 404 + component missing).

- [ ] **Step 2: Extract `TaskBoardColumns.astro` (VERBATIM from 01c)** — FIRST establish the behaviour-preservation baseline: run `pnpm --filter @movp/frontend-astro exec playwright test tasks` and confirm it is GREEN. Then **copy the column-rendering markup out of 01c's committed `tasks/board.astro` VERBATIM** into `src/components/TaskBoardColumns.astro` — do NOT retype or redesign it. Props: `columns` (the `taskBoard` result — `[{ status, tasks }]`) and an optional `taskIds?: string[]` filter. When `taskIds` is provided, each column renders only tasks whose `id` is in that set; when omitted, it renders all (the Task board's current behaviour). Keep the exact status-column ordering, headings, aria attributes, and empty-column handling 01c had.
> The `.astro` below is **ILLUSTRATIVE of the Props shape only — NOT authoritative markup.** 01c never pins the board markup; the authoritative markup is whatever 01c's `tasks/board.astro` renders — transcribe THAT. Keep the Props type (it matches 01c's `taskBoard` shape).
```astro
---
// src/components/TaskBoardColumns.astro
interface BoardTask { id: string; title: string; due_date: string | null }
interface BoardColumn { status: { id: string; label: string; category: string; sort_order: number }; tasks: BoardTask[] }
interface Props { columns: BoardColumn[]; taskIds?: string[] }
const { columns, taskIds } = Astro.props
const allow = taskIds ? new Set(taskIds) : null
---
<div class="board" role="list">
  {columns.map((col) => {
    const tasks = allow ? col.tasks.filter((t) => allow.has(t.id)) : col.tasks
    return (
      <section class="board-col" role="listitem" aria-label={col.status.label}>
        <h2>{col.status.label}</h2>
        {tasks.length === 0
          ? <p class="empty">No tasks</p>
          : <ul>{tasks.map((t) => <li><a href={`/tasks/${t.id}`}>{t.title}</a></li>)}</ul>}
      </section>
    )
  })}
</div>
```

- [ ] **Step 3: Refactor `tasks/board.astro`** to import and render `<TaskBoardColumns columns={board.taskBoard} />` (no `taskIds`) in place of the inlined markup, then **re-run `pnpm --filter @movp/frontend-astro exec playwright test tasks` and confirm it is still GREEN** (the behaviour-preservation gate). 01c's `tests/e2e/tasks.spec.ts` board assertions and its axe pass must stay green — same result as the Step-2 baseline.

- [ ] **Step 4: Implement `campaigns/[id]/board.astro`** — fetch `campaignDetail(campaignId)` (for the deliverables' `taskId`s) and `TASK_BOARD_QUERY` (workspace board); compute `taskIds = campaignDetail.deliverables.map(d => d.taskId).filter(Boolean)`; render `<TaskBoardColumns columns={taskBoard} taskIds={taskIds} />`. Add `export { TASK_BOARD_QUERY } from './task-queries.ts'` (or import the Task phase's doc) to `campaign-queries.ts` so the board page has the query. `EmptyState` when the campaign has no backing tasks.
Run: `pnpm --filter @movp/frontend-astro exec playwright test campaigns tasks` → Expected: PASS (campaign board filters correctly; the Task board tests still green).

- [ ] **Step 5: Boundary + build gate**
Run:
```bash
bash scripts/check-boundary.sh && pnpm --filter @movp/frontend-astro build
```
Expected: boundary grep clean; Astro build succeeds (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`).

- [ ] **Step 6: Commit**
```bash
git add templates/frontend-astro/src/components/TaskBoardColumns.astro templates/frontend-astro/src/pages/tasks/board.astro templates/frontend-astro/src/pages/campaigns/\[id\]/board.astro templates/frontend-astro/src/lib/campaign-queries.ts templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/campaigns.spec.ts
git commit -m "feat(frontend): campaign deliverable board reusing the Task board (filtered to backing tasks)"
```

---

### Task 5: Reporting star-schema verification (pgTAP)

Prove the campaign reporting star schema: `campaign_metric` is a fact table (`value` = measure) surrounded by conformed dimensions, and the registry (`public.movp_fields`) reports the roles. This is a **test only** — no migration. It seeds two campaigns across two channels/statuses, asserts a `sum(value)` rollup grouped by `channel_type` + `status`, and asserts the `movp_fields` reporting roles.

**Files:**
- Create: `supabase/tests/campaign_reporting_test.sql`

- [ ] **Step 1: Write the failing pgTAP**

`supabase/tests/campaign_reporting_test.sql` (runs as the table owner — RLS bypassed; one channel per campaign so the metric→channel join stays 1:1, no cartesian blow-up):
```sql
begin;
select plan(8);

-- ── seed (as table owner) ────────────────────────────────────────────────────
insert into public.workspace (id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'RepWs') on conflict (id) do nothing;

-- Campaign A: status 'active', one 'email' channel.
insert into public.campaign (id, workspace_id, name, status)
  values ('cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-000000000001', 'A', 'active');
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name)
  values ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-0000000000a1', 'email', 'Email');
-- Campaign B: status 'scheduled', one 'paid' channel.
insert into public.campaign (id, workspace_id, name, status)
  values ('cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-000000000001', 'B', 'scheduled');
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name)
  values ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-0000000000b1', 'paid', 'Paid');

-- Fact rows: A gets 30+70=100 (email/active), B gets 25 (paid/scheduled).
insert into public.campaign_metric (workspace_id, campaign_id, channel_id, metric_key, value, measured_at) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-0000000000c1', 'clicks', 30, current_date),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-0000000000c1', 'clicks', 70, current_date),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000c2', 'clicks', 25, current_date);

-- ── fact rollup: sum(value) by channel_type + status (the star-schema query) ──
select is(
  (select sum(m.value)::int
     from public.campaign_metric m
     join public.campaign c on c.id = m.campaign_id
     join public.campaign_channel cc on cc.id = m.channel_id
    where cc.channel_type = 'email' and c.status = 'active'),
  100, 'email/active fact rollup = 100');
select is(
  (select sum(m.value)::int
     from public.campaign_metric m
     join public.campaign c on c.id = m.campaign_id
     join public.campaign_channel cc on cc.id = m.channel_id
    where cc.channel_type = 'paid' and c.status = 'scheduled'),
  25, 'paid/scheduled fact rollup = 25');
select is(
  (select count(*)::int from (
     select cc.channel_type, c.status
       from public.campaign_metric m
       join public.campaign c on c.id = m.campaign_id
       join public.campaign_channel cc on cc.id = m.channel_id
      group by cc.channel_type, c.status) g),
  2, 'group by channel_type,status yields 2 fact groups');

-- ── metadata registry: reporting roles (measure vs dimension) ────────────────
-- Field NAMES are the snake_case codegen columns. If Parts A/B registered camelCase
-- keys (e.g. 'measuredAt'), reconcile these `name=` literals.
select is((select reporting_role from public.movp_fields where collection_name='campaign_metric' and name='value'),
          'measure',  'campaign_metric.value is a measure');
select is((select reporting_role from public.movp_fields where collection_name='campaign_metric' and name='measured_at'),
          'dimension','campaign_metric.measured_at is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='campaign_channel' and name='channel_type'),
          'dimension','campaign_channel.channel_type is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='campaign' and name='status'),
          'dimension','campaign.status is a dimension');
select is((select reporting_role from public.movp_fields where collection_name='campaign' and name='priority'),
          'dimension','campaign.priority is a dimension');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify — it PASSES against the merged Parts A & B**

Run:
```bash
supabase db reset && supabase test db
```
Expected: `campaign_reporting_test.sql .. ok` (8 assertions). This test is red-by-construction ONLY if Parts A/B are missing/misnamed (a column/role mismatch fails a specific assertion) — that is the reconciliation signal. If the seed itself errors, a column name is wrong (see the reconciliation note) — fix the literal to match Part A's column, do NOT change the schema. Every other test file still `ok`.

> TDD note: this task has no product code to make green (Part C authors no migration). Its "red" state is a genuine assertion failure surfacing a Part A/B naming/role mismatch; its "green" state confirms the star schema. Treat a failure as a reconciliation task against Parts A/B, not as a Part C code change.

- [ ] **Step 3: Commit**
```bash
git add supabase/tests/campaign_reporting_test.sql
git commit -m "test(db): campaign reporting star-schema verification (fact rollup + movp_fields roles)"
```

---

### Task 6: End-to-end `[campaigns]` slice

Append a `[campaigns]` section to `scripts/slice-e2e.sh` implementing the roadmap verification. Base rows (`marketing_plan`, `campaign`, `campaign_deliverable`) are created via `psql` so required FK columns (`marketing_plan_id`, `campaign_id`), the scheduled `status`, and `start_date` are set deterministically — the committed generic `create<Pascal>` mutation SKIPS relation fields in its input and emits no update mutation, so it cannot set those FKs. The behaviours under test (assign/transition, scan, RLS reads) go through the real GraphQL/REST surfaces.

**Files:**
- Modify: `scripts/slice-e2e.sh` (insert the `[campaigns]` section immediately BEFORE the `echo "== [8] internal not exposed via PostgREST API =="` line)

**Interfaces consumed (committed slice helpers/vars — use EXACTLY these names):** `post_graphql` (uses the owner's global `$TOKEN`); `post_graphql_as` (token-scoped — already defined by the `[collab]` block above; reuse, do NOT redefine); `json_get`; `psql "$DB_URL"`; `$API_URL`, `$ANON_KEY`, `$SERVICE_ROLE_KEY`; `$WS` (workspace id — NOT `$WS_ID`), `$USER_ID` (owner), `$USER2_ID` (member), `$TOKEN2` (member JWT). Also: the task GraphQL surface (`createTask`, `assignTask`, `transitionTask` from the Task phase), Part B's bridge/scan, `public.edges`, `movp_internal.movp_events`.

- [ ] **Step 1: Add the `[campaigns]` section** to `scripts/slice-e2e.sh`:
```bash
echo "== [campaigns] plan -> campaign (psql: FK/status/date set) -> campaign.created + FK resolves =="
TODAY="$(date -u +%F)"
PLAN_ID="11111111-cccc-0000-0000-000000000001"
CAMP_ID="22222222-cccc-0000-0000-000000000001"
DELIV_ID="33333333-cccc-0000-0000-000000000001"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.marketing_plan (id, workspace_id, name, owner_id) values ('$PLAN_ID','$WS','E2E Plan','$USER_ID') on conflict (id) do nothing;" \
  -c "insert into public.campaign (id, workspace_id, name, marketing_plan_id, owner_id, status, start_date) values ('$CAMP_ID','$WS','E2E Campaign','$PLAN_ID','$USER_ID','scheduled','$TODAY') on conflict (id) do nothing;" \
  -c "insert into public.campaign_deliverable (id, workspace_id, campaign_id, name) values ('$DELIV_ID','$WS','$CAMP_ID','E2E Deliverable') on conflict (id) do nothing;"
CREATED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.created' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${CREATED:-0}" -ge 1 ] || { echo "no campaign.created event for $CAMP_ID (got $CREATED)"; exit 1; }
FK="$(psql "$DB_URL" -tAc "select marketing_plan_id from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$FK" = "$PLAN_ID" ] || { echo "campaign.marketing_plan_id did not resolve (got $FK)"; exit 1; }

echo "== [campaigns] create a backing task and link it (implemented_by edge) =="
TASK="$(post_graphql "{\"query\":\"mutation{createTask(workspaceId:\\\"$WS\\\", title:\\\"Backing task\\\"){id}}\"}")"
TASK_ID="$(echo "$TASK" | json_get data.createTask.id)"
[ -n "$TASK_ID" ] || { echo "createTask failed: $TASK"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values ('$WS','campaign_deliverable','$DELIV_ID','implemented_by','task','$TASK_ID') on conflict do nothing;"

echo "== [campaigns] assign the backing task -> bridge emits deliverable.assigned =="
post_graphql "{\"query\":\"mutation{assignTask(taskId:\\\"$TASK_ID\\\", userId:\\\"$USER2_ID\\\")}\"}" >/dev/null
ASSIGNED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='deliverable.assigned' and payload->>'entity_id'='$DELIV_ID';" | tr -d '[:space:]')"
[ "${ASSIGNED:-0}" -ge 1 ] || { echo "bridge did not emit deliverable.assigned for $DELIV_ID (got $ASSIGNED)"; exit 1; }

echo "== [campaigns] complete the backing task -> bridge emits deliverable.completed =="
DONE_ID="$(psql "$DB_URL" -tAc "select id from public.task_status_option where workspace_id='$WS' and category='done' limit 1;" | tr -d '[:space:]')"
[ -n "$DONE_ID" ] || { echo "no done-category status option for WS"; exit 1; }
post_graphql "{\"query\":\"mutation{transitionTask(taskId:\\\"$TASK_ID\\\", statusId:\\\"$DONE_ID\\\"){id completed_at}}\"}" >/dev/null
COMPLETED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='deliverable.completed' and payload->>'entity_id'='$DELIV_ID';" | tr -d '[:space:]')"
[ "${COMPLETED:-0}" -ge 1 ] || { echo "bridge did not emit deliverable.completed for $DELIV_ID (got $COMPLETED)"; exit 1; }

echo "== [campaigns] scan flips scheduled->active (campaign.started once); re-run emits nothing =="
psql "$DB_URL" -tAc "select public.scan_campaigns();" >/dev/null
STATUS="$(psql "$DB_URL" -tAc "select status from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$STATUS" = "active" ] || { echo "scan did not activate the campaign (got $STATUS)"; exit 1; }
STARTED1="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.started' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${STARTED1:-0}" -eq 1 ] || { echo "expected exactly one campaign.started (got $STARTED1)"; exit 1; }
psql "$DB_URL" -tAc "select public.scan_campaigns();" >/dev/null
STARTED2="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.started' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${STARTED2:-0}" -eq 1 ] || { echo "re-running scan emitted a duplicate campaign.started (got $STARTED2)"; exit 1; }

echo "== [campaigns] no-duplication gate: campaign_deliverable has no schedule/status/assignee columns =="
DUP_COLS="$(psql "$DB_URL" -tAc "select count(*) from information_schema.columns where table_schema='public' and table_name='campaign_deliverable' and column_name in ('start_date','due_date','status','status_id','priority','priority_id','assignee_user_id','completed_at');" | tr -d '[:space:]')"
[ "${DUP_COLS:-1}" -eq 0 ] || { echo "campaign_deliverable duplicates task fields (found $DUP_COLS)"; exit 1; }

echo "== [campaigns] a non-member sees 0 campaigns (GraphQL read under RLS) =="
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-camp-outsider@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN3="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-camp-outsider@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$TOKEN3" ] || { echo "failed to mint outsider token"; exit 1; }
OUT="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{campaigns(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
echo "$OUT" | grep -q "$CAMP_ID" && { echo "non-member could see the campaign: $OUT"; exit 1; }

echo "== [campaigns] a non-owner UPDATE is denied (owner-only RLS) =="
psql "$DB_URL" -tAc "update public.campaign set name='keep' where id='$CAMP_ID';" >/dev/null
curl -sS -X PATCH "$API_URL/rest/v1/campaign?id=eq.$CAMP_ID" \
  -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "Prefer: return=representation" \
  -d '{"name":"hijacked"}' >/dev/null
NAME="$(psql "$DB_URL" -tAc "select name from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$NAME" = "keep" ] || { echo "non-owner UPDATE mutated the campaign (name=$NAME)"; exit 1; }
```

- [ ] **Step 2: Gate**

Run:
```bash
bash -n scripts/slice-e2e.sh && bash scripts/slice-e2e.sh
```
Expected: `bash -n` clean (no syntax error); the slice ends `slice-e2e: PASS` with every `[campaigns]` assertion passing (`campaign.created` + FK; `deliverable.assigned`; `deliverable.completed`; scan activation + exactly-one `campaign.started` + idempotent re-run; no-duplication columns = 0; non-member sees 0; non-owner UPDATE leaves `name='keep'`).

> Reconciliation gotchas (inline): (1) `campaign.created` is **Part A's** event and now emits `{id, entity_type:'campaign', entity_id, status, marketing_plan_id}`, so the `payload->>'entity_id'='$CAMP_ID'` selector above is correct as written — do NOT change it. The `deliverable.assigned`/`deliverable.completed` events come from **Part B's** bridge; if Part B keys the deliverable under a different name than `entity_id` (e.g. `deliverable_id`), adjust those two selectors — Part B owns the bridge payload shape. (2) The non-owner-UPDATE assertion depends on Parts A/B having an owner-only UPDATE policy on `public.campaign` (the blanket codegen `campaign_rw` policy alone would ALLOW a member to update); if it is member-writable, this assertion fails — reconcile against Part A's RLS override, do not weaken the assertion.

- [ ] **Step 3: Commit**
```bash
git add scripts/slice-e2e.sh
git commit -m "test(e2e): campaigns lifecycle slice (plan->campaign, bridge, scan, no-dup, RLS)"
```

---

## Self-Review

- **Spec coverage (Part C scope):** three custom GraphQL READ queries — `deliverableSchedule` + its batched `deliverableSchedules` (Part B domain reads) + `campaignDetail` (BFF, `ctx.db` under RLS) — gated behind `refs.has('campaign_deliverable')` (Task 1, optional MCP/CLI custom read); five Astro routes — list, detail (target-vs-actual + stakeholders + discussion), timeline/Gantt, marketing calendar, deliverable board (Tasks 2–4); reporting star-schema pgTAP (Task 5); the `[campaigns]` e2e slice (Task 6). **No generic surface code is authored — codegen owns campaign CRUD** (Task 1's SDL gate asserts no Part-C `updateCampaign`/`deleteCampaign` and that the generic `campaigns`/`createCampaign` remain codegen's). Each task ends in a machine-checkable gate.
- **Correctness:** `deliverableSchedule`/`deliverableSchedules` match Part B's `CampaignService` signatures exactly; `campaignDetail`'s BFF logic (goal-target parse, actuals rollup by `metric_key`, batched backing-`taskId`, owner+observer stakeholders) is proven by a resolver-level test against a stubbed `ctx.db` (Task 1), since the frontend harness is mock-based; the deliverable board REUSES the Task board via `TaskBoardColumns` extracted VERBATIM from 01c (filtered by backing-task ids), not a re-implementation, with 01c's `tasks` spec GREEN before AND after; the reporting rollup joins the fact (`campaign_metric.value`) to its conformed dimensions (`channel_type`, `status`) and the registry roles are asserted; the e2e verifies the full roadmap (plan→campaign FK + `campaign.created`, bridge `deliverable.assigned`/`completed`, `scan_campaigns` activation + idempotent `campaign.started`, no-duplication columns, non-member 0-rows, non-owner UPDATE denied).
- **Safety:** custom reads run under the caller's RLS (member-scoped, non-internal tables) with no service-role/`process.env`; the frontend honours the boundary (GraphQL-over-HTTP only) — `check-boundary.sh` stays green; the e2e asserts cross-tenant isolation (outsider 0 rows) and owner-only writes.
- **Reliability:** `campaignDetail` batches all deliverables' backing-task ids in ONE `edges` read (no N+1) and tolerates null schedules; the e2e uses deterministic `psql` seeds for FK-bearing base rows (the generic create cannot set them) and asserts exactly-one `campaign.started` across a re-run (idempotency).
- **Observability:** events/notify are Part B's; the e2e asserts the emitted event types/counts by name (`campaign.created`, `deliverable.assigned`/`completed`, `campaign.started`) without logging payload values.
- **Efficiency / Performance:** the list/timeline/calendar use the generic list surface (id + scalar fields) and only per-campaign joins/jsonb go through `campaignDetail`; `campaignDetail` is a detail-route read (not a hot list path) with a batched edge read; the timeline/calendar issue ONE batched `deliverableSchedules` request for all deliverables (not an N-per-deliverable fan-out), bounded by a `first` cap, with a Playwright network assertion pinning the single request.
- **Simplicity:** three custom reads (two Part B domain reads — `deliverableSchedule` + batched `deliverableSchedules` — plus one BFF read forced by the generic surface's stringify-scalars/edge-relations/no-filter/create-only shape, documented in the Reconciliation note); no new collection, migration, queue, or generic surface; the board is a thin wrapper.
- **Usability:** every page states its auth-failure/loading/empty/error-retry states and keyboard/aria behaviour (sort controls `aria-pressed`/`aria-sort`; board columns `role=list`/`aria-label`); a mock-driven Playwright + axe smoke (via `/scenario`) covers list/detail/timeline/calendar/board.
- **Reconciliation surfaced (not hidden):** `campaignDetail` is a deliberate, documented deviation from the prompt's "only `deliverableSchedule`" framing, justified against the concrete committed generic surface (jsonb→`String`, relations via edges, create-only, no list filter). Column names in the selects and the reporting test are the snake_case codegen columns; the plan flags each place to reconcile if Parts A/B named a column/role/policy/payload-key differently — a mismatch is a reconciliation task, not a Part C code change.
