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
- **F1 atomic safe-write (INTERFACES round 2) — ONE shared helper for EVERY generated artifact.** `packages/codegen/src/safe-write.ts` exports `atomicWriteFile(path, contents, opts?)`; `movp.deltas.json`, `movp.schema.json`, and every project-mode generated migration write THROUGH it — no call site does its own `writeFile`. It closes two gaps in the naive `lstat`-then-`writeFile({mode})`: (1) TOCTOU — a symlink swapped in AFTER the lstat is then followed by `writeFile`; (2) `writeFile({mode})` does NOT chmod an ALREADY-EXISTING file (a pre-existing `0o644` registry stays `0o644`). Mechanism: write bytes to a sibling `<path>.<rand>.tmp` created with EXCLUSIVE `flag: 'wx'` + `mode: 0o600`; `lstat` the destination and refuse a symlink / non-regular target; `rename` the temp over the destination (atomic on one filesystem; `rename` replaces the destination inode — it never follows or writes through a symlink there, and the renamed file carries the temp's `0o600`); on ANY error `unlink` the temp.
- **Stable error codes** (exact strings, cross-part): `new_generated_delta_required`, `platform_row_delete_forbidden`. C6c-local consistency codes: `missing_metadata_row`, `altered_metadata_row`, `stale_metadata_row`, `invalid_deltas_registry`. Generator-version read failures use `generator_version_unreadable`, `generator_version_symlink_rejected`, `generator_version_not_regular_file`, `generator_version_too_large`, `generator_version_invalid_json`, or `generator_version_invalid_shape`; errors name the path and reason, never file contents.
- **Determinism:** manifest collections ordered by `name`, fields by `name`; JSON serialized as `JSON.stringify(x, null, 2) + '\n'`.
- **After every change run the affected Vitest file and show output; commit per task.**

---

## File map

- Create `packages/codegen/src/safe-write.ts` — the ONE shared `atomicWriteFile` helper (F1, Task 1).
- Create `packages/codegen/src/deltas-registry.ts` — `movp.deltas.json` types + validated loader (Task 1).
- Modify `packages/codegen/src/emit-sql.ts` — add project-scoped emitters (Task 2).
- Modify `packages/codegen/src/generate.ts` — add project-mode branch keyed on `deltasRegistryPath` (Task 3).
- Create `packages/codegen/src/new-delta.ts` — allocate ownership + emit one additive migration (Task 4); wire `@movp/cli`.
- Create `packages/codegen/src/emit-manifest.ts` — `movp.schema.json` emitter (Task 5).
- Create `packages/codegen/src/metadata-consistency.ts` — pure DB↔schema comparator (Task 6); `scripts/check-metadata-consistency.ts` psql wiring (Task 6).
- Create `packages/codegen/test/*.test.ts` per task; integration slice `packages/codegen/test/project-codegen-e2e.test.ts` (Task 7).
- Create `scripts/gate-metadata-consistency.sh` + `.github/workflows/ci.yml` `metadata-consistency` job — the live DB-reset consistency gate (Task 8, F7).
- Extend `packages/codegen/src/index.ts` exports as each symbol lands.

---

### Task 1: Validated `movp.deltas.json` delta registry loader

**Files:**
- Create: `packages/codegen/src/safe-write.ts` (the shared `atomicWriteFile` helper — F1)
- Create: `packages/codegen/src/deltas-registry.ts`
- Test: `packages/codegen/test/deltas-registry.test.ts`
- Modify: `packages/codegen/src/index.ts` (add exports)

**Interfaces:**
- Consumes (06a/06b): none directly; pure I/O + validation.
- Produces (F1 shared helper, reused by Tasks 3/4/5):
  - `atomicWriteFile(path: string, contents: string, opts?: { onRefuse?: (reason: string) => never }): Promise<void>` — writes `contents` to a sibling `0o600` temp with EXCLUSIVE creation, `lstat`-refuses a symlink / non-regular destination, then `rename`s the temp over the destination (atomic; re-chmods a pre-existing `0o644` file to `0o600`; never follows a symlink). `onRefuse` maps the refusal to a caller-specific error (e.g. `invalid_deltas_registry`); it defaults to a generic `safe_write_refused` throw.
- Produces (06d/06f + later C6c tasks rely on this):
  - `interface DeltaRegistryEntry { file: string; collections: string[]; events: string[] }`
  - `interface DeltaRegistry { deltas: DeltaRegistryEntry[] }` — the on-disk shape of `movp.deltas.json` (locked in INTERFACES §"Project codegen: deltas + manifest").
  - `loadDeltaRegistry(path: string): Promise<DeltaRegistry>` — missing file → `{ deltas: [] }`; symlink / oversized / structurally-invalid → throws `Error` whose message starts with `invalid_deltas_registry`.
  - `saveDeltaRegistry(path: string, registry: DeltaRegistry): Promise<void>` — validates the registry, then delegates the write to the shared `atomicWriteFile` (F1): temp + `rename`, symlink/non-regular target refused (mapped to `invalid_deltas_registry`), least-privilege `0o600` even over a pre-existing `0o644` file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/deltas-registry.test.ts
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
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

  it('safe-write refuses to overwrite a symlinked registry target without following it (F1)', async () => {
    const d = await dir()
    const target = join(d, 'outside.json')
    const original = JSON.stringify({ deltas: [] })
    await writeFile(target, original)
    const path = join(d, 'movp.deltas.json')
    await symlink(target, path)
    await expect(
      saveDeltaRegistry(path, {
        deltas: [{ file: '20260712000001_movp_generated_x.sql', collections: ['deal'], events: [] }],
      }),
    ).rejects.toThrow(/invalid_deltas_registry.*symlink/)
    // The symlink's target must be byte-unchanged — the write must NOT have followed the link.
    expect(await readFile(target, 'utf8')).toBe(original)
  })

  it('safe-write re-chmods a PRE-EXISTING 0o644 registry down to 0o600 (F1)', async () => {
    const d = await dir()
    const path = join(d, 'movp.deltas.json')
    // A registry that already exists world/group-readable — the exact case writeFile({mode})
    // fails to fix (mode is only honoured on CREATE, not on an overwrite of an existing file).
    await writeFile(path, `${JSON.stringify({ deltas: [] })}\n`)
    await chmod(path, 0o644)
    await saveDeltaRegistry(path, { deltas: [] })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/codegen exec vitest run test/deltas-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/deltas-registry.ts'`.

- [ ] **Step 3: Write minimal implementation**

First the shared F1 atomic writer (`safe-write.ts`); `deltas-registry.ts` (and Tasks 3/4/5) import it — no call site writes files directly:

```ts
// packages/codegen/src/safe-write.ts
import { randomBytes } from 'node:crypto'

// F1 (INTERFACES round 2): the ONE atomic, symlink-safe write for every generated artifact
// (movp.deltas.json, movp.schema.json, generated migrations). Fixes two gaps in the naive
// `lstat`-then-`writeFile({ mode })`:
//   (1) TOCTOU — a symlink swapped in AFTER the lstat is then FOLLOWED by writeFile;
//   (2) writeFile({ mode }) does NOT chmod an ALREADY-EXISTING file — a pre-existing 0o644
//       registry stays 0o644.
// Both close by writing to a fresh 0o600 temp and renaming it over the destination: rename
// replaces the destination inode (so the result is 0o600) and NEVER follows / writes through
// a symlink sitting at the destination.
const SAFE_FILE_MODE = 0o600

interface SafeFs {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>
  writeFile(path: string, data: string, options: { flag: 'wx'; mode: number }): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

async function nodeFs(): Promise<SafeFs> {
  return (await import('node:fs/promises')) as unknown as SafeFs
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
}

export interface AtomicWriteOptions {
  // Map the "destination is a symlink / non-regular file" refusal onto a caller-specific error
  // (e.g. saveDeltaRegistry → `invalid_deltas_registry`). Must never return (typed `never`).
  onRefuse?: (reason: string) => never
}

export async function atomicWriteFile(path: string, contents: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const f = await nodeFs()
  const refuse = opts.onRefuse ?? ((reason: string): never => {
    throw new Error(`safe_write_refused: ${reason}`)
  })
  // Sibling temp in the SAME dir so `rename` is atomic (same filesystem). Exclusive create
  // (`wx`) + 0o600 means the bytes never touch a world/group-readable inode.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await f.writeFile(tmp, contents, { flag: 'wx', mode: SAFE_FILE_MODE })
  try {
    let info: { isFile(): boolean; isSymbolicLink(): boolean } | null = null
    try {
      info = await f.lstat(path)
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
    }
    if (info !== null) {
      if (info.isSymbolicLink()) refuse(`${path}: refusing to overwrite a symlink`)
      if (!info.isFile()) refuse(`${path}: not a regular file`)
    }
    // `rename` never follows a symlink at `path`; even in a TOCTOU race after the lstat it
    // replaces the link itself, so the write can never land on the link's external target.
    await f.rename(tmp, path)
  } catch (error: unknown) {
    // Never leave the temp behind — refusal, rename race, or disk error alike.
    await f.unlink(tmp).catch(() => {})
    throw error
  }
}
```

Then the registry loader/saver, which delegates its write to `atomicWriteFile`:

```ts
// packages/codegen/src/deltas-registry.ts
import { atomicWriteFile } from './safe-write.ts'

export interface DeltaRegistryEntry {
  file: string
  collections: string[]
  events: string[]
}

export interface DeltaRegistry {
  deltas: DeltaRegistryEntry[]
}

const MAX_REGISTRY_BYTES = 1 * 1024 * 1024
// movp.deltas.json can carry sensitive collection/event refs; the shared atomicWriteFile (F1)
// writes it 0o600 (least-privilege; never world/group-readable) — see safe-write.ts.

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
  // Read-path only: the write goes through the shared atomicWriteFile (F1).
  return (await import('node:fs/promises')) as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>
    readFile(path: string, encoding: 'utf8'): Promise<string>
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
  // F1 atomic safe-write ([[untrusted-io-and-resource-bounds]]): the shared helper writes a
  // 0o600 temp and renames it over `path`. It refuses (never follows) a symlink / non-regular
  // target — `fail` maps that refusal to the `invalid_deltas_registry` code — and re-chmods a
  // pre-existing 0o644 registry down to 0o600 (which writeFile({ mode }) would NOT do).
  await atomicWriteFile(path, `${JSON.stringify(registry, null, 2)}\n`, { onRefuse: fail })
}
```

Add to `packages/codegen/src/index.ts` (`atomicWriteFile` stays internal — Tasks 3/4/5 import it from `./safe-write.ts` directly; no public surface):

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
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/safe-write.ts packages/codegen/src/deltas-registry.ts packages/codegen/test/deltas-registry.test.ts packages/codegen/src/index.ts
git commit -m "feat(codegen): C6c.1 atomicWriteFile helper + validated movp.deltas.json registry loader"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/deltas-registry.test.ts` PASS (7). Symlink + malformed load inputs throw `invalid_deltas_registry` with zero content leakage; the write path (`saveDeltaRegistry` → `atomicWriteFile`, F1) refuses to follow/overwrite a symlinked target and leaves its external target byte-unchanged, and a pre-existing `0o644` registry ends `0o600` after a save (stat asserts the mode).

---

### Task 2: Project-scoped SQL emitters (reuse C6a layer-aware emitter)

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
  (There is deliberately NO `emitProjectCollectionSql`: the shared, C6a layer-aware `emitCollectionSql` is the single source of per-collection DDL+metadata for both tiers — DRY.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/codegen/test/emit-project-sql.test.ts
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import {
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
  // Reject platform ownership on the project emit path.
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

```

Add to `packages/codegen/src/index.ts`:

```ts
export {
  emitProjectDeltaSql,
  emitProjectMigration,
} from './emit-sql.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/codegen exec vitest run test/emit-project-sql.test.ts test/generate.test.ts`
Expected: PASS — 3 new tests + the existing 33 generate.test.ts cases still green (monorepo baseline byte-identical).

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/emit-sql.ts packages/codegen/test/emit-project-sql.test.ts packages/codegen/src/index.ts
git commit -m "feat(codegen): C6c.2 project-scoped emitters with layer=project guard"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/emit-project-sql.test.ts test/generate.test.ts` PASS. A platform-layer collection on the project path throws `platform_row_delete_forbidden`.

---

### Task 3: Project-mode `generate()` — compare-before-write, no-delete, `new_generated_delta_required`

**Files:**
- Modify: `packages/codegen/src/generate.ts`
- Test: `packages/codegen/test/generate-project.test.ts`

**Interfaces:**
- Consumes (06a): `schema.projectCollections`. (06b): `generate` already has `schema`. (Task 1): `loadDeltaRegistry`, `DeltaRegistry`. (Task 2): `emitProjectMigration`, `emitProjectDeltaSql`.
- Produces:
  - `GenerateOptions` gains `deltasRegistryPath?: string` (presence ⇒ project mode) and `manifestPath?: string` / `generatorVersion?: string` (consumed in Task 5). `schema: MovpSchema` stays **REQUIRED** (F4, 06b) — this task must NOT reintroduce an optional/defaulted `schema` nor a `generate(options = {})` default.
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

  it('type-rejects a generate() call with no schema (F4 — schema is REQUIRED)', () => {
    // Compile-time assertion, verified by `tsc --noEmit` (Task 7 gate), NOT at runtime:
    // `noSchemaCall` is never invoked. The `@ts-expect-error` below fails the typecheck
    // if omitting `schema` were ever allowed again (the F4 regression this pins shut).
    const noSchemaCall = () =>
      // @ts-expect-error - F4 (06b): options.schema is REQUIRED; a no-schema call must not typecheck.
      generate({ migrationsDir: '/tmp/movp', migrationName: BASELINE, deltasRegistryPath: '/tmp/movp.deltas.json' })
    expect(typeof noSchemaCall).toBe('function')
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
import { atomicWriteFile } from './safe-write.ts'
```

Extend `GenerateOptions`:

```ts
export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
  // F4 (06b owns): `schema` is REQUIRED — no optional `?`, no `= {}` default on
  // `generate()`. Monorepo AND project callers both pass it explicitly (06b rewires
  // `scripts/codegen.ts` et al.). 06c must NOT reintroduce an optional/defaulted schema.
  schema: MovpSchema
  deltasRegistryPath?: string
  manifestPath?: string
  generatorVersion?: string
}
```

At the very start of `generate()`:

```ts
export async function generate(
  options: GenerateOptions,
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
  // F1 atomic safe-write: temp + rename; refuses a symlinked / non-regular target (a planted
  // symlink can never redirect the write outside the migrations dir) and writes 0o600.
  for (const item of toWrite) {
    await atomicWriteFile(item.path, item.expected)
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
Expected: PASS — 6 new project tests (5 project-mode + 1 type-rejection) + 33 monorepo tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/generate.ts packages/codegen/test/generate-project.test.ts
git commit -m "feat(codegen): C6c.3 immutable project-mode generate (compare-before-write, no-delete)"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/generate-project.test.ts test/generate.test.ts` PASS. Unowned collection + drifted baseline both throw `new_generated_delta_required` and the `readdir` before/after assertion proves zero writes; a foreign `*_movp_generated.sql` survives. The F4 no-schema case is enforced at typecheck time by `@ts-expect-error` (verified by `tsc --noEmit`, Task 7).

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
import { atomicWriteFile } from './safe-write.ts'

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

  // Persist ownership FIRST so a crash mid-write cannot leave an unowned migration.
  await saveDeltaRegistry(o.registryPath, { deltas: [...registry.deltas, { file, collections, events }] })
  // F1 atomic safe-write: temp + rename; refuses (never follows) a symlink planted at the target.
  await atomicWriteFile(migrationPath, body)
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
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { schemaFingerprint } from '@movp/core-schema'
import { emitManifest, serializeManifest } from '../src/emit-manifest.ts'
import { resolveGeneratorVersion } from '../src/generate.ts'

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

const fixtureDirs: string[] = []

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'movp-generator-version-'))
  fixtureDirs.push(dir)
  return dir
}

