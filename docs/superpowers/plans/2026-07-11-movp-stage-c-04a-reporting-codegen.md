# MOVP Stage C4a — Generated-Delta Codegen + Reporting Views

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-11). Precondition: **C2 merged** (PR #9, admin
> console) and **C3 merged** (PR #11, PATs/MCP/CLI). This plan is the first of three
> (`c4a`…`c4c`) expanded from the Stage C roadmap
> (`2026-07-07-movp-stage-c-oss-roadmap.md` §C4) and TDD breakdown
> (`2026-07-07-movp-stage-c-tdd-breakdown.md` C4.1–C4.3).

**Goal:** the `reporting.role` metadata that 26 collections already carry becomes a real,
RLS-bound query surface: a new `reporting` schema of **security-invoker** views
(`reporting.v_<collection>`), emitted by codegen into a **generated delta migration** that
never touches the frozen baseline `20260701000002_movp_generated.sql`.

**Architecture — the linchpin:** codegen today writes ONE monolithic migration whose name
is hard-coded, and deletes any other `*_movp_generated.sql` file
(`packages/codegen/src/generate.ts:44-48`). That behavior is incompatible with the
forward-only migration freeze. C4a.1 therefore lands the **generated-delta strategy**
first: `generate()` refuses to rewrite a drifted baseline (hard error), and post-freeze
emitters register in a `GENERATED_DELTAS` table that writes each new emitter's output to
its own pinned, timestamped, idempotent migration file. C4a.2 adds the reporting emitter;
C4a.3 registers it (producing `20260711000001_movp_generated_reporting.sql`); C4a.4 proves
the views under RLS with pgTAP.

**Tech stack:** TypeScript (`@movp/codegen`, vitest string-containment tests, `tsx`),
Postgres 17 + pgTAP, Supabase CLI (`supabase db reset`, `supabase db diff`,
`supabase test db`).

---

## Baselines (state so Codex knows the expected deltas)

| Gate | Baseline on `main` | After C4a |
|---|---|---|
| pgTAP (`supabase test db`) | **611 tests / 30 files** | **634 / 31** (+23 in `reporting_views_test.sql`) |
| definer-audit (`node scripts/check-definer-audit.mjs`) | **179 blocks, all pinned** | **179** (views are not functions) |
| codegen tests (`pnpm --filter @movp/codegen test`) | 4 test files | 6 (+`generate.test.ts`, +`emit-reporting.test.ts`) |
| migrations | latest is `20260709000001_personal_access_tokens.sql` | +1 generated delta `20260711000001_movp_generated_reporting.sql` |
| forward-only (`node scripts/check-forward-only-migrations.mjs`) | pass | pass (delta is `A`dded, baseline untouched) |
| `supabase db diff` after reset | clean | clean |

## Global Constraints (every task inherits these)

- **TDD, failing test first.** Each task adds its failing test/gate and proves the stated
  expected failure *before* implementation.
- **Migration timestamp pre-flight (before the first apply).** Fetch `main`; if
  `supabase/migrations/` on `main` contains any filename sorting after
  `20260711000003_reporting_bi.sql`, re-timestamp C4's three migration filenames so
  they remain consecutive and sort last, and update every matching reference —
  including the reporting entry in `GENERATED_DELTAS` — before running codegen or
  applying a migration. Once any C4 migration merges, it is forward-only and must not
  be renamed; a later change gets a new migration.
- **The frozen baseline is `supabase/migrations/20260701000002_movp_generated.sql`.**
  After C4a it must be **byte-identical** to `main` (`git diff --stat` shows no change to
  it). Never edit, rename, or regenerate it. Guard:
  `node scripts/check-forward-only-migrations.mjs`.
- **Do NOT add or change `reporting:` metadata on any existing collection file** under
  `packages/core-schema/src/collections/`. Metadata rows live in the frozen baseline's
  `movp_fields` upserts (`packages/codegen/src/emit-sql.ts:98-107`); changing them makes
  `emitSqlMigration` emit different baseline bytes and `generate()` will (correctly)
  throw. `task` intentionally has no reporting metadata — its dashboard is served by a
  hand-authored view in C4b.
- **`@movp/*` import rules:** bare specifiers between packages, explicit `.ts` extensions
  on relative imports (`moduleResolution: bundler`).
- **Generated SQL is idempotent** (`create or replace view`, `create schema if not
  exists`) so a delta file can be regenerated and re-applied safely until it merges; once
  merged, the forward-only guard freezes it and any changed emission must go to a NEW
  registry entry/file.
- **Per-task gate + one commit per task.** A task is done only when its gate passes.

## File Structure

```text
packages/codegen/src/
  generate.ts                                  # C4a.1 MODIFY: delta registry + drift guard
  emit-reporting.ts                            # C4a.2 reporting view emitter
  index.ts                                     # C4a.2 MODIFY: export emitter
packages/codegen/test/
  generate.test.ts                             # C4a.1 tmp-dir generate() behavior
  emit-reporting.test.ts                       # C4a.2 string-containment emitter tests
scripts/
  codegen.ts                                   # C4a.3 MODIFY: print delta paths
supabase/migrations/
  20260711000001_movp_generated_reporting.sql  # C4a.3 OUTPUT of `pnpm codegen` (committed)
supabase/tests/
  reporting_views_test.sql                     # C4a.4 pgTAP (plan 23)
```

## Interfaces (produced — later parts rely on these VERBATIM)

```ts
// packages/codegen/src/generate.ts
export interface GeneratedDelta { file: string; emit: (schema: MovpSchema) => string }
export const GENERATED_DELTAS: readonly GeneratedDelta[]
export interface GenerateOptions {
  root?: string; migrationName?: string; migrationsDir?: string; typesPath?: string
  deltas?: readonly GeneratedDelta[]          // test seam; defaults to GENERATED_DELTAS
}
export async function generate(options?: GenerateOptions):
  Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }>

// packages/codegen/src/emit-reporting.ts
export function emitReportingViewSql(c: CollectionDef): string
export function emitReportingSql(schema: MovpSchema): string
```

```sql
-- The emitted surface C4b/C4c build on (26 views; column contract):
--   reporting.v_<collection> = id [, workspace_id] [, <fk>_id ...] [, <reporting scalar> ...],
--                              created_at, updated_at   (field-declaration order)
-- security_invoker = true on every view; select granted to authenticated + service_role;
-- usage on schema reporting granted to authenticated + service_role.
```

---

## Task C4a.1: Generated-delta strategy in `generate()`

**Why first:** every later C4 artifact is a post-freeze generated object. Without this,
`pnpm codegen` either rewrites the frozen baseline (forward-only violation) or deletes the
new delta file (its cleanup removes any `*_movp_generated.sql` that isn't the hard-coded
name).

**Files**
- Create: `packages/codegen/test/generate.test.ts`
- Modify: `packages/codegen/src/generate.ts` (full replacement below)

**Interfaces (consumed):** `emitSqlMigration(schema)` / `emitTypes(schema)` (unchanged),
`schema` from `@movp/core-schema`.

**TDD steps**

- [ ] **Step 1 — write the failing test** `packages/codegen/test/generate.test.ts`:

```ts
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generate } from '../src/generate.ts'

const BASELINE = '20260701000002_movp_generated.sql'

async function freshRoot(): Promise<{ root: string; migrationsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'movp-codegen-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  return { root, migrationsDir }
}

describe('generate() generated-delta strategy (C4a.1)', () => {
  it('bootstraps the baseline and is byte-stable across two runs', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ root })
    const first = await readFile(join(migrationsDir, BASELINE), 'utf8')
    await generate({ root })
    expect(await readFile(join(migrationsDir, BASELINE), 'utf8')).toBe(first)
  })

  it('throws on baseline drift instead of rewriting the frozen file', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ root })
    const path = join(migrationsDir, BASELINE)
    const tampered = (await readFile(path, 'utf8')) + '\n-- drift'
    await writeFile(path, tampered)
    await expect(generate({ root })).rejects.toThrow(/generated baseline drift/)
    expect(await readFile(path, 'utf8')).toBe(tampered) // frozen file left untouched
  })

  it('writes registered deltas and re-writes them idempotently', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = { file: '20990101000001_movp_generated_reporting.sql', emit: () => '-- delta body' }
    const res = await generate({ root, deltas: [delta] })
    expect(res.deltaPaths).toHaveLength(1)
    expect(res.deltaPaths[0].endsWith(delta.file)).toBe(true)
    await generate({ root, deltas: [delta] })
    expect(await readFile(join(migrationsDir, delta.file), 'utf8')).toBe('-- delta body')
  })

  it('cleanup removes a stale renamed baseline but never a registered delta', async () => {
    const { root, migrationsDir } = await freshRoot()
    await writeFile(join(migrationsDir, '20250101000000_movp_generated.sql'), '-- stale')
    // Registered delta whose name deliberately ENDS with the cleanup suffix:
    const delta = { file: '20990101000001_movp_generated.sql', emit: () => '-- kept' }
    await generate({ root, deltas: [delta] })
    const files = await readdir(migrationsDir)
    expect(files).not.toContain('20250101000000_movp_generated.sql')
    expect(files).toContain('20990101000001_movp_generated.sql')
    expect(await readFile(join(migrationsDir, '20990101000001_movp_generated.sql'), 'utf8')).toBe('-- kept')
  })

  it('rejects delta filenames that could escape the migrations directory', async () => {
    const { root } = await freshRoot()
    const delta = { file: '../escape.sql', emit: () => '-- must not be written' }
    await expect(generate({ root, deltas: [delta] })).rejects.toThrow(/invalid generated delta filename/)
  })

  it('rejects a delta symlink without overwriting its target', async () => {
    const { root, migrationsDir } = await freshRoot()
    const target = join(root, 'outside.sql')
    const file = '20990101000001_movp_generated_reporting.sql'
    await writeFile(target, '-- outside')
    await symlink(target, join(migrationsDir, file))
    await expect(generate({ root, deltas: [{ file, emit: () => '-- overwritten' }] })).rejects.toThrow(/symlink/)
    expect(await readFile(target, 'utf8')).toBe('-- outside')
  })
})
```

- [ ] **Step 2 — run it, expect RED:**

```sh
pnpm --filter @movp/codegen exec vitest run generate
```
Expected: **FAIL** — TypeScript rejects the unknown `deltas` option (excess property) and
the drift test fails with "promise resolved instead of rejecting". (Any compile error
naming `deltas`/`deltaPaths` counts as the expected failure.)

- [ ] **Step 3 — replace `packages/codegen/src/generate.ts` in full:**

```ts
import { schema } from '@movp/core-schema'
import type { MovpSchema } from '@movp/core-schema'
import { emitSqlMigration } from './emit-sql.ts'
import { emitTypes } from './emit-types.ts'

export interface GeneratedDelta {
  file: string
  emit: (schema: MovpSchema) => string
}

// C4.1 generated-delta strategy. The baseline 20260701000002_movp_generated.sql is
// FROZEN (supabase/.forward-only-migration-baseline): generate() refuses to rewrite it
// once the current schema emits different bytes. Every post-freeze generated object
// ships as a registry entry here — an idempotent, timestamped delta migration that the
// forward-only guard freezes once merged. NEVER remove or rename an entry after its
// file has merged; changed emission goes to a NEW entry with a NEW timestamped name.
export const GENERATED_DELTAS: readonly GeneratedDelta[] = []

export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
}

const MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024
const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/

function migrationFileName(file: string, label: string): string {
  if (!MIGRATION_FILE.test(file)) throw new Error(`invalid ${label} filename: ${file}`)
  return file
}

function defaultRoot(): string {
  return decodeURIComponent(new URL('../../../', import.meta.url).pathname).replace(/\/$/, '')
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

function dirname(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/'
}

async function fs() {
  return (await import('node:fs/promises')) as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
    readdir(path: string): Promise<string[]>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    rm(path: string): Promise<void>
    writeFile(path: string, contents: string): Promise<void>
  }
}

type Fs = Awaited<ReturnType<typeof fs>>

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function readIfPresent(f: Fs, path: string): Promise<string | null> {
  let info: Awaited<ReturnType<Fs['lstat']>>
  try {
    info = await f.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`generated baseline is a symlink: ${path}`)
  if (!info.isFile()) throw new Error(`generated baseline is not a regular file: ${path}`)
  if (info.size > MAX_GENERATED_FILE_BYTES) {
    throw new Error(`generated baseline exceeds ${MAX_GENERATED_FILE_BYTES} bytes: ${path}`)
  }
  return f.readFile(path, 'utf8')
}

async function assertSafeWriteTarget(f: Fs, path: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<Fs['lstat']>>
  try {
    info = await f.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`)
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
}

