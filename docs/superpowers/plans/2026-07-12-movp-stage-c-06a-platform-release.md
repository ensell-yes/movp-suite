# C6a — Platform Release Artifact + Schema Composition + `layer` Marker — Implementation Plan

**For agentic workers:** Before executing, load the **`superpowers:executing-plans`** skill (REQUIRED
sub-skill). Execute one task at a time, top to bottom; run each task's failing test first, then the
minimal implementation, then re-run to green, then commit. Do not skip the machine-checkable gate that
closes each task. This plan is written for a context-poor executor: every code sample is
copy-paste-correct against the tree at branch `docs/stage-c6-templates-scaffolding` and must be pasted
verbatim.

## Goal

Ship the first piece of the C6 productization seam:

1. A NEW forward-only platform migration adds a `layer text not null default 'platform'` marker to
   `movp_collections` / `movp_fields` (backfilling existing rows to `'platform'`).
2. `@movp/core-schema` gains `defineSchema({ extends?, collections, events })` schema composition and a
   `layer` marker on `CollectionDef`, so a project schema is `platformSchema + projectExtensions`.
3. `@movp/codegen`'s SQL emitter writes `layer = 'project'` for project-extension collections while
   leaving platform output **byte-identical** to the frozen baseline.
4. A new `@movp/platform` package produces an immutable, digest-manifested migration bundle plus a
   `verifyPlatformArtifact(dir)` gate.
5. A committed consumer fixture installs the platform bundle + a tiny extension and proves
   `supabase db reset` is green with no source-repo paths and platform metadata byte-intact.

## Architecture

- **`@movp/core-schema`** (`packages/core-schema/`) — the DSL. `CollectionDef` gains an optional
  `layer` field; `defineSchema` becomes object-form and stamps a concrete `layer` on every collection
  (`'platform'` for the monorepo / inherited collections, `'project'` for locally-declared collections
  when `extends` is set). Adds derived views `schema.platformCollections` / `schema.projectCollections`.
- **`@movp/codegen`** (`packages/codegen/`) — `emit-sql.ts`'s `collectionMetadataSql` conditionally
  writes the `layer` column: **only** for `layer === 'project'` collections. Platform collections emit
  exactly the bytes already frozen in `20260701000002_movp_generated.sql`.
- **`@movp/platform`** (NEW, `packages/platform/`) — a build script that snapshots the whole ordered
  `supabase/migrations/*.sql` stream into `dist/migrations/` + `dist/manifest.json`, and a pure
  `verifyPlatformArtifact(dir)` util that throws `platform_artifact_invalid` on
  missing/extra/reordered/digest-mismatch/symlink.
- **`fixtures/platform-consumer/`** (NEW) — a port-isolated Supabase project that materializes the
  platform bundle + one hand-authored `contact` extension migration (`layer='project'`) and asserts,
  via `gate.sh`, that `db reset` is green, no source-repo paths leak, and platform metadata is
  byte-identical with and without the extension.

## Tech Stack

- TypeScript (ESM, `.ts` extension imports, `moduleResolution: bundler`, `strict: true`), pnpm 9
  workspace, `turbo` for `test`/`typecheck`.
- Vitest `^3.2.6` (already present); `tsx` `^4.19.0` (already present) for the platform build script.
- Node `node:crypto` / `node:fs` for digests and I/O.
- Supabase CLI local stack, Postgres major version 17.

## Global Constraints

- **Forward-only migrations.** Migrations are forward-only from `supabase/.forward-only-migration-baseline`.
  NEVER edit/delete/rename/regenerate a merged migration, including `20260701000002_movp_generated.sql`.
  Add NEW timestamped migrations only. The new file `20260713000001_metadata_layer.sql` is an **added**
  file (git status `A`), which the guard (`scripts/check-forward-only-migrations.mjs`) permits; do NOT
  add it to `.forward-only-migration-baseline` (the guard freezes it automatically once merged).
- **Frozen-baseline byte discipline.** The emitter change MUST keep `emitSqlMigration(schema)` output
  for platform collections **byte-identical**. `pnpm codegen` (which re-emits against the real frozen
  baseline) must not raise `generated baseline drift`. This is why the `layer` write is conditional on
  `layer === 'project'` — see the inline comment at its trigger site in Task 1.
- **No `any`.** Use `unknown` + narrowing. No `any`, no unchecked `as` on parsed external input except
  the localized narrowing shown.
- **No NEW external dependencies.** Every dependency used (`vitest`, `tsx`, `@types/node`) already exists
  in the repo. Do not add others without approval.
- **Port isolation.** The monorepo local stack owns `64321/64322/64320/64323/64324/64327/64329` (see
  root `CLAUDE.md`). The consumer fixture uses a DISTINCT `+100` block (`64421/64422/64420/64423/64424/64429`)
  so it never collides with the main stack.
- **Published pin context.** Scaffolds will later pin `@movp/* @^0.1.0` (C6d). In C6a all workspace
  packages, including the new `@movp/platform`, stay at `version: "0.0.0"`; `platformVersion` in the
  manifest is read from `@movp/platform`'s own `package.json` `version` field.
