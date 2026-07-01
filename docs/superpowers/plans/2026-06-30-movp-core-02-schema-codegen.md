# MOVP Core — Schema DSL & Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the config-first data-model DSL `@movp/core-schema` (the single source of truth — `FieldDef`/`CollectionDef`/`MovpSchema` types, the `f` field-builder registry, `defineCollection`/`defineSchema`, and the `note` + `tag` example collections), then `@movp/codegen` (pure SQL/TS emit transforms) plus `scripts/codegen.ts` and a root `pnpm codegen`. The deliverable: `pnpm codegen` writes a generated migration + generated TS types; `supabase db reset` applies it cleanly; a pgTAP test proves the generated `note`/`tag` tables, FTS columns, shared `search_chunk` + `match_chunks`, `edges`, `movp_jobs` (in `movp_internal`, denied to `authenticated`), and the metadata-registry rows all exist with correct RLS; `supabase db diff` is empty (drift gate).

**Architecture:** `@movp/core-schema` is a runtime-agnostic, dependency-free TS package describing collections as typed config. `@movp/codegen` is a set of pure transforms (`schema → SQL string`, `schema → TS string`) plus a thin Node script (`scripts/codegen.ts`, run via `tsx`) that writes the two generated artifacts to disk. The Supabase CLI remains the only migration applier: codegen emits **one coherent migration** (`supabase/migrations/<ts>_movp_generated.sql`) and the generated row/create/update types (`packages/domain/src/generated/types.ts`, consumed by `@movp/domain` in Plan 3). Shared search/graph/jobs/metadata infrastructure is emitted **once**; per-collection DDL (table, FTS, RLS, embed-enqueue triggers, metadata rows) is emitted per collection.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest (string-contains/unit tests on pure emitters), `tsx` (run the codegen script), Supabase CLI (`db reset`, `test db`, `db diff`, pgTAP), pgvector/pgcrypto extensions (HNSW, `digest`).

**This plan is Plan 2 of the Phase 1 (MOVP Core) series.** The full north-star + Phase 1 design lives at `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`; it covers design Build-sequence Tasks 3–4. Plan 1 (`docs/superpowers/plans/2026-06-30-movp-core-foundation.md`) already created the monorepo scaffold, the local Supabase stack, `public.workspace`, `public.workspace_membership`, the hardened `public.is_workspace_member(uuid)` RLS helper, and `@movp/auth`. Plan 3 (Domain Core) consumes the types this plan generates; Plan 5 (Search & Async) owns the `movp_jobs` worker, `movp_events`, and webhooks DDL — **this plan does not emit `movp_events` or webhooks**.

## Global Constraints

- **Runtime-agnostic, dependency-free core:** `@movp/core-schema` imports nothing Node- or Deno-only and has no runtime dependencies. `@movp/codegen` depends only on `@movp/core-schema` types. Use bare specifiers for cross-package imports (`@movp/core-schema`); use explicit `.ts` extensions for relative intra-package imports (so Deno/bundler resolve them). `tsconfig.base.json` (from Plan 1) sets `moduleResolution: "bundler"` + `allowImportingTsExtensions: true` + `noEmit: true` — source is consumed directly, never tsc-emitted.
- **Codegen is a pure transform.** `emitSqlMigration` / `emitSharedInfraSql` / `emitCollectionSql` / `emitTypes` are pure functions of their input (no I/O, no env, no clock). Only `scripts/codegen.ts` touches the filesystem. This keeps emitters unit-testable and deterministic.
- **One source of truth.** The DB schema and the TS types are *generated* from `@movp/core-schema`; never hand-edit `supabase/migrations/<ts>_movp_generated.sql` or `packages/domain/src/generated/types.ts`. Both carry a `do not edit by hand` header.
- **Supabase CLI is the only migration applier.** `pnpm codegen` writes SQL into `supabase/migrations/`; `supabase db reset` applies it; `supabase db diff` is the drift gate (must be empty).
- **User references use `f.uuid`, never `relation('user')`.** There is no cross-schema FK to `auth.users`; a user-referencing field is a plain `uuid` column whose workspace-membership validity is enforced by RLS / a trigger (per Core invariant: authoritative authz at the data boundary). The `relation` builder targets MOVP collections only.
- **Relation → storage mapping (used by every downstream app phase):** a `relation` field with `cardinality` `'many-to-one'` or `'one-to-one'` emits a real FK column `<field>_id uuid references public.<target>(id)` (required → `on delete cascade`, optional → `on delete set null`) and surfaces in generated types as `<field>_id: string`; `'one-to-many'` is the inverse side (no column); `'many-to-many'` (with `graph: true`) uses the typed `edges` graph. Field types include `json` (`→ jsonb`, TS `Record<string, unknown>`) and `date` (`→ date`, TS `string`).
- **Idempotent codegen.** Re-running `pnpm codegen` overwrites the single existing `*_movp_generated.sql` file (it does not mint a new timestamped file each run) so the migration set — and therefore the drift gate — stays stable across reruns.
- **All `SECURITY DEFINER` functions are hardened:** `set search_path = ''`, every non-`pg_catalog` object fully schema-qualified (`movp_internal.*`, `public.*`, `extensions.*`), `execute` revoked from `public`/`anon`/`authenticated` (the embed triggers run as system writers to the internal queue). The FTS maintenance trigger is a plain `security invoker` function (it only mutates `NEW` on the row being written) and is intentionally **not** `SECURITY DEFINER`. `match_chunks` is `security invoker` so RLS still applies.
- **Internal-table isolation.** `movp_internal.movp_jobs` lives in the `movp_internal` schema, which must be **excluded** from `config.toml [api] schemas`; RLS enabled deny-all (no policy), all privileges revoked from `anon`/`authenticated`, granted only to `service_role`.
- **Public values** (project ref, region) are literals; only credentials are secrets.
- **Observability discipline:** never log field values or PII — names/codes only. (No new failure paths emit logs in this plan; emitters are pure and the script logs only file paths.)

## File Structure

```
supasuite/
  package.json                         # EDIT: add `codegen` script, tsx + @movp/{core-schema,codegen} workspace devDeps
  supabase/
    config.toml                        # EDIT: ensure [api] schemas excludes movp_internal
    migrations/
      <ts>_bootstrap_tenancy.sql       # from Plan 1 (unchanged)
      <ts>_movp_generated.sql          # GENERATED by `pnpm codegen` (Task 4)
    tests/
      tenancy_test.sql                 # from Plan 1 (unchanged)
      generated_schema_test.sql        # pgTAP for the generated schema (Task 5)
  scripts/
    codegen.ts                         # tsx script: schema -> migration + types (Task 4)
  packages/
    core-schema/
      package.json  tsconfig.json  vitest.config.ts
      src/
        index.ts                       # re-exports
        types.ts                       # Cardinality/ReportingRole/FieldType/FieldDef/CollectionDef/MovpSchema
        builders.ts                    # `f` field-builder registry + FieldOptions
        define.ts                      # defineCollection / defineSchema (+ validation)
        schema.ts                      # `export const schema = defineSchema([note, tag])`
        collections/
          note.ts                      # the example collection
          tag.ts                       # the example collection
      test/
        builders.test.ts               # f.* + defineCollection validation
        schema.test.ts                 # note/tag definitions + defineSchema aggregate
    codegen/
      package.json  tsconfig.json  vitest.config.ts
      src/
        index.ts                       # re-exports the 4 emit functions
        emit-sql.ts                    # emitSharedInfraSql / emitCollectionSql / emitSqlMigration
        emit-types.ts                  # emitTypes
      test/
        emit-sql.test.ts               # string-contains assertions on emitted SQL
        emit-types.test.ts             # string-contains assertions on emitted TS
    domain/
      src/generated/
        types.ts                       # GENERATED by `pnpm codegen` (Task 4); the @movp/domain package proper is Plan 3
```

---

### Task 1: `@movp/core-schema` — types, `f` builders, `defineCollection`/`defineSchema`

**Files:**
- Create: `packages/core-schema/package.json`, `packages/core-schema/tsconfig.json`, `packages/core-schema/vitest.config.ts`
- Create: `packages/core-schema/src/types.ts`, `packages/core-schema/src/builders.ts`, `packages/core-schema/src/define.ts`, `packages/core-schema/src/index.ts`
- Test: `packages/core-schema/test/builders.test.ts`

