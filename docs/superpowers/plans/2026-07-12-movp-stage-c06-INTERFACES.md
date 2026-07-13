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

## Stable error codes (all parts)

`schema_runtime_mismatch` · `new_generated_delta_required` · `platform_artifact_invalid` ·
`platform_row_delete_forbidden`.
