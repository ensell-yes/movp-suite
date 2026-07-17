## Supabase Local Stack Hygiene

- This repo intentionally uses Supabase local ports `64321`/`64322`/`64320`/`64323`/`64324`/`64327`/`64329`.
  Do not revert them to the Supabase defaults as "cleanup" unless you first prove the default ports are free.
- Before changing `supabase/config.toml` ports, run `supabase status` in this repo and check for other local
  Supabase projects already owning default ports, especially `big-wave`, `norcal`, and `atomic`.
- Treat a port remap as environment isolation, not drift. If DB gates start reading a migration history that does
  not belong to this repo, stop and fix the local Supabase target before trusting pgTAP results.
- Storage may be temporarily disabled for pure-Postgres DB gates only when the local storage container healthcheck
  blocks `supabase db reset`. Re-enable storage before CMS asset or frontend e2e work.
- When debugging `scripts/slice-e2e.sh` Edge Functions locally, use the script's env-file pattern:
  `supabase functions serve --env-file <file>` with `MOVP_JWT_ISSUER=<API_URL>/auth/v1`.
  The installed CLI serves all functions and accepts no positional function-name list.
  Shell-prefixed env vars may not propagate into the edge runtime and can look like JWT/auth defects.
- The integration smoke retries only transient Edge gateway responses (`502`/`503`/`504`), at most three
  attempts, and prints the content-disciplined function log on final failure. Authentication failures are terminal.
- Every `supabase/setup-cli` CI step pins CLI `2.109.1`; `pnpm check:supabase-cli-pins` enforces the
  step-scoped pin and must run before build/typecheck so config parsing cannot drift by job.
- The slice only kills existing local edge-runtime/function processes in CI, or when explicitly run with
  `MOVP_CLEAN_EDGE_RUNTIME=1`; keep that cleanup opt-in locally so other Supabase projects are not disturbed.

## Migration Discipline

- Migrations are forward-only from the freeze baseline in `supabase/.forward-only-migration-baseline`.
  Do not edit, delete, rename, or regenerate an already-merged migration, including
  `20260701000002_movp_generated.sql`; add a new timestamped migration instead.
- The guard is `node scripts/check-forward-only-migrations.mjs` / `pnpm test:forward-only-migrations`.
  It must run in CI. An override (`MOVP_ALLOW_MERGED_MIGRATION_REWRITE=1`) is only for an explicit,
  pre-deploy emergency and must not be set in CI.
- Future schema/codegen changes must either emit additive hand migrations or introduce a new generated-delta
  migration strategy. The original generated migration is frozen as historical deployment input.
- `@movp/platform` publishes the whole ordered migration stream with per-file digests and exact platform-layer
  collection/field counts derived from `metadataProjection(schema)`. Verify the artifact before materializing it;
  `fixtures/platform-consumer/gate.sh` must match those counts exactly before and after project extensions.
- Codegen writes baselines, generated deltas, types, registries, and manifests through the owner-only atomic-write
  helpers. Do not reintroduce direct writes for generated outputs or weaken frozen-file drift refusal.

## Reporting Discipline

- The `reporting` schema is codegen output from a generated delta registered in
  `packages/codegen/src/generate.ts`. Never hand-edit a `*_movp_generated*.sql` file;
  post-freeze emitter changes require a new registry entry and timestamped migration.
- Dashboard reads use member-gated `reporting_*` RPCs with stable `42501` denial and
  date windows clamped to 90 days. The `movp_internal` readers expose counts and bounded
  classifiers only, never payload values.
- GraphQL maps reporting failures to safe structured codes after emitting a correlated,
  actor-attributed, workspace-hashed event. `/admin/reports` requests all families once
  and preserves healthy sections when another root field fails.
- `reporting_bi`, created by the operator-only `reporting.setup_bi_mirror()`, bypasses
  RLS by design and is granted to no application role. Never grant it to `authenticated`
  or `anon`; `supabase/tests/reporting_bi_grants_test.sql` is the boundary audit.

## Phase Completion Signal

- A phase (`app-01` ... `app-06`) is DONE only when **every part in its plan series** is executed -
  e.g. Segmentation is 04a **and** 04b **and** 04c **and** 04d, not 04a alone. Executing one part
  and stopping is normal and fine; reporting the *phase* as done when parts are pending is not.
