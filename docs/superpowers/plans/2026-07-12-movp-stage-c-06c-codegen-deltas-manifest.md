# Stage C6c — Immutable Project Codegen Deltas + Schema Manifest + Consistency (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a scaffolded downstream project immutable, forward-only codegen: baseline + every registered delta are compare-before-write (never deleted, never overwritten), an unowned schema change fails loudly with zero writes, `movp new-delta` allocates ownership + emits exactly one additive migration, codegen touches `layer='project'` metadata only, and a versioned `movp.schema.json` manifest plus a DB↔schema consistency gate keep the schema honest.

**Architecture:** C6c layers a *project mode* onto `@movp/codegen`. It is entered only when `generate()` receives `deltasRegistryPath` (the monorepo path is untouched, so the 33 existing `generate.test.ts` cases stay green). Project mode: (1) loads a validated `movp.deltas.json` registry; (2) emits only `layer='project'` collections/metadata via new project emitters; (3) computes all expected file bodies, compares every existing file, and refuses to write anything if a frozen file drifted or a project collection has no owning delta entry (`new_generated_delta_required`); (4) writes a deterministic `movp.schema.json`; and a separate pure comparator gates the DB metadata rows against `metadataProjection(schema)`.

**Tech Stack:** TypeScript (ESM, `node20`), Vitest 3, `@movp/core-schema` (06a schema-composition + `layer` marker; 06b `metadataProjection` / `schemaFingerprint`), `@movp/codegen`, `@movp/cli` (commander), Supabase local Postgres (`node:fs/promises`, `node:crypto`; no new dependencies).

## Global Constraints

- **Consume 06a/06b exactly; invent no cross-part API.** From 06a: `CollectionDef.layer: 'platform' | 'project'`; `schema.projectCollections` / `schema.platformCollections` derived views; `movp_collections` and `movp_fields` carry `layer text not null default 'platform'`. From 06b: `metadataProjection(schema): { collections: CollectionMeta[]; fields: FieldMeta[] }` and `schemaFingerprint(schema): string` (sha256 hex over canonical JSON of the projection), both exported from `@movp/core-schema`; `generate(options: { schema: MovpSchema; ... })` already gained a `schema` field. Import these; do not re-derive or re-implement them.
- **Never edit, delete, or rename a merged migration.** Migrations are forward-only from `supabase/.forward-only-migration-baseline`. The frozen monorepo baseline `20260701000002_movp_generated.sql` must stay **byte-identical**: the new project emitters must NOT be wired into the monorepo `emitSqlMigration` path.
- **Never use `any`.** Use `unknown` + a runtime type guard, or a real type.
- **Zero-writes-on-drift is a hard invariant.** In project mode, compute every expected file body and compare ALL existing files BEFORE writing ANY file. If a comparison fails, throw and write nothing.
- **Untrusted I/O discipline** ([[untrusted-io-and-resource-bounds]]): every read path does `lstat` and rejects symlinks BEFORE `readFile`; bounds size before buffering (`MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024`, already defined in `generate.ts`); validates parsed JSON structurally before dereferencing; never logs file/JSON contents (path + reason only).
- **Stable error codes** (exact strings, cross-part): `new_generated_delta_required`, `platform_row_delete_forbidden`. C6c-local consistency codes: `missing_metadata_row`, `altered_metadata_row`, `stale_metadata_row`, `invalid_deltas_registry`.
- **Determinism:** manifest collections ordered by `name`, fields by `name`; JSON serialized as `JSON.stringify(x, null, 2) + '\n'`.
- **After every change run the affected Vitest file and show output; commit per task.**

---

## File map

- Create `packages/codegen/src/deltas-registry.ts` — `movp.deltas.json` types + validated loader (Task 1).
- Modify `packages/codegen/src/emit-sql.ts` — add project-scoped emitters + prune guard (Task 2).
- Modify `packages/codegen/src/generate.ts` — add project-mode branch keyed on `deltasRegistryPath` (Task 3).
- Create `packages/codegen/src/new-delta.ts` — allocate ownership + emit one additive migration (Task 4); wire `@movp/cli`.
- Create `packages/codegen/src/emit-manifest.ts` — `movp.schema.json` emitter (Task 5).
- Create `packages/codegen/src/metadata-consistency.ts` — pure DB↔schema comparator (Task 6); `scripts/check-metadata-consistency.ts` wiring.
- Create `packages/codegen/test/*.test.ts` per task; integration slice `packages/codegen/test/project-codegen-e2e.test.ts` (Task 7).
- Extend `packages/codegen/src/index.ts` exports as each symbol lands.

---

### Task 1: Validated `movp.deltas.json` delta registry loader

**Files:**
- Create: `packages/codegen/src/deltas-registry.ts`
- Test: `packages/codegen/test/deltas-registry.test.ts`
- Modify: `packages/codegen/src/index.ts` (add exports)

**Interfaces:**
- Consumes (06a/06b): none directly; pure I/O + validation.
- Produces (06d/06f + later C6c tasks rely on this):
  - `interface DeltaRegistryEntry { file: string; collections: string[]; events: string[] }`
  - `interface DeltaRegistry { deltas: DeltaRegistryEntry[] }` — the on-disk shape of `movp.deltas.json` (locked in INTERFACES §"Project codegen: deltas + manifest").
  - `loadDeltaRegistry(path: string): Promise<DeltaRegistry>` — missing file → `{ deltas: [] }`; symlink / oversized / structurally-invalid → throws `Error` whose message starts with `invalid_deltas_registry`.
  - `saveDeltaRegistry(path: string, registry: DeltaRegistry): Promise<void>` — writes `JSON.stringify(registry, null, 2) + '\n'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/deltas-registry.test.ts
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDeltaRegistry, saveDeltaRegistry } from '../src/deltas-registry.ts'

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'movp-deltas-'))
}

describe('loadDeltaRegistry', () => {
  it('returns an empty registry when the file is absent', async () => {
    const d = await dir()
    expect(await loadDeltaRegistry(join(d, 'movp.deltas.json'))).toEqual({ deltas: [] })
  })

  it('loads and round-trips a valid registry', async () => {
    const d = await dir()
    const path = join(d, 'movp.deltas.json')
    const reg = { deltas: [{ file: '20260712000001_movp_generated_crm.sql', collections: ['deal'], events: ['deal.won'] }] }
    await saveDeltaRegistry(path, reg)
    expect(await loadDeltaRegistry(path)).toEqual(reg)
  })

  it('rejects a symlinked registry without reading its target', async () => {
    const d = await dir()
    const target = join(d, 'outside.json')
    await writeFile(target, JSON.stringify({ deltas: [] }))
    const path = join(d, 'movp.deltas.json')
    await symlink(target, path)
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry.*symlink/)
  })

  it('rejects a structurally invalid registry (deltas not an array)', async () => {
    const d = await dir()
    const path = join(d, 'movp.deltas.json')
    await writeFile(path, JSON.stringify({ deltas: 'nope' }))
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry/)
  })

  it('rejects an entry missing required fields', async () => {
    const d = await dir()
    const path = join(d, 'movp.deltas.json')
    await writeFile(path, JSON.stringify({ deltas: [{ file: 'x.sql' }] }))
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/deltas-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/deltas-registry.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/codegen/src/deltas-registry.ts
export interface DeltaRegistryEntry {
  file: string
  collections: string[]
  events: string[]
}

export interface DeltaRegistry {
  deltas: DeltaRegistryEntry[]
}

const MAX_REGISTRY_BYTES = 1 * 1024 * 1024

function fail(reason: string): never {
  // Never include file CONTENTS in diagnostics — path + reason only.
  throw new Error(`invalid_deltas_registry: ${reason}`)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function assertRegistry(value: unknown, path: string): asserts value is DeltaRegistry {
  if (typeof value !== 'object' || value === null) fail(`${path}: not an object`)
  const deltas = (value as { deltas?: unknown }).deltas
  if (!Array.isArray(deltas)) fail(`${path}: "deltas" must be an array`)
  for (const [i, entry] of deltas.entries()) {
    if (typeof entry !== 'object' || entry === null) fail(`${path}: deltas[${i}] not an object`)
    const e = entry as Record<string, unknown>
    if (typeof e.file !== 'string' || e.file.length === 0) fail(`${path}: deltas[${i}].file must be a non-empty string`)
    if (!isStringArray(e.collections)) fail(`${path}: deltas[${i}].collections must be a string[]`)
    if (!isStringArray(e.events)) fail(`${path}: deltas[${i}].events must be a string[]`)
  }
}

async function nodeFs() {
  return (await import('node:fs/promises')) as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    writeFile(path: string, contents: string): Promise<void>
  }
}

export async function loadDeltaRegistry(path: string): Promise<DeltaRegistry> {
  const f = await nodeFs()
  let info: Awaited<ReturnType<typeof f.lstat>>
  try {
    info = await f.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return { deltas: [] }
    throw error
  }
  // lstat-before-read: a symlinked registry could point outside the project.
  if (info.isSymbolicLink()) fail(`${path}: is a symlink`)
  if (!info.isFile()) fail(`${path}: not a regular file`)
  if (info.size > MAX_REGISTRY_BYTES) fail(`${path}: exceeds ${MAX_REGISTRY_BYTES} bytes`)
  const raw = await f.readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${path}: not valid JSON`)
  }
  assertRegistry(parsed, path)
  return parsed
}

