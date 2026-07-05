# MOVP App - Domain Workflows Phase 7, Part B: Automation Engine

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans`. This is an implementation plan, not implementation code.

**Goal:** Implement the `automate` branch of the flows worker: claim automate jobs, load enabled rules for the event, evaluate bounded JSON predicates against the single event payload, insert the `workflow_run` ledger first, dispatch actions exactly once, enforce a loop-depth cap, and expose a scoped `get_event(id, ws)` audit-read RPC.

**Architecture:** Part A made every event enqueue one `automate` job. Part B consumes those jobs in `packages/flows/src/flows-worker.ts`. The worker uses the service-role client because it reads `movp_internal.movp_events` and writes `workflow_run`, but every rule/action derives its target workspace from the event row's `workspace_id` and never from member-authored `action_config`. The action ledger row is inserted before side effects and every non-idempotent side effect receives a dedupe key `source_event_id || ':' || automation_rule_id`; the unique `(source_event_id, automation_rule_id)` is the ledger key, while the per-action dedupe key is what prevents duplicate tasks/advances after a crash.

**Tech Stack:** `@movp/flows`, `@movp/domain`, Supabase RPCs, `movp_jobs`, `workflow_run`, in-worker predicate evaluator, Vitest, pgTAP, definer-audit, jobs CI gate.

**This is Part B of Phase 7.** Precondition: Part A merged. Parts C/D consume the same predicate evaluator for webhook filters and rule-builder preview, so keep it pure and exported.

## Global Constraints

- **Single-payload evaluator:** reuse Segmentation's predicate node shape for consistency, but this evaluator checks one event payload object in TypeScript. It is not the set-based SQL compiler from app-04c.
- **No `eval`:** only bounded operators are allowed. Unknown operator, invalid path, max-depth breach, or max-node breach returns a stable validation error and disables/skips the rule fail-closed.
- **Exactly-once actions:** insert/upsert `workflow_run` first, then dispatch with a deterministic action dedupe key. Terminal outcomes are `succeeded`, `failed`, and `skipped`; `enqueued` is in-flight and may be retried, but every non-idempotent action must receive and enforce the dedupe key.
- **Tenant pinning:** every action handler MUST derive `workspaceId` from the loaded event row. `action_config.workspaceId` is ignored/rejected. Any config-supplied entity id (`segmentId`, `subscriptionId`, `deliverableId`, `taskId`) must be proven to belong to the event workspace before acting, otherwise the run is `skipped` with `cross_workspace_target` and no side effect.
- **Action availability:** `create_task`, `advance_deliverable`, and `recompute_segment` validate their phase dependency. If the phase method/RPC is absent, mark the run `skipped` with `phase_unavailable`; do not silently drop the rule.
- **Loop guard:** `emit_event` actions increment `depth`; at `MAX_WORKFLOW_DEPTH`, the action is skipped with `loop_depth_exceeded`.
- **Content discipline:** logs and run rows store event type, rule id, action type, error code, job id, trace id. Never log payload values, recipient emails, webhook secrets, or content bodies.

## File Structure

```text
packages/flows/src/
  condition.ts                        # NEW pure evaluator
  actions.ts                          # NEW action dispatcher helpers
  automation.ts                       # NEW automate job processor
  flows-worker.ts                     # UPDATE: call automate branch
  jobs.ts                             # UPDATE: enqueueJob kind type includes automate
  events.ts                           # UPDATE: helper accepts event ids/depth if needed
packages/flows/test/
  condition.test.ts                   # NEW
  automation.test.ts                  # NEW
  flows-worker.test.ts                # UPDATE
supabase/migrations/
  20260701000023_workflows_automation.sql # NEW
supabase/tests/
  workflows_automation_test.sql       # NEW
```

### Task 1: Pure bounded condition evaluator

**Files**

- Create: `packages/flows/src/condition.ts`
- Create: `packages/flows/test/condition.test.ts`

**Interfaces**

- Produces:

```ts
export type ConditionResult =
  | { ok: true; matched: boolean }
  | { ok: false; errorCode: 'condition_invalid' | 'condition_too_deep' | 'condition_too_large' | 'condition_unknown_operator' }

