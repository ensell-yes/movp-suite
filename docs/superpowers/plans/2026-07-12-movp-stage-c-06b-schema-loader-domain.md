# Stage C6b — Single Cross-Runtime Schema Loader + Fingerprint + Schema-Derived Two-Tier Domain

**REQUIRED SUB-SKILL:** Use `superpowers:test-driven-development` for every task below —
write the failing test first, watch it fail for the stated reason, then write the minimal
implementation. Do not batch multiple steps before running the gate.

## Goal

Make the schema an **injected value**, not a static import, across codegen, domain, and the CLI,
and add the two pure utilities every later C6 part consumes: `metadataProjection(schema)` and
`schemaFingerprint(schema)`. Derive the domain's generic collection tier from the schema at call
time (so a novel non-internal collection reaches CLI/GraphQL/MCP with zero hand edits — the C5
`external_record` precedent), and ship a `movp verify-schema-runtime` command that fails
**before serve/deploy** when the Node and Deno runtimes would load divergent schemas.

## Architecture

- `@movp/core-schema` gains **pure** `metadataProjection` + `schemaFingerprint` (a new
  `projection.ts`, re-exported from `index.ts`). No I/O, no per-request state.
- `@movp/codegen` `generate()` takes a **required** `schema` in options; the module-level
  `import { schema }` is removed. `scripts/codegen.ts` and the CLI's default `runCodegen` pass it.
- `@movp/domain` `createDomain(ctx, { schema, embedder? })` derives a generic `collection(name)`
  registry from `schema.collections` (`internal !== true`, custom services win). The 22 generic
  named `Domain` properties are removed and replaced by the `collection(name)` accessor.
- `@movp/cli` `buildProgram(schema, opts)` threads the schema into the collection-command loop and
  every `createDomain(...)` call. `bin.ts` passes `schema` from `@movp/core-schema`.
- **MCP/GraphQL builders are UNCHANGED** — `buildMcpServer(schema, ctx)` and `buildSchema(schema)`
  already accept `schema` (verified: `packages/mcp/src/server.ts:45`, `packages/graphql/src/schema.ts:141`).
  Their **internal** `createDomain(...)` calls gain `{ schema, ... }`; that is the only edit there.
- `movp verify-schema-runtime` (new `packages/cli/src/verify-schema-runtime.ts` + committed Deno
  fingerprint script): Node imports `movp.config.mjs` → `schemaFingerprint`; spawns `deno run` with
  the scaffold `deno.json` to import the Edge schema module → `schemaFingerprint`; compares; the CLI
  command throws `schema_runtime_mismatch` (→ exit 1 via `bin.ts`) on divergence, prints `{ ok: true }`
  (exit 0) on match.

## Tech Stack

TypeScript (strict, **NEVER `any`**), Node 20+ via `tsx`, Deno (Supabase edge runtime), Vitest,
`commander`, `node:crypto` (builtin — no new dependency), pnpm workspaces + turbo.

## Global Constraints

- **NEVER `any`.** Use `unknown` + narrowing or a real type. The repo enforces this.
- **06a is a PREREQUISITE, consume it exactly — do not re-define it.** By the time this plan runs,
  `CollectionDef` already has `layer: 'platform' | 'project'` (default `'platform'`), `defineSchema`
  already accepts `{ extends?, collections, events }`, and `MovpSchema` already exposes
  `projectCollections` / `platformCollections`. This plan READS `c.layer`; it never adds the marker.
- **MCP/GraphQL builder signatures do not change.** `buildMcpServer(schema, ctx)` /
  `buildSchema(schema)` already take `schema`. Do NOT refactor them; only their inner
  `createDomain(...)` opts gain `{ schema }`.
- **`createDomain` must be schema-derived** (C5 `external_record` precedent — a hand-maintained
  per-collection map silently omitted a new collection). Do not reintroduce a hardcoded map.
- `schemaFingerprint` is **synchronous** and **byte-identical across Node and Deno** — same
  `node:crypto` `createHash('sha256')`, same `JSON.stringify` of the canonical projection.
- Migrations are forward-only; this plan touches **no** `.sql` and **no** migration files.
- Run the monorepo suite green after every task: `pnpm -w test` (or the per-package `vitest run`
  named in each gate) plus `pnpm -w typecheck`.

## Interfaces this plan PRODUCES (consumed by 06c/06d/06e/06f)

```ts
// @movp/core-schema (projection.ts, re-exported from index.ts)
export interface CollectionMeta {
  name: string; label: string; label_plural: string; workspace_scoped: boolean; layer: string
}
export interface FieldMeta {
  collection_name: string; name: string; type: string; label: string
  cardinality: string | null; reporting_role: string | null
  searchable: boolean; embeddable: boolean; layer: string
}
export function metadataProjection(schema: MovpSchema): { collections: CollectionMeta[]; fields: FieldMeta[] }
export function schemaFingerprint(schema: MovpSchema): string // sha256 hex

// @movp/codegen
export function generate(options: { schema: MovpSchema; root?: string; migrationName?: string;
  migrationsDir?: string; typesPath?: string; deltas?: readonly GeneratedDelta[] }):
  Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }>

// @movp/domain
export function createDomain(ctx: DomainCtx, opts: { schema: MovpSchema; embedder?: EmbeddingProvider }): Domain
// Domain gains: collection(name: string): CollectionService<{ id: string } & Record<string, unknown>,
//   Record<string, unknown>, Record<string, unknown>>   (generic accessor; custom services stay typed)

// @movp/cli
export function buildProgram(schema: MovpSchema, opts?: BuildProgramOpts): Command
export function runVerifySchemaRuntime(opts: VerifySchemaRuntimeOpts):
  Promise<{ ok: boolean; code?: 'schema_runtime_mismatch'; nodeFingerprint: string; denoFingerprint: string }>
```

Stable error code produced here: **`schema_runtime_mismatch`**.

---