- **Stable error codes (this part):** `platform_artifact_invalid`. (`platform_row_delete_forbidden`,
  `new_generated_delta_required`, `schema_runtime_mismatch` are owned by 06b/06c — do NOT emit them here.)

---

## Task 1 — `layer` marker migration + emitter writes `layer='project'`

Add the forward-only `layer` column migration and make `collectionMetadataSql` write `layer` **only** for
project collections, keeping platform output byte-identical.

### Files

- **Create:** `supabase/migrations/20260713000001_metadata_layer.sql`
- **Modify:** `packages/codegen/src/emit-sql.ts` — `collectionMetadataSql` (currently lines 76–108)
- **Test (modify):** `packages/codegen/test/emit-sql.test.ts` — append a `describe` block

### Interfaces

- **Consumes:** `CollectionDef.layer?: 'platform' | 'project'` (added in Task 2; in Task 1 the field is
  read defensively via `c.layer === 'project'`, which is `false`/safe until Task 2 lands the field —
  order Task 1 before Task 2 and the emitter compiles because `layer` is added as OPTIONAL in Task 2;
  to keep Task 1 self-compiling, Task 1 also adds the optional field — see step 3a).
- **Produces (SQL DDL, consumed by the platform bundle + C6c):**
  `movp_collections.layer text not null default 'platform' check (layer in ('platform','project'))`
  and the same on `movp_fields`.

### Steps

**1. Write the migration file** `supabase/migrations/20260713000001_metadata_layer.sql`:

```sql
-- Stage C6a: add the platform/project tier marker to schema metadata.
-- Forward-only (new file). `add column ... not null default 'platform'` backfills every existing
-- row to 'platform'; the check constraint pins the allowed values.
alter table public.movp_collections
  add column if not exists layer text not null default 'platform';
alter table public.movp_collections
  add constraint movp_collections_layer_check check (layer in ('platform', 'project'));

alter table public.movp_fields
  add column if not exists layer text not null default 'platform';
alter table public.movp_fields
  add constraint movp_fields_layer_check check (layer in ('platform', 'project'));
```

**2. Add the optional `layer` field to `CollectionDef`** so the emitter typechecks (the full
composition semantics land in Task 2). In `packages/core-schema/src/types.ts`, inside
`export interface CollectionDef`, add the field after `internal?: boolean`:

```ts
  /**
   * Tier marker distinguishing platform-owned collections from project extensions. Stamped by
   * defineSchema: 'platform' for a non-extends (monorepo) schema and for inherited collections;
   * 'project' for collections declared locally in an `extends` schema. Optional on hand-authored
   * defs (absent === 'platform').
   */
  layer?: 'platform' | 'project'
```

**3. Write the failing test.** Append to `packages/codegen/test/emit-sql.test.ts`:

```ts
describe('collection metadata layer marker', () => {
  const platformCollection = { ...note, layer: 'platform' as const }
  const projectCollection = { ...note, layer: 'project' as const }

  it('omits the layer column for platform collections (byte-identical to the frozen baseline)', () => {
    const sql = emitCollectionSql(platformCollection)
    expect(sql).toContain('insert into public.movp_collections (name, label, label_plural, workspace_scoped)')
    expect(sql).toContain("values ('note', 'Note', 'Notes', true)")
    expect(sql).toContain(
      'insert into public.movp_fields (collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable)',
    )
    expect(sql).not.toContain(", 'project')")
  })

  it('writes layer=project in both metadata upserts for project collections', () => {
    const sql = emitCollectionSql(projectCollection)
    expect(sql).toContain(
      'insert into public.movp_collections (name, label, label_plural, workspace_scoped, layer)',
    )
    expect(sql).toContain("values ('note', 'Note', 'Notes', true, 'project')")
    expect(sql).toContain(
      'insert into public.movp_fields (collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer)',
    )
    expect(sql).toContain("('note', 'title', 'text', 'Title', null, null, true, false, 'project')")
    expect(sql).toContain('layer = excluded.layer')
  })
})
```

Run it — **Expected: FAIL** (`Received string ... does not contain ..., 'Note', 'Notes', true, 'project'`
— the emitter does not yet write `layer`):

```
pnpm --filter @movp/codegen exec vitest run emit-sql
```

**4. Implement.** Replace the entire `collectionMetadataSql` function in
`packages/codegen/src/emit-sql.ts` (currently lines 76–108) with:

```ts
function collectionMetadataSql(c: CollectionDef): string {
  // Platform collections (layer 'platform' or absent) emit BYTE-IDENTICAL SQL to the frozen
  // baseline 20260701000002_movp_generated.sql, which PREDATES the `layer` column (added by
  // 20260713000001_metadata_layer.sql). Emitting `layer` unconditionally would (a) drift the frozen
  // baseline -> `pnpm codegen` throws "generated baseline drift", and (b) reference a column that
  // does not yet exist at baseline apply time. Only project extension codegen (which runs AFTER the
  // platform bundle adds the column) writes `layer = 'project'`.
  const isProject = c.layer === 'project'

  const collectionCols = isProject
    ? '(name, label, label_plural, workspace_scoped, layer)'
    : '(name, label, label_plural, workspace_scoped)'
  const collectionVals = isProject
    ? `(${q(c.name)}, ${q(c.label)}, ${q(c.labelPlural)}, ${String(c.workspaceScoped)}, 'project')`
    : `(${q(c.name)}, ${q(c.label)}, ${q(c.labelPlural)}, ${String(c.workspaceScoped)})`
  const collectionUpdate = isProject
    ? 'label = excluded.label, label_plural = excluded.label_plural, workspace_scoped = excluded.workspace_scoped, layer = excluded.layer'
    : 'label = excluded.label, label_plural = excluded.label_plural, workspace_scoped = excluded.workspace_scoped'

  const fieldCols = isProject
    ? '(collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer)'
    : '(collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable)'
  const fieldRows = Object.entries(c.fields)
    .map(([name, field]) => {
      const cells = [
        q(c.name),
        q(name),
        q(field.type),
        q(field.label),
        field.cardinality ? q(field.cardinality) : 'null',
        field.reporting?.role ? q(field.reporting.role) : 'null',
        String(!!field.searchable),
        String(!!field.embeddable),
      ]
      if (isProject) cells.push(`'project'`)
      return cells.join(', ')
    })
    .map((row) => `  (${row})`)
    .join(',\n')
  const fieldUpdate = isProject
    ? `  type = excluded.type,
  label = excluded.label,
  cardinality = excluded.cardinality,
  reporting_role = excluded.reporting_role,
  searchable = excluded.searchable,
  embeddable = excluded.embeddable,
  layer = excluded.layer`
    : `  type = excluded.type,
  label = excluded.label,
  cardinality = excluded.cardinality,
  reporting_role = excluded.reporting_role,
  searchable = excluded.searchable,
  embeddable = excluded.embeddable`

  return `
insert into public.movp_collections ${collectionCols}
values ${collectionVals}
on conflict (name) do update set ${collectionUpdate};

insert into public.movp_fields ${fieldCols}
values
${fieldRows}
on conflict (collection_name, name) do update set
${fieldUpdate};`
}
```

Re-run — **Expected: PASS** (both the new block and the pre-existing `emitCollectionSql(note)` /
`emitSqlMigration` tests, which pin the platform byte shape):

```
pnpm --filter @movp/codegen exec vitest run emit-sql
```

**5. Prove no baseline drift** (the load-bearing byte gate). Regenerate against the REAL frozen baseline
and confirm nothing changed:

```
pnpm codegen && git diff --exit-code supabase/migrations packages/domain/src/generated
```

**Expected:** `pnpm codegen` prints its normal output and does NOT throw `generated baseline drift`;
`git diff --exit-code` returns exit 0 (no changes to the frozen baseline, deltas, or generated types).

**6. Commit** (`feat(c6a): add layer metadata marker migration + project-layer emitter`).

### Gate (machine-checkable)

```
pnpm --filter @movp/codegen test \
  && node scripts/check-forward-only-migrations.mjs \
  && pnpm codegen && git diff --exit-code supabase/migrations packages/domain/src/generated
```

**Expected:** codegen tests green; forward-only guard prints `forward-only migrations: ok`; `git diff`
exit 0. The presence of the migration: `test -f supabase/migrations/20260713000001_metadata_layer.sql`.

---

## Task 2 — `defineSchema({ extends?, collections, events })` + `layer` composition + derived views

Convert `defineSchema` to object form, stamp `layer` on every collection, add derived views, and update
all call sites.

### Files

- **Modify:** `packages/core-schema/src/define.ts` — `defineSchema` (lines 47–69)
- **Modify:** `packages/core-schema/src/types.ts` — `MovpSchema` (lines 54–57)
- **Modify:** `packages/core-schema/src/schema.ts` — the `defineSchema([...], events)` call (lines 50–108)
- **Modify (callers):** `packages/codegen/test/workflows-contract.test.ts` (line 19–24);
  `packages/graphql/test/schema.test.ts` (the `recursive: MovpSchema` literal, lines 28–48)
- **Test (modify):** `packages/core-schema/test/schema.test.ts` — update the two `defineSchema(...)`
  calls and append a composition `describe`

### Interfaces

- **Produces (consumed by 06b/06c/06d — LOCKED, use verbatim):**
  - `defineSchema(opts: { extends?: MovpSchema; collections: CollectionDef[]; events?: EventDef[] }): MovpSchema`
  - `CollectionDef.layer?: 'platform' | 'project'` (added in Task 1)
  - `MovpSchema` gains `platformCollections: CollectionDef[]` and `projectCollections: CollectionDef[]`
    (derived views). `collections` includes both tiers.
  - When `extends` is set: inherited collections carry `layer: 'platform'`, locally-declared carry
    `layer: 'project'`. Without `extends`: all carry `layer: 'platform'`.

### Steps

**1. Extend `MovpSchema`.** In `packages/core-schema/src/types.ts` replace the interface (lines 54–57):

