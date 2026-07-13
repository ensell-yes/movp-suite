# Stage C6e — Gallery (Marketing / Support / Knowledge-Base Templates) + 4-Way CI Matrix — Implementation Plan

**For agentic workers:** REQUIRED SUB-SKILL — load **`superpowers:executing-plans`** before executing.
Implement one task top-to-bottom: run the task's failing gate first, then the minimal
implementation, then re-run to green, then commit. Do NOT skip the machine-checkable gate that closes
each task. This plan is written for a context-poor executor: every code sample is copy-paste-correct
against the tree at branch `docs/stage-c6-templates-scaffolding`. Locked companions (READ FIRST, use
their exact names/shapes): `2026-07-12-movp-stage-c06-INTERFACES.md` and the finalized
`2026-07-12-movp-stage-c-06d-scaffolder-crmlite.md`. Design: `...templates-scaffolding-design.md` §C6e.

## Goal

Prove the platform's breadth with three more standalone template scaffolds on the C6a–C6d contract, and
wire a CI matrix that packs artifacts once and runs all **four** templates (CRM-lite from 06d + these
three) through scaffold → install → codegen → `db reset` → real-surface smoke:

1. **Marketing site + blog** (`templates/marketing-site/`) — CMS + SEO/AEO + publish scheduling.
   Reuses the platform CMS collections; adds `author` + `newsletter_subscriber` project extensions.
2. **Support desk** (`templates/support-desk/`) — tickets-as-tasks + SLA `due_soon` automation + inbox.
   Reuses the platform task + automation collections; adds `support_ticket` + `sla_policy` extensions.
3. **Knowledge base / product docs** (`templates/knowledge-base/`) — embeddable content + hybrid search.
   Reuses the platform content/search collections; adds `kb_article` + `kb_category` extensions.
4. **4-way CI matrix** — a data-driven `scripts/check-template-gallery.ts` local gate (Docker-free) plus
   a CI job that packs `@movp/*` + `@movp/platform` + `create-movp` ONCE and fans out per template to
   scaffold → reset → real-surface smoke, reusing the 06d Verdaccio harness shape.

Each template is a **standalone scaffold** — identical in shape to 06d's CRM-lite (`templates/crm-lite/`):
a `layer:'project'` schema on `extends: platformSchema`, plus the same template-agnostic app shell
(bins, edge functions, deno.json, wrangler, Astro shell) so its real GraphQL + MCP edge functions can be
started and smoked. Only the domain files differ.

## Architecture

- **Template layout (LOCKED — mirrors 06d CRM-lite, `templates/crm-lite/`).** Each `templates/<name>/`
  carries:
  - **Domain-specific (authored here):**
    - `supabase/functions/_shared/schema.ts` — the ONE Node-AND-Deno schema module:
      `defineSchema({ extends: platformSchema, collections: [...] })`, default-exported.
    - `supabase/config.toml` — port-isolated per the INTERFACES "Port-block allocation" table, with
      `project_id = "__PROJECT_NAME__"` (06d copier token). Same smoke-capable shape as CRM-lite
      (`[api]`, `[edge_runtime]`, and `[functions.graphql]`/`[functions.mcp]` `verify_jwt = false`
      enabled — the smoke needs the real edge functions running).
    - `supabase/seed.sql` — a db-reset-safe demo seed; the workspace UUID uses the `__WORKSPACE_ID__`
      token.
    - `movp.deltas.json` — `{ "deltas": [] }` (the project baseline owns the extensions on first
      scaffold; a later collection needs `movp new-delta`, per 06c).
    - `package.json.template` — mirrors CRM-lite's (`name: "__PROJECT_NAME__"`, `@movp/* @^0.1.0`,
      `packageManager`, hosted-MCP default). Named `.template` so the copier renames it to
      `package.json` at scaffold time and pnpm never links it in-repo (06d Task 4 step 11).
    - `README.md` — purpose, Platform-vs-project table, bootstrap commands. Uses `__PROJECT_NAME__` /
      `__WORKSPACE_ID__` tokens where 06d's README does.
    - `src/pages/<domain>/index.astro` — one real page (smoke target, not gate-critical), querying the
      schema-derived generic GraphQL field via the shell's `postGraphql` helper.
  - **Template-agnostic shell (COPIED verbatim from `templates/crm-lite/`, then domain files overwritten):**
    `movp.config.mjs`, `bin/movp.mjs`, `bin/codegen.mjs`, `supabase/functions/mcp/{index.ts,deno.json}`,
    `supabase/functions/graphql/{index.ts,deno.json}`, `supabase/.gitignore`, `tsconfig.json`,
    `astro.config.mjs`, `wrangler.jsonc`, `src/lib/env.ts`, `src/lib/graphql.ts`, `src/layouts/Base.astro`.
    These are byte-identical to CRM-lite (`wrangler.jsonc` already uses the tokens for its `name`/`vars`)
    — so the four scaffolds are smoke-identical except their domain schema, seed, and pages.
- **Local gate = `scripts/check-template-gallery.ts` (NEW, run via `tsx`).** Data-driven over a
  `TEMPLATES` manifest. Per template it (a) imports the schema module and asserts the composition
  (project collections tagged `layer:'project'`, platform collections inherited as `layer:'platform'`,
  a stable 64-hex fingerprint); (b) runs `@movp/codegen`'s project-mode `generate()` twice against a
  temp dir and asserts the project baseline emits ONLY the `layer='project'` tables/metadata, never
  platform infra, and is byte-stable (immutability); (c) structural-greps the seed, page, and manifest
  files (`package.json.template` present, bare `package.json` absent). Docker-free proxy for
  "scaffold → reset"; the true reset + real-surface smoke runs in CI (Task 4).
- **CI matrix (Task 4).** A `pack-artifacts` job packs `@movp/*` + `@movp/platform` + `create-movp`
  ONCE and uploads the tarballs; a `template-smoke` matrix job (`matrix.template:
  [crm-lite, marketing-site, support-desk, knowledge-base]`) `needs:` it, downloads the tarballs, and
  runs the generalized `fixtures/verdaccio-gallery/gate.sh <template>` (derived from 06d's
  `fixtures/verdaccio-crm-lite/gate.sh`) — scaffold → install → codegen → reset → real-surface smoke.

## Tech Stack

- TypeScript (ESM, `.ts` extension imports, `strict: true`, no `any`), pnpm 9 workspace, `tsx`
  `^4.19.0` (already at repo root — `pnpm codegen` / `pnpm seed:demo` run `.ts` via `tsx`).
- `@movp/core-schema` (06a `defineSchema({extends})` + `layer` marker; 06b `schemaFingerprint`),
  `@movp/codegen` (06c project-mode `generate()` + `movp.deltas.json`), `@movp/platform` (06a bundle),
  `create-movp` (06d scaffolder). All at `0.1.0` after 06d Task 1's bump.
- Astro v6 / Cloudflare adapter for the template shell (same versions as `templates/frontend-astro`).
- Supabase CLI local Postgres + Verdaccio for the CI smoke legs.

## Global Constraints

- **Consume 06a–06d exactly; invent no cross-part API.** Use `defineSchema({ extends, collections })`,
  `CollectionDef.layer`, `schema.projectCollections` / `schema.platformCollections`,
  `schemaFingerprint(schema)`, `generate({ schema, migrationsDir, migrationName, deltasRegistryPath, manifestPath })`,
  the `movp.deltas.json` shape, the copier tokens `__PROJECT_NAME__` / `__WORKSPACE_ID__`, and the
  CRM-lite template layout — all verbatim from the INTERFACES + 06d plan.