export function evaluateCondition(condition: unknown, payload: Record<string, unknown>): ConditionResult
```

- [ ] **Step 1: Write failing tests**

Cover:

- `null` / `{}` matches;
- `{ field:'entity_type', op:'eq', value:'task' }`;
- `neq`, `in`, `exists`, `gt`, `gte`, `lt`, `lte`;
- `and` / `or` / `not`;
- nested payload path `payload.status.to` using dot paths;
- invalid operator fails closed;
- depth > 5 and nodes > 50 fail closed.

Expected: FAIL - module does not exist.

- [ ] **Step 2: Implement the evaluator**

Resolve paths by own-property traversal only. Do not permit `__proto__`, `constructor`, or `prototype` path segments. Numeric operators only match numbers; strings that look numeric do not coerce silently.

Paste this implementation skeleton and keep the bounds/constants visible in the file:

```ts
const MAX_DEPTH = 5
const MAX_NODES = 50
const BLOCKED_PATH = new Set(['__proto__', 'prototype', 'constructor'])

function readPath(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload
  for (const part of path.split('.')) {
    if (!part || BLOCKED_PATH.has(part)) return undefined
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function visit(node: unknown, payload: Record<string, unknown>, depth: number, count: { n: number }): ConditionResult {
  if (depth > MAX_DEPTH) return { ok: false, errorCode: 'condition_too_deep' }
  if (++count.n > MAX_NODES) return { ok: false, errorCode: 'condition_too_large' }
  if (node == null || (typeof node === 'object' && Object.keys(node as object).length === 0)) return { ok: true, matched: true }
  if (typeof node !== 'object') return { ok: false, errorCode: 'condition_invalid' }
  const n = node as Record<string, unknown>

  if (Array.isArray(n.and)) {
    for (const child of n.and) {
      const r = visit(child, payload, depth + 1, count)
      if (!r.ok || !r.matched) return r
    }
    return { ok: true, matched: true }
  }
  if (Array.isArray(n.or)) {
    let any = false
    for (const child of n.or) {
      const r = visit(child, payload, depth + 1, count)
      if (!r.ok) return r
      any ||= r.matched
    }
    return { ok: true, matched: any }
  }
  if ('not' in n) {
    const r = visit(n.not, payload, depth + 1, count)
    return r.ok ? { ok: true, matched: !r.matched } : r
  }

  if (typeof n.field !== 'string' || typeof n.op !== 'string') return { ok: false, errorCode: 'condition_invalid' }
  const actual = readPath(payload, n.field)
  switch (n.op) {
    case 'exists': return { ok: true, matched: actual !== undefined }
    case 'eq': return { ok: true, matched: actual === n.value }
    case 'neq': return { ok: true, matched: actual !== n.value }
    case 'in': return { ok: true, matched: Array.isArray(n.value) && n.value.includes(actual) }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof actual !== 'number' || typeof n.value !== 'number') return { ok: true, matched: false }
      if (n.op === 'gt') return { ok: true, matched: actual > n.value }
      if (n.op === 'gte') return { ok: true, matched: actual >= n.value }
      if (n.op === 'lt') return { ok: true, matched: actual < n.value }
      return { ok: true, matched: actual <= n.value }
    default:
      return { ok: false, errorCode: 'condition_unknown_operator' }
  }
}

export function evaluateCondition(condition: unknown, payload: Record<string, unknown>): ConditionResult {
  return visit(condition, payload, 0, { n: 0 })
}
```

**Gate**

```sh
pnpm --filter @movp/flows test -- condition
```

Expected: PASS.

### Task 2: Scoped event audit-read RPC

**Files**

- Create: `supabase/migrations/20260701000023_workflows_automation.sql`
- Create: `supabase/tests/workflows_automation_test.sql`

**Interfaces**

- Produces: `public.get_event(ev_id uuid, ws uuid) returns jsonb`, hardened definer, membership-gated before returning a `movp_internal.movp_events` row.

- [ ] **Step 1: Write failing pgTAP**

Assertions:

- member can read an event in their workspace;
- non-member gets `null`;
- wrong workspace gets `null`;
- returned JSON includes `id`, `type`, `workspace_id`, `payload`, `trace_id`, `created_at`;
- no direct `authenticated` SELECT on `movp_internal.movp_events`.

Expected: FAIL - `get_event` missing.

- [ ] **Step 2: Add the RPC**

Use `security definer set search_path=''`. First check `public.is_workspace_member(ws)` under caller auth, then select the event by id and workspace. Grant execute to `authenticated`; revoke from `anon`.

**Gate**

```sh
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```

Expected: `workflows_automation_test.sql .. ok`; definer audit passes; diff empty.

### Task 3: Automate job processor and exactly-once ledger

**Files**

- Create: `packages/flows/src/automation.ts`
- Update: `packages/flows/src/flows-worker.ts`
- Update: `packages/flows/src/jobs.ts`
- Create: `packages/flows/test/automation.test.ts`

**Interfaces**

- Consumes: `claimDueJobs(db, 'automate', limit)`, `completeJob`, `automation_rule`, `workflow_run`, `movp_internal.movp_events`.
- Produces:

```ts
export async function runAutomationWorker(db: SupabaseClient, limit?: number): Promise<{ processed: number; failed: number }>
```

- [ ] **Step 1: Write failing unit tests with a stub db**

Tests must prove:

- one event with two enabled matching rules creates two run rows ordered by `priority`;
- a non-matching condition inserts a run with `matched=false`, `outcome='skipped'`, no side effect;
- retry of the same job does not dispatch the same rule action twice;
- crash after dispatch but before outcome update does not duplicate a non-idempotent `create_task` action because the action receives the same dedupe key;
- a ws-A rule whose config points at ws-B is skipped with `cross_workspace_target` and creates/updates nothing in ws-B;
- invalid condition marks `condition_invalid` and does not throw away the whole job.

Expected: FAIL - processor missing.

- [ ] **Step 2: Implement ledger-first processing**

Processing order:

1. claim automate jobs;
2. load event by `payload.event_id`;
3. load enabled `automation_rule` rows for that workspace/event ordered by `priority asc, created_at asc`;
4. evaluate condition;
5. insert `workflow_run` with `(source_event_id, automation_rule_id, outcome='enqueued')` before dispatch;
6. if a conflicting row is terminal (`succeeded`, `failed`, `skipped`), skip dispatch;
7. if a conflicting row is `enqueued`, retry dispatch with the same action dedupe key;
8. dispatch action with `{ workspaceId: event.workspace_id, dedupeKey: event.id + ':' + rule.id }`;
9. update run outcome/error/job id;
10. complete the job.

Expected error codes: `event_not_found`, `condition_invalid`, `phase_unavailable`, `cross_workspace_target`, `action_config_invalid`, `action_dispatch_failed`, `loop_depth_exceeded`.

Use this loop shape; fill in only the local db wrapper details required by the Supabase client:

```ts
const TERMINAL = new Set(['succeeded', 'failed', 'skipped'])

export async function runAutomationWorker(db: SupabaseClient, limit = 10): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const job of await claimDueJobs(db, 'automate', limit)) {
    try {
      const eventId = stringField(job.payload.event_id)
      if (!eventId) throw new Error('event_not_found')
      const event = await loadInternalEvent(db, eventId, job.workspace_id)
      if (!event) throw new Error('event_not_found')
      const rules = await loadEnabledRules(db, event.workspace_id, event.type)
      for (const rule of rules) {
        const dedupeKey = `${event.id}:${rule.id}`
        const condition = evaluateCondition(rule.condition, { event_type: event.type, ...event.payload })
        if (!condition.ok) {
          await upsertRun(db, { event, rule, matched: false, outcome: 'skipped', errorCode: condition.errorCode })
          continue
        }
        const inserted = await insertRunIfAbsent(db, { event, rule, matched: condition.matched, outcome: 'enqueued' })
        if (!inserted && TERMINAL.has(await currentRunOutcome(db, event.id, rule.id))) continue
        if (!condition.matched) {
          await finishRun(db, event.id, rule.id, { outcome: 'skipped' })
          continue
        }
        const result = await dispatchWorkflowAction(db, {
          workspaceId: event.workspace_id,
          event,
          rule,
          dedupeKey,
        })
        await finishRun(db, event.id, rule.id, result.ok
          ? { outcome: result.outcome, jobId: result.jobId ?? null }
          : { outcome: 'failed', errorCode: result.errorCode })
      }
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

- [ ] **Step 3: Wire flows-worker**

`runFlowsWorker` currently handles `notify` and `webhook`. Add `automate` processing after notify and before webhook; rule-enqueued webhook jobs may be delivered in the same worker invocation after the automate branch reaches the existing webhook branch. Keep existing notify/webhook behavior unchanged.

**Gate**

```sh
pnpm --filter @movp/flows test -- automation flows-worker
```

Expected: PASS; existing notify/webhook tests still pass.

### Task 4: Action dispatcher

**Files**

- Create: `packages/flows/src/actions.ts`
- Update: `packages/flows/src/automation.ts`
- Update: `packages/flows/test/automation.test.ts`

**Interfaces**

- Produces six action handlers:
  - `notify` -> enqueue Core `notify` job with recipient fields already in config/payload.
  - `deliver_webhook` -> enqueue a Core `webhook` job for a **validated same-workspace `webhook_subscription`** id from Part C; if no subscription id is configured, skip with `action_config_invalid`.
  - `create_task` -> `createDomain({db,userId: actor}).task.create({workspaceId: event.workspace_id, title, description, statusId, priorityId, parentId, startDate, dueDate, idempotencyKey: dedupeKey })`. If the Task service has not yet accepted `idempotencyKey`, this task must add that optional field/RPC idempotency gate before enabling the action.
  - `advance_deliverable` -> Campaign service from app-03b with `{ workspaceId: event.workspace_id, deliverableId, dedupeKey }`; first verify the deliverable belongs to the event workspace. If absent in `createDomain`, skip with `phase_unavailable`.
  - `recompute_segment` -> enqueue the app-04c `segment_recompute` job with idempotency key `dedupeKey`; first verify `segment_id` belongs to `event.workspace_id`. If the job kind/table/RPC is absent, skip with `phase_unavailable`.
  - `emit_event` -> `db.rpc('emit_event', { ev_type, ws, payload: {..., depth: depth + 1}, trace })`.

- [ ] **Step 1: Write failing dispatcher tests**

Use dependency injection to stub:

- `enqueueJob`;
- `createDomain`;
- `db.rpc`.

Assert each action validates required config keys and returns stable error codes without payload values.
Also assert every action ignores/rejects `action_config.workspaceId`; the event row workspace is the only workspace input.

Expected: FAIL - action dispatcher missing.

- [ ] **Step 2: Implement handlers conservatively**

Do not invent Campaign/Segmentation signatures. Bind to real interfaces at execution time, but keep these decisions fixed:

- Task signature is already in `packages/domain/src/types.ts`: `task.create({ workspaceId, title, description?, statusId?, priorityId?, parentId?, startDate?, dueDate? })`.
- `recompute_segment` uses the queued `segment_recompute` job, not the synchronous RPC, so retries are keyed and bounded.
- `deliver_webhook` targets a concrete `webhook_subscription` id and validates it belongs to the event workspace.
- Campaign and Segmentation phases must be merged before app-06 executes; read `packages/domain/src/types.ts` after those phases and update the handler to exact signatures. If the method is absent, the validation test must prove `phase_unavailable`.

The dispatcher must centralize tenant pinning:

```ts
export async function dispatchWorkflowAction(db: SupabaseClient, input: {
  workspaceId: string
  event: MovpInternalEvent
  rule: AutomationRuleRow
  dedupeKey: string
}): Promise<{ ok: true; outcome: 'succeeded' | 'enqueued'; jobId?: string } | { ok: false; errorCode: string }> {
  const cfg = input.rule.action_config as Record<string, unknown>
  if (typeof cfg.workspaceId === 'string' && cfg.workspaceId !== input.workspaceId) {
    return { ok: false, errorCode: 'cross_workspace_target' }
  }
  switch (input.rule.action_type) {
    case 'notify':
      return enqueueNotifyForWorkspace(db, input.workspaceId, cfg, input.dedupeKey)
    case 'deliver_webhook':
      return enqueueSubscriptionWebhook(db, input.workspaceId, cfg.subscriptionId, input.event, input.dedupeKey)
    case 'create_task':
      return createTaskForWorkspace(db, input.workspaceId, cfg, input.dedupeKey)
    case 'advance_deliverable':
      return advanceDeliverableForWorkspace(db, input.workspaceId, cfg.deliverableId, input.dedupeKey)
    case 'recompute_segment':
      return enqueueSegmentRecomputeForWorkspace(db, input.workspaceId, cfg.segmentId, input.dedupeKey)
    case 'emit_event':
      return emitChainedEvent(db, input.workspaceId, input.event, cfg)
    default:
      return { ok: false, errorCode: 'action_config_invalid' }
  }
}
```

Every helper above first proves any supplied id belongs to `input.workspaceId` using a workspace-filtered SELECT/RPC. A missing row and a foreign-workspace row both return `cross_workspace_target`. The write always uses `input.workspaceId` (the event row's workspace), never `cfg.workspaceId`. This is the load-bearing tenant-isolation code — implement it as concrete SELECT-then-act, not prose. Canonical shape (the id-taking helpers follow this exactly; `enqueueJob` is the real signature from `packages/flows/src/jobs.ts`):

```ts
type ActionResult =
  | { ok: true; outcome: 'succeeded' | 'enqueued'; jobId?: string }
  | { ok: false; errorCode: string }

async function enqueueSubscriptionWebhook(
  db: SupabaseClient,
  workspaceId: string,
  subscriptionId: unknown,
  event: MovpInternalEvent,
  dedupeKey: string,
): Promise<ActionResult> {
  if (typeof subscriptionId !== 'string') return { ok: false, errorCode: 'action_config_invalid' }
  // Prove ownership: id AND workspace_id must match, before any side effect.
  const { data, error } = await db
    .from('webhook_subscription')
    .select('id')
    .eq('id', subscriptionId)
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .maybeSingle()
  if (error) return { ok: false, errorCode: 'action_dispatch_failed' }
  if (!data) return { ok: false, errorCode: 'cross_workspace_target' } // missing OR foreign-workspace
  await enqueueJob(db, {
    kind: 'webhook',
    idempotencyKey: dedupeKey, // (event.id:rule.id) => idempotent under retry
    payload: { event: event.type, subscription_id: subscriptionId },
    workspaceId, // always the event workspace, never cfg.workspaceId
  })
  return { ok: true, outcome: 'enqueued' }
}
```

`enqueueSegmentRecomputeForWorkspace` and `advanceDeliverableForWorkspace` follow the same SELECT-then-act shape against `segment` / `campaign_deliverable`; when that table/job-kind/RPC is absent (Segmentation/Campaigns not yet merged) they return `phase_unavailable` instead of `cross_workspace_target`. `createTaskForWorkspace` skips the ownership SELECT (it creates a new row) but MUST pass `{ workspaceId: input.workspaceId, idempotencyKey: dedupeKey }` to `task.create` (app-01c must accept the optional `idempotencyKey` before this action is enabled). `enqueueJob`'s `kind` union must be widened to include every enqueued kind (`automate`, plus `segment_recompute` if the recompute action enqueues rather than RPC-calls).

**Gate**

```sh
pnpm --filter @movp/flows test -- automation
```

Expected: PASS.

### Task 5: Canonical seeded rules and failure-mode pgTAP

**Files**

- Update: `supabase/migrations/20260701000023_workflows_automation.sql`
- Update: `supabase/tests/workflows_automation_test.sql`

**Interfaces**

- Produces seedable default rules, disabled when their required phase/action is absent.

- [ ] **Step 1: Add failing SQL tests**

Test:

- `deliverable.due_soon` default rules exist disabled until Campaigns/Task are present;
- `content.approved` -> `advance_deliverable` rule is disabled if Campaign service is unavailable;
- `segment.membership_changed` -> `recompute_segment` exists only after `segment` table/RPC exists;
- rule inserts reject unknown event types and unknown action types.

Expected: FAIL until seed/validation SQL exists.

- [ ] **Step 2: Add validation constraints**

Use FK to `event_type` for `trigger_event_type_id`, enum check from codegen for `action_type`, and a lightweight JSON shape check for `condition`/`action_config`. Deep validation remains in worker tests.

**Gate**

```sh
supabase db reset && supabase test db && pnpm --filter @movp/flows test && supabase db diff
```

Expected: PASS, diff empty.

### Task 6: Part B integration and commit

**Files**

- Update: package exports if needed (`packages/flows/src/index.ts`)

- [ ] **Step 1: Full verification**

```sh
pnpm --filter @movp/flows test
pnpm --filter @movp/flows typecheck
supabase db reset
supabase test db
node scripts/check-definer-audit.mjs
supabase db diff
```

Expected: all pass.

- [ ] **Step 2: Commit**

```sh
git add packages/flows supabase/migrations/20260701000023_workflows_automation.sql supabase/tests/workflows_automation_test.sql
git commit -m "feat(workflows): process automation rules exactly once"
```

## Self-Review

- **Correctness:** Worker binds to actual Task signature and explicitly validates/marks absent Campaign/Segmentation actions; condition evaluator tests both match and no-match paths.
- **Safety:** Service-role worker never exposes internal tables; payload evaluator blocks prototype path segments; action validation rejects unknown actions.
- **Reliability:** Ledger-first unique key makes actions exactly once under retries; invalid rules are skipped with stable codes.
- **Observability:** Every rule firing gets a `workflow_run` row with outcome/error/job/trace.
- **Efficiency:** Rules are loaded only for the event type/workspace; no full scan across workspaces.
- **Performance:** Priority query is indexed by Part A; evaluator has max depth/node bounds.
- **Simplicity:** Pure evaluator and dispatcher keep the worker branch readable.
- **Usability:** Operators get audit rows for matched, skipped, failed, and enqueued actions; UI lands in Part D.