export async function generate(
  options: GenerateOptions = {},
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  const root = options.root ?? defaultRoot()
  const migrationName = migrationFileName(
    options.migrationName ?? '20260701000002_movp_generated.sql',
    'generated baseline',
  )
  const migrationsDir = options.migrationsDir ?? joinPath(root, 'supabase', 'migrations')
  const migrationPath = joinPath(migrationsDir, migrationName)
  const typesPath = options.typesPath ?? joinPath(root, 'packages', 'domain', 'src', 'generated', 'types.ts')
  const deltas = options.deltas ?? GENERATED_DELTAS
  const deltaFiles = deltas.map((delta) => migrationFileName(delta.file, 'generated delta'))
  if (new Set(deltaFiles).size !== deltaFiles.length) throw new Error('duplicate generated delta filename')
  const f = await fs()

  await f.mkdir(migrationsDir, { recursive: true })
  await f.mkdir(dirname(typesPath), { recursive: true })

  // Cleanup: remove stale *_movp_generated.sql outputs, but NEVER the baseline or a
  // registered delta (the breakdown's "cleanup must not delete approved delta files").
  const keep = new Set([migrationName, ...deltaFiles])
  for (const file of await f.readdir(migrationsDir)) {
    if (file.endsWith('_movp_generated.sql') && !keep.has(file)) {
      await f.rm(joinPath(migrationsDir, file))
    }
  }

  const baselineSql = emitSqlMigration(schema)
  const existing = await readIfPresent(f, migrationPath)
  if (existing !== null && existing !== baselineSql) {
    throw new Error(
      `generated baseline drift: ${migrationName} is frozen but the current schema emits different SQL. ` +
        'Post-freeze schema/emitter changes must ship as a GENERATED_DELTAS entry (a new timestamped migration), ' +
        'never by rewriting the baseline. See docs/superpowers/plans/2026-07-11-movp-stage-c-04a-reporting-codegen.md.',
    )
  }
  if (existing === null) await f.writeFile(migrationPath, baselineSql)

  const deltaPaths: string[] = []
  for (const delta of deltas) {
    const p = joinPath(migrationsDir, delta.file)
    await assertSafeWriteTarget(f, p, 'generated delta')
    await f.writeFile(p, delta.emit(schema))
    deltaPaths.push(p)
  }

  await assertSafeWriteTarget(f, typesPath, 'generated types output')
  await f.writeFile(typesPath, emitTypes(schema))

  return { migrationPath, typesPath, deltaPaths }
}
```

- [ ] **Step 4 — run, expect GREEN:**

```sh
pnpm --filter @movp/codegen exec vitest run generate
```
Expected: **PASS** — 6 tests.

- [ ] **Step 5 — prove the repo baseline is untouched, then commit.**

```sh
pnpm --filter @movp/codegen test              # all codegen tests, incl. existing 4 files
pnpm codegen                                  # against the real repo
git status --porcelain supabase/migrations    # Expected: EMPTY (no change — registry is empty,
                                              # baseline byte-identical, so nothing rewritten)