- **No `any`.** `unknown` + narrowing, or a real type — in `scripts/check-template-gallery.ts` AND every
  Astro page (typed rows only).
- **No new dependencies.** `tsx`, `@movp/*`, Astro, `verdaccio` (06d adds it) already exist in the repo.
- **Templates ship `package.json.template`, never a bare `package.json`.** The copier renames it at
  scaffold time; a committed `package.json` under `templates/*` would make pnpm try to link the
  unpublished `@movp/* @^0.1.0` pins. The gallery gate asserts this per template.
- **Seed must be `db reset`-safe on its own.** `seed.sql` bootstraps its demo workspace with the
  `__WORKSPACE_ID__` token + `workspace_membership` (whose `user_id` has NO FK to `auth.users` — see
  `supabase/migrations/20260701000001_bootstrap_tenancy.sql`), then inserts only project + platform rows
  it fully satisfies. Never reference a row it does not create.
- **Port-block allocation (LOCKED — INTERFACES "Port-block allocation" table).** Base monorepo owns the
  `+0` block; 06a `fixtures/platform-consumer/` owns `+100` (`64421/64422…`); 06d CRM-lite scaffold +
  `fixtures/verdaccio-crm-lite/` own `+200` (`64521/64522…`). This gallery uses:

  | Block | Template | api | db | shadow | pooler | studio | local_smtp | analytics |
  |---|---|---|---|---|---|---|---|---|
  | +300 | `marketing-site` | 64621 | 64622 | 64620 | 64629 | 64623 | 64624 | 64627 |
  | +400 | `support-desk` | 64721 | 64722 | 64720 | 64729 | 64723 | 64724 | 64727 |
  | +500 | `knowledge-base` | 64821 | 64822 | 64820 | 64829 | 64823 | 64824 | 64827 |

- **Stable error codes are owned upstream.** `new_generated_delta_required` /
  `platform_row_delete_forbidden` belong to 06c; this part only *observes* that a well-formed template
  never triggers them.
- **Determinism.** The gallery gate uses temp dirs via `mkdtempSync`, sorted name comparisons, no
  wall-clock timestamps in assertions.

## 06d contract (LOCKED — this plan builds on it)

06d has landed and fixed the template layout, the copier, the tokens, and the Verdaccio harness. This
plan consumes them verbatim; the two facts most load-bearing here:

1. **Tokens.** The copier substitutes exactly `__PROJECT_NAME__` and `__WORKSPACE_ID__` (06d Task 3/4).
   `config.toml` `project_id`, `package.json.template` `name`, `wrangler.jsonc` `name`/`vars`, and the
   `seed.sql` workspace UUID use these tokens. The default `__WORKSPACE_ID__` the CLI offers is
   `33333333-3333-3333-3333-333333333333`, but the COMMITTED template always carries the token.
2. **Smoke harness.** 06d ships `fixtures/verdaccio-crm-lite/gate.sh` (pack/publish ONCE → scaffold →
   install → codegen → reset → serve real GraphQL + MCP edge functions → authenticated HTTP GraphQL +
   streamable-MCP `callTool` + CLI create/list) and the `check:verdaccio-crm` root script. **06d does
   NOT add a CI job** (its acceptance gate is the local `gate.sh`). The 4-way CI matrix is THIS plan's
   Task 4, and it generalizes that gate to a `$TEMPLATE` parameter.

The **generic GraphQL field names are camelCase-plural** of the collection name (`support_ticket` →
`supportTickets`, `kb_article` → `kbArticles`, `author` → `authors`), matching the platform's existing
`contentTypes` / `content` accessors. The pages below use exactly those names.

---

## Task 1 — Marketing-site template + the data-driven gallery gate

Create the gallery gate harness (registering `marketing-site`) and the full marketing-site scaffold.

### Files

- **Create:** `scripts/check-template-gallery.ts`
- **Copy the shell** from `templates/crm-lite/` into `templates/marketing-site/` (the template-agnostic
  files listed in Architecture), then author/overwrite the domain files below.
- **Create/overwrite (domain):**
  `templates/marketing-site/supabase/functions/_shared/schema.ts`,
  `templates/marketing-site/supabase/config.toml`,
  `templates/marketing-site/supabase/seed.sql`,
  `templates/marketing-site/movp.deltas.json`,
  `templates/marketing-site/package.json.template`,
  `templates/marketing-site/src/pages/blog/index.astro`,
  `templates/marketing-site/README.md`.

### Interfaces

- **Consumes (06a):** `defineSchema({ extends, collections })`, `defineCollection`, `f`, and the exported
  monorepo aggregate `schema` (as `platformSchema`) from `@movp/core-schema`; `schema.projectCollections`
  / `schema.platformCollections` / `CollectionDef.layer`. **(06b):** `schemaFingerprint`. **(06c):**
  project-mode `generate({ schema, migrationsDir, migrationName, deltasRegistryPath, manifestPath })`.
  **(06d):** the CRM-lite shell + copier tokens.
- **Platform collections reused (inherited `layer:'platform'`):** `content_item`, `content_type`,
  `content_revision`, `content_seo`, `content_schedule`, `content_publish_event`, `tag`, `asset`.
- **Project extensions (this template owns, `layer:'project'`):** `author`, `newsletter_subscriber`.
- **Produces:** `scripts/check-template-gallery.ts` (consumed unchanged by Tasks 2–4) and the
  `marketing-site` scaffold.

### Steps

**1. Write the gallery gate** `scripts/check-template-gallery.ts`. Data-driven; Tasks 2–3 only append to
`TEMPLATES`. (Runtime foot-gun inlined: import the schema module via a `file://` URL so `tsx` resolves
the workspace `@movp/*` deps the module imports.)

