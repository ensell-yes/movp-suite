# Stage C6f — Starlight Docs Site + DSL-Reference Generator (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT batch tasks; run each task's failing-test → impl → passing-test → commit cycle in order.

**Goal:** Ship a learnable MOVP docs surface. (1) A **drift-proof DSL-reference generator** reads the C6c manifest `movp.schema.json` (never the erased TS types) and emits deterministic Starlight reference pages — one per collection plus an index. (2) A **Starlight docs site** (`docs-site/`) carries authored content (quickstart, per-template guides for CRM-lite + the three gallery templates, and a C3 agent-connectivity matrix) alongside the generated reference. (3) Three CI gates hold it honest: the docs site **builds**, the committed manifest + generated pages are **fresh** (`git diff --exit-code` after regenerate), and a **manifest ⇔ schema consistency gate** — pinning the committed manifest's projection + fingerprint to the live `@movp/core-schema` `schema` by reusing C6c's `checkMetadataConsistency` as a pure projection comparator — is green with stable error ids. The **live-DB truth** (schema ⇔ `movp_fields`/`movp_collections`) is owned by **C6c's own `supabase db reset` gate** (INTERFACES F7); the docs CI job has no database, so C6f does NOT re-prove the live-DB half — it establishes manifest ⇔ schema, and manifest ⇔ `movp_fields` follows by transitivity through C6c's signal.

**Architecture:** `docs-site/` is a new **private workspace package** `@movp/docs-site` (added to `pnpm-workspace.yaml`). Its build is `astro build` behind Starlight. The generator is a **pure function** `generateDslReference(manifest: SchemaManifest): GeneratedPage[]` in `docs-site/src/dsl-reference/generate.ts`, consuming the locked `SchemaManifest` type from `@movp/codegen` (06c). Two `tsx` emit scripts commit derived artifacts into the repo — `scripts/emit-docs-manifest.ts` writes `docs-site/movp.schema.json` from the live `@movp/core-schema` `schema` via C6c's `emitManifest`; `docs-site/scripts/gen-dsl-reference.ts` reads that manifest and writes the reference pages. Both are gated by regenerate-then-`git diff --exit-code`, mirroring the existing `schema-codegen-unit` CI job (`.github/workflows/ci.yml`). The consistency gate `scripts/check-docs-manifest.ts` pins the committed manifest to the live `@movp/core-schema` `schema`: it projects the manifest into the DB-shaped rows C6c's comparator expects and runs `checkMetadataConsistency(schema, …)` as a **pure projection-equality check** (same stable ids on divergence: `missing_metadata_row` · `altered_metadata_row` · `stale_metadata_row`), then pins the whole projection with a `schemaFingerprint` equality (`manifest_fingerprint_mismatch`). This proves **manifest ⇔ schema only** — the projected rows are derived from the committed manifest, NOT read from a database, so this gate is not live-DB evidence and must not be read as one. The **live-DB** assertion (schema ⇔ `movp_fields`/`movp_collections` via `supabase db reset` + a live query) lives in **C6c's** CI job, which the docs job does not (and cannot, having no DB) duplicate; manifest ⇔ `movp_fields` holds by transitivity across the two jobs.

**Tech Stack:** TypeScript (ESM, `node20`), Vitest 3 (already in the workspace), `tsx` `^4.19.0` (already a root devDep — used to run TS scripts, see `scripts/codegen.ts`), Astro `^6.0.0` (already a dependency in `templates/frontend-astro`), **`@astrojs/starlight` (NEW external dependency — requires approval; see Global Constraints)**, `@movp/core-schema` (06a schema + `layer`; 06b `schemaFingerprint` / `metadataProjection`), `@movp/codegen` (06c `emitManifest` / `serializeManifest` / `SchemaManifest` / `checkMetadataConsistency` / `MetadataConsistencyError` / `MetadataConsistencyCode` / `MetadataDbState`). The docs-only fingerprint failure throws a C6f-local `DocsConsistencyError` whose `.code` is a `DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'` union — no `as never` cast, no plain-`Error` fallback. No `pg`, no live DB (the DB-side `movp_fields` truth is already gated by C6c against the same schema; C6f pins the manifest to that schema).

## Global Constraints

- **NEW DEPENDENCY — needs sign-off before Task 5.** `@astrojs/starlight` is not present anywhere in the repo (verified: `grep -rn 'starlight' --include=package.json .` is empty). Per the global "no new dependencies without approval" rule, **stop and request approval before adding it.** Proposed: `@astrojs/starlight` pinned to the version whose peer range accepts the repo's `astro@^6.0.0` (the executor MUST run `npm view @astrojs/starlight peerDependencies` and pick a version listing `astro` `^6`; if none exists yet, STOP and ask — do NOT downgrade the repo's Astro). Starlight also pulls transitive deps (e.g. `sharp`, `@astrojs/mdx`); that is expected and covered by the same approval. `astro` itself is already an approved dependency. No other new external deps: `@movp/*` workspace links and `vitest`/`tsx` are already approved.
- **Consume 06c/06b/06a exactly; invent no cross-part API.** From 06c (`@movp/codegen`): `SchemaManifest` = `{ manifestVersion: 1; generatorVersion: string; schemaFingerprint: string; collections: ManifestCollection[] }`; `ManifestCollection` = `{ name; internal; label; workspaceScoped; layer: 'platform' | 'project'; fields: ManifestField[] }`; `ManifestField` = `{ name; type; label; cardinality: string | null; reporting_role: string | null; searchable; embeddable }`; plus `emitManifest(schema, { generatorVersion })`, `serializeManifest(manifest)`, `checkMetadataConsistency(schema, db: MetadataDbState)`, `MetadataConsistencyError`, `MetadataConsistencyCode`, `MetadataDbState`. From 06b (`@movp/core-schema`): `schemaFingerprint(schema)`, `metadataProjection(schema)`. From 06a: `CollectionDef.layer`. **Import these; never re-derive them.** The manifest is the generator's ONLY input — do not import `schema`/collection TS types into the generator.
- **Drift-proof means generated, committed, and gated.** Every derived artifact (`docs-site/movp.schema.json`, `docs-site/src/content/docs/reference/*.md`) is emitted by a script and committed; CI regenerates and runs `git diff --exit-code`. Never hand-edit a generated file — the reference pages carry an explicit "generated — do not edit" banner.
- **Determinism.** Manifest already orders collections by `name` and fields by `name` (06c). The generator re-sorts defensively (collections by `name`, fields by `name`) and joins lines with `\n`; every page ends with a trailing newline-terminated table. JSON via `serializeManifest` (`JSON.stringify(x, null, 2) + '\n'`, from 06c).
- **Untrusted I/O discipline** ([[untrusted-io-and-resource-bounds]]): every script that reads `movp.schema.json` does `lstat` and rejects a symlink BEFORE `readFile`; bounds size (`MAX_MANIFEST_BYTES = 4 * 1024 * 1024`) before buffering; structurally validates parsed JSON before dereferencing; logs path + reason only, never file contents.
- **Never use `any`.** Use `unknown` + a runtime type guard, or a real type (`SchemaManifest`, `MetadataDbState`).
- **Stable error codes** (exact strings): reused from C6c — `missing_metadata_row`, `altered_metadata_row`, `stale_metadata_row`; C6f-local — `manifest_fingerprint_mismatch`, `invalid_manifest`.
- **After every change run the affected test/gate and show output; commit per task.** Astro/Starlight lands in Task 5, so Tasks 1–4 must NOT import from `astro`/`@astrojs/starlight` (they run under plain Vitest/tsx and stay green before the new dep is approved).

