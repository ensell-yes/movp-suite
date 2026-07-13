# C6 — Locked Cross-Part Interface Contract

Authoritative signatures/artifacts that cross C6a–C6f boundaries. **Every plan MUST use these
exact names/shapes; no part invents a cross-part API.** Grounded in the tree at `3cc0496`.
Companion to the design spec `2026-07-12-movp-stage-c06-templates-scaffolding-design.md`.

## Six plans (one file each), dependency order

| Plan file | Part | Depends on |
|---|---|---|
| `2026-07-12-movp-stage-c-06a-platform-release.md` | Platform release artifact + schema composition + `layer` marker | — |
| `2026-07-12-movp-stage-c-06b-schema-loader-domain.md` | Cross-runtime schema loader + fingerprint + two-tier domain | 06a |
| `2026-07-12-movp-stage-c-06c-codegen-deltas-manifest.md` | Immutable project deltas + schema manifest + consistency | 06a, 06b |
| `2026-07-12-movp-stage-c-06d-scaffolder-crmlite.md` | `create-movp` + safe copier + CRM-lite + Verdaccio proof | 06a–c |
| `2026-07-12-movp-stage-c-06e-gallery.md` | Marketing/Support/KB templates + 4-way CI matrix | 06d |
| `2026-07-12-movp-stage-c-06f-docs-dsl.md` | Starlight docs + DSL-reference generator | 06c |

## Layer marker (06a)

- `movp_collections` and `movp_fields` gain `layer text not null default 'platform'` via a NEW
  forward-only platform migration `20260713000001_metadata_layer.sql` (backfills existing rows to
  `'platform'`). Allowed values: `'platform' | 'project'`.

## Schema composition (06a)

- `@movp/core-schema`: `defineSchema({ extends?: MovpSchema, collections, events })`. When `extends`
  is set, the result carries every collection tagged `layer: 'project'` for locally-declared
  collections and `layer: 'platform'` for inherited ones. `MovpSchema.collections` includes both;
  `schema.projectCollections` / `schema.platformCollections` are derived views.
- `CollectionDef` gains `layer: 'platform' | 'project'` (defaults `'platform'` for a non-`extends`
  schema — i.e. the monorepo).

## Canonical metadata projection + fingerprint (06b — pure, in `@movp/core-schema`)

- `metadataProjection(schema: MovpSchema): { collections: CollectionMeta[]; fields: FieldMeta[] }`
  where `CollectionMeta = { name, label, label_plural, workspace_scoped, layer }` and
  `FieldMeta = { collection_name, name, type, label, cardinality, reporting_role, searchable,
  embeddable, layer }` — EXACTLY the DB-compared columns (`emit-sql.ts:7,11`). Deterministic order:
  collections by name, fields by (collection_name, name).
- `schemaFingerprint(schema: MovpSchema): string` — sha256 hex over the canonical JSON of
  `metadataProjection(schema)`. Pure. Consumed by 06b's runtime guard AND serialized by 06c.
- `internal` is NOT in the projection (manifest-only runtime metadata, not DB-compared).

## Schema injection (06b)

- `generate(options: { schema: MovpSchema; ... })` — `packages/codegen/src/generate.ts` gains a
  required `schema`; the module-level `import { schema }` is removed as the source (callers pass it).
- `createDomain(ctx: DomainCtx, opts: { schema: MovpSchema; embedder?: EmbeddingProvider }): Domain`
  — gains `schema`; derives `domain.collection(name: string): CollectionService` for collections
  with `internal !== true` AND no explicit custom service. `Domain.collection` is the generic
  accessor; explicit custom services (task/content/campaign/workflow) remain typed properties and
  win on name collision.
- `@movp/cli` program factory accepts `schema` (drop the static `program.ts:3` import).
- Monorepo call sites (`scripts/codegen.ts`, CLI bin, edge functions) pass `schema` from
  `@movp/core-schema` explicitly. MCP/GraphQL builders unchanged (already take `schema`).

## Cross-runtime guard (06b)

- CLI command `movp verify-schema-runtime`: Node imports `movp.config.mjs` → `schemaFingerprint`;
  spawns `deno run` with the scaffold's `deno.json` importing the Edge schema module →
  `schemaFingerprint`; compares; exits non-zero with stable code `schema_runtime_mismatch` on
  divergence, `0` on match.

## Project codegen: deltas + manifest (06c)

- Project-local delta registry file `movp.deltas.json`:
  `{ deltas: [{ file: string, collections: string[], events: string[] }] }`.
