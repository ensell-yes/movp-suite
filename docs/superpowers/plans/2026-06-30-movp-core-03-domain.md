# MOVP Core — Domain Service Core (`@movp/domain`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@movp/domain` — the runtime-agnostic service core every surface (GraphQL, MCP, CLI) calls. It exposes `createDomain(ctx, opts)` returning per-collection `CollectionService` for `note` and `tag` (CRUD + cursor pagination), a `search()` over FTS / semantic / hybrid, and a `GraphService` (link writes `public.edges`; traverse walks a recursive CTE). All methods run through the per-request RLS-bound `supabase-js` client passed in `ctx` — never a module-scope client.

**Architecture:** A pure TS package consumed by both Node (CLI/codegen) and Deno (edge functions). It imports nothing Node- or Deno-only — only `@supabase/supabase-js` and web standards (`btoa`/`atob`, `Map`, `Promise.all`). Authorization is authoritative at the data boundary: every read/write goes through the caller's RLS-bound client, so Postgres RLS (via `public.is_workspace_member`) is the gate. Two small hand-authored SQL functions back the parts supabase-js cannot express in one round-trip — `public.search_fts` (FTS ranking via `ts_rank`) and `public.traverse_edges` (recursive graph walk) — both `SECURITY INVOKER` so RLS still applies, both shipped as migrations in this plan and applied by the Supabase CLI.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, `@supabase/supabase-js`, Vitest (Node env, integration tests against the local Supabase stack), Supabase CLI (local stack + SQL migrations + pgTAP infra from Plans 1–2).

**This plan is Plan 3 of the Phase 1 (MOVP Core) series** and implements the design's build-sequence **Task 5** (domain services: CRUD + search + graph). The full north-star + Phase 1 design lives at `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`. Plan 1 (Foundation: scaffold, tenancy, `@movp/auth`) and Plan 2 (`@movp/core-schema` + `@movp/codegen`) precede it; Plan 4+ (API surfaces, search async/embeddings, frontend, CI) follow.

### Prerequisites (must be true before Task 1)

- Plan 1 applied: `public.workspace`, `public.workspace_membership`, `public.is_workspace_member(uuid)`, and `@movp/auth` exist.
- Plan 2 applied: `@movp/core-schema` + `@movp/codegen` have generated **`packages/domain/src/generated/types.ts`** (exporting `NoteRow`/`NoteCreate`/`NoteUpdate`, `TagRow`/`TagCreate`/`TagUpdate`) and the migrations creating tables `public.note`, `public.tag` (each with a trigger-maintained `search_vector` + GIN), `public.search_chunk` + `public.match_chunks(...)`, `public.edges`, and `movp_internal.movp_jobs`.
- The local stack is up: `supabase start` is healthy and `supabase db reset` applies all Plan 1–2 migrations cleanly.

> If `packages/domain/src/generated/types.ts` does not exist, STOP — Plan 2 has not run. Task 1's first gate checks for it explicitly.

## Global Constraints

- **Runtime-agnostic core.** Files under `packages/domain/src/` import only bare specifiers (`@supabase/supabase-js`) and standard web APIs. No `node:*`, no `Deno.*`, no `Buffer`. Cursor encoding uses `btoa`/`atob` (web-standard globals in Node 18+ and Deno). Only **test** files (`packages/domain/test/**`, `vitest.config.ts`) may use Node APIs.
- **Relative imports inside the package use explicit `.ts` extensions** (so Deno resolves them). `tsconfig.base.json` already sets `moduleResolution: "bundler"` + `allowImportingTsExtensions: true` + `noEmit: true`.
- **Per-request dependencies resolved at call time, never module scope.** Every method reads `ctx.db` (the RLS-bound client) that the caller passed; the package never constructs a client and never captures `db`/`userId` in a module-scope variable. (See `cloudflare-workers-runtime` precedent: a captured client is a silent prod no-op.)
- **Authoritative authz at the data boundary.** All domain methods go through the caller's RLS-bound `supabase-js` client. RLS (`is_workspace_member`) is the gate. **Tests prove this with a user-bound client** built from a real Supabase-minted JWT; the service-role key is used **only to seed** (workspaces, memberships, `search_chunk` rows — the latter mirrors the out-of-band embedding indexer), never on an assertion path.
- **Supabase CLI is the only migration applier.** The two SQL functions this plan adds (`search_fts`, `traverse_edges`) are hand-authored migrations in `supabase/migrations/` — domain-support RPCs, not codegen output — and still applied via the CLI. The `edges` table and its unique constraint are owned by Plan 2 (shared infra); this plan does not redefine them. `supabase db diff` stays empty (DB matches migrations).
- **Added SQL functions are `SECURITY INVOKER`** (deliberately — so RLS on the underlying tables applies to the caller) with `set search_path = ''` and fully schema-qualified objects; `execute` revoked from `public`/`anon`, granted to `authenticated`. They are NOT `SECURITY DEFINER`, so the `definer-audit` gate does not apply to them.
- **Observability discipline.** Thrown errors carry the operation label + the PostgREST `error.code` (a stable diagnostic), never row values, the user query text, or PII. No `error.message` interpolation (may echo input).

## File Structure

```
supasuite/
  supabase/
    migrations/
      <ts>_search_fts.sql        # NEW (Task 4): public.search_fts(ws,src_table,q,lim)
      <ts>_graph_traverse.sql    # NEW (Task 6): public.traverse_edges(...) RPC only
  packages/
    domain/
      package.json               # NEW (Task 1): @movp/domain
      tsconfig.json              # NEW (Task 1)
      vitest.config.ts           # NEW (Task 1): injects SUPABASE_* from `supabase status`
      src/
        generated/
          types.ts               # EXISTS (Plan 2) — consumed, never edited here
        types.ts                 # NEW (Task 1): all contract interfaces
        index.ts                 # NEW (Task 1: type exports; Task 7: + createDomain)
        collection.ts            # NEW (Task 2): makeCollectionService factory
        search.ts                # NEW (Task 4: runSearch + fts; Task 5: + semantic/hybrid)
        graph.ts                 # NEW (Task 6): makeGraphService
        domain.ts                # NEW (Task 7): createDomain assembly
      test/
        helpers/
          stack.ts               # NEW (Task 1): service seed + user-bound client helpers
          embedder.ts            # NEW (Task 5): FAKE_VEC + fakeEmbedder
        harness.test.ts          # NEW (Task 1)
        collection.note.test.ts  # NEW (Task 2)
        collection.tag.test.ts   # NEW (Task 3)
        search.fts.test.ts       # NEW (Task 4)
        search.semantic.test.ts  # NEW (Task 5)
        graph.test.ts            # NEW (Task 6)
        domain.e2e.test.ts       # NEW (Task 7)
```

---

