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
   `@movp/platform` release bundle (via `verifyPlatformArtifact` from 06a), and prints bootstrap steps.
   **Project codegen runs POST-install** (`npm install` → `npm run codegen`), never inline at scaffold
   time — the scaffold's `@movp/*` deps do not exist until `npm install` runs (INTERFACES F2).
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

- **Version bump (Task 1).** `package.json` edits plus a gate — `scripts/check-publishable-versions.mjs`
  — that reads the twelve manifests through `scripts/lib/guarded-read.mjs` (`readJsonGuarded`:
  lstat-before-read, size-bound-before-buffer, content-free errors, structural validation) and
  discriminates `git grep`'s exit status (`0` match / `1` no-match / anything else → throw), so an
  operational git failure can never masquerade as a clean tree. All three scripts are unit-tested with
  Node's built-in runner (no vitest, no build step — the gate runs before anything is built).
  `check-release-preflight.mjs` does not read versions (verified: it only shells
  `npm org/whoami/org ls`), so it needs no change — Task 1 states this as an explicit N/A with evidence.
- **Guarded reads + CI wiring (Task 1).** `scripts/lib/guarded-read.mjs` exports **`readTextGuarded(path,
  maxBytes, codePrefix?)`** as THE primitive — every repo-root gate that reads a worktree file goes
  through it, and `readJsonGuarded` is built ON TOP of it (parse + structural validation), so the
  lstat/symlink/size logic exists in exactly ONE place (INTERFACES round-9 F1: a guard that sits *beside*
  a raw `readFileSync` is not a guard). `scripts/check-ci-wiring.mjs` proves the gate jobs are actually
  ARMED in `.github/workflows/ci.yml` with a dependency-free, indentation-aware **structural** scan —
  never a substring `includes()`, which false-greens on a job that exists only inside `#` comments or
  under an unrelated job (INTERFACES round-9 F2). Its `REQUIRED_JOBS` table asserts **exact normalized
  lines**, not substrings (a block-scoped substring still false-greened the `2.109.1` pin, because the
  job greps for that same literal at runtime), and it recognizes a `run:` step at **either** position —
  list item or multi-key property — so it accepts the real workflow it exists to verify (round-10 F1/F2).
  Its `steps` requirement goes one further and proves **OWNERSHIP**, not mere existence: the
  `with: { version: 2.109.1 }` pin must sit in the **same step block** as `uses: supabase/setup-cli@v2`,
  so a decoy action carrying the pinned line while Supabase runs on `latest` FAILS (round-11 F1).
  It is validated against **06e's actual four-job YAML, pasted verbatim**, not a hand-made fixture.
- **`create-movp` (Tasks 2–3, `packages/create-movp/`).** Unscoped published package. `src/copier.ts`
  is a **pure, synchronous, untrusted-I/O-hardened** file copier (no prompts, no network). `src/scaffold.ts`
  orchestrates: resolve target → copy template → substitute tokens → materialize platform bundle →
  print bootstrap steps (codegen is deferred to the printed post-install `npm run codegen`, INTERFACES
  F2 — never run inline). `src/cli.ts` (the `create-movp` bin) does the prompting
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
  **Guards apply on EVERY read path — the walk AND every explicit one-off copy AND every explicit
  one-off read, the tree ROOT AND every recursed subdirectory** (INTERFACES F1 + round-6 F2).
  `readdirSync` FOLLOWS a symlink, so a directory — including the initial root — is `lstat`ed BEFORE
  it is `readdir`ed; no explicit `copyFileSync` may touch a path that has not gone through
  `copyFileGuarded`; and no explicit `readFileSync` of a template source may bypass `readFileGuarded`
  (06e's gallery validator reads real template files — a guard on the copy path but not the read path
  is not a guard). There is exactly one implementation of each guard
  (`packages/create-movp/src/copier.ts`); no script reimplements them.
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
  `template_symlink_rejected` (a symlinked or non-directory tree ROOT, a symlinked entry inside the
  tree, or a symlinked explicit-copy/explicit-read source), `template_not_regular_file` (an
  explicit-copy or explicit-read source that is not a regular file), `template_file_too_large`,
  `template_total_too_large`, `unknown_token`, `unresolved_token`. Reused from 06a:
  `platform_artifact_invalid`. **This copier list is CLOSED** — `readFileGuarded` reuses these codes;
  invent no new copier code (the INTERFACES stable-error-code list is fixed).
