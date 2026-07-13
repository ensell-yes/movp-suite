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

## Stable error codes (all parts)

`schema_runtime_mismatch` · `new_generated_delta_required` · `platform_artifact_invalid` ·
`platform_row_delete_forbidden`.
