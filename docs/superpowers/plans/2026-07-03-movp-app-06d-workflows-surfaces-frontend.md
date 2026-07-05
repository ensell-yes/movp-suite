# MOVP App - Domain Workflows Phase 7, Part D: Surfaces, Admin Frontend, and End-to-End Slice

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans`. This is an implementation plan, not implementation code.

**Goal:** Surface workflows for operators: GraphQL/MCP/CLI custom workflow operations, Astro admin pages for rules/webhooks/audit, a dead-job replay affordance, and a `[workflows]` e2e slice that proves event -> automation -> action -> webhook/audit behavior.

**Architecture:** Codegen generic surfaces expose the non-internal config/read collections (`automation_rule`, `webhook_subscription` read, `workflow_run` read, `event_type` read) where safe, but workflow operations need custom mutations for validation and secret handling. Frontend follows the existing Astro pattern: server-side GraphQL via `gqlRequest`, httpOnly session token, state components, no service-role code under `templates/`. The audit view lists `workflow_run` through the generated `workflow_runs(workspaceId, first, after)` query and reads event details through the scoped `get_event` RPC-backed custom query.

**Tech Stack:** `packages/graphql`, `packages/mcp`, `packages/cli`, `@movp/domain`, Astro template (`templates/frontend-astro`), Playwright/axe, `scripts/slice-e2e.sh`, CI gates (`boundary`, `graphql-shape`, `redaction`, `jobs`, `internal-access`).

**This is Part D of Phase 7.** Precondition: Parts A-C merged. No new migration unless Part B did not add `get_event`; if absent, stop and add it to Part B rather than hiding it here.

## Global Constraints

- **No secret in generic surfaces:** webhook register/rotate returns a secret once from custom mutations/tools only; list/get never include it.
- **Unavailable actions disabled:** UI and API validation must explain `phase_unavailable` for rules whose action depends on a phase not built/merged.
- **Server-side auth only:** browser code never calls GraphQL directly and never sees service-role or webhook secret except the one-time operator display returned by register/rotate.
- **Audit payload redaction:** event payload viewer may show IDs/classifiers needed for debugging, but no recipient emails, webhook secrets, content bodies, or arbitrary payload values in logs/tests. If a payload contains PII from older emitters, render keys and redacted summaries.
- **Do not weaken generic-surface skip rules:** internal collections remain skipped; custom surfaces must call domain/RPC wrappers.

## File Structure

```text
packages/domain/src/
  workflows.ts                        # NEW service wrapper
  domain.ts                           # UPDATE createDomain
  types.ts                            # UPDATE WorkflowService
packages/graphql/src/
  schema.ts                           # UPDATE custom workflow fields
  types.ts                            # UPDATE context if needed
packages/graphql/test/
  workflows.test.ts                   # NEW
packages/mcp/src/server.ts            # UPDATE workflow tools
packages/mcp/test/server.test.ts      # UPDATE
packages/cli/src/program.ts           # UPDATE movp workflows/webhooks commands
packages/cli/test/program.test.ts     # UPDATE
templates/frontend-astro/src/
  lib/workflow-queries.ts             # NEW
  pages/workflows/rules.astro         # NEW
  pages/workflows/webhooks.astro      # NEW
  pages/workflows/runs.astro          # NEW
  pages/api/workflows/rule-preview.ts # NEW if island needs preview
scripts/slice-e2e.sh                  # UPDATE [workflows] section
```

### Task 1: Domain workflow service wrapper

**Files**

- Create: `packages/domain/src/workflows.ts`
- Update: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`, `packages/domain/src/index.ts`
- Create: `packages/domain/test/workflows.integration.test.ts`

**Interfaces**

- Produces `WorkflowService`:

```ts
export interface WorkflowService {
  listEventTypes(a: { first?: number; after?: string | null }): Promise<Page<EventTypeRow>>
  listRules(a: { workspaceId: string; first?: number; after?: string | null }): Promise<Page<AutomationRuleRow>>
  upsertRule(i: { workspaceId: string; id?: string; name: string; triggerEventTypeId: string; condition?: unknown; actionType: string; actionConfig: unknown; enabled: boolean; priority: number }): Promise<AutomationRuleRow>
  getEvent(a: { workspaceId: string; eventId: string }): Promise<Record<string, unknown> | null>
  registerWebhook(i: { workspaceId: string; eventKey: string; url: string; filter?: unknown }): Promise<{ subscriptionId: string; secret: string }>
  rotateWebhook(i: { workspaceId: string; subscriptionId: string }): Promise<{ subscriptionId: string; secret: string }>
  setWebhookActive(i: { workspaceId: string; subscriptionId: string; active: boolean }): Promise<WebhookSubscriptionRow>
  setWebhookFilter(i: { workspaceId: string; subscriptionId: string; filter: unknown }): Promise<WebhookSubscriptionRow>
}
```

