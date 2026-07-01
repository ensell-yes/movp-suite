# MOVP Core — API Surfaces (GraphQL, MCP, CLI, Observability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three first-class consumer surfaces of the MOVP domain core — a code-first **GraphQL** gateway (Pothos + Yoga) with depth/complexity guardrails and DataLoader-batched relations, an **MCP** server exposing per-collection tools, and a Node **CLI** — plus the shared **observability** contract (`@movp/obs`) every surface emits through. All three surfaces consume the already-built `@movp/auth`, `@movp/core-schema`, and `@movp/domain`; none re-implement CRUD.

**Architecture:** Four new `@movp/*` packages (`obs`, `graphql`, `mcp`, `cli`) plus two Supabase Edge Functions (`functions/graphql`, `functions/mcp`). The edge functions resolve the principal **at call time** via `resolvePrincipal(req, env)`, return `401` on failure, and pass the RLS-bound `{ db, userId, embedder? }` into the surface as request context; resolvers/tools build `createDomain({ db, userId }, { embedder })` from that context per call. The optional embedder is a context dependency, not a Deno-only import inside `@movp/graphql`/`@movp/mcp`; Plan 5 creates `GteSmallProvider` and wires it into both edge functions so semantic/hybrid search is reachable through GraphQL and MCP. The GraphQL schema is generated **dynamically from `MovpSchema`** (one builder loop over `collections`), so adding a collection adds GraphQL types/queries/mutations with no edits. Query-shape safety (depth limit 10, complexity budget 1000, cursor pagination with a hard max of 100, DataLoader-batched relations) is baked into the Pothos schema so it holds under hostile/naive queries inside the 256 MB / 2 s-CPU edge envelope.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest. GraphQL: `@pothos/core@^4`, `@pothos/plugin-dataloader@^4`, `@pothos/plugin-complexity@^4`, `graphql@^16`, `graphql-yoga@^5`. MCP: `@modelcontextprotocol/sdk@1.25.3`, `zod`. CLI: `commander@^12`, `tsx`. Supabase Edge Functions (Deno) resolve bare specifiers via per-function `deno.json` import maps.

**This plan is Plan 4 of the Phase 1 (MOVP Core) series.** The north-star + Phase 1 design lives at `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`; it covers design build-sequence Tasks 6–8 (GraphQL, MCP, CLI) plus the observability contract and the `graphql-shape` guardrails. Plan 1 (Foundation: scaffold, tenancy, `@movp/auth`) and Plans 2–3 (Schema DSL & Codegen, Domain Core) precede it; Plans 5–6 (Search & Async, Frontend & CI) follow.

## Global Constraints

- **Consume, do not rebuild.** `@movp/auth` (`resolvePrincipal`), `@movp/core-schema` (`MovpSchema`, `CollectionDef`, `FieldDef`, exported `schema`), and `@movp/domain` (`createDomain`, `Domain`, `CollectionService`, `SearchHit`, row/create/update types) are fixed inputs. Do not change their signatures; do not invent `@movp/flows` / `GraphService.link` internals (owned by Plans 3/5).
- **Per-request dependencies resolved at call time, never module scope.** The RLS-bound `db` + `userId` are resolved from the request in the edge function and threaded as Yoga/MCP context; resolvers/tools call `createDomain({ db, userId }, { embedder: ctx.embedder })` from that context. The optional `embedder` is also request context; until Plan 5 wires the Deno edge provider, semantic/hybrid calls fail loudly with the domain's `requires opts.embedder` error instead of returning fake/empty results. The ONE module-scope object is the stateless Yoga instance (it holds no per-request state — context is injected per call). On Deno read env with `Deno.env.get` at call time.
- **Authoritative authz at the data boundary.** RLS + the verified principal are authoritative. The edge function verifies via `@movp/auth` (functions run with `verify_jwt = false` and self-verify) and fails closed with the stable `code`.
- **Runtime-agnostic libraries.** `@movp/obs`, `@movp/graphql`, `@movp/mcp` import nothing Node- or Deno-only (bare specifiers + web APIs: `Request`, `crypto.randomUUID`, `console`). `@movp/cli` is Node-only (it may use `node:` builtins).
- **Relative imports inside `@movp/*` packages use explicit `.ts` extensions.** `tsconfig.base.json` is `moduleResolution: "bundler"` + `allowImportingTsExtensions` + `noEmit`; source is consumed directly. Internal `@movp/*` deps are declared `"workspace:*"`; external deps are bare-versioned.
- **Observability discipline:** never log a field VALUE or PII. `@movp/obs.emit` strips any string field containing `@`, validates the `surface` enum by value (out-of-enum → coerce to `unknown` AND emit a second `observability_enum_violation` event — never drop the event), and forces `redaction_version` to the constant `1`.
- **Edge envelope:** 256 MB / 2 s CPU (Postgres I/O wait excluded). Resolvers stay I/O-bound; the complexity budget + page clamp + DataLoader batching keep work bounded.

## File Structure

```
supasuite/
  supabase/
    config.toml                              # EDIT: add [functions.graphql]/[functions.mcp] verify_jwt=false
    functions/
      graphql/
        index.ts                             # Deno.serve: resolvePrincipal -> 401 | Yoga(/graphql)
        deno.json                            # import map: @movp/* -> src, bare -> npm:
      mcp/
        index.ts                             # Deno.serve: resolvePrincipal -> 401 | MCP WebStandard transport
        deno.json
      _e2e/                                   # NOT deployed (Supabase ignores _-prefixed dirs)
        lib.ts                               # provision(): admin-create user + workspace + sign-in -> access token
        graphql_smoke.ts                     # functions-serve integration gate for the GraphQL edge fn
  packages/
    obs/
      package.json tsconfig.json vitest.config.ts
      src/{index.ts,event.ts,emit.ts}
      test/emit.test.ts
    graphql/
      package.json tsconfig.json vitest.config.ts
      src/{index.ts,types.ts,limits.ts,relations.ts,schema.ts,yoga.ts}
      test/{schema.test.ts,relations.test.ts}
    mcp/
      package.json tsconfig.json vitest.config.ts
      src/{index.ts,server.ts}
      test/server.test.ts
    cli/
      package.json tsconfig.json vitest.config.ts
      src/{index.ts,client.ts,program.ts,bin.ts}
      test/program.test.ts
```

---

### Task 1: `@movp/obs` — the observability emit contract

**Files:**
- Create: `packages/obs/package.json`, `packages/obs/tsconfig.json`, `packages/obs/vitest.config.ts`
- Create: `packages/obs/src/event.ts`, `packages/obs/src/emit.ts`, `packages/obs/src/index.ts`
- Test: `packages/obs/test/emit.test.ts`

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces (relied on by both edge functions + the CLI):
  - `type Surface = 'graphql' | 'mcp' | 'cli' | 'flows' | 'embed'`
  - `interface ObsEvent { trace_id; request_id; workspace_id_hash?; actor_id?; actor_email_hash?; surface: Surface; operation; collection?; error_code; latency_ms?; attempt?; redaction_version }`
  - `const REDACTION_VERSION = 1`
  - `emit(e: ObsEvent): void`

- [ ] **Step 1: Create the package skeleton**

`packages/obs/package.json`:
```json
{
  "name": "@movp/obs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/obs/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/obs/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: installs `vitest` for the new package; lockfile updates.

- [ ] **Step 2: Write the failing test**

`packages/obs/test/emit.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emit, REDACTION_VERSION, type ObsEvent } from '../src/index.ts'

function baseEvent(over: Partial<ObsEvent> = {}): ObsEvent {
  return {
    trace_id: 'trace-1',
    request_id: 'req-1',
    surface: 'graphql',
    operation: 'note.create',
    error_code: 'ok',
    redaction_version: REDACTION_VERSION,
    ...over,
  }
}

