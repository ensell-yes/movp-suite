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

Everything downstream depends on these four invariants. The monorepo itself becomes the first
consumer of the seam (dogfooding): it passes its own `@movp/core-schema` schema in and must stay
100% green.

**Invariant 1 — Schema-loading contract (narrow).**
- `generate(options)` gains `schema: MovpSchema` (required or defaulted to the monorepo schema for
  back-compat): `generate({ schema, root, migrationsDir, typesPath, deltas })`. Drop the static
  import as the *only* source; keep a default so the monorepo's existing `pnpm codegen` is
  unchanged in behavior.
- `packages/cli/src/program.ts` accepts an injected schema (via the CLI entrypoint / a factory),
  removing the static `import { schema }`.
- `createDomain(ctx, { schema, embedder? })` gains `schema`.
- MCP/GraphQL builders are left untouched (already take `schema`). Their **entrypoints** (the
  edge functions in a scaffolded project) import the project schema and pass it.
- **Monorepo dogfoods:** its codegen entry (`scripts/codegen.ts`), CLI bin, and edge functions
  pass `schema` from `@movp/core-schema` explicitly. Gate: the full existing suite stays green.

**Invariant 2 — Two-tier domain model (do NOT wholesale-replace the map).**
- `createDomain` builds a **generic registry** — `domain.collection(name): CollectionService` — for
  each collection that is (a) `internal !== true` AND (b) has no explicit custom service.
- **Explicit typed custom services** (`task`, `content`, `campaign`, `workflow`, …) remain as
  today and **take precedence** on name collision (custom wins; a documented override rule).
- `internal:true` collections are **excluded from the generic tier entirely** — they never reach
  generic CLI/GraphQL/MCP CRUD (matches the existing surface-exclusion contract;
  `packages/core-schema/src/types.ts` `internal` flag).
- Gate: a fixture schema with a novel public collection AND an `internal:true` collection — assert
  the public one reaches generic create/list via CLI + GraphQL + MCP, and the internal one does
  **not**.

**Invariant 3 — Downstream migration lifecycle (concrete).**
- Each scaffold owns an **immutable initial generated baseline** (project-local filename) plus a
  **project-local generated-delta registry** and a **forward-only guard** shipped in the scaffold
  (a copy/parameterization of `scripts/check-forward-only-migrations.mjs` semantics).
- Regenerating in a scaffold: baseline stays **byte-identical**, schema changes emit **additive
  timestamped deltas only**, and the generator **fails on drift** (reuses the existing drift-throw
  at `generate.ts:143-149`, now project-scoped).
- Gate: scaffold → apply baseline (`db reset`) → add a collection → regenerate → assert the
  initial baseline is byte-identical AND exactly one additive migration now exists.

**Invariant 4 — Versioned schema manifest.**
- Codegen emits `movp.schema.json`: `{ manifestVersion, generatorVersion, schemaFingerprint,
  collections: [{ name, internal, fields: [{ name, type, ... }], … }] }`. Deterministic
  (stable ordering, like the existing emitters).
- Consumers: the DSL-reference docs generator (C6d) reads the manifest, NOT erased TS types.
  `movp_fields` (DB metadata) is a **consistency check** against the manifest, not the docs source.
- Gate: manifest snapshot test; a `db reset` consistency assertion that manifest fields match
  `movp_fields`, emitting a stable mismatch error id on divergence.

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
- **Verdaccio harness:** pack + publish `@movp/*` + `create-movp` to a local Verdaccio; scaffold
  CRM-lite into a temp dir; `npm install` resolves from Verdaccio with **no workspace links**.
- Gate (CI template matrix, one template): scaffold → install-from-Verdaccio → codegen → `db reset`
  → generic-surface smoke (create/list via CLI, one GraphQL read, one MCP `callTool`) green; and
  an assertion that the installed graph has no `file:`/workspace links.

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
| C6a | Monorepo suite still green with injected schema; fixture with a novel public collection + an internal:true collection → only public reaches generic CLI/GraphQL/MCP; regenerate keeps baseline byte-identical + one additive migration; manifest snapshot + `movp_fields` consistency |
| C6b | Scaffold CRM-lite → Verdaccio install (no workspace links) → codegen → `db reset` → generic-surface smoke green; copier rejects absent-target/symlink/oversized/binary/unresolved-token cases |
| C6c | CI matrix over all 4 templates green (pack once) |
| C6d | Docs build in CI; manifest/DB consistency gate |

## Risks / open questions

- **Version bump blast radius.** `0.0.0 → 0.1.0` across publishable packages touches every
  `package.json` + the `check-release-preflight` gate; confirm no in-repo consumer pins `0.0.0`.
- **`@movp` npm scope ownership** is unresolved and gates the *public* publish (not C6 green). Flag
  for the release step; if the scope is unavailable, the scaffolded pin prefix must change.
- **Two-tier collision rules** need an explicit table (which collections are custom vs generic) so
  the derivation is deterministic; enumerate in the C6a plan.

## Deferred (not in C6)

- Public `npm publish` workflow + `@movp` scope acquisition (release step, separate).
- Community template submission process; template versioning/upgrade tooling (per roadmap).
- The DSL-reference *generator* is IN; a live interactive schema playground is out.
