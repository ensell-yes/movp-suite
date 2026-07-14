# Verdaccio CRM-lite acceptance

This fixture proves the C6d publish-to-scaffold contract end to end: every publishable MOVP package is
published to a local Verdaccio, CRM-lite is scaffolded and installed without workspace links, project
codegen and the isolated Supabase reset run, and authenticated CLI, GraphQL, and streamable-MCP
surfaces read the project schema. Run `bash fixtures/verdaccio-crm-lite/gate.sh` with Docker,
Supabase CLI 2.109.1, Deno 2.9.2, Node, npm, psql, and the root Verdaccio dependency installed. The
fixture uses the template's isolated `6452x` port block.

The pack step stages `create-movp` into a temporary tree through
`stage-create-movp.mjs`. Every source read uses the production guarded copier, so a symlinked
template file or root fails rather than being shipped. A before/after
`scripts/tree-snapshot.mjs` content-hash comparison proves staging changed nothing.

You may run this gate with a dirty worktree. It does not require a pristine tree, writes registry
storage, npm credentials, staging output, and the scaffold only under `mktemp -d` directories,
and never deletes or uses `git checkout --` on your files.