describe('emit', () => {
  let logs: string[]
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logs = []
    spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
  })
  afterEach(() => spy.mockRestore())

  it('emits exactly one structured JSON line for a valid event', () => {
    emit(baseEvent({ workspace_id_hash: 'ws-hash', actor_id: 'u1' }))
    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0])
    expect(parsed.surface).toBe('graphql')
    expect(parsed.operation).toBe('note.create')
    expect(parsed.error_code).toBe('ok')
    expect(parsed.redaction_version).toBe(1)
  })

  it('coerces an out-of-enum surface to "unknown" and emits a violation event', () => {
    emit(baseEvent({ surface: 'webhook' as unknown as ObsEvent['surface'] }))
    expect(logs).toHaveLength(2)
    const first = JSON.parse(logs[0])
    const second = JSON.parse(logs[1])
    expect(first.surface).toBe('unknown')
    expect(second.surface).toBe('unknown')
    expect(second.error_code).toBe('observability_enum_violation')
  })

  it('strips any string field containing "@" (no PII leakage)', () => {
    emit(baseEvent({ actor_email_hash: 'leaked@example.com' }))
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('@')
    expect(JSON.parse(logs[0]).actor_email_hash).toBeUndefined()
  })

  it('forces redaction_version to the constant regardless of input', () => {
    emit(baseEvent({ redaction_version: 99 }))
    expect(JSON.parse(logs[0]).redaction_version).toBe(1)
  })

  it('drops undefined optional fields', () => {
    emit(baseEvent())
    const parsed = JSON.parse(logs[0])
    expect('latency_ms' in parsed).toBe(false)
    expect('collection' in parsed).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/obs test
```
Expected: FAIL — cannot resolve `../src/index.ts` / `emit` is not defined.

- [ ] **Step 4: Implement the package**

`packages/obs/src/event.ts`:
```ts
export type Surface = 'graphql' | 'mcp' | 'cli' | 'flows' | 'embed'

export interface ObsEvent {
  trace_id: string
  request_id: string
  workspace_id_hash?: string
  actor_id?: string
  actor_email_hash?: string
  surface: Surface
  operation: string
  collection?: string
  error_code: string
  latency_ms?: number
  attempt?: number
  redaction_version: number
}

// Single source of truth for the redaction scheme version.
export const REDACTION_VERSION = 1
```

`packages/obs/src/emit.ts`:
```ts
import { REDACTION_VERSION, type ObsEvent, type Surface } from './event.ts'

// Bounded enum validated BY VALUE at emit time (not merely allow-listed by key).
const SURFACES: readonly string[] = ['graphql', 'mcp', 'cli', 'flows', 'embed']
function isSurface(v: unknown): v is Surface {
  return typeof v === 'string' && SURFACES.includes(v)
}

// Content discipline: drop undefined keys and any string VALUE containing '@'
// (email-shaped). Field names only — never a field value's PII.
function redact(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue
    if (typeof v === 'string' && v.includes('@')) continue
    out[k] = v
  }
  return out
}

function write(rec: Record<string, unknown>): void {
  // Structured JSON on stdout; the only sink in v1.
  console.log(JSON.stringify(rec))
}

export function emit(e: ObsEvent): void {
  const violated = !isSurface(e.surface)
  const surface: string = violated ? 'unknown' : e.surface
  // Never drop the event: emit the (coerced) failure signal first.
  write(redact({ ...e, surface, redaction_version: REDACTION_VERSION }))
  if (violated) {
    // Then raise a SECOND event flagging the enum violation.
    write(
      redact({
        ...e,
        surface: 'unknown',
        error_code: 'observability_enum_violation',
        redaction_version: REDACTION_VERSION,
      }),
    )
  }
}
```

`packages/obs/src/index.ts`:
```ts
export { emit } from './emit.ts'
export { REDACTION_VERSION } from './event.ts'
export type { ObsEvent, Surface } from './event.ts'
```

- [ ] **Step 5: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/obs test && pnpm --filter @movp/obs typecheck
```
Expected: PASS — all 5 cases green; `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/obs && git commit -m "feat(obs): structured emit with enum-coercion + PII redaction"
```

---

### Task 2: `@movp/graphql` package — dynamic Pothos schema + Yoga factory

Build the schema generator and the Yoga factory as a pure library (no Deno, no edge). The schema is built **dynamically from `MovpSchema`**: one ref per collection, scalar fields exposed by column name, relation fields as DataLoader-batched lists, plus `<name>` (get), `<name>s` (clamped page), `create<Name>` (mutation), and a top-level `search`. Depth (10) and complexity (1000) are enforced by `@pothos/plugin-complexity` baked into the schema; pagination is clamped by `clampPageSize`.

**Files:**
- Create: `packages/graphql/package.json`, `packages/graphql/tsconfig.json`, `packages/graphql/vitest.config.ts`
- Create: `packages/graphql/src/types.ts`, `src/limits.ts`, `src/relations.ts`, `src/schema.ts`, `src/yoga.ts`, `src/index.ts`
- Test: `packages/graphql/test/schema.test.ts`, `packages/graphql/test/relations.test.ts`

**Interfaces:**
- Consumes: `@movp/core-schema` (`MovpSchema`, `CollectionDef`, `FieldDef`, `schema`); `@movp/domain` (`createDomain`, `Domain`, `CollectionService`, `SearchHit`); `@supabase/supabase-js` (`SupabaseClient` type).
- Produces (relied on by `functions/graphql`):
  - `interface GraphQLContext { db: SupabaseClient; userId: string; embedder?: EmbeddingProvider }`
  - `buildSchema(schema: MovpSchema): GraphQLSchema`
  - `createYoga(opts: { schema: MovpSchema }): YogaServerInstance` (depth+complexity enforced via the schema's Pothos plugin)
  - `clampPageSize(first?: number | null): number`, constants `DEFAULT_PAGE_SIZE=20`, `MAX_PAGE_SIZE=100`, `DEPTH_LIMIT=10`, `COMPLEXITY_BUDGET=1000`
  - `loadEdgeTargets(db, { srcType, rel, dstType, srcIds }): Promise<Row[][]>`

- [ ] **Step 1: Create the package skeleton**

`packages/graphql/package.json`:
```json
{
  "name": "@movp/graphql",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@movp/core-schema": "workspace:*",
    "@movp/domain": "workspace:*",
    "@pothos/core": "^4.3.0",
    "@pothos/plugin-complexity": "^4.1.0",
    "@pothos/plugin-dataloader": "^4.1.0",
    "@supabase/supabase-js": "^2.45.0",
    "graphql": "^16.9.0",
    "graphql-yoga": "^5.10.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/graphql/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/graphql/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: installs Pothos, graphql, graphql-yoga; links `@movp/core-schema` + `@movp/domain` from the workspace.

- [ ] **Step 2: Write the failing tests**

`packages/graphql/test/relations.test.ts` (the no-N+1 / bounded-SQL gate — pure function, no live DB):
```ts
import { describe, expect, it } from 'vitest'
import { loadEdgeTargets } from '../src/relations.ts'

// Minimal supabase-js query-builder fake that records every .from(table) call and
// resolves on the terminal .in(). Proves the batch issues a BOUNDED number of
// statements regardless of how many source ids are requested.
function fakeDb(edges: { src_id: string; dst_id: string }[], tags: Record<string, unknown>[]) {
  const calls: string[] = []
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => Promise.resolve({ data: table === 'edges' ? edges : tags }),
    }
    return b
  }
  return {
    calls,
    from(table: string) {
      calls.push(table)
      return builder(table)
    },
  }
}

describe('loadEdgeTargets', () => {
  it('returns [] for empty input without touching the db', async () => {
    const db = fakeDb([], [])
    const out = await loadEdgeTargets(db as any, { srcType: 'note', rel: 'tags', dstType: 'tag', srcIds: [] })
    expect(out).toEqual([])
    expect(db.calls).toEqual([])
  })

  it('issues exactly 2 statements for any number of source ids (no N+1)', async () => {
    const srcIds = Array.from({ length: 50 }, (_v, i) => `n${i}`)
    const edges = [
      { src_id: 'n0', dst_id: 't1' },
      { src_id: 'n0', dst_id: 't2' },
      { src_id: 'n1', dst_id: 't1' },
    ]
    const tags = [
      { id: 't1', workspace_id: 'w', created_at: 'c', updated_at: 'u', name: 'a' },
      { id: 't2', workspace_id: 'w', created_at: 'c', updated_at: 'u', name: 'b' },
    ]
    const db = fakeDb(edges, tags)
    const out = await loadEdgeTargets(db as any, { srcType: 'note', rel: 'tags', dstType: 'tag', srcIds })
    expect(db.calls).toEqual(['edges', 'tag']) // bounded: 1 edges query + 1 tag query
    expect(out).toHaveLength(50)
    expect((out[0] as any[]).map((t) => t.id)).toEqual(['t1', 't2']) // n0 -> [t1,t2], order preserved
    expect((out[1] as any[]).map((t) => t.id)).toEqual(['t1'])
    expect(out[2]).toEqual([]) // n2 has no edges
  })
})
```

`packages/graphql/test/schema.test.ts` (build shape, depth/complexity rejection, page clamp). Mocks `@movp/domain.createDomain` so resolver execution is deterministic without a DB:
```ts
import { describe, expect, it, vi } from 'vitest'