### Task 1: Package skeleton + contract types + integration harness

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/vitest.config.ts`
- Create: `packages/domain/src/types.ts`, `packages/domain/src/index.ts`
- Create: `packages/domain/test/helpers/stack.ts`, `packages/domain/test/harness.test.ts`
- Consumes (do NOT edit): `packages/domain/src/generated/types.ts` (Plan 2)

**Interfaces:**
- Consumes (from `./generated/types.ts`, Plan 2 — exact shapes):
  - `NoteRow = { id: string; workspace_id: string; title: string; body: string | null; status: 'draft'|'published'|'archived'; created_at: string; updated_at: string }`
  - `NoteCreate = { workspace_id: string; title: string; body?: string; status?: 'draft'|'published'|'archived' }`
  - `NoteUpdate = { title?: string; body?: string; status?: 'draft'|'published'|'archived' }`
  - `TagRow = { id: string; workspace_id: string; name: string; created_at: string; updated_at: string }`
  - `TagCreate = { workspace_id: string; name: string }`
  - `TagUpdate = { name?: string }`
- Produces (the full contract surface; consumed by Plan 4 surfaces):
  - `interface DomainCtx { db: SupabaseClient; userId: string }`
  - `interface Page<T> { items: T[]; nextCursor: string | null }`
  - `interface ListArgs { workspaceId: string; first?: number; after?: string | null }`
  - `interface SearchArgs { workspaceId: string; query: string; mode?: 'fts'|'semantic'|'hybrid'; collection?: string; limit?: number }`
  - `interface SearchHit { collection: string; id: string; title: string; snippet: string; score: number }`
  - `interface EmbeddingProvider { embed(text: string): Promise<number[]> }`
  - `interface CollectionService<Row,Create,Update> { create(input:Create):Promise<Row>; get(id:string):Promise<Row|null>; list(args:ListArgs):Promise<Page<Row>>; update(id:string,patch:Update):Promise<Row>; delete(id:string):Promise<void> }`
  - `interface GraphService { link(a:{workspaceId:string;srcType:string;srcId:string;rel:string;dstType:string;dstId:string}):Promise<void>; traverse(a:{workspaceId:string;srcType:string;srcId:string;rel?:string;depth?:number}):Promise<Array<{type:string;id:string;depth:number}>> }`
  - `interface Domain { note:CollectionService<NoteRow,NoteCreate,NoteUpdate>; tag:CollectionService<TagRow,TagCreate,TagUpdate>; search(a:SearchArgs):Promise<SearchHit[]>; graph:GraphService }`
- Produces (test helpers): `serviceClient()`, `createUserClient(email?)`, `seedWorkspace(name)`, `addMember(ws,userId,role?)`, `seedChunk(opts)`.

- [ ] **Step 1: Confirm the Plan 2 prerequisite exists**

Run:
```bash
test -f /Users/ensell/Code/supasuite/packages/domain/src/generated/types.ts && echo OK || echo MISSING
```
Expected: `OK`. If `MISSING`, STOP — Plan 2 has not run; this plan cannot proceed.

- [ ] **Step 2: Create the package skeleton**

`packages/domain/package.json`:
```json
{
  "name": "@movp/domain",
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
    "@supabase/supabase-js": "^2.45.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/domain/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/domain/vitest.config.ts` (config runs in the Node main process, so `node:child_process` is fine here — NOT in `src/`):
```ts
import { defineConfig } from 'vitest/config'
import { execFileSync } from 'node:child_process'

// Read the running local stack's URL + keys from `supabase status` at config-load time
// and inject them via `test.env`. Production-shaped: no hardcoded demo keys, and it
// fails loudly (here, before any test runs) if the stack is down.
function stackEnv(): Record<string, string> {
  let out: string
  try {
    out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8' })
  } catch {
    throw new Error('`supabase status` failed — run `supabase start` before `pnpm --filter @movp/domain test`')
  }
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
    if (m) map.set(m[1], m[2])
  }
  // Default `supabase status -o env` names. If a name differs in your CLI version, the
  // error lists what WAS found so you can adjust the mapping (or use --override-name).
  const url = map.get('API_URL')
  const anon = map.get('ANON_KEY')
  const service = map.get('SERVICE_ROLE_KEY')
  if (!url || !anon || !service) {
    throw new Error(`supabase status missing API_URL/ANON_KEY/SERVICE_ROLE_KEY; found: ${[...map.keys()].join(', ')}`)
  }
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service }
}

export default defineConfig({
  test: {
    environment: 'node',
    env: stackEnv(),
    testTimeout: 30000,
    hookTimeout: 30000,
    // Tests share one local DB; run files serially to avoid cross-file interference.
    fileParallelism: false,
  },
})
```

- [ ] **Step 3: Write the contract types**

`packages/domain/src/types.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  NoteRow, NoteCreate, NoteUpdate,
  TagRow, TagCreate, TagUpdate,
} from './generated/types.ts'

export interface DomainCtx {
  db: SupabaseClient
  userId: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListArgs {
  workspaceId: string
  first?: number
  after?: string | null
}

export interface SearchArgs {
  workspaceId: string
  query: string
  mode?: 'fts' | 'semantic' | 'hybrid'
  collection?: string
  limit?: number
}

export interface SearchHit {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

// 384-dim. DEFINED HERE; implemented later by @movp/search (Plan 4+).
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export interface CollectionService<Row, Create, Update> {
  create(input: Create): Promise<Row>
  get(id: string): Promise<Row | null>
  list(args: ListArgs): Promise<Page<Row>>
  update(id: string, patch: Update): Promise<Row>
  delete(id: string): Promise<void>
}

export interface GraphService {
  link(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel: string
    dstType: string
    dstId: string
  }): Promise<void>
  traverse(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel?: string
    depth?: number
  }): Promise<Array<{ type: string; id: string; depth: number }>>
}

export interface Domain {
  note: CollectionService<NoteRow, NoteCreate, NoteUpdate>
  tag: CollectionService<TagRow, TagCreate, TagUpdate>
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
}
```

`packages/domain/src/index.ts` (createDomain is added in Task 7; types are exported now):
```ts
export type {
  DomainCtx, Page, ListArgs, SearchArgs, SearchHit,
  EmbeddingProvider, CollectionService, GraphService, Domain,
} from './types.ts'
```

- [ ] **Step 4: Write the integration-test harness helpers**

`packages/domain/test/helpers/stack.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Read env lazily (vitest injects test.env into process.env before test modules run).
function env() {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anon || !service) {
    throw new Error('SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY unset — vitest.config reads `supabase status`')
  }
  return { url, anon, service }
}

// Service-role client: bypasses RLS. SEED ONLY — never an assertion path.
export function serviceClient(): SupabaseClient {
  const { url, service } = env()
  return createClient(url, service, { auth: { persistSession: false } })
}

// Create a confirmed user and return its id + an RLS-bound client built EXACTLY like
// @movp/auth.resolvePrincipal (anon key + the user's real JWT in the Authorization header),
// so RLS sees this principal. Email is unique per call to avoid cross-run collisions.
export async function createUserClient(
  email = `${crypto.randomUUID()}@test.local`,
  password = 'password123!',
): Promise<{ userId: string; db: SupabaseClient }> {
  const { url, anon } = env()
  const svc = serviceClient()
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`createUser failed [${cErr?.status ?? '?'}]`)
  const userId = created.user.id

  const anonClient = createClient(url, anon, { auth: { persistSession: false } })
  const { data: signin, error: sErr } = await anonClient.auth.signInWithPassword({ email, password })
  if (sErr || !signin.session) throw new Error(`signIn failed [${sErr?.status ?? '?'}]`)

  const db = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${signin.session.access_token}` } },
    auth: { persistSession: false },
  })
  return { userId, db }
}

export async function seedWorkspace(name: string): Promise<string> {
  const { data, error } = await serviceClient().from('workspace').insert({ name }).select('id').single()
  if (error) throw new Error(`seedWorkspace failed [${error.code ?? '?'}]`)
  return data.id as string
}

export async function addMember(workspaceId: string, userId: string, role = 'member'): Promise<void> {
  const { error } = await serviceClient()
    .from('workspace_membership')
    .insert({ workspace_id: workspaceId, user_id: userId, role })
  if (error) throw new Error(`addMember failed [${error.code ?? '?'}]`)
}

// Seed a search_chunk row via service role — mirrors the out-of-band embedding indexer.
export async function seedChunk(opts: {
  workspaceId: string
  sourceTable: string
  sourceId: string
  field: string
  chunkIndex: number
  content: string
  embedding: number[]
}): Promise<void> {
  const { error } = await serviceClient().from('search_chunk').insert({
    workspace_id: opts.workspaceId,
    source_table: opts.sourceTable,
    source_id: opts.sourceId,
    field: opts.field,
    chunk_index: opts.chunkIndex,
    content: opts.content,
    // JS number[] → pgvector: PostgREST serializes the array to text "[...]", which is
    // pgvector's input format. If your stack rejects it, pass `'[' + opts.embedding.join(',') + ']'`.
    embedding: opts.embedding,
    content_hash: 'seed',
  })
  if (error) throw new Error(`seedChunk failed [${error.code ?? '?'}]`)
}
```

- [ ] **Step 5: Write the harness test (proves the seed + RLS-bound read path works)**

`packages/domain/test/harness.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { addMember, createUserClient, seedWorkspace } from './helpers/stack.ts'