**Interfaces:**
- Consumes: nothing (pure library; no earlier-task dependency).
- Produces (relied on by `@movp/codegen`, and by `@movp/domain`/`@movp/graphql` later):
  - `type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'`
  - `type ReportingRole = 'dimension' | 'measure'`
  - `type FieldType = 'text' | 'richText' | 'enum' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'uuid' | 'relation'`
  - `interface FieldDef { type: FieldType; label: string; description?: string; required?: boolean; default?: string | number | boolean; searchable?: boolean; embeddable?: boolean; reporting?: { role: ReportingRole }; values?: string[]; target?: string; cardinality?: Cardinality; graph?: boolean }`
  - `interface CollectionDef { name: string; label: string; labelPlural: string; workspaceScoped: boolean; fields: Record<string, FieldDef> }`
  - `interface MovpSchema { collections: CollectionDef[] }`
  - `type FieldOptions = Omit<FieldDef, 'type' | 'values' | 'target'>`
  - `const f: { text; richText; enum(values, o); number; boolean; date; datetime; json; uuid; relation(target, o) }` (each `(o: FieldOptions) => FieldDef` unless shown otherwise)
  - `defineCollection(def: CollectionDef): CollectionDef`
  - `defineSchema(collections: CollectionDef[]): MovpSchema`

- [ ] **Step 1: Create the package skeleton**

`packages/core-schema/package.json`:
```json
{
  "name": "@movp/core-schema",
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

`packages/core-schema/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/core-schema/vitest.config.ts`:
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
Expected: installs `vitest` into the workspace; `@movp/core-schema` is linked.

- [ ] **Step 2: Write the failing test (`f` builders + `defineCollection` validation)**

`packages/core-schema/test/builders.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { f } from '../src/builders.ts'
import { defineCollection } from '../src/define.ts'

describe('f field builders', () => {
  it('text sets type and carries options', () => {
    expect(f.text({ label: 'Title', required: true, searchable: true })).toEqual({
      type: 'text', label: 'Title', required: true, searchable: true,
    })
  })
  it('enum injects values + type', () => {
    expect(f.enum(['a', 'b'], { label: 'S', default: 'a' })).toEqual({
      type: 'enum', values: ['a', 'b'], label: 'S', default: 'a',
    })
  })
  it('relation injects target + type', () => {
    expect(f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true })).toEqual({
      type: 'relation', target: 'tag', label: 'Tags', cardinality: 'many-to-many', graph: true,
    })
  })
  it('the remaining builders set their type', () => {
    expect(f.richText({ label: 'B' }).type).toBe('richText')
    expect(f.number({ label: 'N' }).type).toBe('number')
    expect(f.boolean({ label: 'Bn' }).type).toBe('boolean')
    expect(f.datetime({ label: 'D' }).type).toBe('datetime')
    expect(f.uuid({ label: 'U' }).type).toBe('uuid')
  })
})