- `generate({schema})` in a project: baseline + every registered delta are compare-before-write /
  fail-on-drift; NEVER deletes generated migrations. A schema change whose collection/event has no
  owning `movp.deltas.json` entry → exit non-zero with stable code `new_generated_delta_required`,
  ZERO file writes. CLI `movp new-delta <name>` appends a registry entry and emits exactly one
  additive `<ts>_movp_generated_<name>.sql`.
- Project codegen emits DDL/metadata for `layer='project'` collections ONLY; deletes only
  `layer='project'` metadata rows absent from the project schema; never touches `layer='platform'`.
- Manifest `movp.schema.json`:
  `{ manifestVersion: 1, generatorVersion: string, schemaFingerprint: string,
     collections: [{ name, internal, label, workspaceScoped, layer,
       fields: [{ name, type, label, cardinality, reporting_role, searchable, embeddable }] }] }`.
  `schemaFingerprint` === `schemaFingerprint(schema)` from 06b.

## Platform artifact (06a)

- `@movp/platform` package: `migrations/<ordered .sql files>` + `manifest.json`
  `{ platformVersion: string, files: [{ name: string, sha256: string }] }` (files in applied
  order, incl. interleaved `*_movp_generated*.sql`). A `verifyPlatformArtifact(dir): void` util
  (throws on missing/extra/reordered/digest-mismatch) gates materialization.

## Scaffold layout produced by `create-movp` (06d)

- `movp.config.mjs` (re-exports the schema module) · `supabase/functions/_shared/schema.ts` (the one
  schema module, imported by Node re-export AND Deno) · `supabase/config.toml` (port-isolated) ·
  `supabase/migrations/` (platform bundle materialized first, then project baseline) ·
  `movp.deltas.json` · Astro pages · seed · README · `package.json` (`@movp/* @^0.1.0`,
  `packageManager`, hosted-MCP default).

## Ownership notes (reconciliations)

- **emit-sql layer emission (06a owns).** C6a makes the SHARED `emitCollectionSql`/
  `collectionMetadataSql` layer-aware (writes `layer='project'` only for `layer:'project'`
  collections; byte-identical for platform). C6c REUSES it (no duplicate `emitProjectCollectionSql`);
  C6c owns `emitProjectMigration`/`emitProjectDeltaSql` (call the shared emitter, guard
  `platform_row_delete_forbidden`) + `emitProjectMetadataPrune`.
- **Version bump (06d owns).** The `0.0.0 → 0.1.0` bump across publishable `@movp/*` + `@movp/platform`
  happens in C6d (before the Verdaccio publish). 06a's `platformVersion` starts `0.0.0`; 06d bumps it.

## Port-block allocation (no collisions across CI fixtures)

Base monorepo owns `64321/64322/…` (+0, per root CLAUDE.md). Each scaffold/fixture uses a DISTINCT block:

| Block | Owner |
|---|---|
| +100 (`64421/64422…`) | 06a `fixtures/platform-consumer/` |
| +200 (`64521/64522…`) | 06d CRM-lite scaffold + `fixtures/verdaccio-crm-lite/` |
| +300 (`64621/64622…`) | 06e marketing-site |
| +400 (`64721/64722…`) | 06e support-desk |
| +500 (`64821/64822…`) | 06e knowledge-base |

## Approved new dependencies (sign-off recorded 2026-07-12)

Both are APPROVED — the executor does NOT stop on them:
- **`verdaccio`** (06d) — dev-only, CI + local test harness only; never a runtime/shipped dep.
- **`@astrojs/starlight`** (06f) — docs-site framework; pick a version whose peer range accepts the
  repo's `astro@^6`. If NO compatible version exists, STOP and ask (do NOT downgrade Astro).

## Plan review round 1 — locked resolutions (2026-07-12)

- **F1 `@movp/platform` publish mechanics (06a owns, 06d consumes).** The package ships a real JS
  entrypoint via `publishConfig` (`dist/index.js` + `dist/index.d.ts`, built from `src/index.ts`)
  AND its migration artifacts under `dist/migrations/` + `dist/manifest.json`; its `exports` map
  includes `"."`, `"./package.json"`, and `"./migrations/*"`. 06d resolves the package via
  `import.meta.resolve('@movp/platform/package.json')` (or the entry), derives the migrations dir
  from that, and runs `verifyPlatformArtifact` on it. Do NOT export `./src/*` for the installed path.