```ts
export interface MovpSchema {
  collections: CollectionDef[]
  events: EventDef[]
  /** Derived: collections with layer === 'platform'. */
  platformCollections: CollectionDef[]
  /** Derived: collections with layer === 'project' (empty for a non-extends schema). */
  projectCollections: CollectionDef[]
}
```

**2. Update the two existing `defineSchema` test calls** in
`packages/core-schema/test/schema.test.ts` so they compile against the new signature. Replace line 90:

```ts
    expect(() => defineSchema({ collections: [tag, tag] })).toThrow(/duplicate/)
```

Replace line 94:

```ts
    expect(() => defineSchema({ collections: [note] })).toThrow(/unknown collection "tag"/)
```

Also update the imports at the top of that file (lines 1–6) to add `defineCollection` and `f`:

```ts
import { describe, expect, it } from 'vitest'
import { f } from '../src/builders.ts'
import { comment } from '../src/collections/comment.ts'
import { note } from '../src/collections/note.ts'
import { tag } from '../src/collections/tag.ts'
import { defineCollection, defineSchema } from '../src/define.ts'
import { schema } from '../src/schema.ts'
```

**3. Append the composition failing test** to `packages/core-schema/test/schema.test.ts`:

```ts
describe('defineSchema layer composition', () => {
  it('tags a non-extends schema entirely platform', () => {
    expect(schema.collections.every((c) => c.layer === 'platform')).toBe(true)
    expect(schema.projectCollections).toEqual([])
    expect(schema.platformCollections).toHaveLength(schema.collections.length)
  })

  it('tags inherited collections platform and local collections project when extends is set', () => {
    const contact = defineCollection({
      name: 'contact',
      label: 'Contact',
      labelPlural: 'Contacts',
      workspaceScoped: true,
      fields: { full_name: f.text({ label: 'Full name', required: true }) },
    })
    const extended = defineSchema({ extends: schema, collections: [contact] })
    expect(extended.collections.find((c) => c.name === 'contact')?.layer).toBe('project')
    expect(extended.collections.find((c) => c.name === 'note')?.layer).toBe('platform')
    expect(extended.projectCollections.map((c) => c.name)).toEqual(['contact'])
    expect(extended.platformCollections.every((c) => c.layer === 'platform')).toBe(true)
  })

  it('rejects an extension that redeclares a platform collection name', () => {
    const dupNote = defineCollection({
      name: 'note',
      label: 'Note',
      labelPlural: 'Notes',
      workspaceScoped: true,
      fields: { title: f.text({ label: 'Title', required: true }) },
    })
    expect(() => defineSchema({ extends: schema, collections: [dupNote] })).toThrow(/duplicate/)
  })

  it('does not mutate the shared collection singleton (stamps copies)', () => {
    defineSchema({ extends: schema, collections: [] })
    expect((note as { layer?: string }).layer).toBeUndefined()
  })
})
```

Run it — **Expected: FAIL** (`defineSchema` still takes positional args; TS/type errors and
`schema.projectCollections` is `undefined`):

```
pnpm --filter @movp/core-schema exec vitest run schema
```

**4. Implement `defineSchema`.** Replace the function in `packages/core-schema/src/define.ts`
(lines 47–69) with:

```ts
export function defineSchema(opts: {
  extends?: MovpSchema
  collections: CollectionDef[]
  events?: EventDef[]
}): MovpSchema {
  // Spread into NEW objects so the shared exported collection singletons (e.g. `note`) are never
  // mutated by the layer stamp — callers import those singletons elsewhere.
  const inherited = (opts.extends?.collections ?? []).map((c) => ({ ...c, layer: 'platform' as const }))
  const local = opts.collections.map((c) => ({
    ...c,
    layer: (opts.extends ? 'project' : 'platform') as 'platform' | 'project',
  }))
  const collections = [...inherited, ...local]
  const events = [...(opts.extends?.events ?? []), ...(opts.events ?? [])]

  const names = new Set<string>()
  for (const c of collections) {
    if (names.has(c.name)) throw new Error(`duplicate collection name "${c.name}"`)
    names.add(c.name)
  }

  const eventKeys = new Set<string>()
  for (const event of events) {
    if (eventKeys.has(event.key)) throw new Error(`duplicate event key "${event.key}"`)
    eventKeys.add(event.key)
  }

  for (const c of collections) {
    for (const [fname, field] of Object.entries(c.fields)) {
      if (field.type === 'relation' && field.target && !names.has(field.target)) {
        throw new Error(`relation "${c.name}.${fname}" targets unknown collection "${field.target}"`)
      }
    }
  }

  return {
    collections,
    events,
    platformCollections: collections.filter((c) => c.layer === 'platform'),
    projectCollections: collections.filter((c) => c.layer === 'project'),
  }
}
```

**5. Update the monorepo call site** in `packages/core-schema/src/schema.ts`. Change line 50 from
`export const schema = defineSchema([` to:

```ts
export const schema = defineSchema({
  collections: [
```

and change the tail (line 108) from `], events)` to:

```ts
  ],
  events,
})
```

(The collection list between them is unchanged.)

**6. Update the codegen contract caller.** In `packages/codegen/test/workflows-contract.test.ts`
replace lines 19–24:

```ts
    const sql = emitSqlMigration(
      defineSchema({
        collections: [eventType],
        events: [defineEvent({ key: 'task.completed', domain: 'task', payloadSchema: { type: 'object' }, version: 1 })],
      }),
    )
```

**7. Update the graphql `MovpSchema` literal.** In `packages/graphql/test/schema.test.ts` add
`CollectionDef` to the type import (line 3):

```ts
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
```

and replace the `recursive` literal (lines 28–48) with a named collection referenced in both the
`collections` array and the derived view (so the required fields are satisfied):

```ts
const recursiveNode: CollectionDef = {
  name: 'node',
  label: 'Node',
  labelPlural: 'Nodes',
  workspaceScoped: true,
  layer: 'platform',
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
}

const recursive: MovpSchema = {
  collections: [recursiveNode],
  events: [],
  platformCollections: [recursiveNode],
  projectCollections: [],
}
```

Re-run the core-schema test — **Expected: PASS**:

```
pnpm --filter @movp/core-schema exec vitest run schema
```

**8. Commit** (`feat(c6a): defineSchema composition + layer views`).

### Gate (machine-checkable)

```
pnpm -r --filter @movp/core-schema --filter @movp/codegen --filter @movp/graphql test \
  && pnpm turbo run typecheck
```

**Expected:** all three package test suites green; `turbo run typecheck` green across the workspace (the
`MovpSchema` type widening compiles everywhere — the only literal is the graphql test, updated above).

---

## Task 3 — `@movp/platform` package: build + `verifyPlatformArtifact`

Create the platform artifact package: a build script that snapshots the migration stream with per-file
digests, and a pure verifier that rejects tampered artifacts.

### Files

- **Create:** `packages/platform/package.json`
- **Create:** `packages/platform/tsconfig.json`
- **Create:** `packages/platform/vitest.config.ts`
- **Create:** `packages/platform/src/verify.ts`
- **Create:** `packages/platform/src/build.ts`
- **Create:** `packages/platform/src/index.ts`
- **Create:** `packages/platform/.gitignore`
- **Test (create):** `packages/platform/test/verify.test.ts`

### Interfaces

- **Produces (LOCKED — consumed by 06d's scaffolder + this part's fixture):**
  - Artifact layout under a dir: `migrations/<ordered .sql files>` + `manifest.json`
    `{ platformVersion: string, files: [{ name: string, sha256: string }] }` (files in applied /
    lexicographic order, including interleaved `*_movp_generated*.sql`).
  - `verifyPlatformArtifact(dir: string): void` — throws on missing / extra / reordered /
    digest-mismatch / symlink migration. Error message contains the stable code
    `platform_artifact_invalid`.

### Steps

**1. `packages/platform/package.json`** (all deps already exist in the repo; version stays `0.0.0`):

```json
{
  "name": "@movp/platform",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsx src/build.ts"
  },
  "devDependencies": {
    "vitest": "^3.2.6",
    "tsx": "^4.19.0",
    "@types/node": "^26.0.1"
  },
  "types": "./src/index.ts",
  "files": [
    "dist"
  ]
}
```

**2. `packages/platform/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

**3. `packages/platform/vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

**4. `packages/platform/.gitignore`:**

```
dist/
```

**5. `packages/platform/src/verify.ts`** (the pure verifier — `lstat` symlink-reject and size-bound
BEFORE read, per the untrusted-I/O rule):