```ts
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generate } from '@movp/codegen'
import { schemaFingerprint, type MovpSchema } from '@movp/core-schema'

interface TemplateSpec {
  name: string
  projectCollections: string[]
  reusesPlatform: string[]
  pages: string[]
}

// Tasks 2 and 3 APPEND their template specs here; nothing else changes.
const TEMPLATES: TemplateSpec[] = [
  {
    name: 'marketing-site',
    projectCollections: ['author', 'newsletter_subscriber'],
    reusesPlatform: ['content_item', 'content_seo', 'content_schedule'],
    pages: ['src/pages/blog/index.astro'],
  },
]

const HEX64 = /^[0-9a-f]{64}$/

function fail(name: string, reason: string): never {
  throw new Error(`template_gallery_invalid: [${name}] ${reason}`)
}

async function loadSchema(dir: string, name: string): Promise<MovpSchema> {
  const modPath = join(dir, 'supabase', 'functions', '_shared', 'schema.ts')
  if (!existsSync(modPath)) fail(name, `missing schema module ${modPath}`)
  // tsx resolves the workspace @movp/* imports this module makes; import by file URL.
  const mod: unknown = await import(pathToFileURL(modPath).href)
  const schema = (mod as { schema?: unknown }).schema
  if (typeof schema !== 'object' || schema === null || !Array.isArray((schema as MovpSchema).collections)) {
    fail(name, 'schema module must export a `schema` MovpSchema')
  }
  return schema as MovpSchema
}

function assertComposition(name: string, schema: MovpSchema, spec: TemplateSpec): void {
  const project = schema.projectCollections.map((c) => c.name).sort()
  if (JSON.stringify(project) !== JSON.stringify([...spec.projectCollections].sort())) {
    fail(name, `projectCollections ${JSON.stringify(project)} !== expected ${JSON.stringify(spec.projectCollections)}`)
  }
  for (const c of schema.projectCollections) {
    if (c.layer !== 'project') fail(name, `project collection "${c.name}" has layer="${c.layer}"`)
  }
  const platformNames = new Set(schema.platformCollections.map((c) => c.name))
  for (const c of schema.platformCollections) {
    if (c.layer !== 'platform') fail(name, `platform collection "${c.name}" has layer="${c.layer}"`)
  }
  for (const req of spec.reusesPlatform) {
    if (!platformNames.has(req)) fail(name, `expected to inherit platform collection "${req}"`)
  }
  const fp = schemaFingerprint(schema)
  if (!HEX64.test(fp)) fail(name, `schemaFingerprint is not 64-hex: ${fp}`)
}

async function assertProjectCodegen(name: string, dir: string, schema: MovpSchema, spec: TemplateSpec): Promise<void> {
  const registrySrc = join(dir, 'movp.deltas.json')
  if (!existsSync(registrySrc)) fail(name, 'missing movp.deltas.json')
  const scratch = mkdtempSync(join(tmpdir(), `movp-tmpl-${name}-`))
  try {
    const migrationsDir = join(scratch, 'supabase', 'migrations')
    const registryPath = join(scratch, 'movp.deltas.json')
    cpSync(registrySrc, registryPath)
    const manifestPath = join(scratch, 'movp.schema.json')
    const baseline = '20260713000200_movp_generated.sql'
    const opts = { schema, migrationsDir, migrationName: baseline, deltasRegistryPath: registryPath, manifestPath }

    await generate(opts) // must NOT throw new_generated_delta_required for a well-formed template
    const first = readFileSync(join(migrationsDir, baseline), 'utf8')
    await generate(opts)
    const second = readFileSync(join(migrationsDir, baseline), 'utf8')
    if (first !== second) fail(name, 'project baseline is not byte-stable across two runs (immutability)')

    for (const c of spec.projectCollections) {
      if (!first.includes(`create table if not exists public.${c} (`)) fail(name, `baseline missing project table ${c}`)
    }
    if (!first.includes("'project')")) fail(name, 'baseline missing layer=project metadata')
    if (first.includes('create table if not exists public.movp_collections')) {
      fail(name, 'baseline re-emits platform metadata infra (must not)')
    }
    for (const platformTable of spec.reusesPlatform) {
      if (first.includes(`create table if not exists public.${platformTable} (`)) {
        fail(name, `baseline re-emits inherited platform table ${platformTable} (must not)`)
      }
    }
    if (!existsSync(manifestPath)) fail(name, 'movp.schema.json manifest not written')
    void readdirSync(migrationsDir)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function assertAssets(name: string, dir: string, spec: TemplateSpec): void {
  const seed = join(dir, 'supabase', 'seed.sql')
  if (!existsSync(seed)) fail(name, 'missing supabase/seed.sql')
  const seedText = readFileSync(seed, 'utf8')
  if (/\.\.\/|\/Code\/supasuite|packages\/[a-z]/.test(seedText)) fail(name, 'seed.sql leaks a source-repo path')
  for (const page of spec.pages) {
    const p = join(dir, page)
    if (!existsSync(p)) fail(name, `missing page ${page}`)
    const text = readFileSync(p, 'utf8')
    if (!/Base\.astro/.test(text)) fail(name, `page ${page} must import the Base layout`)
    if (/[:<]\s*any\b|\bas any\b/.test(text)) fail(name, `page ${page} uses the any type`)
  }
  if (!existsSync(join(dir, 'README.md'))) fail(name, 'missing README.md')
  if (!existsSync(join(dir, 'movp.config.mjs'))) fail(name, 'missing movp.config.mjs')
  if (!existsSync(join(dir, 'supabase', 'config.toml'))) fail(name, 'missing supabase/config.toml')
  // Copier token discipline (06d): package.json.template present, bare package.json absent.
  if (!existsSync(join(dir, 'package.json.template'))) fail(name, 'missing package.json.template')
  if (existsSync(join(dir, 'package.json'))) fail(name, 'committed a bare package.json (must be package.json.template)')
}

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith('--template='))?.split('=')[1]
  const selected = only ? TEMPLATES.filter((t) => t.name === only) : TEMPLATES
  if (only && selected.length === 0) throw new Error(`unknown template: ${only}`)
  for (const spec of selected) {
    const dir = join('templates', spec.name)
    const schema = await loadSchema(dir, spec.name)
    assertComposition(spec.name, schema, spec)
    await assertProjectCodegen(spec.name, dir, schema, spec)
    assertAssets(spec.name, dir, spec)
    console.log(`template-gallery: ${spec.name} OK`)
  }
  console.log(`template-gallery: ${selected.length} template(s) verified`)
}

await main()
```

Run it now — **Expected: FAIL** (`template_gallery_invalid: [marketing-site] missing schema module ...`):

```
pnpm exec tsx scripts/check-template-gallery.ts --template=marketing-site
```

**2. Copy the CRM-lite shell** into the new template, then remove the domain files you will replace:

```
mkdir -p templates/marketing-site
cp -R templates/crm-lite/. templates/marketing-site/
rm -f templates/marketing-site/supabase/functions/_shared/schema.ts \
      templates/marketing-site/supabase/config.toml \
      templates/marketing-site/supabase/seed.sql \
      templates/marketing-site/package.json.template \
      templates/marketing-site/README.md
rm -rf templates/marketing-site/src/pages
```

(`bin/`, the edge functions + `deno.json`, `movp.config.mjs`, `tsconfig.json`, `astro.config.mjs`,
`wrangler.jsonc`, `src/lib/`, `src/layouts/`, `movp.deltas.json`, `supabase/.gitignore` are kept
verbatim — they are template-agnostic. `wrangler.jsonc` already uses the `__PROJECT_NAME__` /
`__WORKSPACE_ID__` tokens; leave it as-is.)

**3. Create the schema module** `templates/marketing-site/supabase/functions/_shared/schema.ts`. The
platform aggregate `schema` is imported and passed as `extends`; local collections carry `layer:'project'`
automatically (06a):

```ts
import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

// Blog author profile. `bio` is embeddable so author content participates in hybrid search.
const author = defineCollection({
  name: 'author',
  label: 'Author',
  labelPlural: 'Authors',
  workspaceScoped: true,
  fields: {
    full_name: f.text({ label: 'Full name', required: true, searchable: true }),
    bio: f.richText({ label: 'Bio', searchable: true, embeddable: true }),
    avatar_url: f.text({ label: 'Avatar URL' }),
    twitter_handle: f.text({ label: 'Twitter handle' }),
  },
})

// Newsletter signup captured from marketing pages.
const newsletterSubscriber = defineCollection({
  name: 'newsletter_subscriber',
  label: 'Newsletter Subscriber',
  labelPlural: 'Newsletter Subscribers',
  workspaceScoped: true,
  fields: {
    email: f.text({ label: 'Email', required: true }),
    status: f.enum(['subscribed', 'unsubscribed'], {
      label: 'Status',
      default: 'subscribed',
      reporting: { role: 'dimension' },
    }),
    source: f.text({ label: 'Source' }),
  },
})

// CMS + SEO/AEO + publish scheduling come from the platform CMS collections (content_item,
// content_type, content_revision, content_seo, content_schedule, content_publish_event, tag, asset)
// inherited via `extends`; this template only adds the two project extensions above.
export const schema = defineSchema({
  extends: platformSchema,
  collections: [author, newsletterSubscriber],
})

export default schema
```

**4. `templates/marketing-site/supabase/config.toml`** — mirror the CRM-lite `config.toml` shape (06d Task
4 step 6) EXACTLY, changing only the ports to the `+300` block and keeping the `__PROJECT_NAME__` token.
Base it on the monorepo `supabase/config.toml` with: `project_id = "__PROJECT_NAME__"`; `[api] port =
64621`; `[db] port = 64622`, `shadow_port = 64620`; `[db.pooler] port = 64629`; `[studio] port = 64623`;
`[local_smtp] port = 64624`; `[analytics] port = 64627`; keep the `[functions.graphql]` /
`[functions.mcp]` `verify_jwt = false` blocks and `[edge_runtime] deno_version = 2`; keep `[db.seed]
sql_paths = ["./seed.sql"]`. (The `+300` values are locked in the Global Constraints port table.)

> **Token gotcha (inline):** `project_id` uses `__PROJECT_NAME__`; the copier's allowlist includes
> `.toml`, so this file IS substituted at scaffold time. Do NOT hardcode a project id.

**5. `templates/marketing-site/supabase/seed.sql`** (db-reset-safe; workspace UUID uses `__WORKSPACE_ID__`;
every FK it references it also inserts):

```sql
-- Marketing-site demo seed. Self-contained: bootstraps the demo workspace (workspace_membership.user_id
-- has no FK to auth.users) then inserts only rows this file fully satisfies. Idempotent.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Marketing Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'a0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

-- Platform CMS: a blog content type (SEO + scheduling attach to items of this type).
insert into public.content_type (id, workspace_id, key, label, field_schema, moderation_policy, approval_policy)
  values ('a1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'blog_post', 'Blog Post', '{"type":"object"}'::jsonb, 'none', 'single')
  on conflict (id) do nothing;

-- Project extensions.
insert into public.author (id, workspace_id, full_name, bio, avatar_url, twitter_handle)
  values ('a2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'Ada Lovelace', 'Writes about analytical engines.', null, 'ada')
  on conflict (id) do nothing;
insert into public.newsletter_subscriber (id, workspace_id, email, status, source)
  values ('a3000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'reader@example.com', 'subscribed', 'homepage')
  on conflict (id) do nothing;
```

**6. `templates/marketing-site/movp.deltas.json`** — `{ "deltas": [] }` (already copied from CRM-lite;
confirm it is present and unchanged).

**7. `templates/marketing-site/package.json.template`** — copy CRM-lite's `package.json.template` (06d Task
4 step 9) verbatim; it already uses `name: "__PROJECT_NAME__"`, `@movp/* @^0.1.0`, `packageManager`, and
carries NO `@movp/mcp-bridge` (hosted-MCP default). No content change is needed beyond the copy.

**8. `templates/marketing-site/src/pages/blog/index.astro`** — one page (smoke target, not gate-critical),
using the CRM-lite shell's `postGraphql` helper + `readServerEnv`. (Platform gotcha inlined: env is read
via `readServerEnv()`, never `process.env` — workerd.)

