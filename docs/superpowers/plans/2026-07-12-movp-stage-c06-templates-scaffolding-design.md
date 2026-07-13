# Stage C6 — Use-Case Templates & Scaffolding (Design Spec)

Status: DESIGN (pre-plan). Author: brainstorming session 2026-07-12. Depends on: C1 (OSS
packaging ✅), enriched by C4/C5 (✅) and C7/C8 (later). Supersedes the one-line C6 entry in
`docs/superpowers/plans/2026-07-07-movp-stage-c-oss-roadmap.md` §C6.

## Goal

`npx create-movp` (equivalently `npm create movp`) scaffolds a working, agent-connected product
in minutes; a four-template gallery proves breadth; a Starlight docs site (with a generated DSL
reference) makes the platform learnable. The demo IS the differentiator.

## Locked decisions (from brainstorming)

1. **Whole C6 in one TDD series**, decomposed into four parts (C6a–C6d).
2. **Scaffolded projects depend on published `@movp/*`** (pinned `^0.1.0`). This requires a real
   version bump `0.0.0 → 0.1.0` across the publishable workspace packages.
3. **Verdaccio** provides a hermetic local registry for CI + local dev (pack + publish the
   workspace `@movp/*` and `create-movp`, install into a temp dir with no workspace links).
   The public `npm publish` is a **documented release step**, out of C6's green path (it needs
   `@movp` scope ownership + `NPM_TOKEN`, neither assumed here).
4. **Docs site includes the generated DSL reference** (from a codegen-emitted schema manifest).

## Why this is a productization seam, not a copy tool (current-state grounding)

The MOVP codegen and runtime were built for the monorepo's single, statically-bound schema. A
scaffolded downstream project defines its *own* collections, so the following must change before
any template can work. Each claim is verified against the tree at merge `3cc0496`:

- **Codegen is hardwired to one schema.** `packages/codegen/src/generate.ts:1` does
  `import { schema } from '@movp/core-schema'`; `GenerateOptions` (`generate.ts:38-44`) has
  `root`/`migrationName`/`migrationsDir`/`typesPath`/`deltas` but **no `schema`**; every emit
  (`generate.ts:139,156,161`) uses the module-level `schema`. `root` only redirects output paths.
  A scaffold running `generate()` would emit MOVP's built-in collections, never its own.
- **CLI is hardwired too.** `packages/cli/src/program.ts:3` `import { schema } from '@movp/core-schema'`.
- **MCP and GraphQL builders are already parameterized** — no change needed:
  `buildMcpServer(schema, ctx)` (`packages/mcp/src/server.ts:6`), `buildSchema(schema)`
  (`packages/graphql/src/schema.ts:4`). Their *entrypoints* (edge functions, server startup) must
  supply the project-local schema, which a scaffolded project does by importing its own schema.
- **`createDomain` is a hardcoded per-collection map** — 24 literal `makeCollectionService`
  entries (`packages/domain/src/domain.ts:85+`). A new non-internal collection gets no generic
  service without a hand edit (this is exactly the C5 `external_record` gap fixed in `3aebce8`;
  see [[review-lens-collection-surface-wiring]]).

The seam is therefore: **inject a project-local schema into codegen + CLI + `createDomain` +
runtime entrypoints**, **derive the generic domain tier from `schema.collections`**, **give each
scaffold its own migration lifecycle**, and **emit a versioned schema manifest** the docs consume.

## Architecture — four parts

### C6a — Productization seam (the load-bearing part)

C6a is materially larger than the roadmap one-liner implied: it makes the monorepo's
single-schema, monorepo-pathed runtime consumable by an *installed* downstream project. Six
invariants. The monorepo becomes the first consumer (dogfooding) and must stay 100% green
throughout.

**Invariant 1 — Platform-migration bundle (monolithic, versioned, immutable).**
- The generated baseline is NOT self-sufficient: `20260701000002_movp_generated.sql` references
  `public.workspace` / `public.is_workspace_member` / `public.movp_collections`
  (lines 16/46/82…), created by **38 hand-written non-generated platform migrations** (tenancy,
  RLS helpers, `movp_internal`, jobs queue, `emit_event`, auth, admin, reporting, …). A scaffold
  shipping only its generated baseline cannot `db reset`.
- Ship those 38 as a **versioned, immutable platform-migration bundle** with the published runtime
  (a distributable artifact — a `@movp/platform` package carrying the `.sql` files, or the
  scaffolder materializes them from a published manifest). The project's generated baseline + its
  additive deltas layer ON TOP.
- Gate: a freshly-scaffolded install-only project runs `supabase db reset` to green with **no
  source-repo migration paths**.