- **Stable error codes (repo-root gates, Task 1) — a SEPARATE closed set:**
  - `scripts/lib/guarded-read.mjs`, **`readTextGuarded(path, maxBytes, codePrefix = 'file')`** — the ONE
    guarded reader. Its four codes are parameterized by `codePrefix` so each caller keeps a closed,
    self-describing set: **`<prefix>_symlink_rejected`**, **`<prefix>_not_regular_file`**,
    **`<prefix>_too_large`**, **`<prefix>_unreadable`** (two DISTINCT reasons — `cannot be inspected` for
    an `lstat` fault, `cannot be read` for a read fault). The prefixes in use are exactly three:
    `manifest` (from `readJsonGuarded`), `workflow` (from `check-ci-wiring.mjs`), and the default `file`.
  - `scripts/lib/guarded-read.mjs`, **`readJsonGuarded(path)`** — built ON TOP of `readTextGuarded` with
    `codePrefix: 'manifest'`, so it inherits `manifest_symlink_rejected`, `manifest_not_regular_file`,
    `manifest_too_large`, `manifest_unreadable` and ADDS: `manifest_unreadable: … is not valid JSON` (a
    JSON parse failure; the message carries the path + reason and **NEVER** the file's bytes) and
    `manifest_invalid_shape` (parseable but `name`/`version` are not strings).
  - `scripts/check-publishable-versions.mjs` — `version_gate_git_failed` (git exited with an operational
    status, or could not be spawned at all).
  - `scripts/check-ci-wiring.mjs` — `ci_wiring_jobs_block_missing`, `ci_wiring_job_missing`,
    `ci_wiring_job_duplicated`, `ci_wiring_run_missing`, `ci_wiring_line_missing` (a required EXACT
    normalized line is absent from THAT job's block), `ci_wiring_step_missing` (no SINGLE step block of
    that job contains every line of a required `steps` group — the OWNERSHIP assertion, round-11 F1).
    (Its `workflow_*` read faults come from `readTextGuarded` above.)

  These are deliberately NOT the copier's `template_*` codes: the repo-root gate and the published
  `create-movp` package are two different module boundaries that must not import each other (INTERFACES
  round-7 F2), and a `package.json` manifest is not a template file. Neither set adds to the INTERFACES
  cross-part code list.

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
- **Create (the guarded readers):** `scripts/lib/guarded-read.mjs` — `readTextGuarded` (THE primitive)
  + `readJsonGuarded` (built on top of it) (INTERFACES round-7 F2 + round-9 F1).
- **Create (the version gate):** `scripts/check-publishable-versions.mjs`.
- **Create (the CI-wiring gate):** `scripts/check-ci-wiring.mjs` — the structural checker that proves
  each gate job is armed in `ci.yml` (INTERFACES round-9 F2, step 5d).
- **Test (create):** `scripts/test/guarded-read.test.mjs` (14 tests — 6 `readTextGuarded` + 8 `readJsonGuarded`)
- **Test (create):** `scripts/test/check-publishable-versions.test.mjs` (9 tests)
- **Test (create):** `scripts/test/check-ci-wiring.test.mjs` (19 tests — the 4 hostile workflows, the
  intended one, the guarded-read seam, the 4 exact-line `lines` cases, the 3 step-OWNERSHIP cases (the
  decoy-step hostile fixture, the proof that the `lines`-only form would have PASSED that same fixture,
  and the `id:`/`name:` tolerance case that is why we did NOT use adjacency), and — the acceptance test —
  **06e's real four-job workflow pasted VERBATIM**, which the round-9 checker REJECTED)
- **Modify (scripts block only):** root `package.json` — add `check:publishable-versions`,
  `check:ci-wiring` + `test:version-gate` (step 5). Its `version` stays `0.0.0`.
- **Modify (arm the gate in CI):** `.github/workflows/ci.yml` — add the `publishable-versions` job
  (step 5b). Without it the gate is registered but never run: `pnpm -w test` → `turbo run test` never
  reaches a root-only script (INTERFACES round-8 F2).

> **Why these two tests use Node's BUILT-IN runner (`node --test`), not vitest:** Task 1 runs BEFORE
> `packages/create-movp` exists (Task 2 creates it), and the version gate must run before ANYTHING is
> built — so its tests cannot live in a workspace package, cannot import a package's `dist/`, and must
> not pull in a new test dependency. `node --test` is a Node builtin: zero new dependencies, no build
> step, no tsconfig. They are plain `.mjs`, so no `.d.mts` declaration is needed either (nothing in TS
> imports them — unlike `scripts/tree-snapshot.mjs` in Task 2, which a `.ts` test does import).

### Interfaces

- **Consumes:** the publishable list is exactly the 11 names already enumerated in
  `scripts/check-package-artifacts.mjs` (`auth, cli, codegen, core-schema, domain, flows, graphql,
  mcp, notifications, obs, search`) PLUS `platform` (added by 06a).
- **Produces (06d-internal, consumed by Task 5's publish step):** every publishable package + platform
  at `version: "0.1.0"`; `@movp/platform`'s `manifest.json` `platformVersion` becomes `0.1.0` on the
  next `pnpm --filter @movp/platform build` (it reads its own `package.json` version — verified in
  06a Task 3 `build.ts`).
- **Produces (06d-internal, repo-root gates only):** `scripts/lib/guarded-read.mjs` →
  - `readTextGuarded(path: string, maxBytes: number, codePrefix = 'file'): string` — **THE primitive.**
    `lstat` FIRST (throw on the lstat RESULT, so a symlink target is never opened) → reject symlink /
    non-regular → size-bound via `lstat.size` BEFORE buffering → read. Errors are content-free
    (`<prefix>_*`: path + reason, never the bytes). **EVERY repo-file read in a repo-root gate goes
    through this or `readJsonGuarded` — never a raw `readFileSync`** (INTERFACES round-9 F1).
  - `readJsonGuarded(path): PackageManifest` — the untrusted-I/O-hardened `package.json` reader every
    repo-root gate uses instead of `JSON.parse(readFileSync(...))`. **Implemented ON TOP of
    `readTextGuarded`** (`codePrefix: 'manifest'`, cap `MAX_MANIFEST_BYTES`), then `JSON.parse` +
    structural validation. The lstat/size logic is NOT duplicated — one implementation, one owner.
  - Exported constants `MAX_MANIFEST_BYTES` (256 KiB) and `MAX_WORKFLOW_BYTES` (1 MiB).

  **This whole module is deliberately NOT the same implementation as `create-movp`'s `readFileGuarded`
  (Task 2), and the two must NOT be "consolidated"** (INTERFACES round-7 F2): `create-movp` is a
  *published npm package* and cannot import repo-root `scripts/` (it would not ship in the tarball), and
  a repo-root gate cannot import `create-movp`'s build output (nothing is built when this gate runs). Two
  consumers, two module boundaries — one guard each, same semantics.
- **Produces (LOCKED — the ONE shared CI-wiring checker; 06e CONSUMES it):**
  `scripts/check-ci-wiring.mjs` → `checkCiWiring(workflowPath?, requiredJobs?): string[]` plus the
  **`REQUIRED_JOBS` table**, `Record<string, JobRequirement>` where:

  ```js
  /** @typedef {{ runs: string[], lines?: string[], steps?: string[][] }} JobRequirement */
  export const REQUIRED_JOBS = {
    'publishable-versions': {
      runs: ['pnpm test:version-gate', 'pnpm check:publishable-versions'],
    },
    // 06e APPENDS its three entries here; nothing else in this file changes.
  }
  ```

  All three fields are matched against **NORMALIZED** lines. Normalizing a line means: strip a
  trailing `#` comment **quote-aware** (a `#` inside `'…'`/`"…"` is a literal, not a comment, so
  `grep -qF '2.109.1'` survives intact) → collapse runs of whitespace → trim → strip a leading list-item
  `- `.

  - **`runs`** — the exact, FULL `run:` command string, **arguments included** (`bash
    fixtures/verdaccio-gallery/pack.sh ./artifacts`, not `bash`). The dash-strip above is what lets one
    form match a `run:` step at **EITHER position** — a list item (`- run: <cmd>`) or an indented property
    of a **multi-key step** (`- env:` / `ARTIFACTS_DIR: …` / `run: <cmd>`, which is exactly how 06e's
    `template-smoke` gate step is written). Both normalize to `run: <cmd>`. Matching only the list-item
    form is what made the round-9 checker REJECT the very workflow it exists to verify (round-10 F1).
  - **`lines`** (optional) — exact NORMALIZED lines that must appear inside **that job's OWN block**
    (bounded by the next key at same-or-shallower indent). For JOB-LEVEL assertions that are neither a
    `run:` command nor a property of any step: **06e uses it to name all four templates in the
    `template-smoke` matrix** — that line sits under `strategy:`, OUTSIDE every step block, so a
    job-scoped match is exactly the right shape for it. (The matrix lives in `template-smoke`, not
    `template-gallery`.) Anything that belongs to a specific step goes in **`steps`** instead.

    **This is an EXACT LINE match, not a substring scan — that distinction is the whole point** (round-10
    F2). The round-9 design used `contains: ['2.109.1']`, a substring search merely *scoped* to the job
    block; but `template-smoke` carries the literal `2.109.1` **twice** — the real pin
    `with: { version: 2.109.1 }` AND a runtime drift check `- run: supabase --version | grep -qF
    '2.109.1'` — so it PASSED even with `version: latest`, satisfied entirely by the `grep` argument
    (reproduced). Shrinking the haystack does not turn a substring search into an assertion. Requiring the
    exact line `with: { version: 2.109.1 }` cannot be satisfied by a comment, by a `grep` argument, or by
    another job.
  - **`steps`** (optional, `string[][]`) — each inner array is a set of exact NORMALIZED lines that must
    ALL appear **within a SINGLE step block** of that job. This proves **OWNERSHIP**, which `lines` cannot:
    `lines` is an unordered set match over the WHOLE job block, so it proves `uses: supabase/setup-cli@v2`
    and `with: { version: 2.109.1 }` each occur *somewhere* in `template-smoke` — **not that the `with:`
    belongs to that action**. Supabase could be pinned to `latest` while a DECOY step
    (`- uses: some/other-action@v1` / `with: { version: 2.109.1 }`) owns the pinned line, and `lines`
    still passes (reproduced). **06e pins the CLI with `steps`:**
    `steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']]` (round-11 F1).

    Step extraction first anchors on the job-level `steps:` key, then treats each direct `- ` child as a
    step block; every deeper line belongs to that step until the next direct list item. A block-style
    matrix or `needs` list before `steps:` is therefore outside every step. Comment-only lines normalize
    to `''` and are DROPPED, so a comment sitting between `- uses:` and `with:` is harmless.

    **Deliberately step-scoped, NOT strict adjacency / a `sequences` field — do NOT "upgrade" it later.**
    Both were verified against the real YAML: adjacency catches the decoy case BUT goes falsely RED the
    moment anyone adds an `id:` or a `name:` to that step — and a gate that cries wolf gets disabled,
    after which it protects nothing. Step-scoping expresses the actual invariant ("the `with:` belongs to
    this step"), tolerates any step property, and is still a line scan — the no-YAML-parser SCOPE LIMIT
    holds. A test pins the `id:`/`name:` tolerance so nobody regresses to adjacency.

  **06d OWNS this script and seeds the table with `publishable-versions`; later parts only APPEND an
  entry** — 06e appends `pack-artifacts` + `template-gallery` + `template-smoke` and changes nothing else
  in the file.
  **Do NOT write a second CI-wiring checker.** (Duplicate-helper drift has already been caught four times
  in this plan series — `tree-snapshot.mjs`, `readFileGuarded`, the snapshot CLI contract, and the guarded
  reader itself. This note is what prevents the fifth.) The workflow path is an argument (default
  `.github/workflows/ci.yml`) so tests point it at `mkdtemp` fixtures — the same seam 06e uses for
  `--templates-dir`.

### Steps

**1. Write the failing test for the guarded readers** `scripts/test/guarded-read.test.mjs`.

The gates read twelve worktree `package.json` files **and** `.github/workflows/ci.yml`. Those are
UNTRUSTED input: any of them could be a committed symlink (`packages/auth/package.json ->
~/.aws/credentials`), and `readFileSync` FOLLOWS symlinks. Worse, Node's `JSON.parse` error message
**embeds a snippet of the input** — so the naive `JSON.parse(readFileSync(p))` leaks secret bytes into
CI logs through its own failure path. `readTextGuarded` is THE primitive that closes both; `readJsonGuarded`
is built on top of it, so the lstat/size logic is tested once and inherited (INTERFACES round-9 F1).

```js
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MAX_MANIFEST_BYTES, readJsonGuarded, readTextGuarded } from '../lib/guarded-read.mjs'

// Synthetic fixtures under $TMPDIR only. NO writes under the real repository (INTERFACES round-5 F1).
let work = ''
before(() => { work = mkdtempSync(join(tmpdir(), 'movp-guarded-read-')) })
after(() => rmSync(work, { recursive: true, force: true }))

// `chmod 000` does NOT deny root (it ignores the mode bits) and does not remove read access on win32,
// so the EACCES case is SKIPPED there rather than asserted falsely. Every other case is portable.
const canDenyRead =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

// `readTextGuarded` is THE primitive — `readJsonGuarded` is built on top of it, so these guards are
// tested once and inherited. The `codePrefix` argument keeps each caller's error-code set closed:
// 'manifest' for package.json, 'workflow' for ci.yml, 'file' by default.
describe('readTextGuarded', () => {
  const TEXT_MAX = 1024

  it('returns the file contents for a regular, in-bounds file', () => {
    const path = join(work, 'ok.txt')
    writeFileSync(path, 'jobs:\n')
    assert.equal(readTextGuarded(path, TEXT_MAX, 'workflow'), 'jobs:\n')
  })

  it('rejects a symlink WITHOUT reading its target', () => {
    const secret = join(work, 'text-credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.yml')
    symlinkSync(secret, path) // .github/workflows/ci.yml -> ~/.aws/credentials
    assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), (err) => {
      assert.match(String(err), /workflow_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects a non-regular file (a directory)', () => {
    const dir = join(work, 'text-dir')
    mkdirSync(dir)
    assert.throws(() => readTextGuarded(dir, TEXT_MAX, 'workflow'), /workflow_not_regular_file/)
  })

  it('rejects an oversized file BEFORE buffering it', () => {
    const path = join(work, 'big.yml')
    writeFileSync(path, 'x'.repeat(TEXT_MAX + 1))
    assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), /workflow_too_large/)
  })

  it('throws <prefix>_unreadable (not a raw ENOENT) for a missing file', () => {
    assert.throws(() => readTextGuarded(join(work, 'nope.yml'), TEXT_MAX, 'workflow'), (err) => {
      assert.match(String(err), /workflow_unreadable: .* cannot be inspected/)
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })

  it('throws <prefix>_unreadable (not a raw EACCES) for an unreadable file', { skip: !canDenyRead }, () => {
    const path = join(work, 'text-noperm.yml')
    writeFileSync(path, 'jobs:\n')
    chmodSync(path, 0o000) // lstat still succeeds; the READ is what fails
    try {
      assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), (err) => {
        assert.match(String(err), /workflow_unreadable: .* cannot be read/)
        assert.doesNotMatch(String(err), /EACCES|permission denied/)
        return true
      })
    } finally {
      chmodSync(path, 0o600) // restore so the `after` hook can remove the temp tree
    }
  })
})

describe('readJsonGuarded', () => {
  it('returns the parsed manifest for a regular, valid file', () => {
    const path = join(work, 'ok.json')
    writeFileSync(path, JSON.stringify({ name: '@movp/auth', version: '0.1.0' }))
    assert.equal(readJsonGuarded(path).version, '0.1.0')
  })

  it('rejects a symlink WITHOUT reading its target', () => {
    const secret = join(work, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.json')
    symlinkSync(secret, path) // packages/auth/package.json -> ~/.aws/credentials
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects a non-regular file (a directory)', () => {
    const dir = join(work, 'a-dir')
    mkdirSync(dir)
    assert.throws(() => readJsonGuarded(dir), /manifest_not_regular_file/)
  })

  it('rejects an oversized file BEFORE buffering it', () => {
    const path = join(work, 'big.json')
    writeFileSync(path, `{"name":"x","version":"0.1.0","pad":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`)
    assert.throws(() => readJsonGuarded(path), /manifest_too_large/)
  })

  // THE leak: `JSON.parse` throws `Unexpected token 'a', "aws_secret"... is not valid JSON`. Re-throwing
  // that message — or including `err.message` in ours — prints the file's bytes to CI. Assert it cannot.
  it('rejects malformed JSON WITHOUT echoing the file content', () => {
    const path = join(work, 'bad.json')
    writeFileSync(path, 'aws_secret_access_key = SUPERSECRET\n')
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_unreadable: .* is not valid JSON/) // a CONTENT fault
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/)
      return true
    })
  })

  // I/O faults must stay INSIDE the closed `manifest_*` set — a raw ENOENT/EACCES escaping it is a
  // gate that crashes instead of diagnosing. The reason must stay DISTINCT from "is not valid JSON":
  // "cannot be read" and "is not valid JSON" have different remedies, and conflating them loses that.
  it('throws manifest_unreadable (not a raw ENOENT) for a missing manifest', () => {
    const path = join(work, 'does-not-exist.json')
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_unreadable: .* cannot be inspected/) // an I/O fault
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })

  it('throws manifest_unreadable (not a raw EACCES) for an unreadable manifest', { skip: !canDenyRead }, () => {
    const path = join(work, 'noperm.json')
    writeFileSync(path, JSON.stringify({ name: '@movp/auth', version: '0.1.0' }))
    chmodSync(path, 0o000) // lstat still succeeds; the READ is what fails
    try {
      assert.throws(() => readJsonGuarded(path), (err) => {
        assert.match(String(err), /manifest_unreadable: .* cannot be read/)
        assert.doesNotMatch(String(err), /EACCES|permission denied/)
        return true
      })
    } finally {
      chmodSync(path, 0o600) // restore so the `after` hook can remove the temp tree
    }
  })

  it('rejects a parseable-but-structurally-invalid manifest (parseable is not valid)', () => {
    const path = join(work, 'shape.json')
    writeFileSync(path, JSON.stringify({ name: 123, version: '0.1.0' }))
    assert.throws(() => readJsonGuarded(path), /manifest_invalid_shape/)
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '.../scripts/lib/guarded-read.mjs'`):

```
node --test scripts/test/guarded-read.test.mjs
```

**2. Implement `scripts/lib/guarded-read.mjs`:**

```js
// The guarded file readers for repo-root gates. Dependency-free ESM with NO build step, on purpose:
// `check-publishable-versions.mjs` and `check-ci-wiring.mjs` run BEFORE anything is built, so they
// cannot import a package's compiled `dist/`.
//
// `readTextGuarded` is THE primitive: every repo-root gate that reads a worktree file goes through it
// (or through `readJsonGuarded`, which is built ON TOP of it). There is exactly ONE lstat/size-bound
// implementation here — a guard that sits BESIDE a raw `readFileSync` is not a guard (INTERFACES
// round-9 F1: the ci.yml shape assertion was originally added with a raw `readFileSync` one line after
// `readJsonGuarded` was built for exactly that hazard).
//
// DELIBERATELY NOT the same implementation as `create-movp`'s `readFileGuarded`
// (`packages/create-movp/src/copier.ts`, Task 2), and the two must NOT be "consolidated" (INTERFACES
// round-7 F2). `create-movp` is a PUBLISHED npm package: it cannot import repo-root `scripts/` (those
// files are not in its tarball), and a repo-root gate cannot import `create-movp`'s build output
// (nothing is built when the gate runs). Consolidating them creates an import cycle or a broken
// publish. Two module boundaries — one guard each, same semantics.
import { lstatSync, readFileSync } from 'node:fs'

/** A `package.json` is a few KiB. 256 KiB is generous and still BOUNDS the buffer. */
export const MAX_MANIFEST_BYTES = 256 * 1024
/** A workflow is a few KiB (this repo's `ci.yml` is ~7 KiB). 1 MiB is generous and still BOUNDS it. */
export const MAX_WORKFLOW_BYTES = 1024 * 1024

/** @typedef {{ name: string, version: string } & Record<string, unknown>} PackageManifest */

/**
 * Read a UTF-8 text file from an UNTRUSTED path (a worktree file anyone may have committed as a
 * symlink). Throws `<codePrefix>_*` (path + reason ONLY — never the file's bytes).
 *
 * `codePrefix` keeps each caller's error-code set closed and self-describing: `readJsonGuarded` passes
 * `'manifest'` (preserving its `manifest_*` codes), `check-ci-wiring.mjs` passes `'workflow'`, and the
 * default `'file'` reads correctly for any other repo file.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @param {string} [codePrefix]
 * @returns {string}
 */
export function readTextGuarded(path, maxBytes, codePrefix = 'file') {
  // GOTCHA: `lstat` FIRST, and throw on the lstat RESULT — `statSync` and `readFileSync` both FOLLOW
  // symlinks, so a symlinked file pointing at ~/.aws/credentials would already be OPEN by the time any
  // later check ran. A basename denylist cannot help: the symlink is named `package.json` / `ci.yml`.
  /** @type {import('node:fs').Stats} */
  let info
  try {
    info = lstatSync(path)
  } catch {
    // The `<codePrefix>_*` code set is CLOSED. A raw `ENOENT`/`EACCES` from `lstatSync` would escape it
    // — a deleted/renamed file or a CI permissions problem is a plausible real state, not a crash.
    // Bare `catch` (NO error binding), so no errno message — which can name paths outside the repo —
    // can be interpolated: the leak is unrepresentable, not merely discouraged.
    throw new Error(`${codePrefix}_unreadable: ${path} cannot be inspected`)
  }
  if (info.isSymbolicLink()) throw new Error(`${codePrefix}_symlink_rejected: ${path} is a symlink`)
  if (!info.isFile()) throw new Error(`${codePrefix}_not_regular_file: ${path} is not a regular file`)
  // Bound BEFORE buffering: a cap applied after `readFileSync` cannot prevent the OOM it exists to stop.
  if (info.size > maxBytes) {
    throw new Error(`${codePrefix}_too_large: ${path} is ${info.size} bytes (max ${maxBytes})`)
  }

  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Same closed-set discipline as the `lstat` above. This reason is DISTINCT from the JSON-parse
    // case's "is not valid JSON": conflating "cannot be read" with "is not valid JSON" destroys the
    // diagnostic — one is an I/O fault, the other a content fault, with different remedies.
    throw new Error(`${codePrefix}_unreadable: ${path} cannot be read`)
  }
}

/**
 * Read + parse a `package.json` from an UNTRUSTED path. Built ON TOP of `readTextGuarded` — the
 * lstat/symlink/size logic lives in ONE place, not two. Throws `manifest_*` (path + reason ONLY).
 * @param {string} path
 * @returns {PackageManifest}
 */
export function readJsonGuarded(path) {
  const raw = readTextGuarded(path, MAX_MANIFEST_BYTES, 'manifest')

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // GOTCHA (the entire reason this catch exists): Node's `JSON.parse` error message EMBEDS a snippet
    // of the input — `Unexpected token 'a', "aws_secret"... is not valid JSON`. Re-throwing it, or
    // interpolating `err.message`, prints the file's CONTENT into CI logs — the very leak the `lstat`
    // in `readTextGuarded` closes on the happy path. Throw the path + a reason. NEVER the bytes.
    throw new Error(`manifest_unreadable: ${path} is not valid JSON`)
  }

  // Structurally validate BEFORE any field is dereferenced — parseable is not valid, and a cast is not
  // validation. A malformed-but-parseable manifest throws here; it never reaches the version compare.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`manifest_invalid_shape: ${path} is not a JSON object`)
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof obj.name !== 'string') {
    throw new Error(`manifest_invalid_shape: ${path} has no string "name"`)
  }
  if (typeof obj.version !== 'string') {
    throw new Error(`manifest_invalid_shape: ${path} has no string "version"`)
  }
  return /** @type {PackageManifest} */ (parsed)
}
```

Re-run — **Expected: PASS**, `pass 14 / fail 0` (6 `readTextGuarded` + 8 `readJsonGuarded`):

```
node --test scripts/test/guarded-read.test.mjs
```

> The TWO EACCES cases (one per reader) self-skip when the runner is root or win32 (`chmod 000` cannot
> deny root), so a root container reports `pass 12 / skip 2 / fail 0` instead. Either is green;
> **`fail 0` is the gate.**

**3. Write the failing test for the gate** `scripts/test/check-publishable-versions.test.mjs`.

`git grep` exits **0** on a match, **1** on NO match (benign), and **anything else** on an operational
failure — not a git repo (128), git not installed (spawn `ENOENT`), a bad pathspec, an unreadable
object. A `try/catch { return [] }` swallows *both* 1 and 128, so a BROKEN gate reports "no 0.0.0
pins" and passes. These three branches are the point of this file, so the git invocation is injectable.

```js
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  PUBLISHABLE, checkPublishableVersions, pinnedZeroConsumers,
} from '../check-publishable-versions.mjs'

// A SYNTHETIC repo root under $TMPDIR — the gate is driven against it, never against the real
// worktree, so no test writes under the repository (INTERFACES round-5 F1) and a dirty tree cannot
// flip a result.
let repoRoot = ''

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'movp-version-gate-'))
  for (const name of PUBLISHABLE) {
    mkdirSync(join(repoRoot, 'packages', name), { recursive: true })
    writeFileSync(
      join(repoRoot, 'packages', name, 'package.json'),
      `${JSON.stringify({ name: `@movp/${name}`, version: '0.1.0' }, null, 2)}\n`,
    )
  }
})
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

/** A stubbed `spawnSync` result: `{ status, stdout, stderr, signal, error }`. */
const stubGit = (result) => () => ({ stdout: '', stderr: '', status: 0, signal: null, ...result })

describe('pinnedZeroConsumers — the git exit status is DISCRIMINATED, never swallowed', () => {
  it('status 0 → returns the matched lines', () => {
    const hit = 'templates/crm-lite/package.json.template:5:    "@movp/cli": "0.0.0",'
    assert.deepEqual(pinnedZeroConsumers(repoRoot, stubGit({ status: 0, stdout: `${hit}\n` })), [hit])
  })

  it('status 1 → no matches (the benign case)', () => {
    assert.deepEqual(pinnedZeroConsumers(repoRoot, stubGit({ status: 1 })), [])
  })

  it('status 2 → throws LOUDLY, carrying the status', () => {
    assert.throws(
      () => pinnedZeroConsumers(repoRoot, stubGit({ status: 2, stderr: 'fatal: not a git repository' })),
      /version_gate_git_failed: .*status=2/,
    )
  })

  it('a spawn error (git not installed) → throws LOUDLY', () => {
    const error = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' })
    assert.throws(
      () => pinnedZeroConsumers(repoRoot, stubGit({ status: null, error })),
      /version_gate_git_failed: .*ENOENT/,
    )
  })
})

describe('checkPublishableVersions', () => {
  it('PASSES when every publishable is 0.1.0 and git reports no match (status 1)', () => {
    assert.deepEqual(checkPublishableVersions(repoRoot, stubGit({ status: 1 })), [])
  })

  it('FAILS when git finds a 0.0.0 pin (status 0 with a match)', () => {
    const problems = checkPublishableVersions(
      repoRoot, stubGit({ status: 0, stdout: 'x/package.json:5:  "@movp/cli": "0.0.0",\n' }),
    )
    assert.equal(problems.length, 1)
    assert.match(problems[0], /pins a @movp dependency at 0\.0\.0/)
  })

  // The regression this gate's own bug produced: a broken git run must NOT look like a clean tree.
  it('FAILS LOUDLY on an operational git failure (status 2) — it does NOT report "no pins"', () => {
    assert.throws(() => checkPublishableVersions(repoRoot, stubGit({ status: 2 })), /version_gate_git_failed/)
  })

  it('FAILS when a publishable is still 0.0.0', () => {
    writeFileSync(
      join(repoRoot, 'packages', 'auth', 'package.json'),
      '{"name":"@movp/auth","version":"0.0.0"}\n',
    )
    const problems = checkPublishableVersions(repoRoot, stubGit({ status: 1 }))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /@movp\/auth is 0\.0\.0, expected 0\.1\.0/)
  })

  it('THROWS on a symlinked manifest instead of following it, and leaks no target bytes', () => {
    const secret = join(repoRoot, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const manifest = join(repoRoot, 'packages', 'auth', 'package.json')
    rmSync(manifest)
    symlinkSync(secret, manifest)
    assert.throws(() => checkPublishableVersions(repoRoot, stubGit({ status: 1 })), (err) => {
      assert.match(String(err), /manifest_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET/)
      return true
    })
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '.../scripts/check-publishable-versions.mjs'`):

```
node --test scripts/test/check-publishable-versions.test.mjs
```

**4. Implement `scripts/check-publishable-versions.mjs`** — ONE coherent script:

```js
#!/usr/bin/env node
// The publishable-version gate. It runs BEFORE anything is built, so it is dependency-free ESM and
// imports only `scripts/lib/` — never a package's `dist/` (see the note in `lib/guarded-read.mjs`).
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJsonGuarded } from './lib/guarded-read.mjs'

/** The set Verdaccio publishes and scaffolds pin at ^0.1.0. `mcp-bridge` is private/unpublished and
 *  intentionally excluded (it stays 0.0.0). */
export const PUBLISHABLE = [
  'auth', 'cli', 'codegen', 'core-schema', 'domain', 'flows',
  'graphql', 'mcp', 'notifications', 'obs', 'platform', 'search',
]
export const EXPECTED_VERSION = '0.1.0'
/** POSIX ERE for `git grep -E`. `workspace:*` is fine — only a literal 0.0.0 version pin is a hit. */
export const ZERO_PIN_PATTERN = '"@movp/[a-z-]+":[[:space:]]*"0\\.0\\.0"'
// GOTCHA: scope the grep to MANIFESTS. An UNSCOPED `git grep` over the worktree also matches this
// gate's OWN test fixtures and any doc/plan prose quoting the pattern — the gate would fail on itself.
// Verified against the current tree: this pathspec covers the root manifest, every
// `packages/<name>/package.json`, and every `templates/<name>/package.json[.template]` — and nothing else.
export const MANIFEST_PATHSPEC = ['*package.json', '*package.json.template']

/** @param {string} repoRoot @returns {import('node:child_process').SpawnSyncReturns<string>} */
export function runGitGrep(repoRoot) {
  // `spawnSync` (NOT `execFileSync`): it RETURNS `{ status, stdout, stderr, error }` instead of
  // throwing, which is what lets the caller tell "no match" (1) apart from "git broke" (128/ENOENT).
  return spawnSync('git', ['grep', '-nE', ZERO_PIN_PATTERN, '--', ...MANIFEST_PATHSPEC], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

/**
 * @param {string} repoRoot
 * @param {(repoRoot: string) => import('node:child_process').SpawnSyncReturns<string>} [runGit]
 * @returns {string[]} the `path:line:text` hits; `[]` when git found nothing. THROWS if git failed.
 */
export function pinnedZeroConsumers(repoRoot, runGit = runGitGrep) {
  const result = runGit(repoRoot)
  // Fail HARD and LOUD on an operational failure. A bare `catch { return [] }` here would report
  // "no 0.0.0 pins" when git is absent or the cwd is not a repo — a broken gate that PASSES.
  if (result.error) {
    throw new Error(
      `version_gate_git_failed: git grep could not run in ${repoRoot} (${result.error.code ?? result.error.message})`,
    )
  }
  if (result.status === 0) return result.stdout.trim().split('\n').filter(Boolean) // matches
  if (result.status === 1) return [] // no matches — the ONLY benign non-zero status
  throw new Error(
    `version_gate_git_failed: git grep in ${repoRoot} exited status=${result.status} signal=${result.signal ?? 'none'}`,
  )
}

/**
 * @param {string} repoRoot
 * @param {(repoRoot: string) => import('node:child_process').SpawnSyncReturns<string>} [runGit]
 * @returns {string[]} human-readable problems; `[]` means the gate passes. THROWS on an operational failure.
 */
export function checkPublishableVersions(repoRoot, runGit = runGitGrep) {
  /** @type {string[]} */
  const problems = []
  for (const name of PUBLISHABLE) {
    // readJsonGuarded, NEVER `JSON.parse(readFileSync(...))`: these twelve paths are worktree files, and
    // a symlinked one would be followed straight out of the repo — with the parse error printing its bytes.
    const pkg = readJsonGuarded(join(repoRoot, 'packages', name, 'package.json'))
    if (pkg.version !== EXPECTED_VERSION) {
      problems.push(`version check failed: ${pkg.name} is ${pkg.version}, expected ${EXPECTED_VERSION}`)
    }
  }
  for (const line of pinnedZeroConsumers(repoRoot, runGit)) {
    problems.push(`consumer pins a @movp dependency at 0.0.0: ${line}`)
  }
  return problems
}

// Exit-code contract: 0 = pass · 1 = a real finding (wrong version / a 0.0.0 pin) · 2 = OPERATIONAL
// failure (git broke, a manifest is a symlink/oversized/malformed). An operational failure is never 0.
//
// GOTCHA: `process.argv[1]` is `undefined` when this module is IMPORTED from an eval context
// (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE` — turning a
// library import into a crash. Guard it. (Hit for real while verifying this plan; all three scripts
// here — this one, `tree-snapshot.mjs`, and `check-ci-wiring.mjs` — use the identical idiom.)
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  /** @type {string[]} */
  let problems
  try {
    problems = checkPublishableVersions(process.cwd())
  } catch (err) {
    console.error(
      `publishable-version gate: OPERATIONAL FAILURE — ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log(
    `publishable versions: all ${PUBLISHABLE.length} @movp publishables at ${EXPECTED_VERSION}, no 0.0.0 consumer pins`,
  )
}
```

Re-run the test — **Expected: PASS** (9 tests). Then run the gate itself against the real repo —
**Expected: FAIL, exit 1** (`... is 0.0.0, expected 0.1.0` for all 12, since nothing is bumped yet):

```
node --test scripts/test/check-publishable-versions.test.mjs
node scripts/check-publishable-versions.mjs ; test $? -eq 1
```

**5. Add the gate scripts to root `package.json` scripts** (after `check:packages`). `test:version-gate`
runs all THREE test files — the two above plus the CI-wiring checker's, added in step 5c:

```json
    "check:publishable-versions": "node scripts/check-publishable-versions.mjs",
    "check:ci-wiring": "node scripts/check-ci-wiring.mjs",
    "test:version-gate": "node --test scripts/test/guarded-read.test.mjs scripts/test/check-publishable-versions.test.mjs scripts/test/check-ci-wiring.test.mjs",
```

**5b. ARM the gate in CI** — add a `publishable-versions` job to `.github/workflows/ci.yml`, immediately
after the existing `package-artifacts` job (which ends at `- run: pnpm check:release-preflight`) and
before `quickstart:`. Same shape as `schema-codegen-unit` / `package-artifacts` — checkout, pnpm,
node, install, then the runs:

```yaml
  publishable-versions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # NO `pnpm build` step, deliberately: this gate is dependency-free ESM over node builtins and must
      # stay runnable before anything is built (see the header of `scripts/lib/guarded-read.mjs`).
      - run: pnpm test:version-gate
      - run: pnpm check:publishable-versions
```

> **Why a job and not `pnpm -w test`:** `pnpm -w test` runs `turbo run test`, which only reaches
> *workspace-package* tests — it never runs a root-only script. Without this job the gate exists but is
> never armed: a `0.0.0` pin could regress after Task 1 and still merge green (INTERFACES round-8 F2).

**5c. Write the failing test for the CI-wiring checker** `scripts/test/check-ci-wiring.test.mjs`.

The job above is only useful if it is REALLY there. The obvious check —
`y.includes('publishable-versions:') && y.includes('pnpm test:version-gate') && …` — is a substring scan,
and it **false-greens**: a `ci.yml` whose entire job exists as `#` comments passes it with exit 0
(reproduced), as does one where the commands sit under an unrelated job. The check that proves the gate
is armed would itself be manufacturing evidence. These four hostile fixtures MUST fail; the intended job
MUST pass (INTERFACES round-9 F2).

```js
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MAX_WORKFLOW_BYTES } from '../lib/guarded-read.mjs'
import { REQUIRED_JOBS, checkCiWiring } from '../check-ci-wiring.mjs'

// Synthetic fixtures under $TMPDIR only. NO writes under the real repository (INTERFACES round-5 F1);
// the checker takes the workflow path as an argument so the hostile cases point at a temp file.
let work = ''
before(() => { work = mkdtempSync(join(tmpdir(), 'movp-ci-wiring-')) })
after(() => rmSync(work, { recursive: true, force: true }))

/** Write a fixture workflow and return its path. @param {string} name @param {string} yaml */
const fixture = (name, yaml) => {
  const path = join(work, `${name}.yml`)
  writeFileSync(path, yaml)
  return path
}

const ARMED_JOB = `
  publishable-versions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:version-gate
      - run: pnpm check:publishable-versions
`

/** The real ci.yml shape: a top-level `jobs:`, a neighbouring job, and a job literally NAMED `jobs`. */
const GOOD = `name: ci
on:
  push:
    branches: [main]

jobs:
  package-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm check:packages
${ARMED_JOB}
  jobs:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:jobs
`

describe('checkCiWiring — the intended workflow', () => {
  it('PASSES: the job exists under jobs: and invokes both commands', () => {
    assert.deepEqual(checkCiWiring(fixture('good', GOOD)), [])
  })

  // The real ci.yml contains a job literally NAMED `jobs:` (ci.yml:173). Matching the trimmed text
  // alone would anchor on it and scan the wrong block.
  it('anchors on the TOP-LEVEL jobs: mapping, not a job named "jobs"', () => {
    const noTopLevel = GOOD.replace(/^jobs:$/m, 'not-jobs:')
    const problems = checkCiWiring(fixture('no-jobs', noTopLevel))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_jobs_block_missing/)
  })
})

describe('checkCiWiring — hostile workflows that MUST fail (each false-greened the substring scan)', () => {
  // THE reproduced defect: `y.includes('publishable-versions:')` is true for a COMMENTED-OUT job.
  it('FAILS: the job and both commands appear ONLY inside # comments', () => {
    const commented = GOOD.replace(ARMED_JOB, `${ARMED_JOB.replace(/^(.*)$/gm, '#$1')}\n`)
    const problems = checkCiWiring(fixture('comments-only', commented))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_missing: .* has no "publishable-versions:" job/)
  })

  it('FAILS: the right commands live under a DIFFERENT job', () => {
    const wrongJob = GOOD.replace(
      ARMED_JOB,
      `
  publishable-versions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

  some-other-job:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:version-gate
      - run: pnpm check:publishable-versions
`,
    )
    const problems = checkCiWiring(fixture('wrong-job', wrongJob))
    assert.equal(problems.length, 2) // BOTH commands are outside the job's block
    assert.match(problems[0], /ci_wiring_run_missing: .* job "publishable-versions" does not invoke `pnpm test:version-gate`/)
    assert.match(problems[1], /ci_wiring_run_missing: .* does not invoke `pnpm check:publishable-versions`/)
  })

  it('FAILS: the job is present but ONE command is missing', () => {
    const oneMissing = GOOD.replace('      - run: pnpm check:publishable-versions\n', '')
    const problems = checkCiWiring(fixture('one-missing', oneMissing))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .* does not invoke `pnpm check:publishable-versions`/)
  })

  it('FAILS: the job name is DUPLICATED (never silently pick one)', () => {
    const duplicated = GOOD.replace(ARMED_JOB, `${ARMED_JOB}${ARMED_JOB}`)
    const problems = checkCiWiring(fixture('duplicate', duplicated))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_duplicated: .* declares the "publishable-versions:" job 2 times/)
  })

  it('reports EVERY failing table entry, not just the first', () => {
    const problems = checkCiWiring(fixture('good-multi', GOOD), {
      ...REQUIRED_JOBS,
      // 06e's future entry, not wired yet
      'template-gallery': { runs: ['pnpm check:template-gallery'] },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_missing: .* has no "template-gallery:" job/)
  })
})

/** A `template-smoke` job that pins the Supabase CLI, plus a neighbour that also mentions a version.
 *  Shared by the `lines` cases below and the `steps` OWNERSHIP cases after them.
 *  @param {string} smokeBody @param {string} [neighbourBody] */
const withSmoke = (smokeBody, neighbourBody = '      - run: pnpm lint\n') => `name: ci
on:
  push:
    branches: [main]

jobs:
  template-smoke:
    runs-on: ubuntu-latest
    steps:
${smokeBody}
  neighbour:
    runs-on: ubuntu-latest
    steps:
${neighbourBody}`

// `lines` is a JOB-scoped exact match against a NORMALIZED line, NOT a substring scan. That distinction
// is the entire point of round-10 F2: `template-smoke` carries the literal `2.109.1` TWICE (the real pin
// AND a `grep -qF '2.109.1'` drift check), so the round-9 `contains: ['2.109.1']` substring scan PASSED
// even with `version: latest` — satisfied purely by the grep argument. These four cases pin the
// exact-line semantics that make `lines` a real assertion; they exercise the MECHANISM with the pin
// strings as a convenient payload. (06e's REAL table pins the CLI through `steps`, not `lines`, because
// job-scoped existence is not OWNERSHIP — see the `steps` describe block below. `lines` keeps a real
// consumer: 06e's four-template matrix line, which sits under `strategy:` and belongs to no step.)
describe('checkCiWiring — `lines` is an EXACT normalized-line match inside the job BLOCK', () => {
  const TABLE = {
    'template-smoke': {
      runs: ["supabase --version | grep -qF '2.109.1'"],
      lines: ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
    },
  }

  it('PASSES when the exact pinned lines are in the block (normalizing whitespace + a trailing comment)', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: {  version:  2.109.1  }   # pin — matches integration-smoke
      - run: supabase --version | grep -qF '2.109.1'   # fail loud if the CLI drifts
`,
    )
    assert.deepEqual(checkCiWiring(fixture('lines-ok', yaml), TABLE), [])
  })

  // THE round-10 F2 REGRESSION TEST. Under the round-9 `contains: ['2.109.1']` this workflow PASSED: the
  // substring IS present — in the `grep -qF '2.109.1'` run line — so a job pinned to `latest` false-greened
  // (reproduced). The exact line `with: { version: 2.109.1 }` is absent, so `lines` FAILS it, correctly.
  it('FAILS when the pin says `version: latest` even though a run line still greps for 2.109.1', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    const problems = checkCiWiring(fixture('lines-latest', yaml), TABLE)
    assert.equal(problems.length, 1) // the `runs` grep entry still matches — ONLY the pin is missing
    assert.match(problems[0], /ci_wiring_line_missing: .* job "template-smoke" has no line `with: \{ version: 2\.109\.1 \}`/)
  })

  it('FAILS when the required line appears only in a COMMENT inside the job', () => {
    const yaml = withSmoke(
      `      # TODO — pin it: with: { version: 2.109.1 }
      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    const problems = checkCiWiring(fixture('lines-comment', yaml), TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_line_missing: .* has no line `with: \{ version: 2\.109\.1 \}`/)
  })

  it('FAILS when the required line appears only in a DIFFERENT job', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
      `      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
`, // the pin is on the NEIGHBOUR — a file-wide includes() would green here
    )
    const problems = checkCiWiring(fixture('lines-wrong-job', yaml), TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_line_missing: .* job "template-smoke" has no line `with: \{ version: 2\.109\.1 \}`/)
  })
})

// ROUND-11 F1. `lines` proves EXISTENCE; `steps` proves OWNERSHIP. `lines` is an unordered set match over
// the WHOLE job block, so it proves `uses: supabase/setup-cli@v2` and `with: { version: 2.109.1 }` each
// occur SOMEWHERE in `template-smoke` — NOT that the `with:` belongs to that action. A DECOY step can own
// the pinned line while Supabase itself runs on `latest`, and `lines` still greens (the second test below
// reproduces exactly that). `steps` requires every line of a group inside ONE step block.
describe('checkCiWiring — `steps` proves the pin is OWNED by the setup-cli step (round-11 F1)', () => {
  /** What 06e actually ships: the pin must live in the SAME step as the action. */
  const STEP_TABLE = {
    'template-smoke': {
      runs: [],
      steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']],
    },
  }

  /** The round-10 shape, kept ONLY to prove it would have missed the decoy below. */
  const LINES_ONLY_TABLE = {
    'template-smoke': {
      runs: [],
      lines: ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
    },
  }

  /** setup-cli on `latest`; a DECOY action owns the pinned line. BOTH required lines exist in the job —
   *  which is precisely why a job-scoped set match is not enough. */
  const DECOY = withSmoke(
    `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - uses: some/other-action@v1
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
  )

  it('FAILS the decoy: no SINGLE step owns both the action and the pin', () => {
    const problems = checkCiWiring(fixture('steps-decoy', DECOY), STEP_TABLE)
    assert.equal(problems.length, 1)
    assert.match(
      problems[0],
      /ci_wiring_step_missing: .* job "template-smoke" has no single step containing all of/,
    )
    assert.match(problems[0], /with: \{ version: 2\.109\.1 \}/) // the message NAMES the required lines
  })

  // THE REGRESSION PROOF. The round-10 `lines`-only requirement PASSES this same hostile fixture: both
  // literals are present in the block, just not in the same step. That gap — existence, not ownership —
  // is exactly what `steps` closes. If this test ever goes RED, `lines` has silently become step-scoped
  // and the two mechanisms have been conflated; fix the code, not the test.
  it('the round-10 `lines`-only requirement PASSES that same decoy — the gap `steps` closes', () => {
    assert.deepEqual(checkCiWiring(fixture('steps-decoy-lines', DECOY), LINES_ONLY_TABLE), [])
  })

  // WHY NOT ADJACENCY: a strict `uses:`-then-`with:` sequence catches the decoy too, but goes falsely RED
  // the moment anyone adds an `id:` or a `name:` to that step — and a gate that cries wolf gets disabled,
  // after which it protects nothing. Step-scoping tolerates ANY step property. This test PINS that
  // tolerance so nobody "upgrades" the checker to adjacency later.
  it('PASSES when the setup-cli step also carries `id:` and `name:` (why adjacency was rejected)', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        id: setup-supabase
        name: Pin the Supabase CLI
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    assert.deepEqual(checkCiWiring(fixture('steps-id-name', yaml), STEP_TABLE), [])
  })

  // A block-style matrix is an ordinary equivalent spelling of the flow-style matrix 06e currently
  // ships. It creates list items before `steps:` at a different indent; step extraction must anchor on
  // the `steps:` key rather than treating the first list item in the whole job as a step.
  it('PASSES when a block-style matrix list appears before `steps:`', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
    ).replace(
      '    runs-on: ubuntu-latest\n    steps:',
      `    runs-on: ubuntu-latest
    strategy:
      matrix:
        template:
          - crm-lite
          - support-desk
    steps:`,
    )
    assert.deepEqual(checkCiWiring(fixture('steps-block-matrix', yaml), STEP_TABLE), [])
  })
})

