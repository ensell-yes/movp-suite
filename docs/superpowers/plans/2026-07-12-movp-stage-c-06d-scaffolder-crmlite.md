# Stage C6d — Scaffolder Engine + CRM-lite + Verdaccio Proof (Implementation Plan)

**For agentic workers:** REQUIRED SUB-SKILL — load **`superpowers:executing-plans`** before starting.
Execute one task top-to-bottom: write the failing test, run it and see the stated FAIL, write the
minimal implementation, re-run to the stated PASS, then commit. Do not skip the machine-checkable
gate that closes each task. This plan is written for a context-poor executor: every code sample is
copy-paste-correct against the worktree `docs/stage-c6-templates-scaffolding` at the current tree,
and the seam plans 06a/06b/06c are PREREQUISITES already merged — consume their `Produces` exactly,
invent no cross-part API.

## Goal

Ship the last runnable piece of the C6 productization seam:

1. Bump every publishable `@movp/*` package **and** `@movp/platform` from `0.0.0 → 0.1.0` (06d owns
   this per INTERFACES "Ownership notes"), confirming no in-repo consumer pins `0.0.0`.
2. A new **unscoped `create-movp`** package: `npm create movp` / `npx create-movp` prompts for a
   template + project name, runs a **safe copier** (untrusted-I/O hardened), materializes the
   `@movp/platform` release bundle (via `verifyPlatformArtifact` from 06a), runs project codegen
   (06b/06c project mode), and prints bootstrap steps.
3. A **CRM-lite** template under `templates/crm-lite/`: `contact` / `company` / `deal` project
   extension collections (via `defineSchema({ extends })`), a seeded segment + automation (platform
   collections showcasing C5), a few Astro pages, a SQL seed, and a README — the exact "Scaffold
   layout produced by `create-movp`" from INTERFACES.
4. A **Verdaccio harness**: pack + publish `@movp/*` + `@movp/platform` + `create-movp` to a local
   registry, scaffold CRM-lite into a temp dir, `npm install` with **no workspace links**, run
   codegen → `supabase db reset` → **start the scaffold's real GraphQL + MCP edge functions** →
   authenticated HTTP GraphQL query + streamable-MCP `tools/call` over HTTP + CLI create/list green;
   assert no `file:`/workspace links; assert the copier rejects every unsafe input; run
   `movp verify-schema-runtime` (06b) green.

## Architecture

- **Version bump (Task 1).** Pure `package.json` edits + a grep gate. `check-release-preflight.mjs`
  does not read versions (verified: it only shells `npm org/whoami/org ls`), so it needs no change —
  Task 1 states this as an explicit N/A with evidence.
- **`create-movp` (Tasks 2–3, `packages/create-movp/`).** Unscoped published package. `src/copier.ts`
  is a **pure, synchronous, untrusted-I/O-hardened** file copier (no prompts, no network). `src/scaffold.ts`
  orchestrates: resolve target → copy template → substitute tokens → materialize platform bundle →
  run project codegen → print bootstrap steps. `src/cli.ts` (the `create-movp` bin) does the prompting
  and calls `scaffold`. The copier and scaffolder are unit-tested in isolation; the CLI is exercised
  end-to-end by the Verdaccio gate (Task 5).
- **CRM-lite template (Task 4, `templates/crm-lite/`).** A private-in-monorepo directory of template
  source. It is NOT a pnpm workspace package (it ships standalone `@movp/* @^0.1.0` pins); it lives
  under `templates/` (already globbed by `pnpm-workspace.yaml`) but carries **no** `package.json` at
  its root that pnpm would try to link — its `package.json` file is named `package.json.template` so
  pnpm never installs it, and the copier renames it on scaffold. (See Task 4 Step 2 for the exact
  rename map.)
- **Verdaccio gate (Task 5, `fixtures/verdaccio-crm-lite/`).** A `gate.sh` that stands up Verdaccio,
  publishes the bundle, scaffolds into `$TMP`, installs, and drives the real edge surfaces using the
  same env-file edge-serve pattern as `scripts/slice-e2e.sh`.

## Tech Stack

- TypeScript (ESM, `.ts` extension imports, `moduleResolution: bundler`, `strict: true`,
  **NEVER `any`** — `unknown` + narrowing), pnpm 9 workspace, Vitest `^3.2.6`, `tsx` `^4.19.0`.
- Node `node:fs`/`node:crypto`/`node:readline` (builtins — no new runtime dependency).
- `verdaccio` `^6` as a **devDependency of the fixture harness only** (Task 5 — this is the one new
  dependency; it is dev-only, hermetic-registry tooling, and MUST be approved before install; see the
  Task 5 note).
- Supabase local stack (Postgres 17, Deno 2 edge runtime), `psql`, Docker.

## Global Constraints

- **Consume 06a/06b/06c exactly; invent no cross-part API.** Signatures used verbatim:
  - 06a: `verifyPlatformArtifact(dir: string): void` (throws `platform_artifact_invalid`); the
    `@movp/platform` artifact layout `migrations/<ordered .sql>` + `manifest.json`
    `{ platformVersion, files: [{ name, sha256 }] }`; `defineSchema({ extends?, collections, events })`;
    `MovpSchema.projectCollections` / `platformCollections`; `CollectionDef.layer`.
  - 06b: `schemaFingerprint(schema): string`; CLI `buildProgram(schema, opts)`; command
    `movp verify-schema-runtime --config <movp.config.mjs> --deno-config <deno.json> --edge-schema <specifier>`.
  - 06c: `generate({ schema, migrationsDir, migrationName, deltasRegistryPath, manifestPath, generatorVersion? })`
    project mode; the `movp.deltas.json` registry `{ deltas: [{ file, collections, events }] }`; the
    `movp.schema.json` manifest.
- **NEVER `any`.** `unknown` + a runtime type guard, or a real type.
- **Untrusted-I/O discipline at every copier read** ([[untrusted-io-and-resource-bounds]]): `lstat`
  and reject symlinks BEFORE any `stat`/`read`; bound file size (`MAX_FILE_BYTES`) with `lstat.size`
  BEFORE `readFileSync`; enforce a running total cap (`MAX_TOTAL_BYTES`); never log file CONTENTS
  (path + reason only). These gotchas are commented at their trigger sites in Task 2.
- **Standalone install contract.** The scaffold pins `@movp/* @^0.1.0`, sets `packageManager`, Node +
  Supabase versions, and **defaults agent connectivity to the hosted MCP** (`/functions/v1/mcp`)
  because `@movp/mcp-bridge` is **private/unpublished** (`packages/mcp-bridge/package.json` has
  `"private": true` and no `publishConfig`). No `file:`/`workspace:` specifier may appear in a
  scaffolded `package.json` or lockfile — Task 5 greps for both and fails on a hit.
- **Port isolation.** The CRM-lite scaffold uses a DISTINCT `+200` port block
  (`64521/64522/64520/64523/64524/64529`) so a Verdaccio run never collides with the monorepo stack
  (`6432x`) or the 06a consumer fixture (`6442x`). See root `CLAUDE.md` "Supabase Local Stack Hygiene".
- **Forward-only migrations.** This plan adds NO monorepo migration. The scaffold's project baseline
  migration is generated at scaffold time (project mode), timestamped AFTER the whole platform stream.
- **No new runtime dependency.** The only new dependency is `verdaccio` (dev-only, Task 5) — get
  approval first (global rule: no new dependencies without approval).
- **Stable error codes (this part):** copier — `target_exists`, `invalid_project_name`,
  `template_symlink_rejected`, `template_file_too_large`, `template_total_too_large`,
  `unknown_token`, `unresolved_token`. Reused from 06a: `platform_artifact_invalid`.

---

## Task 1 — Version bump `0.0.0 → 0.1.0` across publishable `@movp/*` + `@movp/platform`

Bump every publishable package to `0.1.0` (so the Verdaccio publish + `@movp/* @^0.1.0` scaffold pins
resolve), and prove no in-repo consumer pins the literal `0.0.0`.

### Files

- **Modify (version field only, `"0.0.0"` → `"0.1.0"`):** each of
  `packages/auth/package.json`, `packages/cli/package.json`, `packages/codegen/package.json`,
  `packages/core-schema/package.json`, `packages/domain/package.json`, `packages/flows/package.json`,
  `packages/graphql/package.json`, `packages/mcp/package.json`, `packages/notifications/package.json`,
  `packages/obs/package.json`, `packages/search/package.json`, `packages/platform/package.json`.
- **Do NOT modify:** `packages/mcp-bridge/package.json` — it is `"private": true` and unpublished; it
  stays `0.0.0`. The monorepo root `package.json` and `templates/frontend-astro/package.json` stay
  `0.0.0` (both `"private"`; they consume workspace deps via `workspace:*`, never a version pin).