**Invariant 2 — Node/Deno project-runtime loader contract.**
- ONE cross-runtime schema-loading contract:
  - **Node** (codegen, CLI): a project-root `movp.config.mjs` that `export`s the project schema
    (built with the `@movp/core-schema` DSL). `movp` (CLI) and `generate()` discover + import it.
  - **Deno** (edge functions): a local `supabase/functions/_shared/schema.ts` + a `deno.json`
    import map resolving `@movp/*` to PUBLISHED packages via `npm:@movp/<pkg>@^0.1.0`. The map
    already uses `npm:` specifiers for third-party deps (`zod`, `jose`, `@supabase/supabase-js`);
    extend the same pattern to `@movp/*`. The monorepo `deno.json` maps `@movp/*` to
    `../../../packages/*/src` — unusable when installed; scaffolds get the published-specifier map.
- `generate({schema})`, `createDomain(ctx,{schema})`, and the CLI accept the loaded schema;
  MCP/GraphQL builders already take `schema` (`server.ts:6`, `schema.ts:4`) — unchanged. Monorepo
  dogfoods by passing its own `@movp/core-schema` schema in; the full existing suite stays green.
- Gate: the Verdaccio fixture **starts actual local GraphQL + MCP edge functions from the scaffold**
  and makes an authenticated GraphQL query and a streamable-MCP `callTool` over HTTP — proving the
  Deno runtime resolves published `@movp/*`. In-process `callTool` is NOT sufficient.

**Invariant 3 — Two-tier domain model.**
- `createDomain(ctx,{schema})` derives a generic `domain.collection(name): CollectionService`
  registry ONLY for collections that are `internal !== true` AND have no explicit custom service.
- Explicit typed custom services (`task`/`content`/`campaign`/`workflow`, `domain.ts:109`) remain
  and **win on name collision** (documented override rule); `internal:true` collections are
  excluded from the generic tier entirely.
- Gate: fixture with a novel public collection + an `internal:true` collection → only the public
  one reaches generic create/list via CLI + GraphQL + MCP.

**Invariant 4 — Immutable-delta codegen (compare-before-write, never-delete).**
- Today `generate()` DELETES unregistered `*_movp_generated.sql` (`generate.ts:133-137`) and
  OVERWRITES every registered delta unconditionally (`generate.ts:153-158`) — which would rewrite an
  applied downstream migration.
- Downstream contract: a schema change is assigned to a **newly-named local delta**; BOTH the
  baseline AND **every existing delta** are compare-before-write / fail-on-drift; codegen NEVER
  deletes generated migrations in a normal run. Ship a project-local forward-only guard in every
  scaffold (parameterized `check-forward-only-migrations.mjs`).
- Gate: scaffold → `db reset` → add a collection → regenerate → assert the baseline AND every prior
  delta are byte-identical, exactly one additive migration was added, and none was removed.

**Invariant 5 — Versioned schema manifest + consistency contract.**
- Codegen emits `movp.schema.json`: `{ manifestVersion, generatorVersion, schemaFingerprint,
  collections:[{name, internal, fields:[{name, type, cardinality, reporting_role, searchable,
  embeddable}], …}] }`, deterministic (stable ordering; fingerprint = stable hash over the
  canonical projection).
- The manifest's canonical field projection MUST match exactly the columns codegen writes to
  `movp_fields` (`emit-sql.ts:11`: collection_name, name, type, label, cardinality, reporting_role,
  searchable, embeddable). Because codegen UPSERTs metadata without deleting stale rows
  (`emit-sql.ts:9`, `on conflict do update`), the emitter MUST additionally **DELETE**
  `movp_fields`/`movp_collections` rows absent from the current schema, so DB metadata matches the
  manifest.
- Consumers: the DSL-reference docs generator (C6d) reads the manifest, NOT erased TS types.
- Gate: manifest snapshot; a `db reset` consistency assertion comparing the manifest projection to
  `movp_fields`; missing / altered / EXTRA(stale) rows each fail with a **stable mismatch error id**.

**Invariant 6 — Capability model: monolithic v1.**
- v1 is monolithic: every scaffold ships the FULL platform (all 38 migrations + all platform
  collections/services per Invariant 1). Templates DIFFER by their added collections + seed + Astro
  pages + which surfaces they showcase — never by subsetting the platform.
- A composable **capability manifest** that gates custom services (task/content/campaign/workflow)
  and validates their required tables is DEFERRED; until then every template's generated GraphQL/MCP
  surface includes the full platform's custom capabilities by design (not a runtime failure).

### C6b — Scaffolder engine + CRM-lite proof

- **`create-movp`** (unscoped package, so `npm create movp` / `npx create-movp` resolve). Prompts
  for template + project name → copies `templates/<name>/` → substitutes tokens → runs codegen with
  the project's schema → prints bootstrap steps (`supabase start`, `pnpm bootstrap`).
- **Safe copier contract** (untrusted-io, see [[untrusted-io-and-resource-bounds]]):
  - Destination must be an **absent** directory, resolved under the requested parent (reject `..`
    traversal in the project name; validate the token charset).
  - `lstat` each template path before read; **reject symlinks**; skip non-regular files.
  - **Bound file size before buffering**; enforce a total-bytes cap.
  - Copy from a **declared allowlist** of source files; **exclude** generated/cache paths
    (`node_modules`, `dist`, `supabase/.branches`, `.turbo`, etc.); **skip binary** files from
    substitution (copy verbatim).
  - Substitute only **declared tokens** in declared UTF-8 files; **fail on unresolved or unknown
    tokens** (no silent passthrough).