describe('defineCollection validation', () => {
  const base = { name: 'note', label: 'Note', labelPlural: 'Notes', workspaceScoped: true }
  it('accepts a valid collection and returns it unchanged', () => {
    const def = { ...base, fields: { title: f.text({ label: 'T' }) } }
    expect(defineCollection(def)).toBe(def)
  })
  it('rejects an invalid (non-snake_case) collection name', () => {
    expect(() => defineCollection({ ...base, name: 'Note', fields: {} })).toThrow(/collection name/)
  })
  it('rejects a field with no label', () => {
    expect(() => defineCollection({ ...base, fields: { title: { type: 'text', label: '' } } }))
      .toThrow(/requires a label/)
  })
  it('rejects an enum with empty values', () => {
    expect(() => defineCollection({ ...base, fields: { s: { type: 'enum', label: 'S', values: [] } } }))
      .toThrow(/non-empty values/)
  })
  it('rejects a relation with no target', () => {
    expect(() => defineCollection({
      ...base, fields: { r: { type: 'relation', label: 'R', cardinality: 'one-to-many' } },
    })).toThrow(/requires a target/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/core-schema test
```
Expected: FAIL — cannot resolve `../src/builders.ts` / `../src/define.ts` (modules not created yet).

- [ ] **Step 4: Implement the types, builders, and define helpers**

`packages/core-schema/src/types.ts`:
```ts
// 'many-to-one' / 'one-to-one' → this row holds a FK column (`<field>_id`).
// 'one-to-many' → inverse side (FK lives on the other collection; no column here).
// 'many-to-many' → the typed `edges` graph (set `graph: true`).
export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
export type ReportingRole = 'dimension' | 'measure'
export type FieldType =
  | 'text'
  | 'richText'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'date'      // date-only → `date`
  | 'datetime'  // timestamp → `timestamptz`
  | 'json'      // → `jsonb`
  | 'uuid'
  | 'relation'

export interface FieldDef {
  type: FieldType
  label: string
  description?: string
  required?: boolean
  default?: string | number | boolean
  searchable?: boolean
  embeddable?: boolean
  reporting?: { role: ReportingRole }
  values?: string[]
  target?: string
  cardinality?: Cardinality
  graph?: boolean
}

export interface CollectionDef {
  name: string
  label: string
  labelPlural: string
  workspaceScoped: boolean
  fields: Record<string, FieldDef>
}

export interface MovpSchema {
  collections: CollectionDef[]
}
```

`packages/core-schema/src/builders.ts`:
```ts
import type { FieldDef } from './types.ts'

// `o` omits the keys the builder itself fills in (`type`, and `values`/`target`).
export type FieldOptions = Omit<FieldDef, 'type' | 'values' | 'target'>

export const f = {
  text: (o: FieldOptions): FieldDef => ({ type: 'text', ...o }),
  richText: (o: FieldOptions): FieldDef => ({ type: 'richText', ...o }),
  enum: (values: string[], o: FieldOptions): FieldDef => ({ type: 'enum', values, ...o }),
  number: (o: FieldOptions): FieldDef => ({ type: 'number', ...o }),
  boolean: (o: FieldOptions): FieldDef => ({ type: 'boolean', ...o }),
  date: (o: FieldOptions): FieldDef => ({ type: 'date', ...o }),
  datetime: (o: FieldOptions): FieldDef => ({ type: 'datetime', ...o }),
  json: (o: FieldOptions): FieldDef => ({ type: 'json', ...o }),
  uuid: (o: FieldOptions): FieldDef => ({ type: 'uuid', ...o }),
  // A user reference is `f.uuid` (NOT relation('user')): no cross-schema FK to
  // auth.users; workspace membership is validated by RLS/trigger. See Global Constraints.
  relation: (target: string, o: FieldOptions): FieldDef => ({ type: 'relation', target, ...o }),
}
```

`packages/core-schema/src/define.ts`:
```ts
import type { CollectionDef, MovpSchema } from './types.ts'

// Lowercase SQL identifier: starts with a letter, then letters/digits/underscores.
const IDENT = /^[a-z][a-z0-9_]*$/

export function defineCollection(def: CollectionDef): CollectionDef {
  if (!IDENT.test(def.name)) {
    throw new Error(`collection name must be snake_case matching ${IDENT} (got "${def.name}")`)
  }
  if (!def.label || !def.labelPlural) {
    throw new Error(`collection "${def.name}" requires both label and labelPlural`)
  }
  for (const [fname, field] of Object.entries(def.fields)) {
    if (!IDENT.test(fname)) {
      throw new Error(`field name must be snake_case matching ${IDENT} (got "${fname}" in "${def.name}")`)
    }
    if (!field.label) {
      throw new Error(`field "${def.name}.${fname}" requires a label`)
    }
    if (field.type === 'enum' && (!field.values || field.values.length === 0)) {
      throw new Error(`enum field "${def.name}.${fname}" requires non-empty values`)
    }
    if (field.type === 'relation') {
      if (!field.target) {
        throw new Error(`relation field "${def.name}.${fname}" requires a target`)
      }
      if (!field.cardinality) {
        throw new Error(`relation field "${def.name}.${fname}" requires a cardinality`)
      }
    }
  }
  return def
}

export function defineSchema(collections: CollectionDef[]): MovpSchema {
  const names = new Set<string>()
  for (const c of collections) {
    if (names.has(c.name)) {
      throw new Error(`duplicate collection name "${c.name}"`)
    }
    names.add(c.name)
  }
  // Targets are resolved against the full set, so collection order does not matter.
  for (const c of collections) {
    for (const [fname, field] of Object.entries(c.fields)) {
      if (field.type === 'relation' && field.target && !names.has(field.target)) {
        throw new Error(`relation "${c.name}.${fname}" targets unknown collection "${field.target}"`)
      }
    }
  }
  return { collections }
}
```

`packages/core-schema/src/index.ts`:
```ts
export type {
  Cardinality,
  ReportingRole,
  FieldType,
  FieldDef,
  CollectionDef,
  MovpSchema,
} from './types.ts'
export { f, type FieldOptions } from './builders.ts'
export { defineCollection, defineSchema } from './define.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm --filter @movp/core-schema test
```
Expected: PASS — all 9 cases green (4 builder + 5 validation).

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @movp/core-schema typecheck
```
Expected: PASS — no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/ensell/Code/supasuite
git add packages/core-schema pnpm-lock.yaml
git commit -m "feat(core-schema): field-type DSL, f builder registry, defineCollection/defineSchema"
```

---

### Task 2: `note` + `tag` example collections + `schema` aggregate

**Files:**
- Create: `packages/core-schema/src/collections/note.ts`, `packages/core-schema/src/collections/tag.ts`, `packages/core-schema/src/schema.ts`
- Edit: `packages/core-schema/src/index.ts` (re-export `note`, `tag`, `schema`)
- Test: `packages/core-schema/test/schema.test.ts`

**Interfaces:**
- Consumes: `defineCollection`, `defineSchema`, `f` (Task 1).
- Produces (consumed by `@movp/codegen` and the codegen script):
  - `export const note: CollectionDef` — `workspaceScoped: true`; fields `title` (`text`, required, searchable), `body` (`richText`, searchable, embeddable), `status` (`enum` `['draft','published','archived']`, default `'draft'`, `reporting.role: 'dimension'`), `tags` (`relation('tag')`, `cardinality: 'many-to-many'`, `graph: true`).
  - `export const tag: CollectionDef` — `workspaceScoped: true`; field `name` (`text`, required, searchable).
  - `export const schema: MovpSchema` — `defineSchema([note, tag])`.

- [ ] **Step 1: Write the failing test**

`packages/core-schema/test/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { schema } from '../src/schema.ts'
import { note } from '../src/collections/note.ts'
import { tag } from '../src/collections/tag.ts'
import { defineSchema } from '../src/define.ts'

describe('example collections', () => {
  it('note has the expected workspace-scoped fields', () => {
    expect(note.name).toBe('note')
    expect(note.label).toBe('Note')
    expect(note.labelPlural).toBe('Notes')
    expect(note.workspaceScoped).toBe(true)
    expect(note.fields.title).toEqual({ type: 'text', label: 'Title', required: true, searchable: true })
    expect(note.fields.body).toEqual({ type: 'richText', label: 'Body', searchable: true, embeddable: true })
    expect(note.fields.status.values).toEqual(['draft', 'published', 'archived'])
    expect(note.fields.status.default).toBe('draft')
    expect(note.fields.status.reporting).toEqual({ role: 'dimension' })
    expect(note.fields.tags).toEqual({
      type: 'relation', target: 'tag', label: 'Tags', cardinality: 'many-to-many', graph: true,
    })
  })
  it('tag has a required searchable name', () => {
    expect(tag.name).toBe('tag')
    expect(tag.workspaceScoped).toBe(true)
    expect(tag.fields.name).toEqual({ type: 'text', label: 'Name', required: true, searchable: true })
  })
})

describe('defineSchema aggregate', () => {
  it('aggregates the collections in order', () => {
    expect(schema.collections.map((c) => c.name)).toEqual(['note', 'tag'])
  })
  it('rejects duplicate collection names', () => {
    expect(() => defineSchema([tag, tag])).toThrow(/duplicate/)
  })
  it('rejects a relation to a collection not in the set', () => {
    expect(() => defineSchema([note])).toThrow(/unknown collection "tag"/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/core-schema test
```
Expected: FAIL — cannot resolve `../src/schema.ts` / `../src/collections/note.ts` / `../src/collections/tag.ts`.

- [ ] **Step 3: Implement the collections + aggregate**

`packages/core-schema/src/collections/note.ts`:
```ts
import { defineCollection } from '../define.ts'
import { f } from '../builders.ts'

export const note = defineCollection({
  name: 'note',
  label: 'Note',
  labelPlural: 'Notes',
  workspaceScoped: true,
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    body: f.richText({ label: 'Body', searchable: true, embeddable: true }),
    status: f.enum(['draft', 'published', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
    tags: f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true }),
  },
})
```

`packages/core-schema/src/collections/tag.ts`:
```ts
import { defineCollection } from '../define.ts'
import { f } from '../builders.ts'

export const tag = defineCollection({
  name: 'tag',
  label: 'Tag',
  labelPlural: 'Tags',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
  },
})
```

`packages/core-schema/src/schema.ts`:
```ts
import { defineSchema } from './define.ts'
import { note } from './collections/note.ts'
import { tag } from './collections/tag.ts'

// `defineSchema` resolves relation targets against the full set, so [note, tag]
// (note -> tag) validates regardless of order.
export const schema = defineSchema([note, tag])
```

Replace `packages/core-schema/src/index.ts` with:
```ts
export type {
  Cardinality,
  ReportingRole,
  FieldType,
  FieldDef,
  CollectionDef,
  MovpSchema,
} from './types.ts'
export { f, type FieldOptions } from './builders.ts'
export { defineCollection, defineSchema } from './define.ts'
export { note } from './collections/note.ts'
export { tag } from './collections/tag.ts'
export { schema } from './schema.ts'
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm --filter @movp/core-schema test
```
Expected: PASS — all suites green (Task 1's 9 + Task 2's 5 = 14 cases).

- [ ] **Step 5: Typecheck**

Run:
```bash
pnpm --filter @movp/core-schema typecheck
```
Expected: PASS — no type errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/ensell/Code/supasuite
git add packages/core-schema
git commit -m "feat(core-schema): note + tag example collections and schema aggregate"
```

---

### Task 3: `@movp/codegen` — SQL + TS emit transforms

**Files:**
- Create: `packages/codegen/package.json`, `packages/codegen/tsconfig.json`, `packages/codegen/vitest.config.ts`
- Create: `packages/codegen/src/emit-sql.ts`, `packages/codegen/src/emit-types.ts`, `packages/codegen/src/index.ts`
- Test: `packages/codegen/test/emit-sql.test.ts`, `packages/codegen/test/emit-types.test.ts`

**Interfaces:**
- Consumes: `@movp/core-schema` types + `schema`/`note` exports (Tasks 1–2).
- Produces (consumed by `scripts/codegen.ts` in Task 4; the SQL is applied by the Supabase CLI; the TS is consumed by `@movp/domain` in Plan 3):
  - `emitSqlMigration(schema: MovpSchema): string` — full migration = header + shared infra + each collection's DDL.
  - `emitSharedInfraSql(): string` — emitted once: `extensions.vector`/`pgcrypto`, `movp_internal` schema, metadata-registry tables, `movp_internal.movp_jobs`, `public.search_chunk` (+ HNSW), `public.match_chunks`, `public.edges`.
  - `emitCollectionSql(c: CollectionDef): string` — per collection: table (+ enum CHECKs, `search_vector`), FTS GIN index + trigger, RLS, embed-enqueue + delete-cleanup `SECURITY DEFINER` triggers, metadata-registry `INSERT`s.
  - `emitTypes(schema: MovpSchema): string` — generated `<Pascal>Row` / `<Pascal>Create` / `<Pascal>Update` interfaces (many-to-many relations excluded; FK relations surface as `<field>_id: string`). Reproduces exactly: `NoteRow{id:string,workspace_id:string,title:string,body:string|null,status:'draft'|'published'|'archived',created_at:string,updated_at:string}`; `NoteCreate{workspace_id:string,title:string,body?:string,status?:'draft'|'published'|'archived'}`; `NoteUpdate{title?:string,body?:string,status?:'draft'|'published'|'archived'}`; `TagRow{id,workspace_id,name,created_at,updated_at}`; `TagCreate{workspace_id,name}`; `TagUpdate{name?}`.

- [ ] **Step 1: Create the package skeleton**

`packages/codegen/package.json`:
```json
{
  "name": "@movp/codegen",
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
    "@movp/core-schema": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/codegen/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/codegen/vitest.config.ts`:
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
Expected: `@movp/codegen` is linked and resolves `@movp/core-schema` via the workspace.

- [ ] **Step 2: Write the failing tests**

`packages/codegen/test/emit-sql.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { schema, note } from '@movp/core-schema'
import { emitSharedInfraSql, emitCollectionSql, emitSqlMigration } from '../src/index.ts'

describe('emitSharedInfraSql', () => {
  const sql = emitSharedInfraSql()
  it('enables the vector + pgcrypto extensions and the internal schema', () => {
    expect(sql).toContain('create extension if not exists vector with schema extensions;')
    expect(sql).toContain('create extension if not exists pgcrypto with schema extensions;')
    expect(sql).toContain('create schema if not exists movp_internal;')
  })
  it('creates the internal jobs queue with dedupe + service-role-only grants', () => {
    expect(sql).toContain('create table movp_internal.movp_jobs')
    expect(sql).toContain('create table if not exists movp_internal.movp_job_kind')
    expect(sql).toContain("values ('embed'), ('webhook'), ('notify')")
    expect(sql).toContain('kind text not null references movp_internal.movp_job_kind(kind)')
    expect(sql).toContain("check (status in ('pending', 'running', 'done', 'failed', 'dead'))")
    expect(sql).toContain('unique (kind, idempotency_key)')
    expect(sql).toContain('create index movp_jobs_due on movp_internal.movp_jobs (status, next_run_at, lease_expires_at);')
    expect(sql).toContain('revoke all on movp_internal.movp_jobs from anon, authenticated;')
    expect(sql).toContain('grant all on movp_internal.movp_jobs to service_role;')
  })
  it('creates search_chunk with an HNSW cosine index and member-SELECT RLS', () => {
    expect(sql).toContain('embedding extensions.vector(384) not null')
    expect(sql).toContain('using hnsw (embedding extensions.vector_cosine_ops)')
    expect(sql).toContain('create policy search_chunk_read on public.search_chunk')
    expect(sql).toContain('using (public.is_workspace_member(workspace_id))')
  })
  it('creates match_chunks with iterative scan + clamp (security invoker)', () => {
    expect(sql).toContain('create or replace function public.match_chunks')
    expect(sql).toContain("set hnsw.iterative_scan = 'strict_order'")
    expect(sql).toContain('limit least(greatest(match_count, 1), 50)')
    expect(sql).not.toContain('security definer')
  })
  it('creates the edges graph table + both directional indexes', () => {
    expect(sql).toContain('create table public.edges')
    expect(sql).toContain('create index edges_src_idx on public.edges (src_type, src_id);')
    expect(sql).toContain('create index edges_dst_idx on public.edges (dst_type, dst_id);')
  })
  it('creates the metadata registry tables', () => {
    expect(sql).toContain('create table public.movp_collections')
    expect(sql).toContain('create table public.movp_fields')
  })
})

describe('emitCollectionSql(note)', () => {
  const sql = emitCollectionSql(note)
  it('creates the workspace-scoped table with enum check + FTS column', () => {
    expect(sql).toContain('create table public.note')
    expect(sql).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(sql).toContain('title text not null')
    expect(sql).toContain('body text')
    expect(sql).toContain("status text not null default 'draft' check (status in ('draft', 'published', 'archived'))")
    expect(sql).toContain('search_vector tsvector')
  })
  it('creates the FTS GIN index + maintenance trigger', () => {
    expect(sql).toContain('create index note_search_idx on public.note using gin (search_vector);')
    expect(sql).toContain('create or replace function public.note_search_vector_update()')
    expect(sql).toContain('create trigger note_search_vector_tg')
  })
  it('creates the workspace RLS policy', () => {
    expect(sql).toContain('create policy note_rw on public.note for all to authenticated')
    expect(sql).toContain('with check (public.is_workspace_member(workspace_id))')
  })
  it('creates a hardened SECURITY DEFINER enqueue trigger for the embeddable field', () => {
    expect(sql).toContain('create or replace function public.note_body_enqueue_embed()')
    expect(sql).toContain('security definer')
    expect(sql).toContain("set search_path = ''")
    expect(sql).toContain("v_hash := encode(extensions.digest(coalesce(new.body, ''), 'sha256'), 'hex');")
    expect(sql).toContain('insert into movp_internal.movp_jobs')
    expect(sql).toContain('on conflict (kind, idempotency_key) do nothing;')
    expect(sql).toContain('revoke all on function public.note_body_enqueue_embed() from public, anon, authenticated;')
    expect(sql).toContain('after insert or update on public.note')
  })
  it('creates an after-delete chunk cleanup trigger', () => {
    expect(sql).toContain('create or replace function public.note_delete_chunks()')
    expect(sql).toContain('delete from public.search_chunk')
    expect(sql).toContain('after delete on public.note')
  })
  it('inserts metadata registry rows including the relation + reporting role', () => {
    expect(sql).toContain('insert into public.movp_collections (name, label, label_plural, workspace_scoped)')
    expect(sql).toContain("('note', 'Note', 'Notes', true)")
    expect(sql).toContain("('note', 'title', 'text', 'Title', null, null, true, false)")
    expect(sql).toContain("('note', 'status', 'enum', 'Status', null, 'dimension', false, false)")
    expect(sql).toContain("('note', 'tags', 'relation', 'Tags', 'many-to-many', null, false, false)")
  })
})

describe('emitSqlMigration', () => {
  const sql = emitSqlMigration(schema)
  it('starts with the do-not-edit header', () => {
    expect(sql.startsWith('-- generated by @movp/codegen — do not edit by hand')).toBe(true)
  })
  it('emits shared infra before the collections, and includes tag', () => {
    expect(sql.indexOf('movp_internal.movp_jobs')).toBeLessThan(sql.indexOf('create table public.note'))
    expect(sql).toContain('create table public.tag')
  })
})
```

`packages/codegen/test/emit-types.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { schema } from '@movp/core-schema'
import { emitTypes } from '../src/index.ts'

describe('emitTypes', () => {
  const ts = emitTypes(schema)
  it('starts with the do-not-edit header', () => {
    expect(ts.startsWith('// generated by @movp/codegen — do not edit by hand')).toBe(true)
  })
  it('emits NoteRow with nullable body and a non-null enum status', () => {
    expect(ts).toContain('export interface NoteRow {')
    expect(ts).toContain('  id: string')
    expect(ts).toContain('  workspace_id: string')
    expect(ts).toContain('  title: string')
    expect(ts).toContain('  body: string | null')
    expect(ts).toContain("  status: 'draft' | 'published' | 'archived'")
    expect(ts).toContain('  created_at: string')
    expect(ts).toContain('  updated_at: string')
  })
  it('emits NoteCreate with required title + optional body/status', () => {
    expect(ts).toContain('export interface NoteCreate {')
    expect(ts).toContain('  workspace_id: string')
    expect(ts).toContain('  body?: string')
    expect(ts).toContain("  status?: 'draft' | 'published' | 'archived'")
  })
  it('emits a fully-optional NoteUpdate without workspace_id', () => {
    const block = ts.match(/export interface NoteUpdate \{[^}]*\}/)
    expect(block).not.toBeNull()
    expect(block![0]).toContain('  title?: string')
    expect(block![0]).toContain('  body?: string')
    expect(block![0]).not.toContain('workspace_id')
  })
  it('emits the Tag types', () => {
    expect(ts).toContain('export interface TagRow {')
    expect(ts).toContain('export interface TagCreate {')
    expect(ts).toContain('export interface TagUpdate {')
    expect(ts).toContain('  name?: string')
  })
  it('excludes relation fields from generated types', () => {
    expect(ts).not.toContain('tags')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
pnpm --filter @movp/codegen test
```
Expected: FAIL — cannot resolve `../src/index.ts` (emit modules not created yet).

- [ ] **Step 4: Implement `emit-sql.ts`**

`packages/codegen/src/emit-sql.ts`:
```ts
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'

const HEADER = '-- generated by @movp/codegen — do not edit by hand'

// --- helpers -------------------------------------------------------------

function sqlColumnType(field: FieldDef): string {
  switch (field.type) {
    case 'text':
    case 'richText':
    case 'enum':
      return 'text'
    case 'number':
      return 'numeric'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
      return 'timestamptz'
    case 'json':
      return 'jsonb'
    case 'uuid':
      return 'uuid'
    default:
      return 'text'
  }
}

// A relation is a physical column ONLY when this row holds the FK
// ('many-to-one' or 'one-to-one'). 'one-to-many' is the inverse side (no column);
// 'many-to-many' is expressed via the `edges` graph (graph: true).
function relationHoldsFk(field: FieldDef): boolean {
  return field.type === 'relation' &&
    (field.cardinality === 'many-to-one' || field.cardinality === 'one-to-one')
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function sqlDefaultLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function scalarFields(c: CollectionDef): Array<[string, FieldDef]> {
  return Object.entries(c.fields).filter(([, field]) => field.type !== 'relation')
}
function searchableFields(c: CollectionDef): Array<[string, FieldDef]> {
  return scalarFields(c).filter(([, field]) => field.searchable === true)
}
function embeddableFields(c: CollectionDef): Array<[string, FieldDef]> {
  return scalarFields(c).filter(([, field]) => field.embeddable === true)
}

function columnLine(name: string, field: FieldDef): string {
  const parts = [`  ${name} ${sqlColumnType(field)}`]
  const notNull = field.required === true || field.default !== undefined
  if (notNull) parts.push('not null')
  if (field.default !== undefined) parts.push(`default ${sqlDefaultLiteral(field.default)}`)
  if (field.type === 'enum') {
    const vals = (field.values ?? []).map(quote).join(', ')
    parts.push(`check (${name} in (${vals}))`)
  }
  return parts.join(' ')
}

// FK-holding relations become a `<name>_id` column referencing the target's PK.
// Required → on delete cascade (child dies with parent); optional → on delete set null.
function fkRelations(c: CollectionDef): Array<[string, FieldDef]> {
  return Object.entries(c.fields).filter(([, field]) => relationHoldsFk(field))
}
function fkColumnLine(name: string, field: FieldDef): string {
  const parts = [`  ${name}_id uuid`]
  const notNull = field.required === true
  if (notNull) parts.push('not null')
  parts.push(`references public.${field.target} (id)`)
  parts.push(notNull ? 'on delete cascade' : 'on delete set null')
  return parts.join(' ')
}

// --- shared infrastructure (emitted once) --------------------------------

export function emitSharedInfraSql(): string {
  return [
    `create extension if not exists vector with schema extensions;`,
    `create extension if not exists pgcrypto with schema extensions;`,
    `create schema if not exists movp_internal;`,

    `create table public.movp_collections (
  name text primary key,
  label text not null,
  label_plural text not null,
  workspace_scoped boolean not null
);
alter table public.movp_collections enable row level security;
create policy movp_collections_read on public.movp_collections
  for select to authenticated using (true);`,

    `create table public.movp_fields (
  collection text not null references public.movp_collections(name) on delete cascade,
  name text not null,
  type text not null,
  label text not null,
  cardinality text,
  reporting_role text,
  searchable boolean not null default false,
  embeddable boolean not null default false,
  primary key (collection, name)
);
alter table public.movp_fields enable row level security;
create policy movp_fields_read on public.movp_fields
  for select to authenticated using (true);`,

    `create table if not exists movp_internal.movp_job_kind (
  kind text primary key
);
insert into movp_internal.movp_job_kind (kind)
values ('embed'), ('webhook'), ('notify')
on conflict (kind) do nothing;
alter table movp_internal.movp_job_kind enable row level security;
revoke all on movp_internal.movp_job_kind from anon, authenticated;
grant all on movp_internal.movp_job_kind to service_role;`,

    `create table movp_internal.movp_jobs (
  id uuid primary key default gen_random_uuid(),
  -- kind is an FK into an extensible registry, NOT a hardcoded CHECK: an app phase
  -- adds a job kind with one INSERT (no ALTER TABLE / constraint rewrite).
  kind text not null references movp_internal.movp_job_kind(kind),
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  next_run_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  workspace_id uuid references public.workspace(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, idempotency_key)
);
create index movp_jobs_due on movp_internal.movp_jobs (status, next_run_at, lease_expires_at);
alter table movp_internal.movp_jobs enable row level security;
revoke all on movp_internal.movp_jobs from anon, authenticated;
grant all on movp_internal.movp_jobs to service_role;`,

    `create table public.search_chunk (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  source_table text not null,
  source_id uuid not null,
  field text not null,
  chunk_index int not null,
  content text not null,
  embedding extensions.vector(384) not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_table, source_id, field, chunk_index)
);
create index search_chunk_hnsw on public.search_chunk
  using hnsw (embedding extensions.vector_cosine_ops);
alter table public.search_chunk enable row level security;
create policy search_chunk_read on public.search_chunk
  for select to authenticated using (public.is_workspace_member(workspace_id));`,

    `create or replace function public.match_chunks(
  query_embedding extensions.vector(384),
  ws uuid,
  source_table_filter text default null,
  match_count int default 10
)
returns table (
  source_table text,
  source_id uuid,
  field text,
  chunk_index int,
  content text,
  distance float
)
language sql
stable
set hnsw.iterative_scan = 'strict_order'
as $$
  select c.source_table, c.source_id, c.field, c.chunk_index, c.content,
         (c.embedding <=> query_embedding) as distance
  from public.search_chunk c
  where c.workspace_id = ws
    and (source_table_filter is null or c.source_table = source_table_filter)
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50)
$$;`,

    `create table public.edges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  src_type text not null,
  src_id uuid not null,
  rel text not null,
  dst_type text not null,
  dst_id uuid not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, src_type, src_id, rel, dst_type, dst_id)
);
create index edges_src_idx on public.edges (src_type, src_id);
create index edges_dst_idx on public.edges (dst_type, dst_id);
alter table public.edges enable row level security;
create policy edges_rw on public.edges for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));`,
  ].join('\n\n')
}

// --- per-collection DDL --------------------------------------------------

export function emitCollectionSql(c: CollectionDef): string {
  const out: string[] = [`-- collection: ${c.name}`]

  // table ---------------------------------------------------------------
  const cols: string[] = ['  id uuid primary key default gen_random_uuid()']
  if (c.workspaceScoped) {
    cols.push('  workspace_id uuid not null references public.workspace(id) on delete cascade')
  }
  for (const [name, field] of scalarFields(c)) cols.push(columnLine(name, field))
  for (const [name, field] of fkRelations(c)) cols.push(fkColumnLine(name, field))
  const searchables = searchableFields(c)
  if (searchables.length > 0) cols.push('  search_vector tsvector')
  cols.push('  created_at timestamptz not null default now()')
  cols.push('  updated_at timestamptz not null default now()')
  out.push(`create table public.${c.name} (\n${cols.join(',\n')}\n);`)

  // FTS index + maintenance trigger (security invoker; only mutates NEW) -
  if (searchables.length > 0) {
    out.push(`create index ${c.name}_search_idx on public.${c.name} using gin (search_vector);`)
    const weights = searchables.map(
      ([name], i) =>
        `    setweight(to_tsvector('english', coalesce(new.${name}, '')), '${i === 0 ? 'A' : 'B'}')`,
    )
    out.push(
      `create or replace function public.${c.name}_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
${weights.join(' ||\n')};
  return new;
end;
$$;`,
    )
    out.push(
      `create trigger ${c.name}_search_vector_tg
  before insert or update on public.${c.name}
  for each row execute function public.${c.name}_search_vector_update();`,
    )
  }

  // RLS -----------------------------------------------------------------
  out.push(`alter table public.${c.name} enable row level security;`)
  if (c.workspaceScoped) {
    out.push(
      `create policy ${c.name}_rw on public.${c.name} for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));`,
    )
  }

  // embed-enqueue triggers (hardened SECURITY DEFINER) ------------------
  // GOTCHA: empty search_path -> qualify every non-pg_catalog object
  // (extensions.digest, movp_internal.movp_jobs). pg_catalog builtins
  // (encode/jsonb_build_object) resolve implicitly.
  const embeddables = embeddableFields(c)
  const wsExpr = c.workspaceScoped ? 'new.workspace_id' : 'null'
  for (const [name] of embeddables) {
    const fn = `${c.name}_${name}_enqueue_embed`
    out.push(
      `create or replace function public.${fn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  v_hash := encode(extensions.digest(coalesce(new.${name}, ''), 'sha256'), 'hex');
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values (
    'embed',
    '${c.name}' || ':' || new.id::text || ':' || '${name}' || ':' || v_hash,
    jsonb_build_object(
      'source_table', '${c.name}',
      'source_id', new.id,
      'field', '${name}',
      'content_hash', v_hash
    ),
    ${wsExpr}
  )
  on conflict (kind, idempotency_key) do nothing;
  return new;
end;
$$;`,
    )
    out.push(`revoke all on function public.${fn}() from public, anon, authenticated;`)
    out.push(
      `create trigger ${fn}_tg
  after insert or update on public.${c.name}
  for each row execute function public.${fn}();`,
    )
  }

  // after-delete chunk cleanup (one per collection that has embeddables) -
  if (embeddables.length > 0) {
    const dfn = `${c.name}_delete_chunks`
    out.push(
      `create or replace function public.${dfn}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.search_chunk
  where source_table = '${c.name}' and source_id = old.id;
  return old;
end;
$$;`,
    )
    out.push(`revoke all on function public.${dfn}() from public, anon, authenticated;`)
    out.push(
      `create trigger ${dfn}_tg
  after delete on public.${c.name}
  for each row execute function public.${dfn}();`,
    )
  }

  // metadata registry rows ----------------------------------------------
  out.push(
    `insert into public.movp_collections (name, label, label_plural, workspace_scoped)
values (${quote(c.name)}, ${quote(c.label)}, ${quote(c.labelPlural)}, ${c.workspaceScoped});`,
  )
  const fieldRows = Object.entries(c.fields).map(([name, field]) => {
    const card = field.cardinality ? quote(field.cardinality) : 'null'
    const role = field.reporting?.role ? quote(field.reporting.role) : 'null'
    return `  (${quote(c.name)}, ${quote(name)}, ${quote(field.type)}, ${quote(field.label)}, ${card}, ${role}, ${field.searchable === true}, ${field.embeddable === true})`
  })
  out.push(
    `insert into public.movp_fields (collection, name, type, label, cardinality, reporting_role, searchable, embeddable)
values
${fieldRows.join(',\n')};`,
  )

  return out.join('\n\n')
}

// --- whole migration -----------------------------------------------------

export function emitSqlMigration(schema: MovpSchema): string {
  return (
    [HEADER, emitSharedInfraSql(), ...schema.collections.map((c) => emitCollectionSql(c))].join(
      '\n\n',
    ) + '\n'
  )
}
```

- [ ] **Step 5: Implement `emit-types.ts`**

`packages/codegen/src/emit-types.ts`:
```ts
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'

function pascal(name: string): string {
  return name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

function tsType(field: FieldDef): string {
  switch (field.type) {
    case 'text':
    case 'richText':
    case 'uuid':
    case 'date':
    case 'datetime':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'json':
      return 'Record<string, unknown>'
    case 'enum':
      return (field.values ?? []).map((v) => `'${v}'`).join(' | ')
    default:
      return 'never'
  }
}

function scalarFields(c: CollectionDef): Array<[string, FieldDef]> {
  return Object.entries(c.fields).filter(([, field]) => field.type !== 'relation')
}

// FK-holding relations surface as a `<name>_id: string` field (nullable unless required).
function fkRelations(c: CollectionDef): Array<[string, FieldDef]> {
  return Object.entries(c.fields).filter(
    ([, f]) => f.type === 'relation' && (f.cardinality === 'many-to-one' || f.cardinality === 'one-to-one'),
  )
}

function emitRow(c: CollectionDef): string {
  const lines = ['  id: string']
  if (c.workspaceScoped) lines.push('  workspace_id: string')
  for (const [name, field] of scalarFields(c)) {
    const base = tsType(field)
    const notNull = field.required === true || field.default !== undefined
    lines.push(`  ${name}: ${notNull ? base : `${base} | null`}`)
  }
  for (const [name, field] of fkRelations(c)) {
    lines.push(`  ${name}_id: ${field.required === true ? 'string' : 'string | null'}`)
  }
  lines.push('  created_at: string')
  lines.push('  updated_at: string')
  return `export interface ${pascal(c.name)}Row {\n${lines.join('\n')}\n}`
}

function emitCreate(c: CollectionDef): string {
  const lines: string[] = []
  if (c.workspaceScoped) lines.push('  workspace_id: string')
  for (const [name, field] of scalarFields(c)) {
    const required = field.required === true && field.default === undefined
    lines.push(`  ${name}${required ? '' : '?'}: ${tsType(field)}`)
  }
  for (const [name, field] of fkRelations(c)) {
    lines.push(`  ${name}_id${field.required === true ? '' : '?'}: string`)
  }
  return `export interface ${pascal(c.name)}Create {\n${lines.join('\n')}\n}`
}

function emitUpdate(c: CollectionDef): string {
  const lines = scalarFields(c).map(([name, field]) => `  ${name}?: ${tsType(field)}`)
  for (const [name] of fkRelations(c)) lines.push(`  ${name}_id?: string`)
  return `export interface ${pascal(c.name)}Update {\n${lines.join('\n')}\n}`
}

export function emitTypes(schema: MovpSchema): string {
  const blocks = ['// generated by @movp/codegen — do not edit by hand', '']
  for (const c of schema.collections) {
    blocks.push(emitRow(c), emitCreate(c), emitUpdate(c))
  }
  return blocks.join('\n\n') + '\n'
}
```

`packages/codegen/src/index.ts`:
```ts
export { emitSharedInfraSql, emitCollectionSql, emitSqlMigration } from './emit-sql.ts'
export { emitTypes } from './emit-types.ts'
```

- [ ] **Step 5b: Contract-extension gate — `f.json`/`f.date`/FK relations**

`packages/codegen/test/contract-extensions.test.ts` (proves the DSL/codegen contract the
app phases depend on — many-to-one/one-to-one → FK column, many-to-many → edges, `json`→`jsonb`,
`date`→`date`):
```ts
import { describe, expect, it } from 'vitest'
import { f, defineCollection, type CollectionDef } from '@movp/core-schema'
import { emitCollectionSql, emitTypes } from '../src/index.ts'

const deliverable: CollectionDef = defineCollection({
  name: 'deliverable', label: 'Deliverable', labelPlural: 'Deliverables', workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', required: true, cardinality: 'many-to-one' }),
    reviewer: f.relation('reviewer', { label: 'Reviewer', cardinality: 'one-to-one' }),
    tags: f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true }),
    due_on: f.date({ label: 'Due' }),
    meta: f.json({ label: 'Meta' }),
  },
})

describe('DSL/codegen contract extensions', () => {
  const sql = emitCollectionSql(deliverable)
  const ts = emitTypes({ collections: [deliverable] })

  it('many-to-one / one-to-one relations emit FK columns', () => {
    expect(sql).toContain('campaign_id uuid not null references public.campaign(id) on delete cascade')
    expect(sql).toContain('reviewer_id uuid references public.reviewer(id) on delete set null')
  })
  it('many-to-many relations do NOT emit a column (they use edges)', () => {
    expect(sql).not.toContain('tags_id')
  })
  it('json → jsonb, date → date', () => {
    expect(sql).toContain('meta jsonb')
    expect(sql).toContain('due_on date')
  })
  it('generated types carry FK ids + json/date mappings', () => {
    expect(ts).toContain('campaign_id: string')       // required FK
    expect(ts).toContain('reviewer_id: string | null') // optional FK
    expect(ts).toContain('meta: Record<string, unknown> | null')
    expect(ts).toContain('due_on: string | null')
    expect(ts).not.toContain('tags')                   // m2m excluded from types
  })
})
```
Expected after Step 6: PASS.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @movp/codegen test
```
Expected: PASS — both suites green (13 SQL + 6 TS cases).

- [ ] **Step 7: Typecheck**

Run:
```bash
pnpm --filter @movp/codegen typecheck
```
Expected: PASS — no type errors (resolves `@movp/core-schema` via the workspace).

- [ ] **Step 8: Commit**

```bash
cd /Users/ensell/Code/supasuite
git add packages/codegen pnpm-lock.yaml
git commit -m "feat(codegen): pure SQL + TS emit transforms for the schema pipeline"
```

---

### Task 4: `scripts/codegen.ts` + `pnpm codegen` wiring + `config.toml` isolation

**Files:**
- Create: `scripts/codegen.ts`
- Edit: `package.json` (root — add `codegen` script + `tsx` + `@movp/{core-schema,codegen}` workspace devDeps)
- Edit: `supabase/config.toml` (ensure `[api] schemas` excludes `movp_internal`)
- Generated (written by the script — do not author by hand): `supabase/migrations/<ts>_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `schema` from `@movp/core-schema` (Task 2); `emitSqlMigration` + `emitTypes` from `@movp/codegen` (Task 3).
- Produces: the on-disk generated migration + generated TS types; the root `pnpm codegen` entry point. This task is wiring + file generation; its gate is command + grep based (the schema is *applied* and proven in Task 5).

- [ ] **Step 1: Add the root `codegen` script + dependencies**

Replace the root `package.json` (created in Plan 1) with — note the added `codegen` script and three devDependencies (`tsx` to run the TS script, and the two `@movp/*` workspace packages so the root script can import them):
```json
{
  "name": "movp-suite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "codegen": "tsx scripts/codegen.ts"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@movp/core-schema": "workspace:*",
    "@movp/codegen": "workspace:*"
  }
}
```

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: installs `tsx`; links `@movp/core-schema` and `@movp/codegen` into the root `node_modules` so `tsx scripts/codegen.ts` can resolve their bare specifiers.

- [ ] **Step 2: Write the codegen script**

`scripts/codegen.ts`:
```ts
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schema } from '@movp/core-schema'
import { emitSqlMigration, emitTypes } from '@movp/codegen'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')
const typesPath = join(root, 'packages', 'domain', 'src', 'generated', 'types.ts')

// Idempotent: reuse the existing generated migration file if present, so reruns
// overwrite ONE file instead of minting a new timestamped migration each time
// (which would break the `supabase db diff` drift gate). First run mints a
// YYYYMMDDHHMMSS-prefixed name that sorts after Plan 1's bootstrap migration.
function generatedMigrationPath(): string {
  const existing = readdirSync(migrationsDir).find((file) => file.endsWith('_movp_generated.sql'))
  if (existing) return join(migrationsDir, existing)
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  return join(migrationsDir, `${ts}_movp_generated.sql`)
}

const migrationPath = generatedMigrationPath()
writeFileSync(migrationPath, emitSqlMigration(schema), 'utf8')

mkdirSync(dirname(typesPath), { recursive: true })
writeFileSync(typesPath, emitTypes(schema), 'utf8')

console.log(`codegen: wrote ${migrationPath}`)
console.log(`codegen: wrote ${typesPath}`)
```

- [ ] **Step 3: Ensure `movp_internal` is not exposed via the API**

Open `supabase/config.toml`. Find the `[api]` section (created by `supabase init` in Plan 1). Confirm its `schemas` line lists only public API schemas and does **not** include `movp_internal`, and add a guarding comment so a future edit does not accidentally expose it. The section must read:
```toml
[api]
enabled = true
port = 54321
# MOVP: never add `movp_internal` here — it holds the internal jobs queue and
# must not be reachable via PostgREST. (Enforced by the gate in this task.)
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
```
(Leave any other generated `[api]` keys as `supabase init` produced them; only the `schemas` value — excluding `movp_internal` — and the comment are load-bearing here.)

- [ ] **Step 4: Run codegen**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints two `codegen: wrote …` lines — one `supabase/migrations/<ts>_movp_generated.sql`, one `packages/domain/src/generated/types.ts`.

- [ ] **Step 5: Gate — the generated artifacts contain the load-bearing content**

Run (each command must exit 0; the final `!grep` asserts the internal schema is NOT exposed):
```bash
cd /Users/ensell/Code/supasuite
test -f packages/domain/src/generated/types.ts
grep -qF "export interface NoteRow {" packages/domain/src/generated/types.ts
grep -qF "body: string | null" packages/domain/src/generated/types.ts
grep -qF "status: 'draft' | 'published' | 'archived'" packages/domain/src/generated/types.ts
grep -qF "export interface TagUpdate {" packages/domain/src/generated/types.ts
grep -qF "create table movp_internal.movp_jobs" supabase/migrations/*_movp_generated.sql
grep -qF "using hnsw (embedding extensions.vector_cosine_ops)" supabase/migrations/*_movp_generated.sql
grep -qF "create policy note_rw on public.note for all to authenticated" supabase/migrations/*_movp_generated.sql
grep -qF "on conflict (kind, idempotency_key) do nothing;" supabase/migrations/*_movp_generated.sql
! grep -Eq 'schemas[[:space:]]*=.*movp_internal' supabase/config.toml
echo "codegen artifacts OK"
```
Expected: no command fails; final line prints `codegen artifacts OK`.

- [ ] **Step 6: Gate — re-running codegen is idempotent (single generated file)**

Run:
```bash
cd /Users/ensell/Code/supasuite
pnpm codegen
test "$(ls supabase/migrations/*_movp_generated.sql | wc -l | tr -d ' ')" = "1"
echo "single generated migration OK"
```
Expected: exactly one `*_movp_generated.sql` exists after a second run; prints `single generated migration OK`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ensell/Code/supasuite
git add package.json pnpm-lock.yaml scripts/codegen.ts supabase/config.toml \
  supabase/migrations packages/domain/src/generated/types.ts
git commit -m "feat(codegen): codegen script, pnpm codegen, generated migration + types, internal-schema isolation"
```

---

### Task 5: Apply the generated migration + prove it with pgTAP + drift gate

**Files:**
- Test: `supabase/tests/generated_schema_test.sql` (pgTAP)
- Consumes: the generated migration from Task 4 and `public.workspace`/`workspace_membership`/`is_workspace_member` from Plan 1.

**Interfaces:**
- Consumes: `supabase/migrations/<ts>_movp_generated.sql` (Task 4), the local Supabase stack (Plan 1).
- Produces: a passing pgTAP proof that the generated `note`/`tag` tables, FTS columns + index, shared `search_chunk` + HNSW + `match_chunks`, `edges`, `movp_internal.movp_jobs` (denied to `authenticated`), and metadata-registry rows exist with correct RLS; an empty `supabase db diff` (the drift gate).

- [ ] **Step 1: Write the failing pgTAP test**

`supabase/tests/generated_schema_test.sql`:
```sql
begin;
select plan(24);

-- generated collection tables + columns ------------------------------------
select has_table('public', 'note', 'note table exists');
select has_table('public', 'tag', 'tag table exists');
select has_column('public', 'note', 'workspace_id', 'note is workspace-scoped');
select has_column('public', 'note', 'title', 'note has title');
select has_column('public', 'note', 'body', 'note has body');
select has_column('public', 'note', 'status', 'note has status');
select has_column('public', 'note', 'search_vector', 'note has FTS column');
select has_column('public', 'tag', 'name', 'tag has name');
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public' and tablename = 'note' and indexname = 'note_search_idx'),
  1, 'note FTS GIN index exists');