```ts
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PlatformManifestEntry {
  name: string
  sha256: string
}

export interface PlatformManifest {
  platformVersion: string
  files: PlatformManifestEntry[]
}

const MAX_MIGRATION_BYTES = 10 * 1024 * 1024

export class PlatformArtifactError extends Error {
  readonly code = 'platform_artifact_invalid'
  constructor(reason: string) {
    super(`platform_artifact_invalid: ${reason}`)
    this.name = 'PlatformArtifactError'
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readManifest(dir: string): PlatformManifest {
  const manifestPath = join(dir, 'manifest.json')
  const info = lstatSync(manifestPath, { throwIfNoEntry: false })
  if (!info) throw new PlatformArtifactError('manifest.json missing')
  if (info.isSymbolicLink()) throw new PlatformArtifactError('manifest.json is a symlink')

  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PlatformArtifactError('manifest.json is not an object')
  }
  const version = (parsed as { platformVersion?: unknown }).platformVersion
  const rawFiles = (parsed as { files?: unknown }).files
  if (typeof version !== 'string' || !Array.isArray(rawFiles)) {
    throw new PlatformArtifactError('manifest.json is missing platformVersion or files')
  }
  const files = rawFiles.map((entry, i): PlatformManifestEntry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new PlatformArtifactError(`manifest.json files[${i}] is not an object`)
    }
    const name = (entry as { name?: unknown }).name
    const sha256 = (entry as { sha256?: unknown }).sha256
    if (typeof name !== 'string' || typeof sha256 !== 'string') {
      throw new PlatformArtifactError(`manifest.json files[${i}] is malformed`)
    }
    return { name, sha256 }
  })
  return { platformVersion: version, files }
}

export function verifyPlatformArtifact(dir: string): void {
  const manifest = readManifest(dir)
  const migrationsDir = join(dir, 'migrations')

  let present: string[]
  try {
    present = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
  } catch {
    throw new PlatformArtifactError('migrations/ directory missing')
  }

  const expected = manifest.files.map((f) => f.name)
  const expectedSet = new Set(expected)
  const presentSet = new Set(present)

  for (const name of present) {
    if (!expectedSet.has(name)) throw new PlatformArtifactError(`extra migration not in manifest: ${name}`)
  }
  for (const name of expected) {
    if (!presentSet.has(name)) throw new PlatformArtifactError(`manifest migration missing on disk: ${name}`)
  }

  // Applied order is lexicographic filename order (how the Supabase CLI applies migrations); the
  // manifest MUST already be in that order, so any reordering is detectable.
  const expectedSorted = [...expected].sort()
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== expectedSorted[i]) {
      throw new PlatformArtifactError(`manifest files are not in applied order at index ${i}: ${expected[i]}`)
    }
  }

  for (const { name, sha256 } of manifest.files) {
    const filePath = join(migrationsDir, name)
    const info = lstatSync(filePath, { throwIfNoEntry: false })
    if (!info) throw new PlatformArtifactError(`manifest migration missing on disk: ${name}`)
    if (info.isSymbolicLink()) throw new PlatformArtifactError(`migration is a symlink: ${name}`)
    if (!info.isFile()) throw new PlatformArtifactError(`migration is not a regular file: ${name}`)
    if (info.size > MAX_MIGRATION_BYTES) throw new PlatformArtifactError(`migration exceeds size bound: ${name}`)
    if (sha256Hex(readFileSync(filePath)) !== sha256) {
      throw new PlatformArtifactError(`digest mismatch for ${name}`)
    }
  }
}
```

**6. `packages/platform/src/index.ts`:**

```ts
export {
  PlatformArtifactError,
  verifyPlatformArtifact,
  type PlatformManifest,
  type PlatformManifestEntry,
} from './verify.ts'
```

**7. `packages/platform/src/build.ts`** (snapshots the whole ordered migration stream, self-verifies):

```ts
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPlatformArtifact, type PlatformManifest } from './verify.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const repoRoot = join(packageDir, '..', '..')
const sourceMigrations = join(repoRoot, 'supabase', 'migrations')
const outDir = join(packageDir, 'dist')
const outMigrations = join(outDir, 'migrations')

function platformVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const version = (pkg as { version?: unknown }).version
  if (typeof version !== 'string') throw new Error('@movp/platform package.json has no string version')
  return version
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function main(): void {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outMigrations, { recursive: true })

  const files = readdirSync(sourceMigrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const manifest: PlatformManifest = {
    platformVersion: platformVersion(),
    files: files.map((name) => {
      const bytes = readFileSync(join(sourceMigrations, name))
      copyFileSync(join(sourceMigrations, name), join(outMigrations, name))
      return { name, sha256: sha256Hex(bytes) }
    }),
  }

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  verifyPlatformArtifact(outDir)
  console.log(`@movp/platform: bundled ${manifest.files.length} migrations (platformVersion ${manifest.platformVersion})`)
}

main()
```

**8. Write the failing test** `packages/platform/test/verify.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPlatformArtifact } from '../src/verify.ts'

function sha(body: string): string {
  return createHash('sha256').update(Buffer.from(body)).digest('hex')
}

const files = [
  { name: '20260701000001_a.sql', body: '-- a\n' },
  { name: '20260701000002_b.sql', body: '-- b\n' },
]

function writeArtifact(dir: string, order?: string[]): void {
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  for (const f of files) writeFileSync(join(dir, 'migrations', f.name), f.body)
  const manifestFiles = (order ?? files.map((f) => f.name)).map((name) => ({
    name,
    sha256: sha(files.find((f) => f.name === name)!.body),
  }))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ platformVersion: '0.0.0', files: manifestFiles }, null, 2),
  )
}

describe('verifyPlatformArtifact', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'movp-platform-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a well-formed artifact', () => {
    writeArtifact(dir)
    expect(() => verifyPlatformArtifact(dir)).not.toThrow()
  })

  it('rejects a missing migration', () => {
    writeArtifact(dir)
    rmSync(join(dir, 'migrations', '20260701000002_b.sql'))
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects an extra migration not in the manifest', () => {
    writeArtifact(dir)
    writeFileSync(join(dir, 'migrations', '20260701000003_c.sql'), '-- c\n')
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a reordered manifest', () => {
    writeArtifact(dir, ['20260701000002_b.sql', '20260701000001_a.sql'])
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a digest mismatch', () => {
    writeArtifact(dir)
    writeFileSync(join(dir, 'migrations', '20260701000001_a.sql'), '-- tampered\n')
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a symlinked migration even when its target bytes match', () => {
    writeArtifact(dir)
    const outside = join(dir, 'outside.sql')
    writeFileSync(outside, '-- a\n')
    rmSync(join(dir, 'migrations', '20260701000001_a.sql'))
    symlinkSync(outside, join(dir, 'migrations', '20260701000001_a.sql'))
    expect(() => verifyPlatformArtifact(dir)).toThrow(/symlink/)
  })
})
```