- **F2 codegen runs POST-install, never inline at scaffold time (06d owns, 06e mirrors).** The
  scaffolder COPIES files and prints/executes the bootstrap `npm install` → `npm run codegen`; it
  MUST NOT `import(movp.config.mjs)`/run `generate()` before `npm install` (the scaffold's
  `@movp/*` deps do not exist yet — tsx cannot fix a missing dependency). Verdaccio gates sequence
  install → codegen → reset. The schema module stays `.ts` (loaded post-install via the project's
  installed `tsx`).
- **F4 `generate({schema})` — schema REQUIRED, no default (06b owns; 06a/06c conform).** No
  `generate(options = {})`; `schema: MovpSchema` is required. Monorepo callers pass it explicitly
  (06b rewires `scripts/codegen.ts` etc.). 06c must NOT reintroduce an optional/defaulted schema;
  06a's "required OR defaulted" language is tightened to REQUIRED.
- **F6 untrusted-I/O at every platform-build read + registry/manifest write (06a, 06c).** Apply
  `lstat`(symlink-reject) + regular-file + size-bound BEFORE reading source migrations/manifests;
  `saveDeltaRegistry`/manifest writes use the safe-write pattern (no symlink follow/overwrite),
  0o600 where the file may hold sensitive refs. Per [[untrusted-io-and-resource-bounds]].
- **F7 real DB-reset consistency gate (06c owns, 06f consumes).** 06c adds a CI gate that runs
  `supabase db reset` then queries live `movp_fields`/`movp_collections` and asserts
  `checkMetadataConsistency` passes (and fails with the stable code on a mutated row). 06f consumes
  THAT established signal — it does not treat a manifest-derived DB state as live evidence.

## Plan review round 2 — locked resolutions (2026-07-13)

- **F1 atomic safe-write (06c owns a shared helper; reused for registry/manifest/generated migrations).**
  `lstat`-then-`writeFile` is TOCTOU-raceable and `writeFile({mode})` does NOT chmod an existing file.
  Use ONE helper: create a `0o600` sibling temp file with EXCLUSIVE creation (`flag: 'wx'`), `lstat`
  the destination and refuse a symlink/non-regular target, then `rename` the temp over the destination
  (atomic). Reuse for `movp.deltas.json`, `movp.schema.json`, and generated migrations.
- **F3 06e gate is fully inlined (06e owns).** Replace "copy + reconcile 06d's gate" prose with the
  COMPLETE `fixtures/verdaccio-gallery/gate.sh` — explicit tarball enumeration/publication for BOTH
  the local-pack path and a prepopulated `ARTIFACTS_DIR`. No "reconcile with 06d" instruction remains.
- **F4 no `as never` (06f owns).** Define a C6f-local typed error (e.g. `DocsConsistencyError` with a
  `DocsConsistencyCode` union that INCLUDES `manifest_fingerprint_mismatch`) — do NOT cast a string
  to `never` on `MetadataConsistencyError`. The stale-manifest path exposes the code through its real type.
- **F2 CLI version — KEPT AS `version: latest` (pushback, not a defect).** All existing CI jobs use
  `supabase/setup-cli@v2` `version: latest` (a deliberate C1 fix: an older pinned CLI rejected the repo's
  newer `config.toml` keys). C6 jobs MATCH `latest` — pinning only C6 would create cross-job version skew.
  A repo-wide exact-pin is a separate cross-cutting change, out of C6 scope.

## Plan review round 3 — locked resolutions (2026-07-13)

- **F2 CORRECTED — pin C6 CI to `supabase/setup-cli@v2` `version: 2.109.1`.** SUPERSEDES the round-2
  pushback, which was based on a wrong premise: the existing `integration-smoke` job DOES pin
  `2.109.1` (ci.yml:130) for the same `supabase start`/`db reset`/`functions serve` class of work
  (5 other jobs use `latest`; the repo is mixed). All NEW C6 DB/functions jobs (06c consistency,
  06e matrix) pin `version: 2.109.1` and print+assert `supabase --version` matches.
- **F1 pack harness — never mutate the source worktree (06d + 06e own).** Do NOT
  `rm -rf packages/create-movp/templates` + `cp -R templates/` in-place (destroys untracked work +
  bypasses the safe-copier). Instead materialize templates into a TEMP `create-movp` staging dir
  using the SAME guarded-copy semantics as the scaffolder (lstat/symlink-reject, size-bound), and
  `npm pack` from that staging dir. The source worktree is left unchanged. Test: an external-symlink
  template file makes the pack FAIL without reading it; the worktree is byte-unchanged after a pack.