async function capturedError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    return String(error)
  }
  throw new Error('expected operation to reject')
}

afterEach(async () => {
  await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

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

describe('resolveGeneratorVersion — guarded package.json read', () => {
  it('reads a regular package URL, including an encoded path', async () => {
    const dir = await fixtureDir()
    const packagePath = join(dir, 'package with space.json')
    await writeFile(packagePath, JSON.stringify({ version: '0.1.0' }))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(packagePath))).resolves.toBe('0.1.0')
  })

  it('rejects a symlink without reading or logging its target', async () => {
    const dir = await fixtureDir()
    const secret = join(dir, 'credentials')
    const packagePath = join(dir, 'package.json')
    await writeFile(secret, 'aws_secret_access_key = SUPERSECRET\n')
    await symlink(secret, packagePath)
    const error = await capturedError(() => resolveGeneratorVersion(undefined, pathToFileURL(packagePath)))
    expect(error).toMatch(/generator_version_symlink_rejected/)
    expect(error).not.toMatch(/SUPERSECRET|aws_secret/)
  })

  it('rejects a non-regular file', async () => {
    const dir = await fixtureDir()
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(dir))).rejects.toThrow(
      /generator_version_not_regular_file/,
    )
  })

  it('rejects an oversized package before buffering it', async () => {
    const dir = await fixtureDir()
    const packagePath = join(dir, 'package.json')
    await writeFile(packagePath, Buffer.alloc(10 * 1024 * 1024 + 1))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(packagePath))).rejects.toThrow(
      /generator_version_too_large/,
    )
  })

  it('rejects malformed JSON without logging its content', async () => {
    const dir = await fixtureDir()
    const packagePath = join(dir, 'package.json')
    await writeFile(packagePath, 'aws_secret_access_key = SUPERSECRET\n')
    const error = await capturedError(() => resolveGeneratorVersion(undefined, pathToFileURL(packagePath)))
    expect(error).toMatch(/generator_version_invalid_json/)
    expect(error).not.toMatch(/SUPERSECRET|aws_secret/)
  })

  it('validates the parsed version before dereferencing it', async () => {
    const dir = await fixtureDir()
    const packagePath = join(dir, 'package.json')
    await writeFile(packagePath, JSON.stringify({ version: 123 }))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(packagePath))).rejects.toThrow(
      /generator_version_invalid_shape/,
    )
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
import { fileURLToPath } from 'node:url'
import { emitManifest, serializeManifest } from './emit-manifest.ts'
```

Add a resolver (reads the codegen package version deterministically; project mode value flows into the manifest):

```ts
export async function resolveGeneratorVersion(
  explicit?: string,
  packageUrl = new URL('../package.json', import.meta.url),
): Promise<string> {
  if (explicit !== undefined) return explicit
  // `fileURLToPath`, not `decodeURIComponent(url.pathname)`: the latter leaves Windows paths as
  // `/C:/...`. `packageUrl` is injectable only so tests can use synthetic files outside the worktree;
  // production callers omit it and resolve this package's own manifest.
  const packagePath = fileURLToPath(packageUrl)
  const f = await fs()

  // The worktree is untrusted input. `readFile` follows symlinks, so lstat and bound BEFORE buffering.
  let info: Awaited<ReturnType<Fs['lstat']>>
  try {
    info = await f.lstat(packagePath)
  } catch {
    throw new Error(`generator_version_unreadable: ${packagePath} cannot be inspected`)
  }
  if (info.isSymbolicLink()) {
    throw new Error(`generator_version_symlink_rejected: ${packagePath} is a symlink`)
  }
  if (!info.isFile()) {
    throw new Error(`generator_version_not_regular_file: ${packagePath} is not a regular file`)
  }
  if (info.size > MAX_GENERATED_FILE_BYTES) {
    throw new Error(
      `generator_version_too_large: ${packagePath} exceeds ${MAX_GENERATED_FILE_BYTES} bytes`,
    )
  }

  let raw: string
  try {
    raw = await f.readFile(packagePath, 'utf8')
  } catch {
    throw new Error(`generator_version_unreadable: ${packagePath} cannot be read`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON.parse error messages include input snippets. Never interpolate the parse error or bytes.
    throw new Error(`generator_version_invalid_json: ${packagePath} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`generator_version_invalid_shape: ${packagePath} is not an object`)
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version === 'string') {
    return version
  }
  throw new Error(`generator_version_invalid_shape: ${packagePath} has no string version`)
}
```

In `generateProject`, after the write loop and before `return`:

```ts
  if (options.manifestPath !== undefined) {
    const generatorVersion = await resolveGeneratorVersion(options.generatorVersion)
    // F1 atomic safe-write via the shared helper (temp + rename; refuses a symlinked / non-regular
    // target). Writes 0o600 like every other generated artifact — one write path, no exceptions.
    await atomicWriteFile(options.manifestPath, serializeManifest(emitManifest(schema, { generatorVersion })))
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
Expected: PASS — 8 manifest/version tests + Task 3 project tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/codegen/src/emit-manifest.ts packages/codegen/src/generate.ts packages/codegen/src/index.ts packages/codegen/test/emit-manifest.test.ts
git commit -m "feat(codegen): C6c.5 movp.schema.json manifest emitter (fingerprint from 06b)"
```

**Gate:** `pnpm --filter @movp/codegen exec vitest run test/emit-manifest.test.ts` PASS (8 tests). `m.schemaFingerprint === schemaFingerprint(s)` asserted; serialization deterministic + trailing newline; generator-version resolution uses `fileURLToPath`, rejects symlink/non-file/oversized input before reading, and malformed JSON cannot leak its bytes.

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

Create `scripts/check-metadata-consistency.ts` (the `db reset` gate wiring — queries the local DB via `psql`, aliasing columns to the projection field names, and delegates to the pure comparator). This is not a Vitest target; it is run against a reset DB — **Task 8 is the CI gate that invokes it**. It uses `psql` (the repo's DB-gate convention, `scripts/check-vector-scale.mjs`), so it needs **no `pg` dependency** (`pg` is not installed; no new deps without approval):

```ts
// scripts/check-metadata-consistency.ts
// Run AFTER `supabase db reset`: asserts movp_collections/movp_fields match the schema
// projection. Exits non-zero with the stable error CODE on any drift.
// Transport is psql (repo convention — scripts/check-vector-scale.mjs), NOT the `pg`
// npm client, which is not a dependency here (no new deps without approval).
import { execFileSync } from 'node:child_process'
import { schema } from '@movp/core-schema'
import { checkMetadataConsistency, MetadataConsistencyError, type MetadataDbState } from '@movp/codegen'

// This repo's isolated local Supabase DB port (CLAUDE.md "Supabase Local Stack Hygiene").
const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:64322/postgres'

// The SELECT column list IS the row-shape contract: psql returns JSON with exactly these
// keys, matching MetadataDbState. Trusted, fixed-shape output from our own query — the one
// `as T[]` cast lives here. `-tAX` = tuples-only, unaligned, no psqlrc; coalesce → '[]' so
// an empty table still parses.
function queryRows<T>(sql: string): T[] {
  const out = execFileSync('psql', [DB_URL, '-tAX', '-c', `select coalesce(json_agg(t), '[]') from (${sql}) t`], {
    encoding: 'utf8',
  })
  return JSON.parse(out.trim()) as T[]
}

function main(): void {
  const collections = queryRows<MetadataDbState['collections'][number]>(
    'select name, label, label_plural, workspace_scoped, layer from public.movp_collections',
  )
  const fields = queryRows<MetadataDbState['fields'][number]>(
    'select collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer from public.movp_fields',
  )
  const db: MetadataDbState = { collections, fields }
  try {
    checkMetadataConsistency(schema, db)
    console.log('metadata consistency: OK')
  } catch (error: unknown) {
    if (error instanceof MetadataConsistencyError) {
      // Content discipline: log the stable CODE + key/column detail only, never a row value.
      console.error(`metadata consistency FAILED [${error.code}]: ${error.detail}`)
      process.exit(1)
    }
    throw error
  }
}

main()
```

> **Note for the executor:** run this via the repo's `tsx` devDependency (`pnpm exec tsx scripts/check-metadata-consistency.ts`), exactly like `scripts/codegen.ts` / `scripts/seed-demo.ts`. It shells out to `psql` (present on the Supabase CI image). Do NOT add the `pg` npm package. The port `64322` matches this repo's isolated local Supabase DB port (CLAUDE.md "Supabase Local Stack Hygiene").

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

### Task 8: Live DB-reset metadata consistency gate (CI, F7)

**Files:**
- Create: `scripts/gate-metadata-consistency.sh` — the gate: run the check on a reset DB (expect pass), then mutate a real `movp_fields` row and assert the check exits non-zero with the stable code `altered_metadata_row`.
- Modify: `package.json` — add a `gate:metadata-consistency` script for local + CI parity.
- Modify: `.github/workflows/ci.yml` — add a `metadata-consistency` job (`supabase start` → `supabase db reset` → the gate).

**Why this task (F7):** Task 6's `checkMetadataConsistency` + `scripts/check-metadata-consistency.ts` are otherwise only unit/typecheck-gated. F7 (INTERFACES "Plan review round 1 — locked resolutions") requires a REAL gate that runs against a live, reset DB and proves BOTH directions: a clean reset passes (exit 0), and a mutated `movp_fields` row fails with the stable code `altered_metadata_row` and a non-zero exit. **06f consumes THIS established signal** — it must not treat a manifest-derived `MetadataDbState` as live evidence. This task is the codegen-side twin of the monorepo `check-forward-only-migrations` gate.

**Interfaces:**
- Consumes: `scripts/check-metadata-consistency.ts` (Task 6, psql transport) and the stable code `altered_metadata_row` (Task 6). Uses this repo's isolated DB port `64322`.
- Produces: no new API — a CI job + gate script; the live signal 06f depends on.

- [ ] **Step 1: Write the gate script**

```bash
# scripts/gate-metadata-consistency.sh
#!/usr/bin/env bash
# F7 CI gate: after `supabase db reset`, live movp_collections/movp_fields must match the
# schema projection (positive), and a mutated movp_fields row must fail with the stable code
# `altered_metadata_row` + a non-zero exit (negative). 06f consumes THIS live signal.
set -euo pipefail

# This repo's isolated local Supabase DB port (CLAUDE.md "Supabase Local Stack Hygiene").
DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:64322/postgres}"

# 1) Positive: a freshly reset DB is consistent — the check must exit 0.
pnpm exec tsx scripts/check-metadata-consistency.ts

# 2) Precondition: there must be a real movp_fields row to mutate (else the negative case
#    would be a false pass). `-tAX` = tuples-only, unaligned, no psqlrc.
count="$(psql "$DB_URL" -tAX -c 'select count(*) from public.movp_fields;')"
if [ "$count" -eq 0 ]; then
  echo "GATE FAILED: no movp_fields rows after reset — nothing to mutate" >&2
  exit 1
fi

# 3) Negative: mutate exactly one real row, then require a non-zero exit + altered_metadata_row.
psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
  "update public.movp_fields set label = label || ' (drift)' where ctid = (select ctid from public.movp_fields limit 1);"

set +e
out="$(pnpm exec tsx scripts/check-metadata-consistency.ts 2>&1)"
code=$?
set -e
printf '%s\n' "$out"

if [ "$code" -eq 0 ]; then
  echo "GATE FAILED: a mutated movp_fields row did not cause a non-zero exit" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q 'altered_metadata_row'; then
  echo "GATE FAILED: expected stable code altered_metadata_row on drift" >&2
  exit 1
fi
echo "metadata-consistency gate: OK (clean reset passes; drift -> altered_metadata_row, exit $code)"
```

Make it executable: `chmod +x scripts/gate-metadata-consistency.sh`.

Add to `package.json` `scripts`:

```json
"gate:metadata-consistency": "bash scripts/gate-metadata-consistency.sh"
```

- [ ] **Step 2: Wire the CI job**

Add to `.github/workflows/ci.yml` (mirror the existing `quickstart` job's setup — `pnpm/action-setup@v6 { version: 9.12.0 }` + `actions/setup-node@v6 { node-version: 22, cache: pnpm }` + `supabase/setup-cli@v2 { version: 2.109.1 }`; pin the EXACT version matching the existing `integration-smoke` job (ci.yml:130) which runs the same `supabase start`/`db reset` class of work — per ci-deploy-patterns, do not float DB gates on `latest`; `pnpm install` is required because the gate runs `tsx` + imports `@movp/*` workspace packages):

```yaml
  metadata-consistency:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }   # pinned — matches integration-smoke (ci.yml:130); do not float DB gates
      - run: supabase --version | grep -qF '2.109.1'   # assert the pinned CLI is what runs
      - run: pnpm install --frozen-lockfile
      - run: supabase start
      - run: supabase db reset
      - run: pnpm gate:metadata-consistency
```

- [ ] **Step 3: Run the gate locally against a reset DB**

Run:
```bash
supabase db reset && pnpm gate:metadata-consistency
```
Expected: prints `metadata consistency: OK`; then (after the mutation) `metadata consistency FAILED [altered_metadata_row]: field "<key>" column "label"`; then `metadata-consistency gate: OK ...`. The gate's OWN exit is `0` — it passes because the negative case behaved as required (non-zero exit from the check + the stable code found).

> The gate leaves the DB with one mutated row; CI runs it on a throwaway runner after its own `supabase db reset`, so no cleanup is needed. Locally, re-run `supabase db reset` before other DB work.

- [ ] **Step 4: Commit**

```bash
git add scripts/gate-metadata-consistency.sh package.json .github/workflows/ci.yml
git commit -m "test(codegen): C6c.8 live DB-reset metadata consistency gate (F7)"
```

**Gate:** `supabase db reset && pnpm gate:metadata-consistency` exits `0`, having asserted the clean-reset positive AND the `altered_metadata_row` non-zero-exit negative. This is the live signal 06f consumes (INTERFACES F7); a manifest-derived `MetadataDbState` is NOT accepted as a substitute.

---

## Self-Review

**Spec coverage:** Immutable deltas / compare-before-write / no-delete (Task 3); project-local `movp.deltas.json` (Task 1); `new_generated_delta_required` + zero writes (Task 3, 7); `movp new-delta` one additive migration (Task 4); `layer='project'`-only emit + `platform_row_delete_forbidden` (Task 2); manifest exact shape + `schemaFingerprint` from 06b (Task 5); consistency comparator with missing/altered/stale stable ids (Task 6) AND a live DB-reset gate proving both directions (Task 8, F7 — the signal 06f consumes); acceptance slice (Task 7). V1 removal/pruning is explicitly deferred: collection/event removal throws `project_schema_removal_unsupported`, while field mutation/removal must be restored after immutable-file refusal. Locked-resolution conformance: `generate({schema})` schema is REQUIRED with no default (F4, Task 3, pinned by a `@ts-expect-error` test); `saveDeltaRegistry`/manifest writes use the untrusted-I/O safe-write pattern with least-privilege mode (F6, Task 1/5). Forward-only guard: the monorepo `scripts/check-forward-only-migrations.mjs` is reused by scaffolds (06d ships it); C6c's byte-stability gates (Tasks 3/7) are the codegen-side enforcement.

**Type consistency:** `DeltaRegistry`/`DeltaRegistryEntry`, `SchemaManifest`/`ManifestCollection`/`ManifestField`, `MetadataDbState`/`MetadataConsistencyCode` used identically across tasks. `generate` project branch keyed on `deltasRegistryPath`; `emitProjectMigration`/`emitProjectDeltaSql` names match between Task 2 and Task 3.

**Assumptions (flag to the caller):**
1. 06a exposes `schema.projectCollections`/`schema.platformCollections` and `CollectionDef.layer`; test fixtures cast a literal to `MovpSchema` — replace with the real `defineSchema({ extends, ... })` builder once 06a lands.
2. 06b exports `metadataProjection` and `schemaFingerprint` from `@movp/core-schema` with the field names used here.
3. Event-layer ownership: events are owned purely via `movp.deltas.json` entries (no `schema.projectEvents` view is assumed); the ownership check is collection-driven (matching the C6c gate "add a collection"). If 06a adds a project-events view, extend Task 3's ownership set accordingly.
4. The Task 6/8 DB gate uses `psql` (repo convention — `scripts/check-vector-scale.mjs`) run via the `tsx` devDependency; it adds **no** `pg` dependency. `psql` is present on the Supabase CI image. If a future runner lacks `psql`, swap the transport (still no new npm dep) rather than reintroducing `pg`.