export async function saveDeltaRegistry(path: string, registry: DeltaRegistry): Promise<void> {
  assertRegistry(registry, path)
  const f = await nodeFs()
  await f.writeFile(path, `${JSON.stringify(registry, null, 2)}\n`)
}
```

Add to `packages/codegen/src/index.ts`:

```ts
export {
  loadDeltaRegistry,
  saveDeltaRegistry,
  type DeltaRegistry,
  type DeltaRegistryEntry,
} from './deltas-registry.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/deltas-registry.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/deltas-registry.ts packages/codegen/test/deltas-registry.test.ts packages/codegen/src/index.ts
git commit -m "feat(codegen): C6c.1 validated movp.deltas.json registry loader"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/deltas-registry.test.ts` PASS (5). Symlink + malformed inputs throw `invalid_deltas_registry` with zero content leakage.

---

### Task 2: Project-scoped SQL emitters (reuse C6a layer-aware emitter) + prune guard

**Files:**
- Modify: `packages/codegen/src/emit-sql.ts` (add project wrappers only; C6a already made `emitCollectionSql`/`collectionMetadataSql` layer-aware — do NOT re-implement metadata emission)
- Test: `packages/codegen/test/emit-project-sql.test.ts`
- Modify: `packages/codegen/src/index.ts` (add exports)

**Interfaces:**
- Consumes (06a):
  - `schema.projectCollections: CollectionDef[]`; `CollectionDef.layer`.
  - **`emitCollectionSql(c)` / `collectionMetadataSql(c)` are already layer-aware** (C6a `2026-07-12-movp-stage-c-06a-platform-release.md`, Task 1): for a `c.layer === 'project'` collection they write `layer='project'` in BOTH the `movp_collections` and `movp_fields` upserts; for a `layer:'platform'`/absent-layer collection they stay byte-identical (no `layer` column, relying on the DB default). C6c REUSES this shared emitter and must not duplicate metadata emission.
- Produces:
  - `emitProjectMigration(schema, opts?): string` — emits ONLY `schema.projectCollections` (minus `opts.excludeCollections`) via the shared `emitCollectionSql`, plus owned event seeds; NO `emitSharedInfraSql()` (platform owns the metadata tables). Asserts every emitted collection is `layer==='project'` and throws `platform_row_delete_forbidden` otherwise (guard lives here, at the emit boundary).
  - `emitProjectDeltaSql(schema, owned): string` — project counterpart of `emitDeltaSql`, calling the shared `emitCollectionSql` for each owned project collection.
  - `emitProjectMetadataPrune(schema): string` — emits `delete ... where layer = 'project' and <key> not in (...)` for `movp_collections`/`movp_fields`, deleting ONLY stale project rows. Never emits an unguarded delete.

  (There is deliberately NO `emitProjectCollectionSql`: the shared, C6a layer-aware `emitCollectionSql` is the single source of per-collection DDL+metadata for both tiers — DRY.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/emit-project-sql.test.ts
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import {
  emitProjectMetadataPrune,
  emitProjectMigration,
} from '../src/emit-sql.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}

const platformNote: CollectionDef = {
  name: 'note',
  label: 'Note',
  labelPlural: 'Notes',
  workspaceScoped: true,
  layer: 'platform',
  fields: { body: { type: 'text', label: 'Body' } },
}

function projectSchema(collections: CollectionDef[]): MovpSchema {
  // 06a: projectCollections is the derived view codegen consumes.
  return { collections, events: [], projectCollections: collections, platformCollections: [] } as unknown as MovpSchema
}

describe('emitProjectMigration reuses the C6a layer-aware shared emitter', () => {
  it('emits project collections with layer=project metadata (via shared emitCollectionSql) and NO shared infra', () => {
    const sql = emitProjectMigration(projectSchema([deal]))
    // No emitSharedInfraSql(): the metadata tables belong to the platform bundle.
    expect(sql).not.toContain('create table if not exists public.movp_collections')
    expect(sql).toContain('create table if not exists public.deal (')
    // C6a's layer-aware shared emitter writes layer='project' for this collection.
    expect(sql).toContain("insert into public.movp_collections (name, label, label_plural, workspace_scoped, layer)")
    expect(sql).toContain("'deal', 'Deal', 'Deals', true, 'project'")
    expect(sql).toContain("insert into public.movp_fields (collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer)")
    expect(sql).toContain("'project')")
  })

  it('refuses to emit a platform-layer collection on the project path', () => {
    expect(() => emitProjectMigration(projectSchema([platformNote]))).toThrow(/platform_row_delete_forbidden/)
  })

  it('prune deletes only layer=project rows and lists current project keys', () => {
    const sql = emitProjectMetadataPrune(projectSchema([deal]))
    expect(sql).toContain("delete from public.movp_fields where layer = 'project'")
    expect(sql).toContain("delete from public.movp_collections where layer = 'project'")
    expect(sql).toContain("name not in ('deal')")
    // The guard clause is structural: platform rows can never match the predicate.
    expect(sql).not.toContain("layer = 'platform'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/emit-project-sql.test.ts`