// ==============================================================================================
// THE ACCEPTANCE TEST (INTERFACES round-10 F1). The round-9 checker passed hand-made fixtures and would
// have REJECTED the real workflow: its parser matched only `- run: <cmd>` (list-item form), but
// `template-smoke`'s gate step is a MULTI-KEY step whose `run:` is an indented PROPERTY. A checker that
// rejects the very workflow it exists to verify makes 06e's required gate permanently RED. Verified: the
// round-9 parser emits `ci_wiring_run_missing` for the gate.sh step against the YAML below.
//
// So this fixture is 06e's ACTUAL ci.yml jobs, pasted VERBATIM — not a simplified stand-in.
//
// GOTCHA when pasting into a JS template literal, TWO characters need a backslash and NOTHING else does:
//   1. `${` opens an interpolation — GitHub's `${{ … }}` MUST be written `\${{ … }}` (yields `${{ … }}`).
//   2. a backtick closes the literal — the ` ` ` inside 06e's comment lines MUST be written `\``.
// Both are escapes, not content changes: the STRING is byte-for-byte 06e's YAML. Nothing else is edited.
// Note the FULL_TABLE entries below are ordinary '' / "" strings, so there `${{ matrix.template }}` and
// the quoted `grep -qF '2.109.1'` are written UNescaped.
//
// Bonus coverage that falls out of pasting the real thing: 06e's comment block literally contains
// `# \`with: { version: 2.109.1 }\`` — a COMMENTED copy of a required `lines` entry. If comment-stripping
// ever regressed, THIS fixture would false-green. The real file is a better hostile fixture than a
// hand-made one; that is the round-10 lesson.
// ==============================================================================================
const REAL_CI = `name: ci
on:
  push:
    branches: [main]

jobs:
${ARMED_JOB}
  template-gallery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # check-template-gallery.ts imports the untrusted-io guards from the BUILT create-movp dist —
      # build before running it (INTERFACES round-6 F2). The guards gate rebuilds it itself, harmlessly.
      - run: pnpm --filter create-movp build
      - run: pnpm exec tsx scripts/check-template-gallery.ts
      - run: bash scripts/check-template-gallery-guards.sh

  pack-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: bash fixtures/verdaccio-gallery/pack.sh ./artifacts
      - uses: actions/upload-artifact@v4
        with: { name: movp-tarballs, path: ./artifacts }

  template-smoke:
    needs: [pack-artifacts]
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        template: [crm-lite, marketing-site, support-desk, knowledge-base]
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      # pin — matches integration-smoke (ci.yml:130); INTERFACES round-3 F2.
      # Keep the comment on its OWN line: \`check-ci-wiring.mjs\` asserts the EXACT normalized line
      # \`with: { version: 2.109.1 }\` (round-10 F2), so a trailing comment here is needless friction.
      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
      # fail loud if the pinned CLI drifts at runtime
      - run: supabase --version | grep -qF '2.109.1'
      - uses: actions/download-artifact@v4
        with: { name: movp-tarballs, path: ./artifacts }
      - run: pnpm install --frozen-lockfile
      - env:
          ARTIFACTS_DIR: \${{ github.workspace }}/artifacts
        run: bash fixtures/verdaccio-gallery/gate.sh \${{ matrix.template }}
`