// Stable mock domain — createDomain returns the SAME service objects every call,
// so spies are assertable across resolver invocations.
const noteList = vi.fn(async (args: { first?: number }) => ({ items: [{ id: 'n1' }], nextCursor: null }))
vi.mock('@movp/domain', () => {
  const note = {
    create: vi.fn(async (i: Record<string, unknown>) => ({ id: 'n1', ...i })),
    get: vi.fn(async () => ({ id: 'n1', title: 'Hello' })),
    list: noteList,
    update: vi.fn(),
    delete: vi.fn(),
  }
  const tag = { create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() }
  return {
    createDomain: () => ({ note, tag, search: vi.fn(async () => []), graph: { link: vi.fn(), traverse: vi.fn() } }),
  }
})

import { graphql, printSchema } from 'graphql'
import type { MovpSchema, FieldDef } from '@movp/core-schema'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const ctx = { db: {} as never, userId: 'u' }

// A self-referential fixture so depth/complexity are testable independent of the
// real schema's relation shape.
const recursive: MovpSchema = {
  collections: [
    {
      name: 'node',
      label: 'Node',
      labelPlural: 'Nodes',
      workspaceScoped: true,
      fields: {
        title: { type: 'text', label: 'Title' } as FieldDef,
        children: {
          type: 'relation',
          label: 'Children',
          target: 'node',
          cardinality: 'many-to-many',
          graph: true,
        } as FieldDef,
      },
    },
  ],
}