node scripts/check-forward-only-migrations.mjs   # Expected: pass
git add packages/codegen/src/generate.ts packages/codegen/test/generate.test.ts
git commit -m "feat(codegen): C4a.1 generated-delta strategy — frozen baseline drift guard + delta registry"
```

---

## Task C4a.2: Reporting view emitter

**Files**
- Create: `packages/codegen/src/emit-reporting.ts`
- Create: `packages/codegen/test/emit-reporting.test.ts`
- Modify: `packages/codegen/src/index.ts` (add one export line)

**Column contract (the invariant later parts consume):** for each collection with ≥1
`reporting`-tagged field, one view `reporting.v_<name>` selecting, in field-declaration
order: `id`, `workspace_id` (workspace-scoped collections only), every FK-holding relation
as `<field>_id` (**always included — they are star-schema join keys**, tagged or not),
every `reporting`-tagged scalar field by name, then `created_at`, `updated_at`. A
`reporting` role on a `many-to-many` relation is a hard emitter error (no column exists).
Collections with zero reporting-tagged fields (e.g. `task`) get **no view**.

**TDD steps**

- [ ] **Step 1 — write the failing test** `packages/codegen/test/emit-reporting.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { schema } from '@movp/core-schema'
import type { CollectionDef } from '@movp/core-schema'
import { emitReportingSql, emitReportingViewSql } from '../src/emit-reporting.ts'