Run it — **Expected: FAIL** (`Cannot find module '../src/verify.ts'` before step 5 is saved; after
5–7, run again and it PASSES):

```
pnpm install \
  && pnpm --filter @movp/platform exec vitest run
```

(`pnpm install` links the new workspace package; `packages/*` is already globbed by
`pnpm-workspace.yaml`.)

**9. Build the real artifact** to prove the whole migration stream snapshots + self-verifies:

```
pnpm --filter @movp/platform build
```

**Expected:** prints `@movp/platform: bundled 42 migrations (platformVersion 0.0.0)` (41 pre-existing +
the new `20260713000001_metadata_layer.sql`), and `packages/platform/dist/manifest.json` +
`packages/platform/dist/migrations/` exist. `dist/` is gitignored.

**10. Commit** (`feat(c6a): @movp/platform artifact build + verifier`).

### Gate (machine-checkable)

```
pnpm --filter @movp/platform test \
  && pnpm --filter @movp/platform typecheck \
  && pnpm --filter @movp/platform build \
  && node -e "require('node:fs').accessSync('packages/platform/dist/manifest.json')"
```

**Expected:** verifier suite green (6 tests); typecheck green; build prints the bundle line;
`manifest.json` present.

---

## Task 4 — Committed consumer fixture + `db reset` gate

Prove a downstream project installs the platform bundle + one project extension, resets green with no
source-repo paths, and leaves platform metadata (`layer='platform'`) byte-identical whether or not the
extension is present.

### Files

- **Create:** `fixtures/platform-consumer/supabase/config.toml`
- **Create:** `fixtures/platform-consumer/supabase/.gitignore`
- **Create:** `fixtures/platform-consumer/extension/20260714000001_contact_extension.sql`
- **Create:** `fixtures/platform-consumer/gate.sh` (executable)
- **Create:** `fixtures/platform-consumer/README.md`

### Interfaces