/** 06d's seed entry PLUS the three 06e APPENDS — the table exactly as it stands once 06e lands. */
const FULL_TABLE = {
  ...REQUIRED_JOBS,
  'pack-artifacts': {
    runs: ['bash fixtures/verdaccio-gallery/pack.sh ./artifacts'],
  },
  'template-gallery': {
    runs: [
      'pnpm --filter create-movp build',
      'pnpm exec tsx scripts/check-template-gallery.ts',
      'bash scripts/check-template-gallery-guards.sh',
    ],
  },
  'template-smoke': {
    runs: [
      "supabase --version | grep -qF '2.109.1'",
      'bash fixtures/verdaccio-gallery/gate.sh ${{ matrix.template }}',   // multi-key `- env:` / `run:` step
    ],
    // The 4-way matrix sits under `strategy:`, NOT inside a step — so it stays a `lines` requirement.
    lines: ['template: [crm-lite, marketing-site, support-desk, knowledge-base]'],
    // OWNERSHIP: the pin must live in the SAME STEP as the setup-cli action (round-11 F1).
    steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']],
  },
}

describe("checkCiWiring — 06e's REAL workflow, pasted verbatim (round-10 F1 acceptance)", () => {
  it('PASSES with ZERO problems against all four real jobs', () => {
    assert.deepEqual(checkCiWiring(fixture('real-ci', REAL_CI), FULL_TABLE), [])
  })

  // Proves the PASS above is not vacuous: the multi-key `- env:` / `run:` step is precisely the one the
  // round-9 parser could not see at all. Delete it and the gate must go RED.
  it('FAILS when the MULTI-KEY gate step is removed (the round-9 parser could not see it)', () => {
    const withoutGate = REAL_CI.replace(
      `      - env:
          ARTIFACTS_DIR: \${{ github.workspace }}/artifacts
        run: bash fixtures/verdaccio-gallery/gate.sh \${{ matrix.template }}
`,
      '',
    )
    const problems = checkCiWiring(fixture('real-no-gate', withoutGate), FULL_TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .* job "template-smoke" does not invoke `bash fixtures\/verdaccio-gallery\/gate\.sh \$\{\{ matrix\.template \}\}`/)
  })
})

