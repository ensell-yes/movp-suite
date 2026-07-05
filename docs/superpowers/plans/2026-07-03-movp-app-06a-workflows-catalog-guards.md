# MOVP App - Domain Workflows Phase 7, Part A: Catalog and Event Spine

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans`. This is an implementation plan, not implementation code. Follow every TDD step exactly when executing later.

**Goal:** Add the workflow catalog foundation: a global `event_type` reference catalog, workspace-scoped `automation_rule`, `webhook_subscription`, and `workflow_run` tables, codegen support for global collections, config-declared event seeds, and the additive `automate` enqueue in `public.emit_event`.

**Architecture:** `@movp/core-schema` remains the single source of truth. Part A extends the schema contract in two places: (1) `workspaceScoped:false` becomes a real codegen path, not just a type field; (2) `defineEvent(...)` declarations seed `public.event_type`. The generated migration `20260701000002_movp_generated.sql` owns the base tables and event catalog seed rows. The hand-authored migration `20260701000022_workflows_catalog_guards.sql` owns the `automate` job-kind registration, `emit_event` additive enqueue, read-only audit RLS overrides, and `workflow_run` uniqueness/indexes.

**Tech Stack:** `@movp/core-schema`, `@movp/codegen`, generated SQL/types, Supabase migrations + pgTAP, `movp_internal.movp_events`, `movp_internal.movp_jobs`, `movp_internal.movp_job_kind`, `public.emit_event`, definer-audit, migration-drift, event-catalog CI gate.

**This is Part A of Phase 7 (Domain Workflows & Webhooks).** It depends on Core + Collaboration + Task + CMS being executed, and on Campaigns/Segmentation plans reserving event names and migration numbers. It must sort after Segmentation (`...000021`), so the first hand migration is `20260701000022_workflows_catalog_guards.sql`. Parts B/C/D consume the exact table names, generated row types, event keys, `workflow_run unique(source_event_id, automation_rule_id)`, and `automate` job-kind.

## Global Constraints

- **Roadmap reconciliation:** the 2026-06-30 app-06 roadmap says Phase 7 "reuses Core verbatim." That is design intent only. Executed code shows `emit-sql.ts` currently emits a workspace-member RLS policy referencing `workspace_id` for every collection, even when `workspaceScoped:false`; Part A must fix that before `event_type` can exist.
- **Global exception is explicit:** `event_type` is the only non-workspace-scoped public collection in this phase. It has no `workspace_id`, grants `select` to `authenticated`, and writes only through codegen seed/service-role. Do not add fake workspace rows.
- **Generated artifacts are generated:** do not hand-edit `supabase/migrations/20260701000002_movp_generated.sql` or `packages/domain/src/generated/types.ts`; edit schema/codegen, run codegen, and commit the regenerated diff.
- **Event keys are strings with contracts:** every `defineEvent({ key, domain, payloadSchema, version })` key must match an actual or planned `emit_event` callsite. A CI gate compares both directions.
- **Transition-guard retrofit is deferred:** the roadmap's transition-guard idea needs a real Task/CMS state-machine consumer. App-06 does not ship unused guard codegen or rewrite existing Task/CMS lifecycle SQL. A future retrofit must update the source collection, prove no duplicate emissions, and carry its own migration/tests.
- **`emit_event` change is additive:** preserve current event insert, notify guard, and webhook enqueue semantics. Add exactly one `automate` enqueue using the inserted event id as the job idempotency key.
- **SECURITY DEFINER:** all new definer functions use `set search_path = ''`, schema-qualified names, and least-priv grants.

## File Structure

```text
packages/core-schema/src/
  define.ts                           # UPDATE: defineEvent validation
  events.ts                           # NEW: event declarations + registry helpers
  types.ts                            # UPDATE: EventDef metadata
  collections/
    event_type.ts                     # NEW, workspaceScoped:false
    automation_rule.ts                # NEW
    webhook_subscription.ts           # NEW
    workflow_run.ts                   # NEW
  schema.ts                           # UPDATE: add collections + events
  index.ts                            # UPDATE: exports
packages/codegen/src/
  emit-sql.ts                         # UPDATE: global RLS path, event seeds
  emit-types.ts                       # UPDATE if generated types need event metadata
  event-catalog.ts                    # NEW: compare registry to callsites
packages/codegen/test/
  workflows-contract.test.ts          # NEW
scripts/
  check-event-catalog.mjs             # NEW
supabase/migrations/
  20260701000002_movp_generated.sql   # REGENERATED only
  20260701000022_workflows_catalog_guards.sql # NEW hand migration