- **Standalone install contract:** scaffolded `package.json` pins `@movp/* @^0.1.0`, sets
  `packageManager`, ships a lockfile policy, states Node + Supabase CLI versions, and resolves
  published-package versions. **Agent connectivity defaults to hosted MCP** (streamable HTTP at
  `/functions/v1/mcp`) because `@movp/mcp-bridge` is a private, unpublished workspace package; the
  stdio bridge is documented as optional/separately-installed.
- **CRM-lite** is the first template (showcases the merged C5): contacts/companies/deals
  collections + a segment + an automation + a few Astro pages + seed + README.
- **Verdaccio harness:** pack + publish `@movp/*` (incl. the platform bundle) + `create-movp` to a
  local Verdaccio; scaffold CRM-lite into a temp dir; `npm install` resolves from Verdaccio with
  **no workspace links**.
- Gate (CI template matrix, one template): scaffold → install-from-Verdaccio → codegen → `db reset`
  → **start the scaffold's actual GraphQL + MCP edge functions** → authenticated GraphQL query +
  streamable-MCP `callTool` over HTTP → CLI create/list green; assert the installed graph has no
  `file:`/workspace links. (Per C6a Invariant 2 — in-process `callTool` is insufficient.)

### C6c — Gallery (remaining three templates)

- **Marketing site + blog** (CMS + SEO/AEO + publish scheduling; C7 later adds delivery artifacts),
  **Support desk** (tickets-as-tasks + SLA `due_soon` automations + inbox), **Knowledge base /
  product docs** (embeddable content + hybrid search; C8 later adds RAG). Each is a real standalone
  fixture on the C6a contract: collection defs + seed + Astro pages + README.
- Gate: the CI matrix packs artifacts **once** and runs each of the four templates’
  scaffold → reset → generic-surface smoke.

### C6d — Docs site (Starlight) + DSL-reference generator

- **DSL-reference generator** reads `movp.schema.json` (C6a manifest) → reference pages; drift-proof
  against the DSL.
- Authored content: quickstart, per-template guides, agent-connectivity matrix (C3).
- Gate: docs site builds in CI; manifest ↔ `movp_fields` consistency check green with stable error
  ids on mismatch.

## Acceptance gates (summary)

| Part | Gate |
|---|---|
| C6a | Monorepo green with injected schema; **install-only scaffold `db reset` green with no source-repo paths** (platform bundle); novel-public + internal:true fixture → only public reaches generic CLI/GraphQL/MCP; regenerate keeps baseline **and every delta** byte-identical + one additive migration, none removed; manifest snapshot + `movp_fields` consistency (incl. stale-row deletion) with stable error ids |
| C6b | Scaffold CRM-lite → Verdaccio install (no workspace links) → codegen → `db reset` → **start real GraphQL + MCP edge functions** → authenticated GraphQL + streamable-MCP over HTTP + CLI create/list green; copier rejects absent-target/symlink/oversized/binary/unresolved-token cases |
| C6c | CI matrix over all 4 templates green (pack once) |
| C6d | Docs build in CI; manifest/DB consistency gate |

## Risks / open questions

- **Version bump blast radius.** `0.0.0 → 0.1.0` across publishable packages touches every
  `package.json` + the `check-release-preflight` gate; confirm no in-repo consumer pins `0.0.0`.
- **`@movp` npm scope ownership** is unresolved and gates the *public* publish (not C6 green). Flag
  for the release step; if the scope is unavailable, the scaffolded pin prefix must change.
- **Two-tier collision rules** need an explicit table (which collections are custom vs generic) so
  the derivation is deterministic; enumerate in the C6a plan.
- **Platform-bundle distribution mechanism** is a design decision for the C6a plan: a `@movp/platform`
  package carrying the 38 `.sql` files vs the scaffolder materializing them from a published manifest.
  Pick one and pin how a scaffold consumes it (copied into `supabase/migrations/` at scaffold time,
  ahead of the project baseline).
- **C6a is a heavy phase.** Platform bundle + cross-runtime loader + immutable-delta codegen +
  manifest is a substantial productization effort — larger than the roadmap's "scaffolder" framing.
  The C6a plan may itself need sub-parts (bundle/loader/delta/manifest); size it explicitly.
- **Deno resolution of published `@movp/*`** via `npm:` specifiers needs a smoke of the actual edge
  runtime (not just typecheck) — some `@movp/*` deps (e.g. Node built-ins) may not resolve cleanly
  under Deno's `npm:` compat; validate early in C6a.

## Deferred (not in C6)

- Public `npm publish` workflow + `@movp` scope acquisition (release step, separate).
- Community template submission process; template versioning/upgrade tooling (per roadmap).
- The DSL-reference *generator* is IN; a live interactive schema playground is out.