- **Create (the gate):** `scripts/check-publishable-versions.mjs`.

### Interfaces

- **Consumes:** the publishable list is exactly the 11 names already enumerated in
  `scripts/check-package-artifacts.mjs` (`auth, cli, codegen, core-schema, domain, flows, graphql,
  mcp, notifications, obs, search`) PLUS `platform` (added by 06a).
- **Produces (06d-internal, consumed by Task 5's publish step):** every publishable package + platform
  at `version: "0.1.0"`; `@movp/platform`'s `manifest.json` `platformVersion` becomes `0.1.0` on the
  next `pnpm --filter @movp/platform build` (it reads its own `package.json` version — verified in
  06a Task 3 `build.ts`).

### Steps

**1. Write the failing gate** `scripts/check-publishable-versions.mjs`:

```js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The publishable set that Verdaccio publishes and scaffolds pin at ^0.1.0. `mcp-bridge` is
// private/unpublished and intentionally excluded (it stays 0.0.0).
const PUBLISHABLE = [
  'auth', 'cli', 'codegen', 'core-schema', 'domain', 'flows',
  'graphql', 'mcp', 'notifications', 'obs', 'platform', 'search',
]
const EXPECTED = '0.1.0'

let failed = false
for (const name of PUBLISHABLE) {
  const pkgPath = join('packages', name, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.version !== EXPECTED) {
    console.error(`version check failed: ${pkg.name} is ${pkg.version}, expected ${EXPECTED}`)
    failed = true
  }
}

// No in-repo consumer may pin the literal 0.0.0 for a @movp dependency (workspace:* is fine).
import { execFileSync } from 'node:child_process'
const hits = execFileSync('git', ['grep', '-nE', '"@movp/[a-z-]+":\\s*"0\\.0\\.0"'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim().split('\n').filter(Boolean).catch?.(() => []) ?? []
// git grep exits 1 (no match) — treat a thrown error as "no hits" via the wrapper below.
```

Replace the fragile `git grep` tail above with this robust form (git grep exits non-zero when it
finds nothing, which would throw):

```js
function pinnedZeroConsumers() {
  try {
    const out = execFileSync('git', ['grep', '-nE', '"@movp/[a-z-]+":[[:space:]]*"0\\.0\\.0"'], {
      encoding: 'utf8',
    })
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return [] // git grep exit 1 = no matches
  }
}

for (const line of pinnedZeroConsumers()) {
  console.error(`consumer pins @movp dependency at 0.0.0: ${line}`)
  failed = true
}

if (failed) process.exit(1)
console.log('publishable versions: all @movp publishables at 0.1.0, no 0.0.0 consumer pins')
```

(Author the file as ONE coherent script: the `PUBLISHABLE`/`EXPECTED` loop, the `execFileSync` import
at the top, then `pinnedZeroConsumers()` + its loop + the final `process.exit`. Delete the throwaway
`.catch?.` sketch — it was only to show the failure mode.)

Run — **Expected: FAIL** (`... is 0.0.0, expected 0.1.0` for all 12, since nothing is bumped yet):

```
node scripts/check-publishable-versions.mjs
```

**2. Add the script to root `package.json` scripts** (after `check:packages`):

```json
    "check:publishable-versions": "node scripts/check-publishable-versions.mjs",
```

**3. Bump each publishable `package.json`** `"version": "0.0.0"` → `"version": "0.1.0"` (the 12 files
listed under Files). Edit only the `version` field; leave `publishConfig`, `main`, `exports` untouched.

**4. Confirm no in-repo consumer pins `0.0.0`.** Run:

```
git grep -nE '"@movp/[a-z-]+":[[:space:]]*"0\.0\.0"'
```

**Expected: EMPTY** (all internal deps use `workspace:*`; verified in the current tree — root
`package.json` devDeps are `@movp/codegen`/`@movp/core-schema` `workspace:*`). If this prints a line,
STOP and reconcile before continuing.

**5. Rebuild the platform artifact** so its manifest carries the new `platformVersion`:

```
pnpm --filter @movp/platform build
```

**Expected:** prints `@movp/platform: bundled <N> migrations (platformVersion 0.1.0)`.

**6. Run the whole monorepo suite** (nothing behavioural changed; a version bump must not break tests):

```
pnpm -w test && pnpm -w typecheck
```

**Expected:** green.

**7. Commit** (`chore(c6d): bump publishable @movp/* + @movp/platform to 0.1.0`).

### Gate (machine-checkable)

```
node scripts/check-publishable-versions.mjs \
  && pnpm --filter @movp/platform build \
  && git grep -nE '"@movp/[a-z-]+":[[:space:]]*"0\.0\.0"' ; test $? -eq 1
```

**Expected:** the version script prints its success line; the platform build prints `platformVersion
0.1.0`; the final `git grep` finds nothing (exit 1, asserted). `check-release-preflight.mjs` is
unchanged **(N/A with evidence: it reads no version — it only shells `npm org --help`, `npm whoami`,
`npm org ls movp`).**

---

## Task 2 — `create-movp` package + safe copier (pure, untrusted-I/O hardened)

Create the unscoped package skeleton and the pure copier. All unsafe-input rejections are unit-tested
here; the CLI/orchestration lands in Task 3.

### Files

- **Create:** `packages/create-movp/package.json`
- **Create:** `packages/create-movp/tsconfig.json`
- **Create:** `packages/create-movp/vitest.config.ts`
- **Create:** `packages/create-movp/.gitignore`
- **Create:** `packages/create-movp/src/copier.ts`
- **Create:** `packages/create-movp/src/index.ts`
- **Test (create):** `packages/create-movp/test/copier.test.ts`

### Interfaces

- **Consumes:** none (pure `node:fs`/`node:path`).
- **Produces (LOCKED — consumed by Task 3's scaffolder + Task 5's copier-safety assertions):**
  - `interface CopyOptions { templateDir: string; targetDir: string; tokens: Record<string, string> }`
  - `function resolveTargetDir(parentDir: string, projectName: string): string` — validates the name
    charset, rejects `..`, resolves under `parentDir`, requires the result absent. Throws
    `invalid_project_name` / `target_exists`.
  - `function copyTemplate(opts: CopyOptions): { filesWritten: number; bytesWritten: number }` — the
    hardened copy+substitute. Throws the stable copier codes on any unsafe input.
  - Exported constants `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `TOKEN_PATTERN`.

### Steps

**1. `packages/create-movp/package.json`** (unscoped so `npm create movp` / `npx create-movp`
resolve; `version: 0.1.0` to match the bundle; `bin.create-movp` points at the Task 3 CLI, created
next task but declared now):

```json
{
  "name": "create-movp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "create-movp": "./dist/cli.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsup src/index.ts src/cli.ts --format esm --dts --sourcemap --clean --target node20 --out-dir dist"
  },
  "devDependencies": {
    "vitest": "^3.2.6",
    "tsx": "^4.19.0",
    "tsup": "^8.5.1",
    "@types/node": "^26.0.1"
  },
  "publishConfig": {
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "bin": {
      "create-movp": "./dist/cli.js"
    }
  },
  "files": [
    "dist",
    "templates"
  ]
}
```

> **Gotcha (inline at the trigger):** the published `create-movp` tarball must contain the template
> source, so `files` includes `templates` and Task 3 Step "bundle templates" copies
> `templates/crm-lite/` into `packages/create-movp/templates/crm-lite/` at build time. The copier's
> `templateDir` at runtime is resolved relative to the INSTALLED package, never the monorepo.

**2. `packages/create-movp/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

**3. `packages/create-movp/vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

**4. `packages/create-movp/.gitignore`:**

```
dist/
templates/
```

(The `templates/` copy inside the package is a build artifact; the source of truth is the repo-root
`templates/crm-lite/`.)

**5. Write the failing test** `packages/create-movp/test/copier.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyTemplate, resolveTargetDir } from '../src/copier.ts'

let work: string
let templateDir: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'create-movp-'))
  templateDir = join(work, 'template')
  mkdirSync(templateDir, { recursive: true })
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

const tokens = { __PROJECT_NAME__: 'acme-crm', __WORKSPACE_ID__: '33333333-3333-3333-3333-333333333333' }

