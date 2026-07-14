# __PROJECT_NAME__

A standalone MOVP CRM for contacts, companies, and deals.

## Quickstart

    npm install
    npm run codegen
    supabase start
    supabase db reset
    npm run verify-schema-runtime
    supabase functions serve --env-file supabase/.env.local
    npm run dev

The local Supabase API is isolated on port `64521`. Set `SUPABASE_ANON_KEY` in
Wrangler before opening the Astro pages. Use `npm run movp -- --help` for the project-aware CLI.

## Codegen

Run project codegen with the project's own bin:

    npm run codegen

**Never run `movp codegen` here.** The installed `movp` bin runs PLATFORM codegen,
which owns a different set of generated migrations; inside a project it refuses with
`project_codegen_use_project_bin` and tells you to use `npm run codegen`. (Same for
`movp migrate` - it runs codegen first.) `npm run codegen`
(`bin/codegen.mjs`) is the single authority for this project's generated baseline,
`supabase/migrations/20260715000000_movp_generated.sql`.

## Changing the schema

Edit `supabase/functions/_shared/schema.ts` and re-run `npm run codegen`.

**Schema changes are ADDITIVE-ONLY in v1.** You can add a collection, a field, or an event. You
**cannot remove** a project collection or event once it is in the generated baseline - codegen throws
`project_schema_removal_unsupported`. There is no prune emitter. If you must drop a
collection, write the `drop table` yourself as a hand-authored migration and keep the
collection out of future generated output; the generator will not emit a destructive statement
against a table that may hold your data.

## Agent connectivity (MCP)

This project talks to agents over the hosted streamable-HTTP MCP endpoint at
`/functions/v1/mcp`, authenticated with a Personal Access Token. There is no stdio bridge
dependency.