- **F3 06f approval wording (06f owns).** Global Constraints must state `@astrojs/starlight` approval
  is RECORDED (per INTERFACES) — retain ONLY the astro@^6 peer-compat STOP; remove the
  "stop and request approval" language so a context-poor executor does not halt unnecessarily.

## Plan review round 4 — locked resolutions (2026-07-13)

- **F1 guard the ROOT and every explicit file copy (06d owns primitives; 06e consumes).**
  `copyTreeGuarded` currently `readdir`s `srcDir` BEFORE validating it — a symlinked template ROOT
  (`templates/crm-lite -> /external`) is followed. Fix: `lstat` EVERY directory including the initial
  root before `readdir`; reject symlink/non-dir with `template_symlink_rejected`. Additionally, both
  staging scripts copy `packages/create-movp/package.json` with a raw `copyFileSync` — bypassing the
  guards. Add **`copyFileGuarded(src, dest)`** (lstat-reject symlink/non-regular, size-bound before
  read) in `src/copier.ts` and use it for EVERY explicit file copy in both staging scripts. Per
  [[untrusted-io-and-resource-bounds]]: guards apply on EVERY read path, automatic AND explicit.
- **F2 gates must assert "staging changed nothing", NOT "the tree is pristine" (06d + 06e).**
  Asserting `packages/create-movp/templates` is absent and `git status --porcelain` is empty FALSELY
  fails when a developer has unrelated WIP or pre-existing untracked files (the worktree may be dirty).
  Fix: SNAPSHOT the relevant source subtree (content hashes of `packages/create-movp` + `templates`)
  BEFORE staging and compare AFTER; the gate passes iff the snapshot is byte-identical. Pre-existing
  untracked files and unrelated edits are PRESERVED, not failed on.

## Plan review round 5 — locked resolutions (2026-07-13)

- **F1 (HIGH) tests/verification NEVER touch the real worktree (06d + 06e).** The round-4 F2 tests
  dirty a REAL `templates/*/README.md` and restore with `git checkout -- <file>` — which DISCARDS a
  developer's pre-existing uncommitted edits. The test for "staging destroys nothing" must not itself
  destroy anything. Fix: every staging-safety test and snapshot demonstration runs against a
  **temporary synthetic tree** (`mktemp -d`, seeded with a fake `packages/create-movp/` + `templates/`).
  **NO `git checkout --` anywhere. NO writes under the real repository from any test or gate demo.**
  Acceptance: start with a dirty real README, run the tests/gates, assert its bytes are UNCHANGED.
- **F2 ONE shared bounded snapshot helper (06d owns; 06e consumes).** 06d's `tree-snapshot.mjs`
  `readFileSync`s every file (unbounded — a large untracked file OOMs the very gate that exists to
  tolerate dirty worktrees), while 06e wrote a second, chunk-bounded `snapshot-tree.mjs`. Collapse to
  ONE: `scripts/tree-snapshot.mjs` (06d owns) — `lstat`-based, **chunked/bounded streaming hash**
  (never buffers a whole file), path-sorted manifest, records symlinks WITHOUT following, skips
  `node_modules`, never prints content. 06e imports it; delete the duplicate.

## Plan review round 6 — locked resolutions (2026-07-13)

- **F1 (HIGH) `tree-snapshot.mjs` CLI contract is `<root> [outFile]` (06d owns; 06e consumes).**
  Round-5 collapsed the two snapshot scripts into one but reconciled only the MODULE export
  (`snapshotTree(root, roots?)`), not the CLI. 06d's CLI hard-requires `<root> <outFile>` and
  `process.exit(2)`s without both; all six 06e call sites pass `<root>` only and redirect stdout —
  so every gallery pack/gate/example fails before staging. Both forms have real consumers, so the
  contract is:

  > `node scripts/tree-snapshot.mjs <root> [outFile]` — writes the manifest to `<outFile>` when
  > supplied, otherwise emits it to **stdout**. Missing `<root>` is still `exit 2`.

  Both forms MUST produce byte-identical output. 06d owns the implementation and pins it with a test
  running both forms and `diff`ing them. Lesson (4th drift): consolidating a shared helper reconciles
  the module export AND the CLI — they are two contracts, not one.
