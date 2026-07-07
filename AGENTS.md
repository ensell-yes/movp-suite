## Supabase Local Stack Hygiene

- This repo intentionally uses Supabase local ports `64321`/`64322`/`64320`/`64323`/`64324`/`64327`/`64329`.
  Do not revert them to the Supabase defaults as “cleanup” unless you first prove the default ports are free.
- Before changing `supabase/config.toml` ports, run `supabase status` in this repo and check for other local
  Supabase projects already owning default ports, especially `big-wave`, `norcal`, and `atomic`.
- Treat a port remap as environment isolation, not drift. If DB gates start reading a migration history that does
  not belong to this repo, stop and fix the local Supabase target before trusting pgTAP results.
- Storage may be temporarily disabled for pure-Postgres DB gates only when the local storage container healthcheck
  blocks `supabase db reset`. Re-enable storage before CMS asset or frontend e2e work.
- When debugging `scripts/slice-e2e.sh` Edge Functions locally, use the script's env-file pattern:
  `supabase functions serve ... --env-file <file>` with `MOVP_JWT_ISSUER=<API_URL>/auth/v1`.
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

## Phase Completion Signal

- A phase (`app-01` … `app-06`) is DONE only when **every part in its plan series** is executed —
  e.g. Segmentation is 04a **and** 04b **and** 04c **and** 04d, not 04a alone. Executing one part
  and stopping is normal and fine; reporting the *phase* as done when parts are pending is not.
- The authoritative record is the **Stage B EXECUTION STATUS table** in
  `docs/superpowers/plans/README.md`. Update it in the same commit that lands a part, and read it
  before claiming or assuming completion status.