supabase/tests/
  workflows_catalog_guards_test.sql   # NEW
```

### Task 1: Codegen contract for global collections and events

**Files**

- Create: `packages/codegen/test/workflows-contract.test.ts`
- Update later: `packages/core-schema/src/types.ts`, `define.ts`, `events.ts`, `schema.ts`, `packages/codegen/src/emit-sql.ts`

**Interfaces**

- Consumes: existing `CollectionDef.workspaceScoped:boolean`, `f.enum`, `emitSqlMigration(schema)`.
- Produces: a failing contract that pins two capabilities: no `workspace_id`/member RLS for global collections and generated `event_type` seeds.

- [ ] **Step 1: Write the failing contract test**

Create a test with a tiny schema:

```ts
import { describe, expect, it } from 'vitest'
import { defineCollection, defineEvent, defineSchema, f } from '@movp/core-schema'
import { emitSqlMigration } from '../src/emit-sql.ts'

describe('workflow catalog codegen contract', () => {
  it('emits global collection SQL without workspace-member RLS', () => {
    const eventType = defineCollection({
      name: 'event_type',
      label: 'Event type',
      labelPlural: 'Event types',
      workspaceScoped: false,
      fields: {
        key: f.text({ label: 'Key', required: true }),
        domain: f.enum(['task'], { label: 'Domain', required: true }),
        payload_schema: f.json({ label: 'Payload schema', required: true }),
      },
    })
    const sql = emitSqlMigration(defineSchema([eventType], [
      defineEvent({ key: 'task.completed', domain: 'task', payloadSchema: { type: 'object' }, version: 1 }),
    ]))
    expect(sql).toContain('create table if not exists public.event_type')
        expect(sql).not.toContain('event_type_rw')
        expect(sql).not.toContain('public.is_workspace_member(workspace_id)')
        expect(sql).toContain('create policy event_type_read on public.event_type for select to authenticated using (true)')
        expect(sql).toContain("('task.completed', 'task'")
  })

})
```

Expected: FAIL - `defineEvent` is not exported, `defineSchema` accepts one argument, and global collections still get `event_type_rw` with `workspace_id`.

- [ ] **Step 2: Implement the schema/type additions**

Add `EventDef` and thread the event set through `MovpSchema` (transition-guard field metadata is deferred with Task 4 — do **not** add `transitions`/`emits` to `FieldDef` here):

```ts
export interface EventDef {
  key: string
  domain: 'collaboration' | 'task' | 'cms' | 'campaign' | 'segmentation' | 'lifecycle' | 'workflow'
  payloadSchema: Record<string, unknown>
  version: number
  label?: string
  description?: string
}