describe('buildSchema', () => {
  it('generates a type + queries + mutation per collection', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toContain('type Note')
    expect(sdl).toContain('type Tag')
    expect(sdl).toMatch(/note\(id: ID!\): Note/)
    expect(sdl).toMatch(/notes\(/)
    expect(sdl).toContain('createNote(')
    expect(sdl).toContain('search(')
    expect(sdl).toContain('tags: [Tag!]!') // relation exposed as a non-null list
  })

  it('clamps an over-large page request to MAX_PAGE_SIZE and runs', async () => {
    noteList.mockClear()
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { notes(workspaceId: "w", first: 1000) { items { id } nextCursor } }`,
      contextValue: ctx,
    })
    expect(result.errors).toBeUndefined()
    expect(noteList).toHaveBeenCalledWith({ workspaceId: 'w', first: 100, after: null })
  })

  it('rejects an over-depth query before execution', async () => {
    let sel = '{ id }'
    for (let i = 0; i < 12; i++) sel = `{ children ${sel} }`
    const result = await graphql({
      schema: buildSchema(recursive),
      source: `query { node(id: "x") ${sel} }`,
      contextValue: ctx,
    })
    expect(result.data == null || result.data.node == null).toBe(true)
    expect((result.errors ?? []).length).toBeGreaterThan(0)
    expect(JSON.stringify(result.errors)).toMatch(/depth|complexity|exceed/i)
  })

  it('rejects an over-complexity query before execution', async () => {
    const result = await graphql({
      schema: buildSchema(recursive),
      source: `query { nodes(workspaceId: "w", first: 100) { items { id title children { id title } } } }`,
      contextValue: ctx,
    })
    expect(result.data == null || result.data.nodes == null).toBe(true)
    expect((result.errors ?? []).length).toBeGreaterThan(0)
    expect(JSON.stringify(result.errors)).toMatch(/complexity|exceed/i)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @movp/graphql test
```
Expected: FAIL — cannot resolve `../src/relations.ts` / `../src/schema.ts`.

- [ ] **Step 4: Implement the package**

`packages/graphql/src/types.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmbeddingProvider } from '@movp/domain'

// Per-request context threaded by the edge function; resolvers call
// createDomain({ db, userId }, { embedder }) from it at call time.
export interface GraphQLContext {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
}

// Generic row shape every generated object resolves over (column-named fields).
export type Row = { id: string; workspace_id: string; created_at: string; updated_at: string } & Record<
  string,
  unknown
>
```

`packages/graphql/src/limits.ts`:
```ts
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
export const DEPTH_LIMIT = 10
export const COMPLEXITY_BUDGET = 1000

// Clamp a requested page size into [1, MAX_PAGE_SIZE], defaulting when absent.
// Used BOTH as the domain.list page size AND as the complexity multiplier, so the
// cost a query is charged matches the work it can actually trigger.
export function clampPageSize(first?: number | null): number {
  if (first == null) return DEFAULT_PAGE_SIZE
  if (first < 1) return 1
  return Math.min(first, MAX_PAGE_SIZE)
}
```

`packages/graphql/src/relations.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Row } from './types.ts'

// Batch-load a many-to-many relation for MANY source rows in a BOUNDED number of
// statements (2), regardless of how many sources are in the selection. This is
// what prevents N+1 when a nested relation is requested across a list. The edge
// model (edges(src_type,src_id,rel,dst_type,dst_id,...)) is defined in the design.
export async function loadEdgeTargets(
  db: SupabaseClient,
  opts: { srcType: string; rel: string; dstType: string; srcIds: readonly string[] },
): Promise<Row[][]> {
  const { srcType, rel, dstType, srcIds } = opts
  if (srcIds.length === 0) return []

  // 1) one query: every (src -> dst) edge for the requested sources.
  const edgesRes = await db
    .from('edges')
    .select('src_id, dst_id')
    .eq('src_type', srcType)
    .eq('rel', rel)
    .eq('dst_type', dstType)
    .in('src_id', srcIds as string[])
  const edges = (edgesRes.data ?? []) as { src_id: string; dst_id: string }[]

  // 2) one query: hydrate the referenced target rows.
  const dstIds = [...new Set(edges.map((e) => e.dst_id))]
  const tagsRes = dstIds.length ? await db.from(dstType).select('*').in('id', dstIds) : { data: [] as Row[] }
  const byId = new Map<string, Row>()
  for (const r of (tagsRes.data ?? []) as Row[]) byId.set(r.id, r)

  // Map back, preserving input (src) order; preserving edge order within each src.
  const grouped = new Map<string, Row[]>()
  for (const e of edges) {
    const target = byId.get(e.dst_id)
    if (!target) continue
    const list = grouped.get(e.src_id) ?? []
    list.push(target)
    grouped.set(e.src_id, list)
  }
  return srcIds.map((id) => grouped.get(id) ?? [])
}
```

`packages/graphql/src/schema.ts`:
```ts
import SchemaBuilder from '@pothos/core'
import ComplexityPlugin from '@pothos/plugin-complexity'
import DataloaderPlugin from '@pothos/plugin-dataloader'
import type { GraphQLSchema } from 'graphql'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import {
  createDomain,
  type CollectionService,
  type Domain,
  type SearchHit,
} from '@movp/domain'
import { COMPLEXITY_BUDGET, DEPTH_LIMIT, clampPageSize } from './limits.ts'
import { loadEdgeTargets } from './relations.ts'
import type { GraphQLContext, Row } from './types.ts'

function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function plural(s: string): string {
  return `${s}s`
}

// Resolve a per-collection CRUD service off the domain by name. Missing -> fail loud.
function service(
  domain: Domain,
  name: string,
): CollectionService<Row, Record<string, unknown>, Record<string, unknown>> {
  const svc = (domain as unknown as Record<
    string,
    CollectionService<Row, Record<string, unknown>, Record<string, unknown>>
  >)[name]
  if (!svc || typeof svc.create !== 'function') {
    throw new Error(`no domain service for collection: ${name}`)
  }
  return svc
}

function domainFrom(ctx: GraphQLContext): Domain {
  return createDomain({ db: ctx.db, userId: ctx.userId }, { embedder: ctx.embedder })
}

export function buildSchema(schema: MovpSchema): GraphQLSchema {
  const builder = new SchemaBuilder<{ Context: GraphQLContext }>({
    plugins: [DataloaderPlugin, ComplexityPlugin],
    // Depth + complexity enforced together; over-budget ops are rejected with a
    // GraphQL error before resolvers run.
    complexity: { limit: { complexity: COMPLEXITY_BUDGET, depth: DEPTH_LIMIT, breadth: 500 } },
  })

  // Pothos generics fight a fully-dynamic build; the field builder `t` is cast to
  // any inside the loops. Runtime correctness is covered by the tests.
  const refs = new Map<string, any>()
  for (const c of schema.collections) refs.set(c.name, builder.objectRef<Row>(pascal(c.name)))

  const searchHit = builder.objectRef<SearchHit>('SearchHit').implement({
    fields: (t) => ({
      collection: t.exposeString('collection'),
      id: t.exposeID('id'),
      title: t.exposeString('title'),
      snippet: t.exposeString('snippet'),
      score: t.exposeFloat('score'),
    }),
  })

  const pages = new Map<string, any>()
  const inputs = new Map<string, any>()

  for (const c of schema.collections) {
    const ref = refs.get(c.name)
    ref.implement({
      fields: (t: any) => {
        const fields: Record<string, any> = {
          id: t.exposeID('id'),
          workspace_id: t.exposeString('workspace_id'),
          created_at: t.exposeString('created_at'),
          updated_at: t.exposeString('updated_at'),
        }
        for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
          if (def.type === 'relation') {
            const target = refs.get((def as any).target)
            // DataLoader-batched list field: resolve returns the parent key, load
            // batches all keys via loadEdgeTargets (bounded SQL -> no N+1).
            fields[name] = t.loadable({
              type: [target],
              nullable: false,
              complexity: 10,
              resolve: (row: Row) => row.id,
              load: (ids: string[], lctx: GraphQLContext) =>
                loadEdgeTargets(lctx.db, {
                  srcType: c.name,
                  rel: name,
                  dstType: (def as any).target,
                  srcIds: ids,
                }),
            })
          } else {
            fields[name] = t.string({
              nullable: true,
              complexity: 1,
              resolve: (row: Row) => {
                const v = row[name]
                return v == null ? null : String(v)
              },
            })
          }
        }
        return fields
      },
    })

    pages.set(
      c.name,
      builder
        .objectRef<{ items: Row[]; nextCursor: string | null }>(`${pascal(c.name)}Page`)
        .implement({
          fields: (t: any) => ({
            items: t.field({ type: [ref], resolve: (p: any) => p.items }),
            nextCursor: t.string({ nullable: true, resolve: (p: any) => p.nextCursor }),
          }),
        }),
    )

    inputs.set(
      c.name,
      builder.inputRef<Record<string, unknown>>(`${pascal(c.name)}CreateInput`).implement({
        fields: (t: any) => {
          const f: Record<string, any> = { workspace_id: t.id({ required: true }) }
          for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
            if (def.type === 'relation') continue
            f[name] = t.string({ required: !!(def as any).required })
          }
          return f
        },
      }),
    )
  }

  builder.queryType({})
  builder.mutationType({})

  for (const c of schema.collections) {
    const ref = refs.get(c.name)
    const page = pages.get(c.name)
    const input = inputs.get(c.name)

    builder.queryField(c.name, (t: any) =>
      t.field({
        type: ref,
        nullable: true,
        complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          service(domainFrom(ctx), c.name).get(String(args.id)),
      }),
    )

    builder.queryField(plural(c.name), (t: any) =>
      t.field({
        type: page,
        // Cost is proportional to the CLAMPED page size, so first:1000 is charged
        // (and served) as 100.
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          service(domainFrom(ctx), c.name).list({
            workspaceId: String(args.workspaceId),
            first: clampPageSize(args.first),
            after: args.after ?? null,
          }),
      }),
    )

    builder.mutationField(`create${pascal(c.name)}`, (t: any) =>
      t.field({
        type: ref,
        complexity: 10,
        args: { input: t.arg({ type: input, required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          service(domainFrom(ctx), c.name).create(args.input),
      }),
    )
  }

  builder.queryField('search', (t: any) =>
    t.field({
      type: [searchHit],
      complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.limit) }),
      args: {
        workspaceId: t.arg.id({ required: true }),
        query: t.arg.string({ required: true }),
        mode: t.arg.string({ required: false }),
        collection: t.arg.string({ required: false }),
        limit: t.arg.int({ required: false }),
      },
      resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
        domainFrom(ctx).search({
          workspaceId: String(args.workspaceId),
          query: args.query,
          // Once Plan 5 wires the edge embedder, the user-facing default is hybrid.
          // Before that, defaulting to fts keeps Plan 4 independently executable.
          mode: args.mode ?? (ctx.embedder ? 'hybrid' : undefined),
          collection: args.collection ?? undefined,
          limit: clampPageSize(args.limit),
        }),
    }),
  )

  return builder.toSchema()
}
```

`packages/graphql/src/yoga.ts`:
```ts
import { createYoga as createYogaServer } from 'graphql-yoga'
import type { MovpSchema } from '@movp/core-schema'
import { buildSchema } from './schema.ts'
import type { GraphQLContext } from './types.ts'

export interface CreateYogaOpts {
  schema: MovpSchema
}

// Depth + complexity are wired via the Pothos complexity plugin baked into the
// schema buildSchema produces; Yoga executes that schema, so over-budget
// operations are rejected before resolvers run. The per-request { db, userId }
// is injected as the server context by the edge function (see functions/graphql).
export function createYoga(opts: CreateYogaOpts) {
  return createYogaServer<GraphQLContext>({
    schema: buildSchema(opts.schema),
    graphqlEndpoint: '/graphql',
    landingPage: false,
  })
}
```

`packages/graphql/src/index.ts`:
```ts
export { buildSchema } from './schema.ts'
export { createYoga, type CreateYogaOpts } from './yoga.ts'
export { loadEdgeTargets } from './relations.ts'
export {
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEPTH_LIMIT,
  COMPLEXITY_BUDGET,
} from './limits.ts'
export type { GraphQLContext, Row } from './types.ts'
```

- [ ] **Step 5: Run the tests + typecheck**

Run:
```bash
pnpm --filter @movp/graphql test && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `relations.test.ts` (2) + `schema.test.ts` (4) green; `tsc --noEmit` clean.

> If `t.loadable` rejects the list `type` shape at runtime (load must return `Row[][]`, one array per key), the documented fallback is `t.loadableGroup` with a `group: (row) => row.<srcKey>` over a flat result — but the standard `t.loadable` + list-type form is correct here.

- [ ] **Step 6: Commit**

```bash
git add packages/graphql && git commit -m "feat(graphql): dynamic Pothos schema + Yoga factory with depth/complexity/clamp/dataloader"
```

---

### Task 3: `functions/graphql` edge function + the bundling/serve gate

Wire the GraphQL surface into a Supabase Edge Function. This is the FIRST edge function in the suite, so it is also where the **Deno ↔ workspace import bundling** is confirmed. The function resolves the principal at call time, returns `401` (and emits one `@movp/obs` event) on failure, and otherwise hands the request to Yoga with `{ db, userId }` as the server context.

**Files:**
- Create: `supabase/functions/graphql/index.ts`, `supabase/functions/graphql/deno.json`
- Create: `supabase/functions/_e2e/lib.ts`, `supabase/functions/_e2e/graphql_smoke.ts`
- Edit: `supabase/config.toml` (add `verify_jwt = false` for the function)

**Interfaces:**
- Consumes: `@movp/graphql` (`createYoga`), `@movp/core-schema` (`schema`), `@movp/auth` (`resolvePrincipal`), `@movp/obs` (`emit`, `REDACTION_VERSION`).
- Produces: a public HTTP endpoint at `/functions/v1/graphql` that self-verifies the JWT and enforces RLS via the bound client.

- [ ] **Step 1: Write the edge function**

`supabase/functions/graphql/index.ts`:
```ts
import { createYoga } from '@movp/graphql'
import { schema } from '@movp/core-schema'
import { resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'

// Stateless Yoga instance: holds NO per-request state. The principal-bound
// { db, userId } is injected per request as the server context below.
const yoga = createYoga({ schema })

Deno.serve(async (req: Request): Promise<Response> => {
  // Resolve env + principal AT CALL TIME from the request — never module scope.
  // On Deno edge process.env is empty; read via Deno.env.get.
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
  }
  const principal = await resolvePrincipal(req, env)
  if (!principal.ok) {
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'graphql',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Normalize the path to '/graphql' so Yoga's endpoint match is independent of
  // the Supabase function prefix (/functions/v1/graphql).
  const url = new URL(req.url)
  const yogaReq = new Request(new URL(`/graphql${url.search}`, url.origin), req)

  // Pass { db, userId } as Yoga server context; resolvers call
  // createDomain({ db, userId }, { embedder }) from it. Plan 5 wires the
  // edge-only embedder into this context after @movp/search exists.
  return yoga.handleRequest(yogaReq, { db: principal.db, userId: principal.userId })
})
```

- [ ] **Step 2: Write the import map**

`supabase/functions/graphql/deno.json`:
```json
{
  "imports": {
    "@movp/graphql": "../../../packages/graphql/src/index.ts",
    "@movp/core-schema": "../../../packages/core-schema/src/index.ts",
    "@movp/domain": "../../../packages/domain/src/index.ts",
    "@movp/auth": "../../../packages/auth/src/index.ts",
    "@movp/obs": "../../../packages/obs/src/index.ts",
    "@movp/search": "../../../packages/search/src/index.ts",
    "@movp/search/gte-small": "../../../packages/search/src/gte-small.ts",
    "@pothos/core": "npm:@pothos/core@^4.3.0",
    "@pothos/plugin-complexity": "npm:@pothos/plugin-complexity@^4.1.0",
    "@pothos/plugin-dataloader": "npm:@pothos/plugin-dataloader@^4.1.0",
    "graphql": "npm:graphql@^16.9.0",
    "graphql-yoga": "npm:graphql-yoga@^5.10.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "jose": "npm:jose@5"
  }
}
```
> If `supabase functions serve` reports `Relative import path ... not prefixed` or an unmapped bare specifier (e.g. a transitive dep of `@movp/domain`), ADD that specifier to this map. That diagnostic IS the bundling-confirmation signal; fix it here, not by changing package source.

- [ ] **Step 3: Set `verify_jwt = false`**

Append to `supabase/config.toml`:
```toml
[functions.graphql]
verify_jwt = false
```
Confirm the function self-verifies (the only reason `verify_jwt = false` is safe):
```bash
grep -n "verify_jwt" supabase/config.toml
```
Expected: shows `[functions.graphql] verify_jwt = false`. (The public is reachable; `@movp/auth` + RLS are the only gate — by design.)

- [ ] **Step 4: Write the e2e provisioning lib + smoke script**

`supabase/functions/_e2e/lib.ts` (the `_`-prefixed dir is NOT deployed as a function):
```ts
// Provision a confirmed user + workspace + membership via the service-role admin
// path, then sign in to obtain a real access token. Local-stack helper only.
export interface E2eEnv {
  url: string
  anon: string
  serviceRole: string
}

export async function provision(env: E2eEnv): Promise<{ accessToken: string; workspaceId: string; userId: string }> {
  const email = `e2e+${crypto.randomUUID()}@example.test`
  const password = 'e2e-Password-123!'
  const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

  const cu = await fetch(`${env.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (!cu.ok) throw new Error(`admin create user failed: ${cu.status} ${await cu.text()}`)
  const userId = (await cu.json()).id as string

  const ws = await fetch(`${env.url}/rest/v1/workspace`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'return=representation' },
    body: JSON.stringify({ name: 'E2E WS' }),
  })
  if (!ws.ok) throw new Error(`create workspace failed: ${ws.status} ${await ws.text()}`)
  const workspaceId = (await ws.json())[0].id as string

  const mem = await fetch(`${env.url}/rest/v1/workspace_membership`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ workspace_id: workspaceId, user_id: userId, role: 'owner' }),
  })
  if (!mem.ok) throw new Error(`create membership failed: ${mem.status} ${await mem.text()}`)

  const si = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!si.ok) throw new Error(`sign-in failed: ${si.status} ${await si.text()}`)
  return { accessToken: (await si.json()).access_token as string, workspaceId, userId }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
```

`supabase/functions/_e2e/graphql_smoke.ts`:
```ts
import { assert, provision, type E2eEnv } from './lib.ts'

const env: E2eEnv = {
  url: Deno.env.get('SUPABASE_URL')!,
  anon: Deno.env.get('SUPABASE_ANON_KEY')!,
  serviceRole: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
}
const fnUrl = Deno.env.get('GRAPHQL_URL') ?? `${env.url}/functions/v1/graphql`
const { accessToken, workspaceId } = await provision(env)

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: env.anon,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  return { status: res.status, body: await res.json() }
}

// 0) unauthenticated -> 401 (no token)
{
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: { apikey: env.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  })
  assert(res.status === 401, `expected 401 without token, got ${res.status}`)
}

// 1) create returns the note
const created = await gql(
  `mutation ($i: NoteCreateInput!) { createNote(input: $i) { id title status } }`,
  { i: { workspace_id: workspaceId, title: 'Hello', status: 'draft' } },
)
assert(created.body?.data?.createNote?.title === 'Hello', `create failed: ${JSON.stringify(created.body)}`)
const id = created.body.data.createNote.id

// 2) query it back
const got = await gql(`query ($id: ID!) { note(id: $id) { id title } }`, { id })
assert(got.body?.data?.note?.id === id, `query failed: ${JSON.stringify(got.body)}`)

// 3) over-complexity query is rejected before execution
const over = await gql(
  `query { notes(workspaceId: "${workspaceId}", first: 1000) {
      items { id title body status workspace_id created_at updated_at tags { id } } nextCursor } }`,
)
assert((over.body?.errors?.length ?? 0) > 0 && over.body?.data == null, `expected rejection: ${JSON.stringify(over.body)}`)

// 4) bounded, sane list still works
const listed = await gql(`query { notes(workspaceId: "${workspaceId}", first: 5) { items { id } nextCursor } }`)
assert(Array.isArray(listed.body?.data?.notes?.items), `list failed: ${JSON.stringify(listed.body)}`)

console.log('GRAPHQL_SMOKE_OK')
```

- [ ] **Step 5: Confirm bundling + run the integration gate**

In terminal A (serves all functions, following the import maps — this is the bundling confirmation):
```bash
supabase start && supabase functions serve
```
Expected: serves without `Relative import path` / unmapped-specifier errors; logs `Serving functions on http://127.0.0.1:54321/functions/v1/<name>`. (If it errors on an unmapped specifier, fix `deno.json` per Step 2's note, then re-serve.)

In terminal B (provide the keys printed by `supabase status`):
```bash
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_ANON_KEY="$(supabase status -o env | grep ANON_KEY | cut -d= -f2 | tr -d '\"')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '\"')"
deno run -A supabase/functions/_e2e/graphql_smoke.ts
```
Expected: prints `GRAPHQL_SMOKE_OK` and exits 0 — proving (a) Deno↔workspace bundling, (b) 401 without a token, (c) create+query returns the note, (d) the over-complexity query is rejected, (e) a sane list works. A non-zero exit prints `ASSERT FAILED: ...`.

> The over-DEPTH and page-CLAMP gates are proven deterministically by `schema.test.ts` (Task 2); the seeded 100+-row clamp at HTTP level is the Plan 6 `graphql-shape` CI fixture.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/graphql supabase/functions/_e2e supabase/config.toml
git commit -m "feat(functions): graphql edge fn (Yoga) + e2e smoke; verify_jwt=false self-verify"
```

---

### Task 4: `@movp/mcp` package + `functions/mcp` edge function

`buildMcpServer(schema, ctx)` registers per-collection tools (`<name>.create/get/list/search/link`) that wrap `createDomain(ctx)`. The package is tested production-shaped — a real MCP `Client` connected to the real server over the SDK's in-memory transport — so `tools/list` and `tools/call` are exercised against the actual server, with `@movp/domain` mocked for determinism.

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/vitest.config.ts`
- Create: `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/server.test.ts`
- Create: `supabase/functions/mcp/index.ts`, `supabase/functions/mcp/deno.json`
- Edit: `supabase/config.toml` (add `verify_jwt = false` for `mcp`)

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk@1.25.3`, `zod`, `@movp/core-schema`, `@movp/domain`, `@supabase/supabase-js` (type).
- Produces (relied on by `functions/mcp`):
  - `interface McpCtx { db: SupabaseClient; userId: string; embedder?: EmbeddingProvider }`
  - `buildMcpServer(schema: MovpSchema, ctx: McpCtx): McpServer`

- [ ] **Step 1: Create the package skeleton**

`packages/mcp/package.json`:
```json
{
  "name": "@movp/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.25.3",
    "@movp/core-schema": "workspace:*",
    "@movp/domain": "workspace:*",
    "@supabase/supabase-js": "^2.45.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/mcp/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/mcp/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: installs `@modelcontextprotocol/sdk@1.25.3` + `zod`; links workspace deps.

- [ ] **Step 2: Write the failing test**

`packages/mcp/test/server.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'

const note = {
  create: vi.fn(async (i: Record<string, unknown>) => ({
    id: 'n1',
    workspace_id: 'w',
    title: (i as any).title,
    body: null,
    status: 'draft',
    created_at: 't',
    updated_at: 't',
  })),
  get: vi.fn(async () => ({ id: 'n1' })),
  list: vi.fn(async () => ({ items: [{ id: 'n1' }], nextCursor: null })),
  update: vi.fn(),
  delete: vi.fn(),
}
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hi', snippet: 'Hi', score: 0.9 }])
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    note,
    tag: { create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() },
    search,
    graph: { link: vi.fn(), traverse: vi.fn() },
  }),
}))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { schema } from '@movp/core-schema'
import { buildMcpServer } from '../src/index.ts'

async function connect() {
  const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverT)
  await client.connect(clientT)
  return client
}

describe('buildMcpServer', () => {
  it('lists the generated per-collection tools', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'note.create',
        'note.get',
        'note.list',
        'note.search',
        'note.link',
        'tag.create',
      ]),
    )
  })

  it('tools/call note.create then note.search returns it', async () => {
    const client = await connect()
    const created = await client.callTool({
      name: 'note.create',
      arguments: { workspace_id: 'w', title: 'Hi', status: 'draft' },
    })
    const createdRow = JSON.parse((created.content as any[])[0].text)
    expect(createdRow.title).toBe('Hi')
    expect(note.create).toHaveBeenCalledWith({ workspace_id: 'w', title: 'Hi', status: 'draft' })

    const searched = await client.callTool({
      name: 'note.search',
      arguments: { workspaceId: 'w', query: 'Hi' },
    })
    const hits = JSON.parse((searched.content as any[])[0].text)
    expect(hits[0].id).toBe('n1')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/mcp test
```
Expected: FAIL — cannot resolve `../src/index.ts` / `buildMcpServer` is not defined.

- [ ] **Step 4: Implement the package**

`packages/mcp/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain, type EmbeddingProvider } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface McpCtx {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
}

type AnyService = CollectionService<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>

function service(domain: Domain, name: string): AnyService {
  const svc = (domain as unknown as Record<string, AnyService>)[name]
  if (!svc || typeof svc.create !== 'function') throw new Error(`no domain service for collection: ${name}`)
  return svc
}

// Build the create-tool input shape from non-relation fields + workspace_id.
function createShape(c: CollectionDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = { workspace_id: z.string() }
  for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
    if (def.type === 'relation') continue
    shape[name] = (def as any).required ? z.string() : z.string().optional()
  }
  return shape
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function buildMcpServer(schema: MovpSchema, ctx: McpCtx): McpServer {
  const server = new McpServer({ name: 'movp', version: '0.1.0' })
  // Resolve the domain once per server (per request — the edge fn builds a fresh
  // server per request with the request-bound { db, userId }).
  const domain = createDomain({ db: ctx.db, userId: ctx.userId }, { embedder: ctx.embedder })

  for (const c of schema.collections) {
    const svc = service(domain, c.name)

    server.registerTool(
      `${c.name}.create`,
      { title: `Create ${c.label}`, description: `Create a ${c.label}`, inputSchema: createShape(c) },
      async (args: Record<string, unknown>) => text(await svc.create(args)),
    )

    server.registerTool(
      `${c.name}.get`,
      { title: `Get ${c.label}`, description: `Get a ${c.label} by id`, inputSchema: { id: z.string() } },
      async ({ id }) => text(await svc.get(id)),
    )

    server.registerTool(
      `${c.name}.list`,
      {
        title: `List ${c.labelPlural}`,
        description: `List ${c.labelPlural} in a workspace`,
        inputSchema: { workspaceId: z.string(), first: z.number().optional(), after: z.string().optional() },
      },
      async ({ workspaceId, first, after }) =>
        text(await svc.list({ workspaceId, first, after: after ?? null })),
    )

    server.registerTool(
      `${c.name}.search`,
      {
        title: `Search ${c.labelPlural}`,
        description: `Search within ${c.labelPlural}`,
        inputSchema: {
          workspaceId: z.string(),
          query: z.string(),
          mode: z.enum(['fts', 'semantic', 'hybrid']).optional(),
          limit: z.number().optional(),
        },
      },
      async ({ workspaceId, query, mode, limit }) =>
        text(await domain.search({
          workspaceId,
          query,
          mode: mode ?? (ctx.embedder ? 'hybrid' : 'fts'),
          collection: c.name,
          limit,
        })),
    )

    server.registerTool(
      `${c.name}.link`,
      {
        title: `Link ${c.label}`,
        description: `Create a graph edge from this ${c.label} to another record`,
        inputSchema: {
          srcId: z.string(),
          rel: z.string(),
          dstType: z.string(),
          dstId: z.string(),
          workspaceId: z.string(),
        },
      },
      // GraphService.link's exact arg shape is finalized in Plan 3; this tool
      // forwards the design's edge-model fields. (Execution gate deferred to
      // Plan 3/5; tools/list coverage here proves registration.)
      async (args: Record<string, unknown>) =>
        text(await (domain.graph as { link: (a: unknown) => Promise<unknown> }).link({ srcType: c.name, ...args })),
    )
  }

  return server
}
```

`packages/mcp/src/index.ts`:
```ts
export { buildMcpServer, type McpCtx } from './server.ts'
```

- [ ] **Step 5: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/mcp test && pnpm --filter @movp/mcp typecheck
```
Expected: PASS — `tools/list` shows the generated tools; `tools/call note.create` then `note.search` returns the row; `tsc --noEmit` clean.

- [ ] **Step 6: Write the edge function + import map + config**

`supabase/functions/mcp/index.ts`:
```ts
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { buildMcpServer } from '@movp/mcp'
import { schema } from '@movp/core-schema'
import { resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'

Deno.serve(async (req: Request): Promise<Response> => {
  // Per-request env + principal resolved at call time (process.env is empty on Deno).
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
  }
  const principal = await resolvePrincipal(req, env)
  if (!principal.ok) {
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'mcp',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Stateless transport: fresh server + transport per request, bound to this
  // principal. Plan 5 adds the edge-only embedder to this context after
  // @movp/search/gte-small exists. Use the WebStandard transport (NOT the Node
  // StreamableHTTP one).
  const server = buildMcpServer(schema, { db: principal.db, userId: principal.userId })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return await transport.handleRequest(req)
})
```
> `McpServer` itself is imported INSIDE `@movp/mcp` (bare, mapped by `deno.json`), so the edge fn imports only the transport + `buildMcpServer` — no dead `McpServer` import. The bare `@modelcontextprotocol/sdk/...` specifiers inside the package resolve to the same pinned `npm:` version via the prefix map below.

`supabase/functions/mcp/deno.json`:
```json
{
  "imports": {
    "@movp/mcp": "../../../packages/mcp/src/index.ts",
    "@movp/core-schema": "../../../packages/core-schema/src/index.ts",
    "@movp/domain": "../../../packages/domain/src/index.ts",
    "@movp/auth": "../../../packages/auth/src/index.ts",
    "@movp/obs": "../../../packages/obs/src/index.ts",
    "@movp/search": "../../../packages/search/src/index.ts",
    "@movp/search/gte-small": "../../../packages/search/src/gte-small.ts",
    "@modelcontextprotocol/sdk/": "npm:@modelcontextprotocol/sdk@1.25.3/",
    "zod": "npm:zod@^3.23.8",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "jose": "npm:jose@5"
  }
}
```

Append to `supabase/config.toml`:
```toml
[functions.mcp]
verify_jwt = false
```

- [ ] **Step 7: Confirm the edge fn bundles + serves**

Run (with `supabase functions serve` from Task 3 active, or restart it):
```bash
supabase functions serve
# in another terminal — unauthenticated MCP call must be 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:54321/functions/v1/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: serve starts without unmapped-specifier errors; the curl prints `401` (no token → fail closed). The full `tools/list` / `tools/call` behaviour is the machine-checkable gate in `server.test.ts` (Step 5), run against the real MCP client/server.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp supabase/functions/mcp supabase/config.toml
git commit -m "feat(mcp): per-collection tool server + WebStandard edge fn; verify_jwt=false"
```

---

### Task 5: `@movp/cli` — the Node `movp` command

A `commander` program generated from the same `schema`: `movp <collection> create|get|list`, `movp search <query>`, `movp codegen`, `movp migrate`, and `movp jobs replay|reindex`. `buildProgram(opts)` accepts injectable seams (`resolveCtx`, `runCodegen`, `runMigratePush`, `jobs`, `out`) that default to the real Node wiring, so the tests are deterministic without a DB while production wiring stays real.

**Credential model (spelled out):** the CLI resolves a Node `SupabaseClient` at call time. Preferred mode = `MOVP_ACCESS_TOKEN` (a user JWT) → an **RLS-scoped** client (authoritative; `userId` decoded from the token's `sub`, unverified — the server's RLS is the real gate). Fallback = `MOVP_SERVICE_ROLE_KEY` + `MOVP_USER_ID` → a **service-role** client that **bypasses RLS** (prints a stderr warning; **local admin only**, never a shared/remote path — per design invariant 3, service-role is out-of-band). No credential → a loud error. Because the direct-DB CLI runs in Node and cannot use the Supabase Edge `Supabase.ai` global, `movp search` is explicitly FTS-only in Phase 1; semantic/hybrid search is exposed through GraphQL, MCP, and the frontend.

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/client.ts`, `src/program.ts`, `src/bin.ts`, `src/index.ts`
- Test: `packages/cli/test/program.test.ts`

**Interfaces:**
- Consumes: `commander`, `@movp/core-schema` (`schema`), `@movp/domain` (`createDomain`), `@movp/obs` (`emit`), `@supabase/supabase-js`.
- Produces: the `movp` CLI; `buildProgram(opts?): Command`; `resolveCliCtx(env?): CliCtx`.
- **Plan dependencies (noted, not invented):** `movp codegen`/`movp migrate` call `@movp/codegen.generate()` (owned by Plan 2); `movp jobs replay|reindex` manipulate `movp_internal.movp_jobs` (owned by Plan 5) — here they are registered and wired to injectable handlers whose production default throws a clear "delivered in Plan 5" error.

- [ ] **Step 1: Create the package skeleton**

`packages/cli/package.json`:
```json
{
  "name": "@movp/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "bin": { "movp": "./src/bin.ts" },
  "scripts": {
    "movp": "tsx src/bin.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@movp/core-schema": "workspace:*",
    "@movp/domain": "workspace:*",
    "@movp/obs": "workspace:*",
    "@supabase/supabase-js": "^2.45.0",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@movp/codegen": "workspace:*",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/cli/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: installs `commander` + `tsx`; links workspace deps.

- [ ] **Step 2: Write the failing test**

`packages/cli/test/program.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stable mock domain — same service objects every createDomain() call.
const note = {
  create: vi.fn(async (i: Record<string, unknown>) => ({ id: 'n1', ...i })),
  get: vi.fn(async () => ({ id: 'n1', title: 'Hello' })),
  list: vi.fn(async () => ({ items: [{ id: 'n1' }], nextCursor: null })),
  update: vi.fn(),
  delete: vi.fn(),
}
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 't', snippet: 't', score: 1 }])
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    note,
    tag: { create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() },
    search,
    graph: { link: vi.fn(), traverse: vi.fn() },
  }),
}))

import { buildProgram } from '../src/program.ts'

const out: string[] = []
function program(over = {}) {
  return buildProgram({
    resolveCtx: () => ({ db: {} as never, userId: 'u' }),
    out: (l: string) => out.push(l),
    ...over,
  })
}

beforeEach(() => {
  out.length = 0
  note.create.mockClear()
})

describe('movp CLI', () => {
  it('note create calls domain.create and prints the row', async () => {
    await program().parseAsync(['note', 'create', '--workspace', 'w', '--title', 'Hello'], { from: 'user' })
    expect(note.create).toHaveBeenCalledWith({ workspace_id: 'w', title: 'Hello' })
    expect(out.some((l) => l.includes('"id":"n1"'))).toBe(true)
  })

  it('note list prints items', async () => {
    await program().parseAsync(['note', 'list', '--workspace', 'w'], { from: 'user' })
    expect(note.list).toHaveBeenCalledWith({ workspaceId: 'w', first: undefined, after: null })
    expect(out.some((l) => l.includes('"id":"n1"'))).toBe(true)
  })

  it('search calls domain.search', async () => {
    await program().parseAsync(['search', 'hi', '--workspace', 'w'], { from: 'user' })
    expect(search).toHaveBeenCalledWith({
      workspaceId: 'w',
      query: 'hi',
      mode: 'fts',
      collection: undefined,
      limit: undefined,
    })
  })

  it('search rejects semantic/hybrid modes in the direct Node CLI', async () => {
    await expect(program().parseAsync(['search', 'hi', '--workspace', 'w', '--mode', 'semantic'], { from: 'user' }))
      .rejects.toThrow(/CLI search supports fts only/)
  })

  it('migrate runs codegen then push, in order', async () => {
    const order: string[] = []
    await program({
      runCodegen: async () => void order.push('codegen'),
      runMigratePush: async () => void order.push('push'),
    }).parseAsync(['migrate'], { from: 'user' })
    expect(order).toEqual(['codegen', 'push'])
  })

  it('jobs replay --dead forwards to the injected handler', async () => {
    const replay = vi.fn(async () => {})
    await program({ jobs: { replay, reindex: vi.fn(async () => {}) } }).parseAsync(['jobs', 'replay', '--dead'], {
      from: 'user',
    })
    expect(replay).toHaveBeenCalledWith({ kind: undefined, dead: true })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/cli test
```
Expected: FAIL — cannot resolve `../src/program.ts`.

- [ ] **Step 4: Implement the package**

`packages/cli/src/client.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface CliCtx {
  db: SupabaseClient
  userId: string
}

// Decode (NOT verify) the JWT 'sub'. The server's RLS is the authoritative gate;
// the CLI only needs the user id for domain ctx.
export function decodeSub(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed JWT in MOVP_ACCESS_TOKEN')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('JWT missing sub')
  return payload.sub
}

export function resolveCliCtx(env: Record<string, string | undefined> = process.env): CliCtx {
  const url = env.SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL is required')

  // Preferred: user token -> RLS-scoped client (authoritative).
  const accessToken = env.MOVP_ACCESS_TOKEN
  if (accessToken) {
    const anon = env.SUPABASE_ANON_KEY
    if (!anon) throw new Error('SUPABASE_ANON_KEY is required alongside MOVP_ACCESS_TOKEN')
    const db = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(accessToken) }
  }

  // Fallback: service-role -> RLS BYPASSED. Local admin only.
  const serviceRole = env.MOVP_SERVICE_ROLE_KEY
  if (serviceRole) {
    const userId = env.MOVP_USER_ID
    if (!userId) throw new Error('MOVP_USER_ID is required in service-role mode')
    console.error('[movp] WARNING: service-role mode — RLS is BYPASSED. Local admin only.')
    const db = createClient(url, serviceRole, { auth: { persistSession: false } })
    return { db, userId }
  }

  throw new Error(
    'No credential: set MOVP_ACCESS_TOKEN (preferred) or MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID (local admin).',
  )
}
```

`packages/cli/src/program.ts`:
```ts
import { Command } from 'commander'
import type { CollectionDef, FieldDef } from '@movp/core-schema'
import { schema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain } from '@movp/domain'
import { resolveCliCtx, type CliCtx } from './client.ts'

export interface JobsHandlers {
  replay: (o: { kind?: string; dead?: boolean }) => Promise<void>
  reindex: (collection: string) => Promise<void>
}

export interface BuildProgramOpts {
  resolveCtx?: () => CliCtx
  runCodegen?: () => Promise<void>
  runMigratePush?: () => Promise<void>
  jobs?: JobsHandlers
  out?: (line: string) => void
}

type AnyService = CollectionService<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
function service(domain: Domain, name: string): AnyService {
  const svc = (domain as unknown as Record<string, AnyService>)[name]
  if (!svc || typeof svc.create !== 'function') throw new Error(`no domain service for collection: ${name}`)
  return svc
}

export function buildProgram(opts: BuildProgramOpts = {}): Command {
  const out = opts.out ?? ((l: string) => console.log(l))
  const resolveCtx = opts.resolveCtx ?? (() => resolveCliCtx())

  const runCodegen =
    opts.runCodegen ??
    (async () => {
      // @movp/codegen.generate() is owned by Plan 2.
      const mod = (await import('@movp/codegen')) as { generate?: () => Promise<void> }
      if (!mod.generate) throw new Error('@movp/codegen.generate() not found — delivered in Plan 2')
      await mod.generate()
    })

  const runMigratePush =
    opts.runMigratePush ??
    (async () => {
      // Verified: `supabase db push` is the correct apply subcommand (no extra flags).
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync('supabase', ['db', 'push'], { stdio: 'inherit' })
      if (r.status !== 0) throw new Error(`supabase db push failed (exit ${r.status ?? 'unknown'})`)
    })

  const jobs: JobsHandlers =
    opts.jobs ?? {
      replay: async () => {
        throw new Error('movp jobs replay is delivered in Plan 5 (Search & Async)')
      },
      reindex: async () => {
        throw new Error('movp jobs reindex is delivered in Plan 5 (Search & Async)')
      },
    }

  const program = new Command('movp').description('MOVP Core CLI')

  for (const c of schema.collections as CollectionDef[]) {
    const cmd = program.command(c.name).description(`Operate on ${c.labelPlural}`)

    const create = cmd.command('create').requiredOption('--workspace <id>', 'workspace id')
    for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
      if (def.type === 'relation') continue
      const flag = `--${name} <value>`
      if ((def as any).required) create.requiredOption(flag, def.label)
      else create.option(flag, def.label)
    }
    create.action(async (o: Record<string, string>) => {
      const domain = createDomain(resolveCtx())
      const input: Record<string, unknown> = { workspace_id: o.workspace }
      for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
        if (def.type === 'relation') continue
        if (o[name] !== undefined) input[name] = o[name]
      }
      out(JSON.stringify(await service(domain, c.name).create(input)))
    })

    cmd
      .command('get')
      .requiredOption('--id <id>', 'record id')
      .action(async (o: { id: string }) => {
        const domain = createDomain(resolveCtx())
        out(JSON.stringify(await service(domain, c.name).get(o.id)))
      })

    cmd
      .command('list')
      .requiredOption('--workspace <id>', 'workspace id')
      .option('--first <n>', 'page size', (v) => parseInt(v, 10))
      .option('--after <cursor>', 'page cursor')
      .action(async (o: { workspace: string; first?: number; after?: string }) => {
        const domain = createDomain(resolveCtx())
        out(JSON.stringify(await service(domain, c.name).list({
          workspaceId: o.workspace,
          first: o.first,
          after: o.after ?? null,
        })))
      })
  }

  program
    .command('search <query>')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--mode <mode>', 'fts only in the direct Node CLI; use GraphQL/MCP for semantic/hybrid')
    .option('--collection <name>', 'restrict to a collection')
    .option('--limit <n>', 'max hits', (v) => parseInt(v, 10))
    .action(async (query: string, o: { workspace: string; mode?: string; collection?: string; limit?: number }) => {
      if (o.mode && o.mode !== 'fts') throw new Error('CLI search supports fts only; use GraphQL/MCP for semantic/hybrid search')
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.search({
        workspaceId: o.workspace,
        query,
        mode: 'fts',
        collection: o.collection,
        limit: o.limit,
      })))
    })

  program.command('codegen').description('Run the codegen pipeline (Plan 2)').action(async () => {
    await runCodegen()
  })

  program.command('migrate').description('Codegen then apply via supabase db push').action(async () => {
    await runCodegen()
    await runMigratePush()
  })

  const jobsCmd = program.command('jobs').description('Async job operations (Plan 5)')
  jobsCmd
    .command('replay')
    .option('--kind <k>', 'embed | webhook | notify')
    .option('--dead', 'replay dead-lettered jobs')
    .action(async (o: { kind?: string; dead?: boolean }) => {
      await jobs.replay({ kind: o.kind, dead: !!o.dead })
    })
  jobsCmd
    .command('reindex <collection>')
    .action(async (collection: string) => {
      await jobs.reindex(collection)
    })

  return program
}
```

`packages/cli/src/bin.ts`:
```ts
#!/usr/bin/env -S npx tsx
import { emit, REDACTION_VERSION } from '@movp/obs'
import { buildProgram } from './program.ts'

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    // operation = top-level command name only (no arg VALUES -> no PII leak).
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'cli',
      operation: process.argv[2] ?? 'unknown',
      error_code: 'cli_error',
      redaction_version: REDACTION_VERSION,
    })
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
```

`packages/cli/src/index.ts`:
```ts
export { buildProgram, type BuildProgramOpts, type JobsHandlers } from './program.ts'
export { resolveCliCtx, decodeSub, type CliCtx } from './client.ts'
```

- [ ] **Step 5: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/cli test && pnpm --filter @movp/cli typecheck
```
Expected: PASS — all 6 cases green; `tsc --noEmit` clean.

