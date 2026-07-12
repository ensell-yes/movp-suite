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

## Eight-Dimension Review Harness

When asked to review, audit, critique, assess, or score any artifact, score all eight
dimensions: Correctness, Safety, Reliability, Observability, Efficiency, Performance,
Simplicity, and Usability. A ready/approved claim is valid only when the mean clears the
threshold and no individual dimension sits below it.