-- shared search + graph infrastructure -------------------------------------
select has_table('public', 'search_chunk', 'search_chunk exists');
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public' and tablename = 'search_chunk' and indexname = 'search_chunk_hnsw'),
  1, 'search_chunk HNSW index exists');
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'match_chunks'),
  1, 'match_chunks function exists');
select has_table('public', 'edges', 'edges graph table exists');

-- internal jobs queue, denied to authenticated -----------------------------
select has_table('movp_internal', 'movp_jobs', 'movp_jobs lives in movp_internal');
select table_privs_are(
  'movp_internal', 'movp_jobs', 'authenticated', array[]::text[],
  'authenticated has no privileges on movp_jobs');

-- metadata registry (codegen INSERTs) --------------------------------------
select has_table('public', 'movp_collections', 'movp_collections exists');
select has_table('public', 'movp_fields', 'movp_fields exists');
select is(
  (select count(*)::int from public.movp_collections where name in ('note', 'tag')),
  2, 'both collections are registered');
select is(
  (select count(*)::int from public.movp_fields where collection = 'note'),
  4, 'all four note fields are registered');
select is(
  (select reporting_role from public.movp_fields where collection = 'note' and name = 'status'),
  'dimension', 'status reporting role is recorded');

-- FTS + embed-enqueue triggers fire on insert ------------------------------
insert into public.workspace (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Acme');
insert into public.note (id, workspace_id, title, body)
  values ('22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111', 'Hello', 'World body');
select isnt(
  (select search_vector from public.note where id = '22222222-2222-2222-2222-222222222222'),
  null, 'FTS trigger populated search_vector');
select is(
  (select count(*)::int from movp_internal.movp_jobs
   where kind = 'embed' and idempotency_key like 'note:%:body:%'),
  1, 'embed enqueue trigger created exactly one job');

-- generated RLS: member sees the row, non-member sees zero ------------------
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.note), 1, 'member sees the note via RLS');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.note), 0, 'non-member sees zero notes via RLS');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run (regenerate-from-config first so the test runs against current codegen output, but do NOT yet reset the DB):
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen && supabase test db
```
Expected: FAIL — `generated_schema_test.sql` errors with `relation "public.note" does not exist` (the generated migration has not been applied to the running DB yet).

- [ ] **Step 3: Apply the migration**

Run:
```bash
cd /Users/ensell/Code/supasuite && supabase db reset
```
Expected: `db reset` applies Plan 1's `bootstrap_tenancy` migration then the `movp_generated` migration with no errors (creates the `vector`/`pgcrypto` extensions, `movp_internal`, the registry, jobs, search, edges, and the `note`/`tag` tables).

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /Users/ensell/Code/supasuite && supabase test db
```
Expected: PASS — both `tenancy_test.sql` (Plan 1) and `generated_schema_test.sql` report `.. ok`; `generated_schema_test.sql` passes all 24 assertions.