- The authoritative record is the **Stage B EXECUTION STATUS table** in
  `docs/superpowers/plans/README.md` (and the Stage C table for C phases). Update it in the same
  commit that lands a part, and read it
  before claiming or assuming completion status.

## Agent Connectivity

- Personal Access Tokens are user-scoped credentials. `default_workspace_id` is a CLI home hint,
  not an authorization boundary; MCP, GraphQL, and CLI operations reuse the user's normal RLS.
- The hosted MCP transport is streamable HTTP at `/functions/v1/mcp`. Stdio-only clients use the
  narrow `@movp/mcp-bridge` workspace package with `MOVP_MCP_URL` + `MOVP_PAT`; local gateways may
  additionally require `MOVP_MCP_APIKEY`.
- `mcp-remote@0.1.38` is not supported: repeated local gates intermittently dropped static bearer
  auth, attempted OAuth registration, and could log custom header values. Do not restore it without
  a pinned, repeatable smoke that keeps credentials out of argv and logs.
- Agent-facing auth codes are `missing_token`, `invalid_token`, `expired_token`, and
  `invalid_claims`. A revoked PAT maps to `invalid_token` at every public boundary.
- `pnpm docs:agent-contract -- --out-dir <existing-directory>` atomically exports the authoritative
  `schema.json`, `mcp-tools.json`, and generated `schema-reference.md` from the real schema and MCP
  registry. The deterministic exporter test pins 46 collections, 35 events, and the capability-safe
  176-tool registry for release `0.1.1`.

## Astro Cloudflare Templates

- Astro 6 source configs use `@astrojs/cloudflare/entrypoints/server`. Never point source
  `wrangler.jsonc` at generated `dist/server/entry.mjs` or the removed `dist/_worker.js` layout.
- `astro build` owns `dist/server/wrangler.json` and Wrangler's redirected deploy config; the deploy
  gate is build first, then `wrangler deploy --dry-run`.
- The adapter requires `SESSION` KV. Keep the ID-less binding in source so Wrangler auto-provisions
  it; do not manually create or commit an account-specific namespace id.
- Frontend bindings are the four public vars plus `SESSION`/adapter-generated `ASSETS`. Do not add an
  R2 binding until code has a real runtime consumer. Regenerate binding types after config changes.

## Schema Productization

- `defineSchema({ extends })` is the ownership boundary: a root schema is `platform`, locally
  declared extensions are `project`, and nested composition preserves the inherited layer.
  Downstream codegen emits only `projectCollections` and `projectEvents`; platform objects come
  exclusively from `@movp/platform`.
- V1 project migration generation is additive for collections/events. Collection/event removal
  fails with `project_schema_removal_unsupported`; field mutation/removal fails immutable-file
  comparison. Automatic metadata pruning is deferred until historical definitions are persisted.
- `schemaFingerprint` remains the DB-metadata hash used by manifests. Runtime parity uses
  `runtimeFingerprint`, which additionally covers `internal`, full field semantics, and events.
- Runtime packages receive a `MovpSchema`; they do not import the platform schema internally.
  Monorepo and Edge Function entrypoints import `@movp/core-schema` and inject it into CLI, domain,
  GraphQL, MCP, and flows. Preserve `packages/flows/test/schema-injection.test.ts` and the real-schema
  surface gate when adding a new collection or runtime consumer.
- The schema-derived domain registry, flow injection, and complete surface inventory are pure unit gates.
  Keep them in the independent `c6-surface-wiring` CI job; use `packages/domain/vitest.unit.config.ts`
  rather than coupling these gates to a running Supabase stack or a preceding artifact job.
- Every Edge Function that imports `@movp/domain`, `@movp/flows`, or a schema-aware runtime must map
  `@movp/core-schema` in its own `deno.json`. Keep all five entrypoints in the `deno check` graph gate;
  Node typecheck cannot detect a missing Deno import-map entry.
- `@movp/platform` validates the artifact root and migrations directory with `lstat` before any
  enumeration. Never move a `readdir` ahead of those guards or follow a symlinked migration root.