- [ ] **Step 1: Write failing integration tests**

Test against local Supabase:

- list event types returns global catalog for an authenticated member;
- upsert rule validates event/action and writes workspace row;
- register/rotate call RPCs and never persist `secret`;
- getEvent returns null for wrong workspace.

Expected: FAIL - service missing.

- [ ] **Step 2: Implement wrapper**

Use `ctx.db` and existing RPCs. All failures go through the domain `fail(op, code)` pattern used by `content.ts`, with stable codes only.

Use this wrapper shape:

```ts
export function makeWorkflowService(ctx: DomainCtx): WorkflowService {
  return {
    listEventTypes: (a) => page(ctx.db.from('event_type').select('*').eq('active', true), a),
    listRules: (a) => page(ctx.db.from('automation_rule').select('*').eq('workspace_id', a.workspaceId), a),
    async upsertRule(input) {
      const row = {
        workspace_id: input.workspaceId,
        name: input.name,
        trigger_event_type_id: input.triggerEventTypeId,
        condition: input.condition ?? {},
        action_type: input.actionType,
        action_config: input.actionConfig,
        enabled: input.enabled,
        priority: input.priority,
      }
      const q = input.id
        ? ctx.db.from('automation_rule').update(row).eq('id', input.id).eq('workspace_id', input.workspaceId).select('*').single()
        : ctx.db.from('automation_rule').insert(row).select('*').single()
      const { data, error } = await q
      if (error || !data) throw fail('upsertRule', error?.code ?? 'not_found')
      return data
    },
    async getEvent(a) {
      const { data, error } = await ctx.db.rpc('get_event', { ev_id: a.eventId, ws: a.workspaceId })
      if (error) throw fail('getEvent', error.code ?? 'unknown')
      return data as Record<string, unknown> | null
    },
    async registerWebhook(i) {
      const { data, error } = await ctx.db.rpc('register_webhook_subscription', { ws: i.workspaceId, event_key: i.eventKey, hook_url: i.url, filter: i.filter ?? null })
      if (error) throw fail('registerWebhook', error.code ?? 'unknown')
      return { subscriptionId: String(data.subscription_id), secret: String(data.secret) }
    },
    async rotateWebhook(i) {
      const { data, error } = await ctx.db.rpc('rotate_webhook_secret', { subscription_id: i.subscriptionId, ws: i.workspaceId })
      if (error) throw fail('rotateWebhook', error.code ?? 'unknown')
      return { subscriptionId: String(data.subscription_id), secret: String(data.secret) }
    },
    setWebhookActive: async (i) => rpcRow(ctx, 'set_webhook_active', { subscription_id: i.subscriptionId, ws: i.workspaceId, active: i.active }, 'setWebhookActive'),
    setWebhookFilter: async (i) => rpcRow(ctx, 'set_webhook_filter', { subscription_id: i.subscriptionId, ws: i.workspaceId, filter: i.filter }, 'setWebhookFilter'),
  }
}
```

**Gate**

```sh
pnpm --filter @movp/domain test -- workflows.integration && pnpm --filter @movp/domain typecheck
```

Expected: PASS.

### Task 2: GraphQL custom workflow API

**Files**

- Update: `packages/graphql/src/schema.ts`
- Create: `packages/graphql/test/workflows.test.ts`

**Interfaces**

- Produces:
  - Queries: `eventTypes`, `automationRules(workspaceId, ...)`, `workflowEvent(workspaceId,eventId)`. Use the generated `workflow_runs(workspaceId, first, after)` query for audit lists; do not add a redundant custom `workflowRuns` resolver.
  - Mutations: `upsertAutomationRule`, `registerWebhookSubscription`, `rotateWebhookSecret`, `setWebhookActive`, `setWebhookFilter`, `replayDeadWorkflowJobs`.

- [ ] **Step 1: Write failing GraphQL tests**

Tests must assert:

- complexity/page size clamp on list queries;
- register returns `secret` once;
- list/get subscription fields never include secret;
- `workflowEvent` calls the service with workspace id;
- over-depth query still rejected by existing GraphQL shape gate.

Expected: FAIL - fields missing.

- [ ] **Step 2: Implement schema fields**

Reuse `domainFrom(ctx).workflows`. Do not expose `movp_internal` IDs except `internal_webhook_id` if already present in the public row; never expose secret except register/rotate mutation return.

Use this GraphQL shape:

```ts
builder.queryField('workflowEvent', (t) => t.field({
  type: 'String',
  nullable: true,
  args: { workspaceId: t.arg.id({ required: true }), eventId: t.arg.id({ required: true }) },
  resolve: async (_r, args, ctx) => JSON.stringify(await domainFrom(ctx).workflows.getEvent({
    workspaceId: String(args.workspaceId),
    eventId: String(args.eventId),
  })),
}))

builder.mutationField('registerWebhookSubscription', (t) => t.field({
  type: webhookSecretRef,
  args: {
    workspaceId: t.arg.id({ required: true }),
    eventKey: t.arg.string({ required: true }),
    url: t.arg.string({ required: true }),
    filter: t.arg.string({ required: false }),
  },
  resolve: (_r, args, ctx) => domainFrom(ctx).workflows.registerWebhook({
    workspaceId: String(args.workspaceId),
    eventKey: args.eventKey,
    url: args.url,
    filter: args.filter ? JSON.parse(args.filter) : undefined,
  }),
}))
```

Add sibling mutations for rotate/active/filter using the same service methods; only register/rotate return `secret`.

**Gate**

```sh
pnpm --filter @movp/graphql test -- workflows schema && pnpm --filter @movp/graphql typecheck
```

Expected: PASS.

### Task 3: MCP and CLI workflow surfaces

**Files**

- Update: `packages/mcp/src/server.ts`, `packages/mcp/test/server.test.ts`
- Update: `packages/cli/src/program.ts`, `packages/cli/test/program.test.ts`

**Interfaces**

- MCP tools:
  - `workflow.event_types`
  - `workflow.rules.list`
  - `workflow.rules.upsert`
- `workflow.runs.list` wraps the generated `workflow_run.list`/`workflow_runs` read and adds no bespoke DB path.
  - `workflow.webhook.register`
  - `workflow.webhook.rotate`
  - `workflow.webhook.active`
  - `workflow.jobs.replay_dead`
- CLI commands:
  - `movp workflows events`
  - `movp workflows rules list/upsert`
  - `movp workflows runs`
  - `movp workflows webhooks register/rotate/activate/deactivate`
  - `movp workflows replay --dead`

- [ ] **Step 1: Write failing tests**

Assert command/tool registration and that secret appears only in register/rotate output.

Expected: FAIL - surfaces missing.

- [ ] **Step 2: Implement surfaces**

Parse JSON flags for condition/action/filter. Keep command names under `workflows` to avoid colliding with generic `webhook_subscription` list/get surfaces.

For CLI JSON flags, parse once and fail with `invalid_json` before calling the service:

```ts
function parseJsonFlag(value: string | undefined, fallback: unknown): unknown {
  if (value == null) return fallback
  try { return JSON.parse(value) } catch { throw new Error('invalid_json') }
}
```

**Gate**

```sh
pnpm --filter @movp/mcp test && pnpm --filter @movp/cli test && pnpm --filter @movp/mcp typecheck && pnpm --filter @movp/cli typecheck
```

Expected: PASS.

### Task 4: Astro admin pages

**Files**

- Create: `templates/frontend-astro/src/lib/workflow-queries.ts`
- Create: `templates/frontend-astro/src/pages/workflows/rules.astro`
- Create: `templates/frontend-astro/src/pages/workflows/webhooks.astro`
- Create: `templates/frontend-astro/src/pages/workflows/runs.astro`
- Create/update: frontend tests

**Interfaces**

- Consumes: GraphQL fields from Task 2 and existing `Base.astro`, `gqlRequest`, `getSessionToken`, `AuthFailure`, `EmptyState`, `ErrorRetry`, `LoadingState`.
- Produces three admin views:
  - Rule builder: event type select, condition JSON editor, action type/config editor, priority/enabled controls, validation errors.
  - Webhook manager: subscriptions list, register form, rotate, activate/deactivate, filter editor, one-time secret display.
  - Audit viewer: workflow run table, filters, event payload drilldown through `workflowEvent`, replay dead jobs.

- [ ] **Step 1: Write failing Playwright/Vitest tests**

Cover empty/loading/error/auth states, keyboard focus order, register secret shown once, conflict/error banner does not blank forms, and no secret appears after refresh.

Expected: FAIL - pages missing.

- [ ] **Step 2: Implement pages**

Use restrained dashboard layout consistent with existing content/task pages. Do not add marketing hero sections. Keep forms dense and predictable. The condition/action config may be JSON textareas in v1, but validation errors must point to the field.

Each page frontmatter follows this pattern:

```astro
---
import Base from '../../layouts/Base.astro'
import AuthFailure from '../../components/states/AuthFailure.astro'
import ErrorRetry from '../../components/states/ErrorRetry.astro'
import EmptyState from '../../components/states/EmptyState.astro'
import { readServerEnv } from '../../lib/env.ts'
import { gqlRequest } from '../../lib/graphql.ts'
import { getSessionToken } from '../../lib/session.ts'
import { WORKFLOW_RULES_QUERY } from '../../lib/workflow-queries.ts'

const token = getSessionToken(Astro.cookies)
if (!token) return Astro.redirect('/?auth=required')
const { graphqlEndpoint, workspaceId } = readServerEnv()
const result = await gqlRequest({ endpoint: graphqlEndpoint, token }, WORKFLOW_RULES_QUERY, { workspaceId })
const state = !result.ok && result.code === 'auth_error' ? 'auth' : result.ok ? 'ok' : 'error'
---
<Base title="Workflows">
  {state === 'auth' && <AuthFailure />}
  {state === 'error' && <ErrorRetry message="Could not load workflows." />}
  {state === 'ok' && result.data.automationRules.items.length === 0 && <EmptyState title="No workflow rules" />}
  {state === 'ok' && result.data.automationRules.items.length > 0 && <table>{/* dense rows */}</table>}
</Base>
```

**Gate**

```sh
pnpm --filter @movp/frontend-astro test && pnpm --filter @movp/frontend-astro typecheck && bash scripts/check-boundary.sh && ! rg -n "runtime\\.env|Astro\\.locals\\.runtime" templates/frontend-astro/src
```

Expected: PASS; boundary gate proves no domain/auth/service-role imports under `templates/`; the negative grep prints no `runtime.env` anti-patterns. It targets `Astro.locals.runtime` (the forbidden `runtime.env`/`runtime.ctx` root) specifically, so a legitimate `Astro.locals.cfContext` — the sanctioned execution-context accessor — is not falsely rejected.

### Task 5: `[workflows]` slice-e2e

**Files**

- Update: `scripts/slice-e2e.sh`

**Interfaces**

- Consumes existing slice helpers: `$DB_URL`, `$WS`, `$USER_ID`, `$USER2_ID`, `$TOKEN`, `$TOKEN2`, `post_graphql`, `post_graphql_as`, `json_get`, `supabase functions serve` if already used by prior slices.
- Produces end-to-end proof for roadmap verification items 1-8.

- [ ] **Step 1: Add the failing slice block**

Append a `[workflows]` block that:

1. asserts `event_type` includes `task.completed`, `content.approved`, `segment.membership_changed`;
2. creates an automation rule for `task.completed -> notify` and emits the event;
3. runs flows worker and asserts one `workflow_run` and no duplicate action after replay;
4. registers a webhook, emits a matching event, verifies HMAC signature at the local test receiver;
5. rotates secret and proves old signature fails/new succeeds;
6. deactivates webhook and proves no delivery;
7. sets a non-matching filter and proves skipped/no fetch;
8. non-member sees zero rules/subscriptions/runs and cannot rotate;
9. loop guard halts a chained `emit_event` rule at max depth;
10. redaction grep finds no webhook secret/email/content body in `workflow_run`/logs.

Expected before implementation: FAIL at the first missing GraphQL/RPC/surface call if any prior task is incomplete.

- [ ] **Step 2: Make the slice deterministic**

Use fixed ids where possible, `ON_ERROR_STOP=1`, no `|| true` on required assertions, and explicit counts. Cleanup/negative probes may tolerate non-zero only when the following assertion proves state.

**Gate**

```sh
bash -n scripts/slice-e2e.sh && bash scripts/slice-e2e.sh
```

Expected: `slice-e2e: PASS` with `[workflows]` assertions logged.

### Task 6: README update, CI gates, and commit

**Files**

- Update: `docs/superpowers/plans/README.md`
- Update CI/gate scripts if app-06 adds named jobs

- [ ] **Step 1: Verify all phase gates**

```sh
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/mcp test
pnpm --filter @movp/cli test
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs
node scripts/check-event-catalog.mjs
bash scripts/slice-e2e.sh
```

Expected: all pass.

- [ ] **Step 2: Commit**

```sh
git add packages/domain packages/graphql packages/mcp packages/cli templates/frontend-astro scripts docs/superpowers/plans/README.md
git commit -m "feat(workflows): add admin surfaces and e2e slice"
```

## Self-Review

- **Correctness:** Custom API wraps the actual domain/RPC contracts; e2e proves event-to-action-to-audit behavior.
- **Safety:** Secrets are one-time only; frontend has no service-role/internal imports; nonmember authz is in slice.
- **Reliability:** Replay/dead-job path is surfaced; duplicate action replay is tested.
- **Observability:** Audit viewer and e2e correlation pin event/run/job/trace linkage.
- **Efficiency:** Approval-style N+1 is avoided by list queries with labels included or batched maps.
- **Performance:** GraphQL page sizes are clamped; audit filters are indexed by Part A.
- **Simplicity:** JSON editors are acceptable v1 controls for condition/action config; no speculative visual builder.
- **Usability:** Empty/loading/error/auth states, keyboard focus, one-time secret handling, and replay affordance are tested.