const sql = emitReportingSql(schema)

describe('emitReportingSql (C4a.2)', () => {
  it('creates the reporting schema with usage grants', () => {
    expect(sql).toContain('create schema if not exists reporting;')
    expect(sql).toContain('grant usage on schema reporting to authenticated, service_role;')
  })

  it('emits one security-invoker view per collection with reporting metadata (26 today)', () => {
    expect((sql.match(/create or replace view reporting\.v_/g) ?? []).length).toBe(26)
    expect((sql.match(/with \(security_invoker = true\)/g) ?? []).length).toBe(26)
  })

  it('selects join keys, dimensions, measures, and timestamps for the campaign_metric fact', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_campaign_metric\n' +
        'with (security_invoker = true) as\n' +
        'select id, workspace_id, campaign_id, deliverable_id, channel_id, metric_key, value, unit, measured_at, created_at, updated_at\n' +
        'from public.campaign_metric;',
    )
  })

  it('maps the workflow_run FK dimension to automation_rule_id and keeps enum dims', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_workflow_run\n' +
        'with (security_invoker = true) as\n' +
        'select id, workspace_id, event_type, automation_rule_id, action_type, outcome, created_at, updated_at\n' +
        'from public.workflow_run;',
    )
  })

  it('omits workspace_id for the global event_type catalog', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_event_type\n' +
        'with (security_invoker = true) as\n' +
        'select id, key, domain, created_at, updated_at\n' +
        'from public.event_type;',
    )
  })

  it('emits no view for collections without reporting metadata (task)', () => {
    expect(sql).not.toContain('reporting.v_task\n')
  })

  it('grants select to authenticated and service_role on every view', () => {
    expect((sql.match(/grant select on reporting\.v_[a-z_]+ to authenticated, service_role;/g) ?? []).length).toBe(26)
  })

  it('rejects a reporting role on a many-to-many relation (no column exists)', () => {
    const bad: CollectionDef = {
      name: 'bad_collection',
      label: 'Bad',
      labelPlural: 'Bads',
      workspaceScoped: true,
      fields: {
        tags: {
          type: 'relation',
          label: 'Tags',
          target: 'note',
          cardinality: 'many-to-many',
          reporting: { role: 'dimension' },
        },
      },
    }
    expect(() => emitReportingViewSql(bad)).toThrow(/non-FK relation/)
  })
})
```

These are exact-string containment assertions rather than framework snapshots because
the repository has no snapshot harness; the complete emitted view statements above are
the golden SQL contract and fail on any column-order or clause drift.

- [ ] **Step 2 — run it, expect RED:**

```sh
pnpm --filter @movp/codegen exec vitest run emit-reporting
```
Expected: **FAIL** — `Cannot find module '../src/emit-reporting.ts'` (or equivalent).

- [ ] **Step 3 — create `packages/codegen/src/emit-reporting.ts`:**

```ts
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'