describe('checkCiWiring — the workflow is read through the guard (INTERFACES round-9 F1)', () => {
  it('rejects a SYMLINKED workflow WITHOUT reading its target', () => {
    const secret = join(work, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.yml')
    symlinkSync(secret, path) // .github/workflows/ci.yml -> ~/.aws/credentials
    assert.throws(() => checkCiWiring(path), (err) => {
      assert.match(String(err), /workflow_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects an OVERSIZED workflow BEFORE buffering it', () => {
    const path = join(work, 'huge.yml')
    writeFileSync(path, `${GOOD}\n# ${'x'.repeat(MAX_WORKFLOW_BYTES)}`)
    assert.throws(() => checkCiWiring(path), /workflow_too_large/)
  })

  it('throws workflow_unreadable (not a raw ENOENT) for a missing workflow', () => {
    assert.throws(() => checkCiWiring(join(work, 'nope.yml')), (err) => {
      assert.match(String(err), /workflow_unreadable: .* cannot be inspected/)
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '.../scripts/check-ci-wiring.mjs'`):

```
node --test scripts/test/check-ci-wiring.test.mjs
```

**5d. Implement `scripts/check-ci-wiring.mjs`** — a dependency-free, indentation-aware structural scan.
**Do NOT add a YAML dependency**: none is resolvable (`yaml` appears in the root `package.json` only as a
pnpm override) and a new dep needs approval. GitHub remains the authoritative YAML parser; this check
only has to prove each job exists and invokes its commands.

```js
#!/usr/bin/env node
// The CI-wiring gate: proves each gate job below EXISTS in `.github/workflows/ci.yml` and INVOKES its
// required commands. A registered-but-never-run gate is a safety net that is never armed.
//
// SCOPE LIMIT — this is NOT a YAML parser and must never grow into one. It is an indentation-aware
// LINE SCAN with exactly one job: prove that each named job key exists under the top-level `jobs:`
// mapping, that each required NORMALIZED LINE appears INSIDE that job's own block, and that each
// required STEP GROUP appears inside a SINGLE step block of it (the ownership assertion, round-11 F1).
// An indentation-scoped EXACT-LINE match, chunked by list item, is still not a YAML parser — it is
// merely not restricted to `run:` lines. GitHub remains the authoritative YAML parser (a malformed
// workflow fails there, loudly). No YAML dependency is added: none is resolvable in this repo (`yaml`
// appears in the root `package.json` only as a pnpm override) and a new dependency needs approval. If
// you find yourself adding key/value lookups, path expressions, anchors, flow scalars, or block scalars
// here, STOP — the check has outgrown its purpose.
//
// It replaces a substring scan (`y.includes('publishable-versions:') && …`), which FALSE-GREENS when
// those strings appear only inside `#` comments or under an unrelated job (INTERFACES round-9 F2).
//
// Reads the workflow through `readTextGuarded` — never a raw `readFileSync`. A committed
// `.github/workflows/ci.yml -> ~/.aws/credentials` symlink would otherwise be followed and its bytes
// scanned (INTERFACES round-9 F1).
import { pathToFileURL } from 'node:url'
import { MAX_WORKFLOW_BYTES, readTextGuarded } from './lib/guarded-read.mjs'

/**
 * @typedef {object} JobRequirement
 * @property {string[]} runs Exact `run:` commands — the FULL command string, ARGUMENTS INCLUDED (`bash
 *   fixtures/verdaccio-gallery/pack.sh ./artifacts`, not `bash`) — that must appear as a `run:` step
 *   inside the job, at EITHER position: a list item (`- run: <cmd>`) or an indented property of a
 *   MULTI-KEY step (`- env:` / `ARTIFACTS_DIR: …` / `run: <cmd>`). Both normalize to `run: <cmd>`.
 *   Matching only the list-item form is what made the round-9 checker REJECT 06e's real `template-smoke`
 *   gate step — the checker rejecting the very workflow it verifies (round-10 F1).
 * @property {string[]} [lines] OPTIONAL exact NORMALIZED lines that must appear inside the job's OWN
 *   block — for JOB-LEVEL assertions that are neither a `run:` command nor a property of any step (06e's
 *   four-template matrix line lives under `strategy:`, outside every step). Anything that BELONGS to a
 *   step goes in `steps` instead — `lines` proves existence, not ownership.
 *   This is an EXACT LINE match, NOT a substring scan. The round-9 design used a block-scoped substring
 *   (`contains`), but `template-smoke` carries `2.109.1` TWICE — the real pin AND a `grep -qF '2.109.1'`
 *   drift check — so it PASSED with `version: latest`, satisfied purely by the grep argument. Shrinking
 *   the haystack does not turn a substring search into an assertion (round-10 F2).
 * @property {string[][]} [steps] OPTIONAL. Each inner array is a set of exact NORMALIZED lines that must
 *   ALL appear WITHIN A SINGLE STEP BLOCK of the job. This is the OWNERSHIP assertion (round-11 F1):
 *   `lines` is an unordered set match over the whole job block, so it proves `uses: supabase/setup-cli@v2`
 *   and `with: { version: 2.109.1 }` each occur SOMEWHERE in `template-smoke` — not that the `with:`
 *   belongs to that action. Supabase could run on `latest` while a DECOY step owns the pinned line, and
 *   `lines` still greens (reproduced). `steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']]`
 *   closes that.
 *   DELIBERATELY STEP-SCOPED, NOT STRICT ADJACENCY — do NOT "upgrade" this to a `sequences` field. Both
 *   were verified against the real YAML: adjacency catches the decoy too, but goes falsely RED as soon as
 *   anyone adds an `id:` or a `name:` to that step — and a gate that cries wolf gets disabled, after which
 *   it protects nothing. Step-scoping expresses the actual invariant ("the `with:` belongs to this step"),
 *   tolerates any step property (a test pins that), and is still a line scan.
 *   STILL WITHIN THE SCOPE LIMIT: an indentation-scoped exact-line match, step-chunked by list item, is
 *   not a YAML parser. Do NOT grow this into key/value lookups or anchor resolution.
 */

/**
 * THE shared CI-wiring table: job name → what that job MUST contain.
 * 06d OWNS this script and seeds the table; **later parts only APPEND an entry** (06e appends
 * `pack-artifacts` + `template-gallery` + `template-smoke`). Do NOT write a second CI-wiring checker —
 * one script, one table.
 * @type {Record<string, JobRequirement>}
 */
export const REQUIRED_JOBS = {
  'publishable-versions': {
    runs: ['pnpm test:version-gate', 'pnpm check:publishable-versions'],
  },
  // 06e APPENDS its three entries here; nothing else in this file changes. For example, 06e's
  // `template-smoke` pins the Supabase CLI — not a `run:` command, and the pin must be OWNED by the
  // setup-cli step (`steps`), while the 4-way matrix sits under `strategy:`, outside every step (`lines`):
  //   'template-smoke': {
  //     runs: ["supabase --version | grep -qF '2.109.1'",
  //            'bash fixtures/verdaccio-gallery/gate.sh ${{ matrix.template }}'],
  //     lines: ['template: [crm-lite, marketing-site, support-desk, knowledge-base]'],
  //     steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']],
  //   },
}

export const DEFAULT_WORKFLOW = '.github/workflows/ci.yml'

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length

/**
 * Strip a trailing `#` comment, QUOTE-AWARE: a `#` inside `'…'` or `"…"` is a literal, not a comment, so
 * `- run: supabase --version | grep -qF '2.109.1'   # fail loud` keeps its quoted `'2.109.1'` INTACT.
 * (A naive `line.split('#')[0]` would truncate that run command and break the `runs` match.) Per YAML, a
 * comment `#` starts a comment only at line start or after whitespace — `a#b` is not a comment.
 * @param {string} line
 */
function stripComment(line) {
  /** @type {string | null} */
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Normalize a line for EXACT comparison: strip a trailing comment (quote-aware) → collapse runs of
 * whitespace → trim → strip a leading list-item `- `. That last step is what lets ONE form match a step
 * property at EITHER position: `- run: X` (list item) and a multi-key step's indented `run: X` both
 * normalize to `run: X` (round-10 F1), so a single `/^run: …/` match handles both.
 * @param {string} line
 */
const normalizeLine = (line) => stripComment(line).replace(/\s+/g, ' ').trim().replace(/^- /, '')

/** Strip surrounding quotes so `run: "pnpm x"` and `run: pnpm x` compare equal. @param {string} value */
function unquote(value) {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length >= 2 && value.at(-1) === first) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Split a job's RAW block lines into STEP CHUNKS of normalized lines — the unit the `steps` OWNERSHIP
 * requirement is matched against (round-11 F1).
 *
 * First locate the job-level `steps:` key, then bound its child block. A step begins at a direct `- `
 * list item inside that block; every deeper line belongs to that step until the next direct list item.
 * Anchoring on `steps:` matters: a block-style `strategy.matrix` or `needs` list may be the first list
 * item in the job, but it is not a step and must not determine the step indent.
 *
 * Comment-only lines are already dropped by the caller, so a comment sitting between `- uses:` and
 * `with:` cannot split a step.
 *
 * SCOPE LIMIT holds: chunking by list item is still a LINE SCAN, not YAML parsing. Do NOT grow it into one.
 * @param {string[]} rawJobLines
 * @returns {string[][]} one array of normalized lines per step
 */
function stepChunks(rawJobLines) {
  if (rawJobLines.length === 0) return []
  const jobPropertyIndent = Math.min(...rawJobLines.map(indentOf))
  const stepsIndex = rawJobLines.findIndex(
    (line) => indentOf(line) === jobPropertyIndent && stripComment(line).trim() === 'steps:',
  )
  if (stepsIndex === -1) return []

  const stepsIndent = indentOf(rawJobLines[stepsIndex])
  const stepLines = []
  for (let i = stepsIndex + 1; i < rawJobLines.length; i += 1) {
    if (indentOf(rawJobLines[i]) <= stepsIndent) break
    stepLines.push(rawJobLines[i])
  }
  const firstItem = stepLines.find((line) => /^\s*- /.test(line))
  if (firstItem === undefined) return []
  const stepIndent = indentOf(firstItem)

  /** @type {string[][]} */
  const chunks = []
  /** @type {string[] | null} */
  let current = null
  for (const raw of stepLines) {
    const indent = indentOf(raw)
    if (indent === stepIndent && /^\s*- /.test(raw)) {
      current = []
      chunks.push(current)
    } else if (current !== null && indent <= stepIndent) {
      current = null // a key at same-or-shallower indent ends the step sequence
    }
    if (current === null) continue
    const normalized = normalizeLine(raw)
    if (normalized !== '') current.push(normalized)
  }
  return chunks
}

/**
 * @param {string} [workflowPath]
 * @param {Record<string, JobRequirement>} [requiredJobs]
 * @returns {string[]} human-readable problems; `[]` means the gate passes. THROWS (`workflow_*`) if the
 *   workflow cannot be safely read.
 */
export function checkCiWiring(workflowPath = DEFAULT_WORKFLOW, requiredJobs = REQUIRED_JOBS) {
  const text = readTextGuarded(workflowPath, MAX_WORKFLOW_BYTES, 'workflow')

  // Strip comment-only and blank lines BEFORE any structural analysis. THE defect this closes: a
  // workflow whose entire gate job exists only as `#` comments passed the old substring scan with
  // exit 0 — the check that proves the gate is armed was itself a false green.
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))

  // The TOP-LEVEL `jobs:` mapping, at indent 0. GOTCHA: this repo's ci.yml also contains a job literally
  // NAMED `jobs:` at indent 2 (ci.yml:173) — matching on the trimmed text alone finds the WRONG one.
  const jobsIdx = lines.findIndex((line) => indentOf(line) === 0 && line.trim() === 'jobs:')
  if (jobsIdx === -1) {
    return [`ci_wiring_jobs_block_missing: ${workflowPath} has no top-level "jobs:" mapping`]
  }

  /** Every line of the `jobs:` mapping: up to the next top-level (indent 0) key. */
  const block = []
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    if (indentOf(lines[i]) === 0) break
    block.push(lines[i])
  }
  if (block.length === 0) {
    return [`ci_wiring_jobs_block_missing: ${workflowPath} has an empty "jobs:" mapping`]
  }

  // A job KEY is a bare `name:` line at the jobs mapping's own indent — not a substring anywhere.
  const jobIndent = indentOf(block[0])
  /** @type {string[]} */
  const problems = []

  for (const [jobName, requirement] of Object.entries(requiredJobs)) {
    /** @type {number[]} */
    const starts = []
    for (let i = 0; i < block.length; i += 1) {
      if (indentOf(block[i]) !== jobIndent) continue
      const key = block[i].trim().match(/^([A-Za-z0-9_.-]+):$/)
      if (key !== null && key[1] === jobName) starts.push(i)
    }

    if (starts.length === 0) {
      problems.push(
        `ci_wiring_job_missing: ${workflowPath} has no "${jobName}:" job under "jobs:" (a job name in a comment or a substring elsewhere does NOT count)`,
      )
      continue
    }
    if (starts.length > 1) {
      // Duplicate keys are a YAML error GitHub would reject; never silently pick one and pass.
      problems.push(
        `ci_wiring_job_duplicated: ${workflowPath} declares the "${jobName}:" job ${starts.length} times`,
      )
      continue
    }

    // The job's OWN block, NORMALIZED. Bounded by the next key at the same-or-shallower indent, so a
    // `run:` (or any other line) in a NEIGHBOURING job is outside it — which is the whole point.
    // Comment-only lines were dropped above, so a commented-out line is outside it too.
    /** @type {string[]} */
    const jobRaw = []
    for (let i = starts[0] + 1; i < block.length && indentOf(block[i]) > jobIndent; i += 1) {
      jobRaw.push(block[i])
    }
    // RAW is kept alongside NORMALIZED: `stepChunks` needs the original indentation to find step
    // boundaries, and normalizing first would destroy it (`normalizeLine` trims).
    const jobLines = jobRaw.map(normalizeLine)

    // A `run:` step at EITHER position: `- run: X` (list item) and a multi-key step's indented `run: X`
    // BOTH normalize to `run: X`, so ONE match handles both (round-10 F1). The matched command is the
    // FULL string, arguments included — `bash fixtures/verdaccio-gallery/pack.sh ./artifacts`.
    /** @type {Set<string>} */
    const runs = new Set()
    for (const line of jobLines) {
      const run = line.match(/^run:\s+(.+)$/)
      if (run !== null) runs.add(unquote(run[1].trim()))
    }
    for (const command of requirement.runs) {
      if (!runs.has(command)) {
        problems.push(
          `ci_wiring_run_missing: ${workflowPath} job "${jobName}" does not invoke \`${command}\` (expected an exact \`run: ${command}\` step inside that job — as \`- run:\` or as a multi-key step's \`run:\` property)`,
        )
      }
    }

    // `lines`: an EXACT match against a NORMALIZED line of the job's block — NEVER a substring scan.
    // A substring scan is exactly what round-10 F2 removed: `template-smoke` carries `2.109.1` TWICE
    // (the real pin AND a `grep -qF '2.109.1'` drift check), so `jobText.includes('2.109.1')` passed
    // even with `version: latest`. Requiring the exact line `with: { version: 2.109.1 }` cannot be
    // satisfied by a comment, by a grep argument, or by another job.
    const jobLineSet = new Set(jobLines)
    for (const required of requirement.lines ?? []) {
      if (!jobLineSet.has(required)) {
        problems.push(
          `ci_wiring_line_missing: ${workflowPath} job "${jobName}" has no line \`${required}\` (an EXACT normalized line inside THAT job's block — a substring, a comment, a grep argument, or a match in another job does NOT count)`,
        )
      }
    }

    // `steps`: OWNERSHIP, not existence (round-11 F1). The `lines` check above is an unordered set match
    // over the WHOLE job block, so it cannot tell `with: { version: 2.109.1 }` OWNED by
    // `uses: supabase/setup-cli@v2` apart from the same line owned by a DECOY action while setup-cli runs
    // on `latest`. Every line of a `steps` group must land inside ONE step chunk.
    // NOT strict adjacency, deliberately — do NOT "upgrade" this: adjacency catches the decoy too, but
    // goes falsely RED the moment a step gains an `id:` or a `name:`, and a gate that cries wolf gets
    // disabled, after which it protects nothing. A test pins the `id:`/`name:` tolerance.
    const chunks = stepChunks(jobRaw)
    for (const required of requirement.steps ?? []) {
      const owned = chunks.some((chunk) => required.every((line) => chunk.includes(line)))
      if (!owned) {
        const wanted = required.map((line) => `\`${line}\``).join(', ')
        problems.push(
          `ci_wiring_step_missing: ${workflowPath} job "${jobName}" has no single step containing all of [${wanted}] (each line may EXIST somewhere in the job while belonging to a DIFFERENT step — that is not ownership)`,
        )
      }
    }
  }

  return problems
}

// Exit-code contract: 0 = every required job is armed · 1 = a real finding (a job, a `run:`, a required
// `lines` entry, or a required `steps` group is missing/duplicated) · 2 = OPERATIONAL failure (the
// workflow is a symlink, oversized, or unreadable). An operational failure is NEVER 0 — automation reads
// the code.
//
// GOTCHA: guard `process.argv[1]` before `pathToFileURL` — it is UNDEFINED when this module is imported
// from an eval context (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE`
// at import time. That turns a library import into a crash. (Hit for real while verifying this plan.)
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  const workflowPath = process.argv[2] ?? DEFAULT_WORKFLOW
  /** @type {string[]} */
  let problems
  try {
    problems = checkCiWiring(workflowPath)
  } catch (err) {
    console.error(
      `ci-wiring gate: OPERATIONAL FAILURE — ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  const names = Object.keys(REQUIRED_JOBS)
  console.log(`ci wiring: ${names.length} gate job(s) armed in ${workflowPath} — ${names.join(', ')}`)
}
```

Re-run the test — **Expected: PASS**, `pass 19 / fail 0`. Then run the checker against the real `ci.yml`
you just edited in 5b:

```
node --test scripts/test/check-ci-wiring.test.mjs
node scripts/check-ci-wiring.mjs
```

**Expected:** `ci wiring: 1 gate job(s) armed in .github/workflows/ci.yml — publishable-versions`, exit 0.
(Before the 5b edit the SAME command exits **1** with `ci_wiring_job_missing` — verified against the
current tree.) If `actionlint` is on PATH, also run `actionlint .github/workflows/ci.yml` — Expected: no
errors. `check-ci-wiring.mjs` deliberately does not duplicate actionlint: it proves the gate is ARMED,
not that the whole workflow is valid YAML.

**6. Bump each publishable `package.json`** `"version": "0.0.0"` → `"version": "0.1.0"` (the 12 files
listed under Files). Edit only the `version` field; leave `publishConfig`, `main`, `exports` untouched.

**7. Confirm no in-repo consumer manifest pins `0.0.0`.** Run the SAME scoped pathspec the gate uses
(`MANIFEST_PATHSPEC`) — an unscoped `git grep` would also match this task's own test fixtures and the
plan prose quoting the pattern, which are not consumer pins:

```
git grep -nE '"@movp/[a-z-]+":[[:space:]]*"0\.0\.0"' -- '*package.json' '*package.json.template'
```

**Expected: EMPTY, exit 1** (all internal deps use `workspace:*`; verified against the current tree —
root `package.json` devDeps are `@movp/codegen`/`@movp/core-schema` `workspace:*`, and the scoped
pathspec matches the root manifest + `packages/<name>/package.json` +
`templates/<name>/package.json[.template]`). If this prints a line, STOP and reconcile before continuing.

**8. Rebuild the platform artifact** so its manifest carries the new `platformVersion`:

```
pnpm --filter @movp/platform build
```

**Expected:** prints `@movp/platform: bundled <N> migrations (platformVersion 0.1.0)`.

**9. Run the whole monorepo suite** (nothing behavioural changed; a version bump must not break tests):

```
pnpm -w test && pnpm -w typecheck
```

**Expected:** green.

**10. Commit** (`chore(c6d): bump publishable @movp/* + @movp/platform to 0.1.0 behind a guarded version gate`).

### Gate (machine-checkable)

```
node --test scripts/test/guarded-read.test.mjs scripts/test/check-publishable-versions.test.mjs scripts/test/check-ci-wiring.test.mjs \
  && node scripts/check-publishable-versions.mjs \
  && pnpm --filter @movp/platform build \
  && node scripts/check-ci-wiring.mjs
```

> **GOTCHA — never end an `&&` chain with `; test $? -eq N` (INTERFACES round-8 F1).** `&&`
> short-circuits, and a trailing `test` reads `$?` from whatever ran LAST, so an early failure becomes
> **exit 0, green** (`bash -c 'false && echo B ; test $? -eq 1'` → `0`). This gate is a plain `A && B &&
> C && D` chain: any component failing fails the whole gate. The `assert-this-fails` idiom is legitimate
> ONLY against a SINGLE command — step 4's `node scripts/check-publishable-versions.mjs ; test $? -eq 1`
> is the correct use, and it is the only one in this plan.
>
> There is deliberately **no trailing scoped `git grep`** here: `check-publishable-versions.mjs` already
> performs exactly that scoped-pathspec check with correct 0/1/2 status discrimination (round-7 F1), so a
> second copy would be redundant *and* was the thing dragging the `$?` arithmetic in.
>
> **GOTCHA — the 4th component is a SCRIPT, not a `node -e` one-liner (INTERFACES round-9).** A `node -e`
> string is CommonJS: it cannot cleanly `import` the ESM guard, which is exactly why the round-8 version
> reached for a raw `readFileSync` and re-opened the untrusted-I/O hole. And its `includes()` scan
> false-greened on a commented-out job. `node scripts/check-ci-wiring.mjs` reads through `readTextGuarded`
> and checks the STRUCTURE. Do not inline it back.

**Expected:** `node --test` prints `pass 43 / fail 0` — 14 guarded-read (6 `readTextGuarded` + 8
`readJsonGuarded`) + 9 version-gate + 20 ci-wiring. The version gate's three git branches are each
pinned (status 0 with a match FAILS, status 1 PASSES, status 2 / spawn-error THROWS rather than
reporting "no pins"); the ci-wiring checker's four hostile workflows each FAIL (comments-only,
right-commands-wrong-job, one-command-missing, duplicate-job-name) and the intended job PASSES; `lines`
is proven to be an EXACT normalized-line match, not a substring scan (a `version: latest` pin FAILS even
though a `grep -qF '2.109.1'` run line keeps the literal in the block — the round-10 F2 regression; a
required line in a COMMENT or in a NEIGHBOURING job also FAILS); `steps` is proven to assert OWNERSHIP,
not existence (a DECOY step owning `with: { version: 2.109.1 }` while setup-cli runs on `latest` FAILS
with `ci_wiring_step_missing` — and the round-10 `lines`-only form is shown to PASS that same fixture,
which is the regression proof; adding `id:`/`name:` to the setup-cli step still PASSES, which is why
adjacency was rejected; a block-style matrix list before `steps:` also PASSES, proving step extraction
is anchored to the `steps:` block rather than the job's first list item — round-11 F1); and — the acceptance test —
**06e's real four-job workflow, pasted verbatim, PASSES with ZERO problems**, while deleting its
multi-key `- env:`/`run:` gate step turns it RED. On a root/win32 runner the two EACCES cases self-skip →
`pass 41 / skip 2`, still `fail 0`.

> **Why the verbatim-06e test is the load-bearing one (round-10 F1).** The round-9 checker passed five
> hand-made fixtures and would still have REJECTED the real workflow — its parser matched only the
> list-item `- run: <cmd>` form, and `template-smoke`'s gate step is a multi-key step whose `run:` is an
> indented property. A gate that rejects the very workflow it exists to verify is worse than no gate: it
> is permanently RED and gets disabled. A fixture you wrote yourself cannot catch that class of defect —
> only the real artifact can. Do not "simplify" this fixture.

The version script prints its success line — exit 0, and it FAILS this chain with exit **1** on a real
finding (a wrong version or a `0.0.0` consumer pin) or **2** on an operational failure, never 0. The
platform build prints `platformVersion 0.1.0`. The ci-wiring gate prints
`ci wiring: 1 gate job(s) armed in .github/workflows/ci.yml — publishable-versions` (exit 0); it exits
**1** if step 5b's job is missing/duplicated, either `run:` is absent, or (once 06e appends its entries)
a required `lines`/`steps` assertion fails, and **2** if `ci.yml` is a symlink, oversized, or unreadable.

`check-release-preflight.mjs` is unchanged **(N/A with evidence: it reads no version — it only shells
`npm org --help`, `npm whoami`, `npm org ls movp`).**

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
- **Create:** `scripts/tree-snapshot.mjs` — **THE ONE shared staging-safety snapshot** (INTERFACES F2).
  Created HERE because this task's copier test is its first consumer; Task 5's `gate.sh` +
  staging-safety test and **06e's template fixtures** consume this same file. 06e MUST NOT write a
  second snapshot script.
- **Create:** `scripts/tree-snapshot.d.mts` (its type declaration — a TS consumer importing an
  untyped `.mjs` would otherwise get an implicit `any`)
- **Test (create):** `packages/create-movp/test/tree-snapshot.test.ts`
- **Test (create):** `packages/create-movp/test/copier.test.ts`

### Interfaces

- **Consumes:** none (pure `node:fs`/`node:path`/`node:crypto`).
- **Produces (LOCKED — consumed by Task 3's scaffolder, Task 5's pack harness, and 06e's gallery
  templates + CI matrix. 06d OWNS these primitives; the signatures below are the stable contract 06e
  imports — do not change them when executing 06e):**
  - `scripts/tree-snapshot.mjs` — the SHARED bounded tree snapshot (INTERFACES F2). Two interfaces,
    both stable:
    - **module:** `export async function snapshotTree(root: string, roots?: string[]): Promise<string>`
      (default `roots` = `DEFAULT_ROOTS` = `['packages/create-movp', 'templates']`; pass `['.']` to
      snapshot an arbitrary tree whole). Types ship in `scripts/tree-snapshot.d.mts`.
    - **CLI:** `node scripts/tree-snapshot.mjs <root> [outFile]` — writes the manifest to `<outFile>`
      when one is supplied, otherwise emits it to **stdout**. `<outFile>` is OPTIONAL and BOTH forms
      emit byte-identical bytes (INTERFACES round-6 F1): 06d's `gate.sh` passes an `<outFile>`; 06e's
      six call sites pass `<root>` only and redirect stdout. A missing `<root>` is still `exit 2`.
    Deterministic, path-sorted `<kind> <sha256|target|-> <relpath>` manifest. **Bounded:** every file
    is hashed by streaming 64 KiB chunks (`createReadStream` + `createHash`) — never `readFileSync`,
    so a large untracked file cannot OOM the gate that exists to tolerate a dirty worktree.
    `lstat`-based: a symlink is recorded by its target STRING and never followed. Skips `node_modules`
    /`.git`/`.turbo`. NEVER prints file content (path + hash only).
  - `interface CopyOptions { templateDir: string; targetDir: string; tokens: Record<string, string> }`
  - `function resolveTargetDir(parentDir: string, projectName: string): string` — validates the name
    charset, rejects `..`, resolves under `parentDir`, requires the result absent. Throws
    `invalid_project_name` / `target_exists`.
  - `function copyTemplate(opts: CopyOptions): { filesWritten: number; bytesWritten: number }` — the
    hardened copy+substitute. `lstat`s EVERY directory before `readdir` — **the template ROOT
    included** — so a symlinked template root (`templates/crm-lite -> /external/dir`) is rejected, not
    followed. Throws the stable copier codes on any unsafe input.
  - `function copyTreeGuarded(srcDir: string, destDir: string): { filesCopied: number; bytesCopied: number }` —
    the SAME untrusted-io guards (ROOT-and-every-subdirectory lstat/symlink-reject, excluded-dir skip,
    size bounds, path-only errors) with NO substitution/rename: a verbatim regular-file-only tree copy.
    Consumed by Task 5's pack-harness staging (INTERFACES F1) so a symlinked template file — or a
    symlinked template ROOT — fails the pack and the source worktree is never mutated. Throws the same
    stable copier codes.
  - `function copyFileGuarded(src: string, dest: string): { bytesCopied: number }` — a guarded
    **single-file** copy: `lstat` the source (reject a symlink → `template_symlink_rejected`; reject a
    non-regular file → `template_not_regular_file`), size-bound with `lstat.size` BEFORE the read
    (`template_file_too_large`), then `mkdir -p` the dest's parent and write. Every EXPLICIT one-off
    file copy in a pack-staging script (`packages/create-movp/package.json`) goes through this
    (INTERFACES F1) — a raw `copyFileSync` on an unguarded path would follow a symlinked
    `package.json` straight out of the repo and pack whatever it points at.
  - `function readFileGuarded(src: string): Buffer` — a guarded **single-file READ** (INTERFACES
    round-6 F2): the same guards as `copyFileGuarded` (`lstat` BEFORE any stat/read → reject a symlink
    with `template_symlink_rejected` and a non-regular file with `template_not_regular_file`;
    size-bound via `lstat.size` BEFORE buffering → `template_file_too_large`; path + reason in the
    error, NEVER the bytes) but it returns the Buffer instead of writing it. Callers do
    `.toString('utf8')`. This is the read-only half of the seam: **06e's
    `scripts/check-template-gallery.ts` consumes it** for `seed.sql` and every template page, and
    `copyFileGuarded` for the `movp.deltas.json` copy — a guard on the copy path but not the read path
    is not a guard. 06d owns the ONE implementation; 06e does not define its own.
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
> source, so `files` includes `templates`. The template is NOT materialized into the source worktree —
> at PACK time (Task 5, INTERFACES F1) `copyTreeGuarded` copies `templates/crm-lite/` into a TEMP
> `create-movp` staging tree (`<staging>/templates/crm-lite/`) through the same untrusted-io guards,
> and `npm publish` runs from there, so `packages/create-movp/templates` is never written and a
> symlinked template file fails the pack instead of shipping. In the published tarball `templates/`
> sits at the package root next to `dist/`, so the runtime copier's `templateDir`
> (`dist/../templates/<name>`, resolved relative to the INSTALLED package) still finds it.

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

(`templates/` is gitignored as a DEFENSIVE guard — the pack harness materializes templates into a
TEMP staging tree, never here (INTERFACES F1); the ignore only prevents a stray local materialization
from being committed. The source of truth is the repo-root `templates/crm-lite/`. Note it is
gitignored, **not forbidden**: no gate may assert this directory is absent, and nothing may delete it
— a developer's files there are theirs. The gate's F2 snapshot proves staging did not TOUCH it,
which is the invariant that actually matters.)

**5. Create the ONE shared snapshot helper (INTERFACES F2) — test first.**

Every "did this step mutate the tree?" assertion in 06d **and 06e** goes through this single file. Do
not write a second snapshot implementation anywhere (an inline `readFileSync`-based one in a test
counts): the bug it exists to prevent is precisely a snapshot that buffers whole files and OOMs on a
large untracked one.

**5a. `packages/create-movp/test/tree-snapshot.test.ts`** — the failing test:

```ts
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'

// The helper's chunk size. Every case below CROSSES it — the bug this file pins is a whole-file
// `readFileSync`, which passes any single-chunk test.
const CHUNK_BYTES = 64 * 1024
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const snapshotScript = join(repoRoot, 'scripts', 'tree-snapshot.mjs')

let root = ''
let templates = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'movp-tree-snapshot-'))
  templates = join(root, 'templates', 'crm-lite')
  mkdirSync(templates, { recursive: true })
  mkdirSync(join(root, 'packages', 'create-movp'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('snapshotTree (the ONE shared bounded snapshot — INTERFACES F2)', () => {
  it('hashes a file MUCH larger than the chunk size correctly', async () => {
    // ~5 MiB ≫ the 64 KiB chunk, and deliberately NOT a chunk multiple (the +7 tail).
    const big = Buffer.alloc(80 * CHUNK_BYTES + 7, 0x61)
    writeFileSync(join(templates, 'big.sql'), big)
    const expected = createHash('sha256').update(big).digest('hex')
    expect(await snapshotTree(root)).toContain(
      `file ${expected} ${join('templates', 'crm-lite', 'big.sql')}`,
    )
  })

  // Boundedness is a SOURCE property — an RSS/heap probe is flaky (GC timing, Buffer pooling), so pin
  // it deterministically instead: the helper must stream. `gate.sh` greps for the same thing.
  it('is BOUNDED: streams via createReadStream and never buffers a whole file', () => {
    const src = readFileSync(snapshotScript, 'utf8')
    expect(src).toContain('createReadStream')
    expect(src).not.toMatch(/\breadFileSync\(/)
    expect(src).not.toMatch(/\breadFile\(/)
  })

  it('detects a ONE-BYTE change inside a later chunk', async () => {
    const bytes = Buffer.alloc(3 * CHUNK_BYTES, 0x61)
    writeFileSync(join(templates, 'big.sql'), bytes)
    const before = await snapshotTree(root)
    bytes[2 * CHUNK_BYTES + 11] = 0x62 // one byte, in the THIRD chunk
    writeFileSync(join(templates, 'big.sql'), bytes)
    expect(await snapshotTree(root)).not.toBe(before)
  })

  it('records a symlink by its target WITHOUT following it, and never emits file content', async () => {
    writeFileSync(join(root, 'secret'), 'ssh-key\n')
    symlinkSync(join(root, 'secret'), join(templates, 'notes.ts'))
    const manifest = await snapshotTree(root)
    expect(manifest).toContain(`symlink ${join(root, 'secret')} ${join('templates', 'crm-lite', 'notes.ts')}`)
    expect(manifest).not.toContain('ssh-key')
  })

  it('skips node_modules and is byte-stable across runs', async () => {
    mkdirSync(join(templates, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(templates, 'node_modules', 'junk', 'index.js'), 'x\n')
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    const manifest = await snapshotTree(root)
    expect(manifest).not.toContain('node_modules')
    expect(await snapshotTree(root)).toBe(manifest)
  })

  it('reports an absent root as a stable line instead of throwing', async () => {
    rmSync(join(root, 'packages'), { recursive: true, force: true })
    expect(await snapshotTree(root)).toContain('absent - packages/create-movp')
  })

  it('snapshots an arbitrary tree with roots = ["."] (the copier tests\' shape)', async () => {
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    const manifest = await snapshotTree(templates, ['.'])
    expect(manifest).toContain('file ')
    expect(manifest).toContain('README.md')
  })

  // INTERFACES round-6 F1: the CLI contract is `<root> [outFile]` and BOTH forms have real consumers
  // — 06d's gate.sh writes a file, 06e's six call sites redirect stdout. The two forms are diffed
  // against each other by those gates, so a one-byte divergence (e.g. a `console.log` trailing
  // newline on the stdout path) would break them. Pin byte-identity.
  it('CLI: the stdout form and the <outFile> form emit BYTE-IDENTICAL manifests', () => {
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    // The out file sits at the synthetic root — OUTSIDE the snapshotted roots (`packages/create-movp`,
    // `templates`) — so writing it cannot change what the second run hashes.
    const outFile = join(root, 'manifest.txt')

    const piped = spawnSync(process.execPath, [snapshotScript, root], { encoding: 'buffer' })
    expect(piped.status).toBe(0)
    const written = spawnSync(process.execPath, [snapshotScript, root, outFile], { encoding: 'buffer' })
    expect(written.status).toBe(0)

    expect(readFileSync(outFile)).toEqual(piped.stdout) // byte-for-byte, not merely "equivalent"
    expect(written.stdout.length).toBe(0) // the file form prints nothing to stdout
    expect(piped.stdout.toString('utf8')).toContain(join('templates', 'crm-lite', 'README.md'))
  })

  it('CLI: a missing <root> still exits 2', () => {
    const res = spawnSync(process.execPath, [snapshotScript], { encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('usage: tree-snapshot.mjs <root> [outFile]')
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '../../../scripts/tree-snapshot.mjs'`).

**5b. Implement `scripts/tree-snapshot.mjs`:**

```js
#!/usr/bin/env node
// THE shared staging-safety snapshot (INTERFACES F2). C6d OWNS it; C6d's `gate.sh` + copier tests and
// C6e's template fixtures all consume THIS file — do not fork a second snapshot implementation.
//
// It emits a deterministic, path-sorted content-hash manifest of the SOURCE subtrees a pack/stage step
// reads, so a caller can diff a BEFORE against an AFTER and assert "staging MUTATED nothing" — never
// "the worktree is pristine" (a developer's unrelated WIP edits and untracked files are legitimate,
// appear in BOTH manifests, and must survive).
//
// Invariants, each closing a real failure mode:
//   * BOUNDED memory — every file is hashed by STREAMING it in 64 KiB chunks (`createReadStream` +
//     `createHash`). NEVER `readFileSync`: a large untracked file (a stray pg_dump under templates/)
//     would OOM the very gate that exists to tolerate a dirty worktree.
//   * `lstat`, NEVER `stat` — a symlink is recorded by its target STRING and never followed or read,
//     so the snapshot cannot become the exfiltration path the copier's guards close.
//   * Content is NEVER printed — a line carries a path + a sha256 only; the diff goes to CI logs.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The subtrees a `create-movp` pack/stage step reads. Everything else is out of scope. */
export const DEFAULT_ROOTS = ['packages/create-movp', 'templates']
/** Volatile, and never written by staging: hashing them is slow and flaky, not safer. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo'])
/** Hash chunk size. Peak memory is bounded by THIS, not by the file's size. */
const CHUNK_BYTES = 64 * 1024

/** @param {string} abs @returns {Promise<string>} sha256 — streamed, never buffers the whole file. */
async function hashFile(abs) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs, { highWaterMark: CHUNK_BYTES })) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * @param {string} root absolute path of the tree to snapshot (the real repo, or a synthetic one)
 * @param {string[]} [roots] subtrees of `root` to include (`['.']` = the whole tree)
 * @returns {Promise<string>} sorted `<kind> <sha256|target|-> <relpath>` lines, newline-terminated
 */
export async function snapshotTree(root, roots = DEFAULT_ROOTS) {
  /** @type {string[]} */
  const lines = []
  /** @param {string} rel */
  const walk = async (rel) => {
    for (const entry of (await readdir(join(root, rel))).sort()) {
      const childRel = join(rel, entry)
      const abs = join(root, childRel)
      const info = await lstat(abs) // lstat, never stat — see header
      if (info.isSymbolicLink()) {
        lines.push(`symlink ${await readlink(abs)} ${childRel}`)
        continue
      }
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        lines.push(`dir - ${childRel}`)
        await walk(childRel)
        continue
      }
      if (!info.isFile()) {
        lines.push(`other - ${childRel}`)
        continue
      }
      lines.push(`file ${await hashFile(abs)} ${childRel}`)
    }
  }
  for (const rel of roots) {
    const abs = join(root, rel)
    const info = await lstat(abs).catch(() => null)
    if (!info) {
      lines.push(`absent - ${rel}`) // an absent root is a legal, STABLE state, not an error
      continue
    }
    if (info.isSymbolicLink()) {
      lines.push(`symlink ${await readlink(abs)} ${rel}`)
      continue
    }
    lines.push(`dir - ${rel}`)
    await walk(rel)
  }
  return `${lines.join('\n')}\n`
}

// CLI: `<root> [outFile]` (INTERFACES round-6 F1). `outFile` is OPTIONAL — 06d's `gate.sh` passes one
// (`... "$REPO_ROOT" "$WORK/snapshot-before.txt"`); 06e's six call sites pass `<root>` only and
// redirect stdout. Both forms have real consumers and BOTH must emit byte-identical bytes.
// GOTCHA: use `process.stdout.write`, NEVER `console.log` — console.log appends a trailing newline
// that the file form does not write, so the two forms would differ by one byte and the diff-based
// gates that compare a piped manifest against a written one would fail spuriously.
//
// GOTCHA: `process.argv[1]` is `undefined` when this module is IMPORTED from an eval context
// (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE` — turning a
// library import into a crash. 06e imports `snapshotTree` from this file, so the guard is load-bearing.
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  const [root, outFile] = process.argv.slice(2)
  if (!root) {
    console.error('usage: tree-snapshot.mjs <root> [outFile]')
    process.exit(2)
  }
  const manifest = await snapshotTree(root)
  if (outFile) await writeFile(outFile, manifest)
  else process.stdout.write(manifest)
}
```

**5c. `scripts/tree-snapshot.d.mts`** — without this, a `.ts` consumer importing the `.mjs` gets
`TS7016: … implicitly has an 'any' type` (verified). TS resolves `./x.mjs` → `./x.d.mts`.

```ts
/** The subtrees a `create-movp` pack/stage step reads. */
export declare const DEFAULT_ROOTS: string[]
/**
 * Deterministic, path-sorted content-hash manifest of `roots` under `root`.
 * Streams every file in bounded chunks; records symlinks WITHOUT following them; skips `node_modules`.
 */
export declare function snapshotTree(root: string, roots?: string[]): Promise<string>
```

Re-run — **Expected: PASS** (9 tests):

```
pnpm --filter create-movp exec vitest run tree-snapshot
```

**6. Write the failing test** `packages/create-movp/test/copier.test.ts`. Note it CONSUMES the shared
`snapshotTree` above — it does not define its own snapshot helper (INTERFACES F2: one implementation):

```ts
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'
import {
  copyFileGuarded, copyTemplate, copyTreeGuarded, readFileGuarded, resolveTargetDir,
} from '../src/copier.ts'

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

  // INTERFACES F1(a): the ROOT itself. `readdirSync` FOLLOWS a symlink, so a symlinked template root
  // would be walked and an external tree read+copied. The root must be lstat'd BEFORE the readdir.
  it('rejects a symlinked template ROOT WITHOUT reading through it', () => {
    const external = join(work, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'secret.ts'), 'ssh-key\n')
    const rootLink = join(work, 'linked-template') // templates/crm-lite -> /external/dir
    symlinkSync(external, rootLink)
    const target = join(work, 'out-root')
    expect(() => copyTemplate({ templateDir: rootLink, targetDir: target, tokens }))
      .toThrow(/template_symlink_rejected/)
    // Nothing was read through the link and nothing was created.
    expect(existsSync(target)).toBe(false)
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

describe('copyTreeGuarded (pack-harness staging — INTERFACES F1)', () => {
  // (a) An external-symlink template file makes the pack FAIL without reading the symlink target.
  it('rejects an external symlink WITHOUT reading its target and copies nothing for it', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    symlinkSync(join(work, 'secret'), join(templateDir, 'notes.ts')) // absolute → outside the tree
    writeFileSync(join(templateDir, 'real.ts'), 'ok\n')
    const dest = join(work, 'staged')
    let msg = ''
    expect(() => {
      try { copyTreeGuarded(templateDir, dest) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    // Path + reason only — the rejected entry name, NEVER the target's secret bytes.
    expect(msg).toContain('notes.ts')
    expect(msg).not.toContain('ssh-key')
    // The symlink target was never read → no dest file carries the secret content.
    expect(existsSync(join(dest, 'notes.ts'))).toBe(false)
  })

  it('copies every regular file byte-for-byte with NO substitution or `.template` rename', () => {
    writeFileSync(join(templateDir, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    mkdirSync(join(templateDir, 'src'))
    writeFileSync(join(templateDir, 'src', 'app.ts'), 'const n = "__PROJECT_NAME__"\n')
    const dest = join(work, 'staged')
    const res = copyTreeGuarded(templateDir, dest)
    expect(res.filesCopied).toBe(2)
    // Verbatim: tokens survive untouched (runtime copyTemplate substitutes later) and NO rename.
    expect(readFileSync(join(dest, 'package.json.template'), 'utf8')).toBe('{"name":"__PROJECT_NAME__"}\n')
    expect(existsSync(join(dest, 'package.json'))).toBe(false)
    expect(readFileSync(join(dest, 'src', 'app.ts'), 'utf8')).toBe('const n = "__PROJECT_NAME__"\n')
  })

  it('rejects an oversized file before buffering it', () => {
    writeFileSync(join(templateDir, 'big.bin'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyTreeGuarded(templateDir, join(work, 'staged')))
      .toThrow(/template_file_too_large/)
  })

  // INTERFACES F1(a): a symlinked staging ROOT is rejected before any readdir — same guard as the
  // runtime copier, because the pack harness points this at `templates/crm-lite` from a shell script.
  it('rejects a symlinked source ROOT WITHOUT reading through it', () => {
    const external = join(work, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'secret.ts'), 'ssh-key\n')
    const rootLink = join(work, 'linked-src')
    symlinkSync(external, rootLink)
    const dest = join(work, 'staged-root')
    expect(() => copyTreeGuarded(rootLink, dest)).toThrow(/template_symlink_rejected/)
    expect(existsSync(dest)).toBe(false)
  })

  // (b) A staging pass writes ONLY into its TEMP destDir — the SOURCE tree is byte-unchanged.
  // Hermetic: a SYNTHETIC source tree under $TMPDIR, snapshotted with the shared `snapshotTree`
  // (`['.']` = the whole tree). Nothing here reads or writes the real repo, and no `git status` /
  // `git checkout` is involved, so a developer's unrelated WIP can never fail it — or be destroyed
  // by it (INTERFACES F1). Task 5's staging-safety test makes the same assertion for the full
  // pack-staging script, also against a synthetic tree.
  it('leaves the SOURCE tree byte-unchanged (writes only into the TEMP destDir)', async () => {
    const src = join(work, 'src-tree')
    mkdirSync(join(src, 'supabase'), { recursive: true })
    writeFileSync(join(src, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    writeFileSync(join(src, 'supabase', 'config.toml'), 'x\n')
    const before = await snapshotTree(src, ['.'])
    copyTreeGuarded(src, join(work, 'staged', 'crm-lite'))
    expect(existsSync(join(work, 'staged', 'crm-lite', 'package.json.template'))).toBe(true)
    expect(await snapshotTree(src, ['.'])).toBe(before)
  })
})

describe('copyFileGuarded (explicit single-file copy — INTERFACES F1(b))', () => {
  it('copies a regular file byte-for-byte and creates the dest parent', () => {
    writeFileSync(join(templateDir, 'package.json'), '{"name":"create-movp"}\n')
    const dest = join(work, 'staged', 'package.json') // parent does not exist yet
    const res = copyFileGuarded(join(templateDir, 'package.json'), dest)
    expect(res.bytesCopied).toBe(23) // '{"name":"create-movp"}\n' — 22 chars + newline
    expect(readFileSync(dest, 'utf8')).toBe('{"name":"create-movp"}\n')
  })

  it('rejects a symlinked SOURCE WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    const src = join(templateDir, 'package.json')
    symlinkSync(join(work, 'secret'), src) // a symlinked package.json in the staged package
    const dest = join(work, 'staged', 'package.json')
    let msg = ''
    expect(() => {
      try { copyFileGuarded(src, dest) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    expect(msg).not.toContain('ssh-key') // path + reason only — never the target's bytes
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects an oversized source before buffering it', () => {
    writeFileSync(join(templateDir, 'big.json'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyFileGuarded(join(templateDir, 'big.json'), join(work, 'staged', 'big.json')))
      .toThrow(/template_file_too_large/)
  })

  it('rejects a non-regular-file source (a directory)', () => {
    expect(() => copyFileGuarded(templateDir, join(work, 'staged', 'nope')))
      .toThrow(/template_not_regular_file/)
  })
})

// INTERFACES round-6 F2: the READ path needs the same guards as the COPY path. 06e's gallery
// validator reads REAL template sources (`seed.sql`, pages) — a raw `readFileSync` there would
// follow a symlinked `seed.sql` straight to ~/.ssh/id_rsa and print/validate its bytes.
describe('readFileGuarded (explicit single-file read — INTERFACES round-6 F2)', () => {
  it('returns the exact bytes of a regular file', () => {
    const bytes = Buffer.from('insert into company (name) values (\'Acme Corp\');\n')
    writeFileSync(join(templateDir, 'seed.sql'), bytes)
    const out = readFileGuarded(join(templateDir, 'seed.sql'))
    expect(out).toEqual(bytes)
    expect(out.toString('utf8')).toContain('Acme Corp')
  })

  it('rejects a symlinked source WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    const src = join(templateDir, 'seed.sql')
    symlinkSync(join(work, 'secret'), src) // a symlinked seed.sql in the template tree
    let msg = ''
    expect(() => {
      try { readFileGuarded(src) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    // The throw fired on the lstat RESULT — the target was never opened, and the error carries the
    // path + reason only, never the target's bytes.
    expect(msg).toContain('seed.sql')
    expect(msg).not.toContain('ssh-key')
  })

  it('rejects a non-regular-file source (a directory)', () => {
    expect(() => readFileGuarded(templateDir)).toThrow(/template_not_regular_file/)
  })

  it('rejects an oversized source before buffering it', () => {
    writeFileSync(join(templateDir, 'big.sql'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => readFileGuarded(join(templateDir, 'big.sql'))).toThrow(/template_file_too_large/)
  })
})
```

Run — **Expected: FAIL** (`Cannot find module '../src/copier.ts'`):

```
pnpm install \
  && pnpm --filter create-movp exec vitest run copier
```

(`pnpm install` links the new workspace package — `packages/*` is globbed by `pnpm-workspace.yaml`.)

**7. Implement** `packages/create-movp/src/copier.ts`:

```ts
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

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

// GOTCHA (INTERFACES F1a) — `readdirSync` FOLLOWS symlinks. Calling it on an unvalidated directory
// walks straight through a symlinked ROOT (`templates/crm-lite -> /external/dir`) and reads a tree
// outside the project. So EVERY directory is lstat'd BEFORE it is readdir'd — the initial root AND
// every recursed subdirectory. `lstatSync` throws ENOENT for a missing dir (loud, same as readdir).
// The rejection carries the PATH only — never the target's contents.
function assertRealDir(absDir: string, rel: string): void {
  const info = lstatSync(absDir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CopierError('template_symlink_rejected', rel)
  }
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
    // lstat BEFORE readdir — the ROOT (relDir === '') and every recursed subdirectory (F1a).
    assertRealDir(absDir, relDir || '.')
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

  // walk() validates the ROOT before its readdir, so a rejected root creates NOTHING. The trailing
  // mkdir only guarantees the (possibly empty) target exists once the source is known-good.
  walk('')
  mkdirSync(opts.targetDir, { recursive: true })
  return { filesWritten, bytesWritten }
}

// VERBATIM guarded tree copy — the SAME untrusted-io guards as `copyTemplate` (lstat-before-read
// symlink rejection, excluded-dir skip, per-file + running-total size bounds, path+reason-only
// errors) but NO token substitution and NO extension allowlist: it copies every regular file
// byte-for-byte. Used by the PACK harness (INTERFACES F1) to materialize `templates/` into a TEMP
// staging tree so the published tarball ships the template source intact (a `package.json.template`
// stays verbatim; the runtime `copyTemplate` above renames + substitutes at `npm create movp` time)
// AND a symlinked template file makes the pack FAIL loudly instead of being packed. Reusing this one
// function keeps the guards shared — the pack script never reimplements them in bash.
export function copyTreeGuarded(srcDir: string, destDir: string): { filesCopied: number; bytesCopied: number } {
  let filesCopied = 0
  let bytesCopied = 0

  const walk = (relDir: string): void => {
    const absDir = join(srcDir, relDir)
    // lstat BEFORE readdir — the ROOT (relDir === '') and every recursed subdirectory (F1a). The pack
    // harness passes `templates/crm-lite` in from a shell script; a symlinked root must FAIL the pack,
    // not silently pack an external tree.
    assertRealDir(absDir, relDir || '.')
    for (const entry of readdirSync(absDir).sort()) {
      const rel = relDir ? join(relDir, entry) : entry
      const abs = join(absDir, entry)
      // lstat BEFORE any stat/read: a symlink in the tree could point at ~/.ssh/id_rsa. The throw
      // fires on the lstat result — the target is NEVER opened or read.
      const info = lstatSync(abs)
      if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', rel)
      if (info.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue
        walk(rel)
        continue
      }
      if (!info.isFile()) continue
      // Bound BEFORE buffering.
      if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', rel)
      if (bytesCopied + info.size > MAX_TOTAL_BYTES) throw new CopierError('template_total_too_large', rel)

      const buf = readFileSync(abs)
      mkdirSync(join(destDir, relDir), { recursive: true })
      writeFileSync(join(destDir, rel), buf) // byte-for-byte; NO substitution, NO `.template` rename
      filesCopied += 1
      bytesCopied += info.size
    }
  }

  // walk() validates the ROOT before its readdir, so a rejected root creates NOTHING in destDir.
  walk('')
  mkdirSync(destDir, { recursive: true })
  return { filesCopied, bytesCopied }
}

// Guarded EXPLICIT single-file copy. The tree walks above are not the only read path: the pack
// harness also copies individual files (`packages/create-movp/package.json`) one at a time. A raw
// `copyFileSync`/`readFileSync` there FOLLOWS a symlink — a symlinked `package.json` would be read
// and packed into the published tarball. Every explicit one-off copy in a staging script goes
// through THIS function (INTERFACES F1b): lstat first, reject symlink/non-regular-file, bound the
// size BEFORE the read, then write. Path + reason only in every error — never the source bytes.
export function copyFileGuarded(src: string, dest: string): { bytesCopied: number } {
  // lstat BEFORE any stat/read — the throw fires on the lstat RESULT, so the target of a symlinked
  // `src` is NEVER opened. `lstatSync` throws ENOENT if `src` is absent (loud, not silent).
  const info = lstatSync(src)
  if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', src)
  if (!info.isFile()) throw new CopierError('template_not_regular_file', src)
  // Bound BEFORE buffering: an oversized file is rejected without being read into memory.
  if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', src)

  const buf = readFileSync(src)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf) // byte-for-byte; NO substitution
  return { bytesCopied: buf.length }
}

// Guarded EXPLICIT single-file READ — the read-only half of `copyFileGuarded` (INTERFACES round-6 F2).
// Copying is not the only read path: 06e's `scripts/check-template-gallery.ts` READS real template
// sources (`seed.sql`, every Astro page) to validate them. A raw `readFileSync` there FOLLOWS a
// symlink — a symlinked `seed.sql -> ~/.ssh/id_rsa` would be read (and its bytes surfaced in a
// validation error) by the very tool that is supposed to police the templates. A guard on the copy
// path but not the read path is not a guard. Every explicit one-off read of a template source goes
// through THIS function; callers do `.toString('utf8')`.
export function readFileGuarded(src: string): Buffer {
  // lstat BEFORE any stat/read — the throw fires on the lstat RESULT, so the target of a symlinked
  // `src` is NEVER opened. `lstatSync` throws ENOENT if `src` is absent (loud, not silent).
  const info = lstatSync(src)
  if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', src)
  if (!info.isFile()) throw new CopierError('template_not_regular_file', src)
  // Bound BEFORE buffering: an oversized file is rejected without being read into memory.
  if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', src)

  return readFileSync(src) // path + reason in every error above — never these bytes
}
```

**8. `packages/create-movp/src/index.ts`:**

```ts
// The pack-staging scripts (Task 5, and 06e's CI matrix + gallery validator) import `copyTreeGuarded`,
// `copyFileGuarded` and `readFileGuarded` from the BUILT dist — this is the public seam, so all three
// MUST be re-exported here (INTERFACES F1 + round-6 F2).
export {
  copyFileGuarded,
  copyTemplate,
  copyTreeGuarded,
  readFileGuarded,
  resolveTargetDir,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TOKEN_PATTERN,
  type CopyOptions,
} from './copier.ts'
```

Re-run — **Expected: PASS** (9 `snapshotTree` + 4 `resolveTargetDir` + 9 `copyTemplate` +
5 `copyTreeGuarded` + 4 `copyFileGuarded` + 4 `readFileGuarded` = 35 tests across the described
cases). Then typecheck:

```
pnpm --filter create-movp exec vitest run
pnpm --filter create-movp exec tsc --noEmit
```

**9. Commit** (`feat(c6d): create-movp package + untrusted-io-hardened safe copier + shared tree snapshot`).

### Gate (machine-checkable)

```
pnpm --filter create-movp exec vitest run \
  && pnpm --filter create-movp exec tsc --noEmit \
  && test -z "$(grep -rlE '\breadFileSync\(' scripts/tree-snapshot.mjs)"
```

**Expected:** suite green (35 tests); every unsafe input (`..`, bad charset, existing target,
symlink, **symlinked tree ROOT**, oversized file, total-cap, unknown token, unresolved token) throws
its stable code; a binary file is copied byte-identically; `copyTreeGuarded` rejects an external
symlink (entry OR root) without reading its target, copies verbatim (no substitution/rename), bounds
size, and leaves the SOURCE tree byte-unchanged (shared `snapshotTree` over a synthetic tree);
`copyFileGuarded` refuses a symlinked / non-regular / oversized source and copies a regular file
byte-for-byte; `readFileGuarded` refuses the same three and returns the exact bytes of a regular file
(round-6 F2 — the read path is guarded, not just the copy path); `snapshotTree` hashes a multi-chunk
file correctly, detects a one-byte change, records a symlink without following it, emits
**byte-identical** manifests from its `<root>` (stdout) and `<root> <outFile>` forms while still
`exit 2`-ing on a missing `<root>` (round-6 F1), and contains **no `readFileSync`** (the grep must
return empty — it is the bounded-memory pin); typecheck clean. **No test in this task reads or writes
anything under the real repo** (INTERFACES F1): every fixture tree is a `mkdtemp` under `$TMPDIR`.

> The matching **no-unguarded-copy grep gate** runs in Task 5, once both consumers of these
> primitives exist (`src/scaffold.ts` from Task 3 and `stage-create-movp.mjs` from Task 5).

---

## Task 3 — `create-movp` scaffolder orchestration + CLI

Wire the copier into the full flow: resolve target → copy → materialize the platform bundle (06a) →
print bootstrap steps; add the prompting CLI bin. **Codegen is NOT run inline** — the scaffolder only
COPIES files + materializes the platform bundle, then prints the post-install `npm install` →
`npm run codegen` steps (INTERFACES F2: the scaffold's `@movp/*` deps do not exist until `npm install`
runs, so `tsx` cannot import `movp.config.mjs`/`schema.ts` at scaffold time).

### Files

- **Create:** `packages/create-movp/src/scaffold.ts`
- **Create:** `packages/create-movp/src/cli.ts`
- **Modify:** `packages/create-movp/src/index.ts` (export `scaffold`)
- **Test (create):** `packages/create-movp/test/scaffold.test.ts`

### Interfaces

- **Consumes (exact signatures):**
  - 06a: `import { verifyPlatformArtifact } from '@movp/platform'` — `verifyPlatformArtifact(dir: string): void`.
  - The scaffolder does NOT consume `@movp/codegen`'s `generate()` and does NOT import the scaffold's
    `movp.config.mjs`/`schema.ts` at scaffold time (INTERFACES F2). Project codegen runs POST-install
    via the scaffold's own `npm run codegen` (`bin/codegen.mjs`, Task 4), using the project's installed
    `tsx` + `@movp/codegen`.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // movp.config.mjs is COPIED verbatim; the scaffolder never imports it (codegen is post-install, F2).
  writeFileSync(join(dir, 'movp.config.mjs'),
    'export const schema = { collections: [], events: [], projectCollections: [], platformCollections: [] }\n')
}

describe('scaffold', () => {
  it('copies the template + materializes the platform bundle, and DEFERS codegen to bootstrap (install → codegen)', async () => {
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
    // F2: codegen did NOT run inline — no manifest and no project baseline migration were emitted.
    expect(existsSync(join(res.targetDir, 'movp.schema.json'))).toBe(false)
    expect(existsSync(join(res.targetDir, 'supabase', 'migrations', '20260715000000_movp_generated.sql'))).toBe(false)
    // bootstrap sequences install BEFORE codegen (the contract Task 5's gate follows).
    const install = res.bootstrap.indexOf('npm install')
    const codegen = res.bootstrap.indexOf('npm run codegen')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(codegen).toBeGreaterThan(install)
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
import { lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifyPlatformArtifact } from '@movp/platform'
import { copyFileGuarded, copyTemplate, resolveTargetDir } from './copier.ts'

export interface ScaffoldOptions {
  templateDir: string
  parentDir: string
  projectName: string
  workspaceId: string
  platformArtifactDir: string
}

// `async` is retained so a thrown `verifyPlatformArtifact` surfaces as a rejected promise for the
// unit test's `.rejects.toThrow`; there is no inline `await` (codegen is deferred to bootstrap, F2).
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
  //    `platformArtifactDir` is the platform package's `dist/` (contains migrations/ + manifest.json),
  //    resolved by the CLI via import.meta.resolve('@movp/platform/package.json') — see Step 4 (F1).
  verifyPlatformArtifact(opts.platformArtifactDir)
  const migrationsDir = join(targetDir, 'supabase', 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
  const srcMigrations = join(opts.platformArtifactDir, 'migrations')
  for (const name of readdirSync(srcMigrations).sort()) {
    if (!name.endsWith('.sql')) continue
    const abs = join(srcMigrations, name)
    // A symlinked migration is an ARTIFACT defect → the 06a code, not a copier code (the client
    // remedy is "re-install @movp/platform", not "fix your template"). lstat BEFORE any read.
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`platform_artifact_invalid: migration is a symlink: ${name}`)
    // Never a raw `copyFileSync` (INTERFACES F1b): copyFileGuarded re-lstats and, crucially, bounds
    // the size BEFORE buffering, so an oversized artifact cannot OOM the scaffolder.
    copyFileGuarded(abs, join(migrationsDir, name))
  }

  // 3. Codegen is NOT run here (INTERFACES F2). The scaffold's `@movp/*` deps + `tsx` do not exist
  //    until `npm install` runs, so the project baseline + movp.schema.json are emitted post-install
  //    by the scaffold's own `npm run codegen` (bin/codegen.mjs, Task 4). Bootstrap prints that step.
  const bootstrap = [
    `cd ${opts.projectName}`,
    'npm install',
    'npm run codegen',
    'supabase start',
    'supabase db reset',
    'npm run verify-schema-runtime',
    'supabase functions serve --env-file supabase/.env.local',
    'npm run dev',
  ]
  return { targetDir, bootstrap }
}
```

> **F2 gotcha (inline):** the scaffolder MUST NOT `import()` the scaffold's `movp.config.mjs` (which
> re-exports `supabase/functions/_shared/schema.ts`, a `.ts` file resolving `@movp/core-schema`) or run
> `generate()` at scaffold time. At scaffold time the target's `node_modules` is empty — `npm install`
> has not run yet — so tsx cannot load `@movp/*` and codegen would throw a missing-dependency error.
> Codegen is deferred to the printed `npm run codegen`, which runs under the project's installed tsx +
> `@movp/codegen`.

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
import { scaffold } from './scaffold.ts'

const TEMPLATES = ['crm-lite'] as const
type TemplateName = (typeof TEMPLATES)[number]

function bundledTemplateDir(name: TemplateName): string {
  // Templates ship INSIDE the create-movp tarball (package.json "files": ["dist","templates"]).
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'templates', name)
}

function bundledPlatformDir(): string {
  // @movp/platform is a runtime dependency of create-movp. Resolve it via the package.json export
  // (INTERFACES F1: `exports` includes "./package.json"; NEVER "./src/*"), then derive the artifact
  // dir dist/ (which holds migrations/ + manifest.json — see @movp/platform publishConfig). Use
  // import.meta.resolve, not createRequire — the bin is native ESM.
  const pkgJsonPath = fileURLToPath(import.meta.resolve('@movp/platform/package.json'))
  return join(dirname(pkgJsonPath), 'dist')
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
- **Create:** `fixtures/verdaccio-crm-lite/stage-create-movp.mjs` (guarded staging — INTERFACES F1)
- **Create:** `fixtures/verdaccio-crm-lite/gate.sh` (executable)
- **Create:** `fixtures/verdaccio-crm-lite/README.md`
- **Consume (do NOT re-create):** `scripts/tree-snapshot.mjs` — the shared bounded snapshot built in
  Task 2. There is exactly ONE snapshot implementation in the repo (INTERFACES F2).
- **Test (create):** `packages/create-movp/test/staging-safety.test.ts` (INTERFACES F1/F2 — staging
  preserves pre-existing untracked files and unrelated WIP edits, **against a SYNTHETIC tree**; the
  suite never writes under the real repo)
- **Modify:** root `package.json` (`devDependencies.verdaccio`, a `check:verdaccio-crm` script)

### Interfaces

- **Consumes:** the whole published bundle (`@movp/*` + `@movp/platform` + `create-movp`), the
  scaffolder (Task 3), the CRM-lite template (Task 4), and the CLI auth contract
  (`SUPABASE_URL` + `SUPABASE_ANON_KEY` + `MOVP_ACCESS_TOKEN`, verified in
  `packages/cli/src/client.ts:78-95`).
- **Produces (the C6d acceptance evidence + the harness shape 06e's CI matrix reuses):** a
  `gate.sh` whose steps — snapshot → stage → snapshot-compare → publish-once → scaffold → install →
  codegen → reset → serve → drive — are the per-template smoke 06e runs across all four templates.
  The `stage` step (guarded staging into a TEMP tree, INTERFACES F1) is the shared,
  source-worktree-safe pack mechanism 06e reuses, and **`scripts/tree-snapshot.mjs`** (Task 2,
  INTERFACES F2) is the shared staging-safety assertion: **"staging changed nothing", never "the tree
  is pristine"**. 06e reuses BOTH — the CLI `node scripts/tree-snapshot.mjs <root> [outFile]` from a
  shell gate (with `<outFile>`, as this gate does, **or** with `<root>` alone and a stdout redirect,
  as 06e's call sites do — both forms emit byte-identical bytes, round-6 F1), or
  `import { snapshotTree } from '<repo>/scripts/tree-snapshot.mjs'` from JS/TS — and must not
  write a second snapshot script, nor reimplement a `git status --porcelain` / `test ! -e templates`
  check: those fail (and tempt an executor to DELETE the work of) a developer who merely has
  unrelated WIP.
- **Neither this gate nor any test in it writes under the real repository** (INTERFACES F1): staging,
  Verdaccio's storage, and the npm auth token all live in `mktemp -d` dirs, and the staging-safety
  test runs against a synthetic tree. There is no `git checkout --` anywhere in 06d — a "prove we
  destroy nothing" check that restores files by discarding uncommitted edits destroys exactly what it
  claims to protect.

### Steps

**1. `fixtures/verdaccio-crm-lite/verdaccio.yaml`** — a minimal registry that proxies npm for
third-party deps but hosts `@movp/*` + `create-movp` locally. `storage` is a `__STORAGE__` placeholder
that `gate.sh` renders to a path inside its `mktemp -d` work dir: a relative `./storage` resolves next
to this config file and would make the registry write **into the repository** (INTERFACES F1 — the
gate writes nothing under the worktree, so there is also nothing for a cleanup step to delete):

```yaml
storage: __STORAGE__
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

**1b. `fixtures/verdaccio-crm-lite/stage-create-movp.mjs`** — the guarded pack-staging script
(INTERFACES F1). It builds a `create-movp` PUBLISH tree in a caller-supplied TEMP dir so the source
worktree is never mutated, and materializes `templates/` through the SAME `copyTreeGuarded` the
runtime scaffolder uses (imported from the freshly BUILT `dist/`, so the guards are shared — never
reimplemented in bash). Plain `.mjs` run with `node` (no tsx): the gate builds `create-movp` before
invoking it, so `dist/index.js` exists.

```js
#!/usr/bin/env node
// C6d pack-harness staging (INTERFACES F1): assemble a create-movp publish tree in a TEMP dir. The
// `files` whitelist ships package.json + dist/ + templates/, so those are all we stage.
//
// This script READS and WRITES only paths derived from its two arguments — it never writes under the
// repo — which is exactly what lets the staging-safety test point `<repoRoot>` at a SYNTHETIC tree.
// The guards it applies are always the REAL ones: the dist import below is resolved relative to THIS
// file (fixtures/verdaccio-crm-lite/ → repo root), never relative to `<repoRoot>`.
//
// EVERY read here is guarded — the walks AND the single-file copy (F1a + F1b):
//   * `copyTreeGuarded` lstats every directory BEFORE readdir (the ROOT included, so a symlinked
//     `templates/crm-lite -> /external/dir` is REJECTED, not followed) and every entry before read.
//   * `copyFileGuarded` lstats `package.json` before reading it — a raw `copyFileSync` would follow
//     a symlinked package.json and pack whatever it points at.
// A symlinked/oversized input throws `template_symlink_rejected` / `template_file_too_large` WITHOUT
// reading the target, failing the pack. This script NEVER writes outside `stagingDir`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// The BUILT create-movp dist re-exports both guards — the exact functions `npm create movp` runs.
// This module path is fixed relative to THIS script (fixtures/verdaccio-crm-lite/ → repo root).
import { copyFileGuarded, copyTreeGuarded } from '../../packages/create-movp/dist/index.js'

const [repoRoot, stagingDir] = process.argv.slice(2)
if (!repoRoot || !stagingDir) {
  console.error('usage: stage-create-movp.mjs <repoRoot> <stagingDir>')
  process.exit(2)
}
const pkgDir = join(repoRoot, 'packages', 'create-movp')

mkdirSync(stagingDir, { recursive: true })
copyFileGuarded(join(pkgDir, 'package.json'), join(stagingDir, 'package.json'))
copyTreeGuarded(join(pkgDir, 'dist'), join(stagingDir, 'dist')) // own build output — guarded anyway
copyTreeGuarded(join(repoRoot, 'templates', 'crm-lite'), join(stagingDir, 'templates', 'crm-lite'))
console.log(`staged create-movp → ${stagingDir}`)
```

**1c. The staging-safety snapshot is `scripts/tree-snapshot.mjs` — built in Task 2, CONSUMED here.**
Do not create a second one under `fixtures/` (INTERFACES F2: ONE implementation, `lstat`-based,
chunk-streamed, path-sorted, symlinks recorded-not-followed, `node_modules` skipped, content never
printed). `gate.sh` uses its CLI in the two-arg form (`node scripts/tree-snapshot.mjs <root>
<outFile>`) — valid under the `<root> [outFile]` contract, where omitting `<outFile>` emits the same
bytes to stdout instead (round-6 F1); the test below uses its module export
(`snapshotTree(root, roots?)`). 06e consumes this same file.

The invariant it encodes is **"staging changed nothing"**, NOT "the worktree is pristine": a developer
routinely runs this gate with unrelated WIP edits and pre-existing untracked files, and a
`git status --porcelain` / `test ! -e templates` check would falsely fail them — and tempt an executor
to "clean" (i.e. DELETE) their untracked work. So we hash the source subtrees the staging step reads,
BEFORE and AFTER, and require the two manifests to be byte-identical.

**1d. Write the failing test** `packages/create-movp/test/staging-safety.test.ts` (INTERFACES F1/F2).

This pins the corrected invariant AND the corrected method. Staging is exercised against a **synthetic
repo tree in `$TMPDIR`** — seeded with a pre-existing untracked file under `packages/create-movp/
templates/` and a dirty (WIP-edited) tracked template file — because a test that proves "staging
destroys nothing" must not itself write to, or `git checkout --`-restore, the developer's real tree.
The `afterAll` guard is the acceptance criterion: the REAL repo's manifest is byte-identical before
and after the suite, so a dirty `templates/crm-lite/README.md` is provably untouched.

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'

// packages/create-movp/test/ → three levels up is the repo root. NOTHING in this suite ever WRITES
// under it (INTERFACES F1): staging runs against a SYNTHETIC tree in $TMPDIR, and the afterAll guard
// below proves the real worktree is byte-unchanged. There is no `git checkout --` anywhere, because
// there is nothing to restore.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const stageScript = join(repoRoot, 'fixtures', 'verdaccio-crm-lite', 'stage-create-movp.mjs')
const builtCopier = join(repoRoot, 'packages', 'create-movp', 'dist', 'index.js')

const WIP_README = '# crm-lite\n\n<!-- a developer\'s uncommitted WIP edit -->\n'

let work = ''
let synth = ''
let realBefore = ''

beforeAll(async () => {
  // stage-create-movp.mjs imports the BUILT guards. Do NOT build here: a test must not write anywhere
  // under the real repo (F1). The gate command builds first — fail loudly with the command if it did not.
  if (!existsSync(builtCopier)) {
    throw new Error(`missing ${builtCopier} — run: pnpm --filter create-movp build`)
  }
  realBefore = await snapshotTree(repoRoot)
}, 60_000)

// F1 ACCEPTANCE: the real worktree is byte-UNCHANGED by this suite. A developer running it with a
// dirty `templates/crm-lite/README.md` has that WIP edit inside BOTH manifests, so this assertion is
// exactly the promise "the suite never touched your files".
afterAll(async () => {
  expect(await snapshotTree(repoRoot)).toBe(realBefore)
}, 60_000)

// The SYNTHETIC repo staging runs against: the exact layout stage-create-movp.mjs reads
// (<root>/packages/create-movp/{package.json,dist/} + <root>/templates/crm-lite/), seeded with the two
// things the old gate got wrong — a pre-existing UNTRACKED file under packages/create-movp/templates/,
// and a dirty (WIP-edited) tracked template file.
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'movp-staging-safety-'))
  synth = join(work, 'repo')
  const pkg = join(synth, 'packages', 'create-movp')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  mkdirSync(join(pkg, 'templates'), { recursive: true })
  mkdirSync(join(synth, 'templates', 'crm-lite', 'supabase'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), '{"name":"create-movp","version":"0.1.0"}\n')
  writeFileSync(join(pkg, 'dist', 'index.js'), 'export const stub = true\n')
  writeFileSync(join(pkg, 'templates', 'preserve.txt'), 'do not delete me\n')
  writeFileSync(join(synth, 'templates', 'crm-lite', 'README.md'), WIP_README)
  writeFileSync(join(synth, 'templates', 'crm-lite', 'supabase', 'config.toml'), 'project_id = "acme"\n')
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('pack staging (INTERFACES F1/F2 — "staging changed nothing", not "the tree is pristine")', () => {
  it('preserves an untracked file + a WIP edit in the SOURCE tree, and the snapshot gate PASSES', async () => {
    const before = await snapshotTree(synth)
    execFileSync('node', [stageScript, synth, join(work, 'stage')], { stdio: 'pipe' })
    const after = await snapshotTree(synth)

    // The gate's actual assertion: byte-identical manifests → staging MUTATED nothing.
    expect(after).toBe(before)
    // Both the untracked file and the WIP edit survive byte-identical.
    expect(readFileSync(join(synth, 'packages', 'create-movp', 'templates', 'preserve.txt'), 'utf8'))
      .toBe('do not delete me\n')
    expect(readFileSync(join(synth, 'templates', 'crm-lite', 'README.md'), 'utf8')).toBe(WIP_README)
    // …and staging really produced the publish tree — in the TEMP dir ONLY.
    expect(existsSync(join(work, 'stage', 'package.json'))).toBe(true)
    expect(existsSync(join(work, 'stage', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(work, 'stage', 'templates', 'crm-lite', 'README.md'))).toBe(true)
  })

  it('FAILS the pack on a symlinked template file instead of packing its target (F1a)', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    execFileSync('ln', ['-s', join(work, 'secret'), join(synth, 'templates', 'crm-lite', 'notes.ts')])
    let stderr = ''
    expect(() => {
      try {
        execFileSync('node', [stageScript, synth, join(work, 'stage')], { stdio: 'pipe' })
      } catch (err: unknown) {
        stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err)
        throw err
      }
    }).toThrow()
    expect(stderr).toContain('template_symlink_rejected')
    expect(stderr).not.toContain('ssh-key') // path + reason only — never the target's bytes
  })
})
```

Run — **Expected: FAIL** (`Cannot find module .../fixtures/verdaccio-crm-lite/stage-create-movp.mjs`)
until step 1b lands; then **PASS** (2 tests). The build is part of the command, never part of the
test — a test may not write under the repo, and `dist/` is the one thing staging needs:

```
pnpm --filter create-movp build \
  && pnpm --filter create-movp exec vitest run staging-safety
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

# INTERFACES F1 — this gate writes NOTHING under the repository: the staging tree, Verdaccio's
# storage, and the npm auth token all live under $WORK / $CM_STAGE (mktemp -d). So cleanup only ever
# removes temp dirs — it never has to "restore" or delete anything in the worktree.
cleanup() {
  [ -n "${FN_PID:-}" ] && kill "$FN_PID" 2>/dev/null || true
  [ -n "${VERDACCIO_PID:-}" ] && kill "$VERDACCIO_PID" 2>/dev/null || true
  ( cd "$WORK/$PROJECT" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1 ) || true
  rm -rf "$WORK" "${CM_STAGE:-}"
}
trap cleanup EXIT

# 1. Build every publishable dist (tsup) + the platform bundle.
pnpm -w build
pnpm --filter @movp/platform build
pnpm --filter create-movp build
# No unguarded read path may reach an explicit copy (INTERFACES F1b): every one-off file copy in the
# staging script and the scaffolder goes through `copyFileGuarded`, never a raw copyFileSync.
if grep -nE '\b(copyFileSync|readFileSync)\(' \
     "$FIXTURE_DIR/stage-create-movp.mjs" "$REPO_ROOT/packages/create-movp/src/scaffold.ts"; then
  echo "gate: unguarded copyFileSync/readFileSync — use copyFileGuarded (INTERFACES F1b)"; exit 1;
fi
# The snapshot helper must STREAM (INTERFACES F2). A readFileSync-based snapshot OOMs on a large
# untracked file — i.e. it breaks the very gate whose job is to tolerate a dirty worktree.
if grep -nE '\breadFileSync\(' "$REPO_ROOT/scripts/tree-snapshot.mjs"; then
  echo "gate: tree-snapshot must stream (createReadStream + createHash), never readFileSync"; exit 1;
fi

# Stage create-movp into a TEMP publish tree — NEVER mutate the source worktree (INTERFACES F1).
# The staging script materializes templates/ through the SAME guarded copier (`copyTreeGuarded`:
# ROOT-and-subdirectory lstat/symlink-reject, regular-file-only, size-bound) that `npm create movp`
# runs — NOT a raw `cp -R` — so a symlinked template file, or a symlinked template ROOT, FAILS the
# pack instead of being packed into the published tarball.
#
# INTERFACES F2 — the invariant is "STAGING CHANGED NOTHING", not "the tree is pristine". Hash the
# source subtrees staging reads BEFORE and AFTER (with the ONE shared helper, scripts/tree-snapshot.mjs
# — 06e uses this same script) and require byte-identical manifests. Do NOT assert
# `packages/create-movp/templates` is absent or that `git status --porcelain` is empty, and NEVER
# `git checkout --` anything: this gate is run by developers with unrelated WIP and pre-existing
# untracked files, which are legitimate and MUST be preserved (an "assert pristine" gate tempts a
# cleanup that DELETES their work — the exact harm this check claims to prevent).
node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" "$WORK/snapshot-before.txt"
CM_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/movp-create-movp.XXXXXX")"
node "$FIXTURE_DIR/stage-create-movp.mjs" "$REPO_ROOT" "$CM_STAGE"
node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" "$WORK/snapshot-after.txt"
if ! diff -u "$WORK/snapshot-before.txt" "$WORK/snapshot-after.txt"; then
  # The diff prints paths + sha256s only — file CONTENTS are never emitted into the log.
  echo "gate: staging MUTATED the source subtree (paths + hashes above)"; exit 1;
fi

# 2. Start Verdaccio, with its storage rendered into $WORK — a relative `storage:` in the yaml would
#    write into fixtures/ (i.e. into the repo). Nothing this gate creates lives in the worktree.
sed "s#__STORAGE__#$WORK/verdaccio-storage#" "$FIXTURE_DIR/verdaccio.yaml" >"$WORK/verdaccio.yaml"
node "$REPO_ROOT/node_modules/verdaccio/bin/verdaccio" -c "$WORK/verdaccio.yaml" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
for _ in $(seq 1 30); do curl -sf "$REGISTRY/-/ping" >/dev/null 2>&1 && break; sleep 1; done

# 3. Publish the bundle to Verdaccio (a throwaway token; Verdaccio accepts any with $all).
#    The token goes in a TEMP npm userconfig: `npm config set … --location project` would write an
#    .npmrc into the repo (clobbering the developer's) — INTERFACES F1, no writes under the worktree.
export npm_config_registry="$REGISTRY"
export NPM_CONFIG_USERCONFIG="$WORK/npmrc"
printf '//127.0.0.1:4873/:_authToken=fake-token\n' >"$NPM_CONFIG_USERCONFIG"
for pkg in auth cli codegen core-schema domain flows graphql mcp notifications obs platform search; do
  ( cd "$REPO_ROOT/packages/$pkg" && npm publish --registry "$REGISTRY" ) || { echo "publish @movp/$pkg failed"; exit 1; }
done
# create-movp is published from the STAGING tree (holds package.json + dist/ + guarded templates/),
# never from the source worktree.
( cd "$CM_STAGE" && npm publish --registry "$REGISTRY" ) || { echo "publish create-movp failed"; exit 1; }

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

# 6. Codegen runs POST-install (INTERFACES F2 — the scaffolder does NOT run it inline; the project
#    baseline + movp.schema.json are emitted HERE, by the scaffold's own tsx + @movp/codegen). Sequence
#    is install (step 5) → codegen (this step) → db reset (step 7).
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

# 13. Streamable-MCP tools/call over HTTP creates + reads a project collection tool. The MCP server
#     registers tools as `${collection}.list` = `company.list` (verified packages/mcp/src/server.ts:70).
#     Assert the EXACT tool name is present in tools/list BEFORE calling it (not a loose match).
MCP_LIST="$(curl -sS "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$MCP_LIST" | grep -qF '"company.list"' || { echo "MCP tools/list missing exact tool company.list: $MCP_LIST"; exit 1; }
MCP_CALL="$(curl -sS "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"company.list\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")"
echo "$MCP_CALL" | grep -q 'Acme Corp' || { echo "MCP tools/call company.list failed: $MCP_CALL"; exit 1; }

echo "gate: verdaccio-crm-lite acceptance PASS"
```

> **Executor notes:**
> - The MCP tool name is `company.list` (`${collection}.list`, verified `packages/mcp/src/server.ts:70`).
>   The sample above is correct as written — do NOT rename it at execution time. Step 13 asserts the
>   exact `"company.list"` string is in `tools/list` before the `tools/call`, so a derivation drift
>   fails the gate loudly rather than silently mismatching.
> - The exact GraphQL field name (`companies`) and CLI subcommand flags (`--name`) come from the
>   schema-derived surfaces; `company` has a single-word `name` field specifically so the CLI flag is
>   unambiguously `--name` (no camelCase surprise). Confirm the GraphQL root field with
>   `{ __type(name:"Query"){ fields { name } } }` if the query 404s.

**3. `fixtures/verdaccio-crm-lite/README.md`** — one paragraph: what the gate proves (C6d acceptance),
prerequisites (Docker, supabase, deno, node, npm, psql, `verdaccio` installed), the single command
`bash gate.sh`, the `+200` port-block note, and two sentences on the pack step: it stages `create-movp`
into a TEMP tree via `stage-create-movp.mjs` (INTERFACES F1) — every read guarded, so a symlinked
template file *or a symlinked template root* fails the pack rather than shipping — and it proves that
with a `scripts/tree-snapshot.mjs` before/after content-hash comparison (INTERFACES F2). State
explicitly: **you may run this gate with a dirty worktree.** It asserts staging changed nothing; it
does not require a pristine tree, it writes nothing under the repository (staging tree, registry
storage and npm token all live in `mktemp -d` dirs), and it never deletes or `git checkout --`-reverts
your files.

**4. Add the script + dependency to root `package.json`:**

```json
    "check:verdaccio-crm": "bash fixtures/verdaccio-crm-lite/gate.sh",
```

and (after approval) `"verdaccio": "^6.0.0"` in root `devDependencies`.

**5. Run the staging-safety test, then the gate.** **Expected output** (tail):
`gate: verdaccio-crm-lite acceptance PASS`.

```
pnpm add -Dw verdaccio@^6   # only after approval
pnpm --filter create-movp build   # staging imports the built dist; the TEST never builds (F1)
pnpm --filter create-movp exec vitest run staging-safety
bash fixtures/verdaccio-crm-lite/gate.sh
```

**6. Commit** (`test(c6d): Verdaccio CRM-lite scaffold→install→real-surface acceptance gate`).

### Gate (machine-checkable)

```
pnpm --filter create-movp build \
  && pnpm --filter create-movp exec vitest run staging-safety \
  && bash fixtures/verdaccio-crm-lite/gate.sh
```

**Expected:** exit 0; final line `gate: verdaccio-crm-lite acceptance PASS`. Along the way the gate
asserts: no raw `copyFileSync`/`readFileSync` in the staging script or scaffolder (every explicit copy
is `copyFileGuarded` — F1b); no `readFileSync` in `scripts/tree-snapshot.mjs` (F2 — the snapshot must
stream, so a large untracked file cannot OOM it); the source subtree content-hash snapshot is
**byte-identical before and after staging** (F2 — "staging changed nothing"; a dirty worktree and
pre-existing untracked files under `packages/create-movp/` or `templates/` are preserved and still
PASS); no `file:`/`workspace:`/`link:` specifier and no monorepo-source path in the scaffold or its
lockfile (standalone install); the project baseline + platform migrations are present; `db reset`
green on the isolated `+200` stack; `verify-schema-runtime` prints `"ok":true`; an authenticated HTTP
GraphQL `companies` query, a streamable-MCP `tools/call company.list`, and `npm run movp -- company
create/list` all return the seeded/created `Acme Corp`. (Prerequisites: Docker running; `supabase`,
`deno`, `node`, `npm`, `psql` on PATH; `verdaccio` installed. **The worktree may be dirty.**)

**F1 acceptance (the test suite destroys nothing):** neither the gate nor any test writes under the
repository — staging, the registry storage, the npm token and every fixture tree are `mktemp -d` dirs,
and `git checkout --` appears nowhere in 06d. `staging-safety.test.ts` pins this: it snapshots the
REAL repo in `beforeAll` and asserts a byte-identical manifest in `afterAll`, so a developer who runs
the suite with a dirty `templates/crm-lite/README.md` gets those bytes back untouched. Verify by hand
once, if you like — leave a WIP edit in that README, run the gate command above, and `git diff` it:
the edit is still there, byte-for-byte.

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