Expected: FAIL — `emitProjectCollectionSql` (and siblings) not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/codegen/src/emit-sql.ts` (reuses existing private helpers `q`, `ident`, `eventCatalogSeedSql`, and the C6a layer-aware `emitCollectionSql` — do not duplicate metadata emission):

```ts
// --- C6c: project-scoped emitters. Project codegen owns layer='project' rows ONLY. ---

function assertProjectLayer(c: CollectionDef): void {
  // Emitting a project migration for a platform collection would let the prune below
  // delete a platform-owned row. Reject it hard at the emit boundary.
  if (c.layer !== 'project') throw new Error(`platform_row_delete_forbidden: collection "${c.name}" is layer="${c.layer}"`)
}

// Reuses the shared, C6a layer-aware emitCollectionSql: for a layer:'project'
// collection it already writes layer='project' in both metadata upserts. No
// duplicate emitter — the shared one is the single source of per-collection SQL.
export function emitProjectMigration(
  schema: MovpSchema,
  opts: { excludeCollections?: readonly string[]; excludeEvents?: readonly string[] } = {},
): string {
  const excludedCollections = new Set(opts.excludeCollections ?? [])
  const excludedEvents = new Set(opts.excludeEvents ?? [])
  const collections = schema.projectCollections.filter((c) => !excludedCollections.has(c.name))
  for (const c of collections) assertProjectLayer(c)
  const events = schema.events.filter((e) => !excludedEvents.has(e.key))
  // No emitSharedInfraSql(): the metadata tables are owned by the platform bundle.
  return `${HEADER}\n${collections.map(emitCollectionSql).join('\n')}\n${eventCatalogSeedSql(events)}`
}

export function emitProjectDeltaSql(
  schema: MovpSchema,
  owned: { collections?: readonly string[]; events?: readonly string[] },
): string {
  const collections = (owned.collections ?? []).map((name) => {
    const collection = schema.projectCollections.find((entry) => entry.name === name)
    if (!collection) throw new Error(`delta collection not registered: ${name}`)
    assertProjectLayer(collection)
    return emitCollectionSql(collection)
  })
  const eventKeys = new Set(owned.events ?? [])
  const events = schema.events.filter((event) => eventKeys.has(event.key))
  for (const key of owned.events ?? []) {
    if (!events.some((event) => event.key === key)) throw new Error(`delta event not registered: ${key}`)
  }
  return `${HEADER}\n${collections.join('\n')}\n${eventCatalogSeedSql(events)}`
}

export function emitProjectMetadataPrune(schema: MovpSchema): string {
  for (const c of schema.projectCollections) assertProjectLayer(c)
  const collectionNames = schema.projectCollections.map((c) => q(c.name)).sort()
  const fieldKeys = schema.projectCollections
    .flatMap((c) => Object.keys(c.fields).map((f) => `(${q(c.name)}, ${q(f)})`))
    .sort()
  const collectionList = collectionNames.length ? collectionNames.join(', ') : "''"
  const fieldList = fieldKeys.length ? fieldKeys.join(', ') : "(null, null)"
  // The `where layer = 'project'` clause is load-bearing: it makes it structurally
  // impossible to delete a platform-owned row, even if a key were miscomputed.
  return `
delete from public.movp_fields where layer = 'project' and (collection_name, name) not in (${fieldList});
delete from public.movp_collections where layer = 'project' and name not in (${collectionList});`
}
```

Add to `packages/codegen/src/index.ts`:

```ts
export {
  emitProjectDeltaSql,
  emitProjectMetadataPrune,
  emitProjectMigration,
} from './emit-sql.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/emit-project-sql.test.ts test/generate.test.ts`
Expected: PASS — 3 new tests + the existing 33 generate.test.ts cases still green (monorepo baseline byte-identical).

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/emit-sql.ts packages/codegen/test/emit-project-sql.test.ts packages/codegen/src/index.ts
git commit -m "feat(codegen): C6c.2 project-scoped emitters with layer=project + prune guard"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/emit-project-sql.test.ts test/generate.test.ts` PASS. A platform-layer collection on the project path throws `platform_row_delete_forbidden`; the prune's delete predicate always carries `layer = 'project'`.

---

### Task 3: Project-mode `generate()` — compare-before-write, no-delete, `new_generated_delta_required`

**Files:**
- Modify: `packages/codegen/src/generate.ts`
- Test: `packages/codegen/test/generate-project.test.ts`

**Interfaces:**
- Consumes (06a): `schema.projectCollections`. (06b): `generate` already has `schema`. (Task 1): `loadDeltaRegistry`, `DeltaRegistry`. (Task 2): `emitProjectMigration`, `emitProjectDeltaSql`.
- Produces:
  - `GenerateOptions` gains `deltasRegistryPath?: string` (presence ⇒ project mode) and `manifestPath?: string` / `generatorVersion?: string` (consumed in Task 5).
  - Project mode contract: baseline (`migrationName`, project-scoped) + every registry delta are **compare-before-write / fail-on-drift**; codegen **never deletes** a generated migration; a project collection with no owning registry entry (and not baseline-owned) → throw `new_generated_delta_required` with **ZERO** file writes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/generate-project.test.ts
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { generate } from '../src/generate.ts'
import { saveDeltaRegistry } from '../src/deltas-registry.ts'

const BASELINE = '20260712120000_movp_generated.sql'

function col(name: string): CollectionDef {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    workspaceScoped: true,
    layer: 'project',
    fields: { title: { type: 'text', label: 'Title' } },
  }
}

function projectSchema(collections: CollectionDef[]): MovpSchema {
  return { collections, events: [], projectCollections: collections, platformCollections: [] } as unknown as MovpSchema
}

async function scaffold(): Promise<{ root: string; migrationsDir: string; registryPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'movp-proj-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const registryPath = join(root, 'movp.deltas.json')
  await saveDeltaRegistry(registryPath, { deltas: [] })
  return { root, migrationsDir, registryPath }
}

function opts(s: MovpSchema, ctx: Awaited<ReturnType<typeof scaffold>>) {
  return { schema: s, migrationsDir: ctx.migrationsDir, migrationName: BASELINE, deltasRegistryPath: ctx.registryPath }
}

describe('generate() project mode', () => {
  it('bootstraps a project baseline and is byte-stable across two runs', async () => {
    const ctx = await scaffold()
    const s = projectSchema([col('deal')])
    await generate(opts(s, ctx))
    const first = await readFile(join(ctx.migrationsDir, BASELINE), 'utf8')
    await generate(opts(s, ctx))
    expect(await readFile(join(ctx.migrationsDir, BASELINE), 'utf8')).toBe(first)
  })

  it('never deletes a foreign generated migration', async () => {
    const ctx = await scaffold()
    await writeFile(join(ctx.migrationsDir, '20200101000000_movp_generated.sql'), '-- platform stream file')
    await generate(opts(projectSchema([col('deal')]), ctx))
    expect(await readdir(ctx.migrationsDir)).toContain('20200101000000_movp_generated.sql')
  })

  it('rejects an unowned new collection with new_generated_delta_required and zero writes', async () => {
    const ctx = await scaffold()
    await generate(opts(projectSchema([col('deal')]), ctx))
    const before = (await readdir(ctx.migrationsDir)).sort()
    // Add a collection with no owning delta entry: must reject, writing nothing new.
    await expect(generate(opts(projectSchema([col('deal'), col('company')]), ctx)))
      .rejects.toThrow(/new_generated_delta_required/)
    expect((await readdir(ctx.migrationsDir)).sort()).toEqual(before)
  })

  it('refuses to overwrite a drifted frozen baseline (zero writes)', async () => {
    const ctx = await scaffold()
    const s = projectSchema([col('deal')])
    await generate(opts(s, ctx))
    const path = join(ctx.migrationsDir, BASELINE)
    const tampered = `${await readFile(path, 'utf8')}\n-- drift`
    await writeFile(path, tampered)
    await expect(generate(opts(s, ctx))).rejects.toThrow(/new_generated_delta_required/)
    expect(await readFile(path, 'utf8')).toBe(tampered)
  })

  it('emits a registered delta and re-runs it byte-identically', async () => {
    const ctx = await scaffold()
    const s = projectSchema([col('deal'), col('company')])
    await saveDeltaRegistry(ctx.registryPath, {
      deltas: [{ file: '20260712130000_movp_generated_company.sql', collections: ['company'], events: [] }],
    })
    await generate(opts(s, ctx))
    const baseline = await readFile(join(ctx.migrationsDir, BASELINE), 'utf8')
    const delta = await readFile(join(ctx.migrationsDir, '20260712130000_movp_generated_company.sql'), 'utf8')
    expect(baseline).toContain('create table if not exists public.deal (')
    expect(baseline).not.toContain('create table if not exists public.company (')
    expect(delta).toContain('create table if not exists public.company (')
    await generate(opts(s, ctx))
    expect(await readFile(join(ctx.migrationsDir, '20260712130000_movp_generated_company.sql'), 'utf8')).toBe(delta)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/generate-project.test.ts`