- **F2 (MEDIUM) the gallery validator reads template sources through the guards (06d owns the
  primitive; 06e consumes).** `scripts/check-template-gallery.ts` reads the REAL template tree with
  raw `cpSync` (`movp.deltas.json`) and `readFileSync` (`seed.sql`, pages), and dynamically imports
  the schema module — all bypassing the lstat/size guards the staging harness enforces. A guard on one
  read path and not another is not a guard. Fix:
  - **06d adds `readFileGuarded(src: string): Buffer`** to `packages/create-movp/src/copier.ts`
    (lstat BEFORE any stat/read → reject symlink + non-regular-file, size-bound via `lstat.size`
    BEFORE buffering; path + reason in the error, NEVER the bytes) and re-exports it from
    `src/index.ts` alongside `copyTreeGuarded` / `copyFileGuarded`. One implementation, one owner.
  - **06e consumes it**: `copyFileGuarded` for the registry copy, `readFileGuarded` for `seed.sql`
    and every page, and an `lstat`-reject on the schema module BEFORE the dynamic `import()`. Reads
    of files the validator itself just wrote into its `mkdtemp` scratch stay unguarded (it authored
    them; they are not untrusted input).
  - **Gate is behavioural, not a grep.** `check-template-gallery.ts` takes `--templates-dir <dir>`
    (default **`templates`**, the repo root — NOT `packages/create-movp/templates`, which round-3 F1
    forbids materializing in the worktree: it exists only inside the temp staging tree at pack time)
    so the symlink/oversize cases run against a **synthetic `mktemp -d` tree** — per round-5 F1, NO
    writes under the real repo. Assert: a symlinked `seed.sql` / page / schema module is rejected
    without the target being read, and an oversized file is rejected.
  - A grep for `cpSync`/`copyFileSync` in the validator is a **tripwire on the import seam, not the
    proof** — the proof is the behavioural case above. Never grep for the ABSENCE of `readFileSync`:
    the validator legitimately reads back the baseline it just generated into its own `mkdtemp`
    scratch, and that read is guard-exempt by design (it authored those bytes).

## Plan review round 7 — locked resolutions (2026-07-13)

- **F1 (MEDIUM, reliability) the version gate must distinguish "no matches" from "git failed" (06d).**
  `pinnedZeroConsumers()` wraps `execFileSync('git', ['grep', …])` in a bare `catch { return [] }`.
  `git grep` exits **1** for no-match (benign) but **2** for an operational failure (not a repo, git
  absent, unreadable object, bad pathspec) — the catch-all swallows both, so a broken gate reports
  "no 0.0.0 pins" and passes. Fix: `spawnSync`, then discriminate on `status` — `0` → parse matches,
  `1` → no matches, **anything else (or `error`) → throw**, loud. Per [[eight-dimension-review]]
  Reliability: fail hard and loud, never a silent swallow.
  **Also DELETE the throwaway `.catch?.(() => []) ?? []` sketch entirely.** It is not merely fragile:
  `.trim().split('\n').filter(Boolean)` yields an Array, which has no `.catch`, so the expression
  collapses to `[]` and discards *real* hits. A plan's code fences are near-authoritative — an
  executor pastes them. A sample whose own prose says "delete this" must not be in a fence.
- **F2 (MEDIUM, safety) package manifests are read through a guard (06d owns `readJsonGuarded`).**
  The version gate `JSON.parse(readFileSync(pkgPath))`s twelve worktree `package.json` files with no
  `lstat`, no size bound, and no structural validation. A symlinked manifest is followed outside the
  repo — and Node's `JSON.parse` error message **embeds a snippet of the input**, so a symlink to
  `~/.aws/credentials` leaks secret bytes into CI logs via the failure path. Fix: **06d creates
  `scripts/lib/guarded-read.mjs`** exporting `readJsonGuarded(path)` — `lstat` first (reject symlink
  / non-regular), size-bound BEFORE buffering, `JSON.parse` inside a try/catch that throws
  **path + reason ONLY, never the parse error's content-bearing message**, then structurally validate
  (`name`, `version` are strings) before any field is dereferenced. Quarantine-or-throw, never
  dereference an unvalidated shape. Per [[untrusted-io-and-resource-bounds]].
  **This is deliberately NOT the same implementation as `create-movp`'s `readFileGuarded`, and the two
  must not be "consolidated".** `create-movp` is a *published npm package* and cannot import repo-root
  `scripts/`; repo-root gates cannot depend on `create-movp`'s build output (the version gate must run
  before anything is built). Two consumers, two module boundaries — one guard each, same semantics.
- **F3 (NIT) 06e Assumption 10 is stale.** It explains a deviation from an INTERFACES default that
  round-6 already corrected. INTERFACES now says `templates` (repo root); 06e must simply state it
  follows the locked default, not argue against it.