describe('resolveTargetDir', () => {
  it('resolves an absent dir under the parent', () => {
    expect(resolveTargetDir(work, 'acme-crm')).toBe(join(work, 'acme-crm'))
  })
  it('rejects a name with path traversal', () => {
    expect(() => resolveTargetDir(work, '../evil')).toThrow(/invalid_project_name/)
    expect(() => resolveTargetDir(work, 'a/b')).toThrow(/invalid_project_name/)
  })
  it('rejects an invalid charset', () => {
    expect(() => resolveTargetDir(work, 'Acme_CRM')).toThrow(/invalid_project_name/)
    expect(() => resolveTargetDir(work, '9lives')).toThrow(/invalid_project_name/)
  })
  it('rejects an existing target', () => {
    mkdirSync(join(work, 'taken'))
    expect(() => resolveTargetDir(work, 'taken')).toThrow(/target_exists/)
  })
})

describe('copyTemplate', () => {
  it('copies allowlisted text files and substitutes declared tokens', () => {
    writeFileSync(join(templateDir, 'README.md'), '# __PROJECT_NAME__\nws=__WORKSPACE_ID__\n')
    mkdirSync(join(templateDir, 'src'))
    writeFileSync(join(templateDir, 'src', 'app.ts'), 'export const name = "__PROJECT_NAME__"\n')
    const target = join(work, 'out')
    const res = copyTemplate({ templateDir, targetDir: target, tokens })
    expect(res.filesWritten).toBe(2)
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# acme-crm\nws=33333333-3333-3333-3333-333333333333\n')
    expect(readFileSync(join(target, 'src', 'app.ts'), 'utf8')).toContain('"acme-crm"')
  })

  it('excludes build/cache dirs (node_modules, dist, .astro, .git)', () => {
    writeFileSync(join(templateDir, 'keep.ts'), 'ok\n')
    for (const d of ['node_modules', 'dist', '.astro', '.git']) {
      mkdirSync(join(templateDir, d))
      writeFileSync(join(templateDir, d, 'junk.ts'), 'junk\n')
    }
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    for (const d of ['node_modules', 'dist', '.astro', '.git']) {
      expect(() => readFileSync(join(target, d, 'junk.ts'))).toThrow()
    }
    expect(readFileSync(join(target, 'keep.ts'), 'utf8')).toBe('ok\n')
  })

  it('rejects a symlink in the template tree WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    symlinkSync(join(work, 'secret'), join(templateDir, 'notes.ts'))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_symlink_rejected/)
  })

  it('rejects an oversized file before buffering it', () => {
    writeFileSync(join(templateDir, 'big.sql'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_file_too_large/)
  })

  it('rejects when the running total exceeds the cap', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(templateDir, `f${i}.sql`), 'y'.repeat(4 * 1024 * 1024))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_total_too_large/)
  })

  it('copies a binary allowlisted file byte-for-byte WITHOUT substitution', () => {
    // A PNG-ish buffer with a NUL and a token-shaped sequence that must NOT be substituted.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from('__PROJECT_NAME__')])
    writeFileSync(join(templateDir, 'logo.png'), bytes)
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    expect(readFileSync(join(target, 'logo.png'))).toEqual(bytes)
  })

  it('rejects an unknown token key in the map', () => {
    writeFileSync(join(templateDir, 'a.ts'), 'x\n')
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens: { PROJECT_NAME: 'x' } }))
      .toThrow(/unknown_token/)
  })

  it('rejects an unresolved token left in a text file', () => {
    writeFileSync(join(templateDir, 'b.ts'), 'const x = "__NOT_DECLARED__"\n')
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/unresolved_token/)
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '../src/copier.ts'`):

```
pnpm install \
  && pnpm --filter create-movp exec vitest run
```

(`pnpm install` links the new workspace package — `packages/*` is globbed by `pnpm-workspace.yaml`.)

**6. Implement** `packages/create-movp/src/copier.ts`:

```ts
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024
export const TOKEN_PATTERN = /__[A-Z0-9_]+__/g

const PROJECT_NAME = /^[a-z][a-z0-9-]*$/

// Directories that are build/cache output and must never be copied into a fresh scaffold.
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', '.turbo', '.wrangler'])

// Extension allowlist for SUBSTITUTABLE text files. Anything else that is allowlisted-binary is
// copied byte-for-byte; anything not allowlisted at all is skipped.
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro', '.json', '.jsonc', '.sql',
  '.md', '.css', '.html', '.txt', '.toml', '.yaml', '.yml',
])
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2'])
// Exact filenames (no extension) that are still text and allowlisted.
const TEXT_NAMES = new Set(['.gitignore', '.npmrc', '.assetsignore', '.nvmrc'])

export interface CopyOptions {
  templateDir: string
  targetDir: string
  tokens: Record<string, string>
}

class CopierError extends Error {
  constructor(code: string, detail: string) {
    // NEVER include file CONTENTS — path + reason only (untrusted-io content discipline).
    super(`${code}: ${detail}`)
    this.name = 'CopierError'
  }
}

export function resolveTargetDir(parentDir: string, projectName: string): string {
  if (!PROJECT_NAME.test(projectName) || projectName.includes('..')) {
    throw new CopierError('invalid_project_name', `"${projectName}" must match ${PROJECT_NAME}`)
  }
  const target = resolve(parentDir, projectName)
  // Defence in depth: the resolved path must stay a direct child of the parent.
  if (target !== join(parentDir, projectName) || !target.startsWith(resolve(parentDir) + sep)) {
    throw new CopierError('invalid_project_name', `"${projectName}" escapes the parent directory`)
  }
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing) throw new CopierError('target_exists', target)
  return target
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function isBinaryBuffer(buf: Buffer): boolean {
  // A NUL byte in the first 8KB marks the file as binary (skip substitution).
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

function substitute(text: string, tokens: Record<string, string>, relPath: string): string {
  const out = text.replace(TOKEN_PATTERN, (match) => {
    const value = tokens[match]
    if (value === undefined) throw new CopierError('unresolved_token', `${relPath} contains ${match}`)
    return value
  })
  // Belt-and-suspenders: no token-shaped residue may survive (a token that wasn't declared).
  const residue = out.match(TOKEN_PATTERN)
  if (residue) throw new CopierError('unresolved_token', `${relPath} still contains ${residue[0]}`)
  return out
}

export function copyTemplate(opts: CopyOptions): { filesWritten: number; bytesWritten: number } {
  for (const key of Object.keys(opts.tokens)) {
    if (!/^__[A-Z0-9_]+__$/.test(key)) throw new CopierError('unknown_token', `token key "${key}" is not __NAME__ shaped`)
  }

  let filesWritten = 0
  let bytesWritten = 0

  const walk = (relDir: string): void => {
    const absDir = join(opts.templateDir, relDir)
    for (const entry of readdirSync(absDir).sort()) {
      const rel = relDir ? join(relDir, entry) : entry
      const abs = join(absDir, entry)
      // lstat BEFORE any stat/read: a symlink in the template could point at ~/.ssh/id_rsa.
      const info = lstatSync(abs)
      if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', rel)
      if (info.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue
        walk(rel)
        continue
      }
      if (!info.isFile()) continue

      const ext = extname(entry)
      const isText = TEXT_EXTS.has(ext) || TEXT_NAMES.has(entry)
      const isBinary = BINARY_EXTS.has(ext)
      if (!isText && !isBinary) continue // not allowlisted → skip (fonts, unknown blobs)

      // Bound BEFORE buffering: reject an oversized file without reading it into memory.
      if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', rel)
      if (bytesWritten + info.size > MAX_TOTAL_BYTES) throw new CopierError('template_total_too_large', rel)

      const buf = readFileSync(abs)
      mkdirSync(join(opts.targetDir, relDir), { recursive: true })
      const outPath = join(opts.targetDir, rel)
      if (isBinary || isBinaryBuffer(buf)) {
        writeFileSync(outPath, buf) // byte-for-byte; NEVER substitute a binary
      } else {
        writeFileSync(outPath, substitute(buf.toString('utf8'), opts.tokens, rel))
      }
      filesWritten += 1
      bytesWritten += info.size
    }
  }

  mkdirSync(opts.targetDir, { recursive: true })
  walk('')
  return { filesWritten, bytesWritten }
}
```

**7. `packages/create-movp/src/index.ts`:**

```ts
export {
  copyTemplate,
  resolveTargetDir,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TOKEN_PATTERN,
  type CopyOptions,
} from './copier.ts'
```

Re-run — **Expected: PASS** (4 `resolveTargetDir` + 8 `copyTemplate` = 12 assertions across the
described cases). Then typecheck:

```
pnpm --filter create-movp exec vitest run
pnpm --filter create-movp exec tsc --noEmit
```

**8. Commit** (`feat(c6d): create-movp package + untrusted-io-hardened safe copier`).

### Gate (machine-checkable)

```
pnpm --filter create-movp exec vitest run \
  && pnpm --filter create-movp exec tsc --noEmit
```

**Expected:** copier suite green; every unsafe input (`..`, bad charset, existing target, symlink,
oversized file, total-cap, unknown token, unresolved token) throws its stable code; a binary file is
copied byte-identically; typecheck clean.

---

## Task 3 — `create-movp` scaffolder orchestration + CLI

Wire the copier into the full flow: resolve target → copy → materialize the platform bundle (06a) →
run project codegen (06b/06c) → print bootstrap steps; add the prompting CLI bin.

### Files

- **Create:** `packages/create-movp/src/scaffold.ts`
- **Create:** `packages/create-movp/src/cli.ts`
- **Modify:** `packages/create-movp/src/index.ts` (export `scaffold`)
- **Test (create):** `packages/create-movp/test/scaffold.test.ts`

### Interfaces

- **Consumes (exact signatures):**
  - 06a: `import { verifyPlatformArtifact } from '@movp/platform'` — `verifyPlatformArtifact(dir: string): void`.
  - 06c: `import { generate } from '@movp/codegen'` —
    `generate({ schema: MovpSchema; migrationsDir: string; migrationName: string; deltasRegistryPath: string; manifestPath: string; generatorVersion?: string }): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }>`.
  - The scaffold's project schema, imported at scaffold time from the freshly-copied
    `movp.config.mjs` (which re-exports `supabase/functions/_shared/schema.ts`).
- **Produces (LOCKED — consumed by Task 5 + 06e):**
  - `interface ScaffoldOptions { templateDir: string; parentDir: string; projectName: string; workspaceId: string; platformArtifactDir: string }`
  - `function scaffold(opts: ScaffoldOptions): Promise<{ targetDir: string; bootstrap: string[] }>` —
    the full deterministic scaffold. `bootstrap` is the ordered list of shell steps printed to the
    user (also the contract Task 5's gate follows).

### Steps

**1. Write the failing test** `packages/create-movp/test/scaffold.test.ts` (uses a MINIMAL fake
template + a MINIMAL fake platform artifact so the unit test needs no real DB or published packages;
the real CRM-lite + real platform bundle are exercised by Task 5):

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffold } from '../src/scaffold.ts'

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'scaffold-')) })
afterEach(() => rmSync(work, { recursive: true, force: true }))

function fakePlatformArtifact(dir: string): void {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations, { recursive: true })
  const body = '-- platform baseline\n'
  writeFileSync(join(migrations, '20260701000001_init.sql'), body)
  const sha256 = createHash('sha256').update(Buffer.from(body)).digest('hex')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    platformVersion: '0.1.0', files: [{ name: '20260701000001_init.sql', sha256 }],
  }, null, 2))
}

function fakeTemplate(dir: string): void {
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# __PROJECT_NAME__ (ws __WORKSPACE_ID__)\n')
  writeFileSync(join(dir, 'movp.deltas.json'), JSON.stringify({ deltas: [] }, null, 2) + '\n')
  // A movp.config.mjs whose schema has ZERO project collections keeps codegen a no-op baseline.
  writeFileSync(join(dir, 'movp.config.mjs'),
    'export const schema = { collections: [], events: [], projectCollections: [], platformCollections: [] }\n')
}

describe('scaffold', () => {
  it('copies the template, materializes the platform bundle first, runs codegen, prints bootstrap', async () => {
    const templateDir = join(work, 'template')
    const platformDir = join(work, 'platform')
    fakeTemplate(templateDir)
    fakePlatformArtifact(platformDir)

    const res = await scaffold({
      templateDir,
      parentDir: work,
      projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      platformArtifactDir: platformDir,
    })

    expect(res.targetDir).toBe(join(work, 'acme-crm'))
    // token substitution happened
    expect(readFileSync(join(res.targetDir, 'README.md'), 'utf8')).toContain('# acme-crm (ws 33333333')
    // platform migration materialized into the scaffold, ahead of any project migration
    expect(readFileSync(join(res.targetDir, 'supabase', 'migrations', '20260701000001_init.sql'), 'utf8'))
      .toBe('-- platform baseline\n')
    // bootstrap steps are ordered + non-empty
    expect(res.bootstrap.length).toBeGreaterThan(0)
    expect(res.bootstrap.join('\n')).toContain('npm install')
  })

  it('refuses a tampered platform artifact (digest mismatch → platform_artifact_invalid)', async () => {
    const templateDir = join(work, 'template')
    const platformDir = join(work, 'platform')
    fakeTemplate(templateDir)
    fakePlatformArtifact(platformDir)
    writeFileSync(join(platformDir, 'migrations', '20260701000001_init.sql'), '-- tampered\n')
    await expect(scaffold({
      templateDir, parentDir: work, projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333', platformArtifactDir: platformDir,
    })).rejects.toThrow(/platform_artifact_invalid/)
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '../src/scaffold.ts'`):

```
pnpm --filter create-movp exec vitest run scaffold
```

**2. Implement** `packages/create-movp/src/scaffold.ts`:

```ts
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MovpSchema } from '@movp/core-schema'
import { generate } from '@movp/codegen'
import { verifyPlatformArtifact } from '@movp/platform'
import { copyTemplate, resolveTargetDir } from './copier.ts'

export interface ScaffoldOptions {
  templateDir: string
  parentDir: string
  projectName: string
  workspaceId: string
  platformArtifactDir: string
}

// Project baseline sorts AFTER the whole platform stream so the `layer` column (06a's
// 20260713000001_metadata_layer.sql) already exists when project metadata upserts run.
const PROJECT_BASELINE = '20260715000000_movp_generated.sql'

export async function scaffold(
  opts: ScaffoldOptions,
): Promise<{ targetDir: string; bootstrap: string[] }> {
  const targetDir = resolveTargetDir(opts.parentDir, opts.projectName)

  // 1. Copy the template + substitute the two declared tokens.
  copyTemplate({
    templateDir: opts.templateDir,
    targetDir,
    tokens: {
      __PROJECT_NAME__: opts.projectName,
      __WORKSPACE_ID__: opts.workspaceId,
    },
  })

  // 2. Materialize the immutable platform bundle AHEAD of any project migration. verify FIRST
  //    (throws platform_artifact_invalid on any tamper), then COPY the .sql files (never symlink).
  verifyPlatformArtifact(opts.platformArtifactDir)
  const migrationsDir = join(targetDir, 'supabase', 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
  const srcMigrations = join(opts.platformArtifactDir, 'migrations')
  for (const name of readdirSync(srcMigrations).sort()) {
    if (!name.endsWith('.sql')) continue
    const abs = join(srcMigrations, name)
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`platform_artifact_invalid: migration is a symlink: ${name}`)
    copyFileSync(abs, join(migrationsDir, name))
  }

  // 3. Run project codegen (project mode, keyed on deltasRegistryPath). Emits ONLY the project
  //    baseline + registered deltas + the movp.schema.json manifest. Load the schema from the
  //    freshly-copied movp.config.mjs via a file URL so tsx/ESM resolves the composed schema.
  const configUrl = pathToFileURL(join(targetDir, 'movp.config.mjs')).href
  const mod = (await import(configUrl)) as { schema: MovpSchema }
  await generate({
    schema: mod.schema,
    migrationsDir,
    migrationName: PROJECT_BASELINE,
    deltasRegistryPath: join(targetDir, 'movp.deltas.json'),
    manifestPath: join(targetDir, 'movp.schema.json'),
  })

  // 4. Bootstrap steps (also the contract Task 5's gate follows, in order).
  const bootstrap = [
    `cd ${opts.projectName}`,
    'npm install',
    'supabase start',
    'npm run codegen',
    'supabase db reset',
    'npm run verify-schema-runtime',
    'supabase functions serve --env-file supabase/.env.local',
    'npm run dev',
  ]
  return { targetDir, bootstrap }
}
```

> **Platform-runtime gotcha (inline):** `create-movp` runs under Node via `tsx` (its bin is ESM). The
> `import(configUrl)` of `movp.config.mjs` re-exports `supabase/functions/_shared/schema.ts` (a `.ts`
> file), which requires the tsx loader — the `create-movp` bin (Step 4 below) MUST be launched with a
> tsx-capable runtime; the published `dist/cli.js` bundles nothing from the scaffold, so the tsx
> requirement is satisfied by the scaffold's own `packageManager`/`tsx` devDep (Task 4). In the unit
> test above the config is plain `.mjs` with an inline object, so no tsx is needed there.

**3. Add `scaffold` to `packages/create-movp/src/index.ts`:**

```ts
export { scaffold, type ScaffoldOptions } from './scaffold.ts'
```

**4. Implement the CLI bin** `packages/create-movp/src/cli.ts` (prompts, then calls `scaffold`;
`@movp/platform` and `@movp/codegen` are resolved from the INSTALLED package's own dependencies):

```ts
#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { scaffold } from './scaffold.ts'

const TEMPLATES = ['crm-lite'] as const
type TemplateName = (typeof TEMPLATES)[number]

function bundledTemplateDir(name: TemplateName): string {
  // Templates ship INSIDE the create-movp tarball (package.json "files": ["dist","templates"]).
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'templates', name)
}

function bundledPlatformDir(): string {
  // @movp/platform is a runtime dependency of create-movp; its dist/ carries the migration bundle.
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('@movp/platform/package.json')
  return join(dirname(pkgJson), 'dist')
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const template = (await rl.question(`Template (${TEMPLATES.join(', ')}) [crm-lite]: `)).trim() || 'crm-lite'
    if (!TEMPLATES.includes(template as TemplateName)) throw new Error(`unknown template: ${template}`)
    const projectName = (await rl.question('Project name: ')).trim()
    const workspaceId =
      (await rl.question('Workspace UUID [33333333-3333-3333-3333-333333333333]: ')).trim() ||
      '33333333-3333-3333-3333-333333333333'

    const { targetDir, bootstrap } = await scaffold({
      templateDir: bundledTemplateDir(template as TemplateName),
      parentDir: process.cwd(),
      projectName,
      workspaceId,
      platformArtifactDir: bundledPlatformDir(),
    })
    console.log(`\nScaffolded ${projectName} at ${targetDir}\n\nNext steps:`)
    for (const step of bootstrap) console.log(`  ${step}`)
  } finally {
    rl.close()
  }
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
```

Add `@movp/platform` + `@movp/codegen` + `@movp/core-schema` as runtime `dependencies` of
`packages/create-movp/package.json` (they are resolved at scaffold time, not dev-time). Append to
the manifest from Task 2 Step 1:

```json
  "dependencies": {
    "@movp/codegen": "^0.1.0",
    "@movp/core-schema": "^0.1.0",
    "@movp/platform": "^0.1.0"
  },
```

> **Gotcha (inline):** these are pinned `^0.1.0`, NOT `workspace:*` — the published `create-movp`
> must resolve them from the registry (Verdaccio in CI, npm in prod). During local monorepo dev pnpm
> still links them from the workspace because the versions match `0.1.0`; the Verdaccio gate proves
> the registry-resolution path.

Re-run the scaffold unit test — **Expected: PASS** (2 tests). Typecheck:

```
pnpm --filter create-movp exec vitest run scaffold
pnpm --filter create-movp exec tsc --noEmit
```

**5. Commit** (`feat(c6d): create-movp scaffolder orchestration + prompting CLI`).

### Gate (machine-checkable)

```
pnpm --filter create-movp exec vitest run \
  && pnpm --filter create-movp exec tsc --noEmit
```

**Expected:** copier (Task 2) + scaffold (Task 3) suites green; scaffold materializes the platform
bundle ahead of project migrations and rejects a tampered artifact with `platform_artifact_invalid`;
typecheck clean.

---

## Task 4 — CRM-lite template (`templates/crm-lite/`)

Author the standalone CRM-lite template: `contact`/`company`/`deal` project extensions, real edge
functions that expose the COMPOSED schema, project-aware CLI/codegen bins, Astro pages, a seed, and a
README — the exact "Scaffold layout produced by `create-movp`" from INTERFACES.

### Files (all under `templates/crm-lite/`)

- **Schema authority:** `supabase/functions/_shared/schema.ts`, `movp.config.mjs`
- **Edge functions:** `supabase/functions/mcp/index.ts`, `supabase/functions/mcp/deno.json`,
  `supabase/functions/graphql/index.ts`, `supabase/functions/graphql/deno.json`
- **Supabase project:** `supabase/config.toml`, `supabase/seed.sql`, `supabase/.gitignore`
- **Codegen state:** `movp.deltas.json`
- **Project bins:** `bin/movp.mjs`, `bin/codegen.mjs`
- **App:** `package.json.template`, `tsconfig.json`, `astro.config.mjs`, `wrangler.jsonc`,
  `src/lib/env.ts`, `src/lib/graphql.ts`, `src/layouts/Base.astro`, `src/pages/index.astro`,
  `src/pages/contacts.astro`, `src/pages/companies.astro`, `src/pages/deals.astro`
- **Docs/ignore:** `README.md`, `.gitignore`
- **Test (create):** `packages/create-movp/test/crm-lite-template.test.ts` (structural fixture test —
  proves the template composes + fingerprints, without a DB)

### Interfaces

- **Consumes:** 06a `defineSchema({ extends })` + `schema` (platform) from `@movp/core-schema`; 06b
  `schemaFingerprint`; 06b `buildProgram(schema, opts)` from `@movp/cli`; the generated GraphQL/MCP
  builders (`buildSchema`, `buildMcpServer`) unchanged.
- **Produces (LOCKED — the template-layout contract 06e's gallery templates copy):** the file set
  above; the token set `{ __PROJECT_NAME__, __WORKSPACE_ID__ }`; the project-aware bin pattern
  (`bin/movp.mjs` = `buildProgram(projectSchema)`) and edge-function pattern (import schema from
  `../_shared/schema.ts`, resolve `@movp/*` via `npm:@movp/*@^0.1.0`).

### Steps

**1. Schema module** `templates/crm-lite/supabase/functions/_shared/schema.ts` — the SINGLE schema
authority, imported by Node (via `movp.config.mjs`) AND Deno (edge functions):

```ts
import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

const contact = defineCollection({
  name: 'contact',
  label: 'Contact',
  labelPlural: 'Contacts',
  workspaceScoped: true,
  fields: {
    full_name: f.text({ label: 'Full name', required: true, searchable: true }),
    email: f.text({ label: 'Email', searchable: true }),
    title: f.text({ label: 'Title' }),
    company: f.relation('company', { label: 'Company', cardinality: 'many-to-one', graph: true }),
  },
})

const company = defineCollection({
  name: 'company',
  label: 'Company',
  labelPlural: 'Companies',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    domain: f.text({ label: 'Domain' }),
    tier: f.enum(['smb', 'mid_market', 'enterprise'], { label: 'Tier', reporting: { role: 'dimension' } }),
  },
})

const deal = defineCollection({
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    amount: f.number({ label: 'Amount', reporting: { role: 'measure' } }),
    stage: f.enum(['lead', 'qualified', 'proposal', 'won', 'lost'], {
      label: 'Stage', default: 'lead', reporting: { role: 'dimension' },
    }),
    company: f.relation('company', { label: 'Company', cardinality: 'many-to-one', graph: true }),
    primary_contact: f.relation('contact', { label: 'Primary contact', cardinality: 'many-to-one', graph: true }),
  },
})

// Project schema = platform schema + these three extensions. defineSchema({ extends }) stamps the
// three as layer:'project' and every inherited collection as layer:'platform' (06a).
export const schema = defineSchema({ extends: platformSchema, collections: [contact, company, deal] })
```

**2. `templates/crm-lite/movp.config.mjs`** — the Node re-export of the one schema module:

```js
// Node tooling (codegen, the movp CLI, verify-schema-runtime) reads the schema here; Deno edge
// functions import the SAME ../_shared/schema.ts directly. Both compute the identical
// schemaFingerprint (06b), which `movp verify-schema-runtime` asserts before serve/deploy.
export { schema } from './supabase/functions/_shared/schema.ts'
```

**3. Project-aware CLI bin** `templates/crm-lite/bin/movp.mjs`:

```js
#!/usr/bin/env -S npx tsx
// The published @movp/cli bin bakes in the PLATFORM schema only. A scaffold's CLI must expose the
// COMPOSED project schema (contact/company/deal), so it wires buildProgram(schema) here. Run via
// `npm run movp -- <cmd>` (package.json script), never the installed `movp` bin.
import { buildProgram } from '@movp/cli'
import { schema } from '../movp.config.mjs'

buildProgram(schema)
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
```

**4. Project codegen bin** `templates/crm-lite/bin/codegen.mjs`:

```js
#!/usr/bin/env -S npx tsx
// Project-mode codegen: emits ONLY the project baseline + registered deltas + movp.schema.json,
// keyed on deltasRegistryPath (06c). Never touches the platform migration bundle.
import { generate } from '@movp/codegen'
import { schema } from '../movp.config.mjs'

const cwd = process.cwd()
await generate({
  schema,
  migrationsDir: `${cwd}/supabase/migrations`,
  migrationName: '20260715000000_movp_generated.sql',
  deltasRegistryPath: `${cwd}/movp.deltas.json`,
  manifestPath: `${cwd}/movp.schema.json`,
})
console.log('codegen: project baseline + manifest written')
```

**5. Edge functions.** `templates/crm-lite/supabase/functions/mcp/index.ts` is the monorepo
`supabase/functions/mcp/index.ts` (read it) with ONE change — the schema import line:

```ts
// CHANGED for the scaffold: import the COMPOSED project schema, not @movp/core-schema's platform-only
// `schema`. Everything else in this file is byte-identical to the monorepo mcp function.
import { schema } from '../_shared/schema.ts'
```

(Copy the monorepo file verbatim, then replace its `import { schema } from '@movp/core-schema'` line
with the line above. Do the same for `graphql/index.ts` against the monorepo
`supabase/functions/graphql/index.ts`.)

`templates/crm-lite/supabase/functions/mcp/deno.json` — resolve `@movp/*` via `npm:` at `^0.1.0`
(NOT monorepo source paths), and map the shared schema's dependency:

```json
{
  "imports": {
    "@movp/mcp": "npm:@movp/mcp@^0.1.0",
    "@movp/core-schema": "npm:@movp/core-schema@^0.1.0",
    "@movp/domain": "npm:@movp/domain@^0.1.0",
    "@movp/auth": "npm:@movp/auth@^0.1.0",
    "@movp/obs": "npm:@movp/obs@^0.1.0",
    "@movp/search": "npm:@movp/search@^0.1.0",
    "@movp/search/gte-small": "npm:@movp/search@^0.1.0/gte-small",
    "@modelcontextprotocol/sdk/server/mcp.js": "npm:@modelcontextprotocol/sdk@1.26.0/server/mcp.js",
    "zod": "npm:zod@^3.23.8",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "jose": "npm:jose@5"
  }
}
```

> **Deno `npm:@movp/*` resolution gotcha (inline):** the design flags that some transitive Node
> built-ins may not resolve under Deno `npm:` compat (C6 Risks). Task 5's gate is the real edge-runtime
> smoke that proves resolution — a typecheck is NOT sufficient. If a `npm:@movp/*` import fails to
> boot under Deno, that surfaces as a BOOT_ERROR in the functions log (Task 5 tails it).

`templates/crm-lite/supabase/functions/graphql/deno.json` — same shape, mirroring the monorepo
`graphql/deno.json` imports but with every `../../../packages/<pkg>/src/index.ts` replaced by
`npm:@movp/<pkg>@^0.1.0` (and `@pothos/*`, `graphql`, `graphql-yoga` unchanged — they are already
`npm:`). Read the monorepo `supabase/functions/graphql/deno.json` and transform each `@movp/*` entry.

**6. `templates/crm-lite/supabase/config.toml`** — port-isolated `+200` block; storage/analytics kept
minimal for a light scaffold reset. Base it on the monorepo `supabase/config.toml` (read it) with
these changes: `project_id = "__PROJECT_NAME__"`; `[api] port = 64521`; `[db] port = 64522`,
`shadow_port = 64520`; `[db.pooler] port = 64529`; `[studio] port = 64523`; `[local_smtp] port =
64524`; `[analytics] port = 64527`; keep the `[functions.graphql]`/`[functions.mcp]` `verify_jwt =
false` blocks and `[edge_runtime] deno_version = 2`. Keep `[db.seed] sql_paths = ["./seed.sql"]`.

> **`__PROJECT_NAME__` token gotcha (inline):** `project_id` uses the token; the copier substitutes it.
> The copier's allowlist includes `.toml`, so this file IS substituted.

**7. `templates/crm-lite/supabase/seed.sql`** — a standalone SQL seed (run by `supabase db reset`,
no TS seed script), creating the demo workspace, three companies, contacts, deals, a segment, and an
automation_rule (the C5 showcase). Grounded in the platform tables (`public.workspace`,
`public.workspace_membership`, `public.segment`, `public.automation_rule`, and the project tables
`public.contact`/`company`/`deal` created by the project baseline). Seed rows use fixed UUIDs and the
`__WORKSPACE_ID__` token:

```sql
-- CRM-lite demo seed. Workspace + membership are created by the Verdaccio gate (it mints a real
-- gotrue user and inserts membership); this file seeds the CRM domain rows only, idempotently.
insert into public.company (id, workspace_id, name, domain, tier) values
  ('c0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Acme Corp', 'acme.test', 'enterprise'),
  ('c0000000-0000-0000-0000-000000000002', '__WORKSPACE_ID__', 'Globex', 'globex.test', 'mid_market')
on conflict (id) do nothing;

insert into public.contact (id, workspace_id, full_name, email, title, company) values
  ('a0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Ada Lovelace', 'ada@acme.test', 'CTO', 'c0000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

insert into public.deal (id, workspace_id, name, amount, stage, company, primary_contact) values
  ('d0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Acme platform rollout', 50000, 'proposal',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

-- C5 showcase: a segment + an automation over platform collections.
insert into public.segment (id, workspace_id, name, active, mode) values
  ('50000000-0000-0000-0000-0000000000d1', '__WORKSPACE_ID__', 'Enterprise deals', true, 'dynamic')
on conflict (id) do nothing;
```

> **Executor note:** verify the exact platform column names for `segment`/`automation_rule` against the
> materialized platform bundle (they come from `@movp/core-schema` collection defs — `segment` has
> `name, description, owner_ref, active, mode`; `automation_rule` has `trigger_event_type, condition,
> action_type, action_config, enabled, priority`). If an `automation_rule` seed row is added, it needs
> a valid `trigger_event_type` FK into `public.event_type`; keep the seed to rows whose FKs the
> platform bundle guarantees (segment is safe; only add automation_rule if an event_type row exists —
> otherwise document the automation in the README instead of seeding it).

**8. `movp.deltas.json`** `templates/crm-lite/movp.deltas.json` — empty registry (contact/company/deal
land in the project baseline, not a delta, at scaffold time):

```json
{
  "deltas": []
}
```

**9. `package.json.template`** `templates/crm-lite/package.json.template` — standalone, `@movp/* @^0.1.0`,
`packageManager`, hosted-MCP default (no `@movp/mcp-bridge`), project-aware scripts. The copier renames
`package.json.template` → `package.json` (add `.template` → `` to the copier's write path IF a template
suffix is present; see Step 11):

```json
{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "npm@10.8.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "movp": "tsx bin/movp.mjs",
    "codegen": "tsx bin/codegen.mjs",
    "verify-schema-runtime": "tsx bin/movp.mjs verify-schema-runtime --config movp.config.mjs --deno-config supabase/functions/mcp/deno.json --edge-schema ./supabase/functions/_shared/schema.ts"
  },
  "dependencies": {
    "@astrojs/cloudflare": "^13.1.10",
    "@astrojs/react": "^4.0.0",
    "@movp/cli": "^0.1.0",
    "@movp/codegen": "^0.1.0",
    "@movp/core-schema": "^0.1.0",
    "astro": "^6.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "wrangler": "^4.0.0"
  }
}
```

> **Hosted-MCP default gotcha (inline):** there is deliberately NO `@movp/mcp-bridge` dependency — it
> is private/unpublished. Agent connectivity defaults to the hosted streamable-HTTP MCP at
> `/functions/v1/mcp` (documented in the README). The stdio bridge is an optional, separate opt-in.

**10. Remaining app files** (author minimally, grounded in the monorepo `templates/frontend-astro/`):
- `tsconfig.json`, `astro.config.mjs` — copy the monorepo `templates/frontend-astro/` equivalents
  verbatim.
- `wrangler.jsonc` — copy the monorepo frontend `wrangler.jsonc`; set `"name":
  "__PROJECT_NAME__"`, `vars.WORKSPACE_ID = "__WORKSPACE_ID__"`, and point `GRAPHQL_ENDPOINT`/
  `SUPABASE_URL` at `http://127.0.0.1:64521`.
- `src/lib/env.ts` — copy the monorepo frontend `src/lib/env.ts` verbatim (reads
  `GRAPHQL_ENDPOINT`/`WORKSPACE_ID`/`SUPABASE_URL`/`SUPABASE_ANON_KEY` via `cloudflare:workers`).
- `src/lib/graphql.ts` — a MINIMAL GraphQL client: a `postGraphql(endpoint, token, query, variables)`
  helper (copy the request/error-handling shape from the monorepo frontend `src/lib/graphql.ts`, drop
  the note-specific types).
- `src/layouts/Base.astro`, `src/pages/index.astro` (links to the three list pages),
  `src/pages/contacts.astro` / `companies.astro` / `deals.astro` — each queries the generic
  collection query the schema-derived GraphQL exposes (e.g. `contacts(workspaceId, first){ items { id
  full_name email } }`) and renders a table. Keep them small; they are smoke targets, not the product.

> **Executor note:** the exact generic GraphQL query names are schema-derived (06b); confirm them with
> the running scaffold in Task 5 (`{ __type(name:"Query"){ fields { name } } }`) and wire the pages to
> the real field names. The Astro pages are NOT on the Task 5 machine gate's critical path (the gate
> drives GraphQL/MCP/CLI directly); they exist for the template's completeness and 06e's reuse.

**11. Copier `.template` suffix handling.** The copier must rename `package.json.template` →
`package.json` on write (so pnpm never links the template's manifest in-repo). Add to
`packages/create-movp/src/copier.ts` `copyTemplate` walk, where `outPath` is computed:

```ts
      const relOut = rel.endsWith('.template') ? rel.slice(0, -'.template'.length) : rel
      const outPath = join(opts.targetDir, relOut)
```

And allowlist the `.template` suffix by stripping it for the extension check:

```ts
      const nameForExt = entry.endsWith('.template') ? entry.slice(0, -'.template'.length) : entry
      const ext = extname(nameForExt)
      const isText = TEXT_EXTS.has(ext) || TEXT_NAMES.has(nameForExt)
```

Add a copier test for this in `copier.test.ts`:

```ts
  it('renames a .template file and strips the suffix for the allowlist', () => {
    writeFileSync(join(templateDir, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('{"name":"acme-crm"}\n')
    expect(() => readFileSync(join(target, 'package.json.template'))).toThrow()
  })
```

**12. Structural fixture test** `packages/create-movp/test/crm-lite-template.test.ts` — proves the
CRM-lite schema composes (three project collections, platform inherited) and its fingerprint is stable
WITHOUT a DB. Because the template `schema.ts` imports `@movp/core-schema`, import it through the
workspace:

```ts
import { describe, expect, it } from 'vitest'
import { schemaFingerprint } from '@movp/core-schema'
import { schema } from '../../../templates/crm-lite/supabase/functions/_shared/schema.ts'

describe('CRM-lite template schema', () => {
  it('adds contact/company/deal as project extensions over the platform schema', () => {
    expect(schema.projectCollections.map((c) => c.name).sort()).toEqual(['company', 'contact', 'deal'])
    expect(schema.projectCollections.every((c) => c.layer === 'project')).toBe(true)
    expect(schema.platformCollections.length).toBeGreaterThan(0)
    expect(schema.platformCollections.every((c) => c.layer === 'platform')).toBe(true)
  })

  it('has a stable schemaFingerprint (06b)', () => {
    expect(schemaFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

Add `@movp/core-schema` as a devDependency of `packages/create-movp` so this test resolves it (append
to `devDependencies`): `"@movp/core-schema": "^0.1.0"` — it is already a runtime `dependency`, so no
change is strictly needed; confirm the import resolves.

Run — **Expected: FAIL** first (template `schema.ts` not yet written), then PASS after Steps 1–11:

```
pnpm --filter create-movp exec vitest run crm-lite-template copier
```

**13. Commit** (`feat(c6d): CRM-lite template (contact/company/deal extensions + edge fns + bins)`).

### Gate (machine-checkable)

```
pnpm --filter create-movp exec vitest run \
  && pnpm --filter create-movp exec tsc --noEmit \
  && test -f templates/crm-lite/supabase/functions/_shared/schema.ts \
  && test -f templates/crm-lite/package.json.template \
  && test ! -f templates/crm-lite/package.json \
  && grep -q 'npm:@movp/mcp@' templates/crm-lite/supabase/functions/mcp/deno.json \
  && ! grep -rq '@movp/mcp-bridge' templates/crm-lite
```

**Expected:** copier + scaffold + template tests green; typecheck clean; the schema module and
`package.json.template` exist while a bare `package.json` does NOT (so pnpm never links the template);
the MCP `deno.json` resolves `@movp/*` via `npm:`; no `@movp/mcp-bridge` reference anywhere in the
template (hosted-MCP default).

---

## Task 5 — Verdaccio harness + full acceptance gate

Pack + publish the whole bundle to a local Verdaccio, scaffold CRM-lite into a temp dir, install with
no workspace links, and drive the real edge surfaces + CLI + `verify-schema-runtime`.

> **New dependency — APPROVED 2026-07-12.** This task adds `verdaccio` `^6` as a **dev-only** dependency
> of the harness (root `devDependencies`). Sign-off is recorded (INTERFACES "Approved new dependencies") —
> proceed with `pnpm add -Dw verdaccio@^6`. It is hermetic local-registry tooling, never shipped.

### Files

- **Create:** `fixtures/verdaccio-crm-lite/verdaccio.yaml`
- **Create:** `fixtures/verdaccio-crm-lite/gate.sh` (executable)
- **Create:** `fixtures/verdaccio-crm-lite/README.md`
- **Modify:** root `package.json` (`devDependencies.verdaccio`, a `check:verdaccio-crm` script)

### Interfaces

- **Consumes:** the whole published bundle (`@movp/*` + `@movp/platform` + `create-movp`), the
  scaffolder (Task 3), the CRM-lite template (Task 4), and the CLI auth contract
  (`SUPABASE_URL` + `SUPABASE_ANON_KEY` + `MOVP_ACCESS_TOKEN`, verified in
  `packages/cli/src/client.ts:78-95`).
- **Produces (the C6d acceptance evidence + the harness shape 06e's CI matrix reuses):** a
  `gate.sh` whose steps — publish-once → scaffold → install → codegen → reset → serve → drive — are the
  per-template smoke 06e runs across all four templates.

### Steps

**1. `fixtures/verdaccio-crm-lite/verdaccio.yaml`** — a minimal registry that proxies npm for
third-party deps but hosts `@movp/*` + `create-movp` locally:

```yaml
storage: ./storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@movp/*':
    access: $all
    publish: $all
  'create-movp':
    access: $all
    publish: $all
  '**':
    access: $all
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
```

**2. `fixtures/verdaccio-crm-lite/gate.sh`** (mark executable `chmod +x`). This is the acceptance gate.
It follows the exact edge-serve env-file pattern from `scripts/slice-e2e.sh` (lines 136-171):

```bash
#!/usr/bin/env bash
# C6d acceptance: publish the bundle to a local Verdaccio, scaffold CRM-lite, npm install (NO
# workspace links), codegen, db reset, serve the real GraphQL + MCP edge functions, and drive an
# authenticated GraphQL query + streamable-MCP tools/call + CLI create/list. Requires Docker,
# supabase, deno, node, npm, psql.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/fixtures/verdaccio-crm-lite"
REGISTRY="http://127.0.0.1:4873"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/movp-crm-lite.XXXXXX")"
PROJECT="acme-crm"
WS="33333333-3333-3333-3333-333333333333"
DB_URL="postgresql://postgres:postgres@127.0.0.1:64522/postgres"

cleanup() {
  [ -n "${FN_PID:-}" ] && kill "$FN_PID" 2>/dev/null || true
  [ -n "${VERDACCIO_PID:-}" ] && kill "$VERDACCIO_PID" 2>/dev/null || true
  ( cd "$WORK/$PROJECT" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1 ) || true
  rm -rf "$FIXTURE_DIR/storage" "$WORK"
}
trap cleanup EXIT

# 1. Build every publishable dist (tsup) + the platform bundle.
pnpm -w build
pnpm --filter @movp/platform build
pnpm --filter create-movp build
# Bundle the template into the create-movp package so its tarball ships templates/.
rm -rf "$REPO_ROOT/packages/create-movp/templates"
mkdir -p "$REPO_ROOT/packages/create-movp/templates"
cp -R "$REPO_ROOT/templates/crm-lite" "$REPO_ROOT/packages/create-movp/templates/crm-lite"

# 2. Start Verdaccio.
rm -rf "$FIXTURE_DIR/storage"
node "$REPO_ROOT/node_modules/verdaccio/bin/verdaccio" -c "$FIXTURE_DIR/verdaccio.yaml" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
for _ in $(seq 1 30); do curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break; sleep 1; done

# 3. Publish the bundle to Verdaccio (a throwaway token; Verdaccio accepts any with $all).
export npm_config_registry="$REGISTRY"
npm config set "//127.0.0.1:4873/:_authToken" "fake-token" --location project 2>/dev/null || true
for pkg in auth cli codegen core-schema domain flows graphql mcp notifications obs platform search; do
  ( cd "$REPO_ROOT/packages/$pkg" && npm publish --registry "$REGISTRY" ) || { echo "publish @movp/$pkg failed"; exit 1; }
done
( cd "$REPO_ROOT/packages/create-movp" && npm publish --registry "$REGISTRY" ) || { echo "publish create-movp failed"; exit 1; }

# 4. Scaffold CRM-lite into a clean temp dir via the PUBLISHED create-movp (no workspace context).
cd "$WORK"
printf 'crm-lite\n%s\n%s\n' "$PROJECT" "$WS" | npm --registry "$REGISTRY" create movp@0.1.0
[ -d "$WORK/$PROJECT" ] || { echo "scaffold did not create $PROJECT"; exit 1; }
cd "$WORK/$PROJECT"

# 5. Install with NO workspace links, then assert no file:/workspace: specifiers leaked.
npm install --registry "$REGISTRY"
if grep -REl '"(file:|workspace:|link:)' package.json package-lock.json >/dev/null 2>&1; then
  echo "gate: file:/workspace:/link: specifier found in the scaffold — not standalone"; exit 1;
fi
if grep -Rq 'supasuite/packages' package-lock.json 2>/dev/null; then
  echo "gate: lockfile references the monorepo source tree — not standalone"; exit 1;
fi

# 6. Codegen (project mode) + platform-materialized migrations present.
npm run codegen
test -f supabase/migrations/20260715000000_movp_generated.sql || { echo "project baseline missing"; exit 1; }
ls supabase/migrations/*_movp_generated.sql >/dev/null || { echo "no generated migration"; exit 1; }

# 7. Start the isolated stack + reset.
supabase start
supabase db reset

# 8. verify-schema-runtime (06b) MUST be green (Node config fingerprint == Deno edge fingerprint).
npm run verify-schema-runtime | grep -q '"ok":true' || { echo "verify-schema-runtime not ok"; exit 1; }

# 9. Load env + mint a real member JWT (same gotrue flow as slice-e2e).
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
: "${API_URL:?}"; : "${ANON_KEY:?}"; : "${SERVICE_ROLE_KEY:?}"
curl -sS "$API_URL/auth/v1/admin/users" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "content-type: application/json" \
  -d '{"email":"crm@example.test","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -d '{"email":"crm@example.test","password":"Passw0rd!1"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).access_token))')"
[ -n "$TOKEN" ] || { echo "failed to mint token"; exit 1; }
USER_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN")"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace (id,name) values ('$WS','CRM') on conflict do nothing;" \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER_ID','owner') on conflict do nothing;"

# 10. Serve the scaffold's REAL edge functions using the env-file pattern (shell-assigned env vars can
#     fail to propagate into the edge runtime on this stack — keep MOVP_JWT_ISSUER in a file).
FN_ENV_FILE="supabase/.env.local"
printf 'MOVP_JWT_ISSUER=%s\n' "$API_URL/auth/v1" >"$FN_ENV_FILE"
# The CLI serves every function and takes no positional function list.
supabase functions serve --env-file "$FN_ENV_FILE" >"$WORK/functions.log" 2>&1 &
FN_PID=$!
GRAPHQL_READY=0
for _ in $(seq 1 60); do
  BODY="$(curl -sS "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" -d '{"query":"query{__typename}"}' || true)"
  printf '%s' "$BODY" | grep -q '"__typename"' && { GRAPHQL_READY=1; break; }
  sleep 1
done
[ "$GRAPHQL_READY" = "1" ] || { echo "graphql not ready"; tail -n 120 "$WORK/functions.log"; exit 1; }

# 11. Create a contact via the project-aware CLI, then list it back over the REAL surfaces.
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_ACCESS_TOKEN="$TOKEN" \
  npm run movp -- company create --workspace "$WS" --name "Acme Corp" >/dev/null
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_ACCESS_TOKEN="$TOKEN" \
  npm run movp -- company list --workspace "$WS" | grep -q 'Acme Corp' || { echo "CLI create/list failed"; exit 1; }

# 12. Authenticated GraphQL query over HTTP hits the project collection.
GQL="$(curl -sS "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d "{\"query\":\"query{companies(workspaceId:\\\"$WS\\\", first:20){items{id name}}}\"}")"
echo "$GQL" | grep -q 'Acme Corp' || { echo "GraphQL companies query failed: $GQL"; exit 1; }

# 13. Streamable-MCP tools/call over HTTP creates + reads a project collection tool.
MCP_LIST="$(curl -sS "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$MCP_LIST" | grep -qi 'company' || { echo "MCP tools/list missing company tools: $MCP_LIST"; exit 1; }
MCP_CALL="$(curl -sS "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"company_list\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")"
echo "$MCP_CALL" | grep -q 'Acme Corp' || { echo "MCP tools/call company_list failed: $MCP_CALL"; exit 1; }

echo "gate: verdaccio-crm-lite acceptance PASS"
```

> **Executor notes (verify against the running scaffold, fail loudly if wrong):**
> - The exact MCP tool name (`company_list` vs `list_company`) is schema-derived; confirm from the
>   `tools/list` output captured in step 13 and correct the `tools/call` `name` if needed.
> - The exact GraphQL field name (`companies`) and CLI subcommand flags (`--name`) come from the
>   schema-derived surfaces; `company` has a single-word `name` field specifically so the CLI flag is
>   unambiguously `--name` (no camelCase surprise). Confirm the GraphQL root field with
>   `{ __type(name:"Query"){ fields { name } } }` if the query 404s.

**3. `fixtures/verdaccio-crm-lite/README.md`** — one paragraph: what the gate proves (C6d acceptance),
prerequisites (Docker, supabase, deno, node, npm, psql, `verdaccio` installed), the single command
`bash gate.sh`, and the `+200` port-block note.

**4. Add the script + dependency to root `package.json`:**

```json
    "check:verdaccio-crm": "bash fixtures/verdaccio-crm-lite/gate.sh",
```

and (after approval) `"verdaccio": "^6.0.0"` in root `devDependencies`.

**5. Run the gate.** **Expected output** (tail): `gate: verdaccio-crm-lite acceptance PASS`.

```
pnpm add -Dw verdaccio@^6   # only after approval
bash fixtures/verdaccio-crm-lite/gate.sh
```

**6. Commit** (`test(c6d): Verdaccio CRM-lite scaffold→install→real-surface acceptance gate`).

### Gate (machine-checkable)

```
bash fixtures/verdaccio-crm-lite/gate.sh
```

**Expected:** exit 0; final line `gate: verdaccio-crm-lite acceptance PASS`. Along the way the gate
asserts: no `file:`/`workspace:`/`link:` specifier and no monorepo-source path in the scaffold or its
lockfile (standalone install); the project baseline + platform migrations are present; `db reset`
green on the isolated `+200` stack; `verify-schema-runtime` prints `"ok":true`; an authenticated HTTP
GraphQL `companies` query, a streamable-MCP `tools/call company_list`, and `npm run movp -- company
create/list` all return the seeded/created `Acme Corp`. (Prerequisites: Docker running; `supabase`,
`deno`, `node`, `npm`, `psql` on PATH; `verdaccio` installed.)

---

## Assumptions

1. **06a/06b/06c are merged and green** before this plan runs: `@movp/platform` +
   `verifyPlatformArtifact`, `defineSchema({ extends })` + `projectCollections`/`platformCollections`,
   `schemaFingerprint`, `buildProgram(schema, opts)`, `movp verify-schema-runtime`, and `generate()`
   project mode all exist with the exact signatures used here. If any differs, reconcile before coding.
2. **The scaffold needs a project-aware CLI/codegen entrypoint.** The published `@movp/cli` bin bakes
   in the platform-only schema; the scaffold ships `bin/movp.mjs` = `buildProgram(projectSchema)` and
   `bin/codegen.mjs` = `generate({ schema, deltasRegistryPath, ... })`, invoked via `npm run movp` /
   `npm run codegen`. This is the load-bearing design decision of Task 4 — the installed `movp` bin
   (monorepo schema) is never used by a scaffold.
3. **Scaffold edge functions import the COMPOSED schema** from `../_shared/schema.ts` (not
   `@movp/core-schema`) and resolve `@movp/*` via `npm:@movp/*@^0.1.0` in `deno.json`. Real Deno
   `npm:` resolution is proven only by Task 5's edge-runtime smoke (a typecheck is insufficient — C6
   Risk). If a `npm:@movp/*` import fails to boot under Deno, that is a genuine finding to escalate,
   not a gate flake.
4. **`verdaccio` is a new (dev-only) dependency** requiring approval before install (Task 5).
5. **Seed FK safety:** the CRM-lite `seed.sql` seeds `company`/`contact`/`deal`/`segment` (FKs the
   platform bundle + project baseline guarantee). An `automation_rule` seed row is only added if a
   valid `event_type` FK exists post-reset; otherwise the automation is documented in the README, not
   seeded (the C5 showcase is still satisfied by the segment + the documented automation).
6. **CLI/GraphQL/MCP surface names are schema-derived.** The gate uses `company` (single-word `name`
   field) to keep the CLI flag unambiguously `--name`; exact GraphQL field + MCP tool names are
   confirmed against the running scaffold in Task 5 and corrected if the derivation differs.