Expected: FAIL — `deltasRegistryPath` unknown option; project mode not implemented.

- [ ] **Step 3: Write minimal implementation**

Modify `packages/codegen/src/generate.ts`. Extend the options and add a project branch at the TOP of `generate()`; the existing monorepo body is unchanged.

Add imports at the top:

```ts
import { emitProjectDeltaSql, emitProjectMigration } from './emit-sql.ts'
import { loadDeltaRegistry, type DeltaRegistryEntry } from './deltas-registry.ts'
```

Extend `GenerateOptions`:

```ts
export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
  schema?: MovpSchema
  deltasRegistryPath?: string
  manifestPath?: string
  generatorVersion?: string
}
```

At the very start of `generate()`:

```ts
export async function generate(
  options: GenerateOptions = {},
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  if (options.deltasRegistryPath !== undefined) return generateProject(options)
  // ...existing monorepo body unchanged...
```

Add the project implementation:

```ts
function projectOwnedByDeltas(deltas: readonly DeltaRegistryEntry[]): { collections: Set<string>; events: Set<string> } {
  return {
    collections: new Set(deltas.flatMap((d) => d.collections)),
    events: new Set(deltas.flatMap((d) => d.events)),
  }
}

// Project mode: the platform migration stream is materialized ahead of these files
// and is immutable. Project codegen owns ONLY layer='project' objects, and it does
// so as forward-only files: compute every expected body, compare all existing files,
// and write nothing if any frozen file drifted or a collection has no owner.
async function generateProject(
  options: GenerateOptions,
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  const schema = options.schema
  if (!schema) throw new Error('generate(project): options.schema is required')
  const registryPath = options.deltasRegistryPath
  if (registryPath === undefined) throw new Error('generate(project): deltasRegistryPath is required')

  const migrationsDir = options.migrationsDir
  if (!migrationsDir) throw new Error('generate(project): migrationsDir is required')
  const migrationName = migrationFileName(
    options.migrationName ?? '20260712120000_movp_generated.sql',
    'generated baseline',
  )

  const registry = await loadDeltaRegistry(registryPath)
  const deltaFiles = registry.deltas.map((d) => migrationFileName(d.file, 'generated delta'))
  if (new Set(deltaFiles).size !== deltaFiles.length) throw new Error('duplicate generated delta filename')

  const owned = projectOwnedByDeltas(registry.deltas)

  // Any project collection not owned by a registry delta belongs to the frozen
  // baseline. If the baseline body would change, that collection needs a new delta.
  const baselineSql = emitProjectMigration(schema, {
    excludeCollections: [...owned.collections],
    excludeEvents: [...owned.events],
  })

  // Build the full set of (path, expected) pairs BEFORE any write.
  const planned: { path: string; expected: string }[] = [
    { path: joinPath(migrationsDir, migrationName), expected: baselineSql },
  ]
  for (const delta of registry.deltas) {
    planned.push({
      path: joinPath(migrationsDir, delta.file),
      expected: emitProjectDeltaSql(schema, { collections: delta.collections, events: delta.events }),
    })
  }

  const f = await fs()
  await f.mkdir(migrationsDir, { recursive: true })

  // COMPARE-BEFORE-WRITE, never overwrite an applied (present) delta. Collect the
  // set of files that must be created; if ANY present file differs, throw with zero writes.
  const toWrite: { path: string; expected: string }[] = []
  for (const item of planned) {
    const existing = await readIfPresent(f, item.path)
    if (existing === null) {
      toWrite.push(item)
    } else if (existing !== item.expected) {
      throw new Error(
        `new_generated_delta_required: ${item.path} is frozen but the current project schema emits different SQL. ` +
          'A project collection/event changed without an owning movp.deltas.json entry. Run `movp new-delta <name>` to allocate one.',
      )
    }
  }

  // NEVER delete generated migrations in project mode (unlike the monorepo cleanup).
  for (const item of toWrite) {
    await assertSafeWriteTarget(f, item.path, 'generated migration')
    await f.writeFile(item.path, item.expected)
  }

  return {
    migrationPath: joinPath(migrationsDir, migrationName),
    typesPath: '',
    deltaPaths: registry.deltas.map((d) => joinPath(migrationsDir, d.file)),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/generate-project.test.ts test/generate.test.ts`