## Task 1 — `metadataProjection` + `schemaFingerprint` (pure, `@movp/core-schema`)

**Files**
- NEW `packages/core-schema/src/projection.ts`
- EDIT `packages/core-schema/src/index.ts` (re-export)
- NEW `packages/core-schema/test/projection.test.ts`

**Interfaces**
- *Consumes from 06a:* `CollectionDef.layer` (string, `'platform'` in the monorepo);
  `MovpSchema.collections: CollectionDef[]`; `FieldDef` (`type`, `label`, `cardinality?`,
  `reporting?.role`, `searchable?`, `embeddable?`).
- *Produces:* `metadataProjection`, `schemaFingerprint`, `CollectionMeta`, `FieldMeta` (exact shapes
  per INTERFACES "Canonical metadata projection + fingerprint").

**Ground truth** — the projection must equal EXACTLY the DB-compared columns emitted by
`packages/codegen/src/emit-sql.ts:76-107`: `movp_collections (name, label, label_plural,
workspace_scoped)` + the `layer` column (06a), and `movp_fields (collection_name, name, type, label,
cardinality, reporting_role, searchable, embeddable)` + `layer`. `internal` is NOT in the projection.
A field's `layer` is its owning collection's `layer`.

### Step 1.1 — Failing test

Write `packages/core-schema/test/projection.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { MovpSchema } from '../src/index.ts'
import { metadataProjection, schemaFingerprint } from '../src/index.ts'

function makeSchema(): MovpSchema {
  // Two collections out of name order; fields out of name order — projection must sort both.
  return {
    collections: [
      {
        name: 'beta', label: 'Beta', labelPlural: 'Betas', workspaceScoped: true, layer: 'project',
        fields: {
          zeta: { type: 'text', label: 'Zeta', searchable: true },
          alpha: { type: 'number', label: 'Alpha', reporting: { role: 'measure' } },
        },
      },
      {
        name: 'alpha', label: 'Alpha', labelPlural: 'Alphas', workspaceScoped: false, layer: 'platform',
        internal: true, // internal is projected too (a DB row exists); only the runtime tiers skip it
        fields: { ref: { type: 'relation', label: 'Ref', target: 'beta', cardinality: 'many-to-one' } },
      },
    ] as MovpSchema['collections'],
    events: [],
  }
}

describe('metadataProjection', () => {
  it('projects exactly the DB-compared columns, deterministically ordered', () => {
    const p = metadataProjection(makeSchema())
    expect(p.collections.map((c) => c.name)).toEqual(['alpha', 'beta']) // by name
    expect(p.collections[1]).toEqual({
      name: 'beta', label: 'Beta', label_plural: 'Betas', workspace_scoped: true, layer: 'project',
    })
    expect(p.fields.map((f) => `${f.collection_name}.${f.name}`)).toEqual([
      'alpha.ref', 'beta.alpha', 'beta.zeta', // by (collection_name, name)
    ])
    expect(p.fields[1]).toEqual({
      collection_name: 'beta', name: 'alpha', type: 'number', label: 'Alpha',
      cardinality: null, reporting_role: 'measure', searchable: false, embeddable: false, layer: 'project',
    })
    expect(p.fields[0].layer).toBe('platform') // field layer = owning collection layer
    expect(p.fields[0].cardinality).toBe('many-to-one')
    // internal is NOT a projected key
    expect(Object.keys(p.collections[0])).not.toContain('internal')
  })
})

describe('schemaFingerprint', () => {
  it('is a stable sha256 hex string, order-independent over input collection order', () => {
    const fp = schemaFingerprint(makeSchema())
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    const reordered: MovpSchema = { ...makeSchema(), collections: [...makeSchema().collections].reverse() }
    expect(schemaFingerprint(reordered)).toBe(fp) // canonical order → same hash
  })

  it('changes when a projected column changes', () => {
    const base = schemaFingerprint(makeSchema())
    const mutated = makeSchema()
    mutated.collections[0].fields.zeta.label = 'Zeta 2'
    expect(schemaFingerprint(mutated)).not.toBe(base)
  })
})
```

Run — Expected: **FAIL** (`metadataProjection`/`schemaFingerprint` not exported).

```
pnpm --filter @movp/core-schema exec vitest run projection
```

### Step 1.2 — Implement

Create `packages/core-schema/src/projection.ts`:

```ts
// `node:crypto` is a builtin (no new dependency) and resolves under BOTH Node 20+ and the
// Supabase Deno edge runtime, so schemaFingerprint() is byte-identical across runtimes — the
// invariant movp verify-schema-runtime relies on. Do NOT switch to Web Crypto: subtle.digest is
// async and INTERFACES locks schemaFingerprint to a synchronous `string`.
import { createHash } from 'node:crypto'
import type { CollectionDef, FieldDef, MovpSchema } from './types.ts'

export interface CollectionMeta {
  name: string
  label: string
  label_plural: string
  workspace_scoped: boolean
  layer: string
}

export interface FieldMeta {
  collection_name: string
  name: string
  type: string
  label: string
  cardinality: string | null
  reporting_role: string | null
  searchable: boolean
  embeddable: boolean
  layer: string
}

function collectionMeta(c: CollectionDef): CollectionMeta {
  return {
    name: c.name,
    label: c.label,
    label_plural: c.labelPlural,
    workspace_scoped: c.workspaceScoped,
    layer: c.layer,
  }
}

function fieldMeta(collection: CollectionDef, name: string, field: FieldDef): FieldMeta {
  return {
    collection_name: collection.name,
    name,
    type: field.type,
    label: field.label,
    cardinality: field.cardinality ?? null,
    reporting_role: field.reporting?.role ?? null,
    searchable: !!field.searchable,
    embeddable: !!field.embeddable,
    layer: collection.layer, // a field's layer is its owning collection's layer
  }
}

export function metadataProjection(schema: MovpSchema): { collections: CollectionMeta[]; fields: FieldMeta[] } {
  const collections = schema.collections
    .map(collectionMeta)
    .sort((a, b) => a.name.localeCompare(b.name))

  const fields: FieldMeta[] = []
  for (const c of schema.collections) {
    for (const [name, field] of Object.entries(c.fields)) fields.push(fieldMeta(c, name, field))
  }
  fields.sort((a, b) =>
    a.collection_name === b.collection_name
      ? a.name.localeCompare(b.name)
      : a.collection_name.localeCompare(b.collection_name),
  )

  return { collections, fields }
}

export function schemaFingerprint(schema: MovpSchema): string {
  // Keys are inserted in a fixed order above, so JSON.stringify of the (sorted) projection is
  // canonical. Hash the canonical JSON, not the raw schema (which carries un-projected fields).
  return createHash('sha256').update(JSON.stringify(metadataProjection(schema))).digest('hex')
}
```

