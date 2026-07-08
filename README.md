# MOVP Suite

MOVP Suite is an agent-native, multi-tenant backend platform on Supabase. Define a
collection once and get the Postgres table, RLS policy, GraphQL API, MCP tools, CLI
commands, search, lifecycle events, and automation surface for it.

The current codebase includes the Core platform plus Collaboration, Task, CMS, Campaigns,
Segmentation, and Workflows. Stage C is turning that internal platform into an
open-source package outsiders can clone, run, and extend.

## Status

This repository is pre-1.0. It is intended for local development and review, not as a
hosted production service.

## Requirements

- Node.js 20 or newer
- pnpm 9.12.0
- Docker
- Supabase CLI
- Deno through the Supabase CLI edge-runtime tooling

## Quickstart

The full one-command bootstrap lands in Stage C1. Until then, the verified local flow is:

```sh
pnpm install --frozen-lockfile
supabase start
supabase db reset
pnpm test
pnpm typecheck
bash scripts/slice-e2e.sh
```

Local Supabase ports are intentionally remapped to the 64xxx range to avoid collisions with
other local projects. Do not normalize them to Supabase defaults without proving the default
ports are free.

## Architecture

The system is config-first:

1. Define collections and events in `@movp/core-schema`.
2. Run codegen to emit SQL, RLS, TypeScript types, GraphQL fields, MCP tools, and CLI
   commands.
3. Run migrations against Supabase Postgres.
4. Use the generated and custom surfaces from GraphQL, MCP, CLI, Astro, and edge functions.

The agent surfaces are first-class: MCP tools and CLI commands are generated from the same
schema contract as the database and GraphQL API.

## Development

Read `CLAUDE.md` before making changes. It contains the local stack rules, review harness,
and migration discipline used by this repository.

Useful gates:

```sh
pnpm check:docs
pnpm test
pnpm typecheck
pnpm test:forward-only-migrations
node scripts/check-definer-audit.mjs
bash scripts/check-boundary.sh
```

## License

Apache-2.0. See `LICENSE`.