```astro
---
import Base from '../../layouts/Base.astro'
import { readServerEnv } from '../../lib/env.ts'
import { postGraphql } from '../../lib/graphql.ts'

// Generic camelCase-plural accessors the schema-derived GraphQL exposes (06b).
const POSTS_QUERY = /* GraphQL */ `
  query Posts($workspaceId: ID!, $first: Int) {
    content(workspaceId: $workspaceId, status: "published", first: $first) { items { id slug } }
  }`
const AUTHORS_QUERY = /* GraphQL */ `
  query Authors($workspaceId: ID!, $first: Int) {
    authors(workspaceId: $workspaceId, first: $first) { items { id full_name } }
  }`

type PostRow = { id: string; slug: string | null }
type AuthorRow = { id: string; full_name: string | null }

// The shell's postGraphql throws on error and returns the typed `data`; mirror its result type from
// templates/crm-lite/src/lib/graphql.ts (06d). Token is read from the session cookie the shell sets.
const token = Astro.cookies.get('sb-access-token')?.value ?? ''
let posts: PostRow[] = []
let authors: AuthorRow[] = []
let error = false
if (token) {
  const { graphqlEndpoint, workspaceId } = readServerEnv()
  try {
    const [postData, authorData] = await Promise.all([
      postGraphql<{ content: { items: PostRow[] } }>(graphqlEndpoint, token, POSTS_QUERY, { workspaceId, first: 50 }),
      postGraphql<{ authors: { items: AuthorRow[] } }>(graphqlEndpoint, token, AUTHORS_QUERY, { workspaceId, first: 50 }),
    ])
    posts = postData.content.items
    authors = authorData.authors.items
  } catch {
    error = true
  }
}
---
<Base title="Blog">
  <h1 tabindex="-1" id="blog-heading">Blog</h1>
  {!token && <p>Sign in to view the blog.</p>}
  {error && <p role="alert">Could not load the blog.</p>}
  {token && !error && posts.length === 0 && authors.length === 0 && <p>No published posts yet.</p>}
  {token && !error && (posts.length > 0 || authors.length > 0) && (
    <section aria-labelledby="posts-heading">
      <h2 id="posts-heading">Published posts</h2>
      <ul data-testid="blog-posts">{posts.map((post) => <li>{post.slug ?? post.id}</li>)}</ul>
      <h2>Authors</h2>
      <ul data-testid="blog-authors">{authors.map((author) => <li>{author.full_name ?? author.id}</li>)}</ul>
    </section>
  )}
</Base>
```

> **Executor note:** the page consumes the shell's `postGraphql(endpoint, token, query, variables)` from
> `templates/crm-lite/src/lib/graphql.ts` (06d Task 4 step 10). If that helper returns a result union
> rather than throwing, adapt the destructuring to its actual shape — the page is a smoke target, NOT on
> the machine gate's critical path (the CI smoke drives GraphQL/MCP/CLI directly).

**9. `templates/marketing-site/README.md`** — purpose (marketing site + blog), a **Platform vs. project**
table (reuses `content_item`/`content_type`/`content_revision`/`content_seo`/`content_schedule`/
`content_publish_event`/`tag`/`asset`; extends with `author` + `newsletter_subscriber`), the hosted-MCP
default note, and bootstrap commands (`npm create movp@latest -- --template marketing-site`, then
`npm run codegen`, `supabase db reset`). Use `__PROJECT_NAME__` where CRM-lite's README uses it.

**10. Re-run the gate — Expected: PASS**:

```
pnpm exec tsx scripts/check-template-gallery.ts --template=marketing-site \
  && pnpm install --frozen-lockfile
```

Expected tail: `template-gallery: marketing-site OK` then `template-gallery: 1 template(s) verified`; the
`package.json.template` (not a bare `package.json`) keeps `templates/*` workspace globbing from linking
the unpublished pins, so `pnpm install` stays green.

**11. Commit** (`feat(c6e): marketing-site template + gallery gate`).

### Gate (machine-checkable)