Expected: PASS — 5 new project tests + 33 monorepo tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/generate.ts packages/codegen/test/generate-project.test.ts
git commit -m "feat(codegen): C6c.3 immutable project-mode generate (compare-before-write, no-delete)"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/generate-project.test.ts test/generate.test.ts` PASS. Unowned collection + drifted baseline both throw `new_generated_delta_required` and the `readdir` before/after assertion proves zero writes; a foreign `*_movp_generated.sql` survives.

---

### Task 4: `movp new-delta <name>` — allocate ownership + emit exactly one additive migration

**Files:**
- Create: `packages/codegen/src/new-delta.ts`
- Modify: `packages/codegen/src/index.ts`
- Modify: `packages/cli/src/program.ts` (register the `new-delta` command)
- Test: `packages/codegen/test/new-delta.test.ts`

**Interfaces:**
- Consumes (06a): `schema.projectCollections`. (Task 1): `loadDeltaRegistry` / `saveDeltaRegistry` / `DeltaRegistry`. (Task 2): `emitProjectDeltaSql`. (Task 3): `generate` project mode.
- Produces:
  - `newDelta(o: { schema: MovpSchema; name: string; registryPath: string; migrationsDir: string; timestamp?: string }): Promise<{ file: string; collections: string[]; events: string[] }>` — computes the currently-unowned project collections (present in `schema.projectCollections` but in no registry entry), appends `{ file: '<ts>_movp_generated_<name>.sql', collections, events: [] }` to `movp.deltas.json`, and writes **exactly one** additive migration. Throws `nothing_to_allocate` if no unowned collection exists.
  - CLI: `movp new-delta <name>` invokes `newDelta` and prints the created file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/new-delta.test.ts
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { newDelta } from '../src/new-delta.ts'
import { generate } from '../src/generate.ts'
import { loadDeltaRegistry, saveDeltaRegistry } from '../src/deltas-registry.ts'

const BASELINE = '20260712120000_movp_generated.sql'

function col(name: string): CollectionDef {
  return { name, label: name, labelPlural: `${name}s`, workspaceScoped: true, layer: 'project', fields: { title: { type: 'text', label: 'Title' } } }
}
function projectSchema(cs: CollectionDef[]): MovpSchema {
  return { collections: cs, events: [], projectCollections: cs, platformCollections: [] } as unknown as MovpSchema
}

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'movp-newdelta-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const registryPath = join(root, 'movp.deltas.json')
  await saveDeltaRegistry(registryPath, { deltas: [] })
  return { migrationsDir, registryPath }
}

describe('newDelta', () => {
  it('allocates unowned collections and adds exactly one additive migration that makes generate clean', async () => {
    const ctx = await scaffold()
    await generate({ schema: projectSchema([col('deal')]), migrationsDir: ctx.migrationsDir, migrationName: BASELINE, deltasRegistryPath: ctx.registryPath })
    const before = (await readdir(ctx.migrationsDir)).sort()

    const s = projectSchema([col('deal'), col('company')])
    const created = await newDelta({ schema: s, name: 'company', registryPath: ctx.registryPath, migrationsDir: ctx.migrationsDir, timestamp: '20260712130000' })
    expect(created).toEqual({ file: '20260712130000_movp_generated_company.sql', collections: ['company'], events: [] })

    const after = (await readdir(ctx.migrationsDir)).sort()
    expect(after.filter((f) => !before.includes(f))).toEqual(['20260712130000_movp_generated_company.sql'])
    expect(await readFile(join(ctx.migrationsDir, created.file), 'utf8')).toContain('create table if not exists public.company (')

    // Registry now owns company; a follow-up generate is clean and writes nothing new.
    expect((await loadDeltaRegistry(ctx.registryPath)).deltas).toHaveLength(1)
    await generate({ schema: s, migrationsDir: ctx.migrationsDir, migrationName: BASELINE, deltasRegistryPath: ctx.registryPath })
    expect((await readdir(ctx.migrationsDir)).sort()).toEqual(after)
  })

  it('throws when there is nothing unowned to allocate', async () => {
    const ctx = await scaffold()
    const s = projectSchema([col('deal')])
    await generate({ schema: s, migrationsDir: ctx.migrationsDir, migrationName: BASELINE, deltasRegistryPath: ctx.registryPath })
    await expect(newDelta({ schema: s, name: 'noop', registryPath: ctx.registryPath, migrationsDir: ctx.migrationsDir, timestamp: '20260712140000' }))
      .rejects.toThrow(/nothing_to_allocate/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/new-delta.test.ts`
Expected: FAIL — `Cannot find module '../src/new-delta.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/codegen/src/new-delta.ts
import type { MovpSchema } from '@movp/core-schema'
import { emitProjectDeltaSql } from './emit-sql.ts'
import { loadDeltaRegistry, saveDeltaRegistry } from './deltas-registry.ts'

const TIMESTAMP = /^\d{14}$/
const NAME = /^[a-z][a-z0-9_]*$/

export interface NewDeltaOptions {
  schema: MovpSchema
  name: string
  registryPath: string
  migrationsDir: string
  timestamp?: string
}

function utcTimestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

async function nodeFs() {
  return (await import('node:fs/promises')) as {
    lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
    writeFile(path: string, contents: string): Promise<void>
  }
}

export async function newDelta(
  o: NewDeltaOptions,
): Promise<{ file: string; collections: string[]; events: string[] }> {
  if (!NAME.test(o.name)) throw new Error(`invalid delta name: ${o.name}`)
  const timestamp = o.timestamp ?? utcTimestamp()
  if (!TIMESTAMP.test(timestamp)) throw new Error(`invalid delta timestamp: ${timestamp}`)

  const registry = await loadDeltaRegistry(o.registryPath)
  const owned = new Set(registry.deltas.flatMap((d) => d.collections))
  const collections = o.schema.projectCollections.map((c) => c.name).filter((name) => !owned.has(name))
  if (collections.length === 0) throw new Error(`nothing_to_allocate: no unowned project collection for delta "${o.name}"`)

  const file = `${timestamp}_movp_generated_${o.name}.sql`
  if (registry.deltas.some((d) => d.file === file)) throw new Error(`delta file already registered: ${file}`)

  const events: string[] = []
  const body = emitProjectDeltaSql(o.schema, { collections, events })

  const migrationPath = `${o.migrationsDir}/${file}`.replace(/\/+/g, '/')
  const f = await nodeFs()
  // lstat-before-write: refuse to follow a symlink planted at the target path.
  try {
    if ((await f.lstat(migrationPath)).isSymbolicLink()) throw new Error(`generated migration is a symlink: ${migrationPath}`)
  } catch (error: unknown) {
    const missing = typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
    if (!missing) throw error
  }

  // Persist ownership FIRST so a crash mid-write cannot leave an unowned migration.
  await saveDeltaRegistry(o.registryPath, { deltas: [...registry.deltas, { file, collections, events }] })
  await f.writeFile(migrationPath, body)
  return { file, collections, events }
}
```

Add to `packages/codegen/src/index.ts`:

```ts
export { newDelta, type NewDeltaOptions } from './new-delta.ts'
```

Wire the CLI in `packages/cli/src/program.ts`. Add inside `buildProgram`, alongside the other command registrations (the CLI already receives the loaded `schema` per 06b; use it here). The command resolves paths relative to `process.cwd()`:

```ts
program
  .command('new-delta <name>')
  .description('Allocate a codegen delta for new project (layer=project) collections and emit one additive migration')
  .action(async (name: string) => {
    const { newDelta } = await import('@movp/codegen')
    const cwd = process.cwd()
    const created = await newDelta({
      schema, // the loaded MovpSchema passed into buildProgram (06b)
      name,
      registryPath: `${cwd}/movp.deltas.json`,
      migrationsDir: `${cwd}/supabase/migrations`,
    })
    out(`registered delta ${created.file} owning collections: ${created.collections.join(', ')}`)
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/new-delta.test.ts && pnpm --filter @movp/cli exec vitest run`
Expected: PASS — 2 new codegen tests; CLI suite still green.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/new-delta.ts packages/codegen/src/index.ts packages/cli/src/program.ts packages/codegen/test/new-delta.test.ts
git commit -m "feat(codegen): C6c.4 movp new-delta allocates ownership + one additive migration"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/new-delta.test.ts` PASS. After `newDelta`, `readdir` diff is exactly one file and a follow-up `generate` writes nothing (byte-stable); an already-owned schema throws `nothing_to_allocate`.

---

### Task 5: `movp.schema.json` manifest emitter

**Files:**
- Create: `packages/codegen/src/emit-manifest.ts`
- Modify: `packages/codegen/src/generate.ts` (write the manifest in project mode when `manifestPath` is set)
- Modify: `packages/codegen/src/index.ts`
- Test: `packages/codegen/test/emit-manifest.test.ts`

**Interfaces:**
- Consumes (06b): `schemaFingerprint(schema)` from `@movp/core-schema`. (06a): `CollectionDef.layer`, `schema.collections`.
- Produces (locked shape, INTERFACES §"Project codegen"):
  - `interface SchemaManifest { manifestVersion: 1; generatorVersion: string; schemaFingerprint: string; collections: ManifestCollection[] }`
  - `interface ManifestCollection { name: string; internal: boolean; label: string; workspaceScoped: boolean; layer: 'platform' | 'project'; fields: ManifestField[] }`
  - `interface ManifestField { name: string; type: string; label: string; cardinality: string | null; reporting_role: string | null; searchable: boolean; embeddable: boolean }`
  - `emitManifest(schema: MovpSchema, o: { generatorVersion: string }): SchemaManifest` — deterministic (collections by `name`, fields by `name`); `schemaFingerprint === schemaFingerprint(schema)`.
  - `serializeManifest(manifest: SchemaManifest): string` — `JSON.stringify(manifest, null, 2) + '\n'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/emit-manifest.test.ts
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { schemaFingerprint } from '@movp/core-schema'
import { emitManifest, serializeManifest } from '../src/emit-manifest.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  internal: false,
  fields: {
    title: { type: 'text', label: 'Title', searchable: true },
    amount: { type: 'number', label: 'Amount', reporting: { role: 'measure' } },
  },
}

function schema(cs: CollectionDef[]): MovpSchema {
  return { collections: cs, events: [], projectCollections: cs, platformCollections: [] } as unknown as MovpSchema
}