---

## File map

- Create `pnpm-workspace.yaml` entry `- "docs-site"` (Task 1).
- Create `docs-site/package.json` — private `@movp/docs-site`, workspace deps on `@movp/codegen` + `@movp/core-schema`, `vitest` (Task 1); `astro` + `@astrojs/starlight` + `astro build` script added in Task 5.
- Create `docs-site/src/dsl-reference/generate.ts` — pure `generateDslReference` (Task 1).
- Create `docs-site/test/dsl-reference.test.ts` — snapshot test, fixed manifest → expected pages (Task 1).
- Create `scripts/emit-docs-manifest.ts` — writes `docs-site/movp.schema.json` (Task 2); root script `docs:manifest`.
- Create `docs-site/scripts/gen-dsl-reference.ts` — writes reference pages (Task 3); root script `docs:reference`.
- Create `docs-site/src/dsl-reference/consistency.ts` — pure `assertManifestMatchesSchema` (Task 4).
- Create `docs-site/test/consistency.test.ts` — consistency unit test (Task 4).
- Create `scripts/check-docs-manifest.ts` — the gate wiring (Task 4); root script `check:docs-manifest`.
- Create `docs-site/astro.config.mjs`, `docs-site/src/content.config.ts`, `docs-site/tsconfig.json`, authored content under `docs-site/src/content/docs/` (Task 5); root script `docs:build`; new CI `docs` job.
- Modify root `package.json` scripts (Tasks 2–5) and `.github/workflows/ci.yml` (Task 5).

---

### Task 1: Scaffold `@movp/docs-site` + the pure DSL-reference generator

**Files:**
- Create: `docs-site/package.json`
- Modify: `pnpm-workspace.yaml` (add `- "docs-site"`)
- Create: `docs-site/src/dsl-reference/generate.ts`
- Create: `docs-site/test/dsl-reference.test.ts`

**Interfaces:**
- Consumes (06c): the locked `SchemaManifest` / `ManifestCollection` / `ManifestField` types from `@movp/codegen` (type-only import — the generator reads the manifest object, never the schema).
- Produces:
  - `interface GeneratedPage { path: string; content: string }` — `path` is relative to the Starlight docs content root (e.g. `reference/deal.md`).
  - `generateDslReference(manifest: SchemaManifest): GeneratedPage[]` — deterministic: an index page plus one page per collection, sorted by `path`.

- [ ] **Step 1: Write the failing test**

```ts
// docs-site/test/dsl-reference.test.ts
import { describe, expect, it } from 'vitest'
import type { SchemaManifest } from '@movp/codegen'
import { generateDslReference } from '../src/dsl-reference/generate.ts'

const manifest: SchemaManifest = {
  manifestVersion: 1,
  generatorVersion: '0.1.0',
  schemaFingerprint: 'sha256-fixture',
  collections: [
    {
      name: 'company',
      internal: false,
      label: 'Company',
      workspaceScoped: true,
      layer: 'project',
      fields: [{ name: 'name', type: 'text', label: 'Name', cardinality: null, reporting_role: null, searchable: true, embeddable: false }],
    },
    {
      name: 'deal',
      internal: false,
      label: 'Deal',
      workspaceScoped: true,
      layer: 'project',
      fields: [
        // Intentionally out of order to prove the generator sorts fields by name.
        { name: 'title', type: 'text', label: 'Title', cardinality: null, reporting_role: null, searchable: true, embeddable: false },
        { name: 'amount', type: 'number', label: 'Amount', cardinality: 'one', reporting_role: 'measure', searchable: false, embeddable: false },
      ],
    },
  ],
}

describe('generateDslReference', () => {
  it('emits an index plus one page per collection, sorted by path', () => {
    const pages = generateDslReference(manifest)
    expect(pages.map((p) => p.path)).toEqual([
      'reference/company.md',
      'reference/deal.md',
      'reference/index.md',
    ])
  })

  it('renders a collection page from the manifest (fields sorted, booleans as yes/no, null as em-dash)', () => {
    const deal = generateDslReference(manifest).find((p) => p.path === 'reference/deal.md')
    expect(deal?.content).toBe(
      [
        '---',
        'title: Deal',
        'description: DSL reference for the deal collection (generated — do not edit).',
        '---',
        '',
        '<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->',
        '',
        '**Collection name:** `deal`',
        '**Layer:** project',
        '**Workspace-scoped:** yes',
        '**Internal:** no',
        '',
        '## Fields',
        '',
        '| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| `amount` | `number` | Amount | one | measure | no | no |',
        '| `title` | `text` | Title | — | — | yes | no |',
        '',
      ].join('\n'),
    )
  })

  it('renders an index page linking every collection', () => {
    const index = generateDslReference(manifest).find((p) => p.path === 'reference/index.md')
    expect(index?.content).toBe(
      [
        '---',
        'title: Schema reference',
        'description: Generated DSL reference for every MOVP collection.',
        '---',
        '',
        '<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->',
        '',
        'Generated from manifest version 1 (generator 0.1.0).',
        '',
        '| Collection | Name | Layer | Fields |',
        '| --- | --- | --- | --- |',
        '| [Company](/reference/company/) | `company` | project | 1 |',
        '| [Deal](/reference/deal/) | `deal` | project | 2 |',
        '',
      ].join('\n'),
    )
  })

  it('is deterministic across runs', () => {
    expect(generateDslReference(manifest)).toEqual(generateDslReference(manifest))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

First create the package so the workspace resolves. Create `docs-site/package.json`:

```json
{
  "name": "@movp/docs-site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@movp/codegen": "workspace:*",
    "@movp/core-schema": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.2.6"
  }
}
```

Add to `pnpm-workspace.yaml` under `packages:` (keep `packages/*` and `templates/*`):

```yaml
packages:
  - "packages/*"
  - "templates/*"
  - "docs-site"
```

Run: `pnpm install` (updates the lockfile for the new workspace member — commit the lockfile), then
`pnpm --filter @movp/docs-site exec vitest run test/dsl-reference.test.ts`
Expected: FAIL — `Cannot find module '../src/dsl-reference/generate.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// docs-site/src/dsl-reference/generate.ts
import type { ManifestCollection, ManifestField, SchemaManifest } from '@movp/codegen'

export interface GeneratedPage {
  /** Path relative to the Starlight docs content root, e.g. "reference/deal.md". */
  path: string
  content: string
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')
const orDash = (value: string | null): string => (value === null || value === '' ? '—' : value)