export interface MovpSchema {
  collections: CollectionDef[]
  events: EventDef[]
}
```

`defineSchema(collections, events = [])` must validate duplicate event keys. `defineEvent` validates `key` as dotted lower-case (`task.completed`) and `version >= 1`.

- [ ] **Step 3: Implement global collection SQL**

In `emitCollectionSql`, branch on `c.workspaceScoped`:

- scoped collections keep `workspace_id`, grants, and `<name>_rw` policy.
- global collections omit `workspace_id`, create RLS, grant `select` to `authenticated`, grant all to `service_role`, emit an explicit read policy `using (true)`, and do not create an insert/update/delete policy for `authenticated`.

Use an explicit helper like this so a falsey `workspaceScoped` value cannot fall through to the tenant policy:

```ts
function rlsSql(c: CollectionDef): string {
  if (!c.workspaceScoped) {
    return `
alter table public.${ident(c.name)} enable row level security;
grant select on public.${ident(c.name)} to authenticated;
grant select, insert, update, delete on public.${ident(c.name)} to service_role;
create policy ${ident(c.name)}_read on public.${ident(c.name)}
  for select to authenticated using (true);`
  }
  return `
alter table public.${ident(c.name)} enable row level security;
grant select, insert, update, delete on public.${ident(c.name)} to authenticated;
grant select, insert, update, delete on public.${ident(c.name)} to service_role;
create policy ${ident(c.name)}_rw on public.${ident(c.name)} for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));`
}
```

Expected grep after implementation:

```sh
pnpm --filter @movp/codegen test -- workflows-contract
```

Expected: PASS.

**Gate**

```sh
pnpm --filter @movp/codegen test -- workflows-contract && pnpm --filter @movp/core-schema typecheck
```

Expected: both commands pass.

### Task 2: Add workflow collections and event registry

**Files**

- Create: `packages/core-schema/src/collections/event_type.ts`
- Create: `packages/core-schema/src/collections/automation_rule.ts`
- Create: `packages/core-schema/src/collections/webhook_subscription.ts`
- Create: `packages/core-schema/src/collections/workflow_run.ts`
- Create: `packages/core-schema/src/events.ts`
- Update: `packages/core-schema/src/schema.ts`, `index.ts`

**Interfaces**

- Produces generated tables/types consumed by Parts B-D:
  - `event_type` global: `key`, `domain`, `label`, `payload_schema`, `schema_version`, `active`, `description`.
  - `automation_rule`: `trigger_event_type_id`, `condition`, `action_type`, `action_config`, `enabled`, `priority`.
  - `webhook_subscription`: `event_type_id`, `url`, `filter`, `active`, `secret_set`, `secret_last_rotated_at`, `internal_webhook_id`.
  - `workflow_run`: `source_event_id`, `event_type`, `automation_rule_id`, `matched`, `action_type`, `outcome`, `job_id`, `error_code`, `trace_id`.

- [ ] **Step 1: Define the four collections**

Use `workspaceScoped:false` only for `event_type`; the other three are workspace-scoped. Keep `workflow_run` **non-internal** so the generic GraphQL/MCP/CLI read surfaces exist like the roadmap requires. Part A later overrides generated RLS so members can SELECT audit rows while only service-role can write them.

Load-bearing details:

- `automation_rule.action_type` enum is exactly `notify`, `deliver_webhook`, `create_task`, `advance_deliverable`, `recompute_segment`, `emit_event`.
- `workflow_run.outcome` enum is exactly `succeeded`, `failed`, `skipped`, `enqueued`.
- `webhook_subscription` has no secret column. `internal_webhook_id` is a uuid soft reference to `movp_internal.webhooks`.

Use this collection shape; labels/descriptions can be expanded, but names/types must not drift:

```ts
export const eventType = defineCollection({
  name: 'event_type',
  label: 'Event type',
  labelPlural: 'Event types',
  workspaceScoped: false,
  fields: {
    key: f.text({ label: 'Key', required: true, reporting: { role: 'dimension' } }),
    domain: f.enum(['collaboration','task','cms','campaign','segmentation','lifecycle','workflow'], { label: 'Domain', required: true, reporting: { role: 'dimension' } }),
    label: f.text({ label: 'Label', required: true }),
    payload_schema: f.json({ label: 'Payload schema', required: true }),
    schema_version: f.number({ label: 'Schema version', required: true, default: 1 }),
    active: f.boolean({ label: 'Active', required: true, default: true }),
    description: f.text({ label: 'Description', searchable: true }),
  },
})