Add to `packages/core-schema/src/index.ts` (after the existing `export type { ... } from './types.ts'`
block):

```ts
export { metadataProjection, schemaFingerprint, type CollectionMeta, type FieldMeta } from './projection.ts'
```

Run — Expected: **PASS** (3 tests). Then typecheck.

```
pnpm --filter @movp/core-schema exec vitest run projection
pnpm --filter @movp/core-schema exec tsc --noEmit
```

**GATE:** `pnpm --filter @movp/core-schema exec vitest run projection` PASS and
`pnpm --filter @movp/core-schema exec tsc --noEmit` clean.

**COMMIT:** `feat(core-schema): C6b.1 metadataProjection + schemaFingerprint pure utilities`

---

## Task 2 — Inject `schema` into `generate()`

**Files**
- EDIT `packages/codegen/src/generate.ts`
- EDIT `scripts/codegen.ts`
- EDIT `packages/codegen/test/generate.test.ts` (every `generate({...})` call gains `schema`)

**Interfaces**
- *Consumes from 06a:* `import { schema } from '@movp/core-schema'` in the callers (the monorepo schema).
- *Produces:* `generate(options: { schema: MovpSchema; ... })` — `schema` **required**; the
  module-level `import { schema }` in `generate.ts` is deleted.

### Step 2.1 — Failing test

Add to `packages/codegen/test/generate.test.ts` a test proving the injected schema drives emission,
and update the existing `freshRoot()` helper callers to pass `schema`. First, at the top of the file:

```ts
import { schema } from '@movp/core-schema'
```

Then add this test inside the existing top-level `describe`:

```ts
it('emits from the injected schema, not a static import (C6b.2)', async () => {
  const { root, migrationsDir } = await freshRoot()
  const res = await generate({ schema, root })
  const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
  expect(baseline).toContain('create table if not exists public.note')
  expect(res.typesPath.endsWith('types.ts')).toBe(true)
})
```

Run — Expected: **FAIL to typecheck/run** — existing calls `generate({ root })` and `generate({ root, deltas })`
now error because `schema` is required (and this new test won't compile until Step 2.2 removes the
static import path). This is the intended red state.

```
pnpm --filter @movp/codegen exec vitest run generate
```

### Step 2.2 — Implement

In `packages/codegen/src/generate.ts`:

1. **Delete** line 1 `import { schema } from '@movp/core-schema'`. **Keep** line 2
   `import type { MovpSchema } from '@movp/core-schema'`.
2. Add `schema` to `GenerateOptions` (required) and remove the `= {}` default on `generate`:

```ts
export interface GenerateOptions {
  schema: MovpSchema
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
}
```

```ts
export async function generate(
  options: GenerateOptions,
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  const schema = options.schema
  const root = options.root ?? defaultRoot()
  // ...rest unchanged...
```

   Everything below already references the local `schema` name (`emitSqlMigration(schema, …)` :139,
   `delta.emit(schema)` :156, `emitTypes(schema)` :161) — introducing `const schema = options.schema`
   at the top keeps those call sites verbatim.

3. Update the existing test callers in `generate.test.ts`: every `generate({ root })` →
   `generate({ schema, root })`; `generate({ root, deltas: [delta] })` → `generate({ schema, root, deltas: [delta] })`.
   (Locally-defined `delta` objects that emit a literal body ignore `schema` — leave them as-is.)

In `scripts/codegen.ts`:

```ts
import { generate } from '@movp/codegen'
import { schema } from '@movp/core-schema'

const { migrationPath, typesPath, deltaPaths } = await generate({ schema })

console.log(`wrote ${migrationPath}`)
for (const path of deltaPaths) console.log(`wrote ${path}`)
console.log(`wrote ${typesPath}`)
```

Run — Expected: **PASS** (all generate tests). Then typecheck the package.

```
pnpm --filter @movp/codegen exec vitest run generate
pnpm --filter @movp/codegen exec tsc --noEmit
```

**GATE:** `pnpm --filter @movp/codegen exec vitest run` PASS and
`grep -n "^import { schema }" packages/codegen/src/generate.ts` returns **empty** (static import gone).

**COMMIT:** `feat(codegen): C6b.2 inject schema into generate(), remove static import`

---

## Task 3 — Schema-derived two-tier `createDomain(ctx, { schema })`

**Files**
- EDIT `packages/domain/src/types.ts` (`Domain` interface: drop 22 generic props, add `collection(name)`)
- EDIT `packages/domain/src/domain.ts` (`createDomain` derives the generic registry)
- EDIT `packages/mcp/src/server.ts` (inner `createDomain` opts + `service()` body + one direct ref)
- EDIT `packages/graphql/src/schema.ts` (inner `createDomain` opts + `service()` body)
- EDIT `packages/cli/src/program.ts` — deferred to Task 4 (CLI threads schema there)
- EDIT `packages/domain/test/domain.integration.test.ts` (13 `domain.<x>` → `domain.collection('<x>')`,
  and the `createDomain(...)` call gains `schema`)