describe('emitManifest', () => {
  it('produces the locked shape with fingerprint from 06b and deterministic ordering', () => {
    const s = schema([deal])
    const m = emitManifest(s, { generatorVersion: '0.1.0' })
    expect(m.manifestVersion).toBe(1)
    expect(m.generatorVersion).toBe('0.1.0')
    expect(m.schemaFingerprint).toBe(schemaFingerprint(s))
    expect(m.collections).toEqual([
      {
        name: 'deal',
        internal: false,
        label: 'Deal',
        workspaceScoped: true,
        layer: 'project',
        fields: [
          { name: 'amount', type: 'number', label: 'Amount', cardinality: null, reporting_role: 'measure', searchable: false, embeddable: false },
          { name: 'title', type: 'text', label: 'Title', cardinality: null, reporting_role: null, searchable: true, embeddable: false },
        ],
      },
    ])
  })

  it('serializes deterministically with a trailing newline', () => {
    const s = schema([deal])
    const out = serializeManifest(emitManifest(s, { generatorVersion: '0.1.0' }))
    expect(out.endsWith('}\n')).toBe(true)
    expect(out).toBe(serializeManifest(emitManifest(s, { generatorVersion: '0.1.0' })))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/emit-manifest.test.ts`
Expected: FAIL — `Cannot find module '../src/emit-manifest.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/codegen/src/emit-manifest.ts
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { schemaFingerprint } from '@movp/core-schema'

export interface ManifestField {
  name: string
  type: string
  label: string
  cardinality: string | null
  reporting_role: string | null
  searchable: boolean
  embeddable: boolean
}

export interface ManifestCollection {
  name: string
  internal: boolean
  label: string
  workspaceScoped: boolean
  layer: 'platform' | 'project'
  fields: ManifestField[]
}

export interface SchemaManifest {
  manifestVersion: 1
  generatorVersion: string
  schemaFingerprint: string
  collections: ManifestCollection[]
}

function manifestCollection(c: CollectionDef): ManifestCollection {
  const fields: ManifestField[] = Object.entries(c.fields)
    .map(([name, field]) => ({
      name,
      type: field.type,
      label: field.label,
      cardinality: field.cardinality ?? null,
      reporting_role: field.reporting?.role ?? null,
      searchable: field.searchable === true,
      embeddable: field.embeddable === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    name: c.name,
    internal: c.internal === true,
    label: c.label,
    workspaceScoped: c.workspaceScoped,
    layer: c.layer,
    fields,
  }
}

export function emitManifest(schema: MovpSchema, o: { generatorVersion: string }): SchemaManifest {
  const collections = schema.collections
    .map(manifestCollection)
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    manifestVersion: 1,
    generatorVersion: o.generatorVersion,
    // Serialized here, DEFINED in 06b — runtime + manifest agree by construction.
    schemaFingerprint: schemaFingerprint(schema),
    collections,
  }
}

export function serializeManifest(manifest: SchemaManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
```

Wire into project mode. In `generate.ts` `generateProject`, resolve `generatorVersion` and write the manifest when `manifestPath` is set. Add near the imports:

```ts
import { emitManifest, serializeManifest } from './emit-manifest.ts'
```

Add a resolver (reads the codegen package version deterministically; project mode value flows into the manifest):

```ts
async function resolveGeneratorVersion(explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit
  const url = new URL('../package.json', import.meta.url)
  const f = await fs()
  const raw = await f.readFile(decodeURIComponent(url.pathname), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof (parsed as { version: unknown }).version === 'string') {
    return (parsed as { version: string }).version
  }
  throw new Error('cannot resolve @movp/codegen version for manifest')
}
```

In `generateProject`, after the write loop and before `return`:

```ts
  if (options.manifestPath !== undefined) {
    const generatorVersion = await resolveGeneratorVersion(options.generatorVersion)
    await assertSafeWriteTarget(f, options.manifestPath, 'schema manifest')
    await f.writeFile(options.manifestPath, serializeManifest(emitManifest(schema, { generatorVersion })))
  }
```

Add to `packages/codegen/src/index.ts`:

```ts
export {
  emitManifest,
  serializeManifest,
  type ManifestCollection,
  type ManifestField,
  type SchemaManifest,
} from './emit-manifest.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/emit-manifest.test.ts test/generate-project.test.ts`
Expected: PASS — 2 manifest tests + Task 3 project tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/emit-manifest.ts packages/codegen/src/generate.ts packages/codegen/src/index.ts packages/codegen/test/emit-manifest.test.ts
git commit -m "feat(codegen): C6c.5 movp.schema.json manifest emitter (fingerprint from 06b)"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/emit-manifest.test.ts` PASS. `m.schemaFingerprint === schemaFingerprint(s)` asserted; serialization deterministic + trailing newline.

---

### Task 6: DB↔schema metadata consistency gate (pure comparator + stable error ids)

**Files:**
- Create: `packages/codegen/src/metadata-consistency.ts`
- Create: `scripts/check-metadata-consistency.ts` (DB wiring for the `db reset` gate)
- Modify: `packages/codegen/src/index.ts`
- Test: `packages/codegen/test/metadata-consistency.test.ts`

**Interfaces:**
- Consumes (06b): `metadataProjection(schema): { collections: CollectionMeta[]; fields: FieldMeta[] }` from `@movp/core-schema`, where `CollectionMeta = { name, label, label_plural, workspace_scoped, layer }` and `FieldMeta = { collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer }`.
- Produces (06f consumes this comparator for its docs-consistency gate):
  - `interface MetadataDbState { collections: CollectionMeta[]; fields: FieldMeta[] }` (same field names as the projection — the DB query aliases columns to match).
  - `type MetadataConsistencyCode = 'missing_metadata_row' | 'altered_metadata_row' | 'stale_metadata_row'`
  - `class MetadataConsistencyError extends Error { readonly code: MetadataConsistencyCode; readonly detail: string }` — `detail` names the offending collection/field KEY and the differing column NAME only (never a value; obs content discipline).
  - `checkMetadataConsistency(schema: MovpSchema, db: MetadataDbState): void` — throws the first violation; missing (in projection, not in DB), altered (key present, a compared column differs), stale/extra (in DB, not in projection).

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/metadata-consistency.test.ts
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { metadataProjection } from '@movp/core-schema'
import { checkMetadataConsistency, type MetadataDbState } from '../src/metadata-consistency.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}

function schema(cs: CollectionDef[]): MovpSchema {
  return { collections: cs, events: [], projectCollections: cs, platformCollections: [] } as unknown as MovpSchema
}

function dbFrom(s: MovpSchema): MetadataDbState {
  const p = metadataProjection(s)
  return { collections: p.collections.map((c) => ({ ...c })), fields: p.fields.map((f) => ({ ...f })) }
}

describe('checkMetadataConsistency', () => {
  it('passes when the DB matches the projection exactly', () => {
    const s = schema([deal])
    expect(() => checkMetadataConsistency(s, dbFrom(s))).not.toThrow()
  })

  it('fails missing_metadata_row when a projected row is absent from the DB', () => {
    const s = schema([deal])
    const db = dbFrom(s)
    db.fields = db.fields.filter((f) => f.name !== 'title')
    expect(() => checkMetadataConsistency(s, db)).toThrow(/missing_metadata_row/)
  })

  it('fails altered_metadata_row when a compared column differs', () => {
    const s = schema([deal])
    const db = dbFrom(s)
    db.collections[0].label = 'Deals!!'
    expect(() => checkMetadataConsistency(s, db)).toThrow(/altered_metadata_row/)
  })

  it('fails stale_metadata_row when the DB has an extra row', () => {
    const s = schema([deal])
    const db = dbFrom(s)
    db.fields.push({ collection_name: 'deal', name: 'ghost', type: 'text', label: 'Ghost', cardinality: null, reporting_role: null, searchable: false, embeddable: false, layer: 'project' })
    expect(() => checkMetadataConsistency(s, db)).toThrow(/stale_metadata_row/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/metadata-consistency.test.ts`
Expected: FAIL — `Cannot find module '../src/metadata-consistency.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/codegen/src/metadata-consistency.ts
import type { MovpSchema } from '@movp/core-schema'
import { metadataProjection } from '@movp/core-schema'

type Projection = ReturnType<typeof metadataProjection>
type CollectionMeta = Projection['collections'][number]
type FieldMeta = Projection['fields'][number]

export interface MetadataDbState {
  collections: CollectionMeta[]
  fields: FieldMeta[]
}

export type MetadataConsistencyCode = 'missing_metadata_row' | 'altered_metadata_row' | 'stale_metadata_row'

export class MetadataConsistencyError extends Error {
  constructor(
    readonly code: MetadataConsistencyCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'MetadataConsistencyError'
  }
}

function index<T extends Record<string, unknown>>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) map.set(key(row), row)
  return map
}

// Compare only the projection columns. `detail` carries KEYS and the differing
// COLUMN NAME, never a row value — these are schema identifiers, kept disciplined.
function diffColumns<T extends Record<string, unknown>>(expected: T, actual: T, columns: readonly (keyof T)[]): string | null {
  for (const col of columns) {
    if (expected[col] !== actual[col]) return String(col)
  }
  return null
}

const COLLECTION_COLUMNS = ['name', 'label', 'label_plural', 'workspace_scoped', 'layer'] as const
const FIELD_COLUMNS = ['collection_name', 'name', 'type', 'label', 'cardinality', 'reporting_role', 'searchable', 'embeddable', 'layer'] as const

export function checkMetadataConsistency(schema: MovpSchema, db: MetadataDbState): void {
  const projection = metadataProjection(schema)

  const expectedCollections = index(projection.collections, (c) => c.name)
  const actualCollections = index(db.collections, (c) => c.name)
  for (const [name, expected] of expectedCollections) {
    const actual = actualCollections.get(name)
    if (!actual) throw new MetadataConsistencyError('missing_metadata_row', `collection "${name}"`)
    const differing = diffColumns(expected, actual, COLLECTION_COLUMNS)
    if (differing) throw new MetadataConsistencyError('altered_metadata_row', `collection "${name}" column "${differing}"`)
  }
  for (const name of actualCollections.keys()) {
    if (!expectedCollections.has(name)) throw new MetadataConsistencyError('stale_metadata_row', `collection "${name}"`)
  }

  const fieldKey = (f: FieldMeta): string => `${f.collection_name}.${f.name}`
  const expectedFields = index(projection.fields, fieldKey)
  const actualFields = index(db.fields, fieldKey)
  for (const [key, expected] of expectedFields) {
    const actual = actualFields.get(key)
    if (!actual) throw new MetadataConsistencyError('missing_metadata_row', `field "${key}"`)
    const differing = diffColumns(expected, actual, FIELD_COLUMNS)
    if (differing) throw new MetadataConsistencyError('altered_metadata_row', `field "${key}" column "${differing}"`)
  }
  for (const key of actualFields.keys()) {
    if (!expectedFields.has(key)) throw new MetadataConsistencyError('stale_metadata_row', `field "${key}"`)
  }
}
```

Create `scripts/check-metadata-consistency.ts` (the `db reset` gate wiring — queries the local DB, aliasing columns to the projection field names, and delegates to the pure comparator). This is not a Vitest target; it is run against a reset DB:

```ts
// scripts/check-metadata-consistency.ts
// Run AFTER `supabase db reset`: asserts movp_collections/movp_fields match the schema
// projection. Exits non-zero with the stable error code on any drift.
import { Client } from 'pg'
import { schema } from '@movp/core-schema'
import { checkMetadataConsistency, MetadataConsistencyError, type MetadataDbState } from '@movp/codegen'

const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:64322/postgres'

async function main(): Promise<void> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  try {
    const collections = await client.query('select name, label, label_plural, workspace_scoped, layer from public.movp_collections')
    const fields = await client.query('select collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer from public.movp_fields')
    const db: MetadataDbState = { collections: collections.rows, fields: fields.rows }
    checkMetadataConsistency(schema, db)
    console.log('metadata consistency: OK')
  } catch (error: unknown) {
    if (error instanceof MetadataConsistencyError) {
      console.error(`metadata consistency FAILED [${error.code}]: ${error.detail}`)
      process.exit(1)
    }
    throw error
  } finally {
    await client.end()
  }
}

await main()
```

> **Note for the executor:** `pg` is already a repo dependency (used by existing DB gates — verify with `pnpm why pg`). If `pnpm why pg` reports it absent, STOP and ask before adding it (no new dependencies without approval). The port `64322` matches this repo's isolated local Supabase DB port (CLAUDE.md "Supabase Local Stack Hygiene").

Add to `packages/codegen/src/index.ts`:

```ts
export {
  checkMetadataConsistency,
  MetadataConsistencyError,
  type MetadataConsistencyCode,
  type MetadataDbState,
} from './metadata-consistency.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/metadata-consistency.test.ts`
Expected: PASS — 4 tests (pass / missing / altered / stale).

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/metadata-consistency.ts scripts/check-metadata-consistency.ts packages/codegen/src/index.ts packages/codegen/test/metadata-consistency.test.ts
git commit -m "feat(codegen): C6c.6 metadata consistency gate with stable error ids"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/metadata-consistency.test.ts` PASS. Each of missing / altered / stale raises its distinct stable code; `detail` contains only keys + column names.

---

### Task 7: End-to-end project-codegen slice (acceptance gate)

**Files:**
- Create: `packages/codegen/test/project-codegen-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6 (`generate` project mode, `newDelta`, `emitManifest`, `checkMetadataConsistency`, `loadDeltaRegistry`).
- Produces: no new API — this is the C6c acceptance gate exercised without a live DB (the DB assertion is fed a projection-derived `MetadataDbState`, which the Task 6 script materializes for real in CI).

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/project-codegen-e2e.test.ts
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { metadataProjection } from '@movp/core-schema'
import { generate } from '../src/generate.ts'
import { newDelta } from '../src/new-delta.ts'
import { saveDeltaRegistry } from '../src/deltas-registry.ts'
import { checkMetadataConsistency, type MetadataDbState } from '../src/metadata-consistency.ts'
import { emitManifest } from '../src/emit-manifest.ts'

const BASELINE = '20260712120000_movp_generated.sql'
const MANIFEST = 'movp.schema.json'

function col(name: string): CollectionDef {
  return { name, label: name, labelPlural: `${name}s`, workspaceScoped: true, layer: 'project', fields: { title: { type: 'text', label: 'Title' } } }
}
function schema(cs: CollectionDef[]): MovpSchema {
  return { collections: cs, events: [], projectCollections: cs, platformCollections: [] } as unknown as MovpSchema
}
function dbFrom(s: MovpSchema): MetadataDbState {
  const p = metadataProjection(s)
  return { collections: p.collections.map((c) => ({ ...c })), fields: p.fields.map((f) => ({ ...f })) }
}

describe('C6c acceptance: scaffold -> add collection -> regenerate', () => {
  it('keeps baseline + prior deltas byte-identical, adds exactly one migration, and stays consistent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'movp-e2e-'))
    const migrationsDir = join(root, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    const registryPath = join(root, 'movp.deltas.json')
    const manifestPath = join(root, MANIFEST)
    await saveDeltaRegistry(registryPath, { deltas: [] })

    const base = (s: MovpSchema) => ({ schema: s, migrationsDir, migrationName: BASELINE, deltasRegistryPath: registryPath, manifestPath })

    // 1) scaffold codegen
    const s1 = schema([col('deal')])
    await generate(base(s1))
    const baselineV1 = await readFile(join(migrationsDir, BASELINE), 'utf8')
    checkMetadataConsistency(s1, dbFrom(s1))

    // 2) add a collection WITHOUT a delta -> rejected, zero writes
    const s2 = schema([col('deal'), col('company')])
    const before = (await readdir(migrationsDir)).sort()
    await expect(generate(base(s2))).rejects.toThrow(/new_generated_delta_required/)
    expect((await readdir(migrationsDir)).sort()).toEqual(before)

    // 3) allocate + regenerate -> baseline byte-identical, exactly one new migration
    await newDelta({ schema: s2, name: 'company', registryPath, migrationsDir, timestamp: '20260712130000' })
    await generate(base(s2))
    expect(await readFile(join(migrationsDir, BASELINE), 'utf8')).toBe(baselineV1)
    const after = (await readdir(migrationsDir)).sort()
    expect(after.filter((f) => !before.includes(f))).toEqual(['20260712130000_movp_generated_company.sql'])

    // 4) manifest reflects both collections; consistency still holds
    const manifest = emitManifest(s2, { generatorVersion: '0.1.0' })
    expect(manifest.collections.map((c) => c.name)).toEqual(['company', 'deal'])
    checkMetadataConsistency(s2, dbFrom(s2))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/project-codegen-e2e.test.ts`
Expected: FAIL first if any Task 1–6 symbol is missing; once all land, this documents the full gate.

- [ ] **Step 3: Write minimal implementation**

No new implementation — Tasks 1–6 satisfy this slice. If a step fails, fix the owning task, not this test.

- [ ] **Step 4: Run the full codegen suite**

Run: `pnpm --filter @movp/codegen exec vitest run`
Expected: PASS — all C6c tests + the 33 pre-existing `generate.test.ts` cases. Then `pnpm --filter @movp/codegen exec tsc --noEmit` Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/test/project-codegen-e2e.test.ts
git commit -m "test(codegen): C6c.7 end-to-end project-codegen acceptance slice"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run && pnpm --filter @movp/codegen exec tsc --noEmit` both clean. The slice proves: unowned change rejected with zero writes; after `new-delta` the baseline is byte-identical and exactly one migration was added; manifest + consistency hold.

---

## Self-Review

**Spec coverage:** Immutable deltas / compare-before-write / no-delete (Task 3); project-local `movp.deltas.json` (Task 1); `new_generated_delta_required` + zero writes (Task 3, 7); `movp new-delta` one additive migration (Task 4); `layer='project'`-only emit + prune + `platform_row_delete_forbidden` (Task 2); manifest exact shape + `schemaFingerprint` from 06b (Task 5); consistency gate with missing/altered/stale stable ids (Task 6); acceptance slice (Task 7). Forward-only guard: the monorepo `scripts/check-forward-only-migrations.mjs` is reused by scaffolds (06d ships it); C6c's byte-stability gates (Tasks 3/7) are the codegen-side enforcement.

**Type consistency:** `DeltaRegistry`/`DeltaRegistryEntry`, `SchemaManifest`/`ManifestCollection`/`ManifestField`, `MetadataDbState`/`MetadataConsistencyCode` used identically across tasks. `generate` project branch keyed on `deltasRegistryPath`; `emitProjectMigration`/`emitProjectDeltaSql` names match between Task 2 and Task 3.

**Assumptions (flag to the caller):**
1. 06a exposes `schema.projectCollections`/`schema.platformCollections` and `CollectionDef.layer`; test fixtures cast a literal to `MovpSchema` — replace with the real `defineSchema({ extends, ... })` builder once 06a lands.
2. 06b exports `metadataProjection` and `schemaFingerprint` from `@movp/core-schema` with the field names used here.
3. Event-layer ownership: events are owned purely via `movp.deltas.json` entries (no `schema.projectEvents` view is assumed); the ownership check is collection-driven (matching the C6c gate "add a collection"). If 06a adds a project-events view, extend Task 3's ownership set accordingly.
4. `pg` is an existing repo dependency for the Task 6 DB script; the executor verifies with `pnpm why pg` and stops if absent.
