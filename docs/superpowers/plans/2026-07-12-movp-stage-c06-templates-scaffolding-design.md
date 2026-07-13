# Stage C6 — Use-Case Templates & Scaffolding (Design Spec)

Status: DESIGN (pre-plan). Author: brainstorming session 2026-07-12. Depends on: C1 (OSS
packaging ✅), enriched by C4/C5 (✅) and C7/C8 (later). Supersedes the one-line C6 entry in
`docs/superpowers/plans/2026-07-07-movp-stage-c-oss-roadmap.md` §C6.

## Goal

`npx create-movp` (equivalently `npm create movp`) scaffolds a working, agent-connected product
in minutes; a four-template gallery proves breadth; a Starlight docs site (with a generated DSL
reference) makes the platform learnable. The demo IS the differentiator.

## Locked decisions (from brainstorming)

1. **Whole C6 in one TDD series**, decomposed into **six parts (C6a–C6f)** — the productization
   seam is large enough that its concerns are split into independently-gateable parts (per review).
2. **Scaffolded projects depend on published `@movp/*`** (pinned `^0.1.0`). This requires a real
   version bump `0.0.0 → 0.1.0` across the publishable workspace packages.
3. **Verdaccio** provides a hermetic local registry for CI + local dev (pack + publish the
   workspace `@movp/*` and `create-movp`, install into a temp dir with no workspace links).
   The public `npm publish` is a **documented release step**, out of C6's green path (it needs
   `@movp` scope ownership + `NPM_TOKEN`, neither assumed here).
4. **Docs site includes the generated DSL reference** (from a codegen-emitted schema manifest).
5. **Monolithic platform, v1.** Every scaffold contains the full MOVP platform; templates *extend*
   it with their own collections. Composable capability-subsetting is deferred.

## Why this is a productization seam, not a copy tool (current-state grounding)

The MOVP codegen and runtime were built for the monorepo's single, statically-bound schema and its
monorepo-relative paths. A scaffolded downstream project defines its *own* collections and runs
from *installed* packages, so the following must change. Each claim is verified against `3cc0496`:

- **Codegen is hardwired to one schema.** `packages/codegen/src/generate.ts:1`
  `import { schema } from '@movp/core-schema'`; `GenerateOptions` has no `schema`; emits
  (`:139,156,161`) use the module-level `schema`. `root` only redirects paths.
- **CLI is hardwired too.** `packages/cli/src/program.ts:3` static `import { schema }`.
- **MCP/GraphQL builders already take `schema`** (`server.ts:6`, `schema.ts:4`) — their entrypoints
  must supply it.
- **`createDomain` is a hardcoded per-collection map** (24 `makeCollectionService`, `domain.ts:85+`);
  a new non-internal collection gets no generic service without a hand edit (C5 `external_record`,
  fixed in `3aebce8`; see [[review-lens-collection-surface-wiring]]).
- **The generated baseline depends on hand-written foundation** (`20260701000002_movp_generated.sql`
  references `public.workspace`/`is_workspace_member`, created by `20260701000001` + 37 other
  non-generated migrations), and **generated deltas are interleaved** with hand migrations (e.g.
  `20260712000002_external_record_guards` alters the table created by the generated
  `20260712000001` delta). So "the platform" is the *whole ordered migration stream*, not a
  separable set.
- **Edge functions resolve `@movp/*` to monorepo source** (`supabase/functions/mcp/deno.json` maps
  `@movp/*` → `../../../packages/*/src`) — unusable in an installed project.

## Architecture — six parts

Dependency order: **C6a → C6b → C6c → C6d → C6e → C6f.** C6a–C6c are the productization seam; the
monorepo becomes their first consumer (dogfooding) and must stay 100% green throughout.

### C6a — Platform release artifact + schema composition

- **One immutable platform release.** Ship the *entire ordered frozen migration stream* at the
  release point (hand + generated, interleaved) as a **`@movp/platform` package** carrying the
  ordered `.sql` files plus an **ordered manifest with per-file digests** (chosen over a squashed
  snapshot: preserves migration history, matches the Verdaccio publish flow, and enables later
  *additive* platform releases), pinned by a `platformVersion` + content digest. The scaffold
  materializes this ahead of any project migration.