## Plan review round 8 — locked resolutions (2026-07-13)

- **F1 (HIGH — upgraded from the review's MEDIUM — reliability) a `&&` chain must never end in
  `; test $? -eq 1` (06d, and a BAN across all parts).** 06d's Task 1 gate reads
  `node --test … && node check-publishable-versions.mjs && pnpm build … ; test $? -eq 1`. `&&`
  short-circuits and the trailing `test` reads `$?` from whatever ran LAST — so if `node --test` fails
  (exit 1) or the version script finds a REAL 0.0.0 pin (exit 1, per the round-7 exit contract), the
  chain stops and `test $? -eq 1` converts that failure into **exit 0, green**. Reproduced:
  `bash -c 'false && echo B ; test $? -eq 1'` → `0`. The gate is inverted on the exact path it exists
  to guard, which is why this is HIGH, not MEDIUM.
  Fix: **delete the redundant trailing `git grep`** — `check-publishable-versions.mjs` already performs
  that scoped check with correct 0/1/2 status discrimination (round-7 F1); the gate becomes a plain
  `A && B && C` chain with no `$?` arithmetic.
  **Rule for every part — a gate's EXIT CODE must reflect whether the property held.** Three banned
  shapes, all of which pass while the property is violated:
  1. `A && B && C ; test $? -eq 1` — `&&` short-circuits, so the `test` reads the exit of whichever
     command failed. The `assert-this-fails` idiom (`cmd ; test $? -eq N`) may only ever apply to a
     SINGLE command (a TDD "verify it fails" step is the legitimate use; an aggregate gate is not).
  2. `cmd && echo OK || echo FAIL` — **always exits 0**. It *prints* FAIL and *reports* success,
     manufacturing evidence for a property that does not hold.
  3. `test <cond> && echo OK` with no `||` escape — on mismatch the `echo` is skipped, nothing is
     printed, and execution falls through to the next line whose success overwrites `$?`. Its
     correctness depends on being the LAST line, which is not a property an assertion may rely on.

  Write every assertion as an explicit `if ! <cond>; then echo 'FAIL: …' >&2; exit 1; fi`, and put
  `set -euo pipefail` at the top of each verification block.
- **Self-found while fixing F1 (06e, same bug class, safety-critical).** 06e's Task 1 step-1d
  verification used shape 2 for the **symlink-rejection** check — so a BROKEN untrusted-I/O guard (the
  control that stops a template symlink from reading `~/.ssh/id_rsa`) would print
  `FAIL: staging did not reject the symlink` and still exit 0 — and shape 2 *inverted* for the
  snapshot-sensitivity check (a non-sensitive snapshot silently passed). Its `preserve.txt` /
  WIP-README byte-identity checks used shape 3. All rewritten as `if … exit 1`. 06c's `set +e` was
  audited and is CORRECT (it captures `code=$?`, restores `set -e`, then explicitly checks); 06e's
  round-6 `check-template-gallery-guards.sh` was audited and is CORRECT (its `|| true` is deliberate —
  rejection is the expected outcome — and `expect_reject` greps and `exit 1`s).
- **F2 (MEDIUM, observability) the version gate must run in CI (06d).** Task 1 registers
  `check:publishable-versions` and `test:version-gate` in the root `package.json`, but no workflow
  invokes either — `pnpm -w test` runs `turbo run test` and never reaches root-only scripts. The gate
  can regress after Task 1 without blocking a merge, so the safety net exists but is never armed.
  Fix: add both to the C6 CI job (`pnpm test:version-gate` then `pnpm check:publishable-versions`),
  and add a ci.yml-shape assertion to 06d's Task 1 gate so the wiring itself is machine-checked.
- **F3 (LOW, reliability) `readJsonGuarded`'s closed error-code set must cover I/O failure (06d).**
  `lstatSync`/`readFileSync` throw raw `ENOENT`/`EACCES`, escaping the declared closed `manifest_*`
  set (a missing or unreadable publishable manifest is a plausible real state). Wrap each in its own
  bare catch and throw a content-free `manifest_unreadable: <path> cannot be inspected` / `… cannot be
  read`. Keep the reasons DISTINCT from the JSON-parse case's `is not valid JSON` — conflating "cannot
  read" with "not valid JSON" loses the diagnostic. Still throw; never swallow.

## Stable error codes (all parts)

`schema_runtime_mismatch` · `new_generated_delta_required` · `platform_artifact_invalid` ·
`platform_row_delete_forbidden`.