function fieldRow(field: ManifestField): string {
  return `| \`${field.name}\` | \`${field.type}\` | ${field.label} | ${orDash(field.cardinality)} | ${orDash(
    field.reporting_role,
  )} | ${yesNo(field.searchable)} | ${yesNo(field.embeddable)} |`
}

function collectionPage(collection: ManifestCollection): GeneratedPage {
  const fields = [...collection.fields].sort((a, b) => a.name.localeCompare(b.name))
  const content = [
    '---',
    `title: ${collection.label}`,
    `description: DSL reference for the ${collection.name} collection (generated — do not edit).`,
    '---',
    '',
    '<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->',
    '',
    `**Collection name:** \`${collection.name}\``,
    `**Layer:** ${collection.layer}`,
    `**Workspace-scoped:** ${yesNo(collection.workspaceScoped)}`,
    `**Internal:** ${yesNo(collection.internal)}`,
    '',
    '## Fields',
    '',
    '| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...fields.map(fieldRow),
    '',
  ].join('\n')
  return { path: `reference/${collection.name}.md`, content }
}

function indexPage(manifest: SchemaManifest, collections: readonly ManifestCollection[]): GeneratedPage {
  const rows = collections.map(
    (c) => `| [${c.label}](/reference/${c.name}/) | \`${c.name}\` | ${c.layer} | ${c.fields.length} |`,
  )
  const content = [
    '---',
    'title: Schema reference',
    'description: Generated DSL reference for every MOVP collection.',
    '---',
    '',
    '<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->',
    '',
    `Generated from manifest version ${manifest.manifestVersion} (generator ${manifest.generatorVersion}).`,
    '',
    '| Collection | Name | Layer | Fields |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
  return { path: 'reference/index.md', content }
}

export function generateDslReference(manifest: SchemaManifest): GeneratedPage[] {
  const collections = [...manifest.collections].sort((a, b) => a.name.localeCompare(b.name))
  const pages = [indexPage(manifest, collections), ...collections.map(collectionPage)]
  return pages.sort((a, b) => a.path.localeCompare(b.path))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/docs-site exec vitest run test/dsl-reference.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml docs-site/package.json docs-site/src/dsl-reference/generate.ts docs-site/test/dsl-reference.test.ts
git commit -m "feat(docs): C6f.1 pure DSL-reference generator over the C6c manifest"
```

**Gate:** `pnpm --filter @movp/docs-site exec vitest run test/dsl-reference.test.ts` PASS (4). The generator imports ONLY the `SchemaManifest` type — verify with `grep -n "from '@movp/core-schema'" docs-site/src/dsl-reference/generate.ts` returns empty (no schema import in the generator).

---

### Task 2: Emit the monorepo manifest `docs-site/movp.schema.json` + freshness gate

**Files:**
- Create: `scripts/emit-docs-manifest.ts`
- Create (generated, committed): `docs-site/movp.schema.json`
- Modify: root `package.json` (add `docs:manifest` script)

**Interfaces:**
- Consumes (06a/06b): `schema` from `@movp/core-schema`. (06c): `emitManifest(schema, { generatorVersion })` + `serializeManifest` from `@movp/codegen`.
- Produces: `docs-site/movp.schema.json` — the committed manifest that Tasks 3 & 4 read. `generatorVersion` is sourced from `packages/codegen/package.json` `version` so the value is deterministic in CI (NOT `Date`/env-derived).

- [ ] **Step 1: Write the emit script**

```ts
// scripts/emit-docs-manifest.ts
// Emits docs-site/movp.schema.json from the live @movp/core-schema `schema`.
// Run: pnpm docs:manifest. CI regenerates and runs `git diff --exit-code`.
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@movp/core-schema'
import { emitManifest, serializeManifest } from '@movp/codegen'

const CODEGEN_PKG = new URL('../packages/codegen/package.json', import.meta.url)
const MANIFEST_PATH = new URL('../docs-site/movp.schema.json', import.meta.url)

async function generatorVersion(): Promise<string> {
  const raw = await readFile(CODEGEN_PKG, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof (parsed as { version: unknown }).version === 'string'
  ) {
    return (parsed as { version: string }).version
  }
  throw new Error('cannot resolve @movp/codegen version for the docs manifest')
}

const manifest = emitManifest(schema, { generatorVersion: await generatorVersion() })
await writeFile(MANIFEST_PATH, serializeManifest(manifest))
console.log(`wrote docs-site/movp.schema.json (${manifest.collections.length} collections)`)
```

Add to root `package.json` `scripts` (alongside `codegen`):

```json
"docs:manifest": "tsx scripts/emit-docs-manifest.ts",
```

- [ ] **Step 2: Generate the manifest and verify it is deterministic**

Run: `pnpm docs:manifest && pnpm docs:manifest && git diff --stat docs-site/movp.schema.json`
Expected: the file is created on the first run and the second run leaves it unchanged (`git diff --stat` shows no changes after it is staged). Inspect the head: `head -6 docs-site/movp.schema.json` Expected: `{`, `  "manifestVersion": 1,`, `  "generatorVersion": "...",`, `  "schemaFingerprint": "...",`, `  "collections": [`.

- [ ] **Step 3: Wire the freshness gate as a runnable check**

The gate is the two-command pattern already used by `schema-codegen-unit` in CI. Verify locally:

Run: `pnpm docs:manifest && git diff --exit-code docs-site/movp.schema.json`
Expected: exit 0 (no diff) once the file is committed. If a schema change lands without regenerating, this exits non-zero.

- [ ] **Step 4: Commit**

```bash
git add scripts/emit-docs-manifest.ts docs-site/movp.schema.json package.json
git commit -m "feat(docs): C6f.2 emit committed movp.schema.json + freshness gate"
```

**Gate:** `pnpm docs:manifest && git diff --exit-code docs-site/movp.schema.json` exits 0. `node -e "const m=require('./docs-site/movp.schema.json'); if(m.manifestVersion!==1||typeof m.schemaFingerprint!=='string'||!Array.isArray(m.collections)) process.exit(1)"` exits 0 (locked shape present).

---

### Task 3: Generate the reference pages from the manifest + freshness gate

**Files:**
- Create: `docs-site/scripts/gen-dsl-reference.ts`
- Create (generated, committed): `docs-site/src/content/docs/reference/index.md` + one `reference/<collection>.md` per collection
- Modify: root `package.json` (add `docs:reference` script)

**Interfaces:**
- Consumes: `docs-site/movp.schema.json` (Task 2) + `generateDslReference` (Task 1).
- Produces: committed reference `.md` pages under `docs-site/src/content/docs/reference/`. Idempotent: rerun ⇒ byte-identical files.

- [ ] **Step 1: Write the emit script**

```ts
// docs-site/scripts/gen-dsl-reference.ts
// Reads docs-site/movp.schema.json and writes the reference pages. Run: pnpm docs:reference.
// CI regenerates and runs `git diff --exit-code docs-site/src/content/docs/reference`.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SchemaManifest } from '@movp/codegen'
import { generateDslReference } from '../src/dsl-reference/generate.ts'

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MANIFEST_PATH = fileURLToPath(new URL('../movp.schema.json', import.meta.url))
const DOCS_ROOT = fileURLToPath(new URL('../src/content/docs/', import.meta.url))

function assertManifest(value: unknown): asserts value is SchemaManifest {
  // Structural validation before dereference — a parseable JSON is not a valid manifest.
  if (typeof value !== 'object' || value === null) throw new Error('invalid_manifest: not an object')
  const m = value as Record<string, unknown>
  if (m.manifestVersion !== 1) throw new Error('invalid_manifest: manifestVersion must be 1')
  if (typeof m.schemaFingerprint !== 'string') throw new Error('invalid_manifest: schemaFingerprint must be a string')
  if (!Array.isArray(m.collections)) throw new Error('invalid_manifest: collections must be an array')
}

async function readManifest(): Promise<SchemaManifest> {
  // lstat-before-read: a symlinked manifest could point outside the repo.
  const info = await lstat(MANIFEST_PATH)
  if (info.isSymbolicLink()) throw new Error(`invalid_manifest: ${MANIFEST_PATH} is a symlink`)
  if (!info.isFile()) throw new Error(`invalid_manifest: ${MANIFEST_PATH} is not a regular file`)
  if (info.size > MAX_MANIFEST_BYTES) throw new Error(`invalid_manifest: ${MANIFEST_PATH} exceeds ${MAX_MANIFEST_BYTES} bytes`)
  const parsed: unknown = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  assertManifest(parsed)
  return parsed
}

const pages = generateDslReference(await readManifest())
for (const page of pages) {
  const target = `${DOCS_ROOT}${page.path}`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, page.content)
}
console.log(`wrote ${pages.length} reference pages under docs-site/src/content/docs/reference/`)
```

Add to root `package.json` `scripts`:

```json
"docs:reference": "tsx docs-site/scripts/gen-dsl-reference.ts",
```

- [ ] **Step 2: Generate the pages and verify idempotence**

Run: `pnpm docs:reference && pnpm docs:reference && git status --porcelain docs-site/src/content/docs/reference`
Expected: the pages are written; the second run leaves them byte-identical. `ls docs-site/src/content/docs/reference/` Expected: `index.md` plus one `<collection>.md` per manifest collection.

- [ ] **Step 3: Wire the freshness gate**

Run: `pnpm docs:reference && git diff --exit-code docs-site/src/content/docs/reference`
Expected: exit 0 once committed.

- [ ] **Step 4: Commit**

```bash
git add docs-site/scripts/gen-dsl-reference.ts docs-site/src/content/docs/reference package.json
git commit -m "feat(docs): C6f.3 generate committed DSL reference pages + freshness gate"
```

**Gate:** `pnpm docs:reference && git diff --exit-code docs-site/src/content/docs/reference` exits 0. A symlinked or truncated `movp.schema.json` makes the script exit non-zero with an `invalid_manifest` message (path + reason only).

---

### Task 4: Manifest ⇔ schema consistency gate (reuse C6c comparator + stable ids)

> **Scope of what this gate proves.** This gate pins the committed manifest to the live `@movp/core-schema` `schema` — projection equality (via C6c's comparator) + fingerprint equality. It does NOT touch a database and is NOT live-DB evidence. The **live-DB** truth (schema ⇔ `movp_fields`/`movp_collections`, via `supabase db reset` then a live query into `checkMetadataConsistency`) is owned by **C6c's** CI gate (INTERFACES F7). C6f consumes that established signal by transitivity — manifest ⇔ schema (here) plus schema ⇔ live DB (C6c) gives manifest ⇔ `movp_fields`. Do NOT reword the task, script, or gate to claim this docs job proves manifest ⇔ live DB by itself.

**Files:**
- Create: `docs-site/src/dsl-reference/consistency.ts`
- Create: `docs-site/test/consistency.test.ts`
- Create: `scripts/check-docs-manifest.ts`
- Modify: root `package.json` (add `check:docs-manifest` script)

**Interfaces:**
- Consumes (06b): `schemaFingerprint`, `metadataProjection` from `@movp/core-schema`. (06c): `checkMetadataConsistency`, `MetadataConsistencyError`, `MetadataConsistencyCode`, `MetadataDbState`, `SchemaManifest` from `@movp/codegen`.
- Produces:
  - `assertManifestMatchesSchema(schema: MovpSchema, manifest: SchemaManifest): void` — projects the manifest into the DB-shaped rows C6c's comparator consumes and runs `checkMetadataConsistency` as a pure projection-equality check (so a manifest whose collection/field set or a compared column diverges from the schema throws `missing_metadata_row` / `altered_metadata_row` / `stale_metadata_row`), then asserts `manifest.schemaFingerprint === schemaFingerprint(schema)`, throwing a `DocsConsistencyError('manifest_fingerprint_mismatch', …)` otherwise. The projected rows are derived from the committed manifest, not read from a DB, so this proves manifest ⇔ schema — NOT manifest ⇔ live `movp_fields` (that half is C6c's `supabase db reset` gate; see the task's scope note). `label_plural` is not carried by the manifest, so it is sourced from `metadataProjection(schema)` for the comparator input; the fingerprint check (which covers the full projection, `label_plural` included) is what actually pins `label_plural` drift end-to-end.
  - `DocsConsistencyError` / `DocsConsistencyCode` — a C6f-local typed error. `DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'` widens C6c's code union IN THE TYPE (no `as never` cast, no unreachable plain-`Error` fallback). The fingerprint arm throws `DocsConsistencyError` directly; C6c comparator errors are re-wrapped by carrying `error.code` (a `MetadataConsistencyCode`, a subtype) through the same union — still no cast. Every failure therefore exposes a real, typed `.code`, and the gate script catches this one error type.

- [ ] **Step 1: Write the failing test**

```ts
// docs-site/test/consistency.test.ts
import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { emitManifest } from '@movp/codegen'
import { assertManifestMatchesSchema, DocsConsistencyError, type DocsConsistencyCode } from '../src/dsl-reference/consistency.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  internal: false,
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}

function schema(collections: CollectionDef[]): MovpSchema {
  return { collections, events: [], projectCollections: collections, platformCollections: [] } as unknown as MovpSchema
}

describe('assertManifestMatchesSchema', () => {
  it('passes for a manifest freshly emitted from the schema', () => {
    const s = schema([deal])
    expect(() => assertManifestMatchesSchema(s, emitManifest(s, { generatorVersion: '0.1.0' }))).not.toThrow()
  })

  it('fails with .code === manifest_fingerprint_mismatch (typed, no cast) when the fingerprint is stale', () => {
    const s = schema([deal])
    const manifest = { ...emitManifest(s, { generatorVersion: '0.1.0' }), schemaFingerprint: 'sha256-stale' }
    // `instanceof` narrows `error` to DocsConsistencyError, so `error.code` is read
    // through the declared DocsConsistencyCode type — no `as` cast, no `as never`.
    let code: DocsConsistencyCode | undefined
    try {
      assertManifestMatchesSchema(s, manifest)
    } catch (error) {
      if (error instanceof DocsConsistencyError) code = error.code
    }
    expect(code).toBe('manifest_fingerprint_mismatch')
  })

  it('fails with a C6c stable id when the manifest omits a collection', () => {
    const s = schema([deal])
    const manifest = { ...emitManifest(s, { generatorVersion: '0.1.0' }), collections: [] }
    expect(() => assertManifestMatchesSchema(s, manifest)).toThrow(/missing_metadata_row/)
  })

  it('fails altered_metadata_row when a manifest field column diverges', () => {
    const s = schema([deal])
    const manifest = emitManifest(s, { generatorVersion: '0.1.0' })
    manifest.collections[0].fields[0].type = 'number'
    expect(() => assertManifestMatchesSchema(s, manifest)).toThrow(/altered_metadata_row/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/docs-site exec vitest run test/consistency.test.ts`
Expected: FAIL — `Cannot find module '../src/dsl-reference/consistency.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// docs-site/src/dsl-reference/consistency.ts
import type { MovpSchema } from '@movp/core-schema'
import { metadataProjection, schemaFingerprint } from '@movp/core-schema'
import {
  checkMetadataConsistency,
  MetadataConsistencyError,
  type MetadataConsistencyCode,
  type MetadataDbState,
  type SchemaManifest,
} from '@movp/codegen'

// C6f-local code union: C6c's three comparator codes PLUS the docs-only fingerprint
// code. Widening lives in the type — NOT an `as never` cast — so `.code` is exact and
// the fingerprint arm is a real, reachable throw (no unreachable plain-Error fallback).
export type DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'

export class DocsConsistencyError extends Error {
  constructor(
    readonly code: DocsConsistencyCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'DocsConsistencyError'
  }
}

// Rebuild the DB-shaped projection rows from the manifest so we can reuse C6c's
// pure comparator. label_plural is NOT in the manifest — source it from the schema
// projection for the comparator input; the fingerprint check below is what pins
// label_plural (and every other projected column) end-to-end.
function manifestAsDbState(schema: MovpSchema, manifest: SchemaManifest): MetadataDbState {
  const labelPluralByName = new Map(metadataProjection(schema).collections.map((c) => [c.name, c.label_plural]))
  return {
    collections: manifest.collections.map((c) => ({
      name: c.name,
      label: c.label,
      label_plural: labelPluralByName.get(c.name) ?? '',
      workspace_scoped: c.workspaceScoped,
      layer: c.layer,
    })),
    fields: manifest.collections.flatMap((c) =>
      c.fields.map((field) => ({
        collection_name: c.name,
        name: field.name,
        type: field.type,
        label: field.label,
        cardinality: field.cardinality,
        reporting_role: field.reporting_role,
        searchable: field.searchable,
        embeddable: field.embeddable,
        layer: c.layer,
      })),
    ),
  }
}

export function assertManifestMatchesSchema(schema: MovpSchema, manifest: SchemaManifest): void {
  // Reuse C6c's comparator: throws missing_/altered_/stale_metadata_row on divergence.
  // Re-wrap its MetadataConsistencyError into DocsConsistencyError so EVERY docs
  // consistency failure surfaces as one error type whose `.code` is a DocsConsistencyCode.
  // `error.code` is a MetadataConsistencyCode — a subtype of DocsConsistencyCode — so it
  // flows through the union with NO cast.
  try {
    checkMetadataConsistency(schema, manifestAsDbState(schema, manifest))
  } catch (error: unknown) {
    if (error instanceof MetadataConsistencyError) {
      throw new DocsConsistencyError(error.code, error.detail)
    }
    throw error
  }
  if (manifest.schemaFingerprint !== schemaFingerprint(schema)) {
    // Reachable, real throw — `manifest_fingerprint_mismatch` is in DocsConsistencyCode.
    throw new DocsConsistencyError(
      'manifest_fingerprint_mismatch',
      'docs-site/movp.schema.json is stale — run `pnpm docs:manifest`',
    )
  }
}
```

> **Executor note (typed code union, no cast):** the fingerprint code `manifest_fingerprint_mismatch` is C6f-local, so we do NOT throw C6c's `MetadataConsistencyError` with an out-of-union code. Instead a C6f-local `DocsConsistencyError` carries a `DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'`; the fingerprint arm throws it directly (a reachable branch — no `as never`, no unreachable plain-`Error` fallback), and C6c's comparator errors are re-wrapped by carrying `error.code` through the same union (subtype → union, still no cast). Do NOT use `any` or `as never`.

Create the gate script:

```ts
// scripts/check-docs-manifest.ts
// Gate: the committed docs manifest matches the live @movp/core-schema `schema`
// (projection + fingerprint). This is a pure schema check with NO database — the
// live-DB truth (schema <-> movp_fields) is C6c's `supabase db reset` gate, which
// this job does not duplicate. Run: pnpm check:docs-manifest.
import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { schema } from '@movp/core-schema'
import type { SchemaManifest } from '@movp/codegen'
import { assertManifestMatchesSchema, DocsConsistencyError } from '../docs-site/src/dsl-reference/consistency.ts'

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MANIFEST_PATH = fileURLToPath(new URL('../docs-site/movp.schema.json', import.meta.url))

function assertManifest(value: unknown): asserts value is SchemaManifest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid_manifest: not an object')
  const m = value as Record<string, unknown>
  if (m.manifestVersion !== 1) throw new Error('invalid_manifest: manifestVersion must be 1')
  if (typeof m.schemaFingerprint !== 'string') throw new Error('invalid_manifest: schemaFingerprint must be a string')
  if (!Array.isArray(m.collections)) throw new Error('invalid_manifest: collections must be an array')
}

async function main(): Promise<void> {
  const info = await lstat(MANIFEST_PATH)
  if (info.isSymbolicLink()) throw new Error(`invalid_manifest: ${MANIFEST_PATH} is a symlink`)
  if (info.size > MAX_MANIFEST_BYTES) throw new Error(`invalid_manifest: ${MANIFEST_PATH} exceeds ${MAX_MANIFEST_BYTES} bytes`)
  const parsed: unknown = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  assertManifest(parsed)
  try {
    assertManifestMatchesSchema(schema, parsed)
    console.log('docs manifest consistency: OK')
  } catch (error: unknown) {
    // One error type carries every stable code (C6c comparator + fingerprint) via
    // its typed `.code`; no message-prefix sniffing, no separate fallback branch.
    if (error instanceof DocsConsistencyError) {
      console.error(`docs manifest consistency FAILED [${error.code}]: ${error.detail}`)
      process.exit(1)
    }
    throw error
  }
}

await main()
```

Add to root `package.json` `scripts`:

```json
"check:docs-manifest": "tsx scripts/check-docs-manifest.ts",
```

- [ ] **Step 4: Run test to verify it passes + run the live gate**

Run: `pnpm --filter @movp/docs-site exec vitest run test/consistency.test.ts`
Expected: PASS — 4 tests.
Run: `pnpm check:docs-manifest`
Expected: `docs manifest consistency: OK` (exit 0), against the manifest committed in Task 2.

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/dsl-reference/consistency.ts docs-site/test/consistency.test.ts scripts/check-docs-manifest.ts package.json
git commit -m "feat(docs): C6f.4 manifest<->schema consistency gate reusing C6c comparator"
```

**Gate:** `pnpm --filter @movp/docs-site exec vitest run test/consistency.test.ts && pnpm check:docs-manifest` both exit 0 — proving **manifest ⇔ schema** (projection + fingerprint), NOT manifest ⇔ live DB (the live-DB half is C6c's `supabase db reset` gate; this docs job has no database). A stale fingerprint yields `[manifest_fingerprint_mismatch]`; a dropped/altered collection yields a C6c `[missing_metadata_row]` / `[altered_metadata_row]` — stable ids, detail names keys/columns only (no values).

---

### Task 5: Starlight site + authored content + `astro build` CI gate  ← NEW DEPENDENCY

**Files:**
- Modify: `docs-site/package.json` (add `astro` + `@astrojs/starlight` + `build`/`dev` scripts) — **after approval**
- Create: `docs-site/astro.config.mjs`, `docs-site/src/content.config.ts`, `docs-site/tsconfig.json`
- Create authored content: `docs-site/src/content/docs/index.md`, `quickstart.md`, `guides/crm-lite.md`, `guides/marketing.md`, `guides/support.md`, `guides/knowledge-base.md`, `agents/connectivity.md`
- Modify: root `package.json` (add `docs:build`), `.github/workflows/ci.yml` (add `docs` job)

**Interfaces:**
- Consumes: the generated `reference/` pages (Task 3) + authored content. No code API; this task wires the site and its build gate.
- Produces: a buildable Starlight site (`astro build`), a `docs` CI job that regenerates manifest + reference (freshness), runs the consistency gate, and builds.

- [ ] **Step 1: Obtain approval and add the dependency**

`@astrojs/starlight` is **APPROVED 2026-07-12** (sign-off recorded in INTERFACES "Approved new dependencies") — no approval STOP. You MUST still run `npm view @astrojs/starlight peerDependencies` and choose the version whose `astro` peer accepts `^6.0.0`; **if none exists, STOP and ask (do NOT downgrade Astro).** Then update `docs-site/package.json`:

```json
{
  "name": "@movp/docs-site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "test": "vitest run"
  },
  "dependencies": {
    "@astrojs/starlight": "<approved-version>",
    "@movp/codegen": "workspace:*",
    "@movp/core-schema": "workspace:*",
    "astro": "^6.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.2.6"
  }
}
```

Run: `pnpm install` (commit the updated lockfile).

- [ ] **Step 2: Astro + Starlight config**

```js
// docs-site/astro.config.mjs
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'MOVP',
      description: 'Scaffold an agent-connected product in minutes.',
      sidebar: [
        { label: 'Quickstart', slug: 'quickstart' },
        {
          label: 'Templates',
          items: [
            { label: 'CRM-lite', slug: 'guides/crm-lite' },
            { label: 'Marketing site', slug: 'guides/marketing' },
            { label: 'Support desk', slug: 'guides/support' },
            { label: 'Knowledge base', slug: 'guides/knowledge-base' },
          ],
        },
        { label: 'Agent connectivity', slug: 'agents/connectivity' },
        { label: 'Schema reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
})
```

```ts
// docs-site/src/content.config.ts
import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
```

```jsonc
// docs-site/tsconfig.json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 3: Authored content (copy-paste-correct, grounded in real facts)**

`docs-site/src/content/docs/index.md` (splash):

```md
---
title: MOVP
description: Scaffold an agent-connected product in minutes.
template: splash
hero:
  tagline: Scaffold an agent-connected product in minutes. The demo is the differentiator.
  actions:
    - text: Quickstart
      link: /quickstart/
      icon: right-arrow
    - text: Schema reference
      link: /reference/
      variant: minimal
---

MOVP scaffolds a working, agent-connected product: a Supabase-backed data platform, a GraphQL and
MCP surface, a CLI, and an Astro frontend. Pick a template, run one command, and start building.
```

`docs-site/src/content/docs/quickstart.md` (grounds `npx create-movp`, `pnpm bootstrap`, port `64322` — the last two are asserted by `scripts/check-quickstart-docs.mjs`):

```md
---
title: Quickstart
description: Scaffold and boot a MOVP project.
---

## Scaffold

```sh
npx create-movp
```

Pick a template (CRM-lite, Marketing, Support, or Knowledge base) and a project name. The scaffolder
copies the template, materializes the immutable platform migration bundle, runs project codegen for
your extension collections, and prints bootstrap steps.

## Boot the local stack

```sh
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` starts the port-isolated local Supabase stack. This repo uses the local Postgres
port **64322** (and sibling ports) to stay isolated from other local Supabase projects — do not
revert to the Supabase defaults.

## Connect an agent

Agent connectivity defaults to the hosted MCP endpoint. See
[Agent connectivity](/agents/connectivity/).
```

`docs-site/src/content/docs/agents/connectivity.md` (grounds hosted MCP streamable HTTP, PAT, CLI, stable error codes, `workspaceId` — mirrors `docs/agents/mcp/claude-code.md` + `docs/agents/error-codes.md`):

```md
---
title: Agent connectivity
description: Connect coding agents to MOVP over the hosted MCP endpoint.
---

MOVP exposes a **streamable-HTTP MCP** endpoint at `${apiUrl}/functions/v1/mcp`. Authenticate with a
**Personal Access Token** (`movp_pat_…`), minted at `/settings/tokens`. A PAT is **user-scoped**: it
grants exactly the creating user's access across all their workspaces — treat it as an account
credential and revoke on leak. `default_workspace_id` is a CLI home hint, not a security boundary.

## Transport matrix

| Client | Transport | Config |
| --- | --- | --- |
| Claude Code | streamable HTTP | `claude mcp add --transport http movp <apiUrl>/functions/v1/mcp --header "Authorization: Bearer movp_pat_…"` |
| Cursor / Copilot / Gemini / Codex | streamable HTTP | copy the matching config from `docs/agents/mcp/` |
| Stdio-only clients | `@movp/mcp-bridge` | set `MOVP_MCP_URL` + `MOVP_PAT` (local gateways may also need `MOVP_MCP_APIKEY`) |
| CLI | direct | `movp` reads a stored PAT and exchanges it for a session |

The hosted `mcp` function is `verify_jwt = false`, so only `Authorization` is required. If you front
the endpoint with a gateway that requires the Supabase `apikey` header, add `"apikey": "<ANON_KEY>"`.

## Every call carries `workspaceId`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

## Stable error codes

Agents branch on exactly these four (HTTP 401 with `{ "error": "<code>" }`):

| Code | Meaning | Remedy |
| --- | --- | --- |
| `missing_token` | no `Authorization` bearer | attach `Authorization: Bearer movp_pat_…` |
| `invalid_token` | bad / not-found / **revoked** PAT, or unverifiable JWT | re-authenticate; do not blind-retry |
| `expired_token` | PAT or session past `expires_at` | mint a fresh PAT / re-exchange |
| `invalid_claims` | verified session lacks required claims | re-authenticate |
```

`docs-site/src/content/docs/guides/crm-lite.md` (and the three siblings — real, concise, pointing at the template each part ships):

```md
---
title: CRM-lite template
description: Contacts, companies, and deals with a segment and an automation.
---

The CRM-lite template (shipped by C6d) extends the platform with `contact`, `company`, and `deal`
collections, a saved segment, and an automation, plus a few Astro pages and seed data. Scaffold it:

```sh
npx create-movp
# choose: crm-lite
```

Your extension collections appear in the [Schema reference](/reference/) once you regenerate the
manifest. Add a collection, run `movp new-delta <name>` to allocate an immutable codegen delta, and
regenerate.
```

Create `guides/marketing.md`, `guides/support.md`, `guides/knowledge-base.md` with the same shape,
naming each C6e template's real extension focus: Marketing = CMS content + SEO/AEO + publish
scheduling; Support = tickets-as-tasks + SLA `due_soon` automations + inbox; Knowledge base =
embeddable content + hybrid search.

- [ ] **Step 4: Regenerate derived content, then build**

Run (order matters — manifest, then reference, then build):

```sh
pnpm docs:manifest
pnpm docs:reference
pnpm --filter @movp/docs-site build
```

Expected: `astro build` completes with `0` errors and writes `docs-site/dist/`. Add `docs-site/dist/`
to `.gitignore` (or the root `.gitignore`) — the build output is not committed.

Add to root `package.json` `scripts`:

```json
"docs:build": "pnpm --filter @movp/docs-site build",
```

- [ ] **Step 5: Add the CI `docs` job**

Append to `.github/workflows/ci.yml` a job mirroring `schema-codegen-unit`'s freshness pattern (pin
`pnpm@9.12.0`, `node-version: 22`, per `ci-deploy-patterns`):

```yaml
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm docs:manifest
      - run: pnpm docs:reference
      - run: git diff --exit-code docs-site/movp.schema.json docs-site/src/content/docs/reference
      - run: pnpm check:docs-manifest
      - run: pnpm docs:build
```

> **Executor note:** `pnpm build` (root) builds `./packages/*` only, so `@movp/codegen`/`@movp/core-schema` are compiled before the `tsx` scripts import them; the docs site is built by the separate `pnpm docs:build` step. The `git diff --exit-code` step is the drift gate: a schema change that skips `pnpm docs:manifest`/`pnpm docs:reference` fails here.

- [ ] **Step 6: Commit**

```bash
git add docs-site/package.json docs-site/astro.config.mjs docs-site/src/content.config.ts docs-site/tsconfig.json docs-site/src/content/docs package.json .github/workflows/ci.yml pnpm-lock.yaml .gitignore
git commit -m "feat(docs): C6f.5 Starlight site + authored content + docs CI gate"
```

**Gate:** `pnpm docs:manifest && pnpm docs:reference && git diff --exit-code docs-site/movp.schema.json docs-site/src/content/docs/reference && pnpm check:docs-manifest && pnpm --filter @movp/docs-site build` all exit 0 in sequence. The Starlight sidebar resolves every authored slug and autogenerates the `reference/` section from the committed generated pages.

---

## Self-Review

**Spec coverage (C6f):** DSL-reference generator reads `movp.schema.json` (the C6c manifest, exact locked shape) → deterministic Starlight pages, drift-proof via commit + `git diff` gate (Tasks 1–3); Starlight site with quickstart, per-template guides (CRM-lite + 3 gallery), and a C3 agent-connectivity matrix authored from the real `docs/agents/mcp/*` + `docs/agents/error-codes.md` facts (Task 5); gates — docs build in CI (Task 5), manifest ⇔ schema consistency (projection + fingerprint) reusing C6c `checkMetadataConsistency` as a pure comparator with stable ids (Task 4) — the live-DB half (schema ⇔ `movp_fields`) is owned by C6c's `supabase db reset` gate (INTERFACES F7), which C6f consumes by transitivity rather than re-proving in a DB-less docs job — generator snapshot test fixed-manifest → expected pages (Task 1). The generator consumes the manifest ONLY (no schema TS import) — the drift-proofing the spec demands.

**Eight-dimension pass:** *Correctness* — generator is pure + snapshot-pinned; manifest/pages regenerated and diff-gated. *Safety* — untrusted-I/O discipline on every manifest read (lstat/symlink-reject, size bound, structural validation, path+reason logging); no secrets in docs (PATs shown as `movp_pat_…` placeholders). *Reliability* — freshness gates fail hard on drift; consistency gate throws the C6c stable ids. *Observability* — gate prints `[<stable_code>]` + key/column detail (never values). *Efficiency* — derived artifacts computed once per run, committed, diffed; no live DB. *Performance* — static site build; N/A hot path. *Simplicity* — one pure generator, thin tsx scripts, one new workspace package; no speculative playground (deferred per spec). *Usability* — authored quickstart/matrix with copy-paste commands; Starlight a11y/theming is the framework default.

**Assumptions (flag to the caller):**
1. **New dependency:** `@astrojs/starlight` requires approval before Task 5; its version must peer-accept `astro@^6.0.0` — if no such Starlight release exists yet, the executor STOPS (does not downgrade Astro). `astro`, `tsx`, `vitest` are already approved.
2. **06c has landed** and `@movp/codegen` exports `SchemaManifest`/`ManifestCollection`/`ManifestField`, `emitManifest`, `serializeManifest`, `checkMetadataConsistency`, `MetadataConsistencyError`, `MetadataConsistencyCode`, `MetadataDbState`; **06b** exports `schemaFingerprint`, `metadataProjection` from `@movp/core-schema`. C6f depends on 06c per INTERFACES.
3. **`MetadataConsistencyError`'s `code` type is `MetadataConsistencyCode`** (C6c). `manifest_fingerprint_mismatch` is a C6f-local code, so it is NOT forced onto C6c's error via `as never`. C6f defines a typed `DocsConsistencyError` whose `.code` is `DocsConsistencyCode = MetadataConsistencyCode | 'manifest_fingerprint_mismatch'`; the fingerprint arm throws it directly (reachable — no plain-`Error` fallback) and C6c comparator errors are re-wrapped by carrying `error.code` through the same union. No `any`, no `as never`.
4. **The monorepo `schema` carries `layer` on every collection** (all `'platform'` for the non-`extends` monorepo, per 06a). The committed `movp.schema.json` will therefore list the full platform DSL; the reference site documents the whole platform.
5. **`label_plural` is intentionally absent from the manifest** (locked C6c shape). Task 4 sources it from `metadataProjection(schema)` for the comparator and relies on the fingerprint equality to pin `label_plural` drift end-to-end — stated so a reviewer does not read it as a gap.
6. **DB-side `movp_fields`/`movp_collections` truth is the source signal owned by C6c's own `supabase db reset` consistency gate** (INTERFACES F7: `db reset` → live `movp_fields`/`movp_collections` query → `checkMetadataConsistency`). C6f **consumes** that established live signal; it does NOT reconstruct a manifest-derived `MetadataDbState` and treat it as live-DB evidence. C6f's own gate asserts only manifest ⇔ schema (fingerprint + projection comparator) — a pure, DB-less check — and manifest ⇔ `movp_fields` follows by transitivity across the two jobs, without adding `pg` or a live DB to the docs job. The docs CI job has no database, so the manifest ⇔ live-DB claim is never made by this job alone.
```