const HEADER = '-- generated by @movp/codegen - do not edit by hand'

function ident(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid sql identifier: ${name}`)
  return name
}

function isFkRelation(field: FieldDef): boolean {
  return field.type === 'relation' && (field.cardinality === 'many-to-one' || field.cardinality === 'one-to-one')
}

function reportingFields(c: CollectionDef): [string, FieldDef][] {
  return Object.entries(c.fields).filter(([, field]) => field.reporting?.role !== undefined)
}

function viewColumns(c: CollectionDef): string[] {
  const cols: string[] = ['id']
  if (c.workspaceScoped) cols.push('workspace_id')
  for (const [name, field] of Object.entries(c.fields)) {
    if (isFkRelation(field)) {
      // FK columns are star-schema join keys: always included, reporting-tagged or not.
      cols.push(`${ident(name)}_id`)
      continue
    }
    if (field.reporting?.role === undefined) continue
    if (field.type === 'relation') {
      throw new Error(`reporting role on non-FK relation ${c.name}.${name} is not supported (many-to-many has no column)`)
    }
    cols.push(ident(name))
  }
  cols.push('created_at', 'updated_at')
  return cols
}

export function emitReportingViewSql(c: CollectionDef): string {
  return `
create or replace view reporting.v_${ident(c.name)}
with (security_invoker = true) as
select ${viewColumns(c).join(', ')}
from public.${ident(c.name)};
grant select on reporting.v_${ident(c.name)} to authenticated, service_role;`
}

export function emitReportingSql(schema: MovpSchema): string {
  const withReporting = schema.collections.filter((c) => reportingFields(c).length > 0)
  return `${HEADER}
-- reporting schema: SECURITY-INVOKER views over collections with reporting metadata.
-- RLS on the underlying tables still binds — a member sees only their workspaces.
-- movp_internal is NOT exposed here; event/job analytics are member-gated SECURITY
-- DEFINER RPCs (20260711000002_reporting_analytics.sql, Stage C4b).

create schema if not exists reporting;
grant usage on schema reporting to authenticated, service_role;
${withReporting.map(emitReportingViewSql).join('\n')}
`
}
```

- [ ] **Step 4 — add the export.** In `packages/codegen/src/index.ts` add:

```ts
export { emitReportingSql, emitReportingViewSql } from './emit-reporting.ts'
```

- [ ] **Step 5 — run, expect GREEN:**

```sh
pnpm --filter @movp/codegen exec vitest run emit-reporting
```
Expected: **PASS** — 8 tests. If the exact-string assertions fail on column order, the
emitter is wrong (field-declaration order is the contract), not the test.

- [ ] **Step 6 — gate + commit.**

```sh
pnpm --filter @movp/codegen test          # Expected: all pass (generate + emit-reporting + existing)
turbo run typecheck --filter=@movp/codegen   # Expected: pass
git add packages/codegen/src/emit-reporting.ts packages/codegen/src/index.ts packages/codegen/test/emit-reporting.test.ts
git commit -m "feat(codegen): C4a.2 reporting view emitter — security-invoker views over reporting metadata"
```

---

## Task C4a.3: Register the delta, generate + apply the migration

**Files**
- Modify: `packages/codegen/src/generate.ts` (registry entry + one import)
- Modify: `scripts/codegen.ts` (print delta paths)
- Create (by running codegen, then commit): `supabase/migrations/20260711000001_movp_generated_reporting.sql`

**TDD steps**

- [ ] **Step 1 — failing gate first.** Prove the migration does not exist:

```sh
ls supabase/migrations/20260711000001_movp_generated_reporting.sql
```
Expected: **FAIL** — `No such file or directory`.

- [ ] **Step 2 — register the delta.** In `packages/codegen/src/generate.ts`, add the
  import and replace the empty registry:

```ts
import { emitReportingSql } from './emit-reporting.ts'
```

```ts
export const GENERATED_DELTAS: readonly GeneratedDelta[] = [
  // Stage C4: reporting schema + security-invoker views. Frozen once merged — a future
  // change to reporting emission needs a NEW entry with a NEW timestamped file name.
  { file: '20260711000001_movp_generated_reporting.sql', emit: emitReportingSql },
]
```

- [ ] **Step 3 — update `scripts/codegen.ts`** (full replacement; keeps the existing
  `wrote` line format):

```ts
import { generate } from '@movp/codegen'

const { migrationPath, typesPath, deltaPaths } = await generate()
console.log(`wrote ${migrationPath}`)
for (const p of deltaPaths) console.log(`wrote ${p}`)
console.log(`wrote ${typesPath}`)
```

- [ ] **Step 4 — generate and verify the only migration change is the new delta:**

```sh
pnpm codegen
git status --porcelain supabase/migrations
```
Expected: exactly one line — `?? supabase/migrations/20260711000001_movp_generated_reporting.sql`.
The frozen baseline must NOT appear as modified. Also confirm content:

```sh
head -12 supabase/migrations/20260711000001_movp_generated_reporting.sql
grep -c "create or replace view reporting.v_" supabase/migrations/20260711000001_movp_generated_reporting.sql
```
Expected: the header comment + `create schema if not exists reporting;`; view count `26`.

- [ ] **Step 5 — apply + drift gates:**

```sh
supabase db reset            # applies all migrations incl. the delta
supabase db diff             # Expected: no schema changes found
node scripts/check-forward-only-migrations.mjs   # Expected: pass
pnpm --filter @movp/codegen test                 # Expected: pass (registry no longer empty)
```
> Local-stack gotcha (CLAUDE.md): this repo pins Supabase ports 64321/64322/…; if
> `supabase status` shows another project's stack, stop and fix the target before
> trusting DB gates.

- [ ] **Step 6 — commit.**

```sh
git add packages/codegen/src/generate.ts scripts/codegen.ts supabase/migrations/20260711000001_movp_generated_reporting.sql
git commit -m "feat(reporting): C4a.3 generated delta migration — reporting schema + 26 security-invoker views"
```

---

## Task C4a.4: pgTAP — every view structurally and negatively verified

**Scope note:** structural assertions cover all 26 views (existence,
`security_invoker=true`, grants). Positive measure/dimension fidelity is sampled across
the five dashboard families, while member B's loop proves negative two-workspace
isolation across **every workspace-scoped reporting view**. The global `v_event_type`
catalog is intentionally excluded from that negative assertion.

**Files**
- Create: `supabase/tests/reporting_views_test.sql`

**TDD steps**

- [ ] **Step 1 — write the test** `supabase/tests/reporting_views_test.sql`:

```sql
-- C4a.4 reporting views: structural totality + negative isolation across every scoped view.
begin;
select plan(23);

-- ── structural: the generated reporting surface ──────────────────────────────
select is((select count(*)::int from pg_catalog.pg_views
  where schemaname = 'reporting' and viewname <> 'v_task_cycle'),
  26, '26 generated reporting views exist');
select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting' and c.relkind = 'v' and c.relname <> 'v_task_cycle'
      and c.reloptions @> array['security_invoker=true']),
  26, 'every generated reporting view is security_invoker');
select is(
  (select count(*)::int from pg_catalog.pg_views v
    where v.schemaname = 'reporting' and v.viewname <> 'v_task_cycle'
      and has_table_privilege('authenticated', format('%I.%I', v.schemaname, v.viewname)::regclass, 'select')),
  26, 'authenticated can select every generated reporting view');
select is(
  (select count(*)::int from pg_catalog.pg_views v
    where v.schemaname = 'reporting'
      and has_table_privilege('anon', format('%I.%I', v.schemaname, v.viewname)::regclass, 'select')),
  0, 'anon can select none of them');
select ok(not has_schema_privilege('anon', 'reporting', 'usage'), 'anon lacks usage on schema reporting');

-- ── seed (as table owner; RLS bypassed) ──────────────────────────────────────
insert into public.workspace (id, name) values
  ('c4a00000-0000-0000-0000-000000000001', 'RepViewsW1'),
  ('c4a00000-0000-0000-0000-000000000002', 'RepViewsW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c4a00000-0000-0000-0000-000000000001', 'c4a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c4a00000-0000-0000-0000-000000000002', 'c4a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

-- campaign fact rows in BOTH workspaces (isolation is proven on the fact table)
insert into public.campaign (id, workspace_id, name, status) values
  ('c4a00000-0000-0000-0000-0000000000a1', 'c4a00000-0000-0000-0000-000000000001', 'A', 'active'),
  ('c4a00000-0000-0000-0000-0000000000b1', 'c4a00000-0000-0000-0000-000000000002', 'B', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4a00000-0000-0000-0000-000000000001', 'c4a00000-0000-0000-0000-0000000000a1', 'clicks', 30, current_date),
  ('c4a00000-0000-0000-0000-000000000001', 'c4a00000-0000-0000-0000-0000000000a1', 'clicks', 70, current_date),
  ('c4a00000-0000-0000-0000-000000000002', 'c4a00000-0000-0000-0000-0000000000b1', 'clicks', 25, current_date);

-- one seed per remaining dashboard family, W1 only
insert into public.content_type (id, workspace_id, label, key, field_schema) values
  ('c4a00000-0000-0000-0000-0000000000c1', 'c4a00000-0000-0000-0000-000000000001', 'Article', 'article',
   '[{"name":"title","type":"text"}]'::jsonb);
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('c4a00000-0000-0000-0000-0000000000d1', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'draft-1', 'draft'),
  ('c4a00000-0000-0000-0000-0000000000d2', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'draft-2', 'draft'),
  ('c4a00000-0000-0000-0000-0000000000d3', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000c1', 'live-1', 'published');
insert into public.segment (id, workspace_id, name, active, mode) values
  ('c4a00000-0000-0000-0000-0000000000e1', 'c4a00000-0000-0000-0000-000000000001', 'Seg', true, 'dynamic');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('c4a00000-0000-0000-0000-0000000000f1', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-0000000000e1', now(), 'on_demand', 5);
insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config) values
  ('c4a00000-0000-0000-0000-000000000011', 'c4a00000-0000-0000-0000-000000000001',
   (select id from public.event_type where key = 'task.completed'), '{}'::jsonb, 'notify', '{}'::jsonb);
insert into public.workflow_run (id, workspace_id, source_event_id, event_type, automation_rule_id, matched, action_type, outcome) values
  ('c4a00000-0000-0000-0000-000000000012', 'c4a00000-0000-0000-0000-000000000001',
   'c4a00000-0000-0000-0000-000000000099', 'task.completed',
   'c4a00000-0000-0000-0000-000000000011', true, 'notify', 'succeeded');
insert into public.platform_event (workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('c4a00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-1', 'internal', now(), now()),
  ('c4a00000-0000-0000-0000-000000000001', 'signup.completed', 'user', 'u-2', 'external', now(), now());

-- ── member A (W1): positive visibility + measure/dimension fidelity ──────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c4a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from reporting.v_campaign_metric), 2, 'A sees W1 fact rows via the view');
select is((select sum(value)::int from reporting.v_campaign_metric), 100, 'measure column flows through the view');
select is((select count(*)::int from reporting.v_content_item where status = 'draft'), 2, 'dimension column flows (funnel draft=2)');
select is((select member_count::int from reporting.v_segment_snapshot limit 1), 5, 'segment snapshot measure visible');
select is((select count(*)::int from reporting.v_workflow_run where outcome = 'succeeded'), 1, 'workflow outcome dimension visible');
select is((select count(*)::int from reporting.v_platform_event), 2, 'ingest facts visible');
select ok((select count(*) from reporting.v_event_type) > 0, 'global event_type catalog readable by any member');
select is(
  (select count(*)::int
     from reporting.v_campaign_metric m
     join public.campaign c on c.id = m.campaign_id),
  2, 'campaign_id join key supports a star join');

-- ── member B (W2): isolation — sees only its own workspace ───────────────────
set local request.jwt.claims = '{"sub":"c4a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from reporting.v_campaign_metric), 1, 'B sees only W2 fact rows');
select is((select sum(value)::int from reporting.v_campaign_metric), 25, 'B sum excludes W1 values');
select is((select count(*)::int from reporting.v_content_item), 0, 'B sees no W1 content');
select is((select count(*)::int from reporting.v_segment_snapshot), 0, 'B sees no W1 snapshots');
select is((select count(*)::int from reporting.v_workflow_run), 0, 'B sees no W1 workflow runs');
select is((select count(*)::int from reporting.v_platform_event), 0, 'B sees no W1 platform events');

do $$
declare
  view record;
  view_leaks integer;
  total_leaks integer := 0;
begin
  for view in
    select viewname
      from pg_catalog.pg_views
     where schemaname = 'reporting' and viewname <> 'v_event_type'
  loop
    execute format(
      'select count(*)::int from reporting.%I where workspace_id = %L',
      view.viewname,
      'c4a00000-0000-0000-0000-000000000001'
    ) into view_leaks;
    total_leaks := total_leaks + view_leaks;
  end loop;
  perform set_config('c4a.total_leaks', total_leaks::text, true);
end $$;
select is(
  current_setting('c4a.total_leaks')::int,
  0,
  'member B sees zero W1 rows in every workspace-scoped reporting view'
);

-- ── non-member / anon hard denial ────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"c4a0cccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from reporting.v_campaign_metric), 0, 'a user with no membership sees zero rows');
reset role;
set local role anon;
select throws_ok(
  $$ select count(*) from reporting.v_campaign_metric $$,
  '42501', null, 'anon is denied outright (no grant, no schema usage)');
reset role;

select is((select count(*)::int from pg_catalog.pg_views where schemaname = 'reporting' and viewname = 'v_task'),
  0, 'task has no reporting view by design (no reporting metadata)');

select * from finish();
rollback;
```

- [ ] **Step 2 — run, expect GREEN** (the migration from C4a.3 is already applied; this
  task's "failing first" is Step 1 of C4a.3 — the views did not exist before this part):

```sh
supabase test db
```
Expected: **PASS — 634 tests across 31 files** (611 + 23). If `event_type` has no
`task.completed` row, the local stack was reset without the generated migration — rerun
`supabase db reset`.

- [ ] **Step 3 — full repo gates + commit.**

```sh
node scripts/check-definer-audit.mjs      # Expected: 179 blocks (unchanged)
pnpm test:forward-only-migrations         # Expected: pass
git add supabase/tests/reporting_views_test.sql
git commit -m "test(reporting): C4a.4 pgTAP — structural totality + two-workspace isolation for reporting views"
```

---

## Deferred (visible, not silent)

- **Materialized views / refresh infra** — plain views first; add matviews only with
  measured slow-query evidence (roadmap C4 deferred list).
- **Metadata-delta emitter** — changing `reporting:` tags on already-frozen collections
  requires re-emitting `movp_fields` upserts as a delta; build it when a real change
  needs it (the drift guard makes the need loud).
- **PostgREST exposure of the `reporting` schema** (`config.toml [api].schemas`) — the
  dashboard layer uses RPCs (C4b); direct REST access to views is a C5-adjacent decision
  gated by an exposure audit.

## Eight-dimension self-check (C4a)

- **Correctness** — emitter output pinned by exact-string tests; view column contract
  stated once and consumed verbatim by C4b; pgTAP proves RLS semantics.
- **Safety** — views are security-invoker (RLS binds); anon has no schema usage/grants;
  `movp_internal` untouched; the frozen baseline cannot be silently rewritten (hard
  throw + forward-only guard).
- **Reliability** — generated delta is idempotent (`create or replace`); drift fails
  loudly with a remediation message; cleanup can no longer delete approved deltas.
- **Observability** — N/A for runtime (no new failure paths execute in prod); build-time
  failures are loud CLI errors. Analytics-RPC observability lands in C4b.
- **Efficiency** — plain views add zero storage; codegen runs once; no duplicate emission.
- **Performance** — views are pass-through projections over already-indexed tables;
  aggregate/date-bound query shapes live in C4b RPCs where bounds are enforced.
- **Simplicity** — registry is a flat array; no speculative emitter options; `task` view
  deliberately not invented.
- **Usability** — N/A UI here (C4c); error messages name the exact remediation.