describe('integration harness', () => {
  it('a member reads its workspace through the RLS-bound client', async () => {
    const { userId, db } = await createUserClient()
    const ws = await seedWorkspace('Acme')
    await addMember(ws, userId, 'owner')

    const { data, error } = await db.from('workspace').select('id').eq('id', ws)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('a non-member sees zero workspace rows (RLS)', async () => {
    const ws = await seedWorkspace('Beta')
    const { db } = await createUserClient() // never added as a member
    const { data, error } = await db.from('workspace').select('id').eq('id', ws)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Install, reset the DB, run the harness**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install && supabase db reset && pnpm --filter @movp/domain test
```
Expected: `pnpm install` links `@movp/domain`; `supabase db reset` reapplies Plan 1–2 migrations cleanly; vitest runs `harness.test.ts` — **PASS (2 tests)**. (If `supabase status` errors, run `supabase start` first.)

- [ ] **Step 7: Typecheck**

Run:
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS — types compile against `./generated/types.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): package skeleton, contract types, integration harness"
```

**Gate (machine-checkable):** `pnpm --filter @movp/domain test` is green (2 harness tests, including the non-member RLS read returning 0 rows) and `pnpm --filter @movp/domain typecheck` passes.

---

### Task 2: Collection factory — note CRUD + cursor pagination + RLS proof

**Files:**
- Create: `packages/domain/src/collection.ts`
- Create: `packages/domain/test/collection.note.test.ts`

**Interfaces:**
- Consumes: `DomainCtx`, `CollectionService`, `ListArgs`, `Page` (`./types.ts`); `NoteRow`/`NoteCreate`/`NoteUpdate` (`./generated/types.ts`); the `public.note` table + RLS (Plan 2).
- Produces (consumed by Task 3, Task 7):
  - `function makeCollectionService<Row extends { id: string; workspace_id: string }, Create, Update>(ctx: DomainCtx, config: { table: string }): CollectionService<Row, Create, Update>`
  - Cursor contract: keyset on `id` (a uuid; unique, stable, no special chars). `nextCursor = btoa(lastId)`; `after` is decoded via `atob`. `first` clamped to `1..100` (default 20). `list` filters by `args.workspaceId` AND relies on RLS.

- [ ] **Step 1: Write the failing note CRUD + pagination + RLS test**

`packages/domain/test/collection.note.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCollectionService } from '../src/collection.ts'
import type { NoteRow, NoteCreate, NoteUpdate } from '../src/generated/types.ts'
import { addMember, createUserClient, seedWorkspace } from './helpers/stack.ts'

function notes(db: any) {
  return makeCollectionService<NoteRow, NoteCreate, NoteUpdate>({ db, userId: 'unused' }, { table: 'note' })
}

describe('note CollectionService', () => {
  let ws: string
  let memberDb: any

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('Notes WS')
    await addMember(ws, member.userId, 'owner')
    memberDb = member.db
  })

  it('create → get → update → delete under RLS', async () => {
    const svc = notes(memberDb)

    const created = await svc.create({ workspace_id: ws, title: 'First', body: 'hello' })
    expect(created.id).toBeTruthy()
    expect(created.title).toBe('First')
    expect(created.status).toBe('draft') // DB default

    const got = await svc.get(created.id)
    expect(got?.id).toBe(created.id)

    const updated = await svc.update(created.id, { title: 'First (edited)', status: 'published' })
    expect(updated.title).toBe('First (edited)')
    expect(updated.status).toBe('published')

    await svc.delete(created.id)
    expect(await svc.get(created.id)).toBeNull()
  })

  it('list paginates by cursor, returning every row exactly once', async () => {
    const svc = notes(memberDb)
    const created = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const n = await svc.create({ workspace_id: ws, title: `Page ${i}` })
      created.add(n.id)
    }

    const seen = new Set<string>()
    let after: string | null = null
    let pages = 0
    do {
      const page = await svc.list({ workspaceId: ws, first: 2, after })
      expect(page.items.length).toBeLessThanOrEqual(2)
      for (const it of page.items) seen.add(it.id)
      after = page.nextCursor
      pages++
      expect(pages).toBeLessThan(10) // termination guard
    } while (after)

    for (const id of created) expect(seen.has(id)).toBe(true)
  })

  it('a non-member cannot read, list, or create in the workspace', async () => {
    const outsider = await createUserClient() // not a member of ws
    const svc = notes(outsider.db)

    // seed a row as the member so there is something to (not) see
    const owned = await notes(memberDb).create({ workspace_id: ws, title: 'Secret' })

    expect(await svc.get(owned.id)).toBeNull()
    const page = await svc.list({ workspaceId: ws, first: 50 })
    expect(page.items).toHaveLength(0)
    await expect(svc.create({ workspace_id: ws, title: 'intruder' })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: FAIL — cannot resolve `../src/collection.ts` / `makeCollectionService` is not defined.

- [ ] **Step 3: Implement the factory**

`packages/domain/src/collection.ts`:
```ts
import type { CollectionService, DomainCtx, ListArgs, Page } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100

// btoa/atob are web-standard globals (Node 18+, Deno) — keep the core runtime-agnostic.
const encodeCursor = (id: string): string => btoa(id)
const decodeCursor = (cursor: string): string => atob(cursor)

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

export function makeCollectionService<
  Row extends { id: string; workspace_id: string },
  Create,
  Update,
>(ctx: DomainCtx, config: { table: string }): CollectionService<Row, Create, Update> {
  const t = config.table

  const fail = (op: string, code: string | undefined): never => {
    // Stable diagnostic only (op + PostgREST code) — never row values / input / PII.
    throw new Error(`domain.${t}.${op} failed [${code ?? 'unknown'}]`)
  }

  return {
    async create(input) {
      const { data, error } = await ctx.db.from(t).insert(input as Record<string, unknown>).select('*').single()
      if (error) fail('create', error.code)
      return data as Row
    },

    async get(id) {
      const { data, error } = await ctx.db.from(t).select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as Row | null) ?? null
    },

    async list(args: ListArgs): Promise<Page<Row>> {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db
        .from(t)
        .select('*')
        .eq('workspace_id', args.workspaceId) // workspaceId filters; RLS also enforces it
        .order('id', { ascending: true })
        .limit(first + 1) // fetch one extra to detect a next page
      if (args.after) q = q.gt('id', decodeCursor(args.after))

      const { data, error } = await q
      if (error) fail('list', error.code)
      const rows = (data ?? []) as Row[]
      const hasMore = rows.length > first
      const items = hasMore ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null }
    },

    async update(id, patch) {
      const { data, error } = await ctx.db.from(t).update(patch as Record<string, unknown>).eq('id', id).select('*').single()
      if (error) fail('update', error.code)
      return data as Row
    },

    async delete(id) {
      const { error } = await ctx.db.from(t).delete().eq('id', id)
      if (error) fail('delete', error.code)
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: PASS — `harness.test.ts` (2) + `collection.note.test.ts` (3) green. The non-member case proves `get`→null, `list`→empty, `create`→throws under RLS.

- [ ] **Step 5: Typecheck + commit**

Run:
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS.
```bash
git add packages/domain
git commit -m "feat(domain): collection factory with CRUD + cursor pagination + RLS proof"
```

**Gate (machine-checkable):** `pnpm --filter @movp/domain test` green including the non-member denial test, and `typecheck` passes.

---

### Task 3: Tag service via factory reuse

**Files:**
- Create: `packages/domain/test/collection.tag.test.ts`
- (No new `src/` file — `tag` is the factory's second real consumer, config-only.)

**Interfaces:**
- Consumes: `makeCollectionService` (Task 2); `TagRow`/`TagCreate`/`TagUpdate` (`./generated/types.ts`); the `public.tag` table + RLS (Plan 2).
- Produces: confirmation that the generic factory serves `tag` unchanged — `makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' })`. This is the "first real second consumer" that justifies the factory abstraction (vs. a note-specific service).

- [ ] **Step 1: Write the failing tag CRUD test**

`packages/domain/test/collection.tag.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCollectionService } from '../src/collection.ts'
import type { TagRow, TagCreate, TagUpdate } from '../src/generated/types.ts'
import { addMember, createUserClient, seedWorkspace } from './helpers/stack.ts'

describe('tag CollectionService (factory reuse)', () => {
  let ws: string
  let db: any

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('Tags WS')
    await addMember(ws, member.userId, 'owner')
    db = member.db
  })

  it('create → get → update → list → delete', async () => {
    const svc = makeCollectionService<TagRow, TagCreate, TagUpdate>({ db, userId: 'unused' }, { table: 'tag' })

    const created = await svc.create({ workspace_id: ws, name: 'green' })
    expect(created.name).toBe('green')

    expect((await svc.get(created.id))?.name).toBe('green')

    const updated = await svc.update(created.id, { name: 'emerald' })
    expect(updated.name).toBe('emerald')

    const page = await svc.list({ workspaceId: ws, first: 50 })
    expect(page.items.some((r) => r.id === created.id)).toBe(true)

    await svc.delete(created.id)
    expect(await svc.get(created.id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: the new file is exercised against the existing factory. Because `tag` only differs by `table`/`name`, this PASSES immediately on the Task 2 implementation. If `public.tag` is missing it FAILS loudly with a `[42P01]`-style code (signals Plan 2 not applied) — run `supabase db reset`. End state: PASS — harness (2) + note (3) + tag (1).

> TDD note: the failing→passing cycle for the factory itself happened in Task 2. Task 3's value is proving reuse with a real second collection; no production code changes, so a green run is the gate. If you prefer a strict red phase, comment out the `table: 'tag'` line, confirm a failure, then restore.

- [ ] **Step 3: Typecheck + commit**

Run:
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS — `TagRow/TagCreate/TagUpdate` satisfy the factory's `Row extends { id, workspace_id }` bound.
```bash
git add packages/domain
git commit -m "test(domain): tag service proves collection-factory reuse"
```

**Gate (machine-checkable):** `pnpm --filter @movp/domain test` green (harness 2 + note 3 + tag 1) and `typecheck` passes.

---

### Task 4: `search()` — FTS path + `public.search_fts` migration

**Files:**
- Create: `supabase/migrations/<ts>_search_fts.sql`
- Create: `packages/domain/src/search.ts`
- Create: `packages/domain/test/search.fts.test.ts`

**Interfaces:**
- Consumes: `DomainCtx`, `SearchArgs`, `SearchHit`, `EmbeddingProvider` (`./types.ts`); the per-collection `search_vector` + GIN (Plan 2).
- Produces (SQL — pin this exact signature):
  - `public.search_fts(ws uuid, src_table text, q text, lim int default 10) returns table (id uuid, title text, snippet text, score real)` — `SECURITY INVOKER`, `set search_path = ''`, allow-listed table → `ts_rank` over the table's `search_vector`. `execute` granted to `authenticated` only.
- Produces (TS):
  - `function runSearch(ctx: DomainCtx, embedder: EmbeddingProvider | undefined, a: SearchArgs): Promise<SearchHit[]>` — dispatches on `a.mode` (default `'fts'`); clamps `limit` to `1..100` (default 10). FTS path queries `a.collection` or `['note','tag']`, mapping each RPC row to `SearchHit` and sorting by `score` desc.

- [ ] **Step 1: Write the failing FTS test**

`packages/domain/test/search.fts.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { runSearch } from '../src/search.ts'
import { makeCollectionService } from '../src/collection.ts'
import type { NoteRow, NoteCreate, NoteUpdate } from '../src/generated/types.ts'
import { addMember, createUserClient, seedWorkspace } from './helpers/stack.ts'

describe('search() — fts', () => {
  let ws: string
  let db: any
  let noteId: string
  const token = `zylophonix${Date.now()}` // a unique, FTS-tokenizable term

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('FTS WS')
    await addMember(ws, member.userId, 'owner')
    db = member.db
    const notes = makeCollectionService<NoteRow, NoteCreate, NoteUpdate>({ db, userId: 'unused' }, { table: 'note' })
    const n = await notes.create({ workspace_id: ws, title: `Title ${token}`, body: 'body text' })
    noteId = n.id
    // a decoy note that should NOT match
    await notes.create({ workspace_id: ws, title: 'unrelated heading', body: 'nothing here' })
  })

  it('finds the created note across collections (default mode = fts)', async () => {
    const hits = await runSearch({ db, userId: 'unused' }, undefined, { workspaceId: ws, query: token })
    const hit = hits.find((h) => h.id === noteId)
    expect(hit).toBeDefined()
    expect(hit?.collection).toBe('note')
    expect(typeof hit?.score).toBe('number')
    expect(hits.some((h) => h.collection === 'note' && h.title.includes(token))).toBe(true)
  })

  it('scopes to a single collection when requested', async () => {
    const hits = await runSearch({ db, userId: 'unused' }, undefined, {
      workspaceId: ws, query: token, mode: 'fts', collection: 'note',
    })
    expect(hits.every((h) => h.collection === 'note')).toBe(true)
    expect(hits.some((h) => h.id === noteId)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: FAIL — cannot resolve `../src/search.ts` / `runSearch` undefined.

- [ ] **Step 3: Author the `search_fts` migration**

Run:
```bash
supabase migration new search_fts
```
Put this in the created `supabase/migrations/<timestamp>_search_fts.sql`:
```sql
-- Domain-support RPC (hand-authored, not codegen): ranked FTS over a collection's
-- search_vector. SECURITY INVOKER so RLS on note/tag applies to the caller; the ws arg
-- is belt-and-suspenders alongside RLS. Injection-safe: src_table is allow-listed
-- (case → title_col, else raise), interpolated via %I (identifier quoting); the user
-- query is bound as $1 to websearch_to_tsquery, never concatenated.
create or replace function public.search_fts(ws uuid, src_table text, q text, lim int default 10)
returns table (id uuid, title text, snippet text, score real)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  title_col text;
begin
  title_col := case src_table
    when 'note' then 'title'
    when 'tag'  then 'name'
    else null
  end;
  if title_col is null then
    raise exception 'search_fts: unsupported collection %', src_table using errcode = '22023';
  end if;

  return query execute format(
    $q$
      select t.id,
             t.%1$I::text as title,
             t.%1$I::text as snippet,
             ts_rank(t.search_vector, websearch_to_tsquery('english', $1))::real as score
        from public.%2$I t
       where t.workspace_id = $2
         and t.search_vector @@ websearch_to_tsquery('english', $1)
       order by score desc
       limit least(greatest($3, 1), 100)
    $q$, title_col, src_table)
  using q, ws, lim;
end;
$fn$;

revoke all on function public.search_fts(uuid, text, text, int) from public, anon;
grant execute on function public.search_fts(uuid, text, text, int) to authenticated;
```

> Gotcha (inlined): `pg_catalog` is always implicitly searched even with `search_path = ''`, so `ts_rank`/`websearch_to_tsquery`/`format`/`least`/`greatest` resolve unqualified. Domain tables are explicitly `public.%I`. The `$fn$`/`$q$` dollar-quote tags differ so the `$1/$2/$3` EXECUTE params pass through `format()` untouched (`format` only processes `%`).

- [ ] **Step 4: Implement the FTS search path**

`packages/domain/src/search.ts`:
```ts
import type { DomainCtx, EmbeddingProvider, SearchArgs, SearchHit } from './types.ts'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

// v1 collections. In a fuller system this comes from @movp/core-schema metadata.
const ALL_COLLECTIONS = ['note', 'tag'] as const

async function ftsSearch(ctx: DomainCtx, a: SearchArgs, limit: number): Promise<SearchHit[]> {
  const tables = a.collection ? [a.collection] : [...ALL_COLLECTIONS]
  const perTable = await Promise.all(
    tables.map(async (table) => {
      const { data, error } = await ctx.db.rpc('search_fts', {
        ws: a.workspaceId, src_table: table, q: a.query, lim: limit,
      })
      if (error) throw new Error(`domain.search.fts failed for ${table} [${error.code ?? 'unknown'}]`)
      return ((data ?? []) as Array<{ id: string; title: string; snippet: string; score: number }>).map(
        (r): SearchHit => ({ collection: table, id: r.id, title: r.title, snippet: r.snippet, score: r.score }),
      )
    }),
  )
  return perTable.flat().sort((x, y) => y.score - x.score).slice(0, limit)
}

export async function runSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider | undefined,
  a: SearchArgs,
): Promise<SearchHit[]> {
  const mode = a.mode ?? 'fts'
  const limit = clamp(a.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
  if (mode === 'fts') return ftsSearch(ctx, a, limit)
  // semantic / hybrid implemented in Task 5
  throw new Error(`domain.search: mode '${mode}' not yet implemented`)
}
```

- [ ] **Step 5: Apply the migration and run the test**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain test
```
Expected: `db reset` applies the new `search_fts` migration cleanly; vitest PASS — FTS tests green (created note found across collections and when scoped to `note`).

> The default-mode test queries both `note` and `tag`, which relies on Plan 2's per-collection `search_vector` existing on `tag`. If it errors for `tag` only, Plan 2 did not make `tag.name` searchable — surface that rather than silently scoping to `note`.

- [ ] **Step 6: Confirm no drift + typecheck + commit**

Run:
```bash
supabase db diff
```
Expected: empty (DB matches migrations).
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS.
```bash
git add packages/domain supabase/migrations
git commit -m "feat(domain): fts search via hardened search_fts RPC"
```

**Gate (machine-checkable):** `supabase db reset` applies the migration, `supabase db diff` is empty, and `pnpm --filter @movp/domain test` is green (FTS returns the created note).

---

### Task 5: `search()` — semantic + hybrid + `EmbeddingProvider` seam

**Files:**
- Edit: `packages/domain/src/search.ts` (add semantic + hybrid; remove the "not yet implemented" throw)
- Create: `packages/domain/test/helpers/embedder.ts`
- Create: `packages/domain/test/search.semantic.test.ts`

**Interfaces:**
- Consumes: `public.match_chunks(query_embedding extensions.vector(384), ws uuid, source_table_filter text default null, match_count int default 10) returns table(source_table text, source_id uuid, field text, chunk_index int, content text, distance float)` (Plan 2); `public.search_chunk` (Plan 2, member-SELECT RLS); `EmbeddingProvider` (`./types.ts`).
- Produces (TS):
  - `runSearch(...)` now handles `'semantic'` and `'hybrid'`. Both require `embedder` (else `throw new Error("domain.search: mode '<mode>' requires opts.embedder")`).
  - Semantic: `embedder.embed(query)` → 384-dim vector → `match_chunks` RPC; dedupe chunks to the best (min-distance) chunk per `(source_table, source_id)`; hydrate parent titles via the RLS-bound client; `score = 1 - distance`; snippet = chunk content.
  - Hybrid: run FTS + semantic, merge by `${collection}:${id}` (sum scores, prefer the semantic chunk snippet), sort desc, slice to `limit`.

- [ ] **Step 1: Add the deterministic fake embedder helper**

`packages/domain/test/helpers/embedder.ts`:
```ts
import type { EmbeddingProvider } from '../../src/types.ts'

// 384-dim one-hot. Non-zero (cosine is defined), and `match` vs `other` are orthogonal
// so the matching chunk has distance 0 and ranks strictly above the orthogonal one.
export const FAKE_VEC: number[] = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))
export const ORTHOGONAL_VEC: number[] = Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0))

// Deterministic: always returns FAKE_VEC, so a chunk seeded with FAKE_VEC is the 0-distance match.
export const fakeEmbedder: EmbeddingProvider = {
  embed: async (_text: string) => FAKE_VEC,
}
```

- [ ] **Step 2: Write the failing semantic + hybrid test**

`packages/domain/test/search.semantic.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { runSearch } from '../src/search.ts'
import { makeCollectionService } from '../src/collection.ts'
import type { NoteRow, NoteCreate, NoteUpdate } from '../src/generated/types.ts'
import { addMember, createUserClient, seedChunk, seedWorkspace } from './helpers/stack.ts'
import { FAKE_VEC, ORTHOGONAL_VEC, fakeEmbedder } from './helpers/embedder.ts'

describe('search() — semantic + hybrid', () => {
  let ws: string
  let db: any
  let matchId: string
  const token = `chunkterm${Date.now()}`

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('Semantic WS')
    await addMember(ws, member.userId, 'owner')
    db = member.db
    const notes = makeCollectionService<NoteRow, NoteCreate, NoteUpdate>({ db, userId: 'unused' }, { table: 'note' })

    const match = await notes.create({ workspace_id: ws, title: `Match ${token}`, body: 'long body content' })
    matchId = match.id
    const other = await notes.create({ workspace_id: ws, title: 'Other', body: 'unrelated' })

    // Seed chunks via service role — mirrors the out-of-band embedding indexer.
    await seedChunk({ workspaceId: ws, sourceTable: 'note', sourceId: match.id, field: 'body', chunkIndex: 0, content: `chunk for ${token}`, embedding: FAKE_VEC })
    await seedChunk({ workspaceId: ws, sourceTable: 'note', sourceId: other.id, field: 'body', chunkIndex: 0, content: 'orthogonal chunk', embedding: ORTHOGONAL_VEC })
  })

  it('semantic returns the matching note first, with parent title hydrated', async () => {
    const hits = await runSearch({ db, userId: 'unused' }, fakeEmbedder, { workspaceId: ws, query: 'anything', mode: 'semantic' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].id).toBe(matchId)
    expect(hits[0].collection).toBe('note')
    expect(hits[0].title).toContain(token) // hydrated from the parent row
    expect(hits[0].score).toBeGreaterThan(hits[hits.length - 1].score) // 1 - distance ordering
  })

  it('hybrid returns the note (fts term + semantic match)', async () => {
    const hits = await runSearch({ db, userId: 'unused' }, fakeEmbedder, { workspaceId: ws, query: token, mode: 'hybrid' })
    expect(hits.some((h) => h.id === matchId)).toBe(true)
  })

  it('semantic without an embedder throws', async () => {
    await expect(
      runSearch({ db, userId: 'unused' }, undefined, { workspaceId: ws, query: token, mode: 'semantic' }),
    ).rejects.toThrow(/requires opts.embedder/)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: FAIL — semantic/hybrid hit the `not yet implemented` throw (the "without embedder" assertion expects a different message).

- [ ] **Step 4: Implement semantic + hybrid**

Replace the body of `packages/domain/src/search.ts` with:
```ts
import type { DomainCtx, EmbeddingProvider, SearchArgs, SearchHit } from './types.ts'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

// v1 collections + their title column. In a fuller system this comes from @movp/core-schema metadata.
const ALL_COLLECTIONS = ['note', 'tag'] as const
const TITLE_COLUMN: Record<string, string> = { note: 'title', tag: 'name' }

async function ftsSearch(ctx: DomainCtx, a: SearchArgs, limit: number): Promise<SearchHit[]> {
  const tables = a.collection ? [a.collection] : [...ALL_COLLECTIONS]
  const perTable = await Promise.all(
    tables.map(async (table) => {
      const { data, error } = await ctx.db.rpc('search_fts', {
        ws: a.workspaceId, src_table: table, q: a.query, lim: limit,
      })
      if (error) throw new Error(`domain.search.fts failed for ${table} [${error.code ?? 'unknown'}]`)
      return ((data ?? []) as Array<{ id: string; title: string; snippet: string; score: number }>).map(
        (r): SearchHit => ({ collection: table, id: r.id, title: r.title, snippet: r.snippet, score: r.score }),
      )
    }),
  )
  return perTable.flat().sort((x, y) => y.score - x.score).slice(0, limit)
}

type Best = { table: string; id: string; content: string; distance: number }

// Batched title lookup through the caller's RLS-bound client (one query per table).
async function hydrateTitles(ctx: DomainCtx, best: Best[]): Promise<Map<string, string>> {
  const byTable = new Map<string, string[]>()
  for (const b of best) {
    const arr = byTable.get(b.table) ?? []
    arr.push(b.id)
    byTable.set(b.table, arr)
  }
  const out = new Map<string, string>()
  for (const [table, ids] of byTable) {
    const col = TITLE_COLUMN[table] ?? 'title'
    const { data, error } = await ctx.db.from(table).select(`id, ${col}`).in('id', ids)
    if (error) throw new Error(`domain.search.hydrate failed for ${table} [${error.code ?? 'unknown'}]`)
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(`${table}:${row.id as string}`, (row[col] as string) ?? '')
    }
  }
  return out
}

async function semanticSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider,
  a: SearchArgs,
  limit: number,
): Promise<SearchHit[]> {
  const queryVec = await embedder.embed(a.query) // 384-dim
  const { data, error } = await ctx.db.rpc('match_chunks', {
    query_embedding: queryVec, // JS number[] → pgvector (PostgREST coerces array → "[...]")
    ws: a.workspaceId,
    source_table_filter: a.collection ?? null,
    match_count: limit,
  })
  if (error) throw new Error(`domain.search.semantic failed [${error.code ?? 'unknown'}]`)

  const chunks = (data ?? []) as Array<{ source_table: string; source_id: string; content: string; distance: number }>
  const bestByParent = new Map<string, Best>()
  for (const c of chunks) {
    const key = `${c.source_table}:${c.source_id}`
    const prev = bestByParent.get(key)
    if (!prev || c.distance < prev.distance) {
      bestByParent.set(key, { table: c.source_table, id: c.source_id, content: c.content, distance: c.distance })
    }
  }
  const best = [...bestByParent.values()]
  const titles = await hydrateTitles(ctx, best)
  return best
    .map((b): SearchHit => ({
      collection: b.table,
      id: b.id,
      title: titles.get(`${b.table}:${b.id}`) ?? '',
      snippet: b.content,
      score: 1 - b.distance, // cosine distance → similarity; higher is better
    }))
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
}

async function hybridSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider,
  a: SearchArgs,
  limit: number,
): Promise<SearchHit[]> {
  const [fts, sem] = await Promise.all([ftsSearch(ctx, a, limit), semanticSearch(ctx, embedder, a, limit)])
  const merged = new Map<string, SearchHit>()
  for (const h of [...fts, ...sem]) {
    const key = `${h.collection}:${h.id}`
    const prev = merged.get(key)
    if (!prev) merged.set(key, { ...h })
    // NOTE: fts (ts_rank ~0.06) and semantic (1 - distance ~1) are different scales; v1 sums
    // them (a present-in-both row is boosted). Scale-normalized fusion (e.g. RRF) is a future tune.
    else merged.set(key, { ...prev, score: prev.score + h.score, snippet: prev.snippet || h.snippet })
  }
  return [...merged.values()].sort((x, y) => y.score - x.score).slice(0, limit)
}

export async function runSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider | undefined,
  a: SearchArgs,
): Promise<SearchHit[]> {
  const mode = a.mode ?? 'fts'
  const limit = clamp(a.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
  if (mode === 'fts') return ftsSearch(ctx, a, limit)
  if (!embedder) throw new Error(`domain.search: mode '${mode}' requires opts.embedder`)
  if (mode === 'semantic') return semanticSearch(ctx, embedder, a, limit)
  return hybridSearch(ctx, embedder, a, limit)
}
```

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: PASS — semantic returns the FAKE_VEC-matched note first (distance 0), title hydrated from the parent row; hybrid returns it; the missing-embedder case throws `requires opts.embedder`.

> If `match_chunks` returns a permission error (`42501`/`PGRST301`) for the authenticated caller, Plan 2 did not `grant execute ... to authenticated` on `match_chunks`. Surface it — do not work around it with the service-role client (that would break the RLS-on-assertion-path rule).

- [ ] **Step 6: Typecheck + commit**

Run:
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS.
```bash
git add packages/domain
git commit -m "feat(domain): semantic + hybrid search via EmbeddingProvider seam"
```

**Gate (machine-checkable):** `pnpm --filter @movp/domain test` green — semantic search returns the seeded-chunk note via the injected fake embedder, hybrid returns it, and missing-embedder throws.

---

### Task 6: `GraphService` — link + traverse + `public.traverse_edges` migration

**Files:**
- Create: `supabase/migrations/<ts>_graph_traverse.sql`
- Create: `packages/domain/src/graph.ts`
- Create: `packages/domain/test/graph.test.ts`

**Interfaces:**
- Consumes: `public.edges(id, workspace_id, src_type, src_id, rel, dst_type, dst_id, metadata, created_at)` + RLS via `is_workspace_member` (Plan 2); `GraphService`, `DomainCtx` (`./types.ts`).
- Produces (SQL — pin these):
  - (No new index.) The `link` upsert reuses Plan 2's inline `unique (workspace_id, src_type, src_id, rel, dst_type, dst_id)` constraint on `public.edges` as its `onConflict` target.
  - `public.traverse_edges(ws uuid, src_type text, src_id uuid, rel text default null, max_depth int default 5) returns table (type text, id uuid, depth int)` — `SECURITY INVOKER`, `set search_path = ''`, recursive CTE over `public.edges`, depth clamped `1..10`, returns each reachable node once at its min depth. `execute` granted to `authenticated` only.
- Produces (TS):
  - `function makeGraphService(ctx: DomainCtx): GraphService` — `link` upserts `public.edges` (idempotent via `onConflict` + `ignoreDuplicates`); `traverse` calls the `traverse_edges` RPC, passing `rel ?? null`, `depth ?? 5`.

- [ ] **Step 1: Write the failing graph test**

`packages/domain/test/graph.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { makeGraphService } from '../src/graph.ts'
import { makeCollectionService } from '../src/collection.ts'
import type { NoteRow, NoteCreate, NoteUpdate } from '../src/generated/types.ts'
import type { TagRow, TagCreate, TagUpdate } from '../src/generated/types.ts'
import { addMember, createUserClient, seedWorkspace } from './helpers/stack.ts'

describe('GraphService', () => {
  let ws: string
  let db: any
  let noteId: string
  let tagId: string
  let tag2Id: string

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('Graph WS')
    await addMember(ws, member.userId, 'owner')
    db = member.db
    const ctx = { db, userId: 'unused' }
    const note = await makeCollectionService<NoteRow, NoteCreate, NoteUpdate>(ctx, { table: 'note' }).create({ workspace_id: ws, title: 'Graph note' })
    const tags = makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' })
    const tag = await tags.create({ workspace_id: ws, name: 'graph-tag' })
    const tag2 = await tags.create({ workspace_id: ws, name: 'graph-tag-2' })
    noteId = note.id; tagId = tag.id; tag2Id = tag2.id
  })

  it('link then traverse returns the linked tag at depth 1', async () => {
    const graph = makeGraphService({ db, userId: 'unused' })
    await graph.link({ workspaceId: ws, srcType: 'note', srcId: noteId, rel: 'tagged', dstType: 'tag', dstId: tagId })
    await graph.link({ workspaceId: ws, srcType: 'note', srcId: noteId, rel: 'tagged', dstType: 'tag', dstId: tagId }) // idempotent

    const reached = await graph.traverse({ workspaceId: ws, srcType: 'note', srcId: noteId })
    expect(reached).toContainEqual({ type: 'tag', id: tagId, depth: 1 })
    // idempotent link → exactly one occurrence
    expect(reached.filter((r) => r.id === tagId)).toHaveLength(1)
  })

  it('traverses multiple hops with min depth', async () => {
    const graph = makeGraphService({ db, userId: 'unused' })
    await graph.link({ workspaceId: ws, srcType: 'tag', srcId: tagId, rel: 'tagged', dstType: 'tag', dstId: tag2Id })

    const reached = await graph.traverse({ workspaceId: ws, srcType: 'note', srcId: noteId, rel: 'tagged', depth: 3 })
    expect(reached).toContainEqual({ type: 'tag', id: tagId, depth: 1 })
    expect(reached).toContainEqual({ type: 'tag', id: tag2Id, depth: 2 })
  })

  it('a non-member traverses nothing (RLS on edges)', async () => {
    const outsider = await createUserClient()
    const reached = await makeGraphService(outsider).traverse({ workspaceId: ws, srcType: 'note', srcId: noteId })
    expect(reached).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: FAIL — cannot resolve `../src/graph.ts` / `makeGraphService` undefined.

- [ ] **Step 3: Author the `graph_traverse` migration**

Run:
```bash
supabase migration new graph_traverse
```
Put this in the created `supabase/migrations/<timestamp>_graph_traverse.sql`:
```sql
-- NOTE: graph.link's idempotent upsert relies on the UNIQUE constraint
-- (workspace_id, src_type, src_id, rel, dst_type, dst_id) that Plan 2 already
-- declares inline on public.edges. Do NOT add a second unique index here —
-- it would create a redundant index and (because the name differs) would not be
-- skipped by `if not exists`. This migration adds only the traverse RPC.

-- Domain-support RPC (hand-authored, not codegen): bounded recursive graph walk.
-- SECURITY INVOKER so RLS on public.edges applies to the caller; ws arg is belt-and-suspenders.
-- Parameters are qualified as traverse_edges.<name> to disambiguate from edge columns.
create or replace function public.traverse_edges(
  ws uuid,
  src_type text,
  src_id uuid,
  rel text default null,
  max_depth int default 5
)
returns table (type text, id uuid, depth int)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with recursive walk as (
    select e.dst_type as type, e.dst_id as id, 1 as depth
    from public.edges e
    where e.workspace_id = ws
      and e.src_type = traverse_edges.src_type
      and e.src_id   = traverse_edges.src_id
      and (traverse_edges.rel is null or e.rel = traverse_edges.rel)
    union
    select e.dst_type, e.dst_id, w.depth + 1
    from public.edges e
    join walk w on e.src_type = w.type and e.src_id = w.id
    where e.workspace_id = ws
      and (traverse_edges.rel is null or e.rel = traverse_edges.rel)
      and w.depth < least(greatest(traverse_edges.max_depth, 1), 10)
  )
  select w2.type, w2.id, min(w2.depth)::int as depth
  from walk w2
  group by w2.type, w2.id
  order by 3, 1, 2;
$fn$;

revoke all on function public.traverse_edges(uuid, text, uuid, text, int) from public, anon;
grant execute on function public.traverse_edges(uuid, text, uuid, text, int) to authenticated;
```

> Gotcha (inlined): `union` (not `union all`) plus the `w.depth < cap` guard keeps a cyclic graph terminating; `min(depth)` collapses a node reached by several paths to its shortest depth. `least`/`greatest`/`min` are `pg_catalog` (implicit under `search_path = ''`); `public.edges` is explicit.

- [ ] **Step 4: Implement the graph service**

`packages/domain/src/graph.ts`:
```ts
import type { DomainCtx, GraphService } from './types.ts'

export function makeGraphService(ctx: DomainCtx): GraphService {
  return {
    async link(a) {
      const { error } = await ctx.db.from('edges').upsert(
        {
          workspace_id: a.workspaceId,
          src_type: a.srcType,
          src_id: a.srcId,
          rel: a.rel,
          dst_type: a.dstType,
          dst_id: a.dstId,
        },
        { onConflict: 'workspace_id,src_type,src_id,rel,dst_type,dst_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(`domain.graph.link failed [${error.code ?? 'unknown'}]`)
    },

    async traverse(a) {
      const { data, error } = await ctx.db.rpc('traverse_edges', {
        ws: a.workspaceId,
        src_type: a.srcType,
        src_id: a.srcId,
        rel: a.rel ?? null,
        max_depth: a.depth ?? 5,
      })
      if (error) throw new Error(`domain.graph.traverse failed [${error.code ?? 'unknown'}]`)
      return (data ?? []) as Array<{ type: string; id: string; depth: number }>
    },
  }
}
```

- [ ] **Step 5: Apply the migration and run the test**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain test
```
Expected: `db reset` applies `graph_traverse` cleanly; vitest PASS — link+traverse returns the tag at depth 1 (idempotent: exactly one), multi-hop returns tag2 at depth 2, and a non-member traverses 0 rows.

- [ ] **Step 6: Confirm no drift + typecheck + commit**

Run:
```bash
supabase db diff
```
Expected: empty.
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS.
```bash
git add packages/domain supabase/migrations
git commit -m "feat(domain): graph link/traverse via traverse_edges RPC"
```

**Gate (machine-checkable):** `supabase db reset` applies the migration, `supabase db diff` empty, and `pnpm --filter @movp/domain test` green — link+traverse returns the linked tag and a non-member sees nothing.

---

### Task 7: Assemble `createDomain` + end-to-end Domain test

**Files:**
- Create: `packages/domain/src/domain.ts`
- Edit: `packages/domain/src/index.ts` (add the `createDomain` export)
- Create: `packages/domain/test/domain.e2e.test.ts`

**Interfaces:**
- Consumes: `makeCollectionService` (Task 2), `runSearch` (Task 5), `makeGraphService` (Task 6); all contract types (`./types.ts`); `NoteRow`/`NoteCreate`/`NoteUpdate`, `TagRow`/`TagCreate`/`TagUpdate` (`./generated/types.ts`).
- Produces (the public entry point; consumed by Plan 4 surfaces):
  - `function createDomain(ctx: DomainCtx, opts?: { embedder?: EmbeddingProvider }): Domain`
  - `index.ts` re-exports `createDomain` + all contract types.

- [ ] **Step 1: Write the failing end-to-end test (through the public `Domain` object)**

`packages/domain/test/domain.e2e.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'
import { addMember, createUserClient, seedChunk, seedWorkspace } from './helpers/stack.ts'
import { FAKE_VEC, fakeEmbedder } from './helpers/embedder.ts'

describe('createDomain (end-to-end)', () => {
  let ws: string
  let ctx: { db: any; userId: string }

  beforeAll(async () => {
    const member = await createUserClient()
    ws = await seedWorkspace('E2E WS')
    await addMember(ws, member.userId, 'owner')
    ctx = { db: member.db, userId: member.userId }
  })

  it('CRUD + graph + fts + semantic through one Domain', async () => {
    const domain = createDomain(ctx, { embedder: fakeEmbedder })
    const term = `e2eterm${Date.now()}`

    const note = await domain.note.create({ workspace_id: ws, title: `Hello ${term}`, body: 'world' })
    const tag = await domain.tag.create({ workspace_id: ws, name: 'green' })

    // graph
    await domain.graph.link({ workspaceId: ws, srcType: 'note', srcId: note.id, rel: 'tagged', dstType: 'tag', dstId: tag.id })
    const reached = await domain.graph.traverse({ workspaceId: ws, srcType: 'note', srcId: note.id })
    expect(reached).toContainEqual({ type: 'tag', id: tag.id, depth: 1 })

    // fts
    const fts = await domain.search({ workspaceId: ws, query: term, mode: 'fts' })
    expect(fts.some((h) => h.id === note.id)).toBe(true)

    // semantic (seed a chunk via service role, then query through the user-bound client)
    await seedChunk({ workspaceId: ws, sourceTable: 'note', sourceId: note.id, field: 'body', chunkIndex: 0, content: 'world chunk', embedding: FAKE_VEC })
    const sem = await domain.search({ workspaceId: ws, query: 'anything', mode: 'semantic' })
    expect(sem.some((h) => h.id === note.id)).toBe(true)
  })

  it('semantic without opts.embedder throws', async () => {
    const domain = createDomain(ctx) // no embedder
    await expect(domain.search({ workspaceId: ws, query: 'x', mode: 'semantic' })).rejects.toThrow(/requires opts.embedder/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @movp/domain test
```
Expected: FAIL — `createDomain` is not exported from `../src/index.ts`.

- [ ] **Step 3: Implement `createDomain` and wire the export**

`packages/domain/src/domain.ts`:
```ts
import type {
  NoteRow, NoteCreate, NoteUpdate,
  TagRow, TagCreate, TagUpdate,
} from './generated/types.ts'
import type { Domain, DomainCtx, EmbeddingProvider } from './types.ts'
import { makeCollectionService } from './collection.ts'
import { makeGraphService } from './graph.ts'
import { runSearch } from './search.ts'

// ctx (the RLS-bound client + userId) is supplied per request by the caller and threaded
// into each service — never captured in module scope.
export function createDomain(ctx: DomainCtx, opts?: { embedder?: EmbeddingProvider }): Domain {
  const embedder = opts?.embedder
  return {
    note: makeCollectionService<NoteRow, NoteCreate, NoteUpdate>(ctx, { table: 'note' }),
    tag: makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' }),
    search: (a) => runSearch(ctx, embedder, a),
    graph: makeGraphService(ctx),
  }
}
```

Update `packages/domain/src/index.ts` to:
```ts
export { createDomain } from './domain.ts'
export type {
  DomainCtx, Page, ListArgs, SearchArgs, SearchHit,
  EmbeddingProvider, CollectionService, GraphService, Domain,
} from './types.ts'
```

- [ ] **Step 4: Run the full suite**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain test
```
Expected: PASS — all files green: `harness` (2), `collection.note` (3), `collection.tag` (1), `search.fts` (2), `search.semantic` (3), `graph` (3), `domain.e2e` (2). The e2e test exercises CRUD + graph + fts + semantic through one `createDomain(...)`.

- [ ] **Step 5: Typecheck + commit**

Run:
```bash
pnpm --filter @movp/domain typecheck
```
Expected: PASS.
```bash
git add packages/domain
git commit -m "feat(domain): assemble createDomain + end-to-end coverage"
```

- [ ] **Step 6: Final boundary check (runtime-agnostic core)**

Run:
```bash
grep -rERn "from '(node:|child_process)|require\(|Deno\.|process\.env|\bBuffer\b" /Users/ensell/Code/supasuite/packages/domain/src || echo CLEAN
```
Expected: `CLEAN` — no Node-only or Deno-only references under `src/` (test files and `vitest.config.ts` are excluded from this path). This is the machine-checkable proof of the runtime-agnostic constraint.

**Gate (machine-checkable):** full `pnpm --filter @movp/domain test` green across all 7 files, `typecheck` passes, `supabase db diff` empty, and the `src/` boundary grep prints `CLEAN`.

---

## Self-Review

- **Spec coverage (design Task 5 + this plan's deliverables):** `createDomain` + per-collection `CollectionService` for `note` & `tag` (Tasks 2–3, 7); cursor pagination (Task 2); search FTS / semantic / hybrid with the `EmbeddingProvider` seam (Tasks 4–5); `GraphService` link+traverse (Task 6). Deliverable gates met: CRUD under RLS (Task 2), **non-member sees nothing** (Task 2 get/list/create + Task 6 traverse), **FTS returns a created note** (Task 4), **semantic returns it via an injected fake embedder writing to `search_chunk` then `match_chunks`** (Task 5), **graph link+traverse returns the linked tag** (Task 6), and one end-to-end pass through `createDomain` (Task 7). Covered.
- **Public signatures Produced (contract surface):** `createDomain(ctx: DomainCtx, opts?: { embedder?: EmbeddingProvider }): Domain`; `DomainCtx`, `Page<T>`, `ListArgs`, `SearchArgs`, `SearchHit`, `EmbeddingProvider`, `CollectionService<Row,Create,Update>`, `GraphService`, `Domain` — verbatim from the shared contract. Internal: `makeCollectionService`, `runSearch`, `makeGraphService`.
- **SQL added in this plan (justified):** `public.search_fts(ws uuid, src_table text, q text, lim int default 10) returns table(id uuid, title text, snippet text, score real)` — supabase-js cannot compute `ts_rank` in a select, so an RPC is required for the contract's "fts uses … ts_rank". `public.traverse_edges(ws uuid, src_type text, src_id uuid, rel text default null, max_depth int default 5) returns table(type text, id uuid, depth int)` — the recursive CTE the contract authorizes. The idempotent `link` upsert reuses Plan 2's inline `unique` constraint on `public.edges` (no new index added here — avoids a redundant duplicate). All applied by the Supabase CLI; `db diff` stays empty.
- **Safety / hardening:** both functions are deliberately `SECURITY INVOKER` (RLS applies to the caller) with `set search_path = ''`, schema-qualified `public.*`, and `execute` revoked from `public`/`anon`, granted only to `authenticated`. Not `SECURITY DEFINER`, so the `definer-audit` gate is N/A by design. `search_fts` dynamic SQL is injection-safe (allow-listed table via `%I`; user query bound as `$1`). Tests prove authorization with a **real user-bound JWT**; service-role is seed-only, never on an assertion path.
- **Reliability / observability:** thrown errors carry `domain.<op> failed [<PostgREST code>]` — a stable diagnostic, no row values / query text / PII (`error.message` is never interpolated). `link` is idempotent (`ignoreDuplicates`); `traverse` terminates on cycles (`union` + depth cap 1..10) and reports min depth.
- **Efficiency / performance:** keyset pagination on `id` (`limit first+1`, no OFFSET); `match_count`/`lim`/`max_depth` clamped; semantic titles hydrated in one batched `.in(...)` query per table (not N+1); `Promise.all` fans out per-collection FTS and the fts+semantic legs of hybrid. Known v1 limitation stated inline: hybrid sums different-scale scores (RRF deferred).
- **Simplicity:** one generic `makeCollectionService` with `note` AND `tag` as real consumers (no speculative per-collection classes); `TITLE_COLUMN`/`ALL_COLLECTIONS` are the only collection-specific constants, flagged for future migration to `@movp/core-schema` metadata. createDomain assembled last so each module is tested directly first.
- **Usability:** `createDomain(ctx, { embedder })` is the single entry point; a missing embedder for semantic/hybrid fails loudly with `requires opts.embedder` rather than returning empty results. (No end-user UI in this package — a11y is N/A; surfaced UX belongs to Plan 4+.)
- **Placeholder scan:** none — every code/SQL block is complete; every step has an exact command + expected output; cursor uses web-standard `btoa`/`atob`; the runtime-agnostic constraint is enforced by the Task 7 grep gate.
- **Cross-plan assumptions stated (fail loud, not silent):** Plan 2 must have made `tag.name` searchable (per-collection `search_vector`) and granted `execute` on `match_chunks` to `authenticated`; both are surfaced as explicit notes at the call sites that depend on them, and `packages/domain/src/generated/types.ts` is checked for existence in Task 1.