- [ ] **Step 5: Drift gate — `supabase db diff` is empty**

Run:
```bash
cd /Users/ensell/Code/supasuite && supabase db diff
```
Expected: empty output — the live DB matches the committed migrations (no config↔DB drift). If output is non-empty, the generated SQL and the applied schema disagree: re-run `pnpm codegen`, `supabase db reset`, and diff again; a persistent non-empty diff is a real defect to fix in the emitter, not to paper over with a hand-written migration.

- [ ] **Step 6: Commit**

```bash
cd /Users/ensell/Code/supasuite
git add supabase/tests/generated_schema_test.sql
git commit -m "test(db): pgTAP proof of generated schema, RLS, triggers, and internal-table isolation"
```

---

## Self-Review

- **Spec coverage (design Build-sequence Tasks 3–4):** `@movp/core-schema` DSL — field-type registry (`f.*`), `defineCollection`/`defineSchema` with validation, and the `note` + `tag` definitions (Tasks 1–2, design Task 3 — gate: `pnpm test` typechecks definitions, invalid config rejected). `@movp/codegen` SQL emitter → the first generated migration with note/tag + metadata registry + RLS + FTS + edges + shared `search_chunk`/`match_chunks` + `movp_jobs` + enqueue triggers; `supabase db reset` applies clean, `supabase db diff` empty, metadata-registry rows present, HNSW index on `search_chunk` (Tasks 3–5, design Task 4 — all four sub-gates covered in Task 5's pgTAP + drift gate). Covered.
- **Interface-contract fidelity:** Every produced signature matches the shared contract verbatim — `Cardinality`/`ReportingRole`/`FieldType`/`FieldDef`/`CollectionDef`/`MovpSchema`, `f` (with `o` omitting `type`/`values`/`target` via `FieldOptions = Omit<FieldDef,'type'|'values'|'target'>`), `defineCollection`/`defineSchema`, and `emitSqlMigration`/`emitSharedInfraSql`/`emitCollectionSql`/`emitTypes`. The generated `NoteRow`/`NoteCreate`/`NoteUpdate`/`TagRow`/`TagCreate`/`TagUpdate` shapes are reproduced exactly (nullability rule: a Row field is non-null iff `required` or has a `default` — so `title`/`status` are non-null, `body` is `string | null`; relations excluded from types). The shared-infra DDL (movp_internal.movp_jobs columns/constraints/grants, search_chunk + HNSW cosine, match_chunks clamp + iterative scan, edges, metadata registry) matches the contract byte-for-meaning.
- **Ownership boundaries respected:** This plan emits only what the contract assigns it — it does **not** emit `movp_events` or webhooks DDL (Plan 5 owns those), and it does not build the `index-embeddings` worker (Plan 5). It writes a placeholder generated file under `packages/domain/src/generated/` but does not create the `@movp/domain` package proper (Plan 3).
- **Hardening checks:** The embed-enqueue and delete-cleanup triggers are `SECURITY DEFINER` with `set search_path = ''`, fully schema-qualify every non-`pg_catalog` object (`extensions.digest`, `movp_internal.movp_jobs`, `public.search_chunk`), and `revoke all … from public, anon, authenticated` — satisfying the design's `definer-audit` gate (wired into CI in Plan 6). The FTS trigger and `match_chunks` are intentionally `security invoker` (FTS only mutates `NEW`; `match_chunks` must let RLS apply), and the `emitSharedInfraSql` test asserts `match_chunks` carries no `security definer`. `movp_internal` is excluded from `config.toml [api] schemas` (gate in Task 4) and the jobs table is deny-all RLS + service-role-only grants.
- **Eight-dimension pass:** *Correctness* — emitters are pure and unit-pinned by string-contains tests; the migration is proven applied + RLS-correct by pgTAP. *Safety* — internal-schema isolation, deny-all jobs RLS, hardened definers, member-scoped search/edges RLS. *Reliability* — idempotent codegen (single overwritten file) keeps the drift gate stable; the embed trigger dedupes via `on conflict (kind, idempotency_key) do nothing`. *Observability* — N/A for this plan (pure emitters; the script logs only file paths, no values/PII) — stated, not skipped. *Efficiency* — shared infra emitted once (not per collection); `content_hash` in the idempotency key means unchanged content never re-enqueues. *Performance* — HNSW cosine index + `match_chunks` clamp (1–50) + iterative scan; GIN FTS index; directional `edges` indexes; the heavy vector/latency scale gate is Plan 6's `vector-scale`. *Simplicity* — one SQL emitter (no Drizzle/dual-tracker), relations deferred to `edges` (no FK columns in v1), one example collection pair. *Usability* — generated artifacts carry a `do not edit by hand` header; the metadata registry surfaces labels/cardinality/reporting for BI/tooling.
- **Placeholder scan:** none — every code/SQL block is complete and copy-paste-correct; every step has an exact command and expected output; every task ends with a machine-checkable gate (vitest pass, grep, pgTAP `ok`, empty `db diff`).
- **Type consistency:** intra-package relative imports use explicit `.ts` extensions; cross-package imports use the bare `@movp/core-schema` specifier; `@movp/codegen` declares `@movp/core-schema` as a `workspace:*` dependency and the root declares both `@movp/*` packages so `tsx scripts/codegen.ts` resolves them.
- **Known risk (called out, not hidden):** `supabase db diff` normalization of `vector`/`hnsw`/`set hnsw.iterative_scan` constructs is the most likely source of a spurious non-empty diff; Task 5 Step 5 says to treat a persistent diff as an emitter defect (fix the SQL to match what Postgres reports) rather than adding a hand-written migration, preserving the one-source-of-truth invariant.