```
pnpm exec tsx scripts/check-template-gallery.ts --template=marketing-site \
  && test -f templates/marketing-site/package.json.template \
  && test ! -f templates/marketing-site/package.json \
  && grep -q '__PROJECT_NAME__' templates/marketing-site/supabase/config.toml \
  && grep -q '__WORKSPACE_ID__' templates/marketing-site/supabase/seed.sql \
  && grep -q '64622' templates/marketing-site/supabase/config.toml \
  && ! grep -rq '@movp/mcp-bridge' templates/marketing-site \
  && pnpm install --frozen-lockfile
```

**Expected:** `template-gallery: marketing-site OK`; tokens present in config/seed; the `+300` db port;
no `@movp/mcp-bridge`; workspace install green.

---

## Task 2 — Support-desk template (tickets-as-tasks + SLA + inbox)

Add the support-desk scaffold and register it in the gallery gate.

### Files

- **Modify:** `scripts/check-template-gallery.ts` (append the `support-desk` spec to `TEMPLATES`)
- **Copy the shell** from `templates/crm-lite/` into `templates/support-desk/` (as Task 1 step 2), then
  author/overwrite the domain files:
  `templates/support-desk/supabase/functions/_shared/schema.ts`,
  `templates/support-desk/supabase/config.toml`,
  `templates/support-desk/supabase/seed.sql`,
  `templates/support-desk/package.json.template` (copy CRM-lite's verbatim),
  `templates/support-desk/src/pages/support/index.astro`,
  `templates/support-desk/README.md`.

### Interfaces

- **Consumes:** same 06a/06b/06c/06d surface as Task 1.
- **Platform collections reused (inherited):** `task`, `task_status_option`, `task_priority_option`,
  `automation_rule`, `comment`, `event_type`.
- **Project extensions (this template owns):** `support_ticket` (links to a platform `task`), `sla_policy`.

### Steps

**1. Append the spec** to the `TEMPLATES` array in `scripts/check-template-gallery.ts` (after
`marketing-site`, keeping the literal well-formed):

```ts
  {
    name: 'support-desk',
    projectCollections: ['sla_policy', 'support_ticket'],
    reusesPlatform: ['task', 'automation_rule', 'comment'],
    pages: ['src/pages/support/index.astro'],
  },
```

Run — **Expected: FAIL** (`template_gallery_invalid: [support-desk] missing schema module ...`):

```
pnpm exec tsx scripts/check-template-gallery.ts --template=support-desk
```

**2. Copy the shell** as in Task 1 step 2 (into `templates/support-desk/`, removing the domain files).

**3. `templates/support-desk/supabase/functions/_shared/schema.ts`:**

```ts
import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

// A customer ticket. "Tickets-as-tasks": each ticket links to a platform `task` carrying status,
// priority, assignment, and the due_date the SLA due_soon automation watches.
const supportTicket = defineCollection({
  name: 'support_ticket',
  label: 'Support Ticket',
  labelPlural: 'Support Tickets',
  workspaceScoped: true,
  fields: {
    subject: f.text({ label: 'Subject', required: true, searchable: true }),
    requester_email: f.text({ label: 'Requester email', required: true }),
    channel: f.enum(['email', 'web', 'chat'], {
      label: 'Channel',
      default: 'web',
      reporting: { role: 'dimension' },
    }),
    sla_due_at: f.datetime({ label: 'SLA due at' }),
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    policy: f.relation('sla_policy', { label: 'SLA policy', cardinality: 'many-to-one' }),
  },
})

// The service-level targets an SLA automation enforces.
const slaPolicy = defineCollection({
  name: 'sla_policy',
  label: 'SLA Policy',
  labelPlural: 'SLA Policies',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    first_response_minutes: f.number({ label: 'First response (min)', required: true, reporting: { role: 'measure' } }),
    resolution_minutes: f.number({ label: 'Resolution (min)', required: true, reporting: { role: 'measure' } }),
  },
})

// task / task_status_option / task_priority_option / automation_rule / comment / event_type are inherited
// from the platform; the SLA due_soon reminder is an automation_rule seed on the task.due_soon event.
export const schema = defineSchema({
  extends: platformSchema,
  collections: [supportTicket, slaPolicy],
})

export default schema
```

**4. `templates/support-desk/supabase/config.toml`** — mirror CRM-lite's shape with `project_id =
"__PROJECT_NAME__"` and the `+400` block: `[api] port = 64721`; `[db] port = 64722`, `shadow_port =
64720`; `[db.pooler] port = 64729`; `[studio] port = 64723`; `[local_smtp] port = 64724`; `[analytics]
port = 64727`. Keep the `[functions.*] verify_jwt = false` + `[edge_runtime] deno_version = 2` +
`[db.seed]` blocks unchanged.

**5. `templates/support-desk/supabase/seed.sql`** (self-contained: workspace + one status + one priority +
one task, then a ticket linking that task, an SLA policy, and a due_soon automation rule; workspace UUID
uses `__WORKSPACE_ID__`):

```sql
-- Support-desk demo seed. Self-contained; every FK it references it also inserts. Idempotent.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Support Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'b0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

-- Platform task scaffolding a ticket needs (status + priority are required FKs on task).
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active)
  values ('b1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Open', 'active', 1, true, true)
  on conflict (id) do nothing;
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active)
  values ('b1000000-0000-0000-0000-000000000002', '__WORKSPACE_ID__', 'Normal', 100, true, true)
  on conflict (id) do nothing;
insert into public.task (id, workspace_id, title, status_id, priority_id, due_date)
  values ('b2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Login button is broken',
          'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', current_date + 1)
  on conflict (id) do nothing;

-- SLA policy + a ticket linking the task above.
insert into public.sla_policy (id, workspace_id, name, first_response_minutes, resolution_minutes)
  values ('b3000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Standard', 60, 1440)
  on conflict (id) do nothing;
insert into public.support_ticket (id, workspace_id, subject, requester_email, channel, sla_due_at, task_id, policy_id)
  values ('b4000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Login button is broken',
          'user@example.com', 'email', now() + interval '1 day',
          'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;

-- SLA due_soon reminder: a platform automation_rule on the task.due_soon event.
insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority)
  values ('b5000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          (select id from public.event_type where key = 'task.due_soon' limit 1),
          '{}'::jsonb, 'notify', '{"channel":"support_inbox"}'::jsonb, true, 100)
  on conflict (id) do nothing;
```

> **Executor note (verify before pasting):** confirm the exact `task` FK column names (`status_id` /
> `priority_id`) and that an `event_type` row with `key = 'task.due_soon'` exists in the platform seed
> stream — grep `supabase/migrations` for `task.due_soon` and the `create table public.task` columns. The
> migration stream is authoritative. If `automation_rule.trigger_event_type_id` is `not null` and the
> `task.due_soon` key is absent, drop the `automation_rule` insert and document the automation as a manual
> step in the README instead (keep the seed FK-safe).

**6. `templates/support-desk/package.json.template`** — copy CRM-lite's verbatim (unchanged).

**7. `templates/support-desk/src/pages/support/index.astro`** — an inbox of tickets, following the same
shell pattern as Task 1 step 8:

```astro
---
import Base from '../../layouts/Base.astro'
import { readServerEnv } from '../../lib/env.ts'
import { postGraphql } from '../../lib/graphql.ts'

const TICKETS_QUERY = /* GraphQL */ `
  query SupportTickets($workspaceId: ID!, $first: Int) {
    supportTickets(workspaceId: $workspaceId, first: $first) {
      items { id subject requester_email channel sla_due_at }
    }
  }`