- `create-movp` copies only guarded, bounded regular files into an absent target and performs declared-token
  substitution without running installs or codegen. A scaffold bootstraps in the explicit order
  `npm install` -> `npm run codegen` -> `supabase start` -> `supabase db reset`.
- Project scaffolds must use `npm run codegen`; the installed `movp codegen` command refuses with
  `project_codegen_use_project_bin` when `movp.deltas.json` is present so platform codegen cannot write into
  a project or its `node_modules` tree.
- `fixtures/verdaccio-crm-lite/gate.sh` is the C6d release boundary: it stages without mutating the source,
  publishes real tarballs to a temporary registry, installs with no workspace links, resets an isolated stack,
  and drives CLI, GraphQL, and MCP over their real runtimes. Keep its network probes and Docker startup retries
  bounded and fail-loud. Any package imported through a Deno subpath must publish that subpath and its built
  artifacts; `pnpm check:packages` pins `@movp/search/gte-small`.
- `@movp/editor-sdk` is the client-safe embeddable rich-text editor (TipTap, permissive-only). It NEVER imports
  `@movp/domain`/`@movp/auth`/`@movp/graphql`/`@supabase`; the host injects `onSave`, maps transport conflicts
  to `{ status: 'conflict' }`, retains `onSaved(revisionId)` for the next expected revision, and receives
  non-destructive refresh/destructive load-latest callbacks from its host. Its `onDirtyChange` signal is
  `docChanged`-gated and protects in-flight edits. The SDK's domain-direct classifier recognizes
  `content_update_conflict` by string shape; the GraphQL/frontend path classifies only the sanitized
  `extensions.code = CONFLICT` contract. `packages/editor-sdk/test/boundary.test.ts` is the seam audit, and the
  required `c7-editor-sdk` CI job runs the complete package suite.
- `@movp/richtext` is the client/server-safe canonical doc-JSON leaf. Domain `prepare()` normalizes rich-text
  before hashing and derives human-only `search_body`; legacy HTML remains literal text pending explicit cleanup.
- The Astro CMS mounts one client-safe `RichTextFieldsIsland` over all rich-text fields and one shared revision.
  It reaches the server only through the bounded `/api/content/[id]/richtext` route, which resolves request-bound
  env/token state at call time, validates the field schema, merges one field, and emits one content-disciplined
  event. Form saves still reload the page, so save rich-text first; the dirty-only `beforeunload` guard protects drafts.

## Task/CMS Agent Contracts

- Generic public-collection MCP and CLI creates accept relation columns as snake-case `<field>_id`
  inputs, and both surfaces expose generic `update` operations. Preserve schema-derived number,
  boolean, JSON, and enum validation in `packages/mcp/src/server.ts` and
  `packages/cli/src/program.ts`; the real-schema surface gate pins the complete tool inventory.
- The published `@movp/cli` executable is built JavaScript and must retain
  `#!/usr/bin/env node`. It must never invoke `npx tsx` or download a runtime on first use;
  `packages/cli/test/bin-runtime-gate.mjs` is the packaged-executable boundary.

- Consumer contracts live in `docs/agents/task-cms-{data-contract,interface-contract,scaffolding}.md` and
  are indexed by `llms.txt`. Keep them aligned with the schema, domain types, MCP registry, and CLI commands;
  `pnpm check:task-cms-contracts` is the drift gate.
- Task/CMS MCP tools return the same result as JSON text and as `{ result }` structured content. Existing tool
  names and JSON-string CMS inputs remain compatible; structured `fieldSchema` and `data` are preferred.
- Agent detail reads are `task.get_detail` and `content.get_detail`; published delivery reads use
  `content.get_published`. All list surfaces preserve opaque `{ items, nextCursor }` pagination.
- Agent content updates pass the revision they read as `expectedRevisionId` (CLI `--expected-revision`). Agent
  task creates reuse `idempotencyKey` after an indeterminate failure.

## Eight-Dimension Review Harness

When asked to review, audit, critique, assess, or score any artifact, score all eight
dimensions: Correctness, Safety, Reliability, Observability, Efficiency, Performance,
Simplicity, and Usability. A ready/approved claim is valid only when the mean clears the
threshold and no individual dimension sits below it.