export const workflowRun = defineCollection({
  name: 'workflow_run',
  label: 'Workflow run',
  labelPlural: 'Workflow runs',
  workspaceScoped: true,
  fields: {
    source_event_id: f.uuid({ label: 'Source event id', required: true }),
    event_type: f.text({ label: 'Event type', required: true, reporting: { role: 'dimension' } }),
    automation_rule: f.relation('automation_rule', { label: 'Automation rule', required: true, cardinality: 'many-to-one', reporting: { role: 'dimension' } }),
    matched: f.boolean({ label: 'Matched', required: true, default: false }),
    action_type: f.text({ label: 'Action type', required: true, reporting: { role: 'dimension' } }),
    outcome: f.enum(['succeeded','failed','skipped','enqueued'], { label: 'Outcome', required: true, reporting: { role: 'dimension' } }),
    job_id: f.uuid({ label: 'Job id' }),
    error_code: f.text({ label: 'Error code' }),
    trace_id: f.text({ label: 'Trace id' }),
  },
})
```

For `automation_rule` and `webhook_subscription`, use the same field list from **Interfaces** exactly; both are `workspaceScoped:true`, and neither is `internal`.

- [ ] **Step 2: Declare the event registry**

Create `packages/core-schema/src/events.ts` with all roadmap events, plus the actual executed events. Reconciliation notes to encode as comments:

- CMS executed code uses `content.unpublished` through `content_publish_event`; keep it in catalog even if a later schedule action uses `archived` internally.
- Segmentation and Campaigns are planned but not executed in this checkout; their event keys are authoritative from app-03/app-04 plans and must be present because app-06 executes after them.

- [ ] **Step 3: Wire schema and exports**

`schema.ts` should pass both collections and events to `defineSchema`. Put `event_type` before relation consumers so FK generation resolves.

- [ ] **Step 4: Run codegen during execution**

When executing this task later, run:

```sh
pnpm codegen
```

Expected: generated migration contains all four tables, `event_type` has no `workspace_id`, generated types include `EventTypeRow`, `AutomationRuleRow`, `WebhookSubscriptionRow`, `WorkflowRunRow`.

**Gate**

```sh
pnpm codegen
sed -n '/create table if not exists public.event_type /,/insert into public.movp_collections/p' supabase/migrations/20260701000002_movp_generated.sql > /tmp/movp_event_type_block.sql
! rg -n "event_type_rw|workspace_id|public.is_workspace_member\\(workspace_id\\)" /tmp/movp_event_type_block.sql
git diff --check packages/domain/src/generated/types.ts supabase/migrations/20260701000002_movp_generated.sql
```

Expected: the negative `rg` prints no event_type policy/workspace hits; `git diff --check` reports no whitespace/conflict-marker errors in the generated files.

### Task 3: Emit event catalog seed rows and add the coverage gate

**Files**

- Update: `packages/codegen/src/emit-sql.ts`
- Create: `packages/codegen/src/event-catalog.ts`
- Create: `scripts/check-event-catalog.mjs`
- Update: `package.json` or CI config if existing gates are listed there

**Interfaces**

- Consumes: `schema.events`, generated `public.event_type`.
- Produces: idempotent `insert into public.event_type (...) values ... on conflict (key) do update ...` and a CI check comparing catalog keys with `emit_event` callsites.

- [ ] **Step 1: Add a failing test for missing callsite coverage**

Extend `workflows-contract.test.ts` with a fixture that passes `knownCallsites=['task.completed','missing.event']` to a pure `checkEventCatalog(events, knownCallsites)` helper and expects `missing.event` in the failure list.

Expected: FAIL - helper does not exist.

- [ ] **Step 2: Implement seed SQL**

`emitSqlMigration(schema)` should emit catalog seed rows after `public.event_type` exists. Store `payload_schema` as JSONB and `schema_version` as the declared version. Do not hand-code the seed rows in the hand migration.

- [ ] **Step 3: Implement `scripts/check-event-catalog.mjs`**

The script scans committed SQL/TS only: `supabase/migrations`, `packages/domain/src`, `packages/flows/src`, `supabase/functions`, and any merged app package directories for literal `emit_event('type'`, `public.emit_event('type'`, and `emitEvent(... type: 'type')` callsites. It then imports the schema event list and fails if either side is missing. It must not scan `docs/superpowers/plans/*.md`.

Important: app-06 execution is sequenced after Campaigns and Segmentation are merged. Scan committed SQL/TS emit sites only; do **not** scan plan Markdown, or the code gate becomes coupled to design prose and misses the real merged callsites.

**Gate**

```sh
node scripts/check-event-catalog.mjs
```

Expected: `event catalog coverage: ok`.

### Task 4: Pin transition-guard deferral

**Files**

- Update: `docs/superpowers/plans/2026-06-30-movp-app-06-domain-workflows-webhooks.md` only if the roadmap needs a note.
- Do not update `packages/core-schema/src/builders.ts` or `packages/codegen/src/emit-sql.ts` for transition guards in this phase.

**Interfaces**

- Produces: an explicit deferral note and a negative gate proving app-06 did not ship unused transition-guard codegen.

- [ ] **Step 1: Add a short deferral note**

Add this note under Part A's self-review or the roadmap reconciliation note:

```md
Transition-guard codegen is deferred out of app-06 execution. It needs a real consumer
that retrofits an existing Task/CMS state machine without duplicate emissions. App-06
only catalogs emitted events and automates off Core's event spine.
```

Expected: the plan remains honest about the roadmap intent without adding unused schema/codegen surface area.

- [ ] **Step 2: Add the negative gate**

Run:

```sh
! rg -n "transitions|transition_guard|invalid_transition" packages/core-schema/src packages/codegen/src
```

Expected: no matches in app-06 implementation code. Existing prose in app plans is not scanned.

### Task 5: Hand migration for automate job-kind and additive emit_event enqueue

**Files**

- Create: `supabase/migrations/20260701000022_workflows_catalog_guards.sql`
- Create: `supabase/tests/workflows_catalog_guards_test.sql`

**Interfaces**

- Consumes: current `public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)`, `movp_internal.movp_events`, `movp_internal.movp_jobs`, `movp_internal.movp_job_kind`.
- Produces: job kind `automate`; one `automate` job per inserted event; idempotency key = inserted event id; `workflow_run unique(source_event_id, automation_rule_id)`.

- [ ] **Step 1: Write the failing pgTAP**

Test these assertions:

- `movp_internal.movp_job_kind` contains `automate`;
- one `emit_event('task.completed', ws, payload, trace)` inserts exactly one `movp_events` row and one `automate` job;
- a recipient-bearing event still enqueues exactly one `notify` job;
- an active registered webhook still enqueues exactly one `webhook` job;
- the automate job's `idempotency_key` equals the inserted `movp_events.id`, not `payload.id`, so two separate event rows with the same business id still each get one automate job;
- `workflow_run` has a unique constraint on `(source_event_id, automation_rule_id)`;
- non-member sees zero `workflow_run` rows.

Expected: FAIL - no `automate` kind/job exists.

- [ ] **Step 2: Create the migration**

Use `create or replace function public.emit_event(...)`, but do **not** paste a skeleton. Open the current suite-level implementation in `supabase/migrations/20260701000009_task_lifecycle.sql`, copy its full body, and add only:

- `declare v_event_id uuid;`
- `returning id into v_event_id` on the `movp_events` insert;
- the final `automate` insert below.

The complete merged body must look like this, with the notify guard and webhook fanout still present:

```sql
create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
  values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text))
  returning id into v_event_id;

  if payload ? 'recipient_user_id' or payload ? 'email' then
    insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    values ('notify', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
            payload || jsonb_build_object('event', ev_type), ws)
    on conflict (kind, idempotency_key) do nothing;
  end if;

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  select 'webhook', ev_type || ':' || coalesce(payload->>'id','') || ':' || w.id::text,
         payload || jsonb_build_object('event', ev_type, 'url', w.url, 'secret', w.secret), ws
    from movp_internal.webhooks w
   where w.workspace_id = ws and w.event_type = ev_type and w.active
  on conflict (kind, idempotency_key) do nothing;

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values ('automate', v_event_id::text,
          jsonb_build_object('event_id', v_event_id, 'event_type', ev_type, 'depth', coalesce((payload->>'depth')::int, 0)),
          ws)
  on conflict (kind, idempotency_key) do nothing;
end;
$$;
```

Do not use `ev_type || ':' || payload->>'id'` for `automate`; the event row id is the stable one-event/one-job key.

- [ ] **Step 3: Add workflow_run constraints/RLS override**

Add `unique(source_event_id, automation_rule_id)` and indexes on `(workspace_id, created_at desc)`, `(workspace_id, outcome)`, `(workspace_id, event_type)`. Override generated `workflow_run` policy so members can SELECT only; INSERT/UPDATE/DELETE are service-role only. Keep the collection non-internal so generic read surfaces exist; the RLS override, not `internal:true`, is what prevents member writes.

**Gate**

```sh
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && node scripts/check-event-catalog.mjs && supabase db diff
```

Expected: `workflows_catalog_guards_test.sql .. ok`; definer audit and event catalog pass; db diff empty.

### Task 6: Part A integration and handoff commit

**Files**

- Update if needed: CI gate list / README gate references

**Interfaces**

- Produces: a green Part A baseline that Parts B/C/D can assume.

- [ ] **Step 1: Full Part A verification**

Run:

```sh
pnpm --filter @movp/core-schema test
pnpm --filter @movp/codegen test
pnpm codegen
supabase db reset
supabase test db
node scripts/check-definer-audit.mjs
node scripts/check-event-catalog.mjs
supabase db diff
```

Expected: all pass; `db diff` empty; generated files have only the expected app-06 schema/type changes.

- [ ] **Step 2: Commit**

```sh
git add packages/core-schema packages/codegen scripts supabase/migrations supabase/tests packages/domain/src/generated/types.ts
git commit -m "feat(workflows): add event catalog and automate spine"
```

## Self-Review

- **Correctness:** Pins the global-collection bug before defining `event_type`; catalogs every roadmap event; additive `emit_event` job uses event id, not payload id.
- **Safety:** `event_type` is read-only to authenticated; `workflow_run` is read-only to members; `movp_internal` remains service-role/definer only; no secrets or payload values are added.
- **Reliability:** `automate` job dedupes by event id and uses the existing durable queue; `workflow_run` exactly-once uniqueness is created before the worker exists.
- **Observability:** Event catalog coverage gate fails hard on drift; `trace_id` remains threaded from `emit_event`.
- **Efficiency:** No new queue, no duplicate delivery infra; codegen seeds the catalog once.
- **Performance:** Indexes support audit filtering by workspace/time/outcome/event type.
- **Simplicity:** Transition-guard codegen is explicitly deferred until a real Task/CMS state-machine retrofit consumes it; app-06 ships no unused guard generator.
- **Usability:** No UI in Part A; operator-visible catalog and audit rows are prepared for Part D.