type TicketRow = {
  id: string
  subject: string | null
  requester_email: string | null
  channel: string | null
  sla_due_at: string | null
}

const token = Astro.cookies.get('sb-access-token')?.value ?? ''
let tickets: TicketRow[] = []
let error = false
if (token) {
  const { graphqlEndpoint, workspaceId } = readServerEnv()
  try {
    const data = await postGraphql<{ supportTickets: { items: TicketRow[] } }>(
      graphqlEndpoint,
      token,
      TICKETS_QUERY,
      { workspaceId, first: 100 },
    )
    tickets = data.supportTickets.items
  } catch {
    error = true
  }
}
---
<Base title="Support inbox">
  <h1 tabindex="-1" id="support-heading">Support inbox</h1>
  {!token && <p>Sign in to view tickets.</p>}
  {error && <p role="alert">Could not load tickets.</p>}
  {token && !error && tickets.length === 0 && <p>No open tickets.</p>}
  {token && !error && tickets.length > 0 && (
    <table data-testid="ticket-list">
      <thead><tr><th>Subject</th><th>Requester</th><th>Channel</th><th>SLA due</th></tr></thead>
      <tbody>
        {tickets.map((ticket) => (
          <tr>
            <td>{ticket.subject ?? ticket.id}</td>
            <td>{ticket.requester_email ?? ''}</td>
            <td>{ticket.channel ?? ''}</td>
            <td>{ticket.sla_due_at ?? 'unset'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</Base>
```

**8. `templates/support-desk/README.md`** — purpose (support desk), Platform-vs-project table (reuses
`task`/`task_status_option`/`task_priority_option`/`automation_rule`/`comment`/`event_type`; extends with
`support_ticket` + `sla_policy`), the tickets-as-tasks note, and bootstrap commands.

**9. Re-run the gate — Expected: PASS** (`template-gallery: support-desk OK`):

```
pnpm exec tsx scripts/check-template-gallery.ts --template=support-desk
```

**10. Commit** (`feat(c6e): support-desk template (tickets-as-tasks + SLA)`).

### Gate (machine-checkable)

```
pnpm exec tsx scripts/check-template-gallery.ts --template=support-desk \
  && test -f templates/support-desk/package.json.template \
  && test ! -f templates/support-desk/package.json \
  && grep -q '64722' templates/support-desk/supabase/config.toml \
  && grep -q '__WORKSPACE_ID__' templates/support-desk/supabase/seed.sql
```

**Expected:** `template-gallery: support-desk OK`; the `+400` db port; tokens present.

---

## Task 3 — Knowledge-base template (embeddable content + hybrid search)

Add the knowledge-base scaffold and register it in the gallery gate.

### Files

- **Modify:** `scripts/check-template-gallery.ts` (append the `knowledge-base` spec to `TEMPLATES`)
- **Copy the shell** from `templates/crm-lite/` into `templates/knowledge-base/`, then author/overwrite:
  `templates/knowledge-base/supabase/functions/_shared/schema.ts`,
  `templates/knowledge-base/supabase/config.toml`,
  `templates/knowledge-base/supabase/seed.sql`,
  `templates/knowledge-base/package.json.template` (copy CRM-lite's verbatim),
  `templates/knowledge-base/src/pages/kb/index.astro`,
  `templates/knowledge-base/README.md`.

### Interfaces

- **Consumes:** same 06a/06b/06c/06d surface as Task 1.
- **Platform collections reused (inherited):** `content_item` (its `search_body` is `embeddable`, driving
  the platform hybrid-search infra), `saved_item`, `tag`.
- **Project extensions (this template owns):** `kb_article` (`body` `searchable` + `embeddable`),
  `kb_category`.

### Steps

**1. Append the spec** to `TEMPLATES`:

```ts
  {
    name: 'knowledge-base',
    projectCollections: ['kb_article', 'kb_category'],
    reusesPlatform: ['content_item', 'saved_item'],
    pages: ['src/pages/kb/index.astro'],
  },
```

Run — **Expected: FAIL** (`template_gallery_invalid: [knowledge-base] missing schema module ...`):

```
pnpm exec tsx scripts/check-template-gallery.ts --template=knowledge-base
```

**2. Copy the shell** as in Task 1 step 2 (into `templates/knowledge-base/`).

**3. `templates/knowledge-base/supabase/functions/_shared/schema.ts`:**

```ts
import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

// A product-docs article. `body` is searchable + embeddable, so articles are indexed for both keyword
// and vector (hybrid) search by the platform search/embedding infra.
const kbArticle = defineCollection({
  name: 'kb_article',
  label: 'KB Article',
  labelPlural: 'KB Articles',
  workspaceScoped: true,
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true, embeddable: true }),
    category: f.relation('kb_category', { label: 'Category', cardinality: 'many-to-one' }),
    status: f.enum(['draft', 'published'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})

// A grouping for articles (product area / topic).
const kbCategory = defineCollection({
  name: 'kb_category',
  label: 'KB Category',
  labelPlural: 'KB Categories',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    slug: f.text({ label: 'Slug', required: true }),
  },
})

// content_item (embeddable search_body), saved_item, and tag are inherited from the platform;
// C8 later layers RAG on top of the same embeddable surface.
export const schema = defineSchema({
  extends: platformSchema,
  collections: [kbArticle, kbCategory],
})

export default schema
```

**4. `templates/knowledge-base/supabase/config.toml`** — mirror CRM-lite's shape with `project_id =
"__PROJECT_NAME__"` and the `+500` block: `[api] port = 64821`; `[db] port = 64822`, `shadow_port =
64820`; `[db.pooler] port = 64829`; `[studio] port = 64823`; `[local_smtp] port = 64824`; `[analytics]
port = 64827`. Keep the `[functions.*]` / `[edge_runtime]` / `[db.seed]` blocks unchanged.

**5. `templates/knowledge-base/supabase/seed.sql`** (self-contained: workspace + a category + a published
article; workspace UUID uses `__WORKSPACE_ID__`):

```sql
-- Knowledge-base demo seed. Self-contained; every FK it references it also inserts. Idempotent.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Docs Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'c0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

insert into public.kb_category (id, workspace_id, name, slug)
  values ('c1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Getting Started', 'getting-started')
  on conflict (id) do nothing;
insert into public.kb_article (id, workspace_id, title, body, category_id, status)
  values ('c2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Install the CLI',
          'Run npm create movp@latest to scaffold a project.',
          'c1000000-0000-0000-0000-000000000001', 'published')
  on conflict (id) do nothing;
```

**6. `templates/knowledge-base/package.json.template`** — copy CRM-lite's verbatim (unchanged).

**7. `templates/knowledge-base/src/pages/kb/index.astro`** — a docs index with a hybrid-search box over
`kb_article`, using the shell's `postGraphql` + the platform `search` field:

```astro
---
import Base from '../../layouts/Base.astro'
import { readServerEnv } from '../../lib/env.ts'
import { postGraphql } from '../../lib/graphql.ts'

const ARTICLES_QUERY = /* GraphQL */ `
  query KbArticles($workspaceId: ID!, $first: Int) {
    kbArticles(workspaceId: $workspaceId, status: "published", first: $first) { items { id title } }
  }`
const SEARCH_QUERY = /* GraphQL */ `
  query Search($workspaceId: ID!, $query: String!) {
    search(workspaceId: $workspaceId, query: $query) { collection id title snippet score }
  }`

type ArticleRow = { id: string; title: string | null }
type SearchHit = { collection: string; id: string; title: string; snippet: string; score: number }

const token = Astro.cookies.get('sb-access-token')?.value ?? ''
const q = Astro.url.searchParams.get('q')?.trim() ?? ''
let articles: ArticleRow[] = []
let hits: SearchHit[] = []
let error = false
if (token) {
  const { graphqlEndpoint, workspaceId } = readServerEnv()
  try {
    const articleData = await postGraphql<{ kbArticles: { items: ArticleRow[] } }>(
      graphqlEndpoint,
      token,
      ARTICLES_QUERY,
      { workspaceId, first: 100 },
    )
    articles = articleData.kbArticles.items
    if (q) {
      const searchData = await postGraphql<{ search: SearchHit[] }>(graphqlEndpoint, token, SEARCH_QUERY, { workspaceId, query: q })
      hits = searchData.search.filter((hit) => hit.collection === 'kb_article')
    }
  } catch {
    error = true
  }
}
---
<Base title="Knowledge base">
  <h1 tabindex="-1" id="kb-heading">Knowledge base</h1>
  {!token && <p>Sign in to view articles.</p>}
  {error && <p role="alert">Could not load articles.</p>}
  {token && !error && (
    <form method="get" aria-label="Search the knowledge base">
      <label>Search<input name="q" type="search" value={q} /></label>
      <button type="submit">Search</button>
    </form>
  )}
  {token && !error && q && (
    <section aria-labelledby="kb-search-heading" data-testid="kb-search-results">
      <h2 id="kb-search-heading">Search results</h2>
      {hits.length === 0 ? <p>No matching articles.</p> : (
        <ul>{hits.map((hit) => <li>{hit.title} <small>{hit.snippet}</small></li>)}</ul>
      )}
    </section>
  )}
  {token && !error && articles.length === 0 && <p>No articles yet.</p>}
  {token && !error && articles.length > 0 && (
    <section aria-labelledby="kb-list-heading">
      <h2 id="kb-list-heading">Published articles</h2>
      <ul data-testid="kb-articles">{articles.map((article) => <li>{article.title ?? article.id}</li>)}</ul>
    </section>
  )}
</Base>
```

**8. `templates/knowledge-base/README.md`** — purpose (KB / product docs), Platform-vs-project table
(reuses `content_item`/`saved_item`/`tag` + the embeddable search infra; extends with `kb_article` +
`kb_category`), a note that hybrid search works because `kb_article.body` is `embeddable`, and bootstrap
commands.

**9. Re-run the gate — Expected: PASS** (`template-gallery: knowledge-base OK`):

```
pnpm exec tsx scripts/check-template-gallery.ts --template=knowledge-base \
  && pnpm exec tsx scripts/check-template-gallery.ts
```

The all-templates run reports `template-gallery: 3 template(s) verified`.

**10. Commit** (`feat(c6e): knowledge-base template (embeddable + hybrid search)`).

### Gate (machine-checkable)

```
pnpm exec tsx scripts/check-template-gallery.ts \
  && test -f templates/knowledge-base/package.json.template \
  && test ! -f templates/knowledge-base/package.json \
  && grep -q '64822' templates/knowledge-base/supabase/config.toml
```

**Expected:** `template-gallery: 3 template(s) verified`; the `+500` db port; token discipline holds.

---

## Task 4 — 4-way CI matrix (pack once, per-template scaffold → reset → smoke)

Generalize 06d's Verdaccio gate to a `$TEMPLATE` parameter and add the CI jobs that pack artifacts once
and fan out across all four templates, plus the Docker-free gallery gate.

### Files

- **Create:** `fixtures/verdaccio-gallery/gate.sh` (executable) — a `$TEMPLATE`-parameterized copy of
  `fixtures/verdaccio-crm-lite/gate.sh`.
- **Create:** `fixtures/verdaccio-gallery/pack.sh` (executable) — the pack-once half factored out.
- **Modify:** `.github/workflows/ci.yml` (add `template-gallery`, `pack-artifacts`, `template-smoke`).
- **Modify:** root `package.json` (add `check:verdaccio-gallery` script alongside 06d's `check:verdaccio-crm`).
- **Modify:** `docs/superpowers/plans/README.md` (Stage C EXECUTION STATUS — mark C6e landed).

### Interfaces

- **Consumes (06d):** `fixtures/verdaccio-crm-lite/gate.sh` (the pack/publish-once → scaffold → install →
  codegen → reset → serve GraphQL + MCP → authenticated HTTP GraphQL + streamable-MCP `callTool` + CLI
  create/list harness), the `verdaccio` devDependency, and the `+200`/`+300`/`+400`/`+500` port blocks.
- **Produces:** `fixtures/verdaccio-gallery/gate.sh <template>` and a CI matrix over
  `[crm-lite, marketing-site, support-desk, knowledge-base]`.

### Steps

**1. Factor the pack step into `fixtures/verdaccio-gallery/pack.sh`.** Read the pack half of 06d's
`fixtures/verdaccio-crm-lite/gate.sh` (the `pnpm pack` / `npm pack` of each publishable `@movp/*` +
`@movp/platform` + `create-movp`). Create `pack.sh <outdir>` that runs exactly those pack commands,
writing every tarball into `<outdir>`:

```bash
#!/usr/bin/env bash
set -euo pipefail
OUT="${1:?usage: pack.sh <outdir>}"
mkdir -p "$OUT"
# Pack the SAME package set 06d's gate publishes (mirror its list verbatim):
for pkg in auth cli codegen core-schema domain flows graphql mcp notifications obs search platform; do
  ( cd "packages/$pkg" && pnpm pack --pack-destination "$(cd "$OUT" && pwd)" )
done
( cd packages/create-movp && pnpm pack --pack-destination "$(cd "$OUT" && pwd)" )
echo "pack: wrote $(ls "$OUT"/*.tgz | wc -l | tr -d ' ') tarballs to $OUT"
```

> **Reconcile with 06d:** confirm the exact package list against `scripts/check-package-artifacts.mjs`
> (06d Task 1 lists: `auth, cli, codegen, core-schema, domain, flows, graphql, mcp, notifications, obs,
> search, platform`) and `create-movp`. Match 06d's pack command form (`pnpm pack` vs `npm pack`) exactly.

**2. Generalize 06d's gate.** Create `fixtures/verdaccio-gallery/gate.sh` by copying
`fixtures/verdaccio-crm-lite/gate.sh` and parameterizing it by the FIRST positional argument:

```bash
#!/usr/bin/env bash
set -euo pipefail
TEMPLATE="${1:?usage: gate.sh <template>}"   # crm-lite | marketing-site | support-desk | knowledge-base
```

Then replace every hardcoded `crm-lite` occurrence in the copied body with `"$TEMPLATE"` (the `cp -R
"$REPO_ROOT/templates/crm-lite" ...` staging line, the `create movp` template answer piped to the CLI,
and the `templates/crm-lite` install path), and derive the port block so the reset + smoke bind the
right stack:

```bash
case "$TEMPLATE" in
  crm-lite)        API_PORT=64521; DB_PORT=64522 ;;
  marketing-site)  API_PORT=64621; DB_PORT=64622 ;;
  support-desk)    API_PORT=64721; DB_PORT=64722 ;;
  knowledge-base)  API_PORT=64821; DB_PORT=64822 ;;
  *) echo "unknown template: $TEMPLATE" >&2; exit 1 ;;
esac
DB_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres"
```

If a pre-packed artifacts dir is present (`ARTIFACTS_DIR`, set by CI), publish those tarballs to Verdaccio
instead of re-packing; otherwise call `pack.sh` locally. Keep the rest of 06d's gate body verbatim
(publish-once to Verdaccio, scaffold, `npm install`, codegen, `supabase db reset`, serve, drive
GraphQL/MCP/CLI, assert no `file:`/workspace links). Final line: `gate: verdaccio-gallery ($TEMPLATE)
acceptance PASS`. Mark both scripts executable (`chmod +x fixtures/verdaccio-gallery/*.sh`).

> **Reconcile with 06d before running:** open `fixtures/verdaccio-crm-lite/gate.sh` and adopt its exact
> `REGISTRY` / `WORK` / `PROJECT` / `WS` variable names and its serve-readiness poll verbatim — only the
> template name + port block + the "publish pre-packed tarballs if present" branch are parameterized here.

**3. Add the root script** to `package.json` (after 06d's `check:verdaccio-crm`):

```json
    "check:verdaccio-gallery": "bash fixtures/verdaccio-gallery/gate.sh",
```

**4. Add the Docker-free gallery gate as a CI job** in `.github/workflows/ci.yml` (mirrors the existing
`schema-codegen-unit` job's setup):

```yaml
  template-gallery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsx scripts/check-template-gallery.ts
```

**5. Add the pack-once + matrix jobs** in `.github/workflows/ci.yml`. `pack-artifacts` packs the whole
bundle ONCE and uploads the tarballs; `template-smoke` `needs:` it, downloads them, and runs the
generalized gate per `matrix.template` (so the artifacts are packed a single time, not per leg):

```yaml
  pack-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: bash fixtures/verdaccio-gallery/pack.sh ./artifacts
      - uses: actions/upload-artifact@v4
        with: { name: movp-tarballs, path: ./artifacts }

  template-smoke:
    needs: [pack-artifacts]
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        template: [crm-lite, marketing-site, support-desk, knowledge-base]
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - uses: actions/download-artifact@v4
        with: { name: movp-tarballs, path: ./artifacts }
      - run: pnpm install --frozen-lockfile
      - env:
          ARTIFACTS_DIR: ${{ github.workspace }}/artifacts
        run: bash fixtures/verdaccio-gallery/gate.sh ${{ matrix.template }}
```

**6. Verify the workflow parses and lists four templates:**

```
node -e "const y=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!['crm-lite','marketing-site','support-desk','knowledge-base'].every(t=>y.includes(t))) throw new Error('matrix missing a template'); for(const j of ['template-gallery:','pack-artifacts:','template-smoke:']) if(!y.includes(j)) throw new Error('missing job '+j); console.log('ci.yml: 4-way template matrix + gallery job present')"
```

**Expected:** `ci.yml: 4-way template matrix + gallery job present`. If `actionlint` is on PATH, also run
`actionlint .github/workflows/ci.yml` — Expected: no errors.

**7. Update the Stage C EXECUTION STATUS table** in `docs/superpowers/plans/README.md`: mark C6e landed in
the SAME commit (Phase Completion Signal rule), noting the three templates + the 4-way matrix.

**8. Run the Docker-free gallery gate** (the local proxy; the full smoke runs in CI, and locally via
`bash fixtures/verdaccio-gallery/gate.sh <template>` where Docker + Verdaccio are available):

```
pnpm exec tsx scripts/check-template-gallery.ts
```

**Expected:** `template-gallery: 3 template(s) verified`.

**9. Commit** (`ci(c6e): 4-way template matrix + template-gallery gate`).

### Gate (machine-checkable)

```
pnpm exec tsx scripts/check-template-gallery.ts \
  && test -x fixtures/verdaccio-gallery/gate.sh \
  && test -x fixtures/verdaccio-gallery/pack.sh \
  && node -e "const y=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!['crm-lite','marketing-site','support-desk','knowledge-base'].every(t=>y.includes(t))) throw new Error('matrix missing a template'); for(const j of ['template-gallery:','pack-artifacts:','template-smoke:']) if(!y.includes(j)) throw new Error('missing job '+j); console.log('ok')"
```

**Expected:** gallery gate reports 3 templates verified; both scripts are executable; `ci.yml` contains
all four template names and the three new jobs. In CI, `template-smoke` runs each of the four templates'
scaffold → reset → real-surface smoke against the once-packed tarballs; `template-gallery` runs the
Docker-free composition gate.

---

## Assumptions

1. **06d has landed; its contract is consumed verbatim.** Template layout, copier tokens
   (`__PROJECT_NAME__` / `__WORKSPACE_ID__`), `package.json.template` convention, the CRM-lite app shell,
   and `fixtures/verdaccio-crm-lite/gate.sh` are all fixed by the finalized 06d plan. The gallery
   templates are byte-identical to CRM-lite except their domain schema, config ports, seed, pages, and
   README. Reconcile the generalized `gate.sh` / `pack.sh` against the real CRM-lite gate before running
   (Task 4 steps 1–2).
2. **Templates ship `package.json.template`, never `package.json`.** The copier renames it at scaffold
   time; this keeps `templates/*` workspace globbing from linking the unpublished `@movp/* @^0.1.0` pins.
   The gallery gate asserts both (present template, absent bare file) per template.
3. **Port blocks are locked by the INTERFACES "Port-block allocation" table.** marketing-site = `+300`
   (`64621/64622…`), support-desk = `+400` (`64721/64722…`), knowledge-base = `+500` (`64821/64822…`);
   06a owns `+100`, 06d CRM-lite owns `+200`. No collisions across a parallel CI matrix.
4. **Astro pages are smoke targets, not gate-critical** (06d's own note). Each ships ONE page using the
   shell's `postGraphql(endpoint, token, query, variables)` helper; adapt the destructuring to that
   helper's actual result type (throwing vs. result union) once you read
   `templates/crm-lite/src/lib/graphql.ts`. The generic camelCase-plural field names (`authors`,
   `supportTickets`, `kbArticles`) match the platform's existing `contentTypes` / `content` accessors; the
   CI smoke's `{ __type(name:"Query"){ fields { name } } }` step (inherited from 06d) is the source of
   truth for the exact names — wire the pages to whatever it reports.
5. **Empty delta registry is the correct initial state.** Each template ships `movp.deltas.json =
   { "deltas": [] }`; the project baseline owns both extension collections on the first scaffold, and 06c's
   `generate()` bootstraps it cleanly (no `new_generated_delta_required`). Adding a third collection later
   is a `movp new-delta` operation, documented in each README.
6. **Seed FK names are verified against the migration stream, not assumed.** The support-desk seed
   references platform `task` columns (`status_id` / `priority_id`) and the `task.due_soon` `event_type`
   key; the executor note in Task 2 step 5 requires grepping `supabase/migrations` before pasting, since
   the migration stream — not this plan — is authoritative for platform column names.
7. **06d does NOT author a CI matrix job.** Its acceptance gate is the local `gate.sh`. The 4-way CI
   matrix + the pack-once job are THIS plan's Task 4; they generalize 06d's gate to a `$TEMPLATE`
   parameter and must not repack artifacts per matrix leg.
8. **The gallery gate runs via `tsx`** (already a root dependency), importing each template's `.ts` schema
   module by `file://` URL so `tsx` resolves the workspace `@movp/*` deps. No new dependency, no
   per-template test wiring under `templates/<name>/`.