- [ ] **Step 6: Live smoke against the local stack**

With `supabase start` running and a token from the Task 3 provisioning (export `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and a `MOVP_ACCESS_TOKEN` for a workspace member):
```bash
MOVP_ACCESS_TOKEN="<member-jwt>" \
  pnpm --filter @movp/cli exec tsx src/bin.ts note create --workspace "<ws-id>" --title "From CLI"
MOVP_ACCESS_TOKEN="<member-jwt>" \
  pnpm --filter @movp/cli exec tsx src/bin.ts note list --workspace "<ws-id>"
```
Expected: the first prints a JSON note with an `id` and `"title":"From CLI"`; the second prints a page whose `items` includes that row. (`<member-jwt>`/`<ws-id>` come from `_e2e/lib.ts`'s `provision`, or mint via `supabase` auth.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli && git commit -m "feat(cli): movp commander program over the domain core (RLS token or service-role admin)"
```

---

## Self-Review

- **Spec coverage (design Tasks 6–8 + obs + graphql-shape):**
  - *Observability contract* — `@movp/obs` (Task 1): bounded `surface` validated by value, out-of-enum coerced to `unknown` **and** a second `observability_enum_violation` emitted (never dropped), `@`-bearing string fields stripped, `redaction_version` forced to `1`. Both edge functions + the CLI emit one correlated event on their auth/error path.
  - *Design Task 6 — GraphQL* (Tasks 2–3): `buildSchema`/`createYoga` via Pothos code-first with `@pothos/plugin-dataloader` + `@pothos/plugin-complexity`; depth 10, complexity 1000, cursor page default 20 / hard max 100, resolvers call `createDomain` from context; edge fn resolves principal at call time → 401 on `!ok` → Yoga at `/graphql` with `{ db, userId }` context. Gates: create+query returns the note (serve), over-complexity rejected (serve) + over-depth rejected (unit), page clamp (unit), nested relation issues a **bounded SQL count** (`relations.test.ts`). **Deno↔workspace bundling confirmed** in Task 3 (the first edge fn).
  - *Design Task 7 — MCP* (Task 4): `buildMcpServer` registers `create/get/list/search/link` per collection wrapping `createDomain(ctx)`; edge fn uses `WebStandardStreamableHTTPServerTransport` (not the Node transport), pinned SDK `@1.25.3`. Gate: `tools/list` + `tools/call note.create` → `note.search` against the real MCP client/server.
  - *Design Task 8 — CLI* (Task 5): `movp <collection> create|get|list`, `movp search` (direct Node path is FTS-only; semantic/hybrid are edge-surface features), `movp codegen`, `movp migrate` (codegen → `supabase db push`), `movp jobs replay|reindex`. Credential model (user token RLS vs service-role admin) spelled out.
- **Deferred / cross-plan (intentional, not invented):** `GraphService.link` arg shape (Plan 3 — the MCP `link` tool forwards edge-model fields and its execution gate is deferred); `@movp/codegen.generate()` (Plan 2 — `movp codegen`/`migrate` wire to it); `movp_internal.movp_jobs` internals (Plan 5 — `movp jobs` registered, production default throws a clear "delivered in Plan 5" error); the seeded 100+-row HTTP page-clamp and the full redaction CI gate (Plan 6 `graphql-shape`/`redaction`).
- **Sample/prose fidelity:** the GraphQL edge fn passes `{ db, userId }` (NOT a pre-built domain) into Yoga context, and resolvers call `createDomain` — stated in a code comment AND the prose so an implementer cannot duplicate domain construction. The MCP edge fn imports only the transport + `buildMcpServer` (no dead `McpServer` import); `McpServer` is constructed inside the package — called out explicitly where the contract's literal import list would otherwise read as a dead import.
- **Per-request dependency threading:** no `process.env` in any edge fn (both use `Deno.env.get` at call time); no constructor-captured `db`/env — `{ db, userId }` flows from `resolvePrincipal` → context → `createDomain` at call time. The Yoga instance at module scope holds no per-request state (context injected per `handleRequest`).
- **Eight-dimension pass:** *Correctness* — dynamic schema/tool/CLI generation from `MovpSchema`, column-named fields, FK-free edge relation loader; semantic/hybrid search is context-wired for edge surfaces and direct CLI search is explicitly FTS-only; spec↔code↔tests agree. *Safety* — `verify_jwt=false` compensated by `@movp/auth` + RLS; service-role confined to the documented local-admin CLI path with a loud warning; obs strips PII by value. *Reliability* — fail-closed 401 with the stable `code`; missing domain service throws loudly. *Observability* — one redacted, `trace_id`-correlated event per auth/error path; enum coercion never erases the signal. *Efficiency* — DataLoader batches relations (2 statements regardless of N); domain built per-resolver but cheap (no I/O); no client+server double work. *Performance* — depth/complexity/clamp keep the 2 s-CPU envelope safe; complexity multiplier == served page size. *Simplicity* — one Pothos builder loop (no per-collection hand-coding), `<Name>Page` instead of full Relay, no speculative abstraction. *Usability* — three first-class surfaces; CLI flags carry field labels as help; service-role warning + explicit "no credential" error.
- **Placeholder scan:** none — every code/SQL/JSON block is complete; every step has an exact command + expected output; `<member-jwt>`/`<ws-id>` in the optional live smoke are user-supplied runtime values (the deterministic gates are the unit tests + the `_e2e` smoke).
- **Type consistency:** `GraphQLContext`/`McpCtx` are each `{ db: SupabaseClient; userId: string; embedder?: EmbeddingProvider }`, while `CliCtx` remains `{ db: SupabaseClient; userId: string }` because the Node CLI cannot use the Deno-only edge embedder directly. All three match the appropriate `createDomain` call shape. `Surface`, `ObsEvent`, `REDACTION_VERSION`, `buildSchema`, `createYoga`, `buildMcpServer`, `buildProgram`, `clampPageSize`, `loadEdgeTargets` are defined once and consumed by name in their tests and edge functions.
- **CLI flag verification:** `supabase db push` is the apply subcommand with no extra flags (no invalid `--yes` on `push`); `supabase functions serve`/`deploy` per design. `verify_jwt=false` is a documented per-function `config.toml` key, set for `graphql` and `mcp` only.