- **Consumes:** `@movp/platform` build output (`packages/platform/dist/`) and `verifyPlatformArtifact`
  (Task 3); the `layer` column DDL (Task 1); the project-layer metadata byte shape (Task 1's emitter).
- **Produces:** the C6a acceptance evidence (design gates 1–3). No cross-part API.

### Steps

**1. `fixtures/platform-consumer/supabase/config.toml`** — port-isolated (`+100` block), non-DB
services disabled so `supabase db reset` is a light pure-Postgres run (per `CLAUDE.md`, storage may be
disabled for pure-Postgres DB gates):

```toml
project_id = "movp-c6a-consumer"

[api]
enabled = false

[db]
port = 64422
shadow_port = 64420
major_version = 17

[db.migrations]
enabled = true
schema_paths = []

[db.seed]
enabled = false

[db.pooler]
enabled = false
port = 64429

[realtime]
enabled = false

[studio]
enabled = false
port = 64423

[storage]
enabled = false

[auth]
enabled = false

[analytics]
enabled = false

[edge_runtime]
enabled = false
```

**2. `fixtures/platform-consumer/supabase/.gitignore`** — the platform bundle is materialized at gate
time, not committed (proving the scaffold copies it in, not a source-repo path):

```
migrations/
```

**3. `fixtures/platform-consumer/extension/20260714000001_contact_extension.sql`** — a hand-authored
project extension whose metadata bytes match exactly what Task 1's emitter produces for a
`layer='project'` collection (sorts AFTER the entire platform stream, so the `layer` column already
exists):

```sql
-- Project extension fixture: a `contact` collection tagged layer='project'.
-- Byte shape of the metadata upserts mirrors emit-sql.ts collectionMetadataSql for a project layer.
create table if not exists public.contact (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  full_name text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.contact enable row level security;
grant select, insert, update, delete on public.contact to authenticated;
grant select, insert, update, delete on public.contact to service_role;
create policy contact_rw on public.contact for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

insert into public.movp_collections (name, label, label_plural, workspace_scoped, layer)
values ('contact', 'Contact', 'Contacts', true, 'project')
on conflict (name) do update set label = excluded.label, label_plural = excluded.label_plural, workspace_scoped = excluded.workspace_scoped, layer = excluded.layer;

insert into public.movp_fields (collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer)
values
  ('contact', 'full_name', 'text', 'Full name', null, null, false, false, 'project'),
  ('contact', 'email', 'text', 'Email', null, null, false, false, 'project')
on conflict (collection_name, name) do update set
  type = excluded.type,
  label = excluded.label,
  cardinality = excluded.cardinality,
  reporting_role = excluded.reporting_role,
  searchable = excluded.searchable,
  embeddable = excluded.embeddable,
  layer = excluded.layer;
```

**4. `fixtures/platform-consumer/gate.sh`** (mark executable: `chmod +x`). Requires a running Docker +
the Supabase CLI + `psql` on PATH:

```bash
#!/usr/bin/env bash
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$FIXTURE_DIR/../.." && pwd)"
PLATFORM_DIST="$REPO_ROOT/packages/platform/dist"
MIGRATIONS="$FIXTURE_DIR/supabase/migrations"
DB_URL="postgresql://postgres:postgres@127.0.0.1:64422/postgres"

# Platform-metadata digest: canonical, order-stable projection of layer='platform' rows only.
platform_digest() {
  psql "$DB_URL" -tAqc "
    with c as (
      select string_agg(name||'|'||label||'|'||label_plural||'|'||workspace_scoped||'|'||layer, ',' order by name) t
      from public.movp_collections where layer = 'platform'
    ), f as (
      select string_agg(collection_name||'.'||name||'|'||type||'|'||coalesce(cardinality,'')||'|'||layer, ',' order by collection_name, name) t
      from public.movp_fields where layer = 'platform'
    )
    select md5(coalesce((select t from c),'')||'::'||coalesce((select t from f),''));"
}

# 1. Build + independently verify the platform artifact.
pnpm --filter @movp/platform build
node --input-type=module -e "import { verifyPlatformArtifact } from '$REPO_ROOT/packages/platform/src/verify.ts'; verifyPlatformArtifact('$PLATFORM_DIST'); console.log('artifact ok')" || {
  echo "gate: verifyPlatformArtifact failed" >&2; exit 1;
}

# 2. Materialize the platform bundle into the fixture by COPY (never symlink; no source-repo paths).
rm -rf "$MIGRATIONS"; mkdir -p "$MIGRATIONS"
cp "$PLATFORM_DIST/migrations/"*.sql "$MIGRATIONS/"

# 3. Assert no source-repo path leaked into the materialized migrations.
if grep -rEl '\.\./|/Code/supasuite|packages/[a-z]' "$MIGRATIONS" >/dev/null; then
  echo "gate: source-repo path found in fixture migrations" >&2; exit 1;
fi

# 4. Reset WITHOUT the extension; capture the platform digest.
( cd "$FIXTURE_DIR" && supabase db reset )
DIGEST_BASE="$(platform_digest)"
echo "platform digest (no extension): $DIGEST_BASE"

# 5. Add the project extension, reset again; capture the platform digest + assert the project row.
cp "$FIXTURE_DIR/extension/"*.sql "$MIGRATIONS/"
( cd "$FIXTURE_DIR" && supabase db reset )
DIGEST_EXT="$(platform_digest)"
echo "platform digest (with extension): $DIGEST_EXT"

PROJECT_COUNT="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='project' and name='contact';")"
if [ "$PROJECT_COUNT" != "1" ]; then
  echo "gate: expected exactly one project collection 'contact', got $PROJECT_COUNT" >&2; exit 1;
fi

# 6. Platform metadata must be byte-intact whether or not the extension is present.
if [ "$DIGEST_BASE" != "$DIGEST_EXT" ]; then
  echo "gate: platform metadata digest changed after adding the extension" >&2; exit 1;
fi

echo "gate: platform-consumer fixture PASS"
```

**5. `fixtures/platform-consumer/README.md`** — one paragraph: what the fixture proves (design C6a gates
1–3), the prerequisites (Docker, Supabase CLI, `psql`), and the single command `bash gate.sh`. Note that
`supabase/migrations/` is git-ignored and materialized from `@movp/platform`'s `dist/` at gate time.

**6. Run the gate.** **Expected output** (tail):

```
platform digest (no extension): <32-hex>
platform digest (with extension): <32-hex>   # identical to the line above
gate: platform-consumer fixture PASS
```

Run:

```
bash fixtures/platform-consumer/gate.sh
```

**7. Commit** (`test(c6a): platform-consumer fixture + db reset gate`).

### Gate (machine-checkable)

```
bash fixtures/platform-consumer/gate.sh
```

**Expected:** exit 0; the two platform-digest lines are byte-identical; final line
`gate: platform-consumer fixture PASS`. (Environment prerequisites: Docker running, `supabase` and
`psql` on PATH. If the main monorepo stack is up, this fixture still runs — it binds the isolated `+100`
port block.)

---

## Assumptions

1. **"Removing an extension field leaves `layer='platform'` metadata byte-intact"** is realized as a
   two-reset platform-metadata digest comparison (with vs. without the extension migration). In C6a the
   extension is hand-authored SQL (project codegen's stale-row / removal semantics are C6c), so the
   with/without digest equality is the faithful, in-scope proxy for "the extension emits only its own
   DDL and never touches platform rows."
2. **Applied order == lexicographic filename order.** `verifyPlatformArtifact` treats the manifest as
   canonical-ordered iff it equals the lexicographic sort of the filenames — which is exactly how the
   Supabase CLI applies migrations, and how interleaved `*_movp_generated*.sql` files sort by timestamp.
3. **`platformVersion` = `@movp/platform`'s `package.json` version (`0.0.0` in C6a).** The `0.0.0 → 0.1.0`
   publishable-package bump is explicitly a C6d concern and is out of scope here.
4. **The fixture uses `psql`.** If the executor's environment lacks a `psql` client, install the Postgres
   client (the Supabase local stack image bundles one) before running `gate.sh`.