- **Schema composition API.** A project schema is `platformSchema + projectExtensions`, not a fresh
  aggregate. The **platform layer owns** platform collections' metadata, events, and migrations;
  the **project layer owns only its extension collections**. Project codegen emits DDL/metadata for
  **extensions only**, never re-emitting or deleting platform objects. To make ownership
  enforceable, `movp_collections`/`movp_fields` gain a **`layer` marker** (`platform` | `project`)
  so codegen can distinguish the two tiers at the row level (consumed by C6c's stale-row rule).
  (Current `defineSchema` produces a single aggregate, `schema.ts:50`, and codegen emits every
  supplied collection, `generate.ts:139` — this part adds the platform/extension split + marker.)
- Gates: (1) a **committed minimal consumer fixture** (installs `@movp/platform` + a tiny
  extension, no scaffolder) runs `db reset` green with **no source-repo paths**; (2) a negative
  test rejects reordered / missing / digest-mismatched platform artifacts; (3) the fixture's
  extension emits only its own DDL while platform tables + metadata stay intact. (C6d later proves
  `create-movp` produces the same fixture shape — C6a must not depend on the scaffolder.)

### C6b — Single cross-runtime schema loader + schema-derived domain surfaces

- **One schema authority.** A single Node-AND-Deno-loadable ESM schema module is the sole source.
  `movp.config.mjs` (Node tooling) **re-exports** it; Deno edge functions import the **same** module.
- **Canonical fingerprint = pure utility, defined here** (not in C6c). A shared pure function hashes
  the canonical schema projection; the `schema_runtime_mismatch` guard hashes the Node- and
  Deno-loaded schemas **directly** and fails **before startup** if they differ — with no dependency
  on the C6c manifest (C6c later *serializes* this same fingerprint). This prevents the split-brain
  where codegen migrates one DB while GraphQL/MCP exposes another.
- **Injection:** `generate({schema})`, `createDomain(ctx,{schema})`, and the CLI accept the loaded
  schema (drop the static imports); MCP/GraphQL builders unchanged. Deno `deno.json` resolves
  `@movp/*` via `npm:@movp/<pkg>@^0.1.0` (the map already uses `npm:` for third-party deps).
- **Two-tier domain:** `createDomain` derives a generic `domain.collection(name)` registry for
  collections that are `internal !== true` AND have no explicit custom service; typed custom
  services (`domain.ts:109`) win on collision; `internal:true` excluded from the generic tier.
- Gates: monorepo green with injected schema; novel-public + `internal:true` fixture → only public
  reaches generic CLI/GraphQL/MCP; a fixture that changes only the Deno-facing schema fails with a
  stable `schema_runtime_mismatch`.

### C6c — Immutable project codegen deltas + schema manifest

- **Immutable deltas.** Today `generate()` deletes unregistered `*_movp_generated.sql`
  (`:133-137`) and overwrites deltas unconditionally (`:153-158`). Downstream contract: a schema
  change → a **newly-named** local delta; baseline AND **every existing delta** are
  compare-before-write / fail-on-drift; codegen **never deletes** generated migrations in a normal
  run. Ship a project-local forward-only guard in every scaffold.
- **Versioned manifest** `movp.schema.json`: `{manifestVersion, generatorVersion, schemaFingerprint,
  collections:[{name, internal, layer, fields:[{name,type,cardinality,reporting_role,searchable,
  embeddable}]}]}`, deterministic. `schemaFingerprint` is the **C6b canonical-projection hash**,
  serialized here (not defined here) so runtime and manifest agree by construction.
- **Consistency contract (ownership-scoped).** The projection matches `movp_fields` columns exactly
  (`emit-sql.ts:11`). Because codegen upserts metadata without deleting stale rows (`emit-sql.ts:9`),
  the emitter MUST additionally **delete only `layer='project'` rows** absent from the current
  project schema — **platform rows (`layer='platform'`) are never touched** by project codegen (per
  C6a). Removing a *platform* field/collection is rejected (it belongs to a platform release), not a
  project-codegen deletion.
- Gates: scaffold → `db reset` → add a collection → regenerate → baseline + **every prior delta**
  byte-identical, exactly one additive migration added, none removed; manifest snapshot; a `db reset`
  consistency assertion where missing / altered / EXTRA(stale) rows each fail with a **stable error id**.

### C6d — Scaffolder engine + CRM-lite Verdaccio proof

- **`create-movp`** (unscoped, so `npm create movp` / `npx create-movp` resolve): prompts for
  template + name → copies `templates/<name>/` → substitutes tokens → materializes the platform
  release → runs project codegen (extensions only) → prints bootstrap steps.
- **Safe copier** ([[untrusted-io-and-resource-bounds]]): destination must be an **absent** dir
  resolved under the parent (reject `..` in the name, validate token charset); `lstat` + reject
  symlinks; **bound size before buffering** + total cap; **allowlist** of source files, exclude
  build/cache paths, **skip binary** from substitution; substitute **declared tokens only**, fail
  on unresolved/unknown tokens.
- **Standalone install contract:** scaffold pins `@movp/* @^0.1.0`, sets `packageManager`, lockfile
  policy, Node + Supabase versions; **agent connectivity defaults to hosted MCP** (`/functions/v1/mcp`)
  since `@movp/mcp-bridge` is private/unpublished (stdio bridge optional).
- **CRM-lite** template (showcases C5): contacts/companies/deals + a segment + an automation + a few
  Astro pages + seed + README.
- Gate: pack + publish `@movp/*` + platform + `create-movp` to Verdaccio → scaffold CRM-lite →
  `npm install` (no workspace links) → codegen → `db reset` → **start the scaffold's real GraphQL +
  MCP edge functions** → authenticated GraphQL query + streamable-MCP `callTool` over HTTP + CLI
  create/list green; assert no `file:`/workspace links; copier rejects the unsafe cases.

### C6e — Gallery (remaining three templates)

- **Marketing site + blog** (CMS + SEO/AEO + publish scheduling; C7 adds delivery later),
  **Support desk** (tickets-as-tasks + SLA `due_soon` automations + inbox), **Knowledge base /
  product docs** (embeddable content + hybrid search; C8 adds RAG later). Each a real standalone
  extension fixture on the C6a–C6d contracts.
- Gate: CI matrix packs artifacts **once** and runs each of the four templates’
  scaffold → reset → real-surface smoke.

### C6f — Docs site (Starlight) + DSL-reference generator

- **DSL-reference generator** reads `movp.schema.json` (C6c manifest) → reference pages; drift-proof.
- Authored content: quickstart, per-template guides, agent-connectivity matrix (C3).
- Gate: docs build in CI; manifest ↔ `movp_fields` consistency gate green with stable error ids.

## Acceptance gates (summary)

| Part | Gate |
|---|---|
| C6a | Committed consumer fixture `db reset` green, no source-repo paths; reordered/missing/digest-mismatch platform artifact rejected; fixture extension emits only its own DDL, platform metadata (`layer='platform'`) byte-intact after removing an extension field |
| C6b | Monorepo green with injected schema; novel-public + internal:true fixture → only public reaches generic CLI/GraphQL/MCP; Deno-only schema change → `schema_runtime_mismatch` before startup, computed by the pure fingerprint utility with **no manifest** |
| C6c | Regenerate keeps baseline + every delta byte-identical, one additive migration, none removed; manifest snapshot + `movp_fields` consistency (incl. stale-row delete) with stable error ids |
| C6d | Scaffold CRM-lite → Verdaccio install (no workspace links) → `db reset` → start real GraphQL + MCP edge fns → authenticated HTTP GraphQL + streamable-MCP + CLI create/list green; copier rejects unsafe inputs |
| C6e | CI matrix over all 4 templates green (pack once) |
| C6f | Docs build in CI; manifest/DB consistency gate |

## Risks / open questions

- **The `layer` marker is itself a platform migration** (C6a): adding `layer` to
  `movp_collections`/`movp_fields` is a new forward-only platform migration that backfills existing
  rows to `layer='platform'`; sequence it into the platform release stream before the C6c stale-row
  rule can rely on it.
- **Deno `npm:@movp/*` resolution** needs an actual edge-runtime smoke (not typecheck): some deps
  (Node built-ins) may not resolve under Deno `npm:` compat — validate early in C6b.
- **Version bump blast radius.** `0.0.0 → 0.1.0` across publishable packages + `check-release-preflight`;
  confirm no in-repo consumer pins `0.0.0`.
- **`@movp` npm scope ownership** gates the *public* publish (not C6 green); if unavailable, the
  scaffold pin prefix changes.

## Deferred (not in C6)

- Composable capability manifest / platform-subsetting (monolithic v1).
- Public `npm publish` workflow + `@movp` scope acquisition (release step).
- Community template submission; template versioning/upgrade tooling.
- Live interactive schema playground (the DSL-reference generator is IN).