- EDIT every other `createDomain(...)` call site in `packages/domain/test/*` (add `schema`)

**Interfaces**
- *Consumes from 06a:* `CollectionDef.internal?`, `CollectionDef.workspaceScoped`, `MovpSchema`.
- *Produces:* `createDomain(ctx, { schema, embedder? }): Domain`; `Domain.collection(name): CollectionService<GenericRow,…>`.

**Ground truth for the tier split** (verified against the tree): the non-internal collections that
currently have generic named services are exactly `event_type, external_record, note, tag,
marketing_plan, task_status_option, task_priority_option, campaign_channel, campaign_deliverable,
campaign_calendar_event, campaign_metric, campaign_segment, platform_event, segment, segment_rule,
segment_membership, segment_snapshot, segment_snapshot_member, segment_recompute_run,
automation_rule, webhook_subscription, workflow_run`. `task` is `internal: true` (bespoke surfaces
only). `campaign` is the ONE non-internal collection with a custom (CRUD-capable) service —
`Object.assign(makeCollectionService(...campaign...), makeCampaignService(ctx))` — so it is the
documented name collision the accessor must resolve to the custom service.

### Step 3.1 — Failing test

Add a unit test `packages/domain/test/collection-tier.test.ts` (pure, no DB — exercises the tier
logic with a stub ctx):

```ts
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MovpSchema } from '@movp/core-schema'
import { createDomain } from '../src/domain.ts'
import type { DomainCtx } from '../src/types.ts'

const ctx: DomainCtx = { db: {} as SupabaseClient, userId: 'u' }

function schemaWith(...collections: MovpSchema['collections']): MovpSchema {
  return { collections, events: [] }
}

const col = (name: string, extra: Partial<MovpSchema['collections'][number]> = {}): MovpSchema['collections'][number] => ({
  name, label: name, labelPlural: `${name}s`, workspaceScoped: true, layer: 'project', fields: {}, ...extra,
})

describe('createDomain generic two-tier registry (C6b.3)', () => {
  it('exposes a generic service for a novel non-internal collection (external_record precedent)', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('widget')) })
    expect(typeof domain.collection('widget').create).toBe('function')
    expect(typeof domain.collection('widget').list).toBe('function')
  })

  it('excludes internal:true collections from the generic tier', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('secret', { internal: true })) })
    expect(() => domain.collection('secret')).toThrow(/no domain service for collection: secret/)
  })

  it('custom service wins on name collision (campaign)', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('campaign')) })
    // campaign resolves to the custom service, which carries linkTask (not on a plain CollectionService)
    expect(typeof (domain.campaign as { linkTask?: unknown }).linkTask).toBe('function')
    expect(domain.collection('campaign')).toBe(domain.campaign as never)
  })
})
```

Run — Expected: **FAIL** (`createDomain` still takes `{ embedder? }` only; `domain.collection` does not exist).

```
pnpm --filter @movp/domain exec vitest run collection-tier
```

### Step 3.2 — Implement `types.ts` + `domain.ts`

In `packages/domain/src/types.ts`, in the `Domain` interface (currently lines 401-434):

1. **Delete** the 22 generic named `CollectionService<...>` properties (`event_type` … `workflow_run`,
   including `external_record`). **Keep** `task, content, search, graph, collab, campaign, workflows,
   admin, pat, reporting`.
2. Add the generic accessor as the first member:

```ts
export interface Domain {
  /**
   * Generic accessor for a schema-derived collection service. Every non-internal collection with no
   * bespoke custom service is reachable here (the C5 external_record precedent — no hand edit needed).
   * Custom services (task/content/campaign/workflow) win on name collision and stay typed properties.
   */
  collection(name: string): CollectionService<{ id: string } & Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  task: TaskService
  content: ContentService
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
  collab: CollabService
  campaign: CampaignService
  workflows: WorkflowService
  admin: AdminService
  pat: PatService
  reporting: ReportingService
}
```

   The now-unused `Create/Update/Row` type imports for the dropped collections stay imported only if
   still referenced; run `tsc --noEmit` and remove any import that becomes unused (the compiler
   reports `'X' is declared but never used` under the repo's `noUnusedLocals`).

In `packages/domain/src/domain.ts`, replace `createDomain` (lines 85-120) with:

```ts
import type { CampaignCreate, CampaignRow, CampaignUpdate } from './generated/types.ts'
import type { MovpSchema } from '@movp/core-schema'
// (keep the existing service-factory imports; the per-collection generated-type imports for the
//  dropped generic collections are no longer needed here — remove any the compiler flags unused.)

type GenericRow = { id: string } & Record<string, unknown>
type GenericService = CollectionService<GenericRow, Record<string, unknown>, Record<string, unknown>>

export function createDomain(ctx: DomainCtx, opts: { schema: MovpSchema; embedder?: EmbeddingProvider }): Domain {
  const campaign = Object.assign(
    makeCollectionService<CampaignRow, CampaignCreate, CampaignUpdate>(ctx, { table: 'campaign' }),
    makeCampaignService(ctx),
  )

  // Schema-derived generic tier. MUST stay derived (C5 external_record precedent: a hand-maintained
  // per-collection map silently omitted a new non-internal collection). A new non-internal collection
  // reaches generic CLI/GraphQL/MCP with ZERO edits here. internal:true collections are excluded —
  // their writes need bespoke atomic logic (task, content_*, etc.). Custom services win on collision:
  // 'campaign' is registered as the typed property below and returned by collection('campaign').
  const generic = new Map<string, GenericService>()
  for (const c of opts.schema.collections) {
    if (c.internal === true) continue
    if (c.name === 'campaign') continue // custom CRUD service wins (see collection() below)
    generic.set(
      c.name,
      makeCollectionService<GenericRow, Record<string, unknown>, Record<string, unknown>>(ctx, {
        table: c.name,
        workspaceScoped: c.workspaceScoped,
      }),
    )
  }

  return {
    collection(name: string): GenericService {
      if (name === 'campaign') return campaign as unknown as GenericService
      const svc = generic.get(name)
      if (!svc) throw new Error(`no domain service for collection: ${name}`)
      return svc
    },
    task: makeTaskService(ctx),
    content: makeContentService(ctx),
    search: (args) => runSearch(ctx, opts.embedder, args),
    graph: makeGraphService(ctx),
    collab: makeCollabService(ctx),
    campaign,
    workflows: makeWorkflowService(ctx),
    admin: makeAdminService(ctx),
    pat: makePatService(ctx),
    reporting: makeReportingService(ctx),
  }
}
```

Run the unit test — Expected: **PASS** (3 tests).

```
pnpm --filter @movp/domain exec vitest run collection-tier
```

### Step 3.3 — Rewire consumers (MCP, GraphQL) + domain integration tests

**MCP** (`packages/mcp/src/server.ts`): the builder signature is UNCHANGED. Two edits only:
- Line ~47 inner `createDomain(...)` — add `schema`:

```ts
  const domain = createDomain({
    db: ctx.db,
    userId: ctx.userId,
    accessToken: ctx.accessToken,
    assetsFnUrl: ctx.assetsFnUrl,
  }, { schema, embedder: ctx.embedder })
```

- Replace the `service()` helper body (lines 17-21) so it routes through the accessor:

```ts
function service(domain: Domain, name: string): AnyService {
  return domain.collection(name) as unknown as AnyService
}
```

- Line ~480 direct ref: `domain.workflow_run.list(...)` → `domain.collection('workflow_run').list(...)`.

**GraphQL** (`packages/graphql/src/schema.ts`): the `buildSchema(schema)` signature is UNCHANGED.
Two edits only:
- `domainFrom(ctx)` (lines 58-67) inner `createDomain(...)` — add `schema`:

```ts
  ctx.domain = createDomain({
    db: ctx.db,
    userId: ctx.userId,
    accessToken: ctx.accessToken,
    assetsFnUrl: ctx.assetsFnUrl,
  }, { schema, embedder: ctx.embedder })
```

- Replace the `service()` helper body (lines 47-56):

```ts
function service(domain: Domain, name: string): CollectionService<Row, Record<string, unknown>, Record<string, unknown>> {
  return domain.collection(name) as unknown as CollectionService<Row, Record<string, unknown>, Record<string, unknown>>
}
```

**Domain integration tests** (`packages/domain/test/domain.integration.test.ts`):
- Line 86: `createDomain({ db, userId }, { embedder })` → `createDomain({ db, userId }, { schema, embedder })`;
  add `import { schema } from '@movp/core-schema'` at the top.
- Lines 88, 94, 104, 107, 108, 111, 115, 118, 154, 155: `domain.note` → `domain.collection('note')`.
- Lines 96, 102: `domain.external_record` → `domain.collection('external_record')`.
- Line 142: `domain.tag` → `domain.collection('tag')`.

**Every other `createDomain(...)` in `packages/domain/test/*`** (grep below) — add `{ schema }`:
merge into the existing opts object where one exists (`{ embedder }` → `{ schema, embedder }`), else add
`, { schema }` as the second argument, and add the `@movp/core-schema` `schema` import to each file.

Run the full domain + mcp + graphql suites and typecheck — Expected: **PASS** (green, no regressions).

```
pnpm --filter @movp/domain exec vitest run
pnpm --filter @movp/mcp exec vitest run
pnpm --filter @movp/graphql exec vitest run
pnpm --filter @movp/domain exec tsc --noEmit
pnpm --filter @movp/mcp exec tsc --noEmit
pnpm --filter @movp/graphql exec tsc --noEmit
```

**GATE (machine-checkable):**
- `pnpm --filter @movp/domain exec vitest run` and mcp + graphql suites PASS.
- `grep -rnE "domain(From\([^)]*\))?\.(note|tag|external_record|workflow_run)\b" packages/domain/src packages/mcp/src packages/graphql/src packages/domain/test`
  returns **empty** (all rewired to `.collection('…')`).
- All three `tsc --noEmit` clean.

**COMMIT:** `feat(domain): C6b.3 schema-derived two-tier createDomain, rewire MCP/GraphQL/tests`

---

## Task 4 — `@movp/cli` `buildProgram(schema, opts)` threads the schema

**Files**
- EDIT `packages/cli/src/program.ts`
- EDIT `packages/cli/src/bin.ts`
- EDIT `packages/cli/test/program.test.ts` (helper passes `schema`)
- EDIT `packages/cli/test/integration.test.ts` (helper passes `schema`)

**Interfaces**
- *Consumes from 06a:* `import { schema } from '@movp/core-schema'` (bin, tests).
- *Produces:* `buildProgram(schema: MovpSchema, opts?: BuildProgramOpts): Command`.

### Step 4.1 — Failing test

In `packages/cli/test/program.test.ts`, add `import { schema } from '@movp/core-schema'` and change
the local `program()` helper (line ~139) to pass schema positionally:

```ts
function program(opts: Partial<BuildProgramOpts> = {}) {
  const out: string[] = []
  const cmd = buildProgram(schema, {
    resolveCtx: () => ({ db: {} as never, userId: 'u' }),
    out: (line) => out.push(line),
    ...opts,
  })
  cmd.exitOverride()
  return { cmd, out }
}
```

(Add `import type { BuildProgramOpts } from '../src/index.ts'` if not already imported.)

Do the same in `packages/cli/test/integration.test.ts` (line ~47): `buildProgram(schema, { out, readLoginToken })`.

Run — Expected: **FAIL** (`buildProgram` currently takes `(opts)`, so `buildProgram(schema, {...})`
is a type error / wrong arity).

```
pnpm --filter @movp/cli exec vitest run program
```

### Step 4.2 — Implement

In `packages/cli/src/program.ts`:

1. **Delete** line 3 `import { schema } from '@movp/core-schema'`. Keep line 2
   `import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'`.
2. Change the factory signature (line 47):

```ts
export function buildProgram(schema: MovpSchema, opts: BuildProgramOpts = {}): Command {
```

3. Default `runCodegen` (lines 52-58) must pass `schema` — the generated codegen now requires it:

```ts
  const runCodegen =
    opts.runCodegen ??
    (async () => {
      const mod = await import('@movp/codegen')
      if (!mod.generate) throw new Error('@movp/codegen.generate() not found')
      // generate() requires the schema by injection (C6b) — never a static import.
      await mod.generate({ schema })
    })
```

4. Every `createDomain(await resolveCtx())` in this file → `createDomain(await resolveCtx(), { schema })`
   (~20 call sites), and the `search` command's `createDomain(ctx).search({…})` →
   `createDomain(ctx, { schema }).search({…})`.
5. Line ~451 direct ref: `domain.workflow_run.list(...)` → `domain.collection('workflow_run').list(...)`.
   (The collection-command loop `for (const c of schema.collections as CollectionDef[])` already reads
   the parameter `schema` — no change beyond the signature.)

In `packages/cli/src/bin.ts`:

```ts
#!/usr/bin/env -S npx tsx
import { emit, REDACTION_VERSION } from '@movp/obs'
import { AdminDomainError } from '@movp/domain'
import { schema } from '@movp/core-schema'
import { buildProgram } from './program.ts'

buildProgram(schema)
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'cli',
      operation: process.argv[2] ?? 'unknown',
      error_code: err instanceof AdminDomainError ? err.pgCode : 'cli_error',
      redaction_version: REDACTION_VERSION,
    })
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
```

Run the CLI suite + typecheck — Expected: **PASS** (the `createDomain` mock in `program.test.ts`
ignores args, so the `{ schema }` second arg is inert there; the assertion at line ~395 on
`createDomain` call args still matches via `expect.objectContaining` on the first arg).

```
pnpm --filter @movp/cli exec vitest run
pnpm --filter @movp/cli exec tsc --noEmit
```

**GATE:** `pnpm --filter @movp/cli exec vitest run` PASS and
`grep -n "^import { schema }" packages/cli/src/program.ts` returns **empty**.

**COMMIT:** `feat(cli): C6b.4 buildProgram(schema, opts) threads injected schema`

---

## Task 5 — `movp verify-schema-runtime` cross-runtime guard

**Files**
- NEW `packages/cli/src/verify-schema-runtime.ts` (the Node-side comparator, spawn-injectable)
- NEW `packages/cli/src/verify-schema-runtime.deno.ts` (committed Deno fingerprint script)
- EDIT `packages/cli/src/program.ts` (register the command)
- EDIT `packages/cli/src/index.ts` (export `runVerifySchemaRuntime` + its types)
- NEW `packages/cli/test/verify-schema-runtime.test.ts` (injected-spawn unit gate)
- NEW fixture `packages/cli/test/fixtures/verify-schema-runtime/` (real-deno acceptance gate):
  `movp.config.mjs`, `deno.json`, `schema.match.mjs`, `schema.diverge.mjs`

**Interfaces**
- *Consumes from 06a/06b:* `schemaFingerprint` (Task 1), `MovpSchema`.
- *Produces:* `runVerifySchemaRuntime(opts): Promise<{ ok; code?: 'schema_runtime_mismatch';
  nodeFingerprint; denoFingerprint }>`; CLI command `movp verify-schema-runtime`.

**Contract (from INTERFACES "Cross-runtime guard"):** Node imports `movp.config.mjs` →
`schemaFingerprint`; spawns `deno run` with the scaffold `deno.json` to import the Edge schema module
→ `schemaFingerprint`; compares. Divergence → CLI throws `schema_runtime_mismatch` (exit 1 via
`bin.ts`). Match → prints `{ ok: true }` (exit 0). A **spawn/deno failure is NOT a mismatch** — it
throws a distinct `verify_schema_runtime_spawn_failed` error (also exit 1) so automation can tell a
real divergence from an operational failure (idempotency-cli exit-code discipline).

### Step 5.1 — Failing unit test (deterministic, injected spawn)

Write `packages/cli/test/verify-schema-runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { MovpSchema } from '@movp/core-schema'
import { schemaFingerprint } from '@movp/core-schema'
import { runVerifySchemaRuntime } from '../src/verify-schema-runtime.ts'

const nodeSchema: MovpSchema = {
  collections: [{ name: 'n', label: 'N', labelPlural: 'Ns', workspaceScoped: true, layer: 'platform', fields: {} }],
  events: [],
}
const nodeFp = schemaFingerprint(nodeSchema)

const baseOpts = {
  configPath: '/virtual/movp.config.mjs',
  denoConfigPath: '/virtual/deno.json',
  edgeSchemaSpecifier: './schema.ts',
  importConfig: async () => ({ schema: nodeSchema }),
}

describe('runVerifySchemaRuntime (C6b.5)', () => {
  it('returns ok when Node and Deno fingerprints match', async () => {
    const res = await runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 0, stdout: `${nodeFp}\n`, stderr: '' }),
    })
    expect(res).toEqual({ ok: true, nodeFingerprint: nodeFp, denoFingerprint: nodeFp })
  })

  it('flags schema_runtime_mismatch when the Deno fingerprint diverges', async () => {
    const denoFp = 'f'.repeat(64)
    const res = await runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 0, stdout: `${denoFp}\n`, stderr: '' }),
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('schema_runtime_mismatch')
    expect(res.nodeFingerprint).toBe(nodeFp)
    expect(res.denoFingerprint).toBe(denoFp)
  })

  it('throws a spawn-failure error (NOT a mismatch) when deno exits non-zero', async () => {
    await expect(
      runVerifySchemaRuntime({
        ...baseOpts,
        spawnDeno: () => ({ status: 1, stdout: '', stderr: 'deno: command not found' }),
      }),
    ).rejects.toThrow(/verify_schema_runtime_spawn_failed/)
  })
})
```

Run — Expected: **FAIL** (module not found).

```
pnpm --filter @movp/cli exec vitest run verify-schema-runtime
```

### Step 5.2 — Implement the comparator + Deno script

Create `packages/cli/src/verify-schema-runtime.ts`:

```ts
import type { MovpSchema } from '@movp/core-schema'
import { schemaFingerprint } from '@movp/core-schema'

export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface VerifySchemaRuntimeOpts {
  /** Path to movp.config.mjs (Node re-export of the one schema module). */
  configPath: string
  /** Path to the scaffold deno.json import map that resolves @movp/* and the edge schema. */
  denoConfigPath: string
  /** Module specifier for the Edge schema, resolved via deno.json under Deno. */
  edgeSchemaSpecifier: string
  /** Injectable for tests; defaults to a real `deno run` spawn. */
  spawnDeno?: (args: string[]) => SpawnResult
  /** Injectable for tests; defaults to dynamic import of configPath. */
  importConfig?: (path: string) => Promise<{ schema: MovpSchema }>
}

export interface VerifySchemaRuntimeResult {
  ok: boolean
  code?: 'schema_runtime_mismatch'
  nodeFingerprint: string
  denoFingerprint: string
}

function defaultSpawnDeno(args: string[]): SpawnResult {
  // Node builtin — no new dependency. The Deno process computes the fingerprint out-of-process
  // because a Node process cannot import the Deno-resolved schema in-process (the split-brain this
  // command closes). NEVER log stdout/stderr contents elsewhere — they are surfaced only in the
  // spawn-failure error path below and carry no schema field VALUES (only fingerprints/diagnostics).
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const r = spawnSync('deno', args, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function runVerifySchemaRuntime(opts: VerifySchemaRuntimeOpts): Promise<VerifySchemaRuntimeResult> {
  const importConfig = opts.importConfig ?? ((path: string) => import(path) as Promise<{ schema: MovpSchema }>)
  const spawnDeno = opts.spawnDeno ?? defaultSpawnDeno

  const mod = await importConfig(opts.configPath)
  const nodeFingerprint = schemaFingerprint(mod.schema)

  const scriptUrl = new URL('./verify-schema-runtime.deno.ts', import.meta.url)
  const scriptPath = decodeURIComponent(scriptUrl.pathname)
  const result = spawnDeno([
    'run',
    '--allow-read',
    '--allow-env',
    '--config',
    opts.denoConfigPath,
    scriptPath,
    opts.edgeSchemaSpecifier,
  ])

  if (result.status !== 0) {
    // Operational failure, NOT a divergence — distinct terminal state so automation reading the exit
    // code never mistakes a missing/broken deno for a schema mismatch.
    throw new Error(`verify_schema_runtime_spawn_failed: deno exited ${result.status ?? 'null'}: ${result.stderr.trim()}`)
  }

  const denoFingerprint = result.stdout.trim()
  if (!/^[0-9a-f]{64}$/.test(denoFingerprint)) {
    throw new Error(`verify_schema_runtime_spawn_failed: deno produced a non-fingerprint output`)
  }

  return denoFingerprint === nodeFingerprint
    ? { ok: true, nodeFingerprint, denoFingerprint }
    : { ok: false, code: 'schema_runtime_mismatch', nodeFingerprint, denoFingerprint }
}
```

Create `packages/cli/src/verify-schema-runtime.deno.ts` (committed; runs under Deno only):

```ts
// Runs under Deno (Supabase edge runtime toolchain). Imports the Edge schema via the specifier the
// scaffold deno.json resolves, computes the SAME schemaFingerprint as the Node side, prints it.
// Deno globals (`Deno`) are intentional here and unavailable under Node — this file is spawned, never
// imported by Node. schemaFingerprint resolves via the deno.json import map (@movp/core-schema).
import { schemaFingerprint } from '@movp/core-schema'

const specifier = Deno.args[0]
if (!specifier) {
  console.error('verify-schema-runtime.deno: missing edge schema specifier')
  Deno.exit(2)
}
const mod = await import(specifier)
console.log(schemaFingerprint(mod.schema))
```

Note for the executor: `verify-schema-runtime.deno.ts` references the `Deno` global, which the CLI
package's Node `tsconfig` does not know. Exclude it from the package typecheck by adding it to the
package `tsconfig.json` `"exclude"` array (e.g. `"src/verify-schema-runtime.deno.ts"`); it is
type-checked by Deno at spawn time, not by `tsc`. Confirm `pnpm --filter @movp/cli exec tsc --noEmit`
stays clean after the exclude.

Run the unit test — Expected: **PASS** (3 tests).

```
pnpm --filter @movp/cli exec vitest run verify-schema-runtime
```

### Step 5.3 — Register the command + export

In `packages/cli/src/program.ts`, add (near the other top-level `program.command(...)` blocks, e.g.
after `codegen`):

```ts
  program
    .command('verify-schema-runtime')
    .description('Fail before serve/deploy if the Node and Deno schema fingerprints diverge')
    .requiredOption('--config <path>', 'path to movp.config.mjs (Node schema re-export)')
    .requiredOption('--deno-config <path>', 'path to the scaffold deno.json import map')
    .requiredOption('--edge-schema <specifier>', 'Edge schema module specifier (resolved via deno.json)')
    .action(async (o: { config: string; denoConfig: string; edgeSchema: string }) => {
      const { runVerifySchemaRuntime } = await import('./verify-schema-runtime.ts')
      const res = await runVerifySchemaRuntime({
        configPath: o.config,
        denoConfigPath: o.denoConfig,
        edgeSchemaSpecifier: o.edgeSchema,
      })
      // Throwing routes through bin.ts's catch → exit 1 with the stable code in the message.
      if (!res.ok) {
        throw new Error(`schema_runtime_mismatch: node=${res.nodeFingerprint} deno=${res.denoFingerprint}`)
      }
      out(JSON.stringify({ ok: true, fingerprint: res.nodeFingerprint }))
    })
```

In `packages/cli/src/index.ts`, add:

```ts
export { runVerifySchemaRuntime, type VerifySchemaRuntimeOpts, type VerifySchemaRuntimeResult } from './verify-schema-runtime.ts'
```

### Step 5.4 — Real-Deno acceptance fixture + gate

Create the fixture (real cross-runtime proof — this is the C6b acceptance gate line "a fixture that
changes only the Deno-facing schema fails with a stable `schema_runtime_mismatch`").

`packages/cli/test/fixtures/verify-schema-runtime/schema.match.mjs`:

```js
export const schema = {
  collections: [
    { name: 'contact', label: 'Contact', labelPlural: 'Contacts', workspaceScoped: true, layer: 'project', fields: {} },
  ],
  events: [],
}
```

`packages/cli/test/fixtures/verify-schema-runtime/schema.diverge.mjs` — identical EXCEPT one extra
projected field (so only the Deno-facing schema differs):

```js
export const schema = {
  collections: [
    {
      name: 'contact', label: 'Contact', labelPlural: 'Contacts', workspaceScoped: true, layer: 'project',
      fields: { email: { type: 'text', label: 'Email' } },
    },
  ],
  events: [],
}
```

`packages/cli/test/fixtures/verify-schema-runtime/movp.config.mjs` (Node side — the MATCH schema):

```js
export { schema } from './schema.match.mjs'
```

`packages/cli/test/fixtures/verify-schema-runtime/deno.json` (maps `@movp/core-schema` to source so
Deno computes the same fingerprint fn; the real `npm:@movp/*` resolution smoke is C6d, not here):

```json
{
  "imports": {
    "@movp/core-schema": "../../../../core-schema/src/index.ts"
  }
}
```

Add the acceptance test to `packages/cli/test/verify-schema-runtime.test.ts` (real `deno`, guarded so
the suite still runs where deno is absent; the GATE requires deno installed):

```ts
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const fixture = fileURLToPath(new URL('./fixtures/verify-schema-runtime/', import.meta.url))

describe.skipIf(!hasDeno)('verify-schema-runtime real Deno cross-runtime gate (C6b.5 acceptance)', () => {
  it('matches when Node config and Deno edge schema are identical', async () => {
    const res = await runVerifySchemaRuntime({
      configPath: `${fixture}movp.config.mjs`,
      denoConfigPath: `${fixture}deno.json`,
      edgeSchemaSpecifier: `${fixture}schema.match.mjs`,
    })
    expect(res.ok).toBe(true)
  })

  it('fails with schema_runtime_mismatch when only the Deno-facing schema changes', async () => {
    const res = await runVerifySchemaRuntime({
      configPath: `${fixture}movp.config.mjs`,        // MATCH schema on the Node side
      denoConfigPath: `${fixture}deno.json`,
      edgeSchemaSpecifier: `${fixture}schema.diverge.mjs`, // DIVERGED schema on the Deno side
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('schema_runtime_mismatch')
  })
})
```

Run — Expected: **PASS** (unit 3 + acceptance 2 = 5 when deno present; unit 3 + 2 skipped otherwise).
Then typecheck.

```
pnpm --filter @movp/cli exec vitest run verify-schema-runtime
pnpm --filter @movp/cli exec tsc --noEmit
deno --version   # Expected: prints a version — REQUIRED for the acceptance gate; install if absent
```

**GATE (machine-checkable):**
- `pnpm --filter @movp/cli exec vitest run verify-schema-runtime` PASS with **no skipped** acceptance
  tests (i.e. `deno` is installed and the two real-Deno cases run).
- `pnpm --filter @movp/cli exec tsc --noEmit` clean.

**COMMIT:** `feat(cli): C6b.5 movp verify-schema-runtime cross-runtime guard`

---

## Final whole-repo gate (run after Task 5)

```
pnpm -w test        # Expected: all package suites green
pnpm -w typecheck   # Expected: clean
```

Confirm the three static imports are gone (the seam is fully injected):

```
grep -rn "^import { schema } from '@movp/core-schema'" packages/codegen/src packages/cli/src
# Expected: EMPTY. (The schema is imported only at entrypoints: scripts/codegen.ts, bin.ts,
#  and the edge functions — which are unchanged and already import it.)
```

## Eight-Dimension self-check

- **Correctness** — projection equals the DB-compared columns (`emit-sql.ts:76-107`) + `layer`;
  fingerprint is canonical (sorted, fixed key order); tier split verified against the real
  internal/custom sets. Samples grounded in the tree and self-consistent with prose.
- **Safety** — no secrets, no new network surface; `verify-schema-runtime` never logs schema field
  VALUES (only fingerprints); spawn failure is a distinct terminal state, not a false "match".
- **Reliability** — spawn/deno failure ≠ mismatch (separate error id + exit path); fingerprint output
  validated by shape before comparison; injected-spawn unit test pins the classification.
- **Observability** — `schema_runtime_mismatch` and `verify_schema_runtime_spawn_failed` are stable,
  message-carried codes surfaced via `bin.ts`'s structured `emit`.
- **Efficiency** — generic registry built once per `createDomain`; fingerprint hashes a single
  canonical JSON; no per-collection hand map to maintain.
- **Performance** — no added round-trips on hot paths; `verify-schema-runtime` is a pre-serve CLI, off
  the request path; `createDomain` map build is O(collections), same as the prior literal map.
- **Simplicity** — one accessor replaces 22 hand-written properties; MCP/GraphQL untouched beyond one
  opts field + one helper body each.
- **Usability** — command has descriptive `--config/--deno-config/--edge-schema` flags and a clear
  error message naming both fingerprints on divergence.
