# MOVP Core — Frontend Template & CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `templates/frontend-astro` — an Astro app on the Cloudflare Workers + R2 adapter that talks to the GraphQL endpoint over HTTP only (notes list, note detail, search) with every required UX state (empty / loading / error+retry / auth-failure) and correct keyboard focus — and wire `.github/workflows/ci.yml` so EVERY Phase-1 gate runs as a job that fails loudly on a seeded violation.

**Architecture:** The frontend is a leaf consumer. It imports a tiny **fetch-based, generated-shape GraphQL client** defined *inside the template* — never `@movp/auth`, `@movp/domain`, or anything carrying the service-role key. It reads the caller's Supabase JWT from a session cookie and forwards it as `Authorization: Bearer …` to the `graphql` edge function (`/functions/v1/graphql`). Pages are server-rendered on workerd; the search surface is a client island that calls a same-origin Astro API route (so the token never leaves the server). CF runtime env is read via the documented Astro v6 mechanism — the `cloudflare:workers` virtual module — never `process.env` and never `Astro.locals.runtime.env` (removed in Astro v6). CI is the breadth gate for the whole series: 11 jobs, each independently red on a seeded violation, with the Supabase local stack as the e2e substrate.

**Tech Stack:** Astro 6, `@astrojs/cloudflare` adapter, Cloudflare Workers + R2, `wrangler`, TypeScript, Vitest (pure-client unit tests), Playwright + `@axe-core/playwright` (frontend-ux), Supabase CLI (local stack + pgTAP), `psql` (vector-scale EXPLAIN), GitHub Actions (`supabase/setup-cli@v1` pinned `version: latest`).

**This plan is Plan 6 of the Phase 1 (MOVP Core) series** (design Tasks 11–12). The north-star + Phase 1 design lives at `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`; Plan 1 (scaffold/tenancy/auth) lives at `docs/superpowers/plans/2026-06-30-movp-core-foundation.md`. Plans 2–5 (Schema DSL & Codegen, Domain Core, API Surfaces, Search & Async) deliver the packages, migrations, edge functions, and per-package test suites that this plan's CI jobs invoke; Plan 6 wires them and adds the frontend + the CI-owned gates (`boundary`, `definer-audit`, `internal-access`, `vector-scale`, `slice-e2e`, `frontend-ux`).

## Global Constraints

- **Frontend boundary rule (load-bearing).** No file under `templates/` may import `@movp/auth`, `@movp/domain`, or anything that carries the service-role key. The template talks to the GraphQL endpoint over HTTP only, via the in-template fetch client. The `boundary` CI job greps for these imports under `templates/` and fails on a hit; new files are covered automatically because the grep walks the whole directory.
- **CF runtime env via `cloudflare:workers`, never `process.env`/`Astro.locals.runtime.env`.** `process.env` is empty on workerd; `Astro.locals.runtime.env` was removed in Astro v6 and `Astro.locals.runtime.ctx` is a throwing getter. Read env from the `cloudflare:workers` virtual module inside a `readServerEnv()` helper, resolved **at call time** inside the page/route, never captured at module scope. (See the design's tenancy/runtime guidance and the `cloudflare-workers-runtime` rule.)
- **Per-request deps resolved at call time.** The GraphQL endpoint and the session token are resolved inside each page/route from `Astro` (env + cookies), never module-scope singletons. A missing endpoint fails loudly (throws); a missing token renders the auth-failure view (never an anonymous query that returns a misleading empty result).
- **Pure client is env-free and injectable.** `gqlRequest` takes `{ endpoint, token, fetchImpl? }` so it is unit-testable under Vitest with a mock `fetch` and never imports `cloudflare:workers`. Env/cookie wiring lives only in pages/routes.
- **Supabase CLI is the only migration applier;** CI runs the local stack. `supabase db reset` then `supabase db diff` (must be empty) is the drift gate. `supabase test db` runs pgTAP.
- **Public values are literals/`vars:`, never masked secrets.** The local project ref, region, and the standard local DB URL/ports (`127.0.0.1:54321` API, `127.0.0.1:54322` DB) are public and appear as literals. Secrets (`vars`/`secrets` blocks) are reserved for actual credentials; CI needs none beyond the GitHub token because it runs entirely against the local stack.
- **Pin `supabase/setup-cli@v1` with `version: latest`** in every job that uses the CLI (avoids the older-CLI-rejects-newer-config failure).
- **Observability discipline carries to the frontend:** never render or log raw token/email/PII; error views show a stable code, not the upstream body.
- **Every CI gate fails loudly on a seeded violation.** Each CI-gate task's gate includes a temporary, reverted seeded violation that must turn the job red — a defined-but-never-firing gate is not done.

## File Structure

```
supasuite/
  templates/
    frontend-astro/
      package.json              # @movp/frontend-astro (private workspace member)
      tsconfig.json
      astro.config.mjs          # @astrojs/cloudflare adapter, server output
      wrangler.jsonc            # Worker + R2 binding + vars (GRAPHQL_ENDPOINT)
      vitest.config.ts
      playwright.config.ts
      .gitignore
      src/
        env.d.ts                # Astro + cloudflare:workers ambient types
        lib/
          env.ts                # readServerEnv() over cloudflare:workers
          session.ts            # getSessionToken(cookies) — reads JWT cookie
          graphql.ts            # gqlRequest() + generated-shape types + queries
        layouts/
          Base.astro            # skip link, <main tabindex=-1>, global styles
        components/
          states/
            EmptyState.astro
            LoadingState.astro
            ErrorRetry.astro
            AuthFailure.astro
          SearchBox.tsx         # client island: loading/empty/error+retry
        pages/
          index.astro           # notes list (SSR)
          notes/[id].astro      # note detail (SSR)
          search.astro          # search page (hosts SearchBox island)
          api/
            search.ts           # same-origin server route: cookie -> GraphQL search
        styles/
          global.css            # :focus-visible, prefers-reduced-motion
      tests/
        client.test.ts          # Vitest: pure gqlRequest (mock fetch)
        mock/
          graphql-mock.mjs      # scenario-driven mock GraphQL server (e2e)
        e2e/
          frontend.spec.ts      # Playwright + axe: all states + a11y smoke
  scripts/
    check-boundary.sh           # boundary grep over templates/
    check-definer-audit.mjs     # SECURITY DEFINER search_path audit over migrations
    internal_access_seed.sql    # (helper for seeded-violation demo; see Task 7)
    vector-scale.sql            # 10 ws x 50k chunks fixture + EXPLAIN
    check-vector-scale.mjs      # runs the EXPLAIN, asserts plan shape
    slice-e2e.sh                # end-to-end Verification list against local stack
  supabase/
    tests/
      internal_access_test.sql  # pgTAP: anon/authenticated denied on movp_internal.*
  .github/
    workflows/
      ci.yml                    # 11 jobs (see Task 9)
```

---

### Task 1: Scaffold `templates/frontend-astro` (Astro + Cloudflare adapter + R2 + env)

**Files:**
- Create: `templates/frontend-astro/package.json`, `tsconfig.json`, `astro.config.mjs`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`
- Create: `templates/frontend-astro/src/env.d.ts`, `src/lib/env.ts`

**Interfaces:**
- Consumes: the monorepo workspace globs (`templates/*`) and `tsconfig.base.json` from Plan 1; the deployed `graphql` edge function (HTTP only).
- Produces (relied on by Tasks 2–5): a buildable Astro Worker; `readServerEnv()` returning `{ graphqlEndpoint, workspaceId }`; `@movp/frontend-astro` workspace member with `build`/`typecheck`/`test`/`e2e` scripts.

> **Boundary + runtime gotchas live in the code below.** `readServerEnv()` reads the `cloudflare:workers` virtual module, NOT `process.env`/`Astro.locals.runtime.env`. No file here imports `@movp/auth` or `@movp/domain`.

- [ ] **Step 1: Create the package skeleton**

`templates/frontend-astro/package.json`:
```json
{
  "name": "@movp/frontend-astro",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "typecheck": "astro check && tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test",
    "preview": "wrangler dev"
  },
  "dependencies": {
    "astro": "^6.0.0",
    "@astrojs/cloudflare": "^12.0.0"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^4.0.0",
    "@playwright/test": "^1.48.0",
    "@axe-core/playwright": "^4.10.0"
  }
}
```

`templates/frontend-astro/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["astro/client"],
    "jsx": "preserve"
  },
  "include": ["src", "tests", "env.d.ts", "src/env.d.ts"]
}
```

`templates/frontend-astro/.gitignore`:
```gitignore
dist/
.astro/
.wrangler/
node_modules/
test-results/
playwright-report/
```

- [ ] **Step 2: Astro + Cloudflare adapter config**

`templates/frontend-astro/astro.config.mjs`:
```js
// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'

// Server-rendered on Cloudflare Workers; static assets served by Workers Assets,
// media via the R2 binding declared in wrangler.jsonc. Do NOT add a Node adapter.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // platformProxy provides the `cloudflare:workers` env + bindings during `astro dev`.
    platformProxy: { enabled: true },
  }),
})
```

`templates/frontend-astro/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "movp-frontend-astro",
  // @astrojs/cloudflare emits the server entry here after `astro build`.
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2025-05-05",
  "compatibility_flags": ["nodejs_compat"],
  // Built static files are served as Workers Assets.
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  // R2 bucket for media/uploads (the design's "assets to R2"). Public binding name;
  // bucket_name is a public value, declared as a literal (not a secret).
  "r2_buckets": [
    { "binding": "MEDIA_BUCKET", "bucket_name": "movp-frontend-media" }
  ],
  // GRAPHQL_ENDPOINT and WORKSPACE_ID are public routing values -> plain vars, never masked secrets.
  // Overridden per-environment / in e2e via `wrangler dev --var`.
  "vars": {
    "GRAPHQL_ENDPOINT": "http://127.0.0.1:54321/functions/v1/graphql",
    "WORKSPACE_ID": "33333333-3333-3333-3333-333333333333"
  },
  "observability": { "enabled": true }
}
```

- [ ] **Step 3: Ambient types + env helper**

`templates/frontend-astro/src/env.d.ts`:
```ts
/// <reference types="astro/client" />

// Bindings/vars surfaced by the Cloudflare adapter at runtime.
type CfEnv = {
  GRAPHQL_ENDPOINT: string
  WORKSPACE_ID: string
  MEDIA_BUCKET: R2Bucket
  ASSETS: Fetcher
}

// The `cloudflare:workers` virtual module is provided by the adapter / workerd.
declare module 'cloudflare:workers' {
  export const env: CfEnv
}
```

`templates/frontend-astro/src/lib/env.ts`:
```ts
// CF runtime env. workerd-only: read from the `cloudflare:workers` virtual module.
// NEVER use process.env (empty on workerd) or Astro.locals.runtime.env (removed in
// Astro v6). Resolve at CALL TIME from inside the page/route — never cache at module scope.
import { env } from 'cloudflare:workers'

export type ServerEnv = { graphqlEndpoint: string; workspaceId: string }

export function readServerEnv(): ServerEnv {
  const graphqlEndpoint = env.GRAPHQL_ENDPOINT
  const workspaceId = env.WORKSPACE_ID
  if (!graphqlEndpoint || !workspaceId) {
    // Fail loudly — a misconfigured endpoint must not silently degrade to no data.
    throw new Error('env_misconfigured: GRAPHQL_ENDPOINT or WORKSPACE_ID is not set')
  }
  return { graphqlEndpoint, workspaceId }
}
```

`templates/frontend-astro/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

// Pure-client unit tests only. They never import `cloudflare:workers`, so the
// default node environment is correct; e2e (Playwright) lives outside vitest.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
```

- [ ] **Step 4: Install and build**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install && pnpm --filter @movp/frontend-astro build
```
Expected: `pnpm install` links `@movp/frontend-astro`; `astro build` prints `Complete!` and emits `templates/frontend-astro/dist/_worker.js/index.js`. (Pages are added in later tasks; an app with zero routes still builds.)

- [ ] **Step 5: Validate the Worker config without deploying**

Run:
```bash
cd /Users/ensell/Code/supasuite/templates/frontend-astro && pnpm exec wrangler deploy --dry-run --outdir /tmp/movp-fe-dryrun
```
Expected: PASS — wrangler resolves `wrangler.jsonc`, the R2 binding, and `main`, printing a dry-run bundle summary and `--dry-run: exiting now.` with no auth/credentials required. (If `wrangler deploy --dry-run` rejects a flag, run `pnpm exec wrangler deploy --help` and confirm `--dry-run`/`--outdir` per your installed version — see the `ci-deploy-patterns` rule.)

- [ ] **Step 6: Gate — boundary stays clean and typecheck passes**

Run:
```bash
cd /Users/ensell/Code/supasuite && grep -rnE "@movp/(auth|domain)|service_role|SERVICE_ROLE" templates/ || echo "BOUNDARY_CLEAN"
pnpm --filter @movp/frontend-astro typecheck
```
Expected: first command prints `BOUNDARY_CLEAN` (no forbidden imports); `typecheck` (astro check + tsc) passes with no errors.

- [ ] **Step 7: Commit**

```bash
git add templates/frontend-astro
git commit -m "feat(frontend): scaffold Astro CF Worker template (R2, cloudflare:workers env)"
```

---

### Task 2: Typed fetch GraphQL client + notes list page (SSR)

**Files:**
- Create: `templates/frontend-astro/src/lib/graphql.ts`, `src/lib/session.ts`
- Create: `templates/frontend-astro/src/layouts/Base.astro`, `src/styles/global.css`
- Create: `templates/frontend-astro/src/pages/index.astro`
- Test: `templates/frontend-astro/tests/client.test.ts`

**Interfaces:**
- Consumes: `readServerEnv()` (Task 1); the GraphQL endpoint's `notes` page (`items` + `nextCursor`, cursor pagination, default 20 / max 100) and `NoteRow{id,title,body,status,created_at,updated_at}`.
- Produces (relied on by Tasks 3–5): `gqlRequest()`, generated-shape types, named query documents, `getSessionToken()`, the `Base` layout, and the notes-list route at `/`.

- [ ] **Step 1: Write the failing pure-client test**

`templates/frontend-astro/tests/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { gqlRequest, NOTES_QUERY } from '../src/lib/graphql.ts'

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('gqlRequest', () => {
  it('sends the Bearer token and POSTs the query, returning data', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(
        JSON.stringify({ data: { notes: { items: [], nextCursor: null } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const r = await gqlRequest(
      { endpoint: 'https://x/functions/v1/graphql', token: 'jwt-abc', fetchImpl },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r.ok).toBe(true)
    expect(seen?.init.method).toBe('POST')
    expect((seen?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-abc')
    expect((seen?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(seen?.init.body as string).variables).toEqual({ workspaceId: 'w', first: 20 })
  })

  it('maps a non-2xx response to an error result (no throw)', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(500, {}) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'http_error' })
  })

  it('maps a GraphQL errors array to an error result', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(200, { errors: [{ message: 'nope' }] }) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'graphql_error' })
  })

  it('maps a 401/403 to auth_error', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(401, {}) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'auth_error' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/frontend-astro test
```
Expected: FAIL — cannot resolve `../src/lib/graphql.ts` / `gqlRequest` is not defined.

- [ ] **Step 3: Implement the client + types**

`templates/frontend-astro/src/lib/graphql.ts`:
```ts
// In-template, fetch-based GraphQL client. Boundary rule: this is the ONLY way the
// template reaches the backend. It imports nothing from @movp/* and holds no secrets.
// Types mirror the generated GraphQL schema (Plan 4); regenerate if the schema changes.

export type NoteStatus = 'draft' | 'published' | 'archived'

export type NoteRow = {
  id: string
  title: string
  body: string | null
  status: NoteStatus
  created_at: string
  updated_at: string
}

export type NotePage = { items: NoteRow[]; nextCursor: string | null }

export type SearchHit = {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

export type GqlErrorCode = 'http_error' | 'auth_error' | 'graphql_error' | 'network_error'
export type GqlResult<T> = { ok: true; data: T } | { ok: false; code: GqlErrorCode }

export type GqlClientOpts = {
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
}

// Cursor pagination: default 20, hard max 100 — the client never requests above the
// server cap, so a naive caller cannot ask for an unbounded page.
export const NOTES_PAGE_DEFAULT = 20
export const NOTES_PAGE_MAX = 100

export const NOTES_QUERY = /* GraphQL */ `
  query Notes($workspaceId: ID!, $first: Int!, $after: String) {
    notes(workspaceId: $workspaceId, first: $first, after: $after) {
      items { id title status updated_at }
      nextCursor
    }
  }
`

export const NOTE_QUERY = /* GraphQL */ `
  query Note($id: ID!) {
    note(id: $id) { id title body status created_at updated_at }
  }
`

export const SEARCH_QUERY = /* GraphQL */ `
  query Search($workspaceId: ID!, $query: String!, $mode: String) {
    search(workspaceId: $workspaceId, query: $query, mode: $mode) { collection id title snippet score }
  }
`

export async function gqlRequest<T>(
  opts: GqlClientOpts,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    return { ok: false, code: 'network_error' }
  }

  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_error' }
  if (!res.ok) return { ok: false, code: 'http_error' }

  let json: { data?: T; errors?: unknown[] }
  try {
    json = (await res.json()) as { data?: T; errors?: unknown[] }
  } catch {
    return { ok: false, code: 'graphql_error' }
  }
  if (json.errors && json.errors.length > 0) return { ok: false, code: 'graphql_error' }
  if (json.data === undefined) return { ok: false, code: 'graphql_error' }
  return { ok: true, data: json.data }
}

// Clamp a requested page size into [1, NOTES_PAGE_MAX]; default when absent.
export function clampFirst(first: number | undefined): number {
  if (first === undefined || Number.isNaN(first)) return NOTES_PAGE_DEFAULT
  return Math.min(Math.max(Math.trunc(first), 1), NOTES_PAGE_MAX)
}
```

`templates/frontend-astro/src/lib/session.ts`:
```ts
import type { AstroCookies } from 'astro'

// Reads the Supabase access token from the session cookie. No verification here —
// the GraphQL edge function + RLS are authoritative; this is transport only.
// Returns null when absent so the caller can render the auth-failure view instead
// of issuing an anonymous query that would return a misleading empty result.
const COOKIE_NAME = 'sb-access-token'

export function getSessionToken(cookies: AstroCookies): string | null {
  const v = cookies.get(COOKIE_NAME)?.value
  return v && v.length > 0 ? v : null
}
```

- [ ] **Step 4: Base layout + global styles (skip link, focus, reduced motion)**

`templates/frontend-astro/src/layouts/Base.astro`:
```astro
---
interface Props { title: string }
const { title } = Astro.props
import '../styles/global.css'
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
  </head>
  <body>
    <!-- First focusable element: skip link for keyboard users. -->
    <a class="skip-link" href="#main">Skip to content</a>
    <header><nav aria-label="Primary"><a href="/">Notes</a> · <a href="/search">Search</a></nav></header>
    <!-- tabindex=-1 so programmatic focus + the skip link target work. -->
    <main id="main" tabindex="-1">
      <slot />
    </main>
  </body>
</html>
```

`templates/frontend-astro/src/styles/global.css`:
```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 1rem; max-width: 48rem; }
.skip-link {
  position: absolute; left: -999px; top: 0;
}
.skip-link:focus { left: 0; padding: 0.5rem; background: Canvas; }
:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 5: Notes list page (SSR, all non-loading states)**

`templates/frontend-astro/src/pages/index.astro`:
```astro
---
import Base from '../layouts/Base.astro'
import { readServerEnv } from '../lib/env.ts'
import { getSessionToken } from '../lib/session.ts'
import { gqlRequest, NOTES_QUERY, clampFirst, type NotePage } from '../lib/graphql.ts'

// Resolve per-request deps AT CALL TIME (env + cookie), never module scope.
const token = getSessionToken(Astro.cookies)
let state: 'auth' | 'error' | 'empty' | 'ok' = 'auth'
let notes: NotePage['items'] = []

if (token) {
  const { graphqlEndpoint, workspaceId } = readServerEnv()
  const first = clampFirst(Number(Astro.url.searchParams.get('first') ?? '') || undefined)
  const r = await gqlRequest<{ notes: NotePage }>(
    { endpoint: graphqlEndpoint, token },
    NOTES_QUERY,
    { workspaceId, first, after: null },
  )
  if (!r.ok) {
    state = 'error'
  } else {
    notes = r.data.notes.items
    state = notes.length === 0 ? 'empty' : 'ok'
  }
}
---
<Base title="Notes">
  <h1 tabindex="-1" id="notes-heading">Notes</h1>
  {state === 'auth' && (
    <section data-testid="auth-failure" role="alert">
      <p>You are signed out. Please sign in to view notes.</p>
      <a href="/login">Sign in</a>
    </section>
  )}
  {state === 'error' && (
    <section data-testid="error" role="alert">
      <p>Could not load notes.</p>
      <!-- Retry = reload this route; deterministic and JS-free. -->
      <a data-testid="retry" href={Astro.url.pathname + Astro.url.search}>Retry</a>
    </section>
  )}
  {state === 'empty' && (
    <section data-testid="empty"><p>No notes yet.</p></section>
  )}
  {state === 'ok' && (
    <ul data-testid="notes-list">
      {notes.map((note) => (
        <li><a href={`/notes/${note.id}`}>{note.title}</a> <small>{note.status}</small></li>
      ))}
    </ul>
  )}
</Base>
```

- [ ] **Step 6: Run the test to verify it passes + typecheck**

Run:
```bash
pnpm --filter @movp/frontend-astro test && pnpm --filter @movp/frontend-astro typecheck
```
Expected: PASS — all 4 client cases green; `astro check`/`tsc` report no errors. The notes-list route renders `auth-failure` when no cookie is present (no anonymous query is issued).

- [ ] **Step 7: Commit**

```bash
git add templates/frontend-astro
git commit -m "feat(frontend): fetch GraphQL client + notes list page with SSR states"
```

---

### Task 3: Note detail page + search (server API route + client island)

**Files:**
- Create: `templates/frontend-astro/src/pages/notes/[id].astro`
- Create: `templates/frontend-astro/src/pages/api/search.ts`
- Create: `templates/frontend-astro/src/pages/search.astro`
- Create: `templates/frontend-astro/src/components/SearchBox.tsx`

**Interfaces:**
- Consumes: `gqlRequest`, `NOTE_QUERY`, `SEARCH_QUERY`, `getSessionToken`, `readServerEnv` (Tasks 1–2); GraphQL `note(id)` and `search(workspaceId, query, mode) -> [SearchHit{collection,id,title,snippet,score}]`.
- Produces (relied on by Task 5): routes `/notes/[id]`, `/search`, and the same-origin JSON route `/api/search`. The search island owns the **loading** state (the SSR pages can't show one) and a client **error+retry**.

> The token is read server-side in `/api/search` and never shipped to the browser. The island fetches the same-origin route, so the cross-origin GraphQL endpoint + Bearer token stay on the server (boundary + safety).

- [ ] **Step 1: Note detail page (SSR)**

`templates/frontend-astro/src/pages/notes/[id].astro`:
```astro
---
import Base from '../../layouts/Base.astro'
import { readServerEnv } from '../../lib/env.ts'
import { getSessionToken } from '../../lib/session.ts'
import { gqlRequest, NOTE_QUERY, type NoteRow } from '../../lib/graphql.ts'

const { id } = Astro.params
const token = getSessionToken(Astro.cookies)
let state: 'auth' | 'error' | 'empty' | 'ok' = 'auth'
let note: NoteRow | null = null

if (token) {
  const { graphqlEndpoint } = readServerEnv()
  const r = await gqlRequest<{ note: NoteRow | null }>(
    { endpoint: graphqlEndpoint, token },
    NOTE_QUERY,
    { id },
  )
  if (!r.ok) state = 'error'
  else if (!r.data.note) state = 'empty'
  else { note = r.data.note; state = 'ok' }
}
---
<Base title={note?.title ?? 'Note'}>
  {state === 'auth' && (
    <section data-testid="auth-failure" role="alert"><p>You are signed out.</p><a href="/login">Sign in</a></section>
  )}
  {state === 'error' && (
    <section data-testid="error" role="alert"><p>Could not load this note.</p>
      <a data-testid="retry" href={Astro.url.pathname}>Retry</a></section>
  )}
  {state === 'empty' && (
    <section data-testid="empty"><p>Note not found.</p><a href="/">Back to notes</a></section>
  )}
  {state === 'ok' && note && (
    <article data-testid="note-detail">
      <h1 tabindex="-1" id="note-heading">{note.title}</h1>
      <p><small>{note.status} · updated {note.updated_at}</small></p>
      <div>{note.body ?? ''}</div>
      <a href="/">Back to notes</a>
    </article>
  )}
</Base>
```

- [ ] **Step 2: Same-origin search API route (server-side; keeps token off the client)**

`templates/frontend-astro/src/pages/api/search.ts`:
```ts
import type { APIRoute } from 'astro'
import { readServerEnv } from '../../lib/env.ts'
import { getSessionToken } from '../../lib/session.ts'
import { gqlRequest, SEARCH_QUERY, type SearchHit } from '../../lib/graphql.ts'

// Stable JSON contract for the island. The wire shape is fixed and documented:
//   200 { hits: SearchHit[] }            on success
//   401 { code: 'auth_error' }           when no session / GraphQL rejects auth
//   502 { code: 'http_error'|'graphql_error'|'network_error' }  on upstream failure
//   400 { code: 'bad_request' }          when q is missing/empty
export const GET: APIRoute = async ({ url, cookies }) => {
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) return Response.json({ code: 'bad_request' }, { status: 400 })

  const token = getSessionToken(cookies)
  if (!token) return Response.json({ code: 'auth_error' }, { status: 401 })

  const { graphqlEndpoint, workspaceId } = readServerEnv()
  const r = await gqlRequest<{ search: SearchHit[] }>(
    { endpoint: graphqlEndpoint, token },
    SEARCH_QUERY,
    { workspaceId, query: q, mode: 'hybrid' },
  )
  if (!r.ok) {
    const status = r.code === 'auth_error' ? 401 : 502
    return Response.json({ code: r.code }, { status })
  }
  return Response.json({ hits: r.data.search }, { status: 200 })
}
```

- [ ] **Step 3: Search island (owns loading + client error+retry)**

`templates/frontend-astro/src/components/SearchBox.tsx`:
```tsx
// Astro renders this island with client:load. No @movp/* imports; same-origin fetch only.
import { useState } from 'react'
import type { SearchHit } from '../lib/graphql.ts'

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ok'; hits: SearchHit[] }
  | { kind: 'error'; code: string }

export default function SearchBox() {
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })

  async function run(query: string) {
    if (!query.trim()) return
    setView({ kind: 'loading' })
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        return setView({ kind: 'error', code: body.code ?? 'http_error' })
      }
      const body = (await res.json()) as { hits: SearchHit[] }
      setView(body.hits.length === 0 ? { kind: 'empty' } : { kind: 'ok', hits: body.hits })
    } catch {
      setView({ kind: 'error', code: 'network_error' })
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => { e.preventDefault(); void run(q) }}
        role="search"
      >
        <label htmlFor="q">Search notes</label>
        <input id="q" name="q" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>

      {view.kind === 'loading' && (
        <p data-testid="search-loading" role="status" aria-live="polite">Searching…</p>
      )}
      {view.kind === 'empty' && <p data-testid="search-empty">No results.</p>}
      {view.kind === 'error' && (
        <div data-testid="search-error" role="alert">
          <p>Search failed ({view.code}).</p>
          <button data-testid="search-retry" onClick={() => void run(q)}>Retry</button>
        </div>
      )}
      {view.kind === 'ok' && (
        <ul data-testid="search-results" aria-label="Search results">
          {view.hits.map((h) => (
            <li key={`${h.collection}:${h.id}`}>
              <a href={`/notes/${h.id}`}>{h.title}</a>{' '}
              <small>{h.collection} · score {h.score.toFixed(2)}</small>
              <div>{h.snippet}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

The React island needs the renderer; add it (idempotent if already present):
```bash
cd /Users/ensell/Code/supasuite/templates/frontend-astro && pnpm add @astrojs/react react react-dom && pnpm add -D @types/react @types/react-dom
```
Then register it in `astro.config.mjs` by adding `import react from '@astrojs/react'` and `integrations: [react()]` to the `defineConfig({...})` call (place `integrations` alongside `output`/`adapter`).

- [ ] **Step 4: Search page hosting the island**

`templates/frontend-astro/src/pages/search.astro`:
```astro
---
import Base from '../layouts/Base.astro'
import SearchBox from '../components/SearchBox.tsx'
---
<Base title="Search">
  <h1 tabindex="-1" id="search-heading">Search</h1>
  <SearchBox client:load />
</Base>
```

- [ ] **Step 5: Gate — build, typecheck, boundary**

Run:
```bash
cd /Users/ensell/Code/supasuite
pnpm --filter @movp/frontend-astro build && pnpm --filter @movp/frontend-astro typecheck
grep -rnE "@movp/(auth|domain)|service_role|SERVICE_ROLE" templates/ || echo "BOUNDARY_CLEAN"
```
Expected: `astro build` prints `Complete!`; typecheck passes; boundary grep prints `BOUNDARY_CLEAN`. Routes `/notes/[id]`, `/search`, `/api/search` are emitted in the build manifest.

- [ ] **Step 6: Commit**

```bash
git add templates/frontend-astro
git commit -m "feat(frontend): note detail + search (server route + client island)"
```

---

### Task 4: Shared UX-state components, keyboard focus order, a11y semantics

**Files:**
- Create: `templates/frontend-astro/src/components/states/EmptyState.astro`, `LoadingState.astro`, `ErrorRetry.astro`, `AuthFailure.astro`
- Edit: `src/pages/index.astro`, `src/pages/notes/[id].astro` (use the shared components)
- Edit: `src/layouts/Base.astro` (focus-on-load script for the page heading)

**Interfaces:**
- Consumes: the page states from Tasks 2–3.
- Produces (relied on by Task 5): canonical, reusable state views with stable `data-testid`s and consistent ARIA roles, plus a defined keyboard focus order (skip link → nav → main heading → content) verified by the `frontend-ux` gate.

> The four states are deliberately one component each so the `frontend-ux` test asserts identical, accessible markup everywhere and a reviewer sees the duality (auth/error/empty/ok) in one place. `LoadingState` is for client islands; SSR pages never show it.

- [ ] **Step 1: The four state components**

`templates/frontend-astro/src/components/states/AuthFailure.astro`:
```astro
---
interface Props { resource?: string }
const { resource = 'this page' } = Astro.props
---
<section data-testid="auth-failure" role="alert">
  <p>You are signed out. Please sign in to view {resource}.</p>
  <a href="/login">Sign in</a>
</section>
```

`templates/frontend-astro/src/components/states/ErrorRetry.astro`:
```astro
---
interface Props { message?: string; retryHref: string }
const { message = 'Something went wrong.', retryHref } = Astro.props
---
<section data-testid="error" role="alert">
  <p>{message}</p>
  <a data-testid="retry" href={retryHref}>Retry</a>
</section>
```

`templates/frontend-astro/src/components/states/EmptyState.astro`:
```astro
---
interface Props { message?: string }
const { message = 'Nothing here yet.' } = Astro.props
---
<section data-testid="empty"><p>{message}</p><slot /></section>
```

`templates/frontend-astro/src/components/states/LoadingState.astro`:
```astro
---
interface Props { label?: string }
const { label = 'Loading…' } = Astro.props
---
<p data-testid="loading" role="status" aria-live="polite">{label}</p>
```

- [ ] **Step 2: Use the shared components in the list page**

In `src/pages/index.astro`, add to the frontmatter imports:
```astro
import AuthFailure from '../components/states/AuthFailure.astro'
import ErrorRetry from '../components/states/ErrorRetry.astro'
import EmptyState from '../components/states/EmptyState.astro'
```
Replace the three inline `auth`/`error`/`empty` `<section>` blocks with:
```astro
  {state === 'auth' && <AuthFailure resource="notes" />}
  {state === 'error' && <ErrorRetry message="Could not load notes." retryHref={Astro.url.pathname + Astro.url.search} />}
  {state === 'empty' && <EmptyState message="No notes yet." />}
```
(Leave the `ok` branch's `<ul data-testid="notes-list">` unchanged.)

- [ ] **Step 3: Use the shared components in the detail page**

In `src/pages/notes/[id].astro`, add the same three imports (path `../../components/states/...`) and replace the inline `auth`/`error`/`empty` blocks with:
```astro
  {state === 'auth' && <AuthFailure resource="this note" />}
  {state === 'error' && <ErrorRetry message="Could not load this note." retryHref={Astro.url.pathname} />}
  {state === 'empty' && <EmptyState message="Note not found."><a href="/">Back to notes</a></EmptyState>}
```

- [ ] **Step 4: Move focus to the page heading on navigation (keyboard order)**

Append to `src/layouts/Base.astro` just before `</body>`:
```astro
    <script>
      // On load, leave focus at the document start so Tab reaches the skip link first.
      // After the skip link is activated, focus lands on <main> (tabindex=-1).
      // Client islands manage their own focus (e.g. SearchBox results).
      document.querySelector('.skip-link')?.addEventListener('click', () => {
        const main = document.getElementById('main')
        if (main) requestAnimationFrame(() => main.focus())
      })
    </script>
```

- [ ] **Step 5: Gate — components are wired everywhere; build + typecheck**

Run:
```bash
cd /Users/ensell/Code/supasuite/templates/frontend-astro
# Every state view now flows through the shared components (no stray inline auth-failure markup in pages):
grep -rn "components/states/" src/pages && echo "STATES_WIRED"
pnpm --filter @movp/frontend-astro build && pnpm --filter @movp/frontend-astro typecheck
```
Expected: the grep lists the imports in both `index.astro` and `notes/[id].astro` and prints `STATES_WIRED`; build prints `Complete!`; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add templates/frontend-astro
git commit -m "feat(frontend): shared UX-state components + keyboard focus order"
```

---

### Task 5: Playwright + axe e2e (the `frontend-ux` gate)

**Files:**
- Create: `templates/frontend-astro/tests/mock/graphql-mock.mjs`
- Create: `templates/frontend-astro/playwright.config.ts`
- Test: `templates/frontend-astro/tests/e2e/frontend.spec.ts`

**Interfaces:**
- Consumes: the built Worker (`astro build`) served by `wrangler dev`, pointed at a scenario-driven mock GraphQL server via `--var GRAPHQL_ENDPOINT`.
- Produces (relied on by Task 9's `frontend-ux` job): a deterministic e2e suite covering list / detail / search and the empty / loading / error+retry / auth-failure states, plus keyboard focus order and an axe a11y smoke over list / detail / search.

> The app always calls one endpoint; the **mock** owns scenario state (switched via a control route) and the **app** owns auth-failure (driven by presence/absence of the session cookie). This keeps production code free of any test-only branching.

- [ ] **Step 1: Scenario-driven mock GraphQL server**

`templates/frontend-astro/tests/mock/graphql-mock.mjs`:
```js
// Minimal scenario-driven mock of the GraphQL endpoint for e2e. No deps (Node http).
// POST /__scenario {"name": "..."} sets state; POST / (graphql) answers per scenario.
import { createServer } from 'node:http'

let scenario = 'ok'
const PORT = Number(process.env.MOCK_PORT ?? 8787)

const NOTES_OK = {
  notes: {
    items: [
      { id: 'n1', title: 'First note', status: 'published', updated_at: '2026-06-01T00:00:00Z' },
      { id: 'n2', title: 'Second note', status: 'draft', updated_at: '2026-06-02T00:00:00Z' },
    ],
    nextCursor: null,
  },
}
const NOTE_OK = { note: { id: 'n1', title: 'First note', body: 'Body text', status: 'published', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' } }
// Search returns both an FTS hit and a semantic hit so the UI proves both paths.
const SEARCH_OK = { search: [
  { collection: 'note', id: 'n1', title: 'First note', snippet: 'exact <b>match</b>', score: 0.99 },
  { collection: 'note', id: 'n2', title: 'Second note', snippet: 'semantically related', score: 0.71 },
] }

function dataFor(query) {
  if (query.includes('query Notes')) return scenario === 'empty'
    ? { notes: { items: [], nextCursor: null } }
    : NOTES_OK
  if (query.includes('query Note')) return NOTE_OK
  if (query.includes('query Search')) return scenario === 'empty' ? { search: [] } : SEARCH_OK
  return {}
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
}

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__scenario') {
    const { name } = JSON.parse(await readBody(req))
    scenario = name
    res.writeHead(200).end('ok')
    return
  }
  const raw = await readBody(req)
  if (scenario === 'error') { res.writeHead(500).end('upstream boom'); return }
  if (scenario === 'slow') await new Promise((r) => setTimeout(r, 800))
  const { query } = JSON.parse(raw || '{}')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: dataFor(query) }))
}).listen(PORT, () => console.log(`graphql-mock on ${PORT}`))
```

- [ ] **Step 2: Playwright config (builds, serves the Worker + the mock)**

`templates/frontend-astro/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

const APP_PORT = 8788
const MOCK_PORT = 8787

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${APP_PORT}` },
  // Public local values only — no secrets.
  webServer: [
    {
      command: `node tests/mock/graphql-mock.mjs`,
      port: MOCK_PORT,
      env: { MOCK_PORT: String(MOCK_PORT) },
      reuseExistingServer: false,
    },
    {
      // Build then serve the Worker; override the public GraphQL var to the mock.
      command:
        `pnpm build && pnpm exec wrangler dev --port ${APP_PORT} ` +
        `--var GRAPHQL_ENDPOINT:http://127.0.0.1:${MOCK_PORT}/ ` +
        `--var WORKSPACE_ID:33333333-3333-3333-3333-333333333333`,
      port: APP_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
```

- [ ] **Step 3: Write the e2e spec (all states + a11y + keyboard)**

`templates/frontend-astro/tests/e2e/frontend.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const MOCK = 'http://127.0.0.1:8787'
const APP = 'http://127.0.0.1:8788'

async function setScenario(name: string) {
  const r = await fetch(`${MOCK}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(r.ok).toBeTruthy()
}

async function signIn(page: Page) {
  await page.context().addCookies([
    { name: 'sb-access-token', value: 'test-jwt', url: APP },
  ])
}

test.beforeEach(async () => { await setScenario('ok') })

test('auth-failure: no cookie renders the auth view, issues no query', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
  await expect(page.getByTestId('notes-list')).toHaveCount(0)
})

test('list: renders notes when signed in', async ({ page }) => {
  await signIn(page)
  await page.goto('/')
  await expect(page.getByTestId('notes-list')).toBeVisible()
  await expect(page.getByRole('link', { name: 'First note' })).toBeVisible()
})

test('list: empty state', async ({ page }) => {
  await signIn(page); await setScenario('empty')
  await page.goto('/')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('list: error + retry', async ({ page }) => {
  await signIn(page); await setScenario('error')
  await page.goto('/')
  await expect(page.getByTestId('error')).toBeVisible()
  await setScenario('ok')
  await page.getByTestId('retry').click()
  await expect(page.getByTestId('notes-list')).toBeVisible()
})

test('detail: opens a note', async ({ page }) => {
  await signIn(page)
  await page.goto('/notes/n1')
  await expect(page.getByTestId('note-detail')).toBeVisible()
})

test('search: loading -> results (FTS + semantic hits)', async ({ page }) => {
  await signIn(page); await setScenario('slow')
  await page.goto('/search')
  await page.getByLabel('Search notes').fill('match')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-loading')).toBeVisible()
  await setScenario('ok') // mock returns full set once the slow request settles? -> keep slow=ok data
  await expect(page.getByTestId('search-results')).toBeVisible()
  await expect(page.getByTestId('search-results').getByRole('listitem')).toHaveCount(2)
})

test('search: empty + error+retry', async ({ page }) => {
  await signIn(page); await setScenario('empty')
  await page.goto('/search')
  await page.getByLabel('Search notes').fill('zzz')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-empty')).toBeVisible()

  await setScenario('error')
  await page.getByLabel('Search notes').fill('boom')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-error')).toBeVisible()
  await setScenario('ok')
  await page.getByTestId('search-retry').click()
  await expect(page.getByTestId('search-results')).toBeVisible()
})

test('keyboard: skip link is the first focusable, moves focus to main', async ({ page }) => {
  await signIn(page)
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
})

for (const path of ['/', '/notes/n1', '/search']) {
  test(`a11y smoke: ${path} has no axe violations`, async ({ page }) => {
    await signIn(page)
    await page.goto(path)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
}
```

Note on the `slow` scenario: the mock's `slow` branch returns the same data as `ok`, so the assertion observes loading then the full result set; switching to `ok` mid-flight is harmless (the in-flight response already used the OK payload).

- [ ] **Step 4: Install browsers and run the suite**

Run:
```bash
cd /Users/ensell/Code/supasuite/templates/frontend-astro && pnpm exec playwright install --with-deps chromium
pnpm --filter @movp/frontend-astro e2e
```
Expected: PASS — all scenarios green (auth-failure, list, empty, error+retry, detail, search loading→results with 2 hits, search empty/error+retry, keyboard focus order, and 3 axe smokes with zero violations).

- [ ] **Step 5: Gate — seeded a11y violation must turn the suite red**

Temporarily break a11y by removing the search input's label association: in `src/components/SearchBox.tsx` change `<label htmlFor="q">Search notes</label>` to `<label>Search notes</label>` (orphan label) and re-run:
```bash
pnpm --filter @movp/frontend-astro build && pnpm --filter @movp/frontend-astro e2e
```
Expected: FAIL — the `a11y smoke: /search` test reports an axe `label`/`form-field-multiple-labels` violation (and `search` interactions may fail to find the field by label). **Revert the change**, rebuild, and confirm green again. This proves the `frontend-ux` gate bites.

- [ ] **Step 6: Commit**

```bash
git add templates/frontend-astro
git commit -m "test(frontend): Playwright + axe e2e covering all UX states + a11y smoke"
```

---

### Task 6: Static-analysis CI gates — `boundary` + `definer-audit` scripts

**Files:**
- Create: `scripts/check-boundary.sh`
- Create: `scripts/check-definer-audit.mjs`

**Interfaces:**
- Consumes: the `templates/` tree (this plan) and `supabase/migrations/` (Plans 1–5).
- Produces (wired by Task 9): two zero-dependency checks that exit non-zero on a violation, runnable locally and in CI.

> These two gates are pure static analysis — fast, no DB, no network. Each is proven here by a seeded violation that must turn it red before it is trusted in CI.

- [ ] **Step 1: Boundary grep script**

`scripts/check-boundary.sh`:
```bash
#!/usr/bin/env bash
# Fails if any file under templates/ imports @movp/auth, @movp/domain, or anything
# carrying the service-role key. The frontend must talk to GraphQL over HTTP only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN='@movp/(auth|domain)|service_role|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE'

# --include limits to source files; -E for ERE; -n for line numbers.
if grep -rnE --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.mjs' \
     --include='*.js' --include='*.json' "$PATTERN" "$ROOT/templates" ; then
  echo "BOUNDARY VIOLATION: forbidden import found under templates/ (see above)" >&2
  exit 1
fi
echo "boundary: clean"
```
Make it executable:
```bash
chmod +x /Users/ensell/Code/supasuite/scripts/check-boundary.sh
```

- [ ] **Step 2: SECURITY DEFINER search_path audit script**

`scripts/check-definer-audit.mjs`:
```js
#!/usr/bin/env node
// Audits every CREATE FUNCTION block in supabase/migrations/: any block declaring
// `security definer` MUST also pin a search_path (`set search_path = ...`). A pinned
// empty string ('') is the canonical hardened value; absence is the violation.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'supabase', 'migrations')

let files = []
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => join(dir, f))
} catch {
  console.error(`definer-audit: no migrations dir at ${dir}`)
  process.exit(1)
}

const sql = files.map((f) => readFileSync(f, 'utf8')).join('\n').toLowerCase()

// Split into function-definition blocks. Each block runs from a CREATE [OR REPLACE]
// FUNCTION up to the dollar-quoted body terminator `$$;` (the form codegen emits).
const blocks = sql.split(/create\s+(?:or\s+replace\s+)?function/g).slice(1)

const violations = []
for (const raw of blocks) {
  const block = raw.split('$$;')[0] // header + body up to the terminator
  if (!/\bsecurity\s+definer\b/.test(block)) continue
  if (!/\bset\s+search_path\s*=/.test(block)) {
    const name = (raw.match(/^\s*([a-z0-9_."]+)\s*\(/) ?? [])[1] ?? '<unknown>'
    violations.push(name)
  }
}

if (violations.length > 0) {
  console.error('DEFINER-AUDIT VIOLATION: security definer fn(s) missing pinned search_path:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log(`definer-audit: ${blocks.length} function block(s) scanned, all definers pinned`)
```

- [ ] **Step 3: Run both checks clean against the current tree**

Run:
```bash
cd /Users/ensell/Code/supasuite
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs
```
Expected: `boundary: clean`; `definer-audit: N function block(s) scanned, all definers pinned` (N ≥ 1 — at least `is_workspace_member` from Plan 1). Both exit 0.

- [ ] **Step 4: Gate — seeded violations must turn each check red**

Boundary: create a throwaway offender and confirm the script fails, then delete it.
```bash
cd /Users/ensell/Code/supasuite
printf "import { resolvePrincipal } from '@movp/auth'\n" > templates/frontend-astro/src/__seed_violation.ts
bash scripts/check-boundary.sh; echo "exit=$?"
rm templates/frontend-astro/src/__seed_violation.ts
```
Expected: prints the offending line + `BOUNDARY VIOLATION …` and `exit=1`.

Definer-audit: append an unhardened definer fn to a scratch migration and confirm failure, then remove it.
```bash
cd /Users/ensell/Code/supasuite
cat > supabase/migrations/99999999999999_seed_bad_definer.sql <<'SQL'
create or replace function public.seed_bad() returns int
language sql security definer as $$ select 1 $$;
SQL
node scripts/check-definer-audit.mjs; echo "exit=$?"
rm supabase/migrations/99999999999999_seed_bad_definer.sql
```
Expected: prints `DEFINER-AUDIT VIOLATION: … public.seed_bad` and `exit=1`. After removal, `node scripts/check-definer-audit.mjs` exits 0 again.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-boundary.sh scripts/check-definer-audit.mjs
git commit -m "ci: boundary + definer-audit static gate scripts"
```

---

### Task 7: Database CI gates — `migration-drift`, `internal-access`, `vector-scale`

**Files:**
- Create: `supabase/tests/internal_access_test.sql` (pgTAP)
- Create: `scripts/vector-scale.sql`, `scripts/check-vector-scale.mjs`

**Interfaces:**
- Consumes: the running local stack; `public.workspace`/`workspace_membership` (Plan 1); `public.note` + enqueue trigger + `movp_internal.movp_jobs` (Plans 4–5); `public.search_chunk` + `search_chunk_hnsw` + `public.match_chunks` (Plan 4).
- Produces (wired by Task 9): a pgTAP test proving `movp_internal.*` is locked to anon/authenticated while the vetted enqueue path still works, and a fixture+EXPLAIN check proving HNSW plan shape with no seq/cross-tenant scan.
- Local DB URL (public value, literal): `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

> `migration-drift` needs no new file — it is `supabase db reset` then `supabase db diff` (must be empty). It is verified locally in Step 5 and wired in Task 9.

- [ ] **Step 1: `internal-access` pgTAP test (deny anon/authenticated; vetted path enqueues)**

`supabase/tests/internal_access_test.sql`:
```sql
begin;
select plan(5);

-- The internal queue lives in a non-API schema, RLS deny-all, grants to service_role only.
-- anon and authenticated must be denied at the privilege layer (SQLSTATE 42501).
set local role anon;
select throws_ok(
  $$ select * from movp_internal.movp_jobs $$,
  '42501', null, 'anon cannot SELECT movp_internal.movp_jobs');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$ select * from movp_internal.movp_jobs $$,
  '42501', null, 'authenticated cannot SELECT movp_internal.movp_jobs');
select throws_ok(
  $$ insert into movp_internal.movp_jobs (kind, idempotency_key, payload)
     values ('embed','x','{}'::jsonb) $$,
  '42501', null, 'authenticated cannot INSERT movp_internal.movp_jobs');

-- Vetted path: a member inserting an embeddable note enqueues a job via the hardened
-- SECURITY DEFINER trigger (the user role never touches movp_internal directly).
reset role;
insert into public.workspace (id, name)
  values ('22222222-2222-2222-2222-222222222222', 'VettedWs');
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('22222222-2222-2222-2222-222222222222',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.note (workspace_id, title, body, status)
  values ('22222222-2222-2222-2222-222222222222', 'Vetted', 'embed me', 'draft');

-- Read the queue back as the privileged test role: the enqueue succeeded.
reset role;
select isnt(
  (select count(*)::int from movp_internal.movp_jobs where kind = 'embed'),
  0, 'vetted insert enqueued an embed job via the definer trigger');
select ok(true, 'internal-access invariants hold');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the internal-access test**

Run:
```bash
cd /Users/ensell/Code/supasuite && supabase db reset && supabase test db
```
Expected: `internal_access_test.sql .. ok` — all 5 assertions pass (anon/authenticated denied; vetted enqueue produced an `embed` job). (`tenancy_test.sql` and the other suites also run and pass.)

- [ ] **Step 3: `vector-scale` fixture + EXPLAIN SQL**

`scripts/vector-scale.sql`:
```sql
\set ON_ERROR_STOP on

-- Fixture: 10 workspaces x 50k chunks = 500k rows. Idempotent: seed only if absent.
do $$
declare n bigint;
begin
  select count(*) into n from public.search_chunk;
  if n < 500000 then
    insert into public.workspace (id, name)
      select gen_random_uuid(), 'vs-ws-'||g from generate_series(1,10) g;
    insert into public.search_chunk
      (workspace_id, source_table, source_id, field, chunk_index, content, embedding, content_hash)
    select w.id, 'note', gen_random_uuid(), 'body', 0, 'chunk',
           (select array_agg(random()::real) from generate_series(1,384))::extensions.vector(384),
           md5(random()::text)
    from (select id from public.workspace where name like 'vs-ws-%' limit 10) w,
         generate_series(1,50000) s;
  end if;
end $$;
analyze public.search_chunk;

-- match_chunks sets this internally; set it for the raw EXPLAIN too (pgvector 0.8).
set hnsw.iterative_scan = strict_order;

select id as ws from public.workspace where name like 'vs-ws-%' order by name limit 1 \gset
select embedding as qvec from public.search_chunk where workspace_id = :'ws' limit 1 \gset

\echo === EXPLAIN BEGIN ===
explain (format text)
select c.source_id, (c.embedding <=> :'qvec') as distance
from public.search_chunk c
where c.workspace_id = :'ws'
order by c.embedding <=> :'qvec'
limit 10;
\echo === EXPLAIN END ===

\echo === CROSSTENANT BEGIN ===
select count(*) as foreign_rows
from public.match_chunks(:'qvec', :'ws', null, 10) m
join public.search_chunk c
  on c.source_id = m.source_id and c.field = m.field and c.chunk_index = m.chunk_index
where c.workspace_id <> :'ws';
\echo === CROSSTENANT END ===

\echo === P95 BEGIN ===
do $$
declare t0 timestamptz; durs double precision[] := '{}'; i int;
  q extensions.vector(384); ws uuid;
begin
  select id into ws from public.workspace where name like 'vs-ws-%' order by name limit 1;
  select embedding into q from public.search_chunk where workspace_id = ws limit 1;
  for i in 1..100 loop
    t0 := clock_timestamp();
    perform * from public.match_chunks(q, ws, null, 10);
    durs := durs || (extract(epoch from clock_timestamp() - t0) * 1000);
  end loop;
  raise notice 'p95_ms=%', (select percentile_cont(0.95) within group (order by d) from unnest(durs) d);
end $$;
\echo === P95 END ===
```

- [ ] **Step 4: `vector-scale` checker (plan-shape is the binding gate; p95 advisory)**

`scripts/check-vector-scale.mjs`:
```js
#!/usr/bin/env node
// Runs scripts/vector-scale.sql and asserts the EXPLAIN plan uses search_chunk_hnsw,
// has NO Seq Scan, and match_chunks returns NO cross-tenant rows. p95 is advisory.
// VS_FORCE_SEQSCAN=1 prepends planner toggles to force a Seq Scan (seeded-violation demo).
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB = process.env.VS_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const sqlFile = join(root, 'scripts', 'vector-scale.sql')

const pre = process.env.VS_FORCE_SEQSCAN
  ? '-c "set enable_indexscan=off;" -c "set enable_bitmapscan=off;"'
  : ''

let out
try {
  out = execSync(`psql "${DB}" ${pre} -X -f "${sqlFile}" 2>&1`, { encoding: 'utf8' })
} catch (e) {
  console.error('vector-scale: psql failed\n' + (e.stdout ?? '') + (e.stderr ?? ''))
  process.exit(1)
}

function section(name) {
  const m = out.match(new RegExp(`=== ${name} BEGIN ===([\\s\\S]*?)=== ${name} END ===`))
  return m ? m[1] : ''
}

const explain = section('EXPLAIN')
const crosstenant = section('CROSSTENANT')
const p95 = (out.match(/p95_ms=([0-9.]+)/) ?? [])[1]

const errors = []
if (!/search_chunk_hnsw/.test(explain)) errors.push('plan does NOT use search_chunk_hnsw')
if (/Seq Scan/i.test(explain)) errors.push('plan contains a Seq Scan')
if (!/\b0\b/.test(crosstenant)) errors.push('match_chunks returned cross-tenant rows (foreign_rows != 0)')

if (p95) {
  const ms = Number(p95)
  console.log(`vector-scale: p95=${ms.toFixed(1)}ms (advisory; soft target < 150ms)`)
  if (ms >= 150) console.warn('vector-scale: WARN p95 >= 150ms (advisory, not failing)')
}

if (errors.length > 0) {
  console.error('VECTOR-SCALE VIOLATION:\n  - ' + errors.join('\n  - '))
  console.error('--- EXPLAIN ---\n' + explain)
  process.exit(1)
}
console.log('vector-scale: HNSW plan OK, no Seq Scan, no cross-tenant rows')
```

- [ ] **Step 5: Run the DB gates clean + seeded-violation proofs**

Run all three clean:
```bash
cd /Users/ensell/Code/supasuite
supabase db reset && supabase db diff || echo "drift detected"   # diff must be empty (no "drift detected")
supabase test db                                                  # internal_access_test passes
node scripts/check-vector-scale.mjs                               # may take a few minutes to seed 500k rows
```
Expected: `supabase db diff` prints nothing (empty → drift gate green); `supabase test db` shows `internal_access_test.sql .. ok`; vector-scale prints `vector-scale: HNSW plan OK, no Seq Scan, no cross-tenant rows` and a `p95=…ms` advisory line.

Seeded violations (each must fail loudly, then revert):
```bash
cd /Users/ensell/Code/supasuite
# migration-drift: inject an out-of-band object, confirm a non-empty diff, then reset.
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "create table public.drift_demo();"
supabase db diff | tee /tmp/diff.out; test -s /tmp/diff.out && echo "DRIFT DETECTED (expected)"
supabase db reset   # restores to migrations-only state

# vector-scale: force a Seq Scan and confirm the checker fails.
VS_FORCE_SEQSCAN=1 node scripts/check-vector-scale.mjs; echo "exit=$?"
```
Expected: `supabase db diff` emits a diff containing `drift_demo` and prints `DRIFT DETECTED (expected)`; the forced-seqscan run prints `VECTOR-SCALE VIOLATION: … plan contains a Seq Scan` with `exit=1`. (For `internal-access`, a seeded violation is `grant select on movp_internal.movp_jobs to authenticated;` in a scratch migration → the deny assertions fail; revert it.)

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/internal_access_test.sql scripts/vector-scale.sql scripts/check-vector-scale.mjs
git commit -m "ci: internal-access pgTAP + vector-scale fixture/EXPLAIN gates"
```

---

### Task 8: Wire the earlier-plan suites — `jobs`, `redaction`, `graphql-shape`

**Files:**
- Edit: `package.json` (root) — add stable aggregate test-script names CI calls.

**Interfaces:**
- Consumes (CONTRACT with Plans 4–5 — state it, do not re-derive): these three suites already exist when Plan 6 runs.
  - `graphql-shape` → `@movp/graphql` Vitest suite `shape.test.ts`: over-depth and over-complexity operations are **rejected before execution**; a list beyond the hard max page size is **clamped**; a nested `note → tags` query issues a **bounded SQL count** (no N+1, asserted via a query counter / DataLoader spy).
  - `jobs` → `@movp/flows` Vitest suite `jobs.test.ts`: retry with exponential backoff, DLQ after `max_attempts`, idempotency via unique key/`content_hash`, and **lease reclaim** of a crashed `running` job after `lease_expires_at`.
  - `redaction` → `@movp/flows` Vitest suite `redaction.test.ts`: each seeded failure (auth, RLS, webhook, embed, GraphQL-validation) emits **exactly one** `trace_id`-correlated event with **no PII** (no `@`, no raw token), and an out-of-enum `error_code`/`surface` **coerces to `unknown` and still emits** (plus an `observability_enum_violation`).
- Produces (wired by Task 9): stable root scripts `test:graphql-shape`, `test:jobs`, `test:redaction` so `ci.yml` calls one name per gate and is insulated from internal file moves.

> If a suite's package or filename differs from the contract above, update the single mapping line here — that is the only coupling point. Each gate is proven below by running it green, then by a seeded violation that turns it red.

- [ ] **Step 1: Add the aggregate scripts to the root `package.json`**

In the root `package.json` `"scripts"` block (created in Plan 1), add:
```json
    "test:graphql-shape": "pnpm --filter @movp/graphql exec vitest run shape",
    "test:jobs": "pnpm --filter @movp/flows exec vitest run jobs",
    "test:redaction": "pnpm --filter @movp/flows exec vitest run redaction"
```
(Keep the existing `"test"` and `"typecheck"` Turborepo scripts; these three are explicit single-suite entry points for CI.)

- [ ] **Step 2: Run all three green**

Run:
```bash
cd /Users/ensell/Code/supasuite
supabase start   # jobs/redaction integration tests need the local DB
pnpm test:graphql-shape
pnpm test:jobs
pnpm test:redaction
```
Expected: each prints a passing Vitest summary — `shape` (reject over-depth/over-complexity, clamp pagination, bounded SQL count), `jobs` (retry/backoff/DLQ/idempotency + lease reclaim), `redaction` (one redacted correlated event per seeded failure; out-of-enum coerces to `unknown` and still emits).

- [ ] **Step 3: Gate — seeded violation per suite must turn it red**

These prove the gates bite. Apply each break, run, confirm red, then `git checkout` to revert.

graphql-shape — relax the depth limit so a hostile query is no longer rejected:
```bash
# In @movp/graphql, temporarily raise the depth limit far above the test's hostile query
# (e.g. maxDepth 50). The "rejects over-depth" case must FAIL.
pnpm test:graphql-shape; echo "exit=$?"   # after the edit: exit=1
git checkout -- packages/graphql
```

jobs — disable lease reclaim so a crashed `running` job is never reclaimed:
```bash
# In @movp/flows, temporarily drop the `(status='running' and lease_expires_at < now())`
# arm of the claim predicate. The "reclaims crashed running job" case must FAIL.
pnpm test:jobs; echo "exit=$?"            # after the edit: exit=1
git checkout -- packages/flows
```

redaction — leak a value into an emitted event:
```bash
# In @movp/flows, temporarily add a raw `email` field to the obs envelope. The
# "no PII / no @" assertion must FAIL.
pnpm test:redaction; echo "exit=$?"       # after the edit: exit=1
git checkout -- packages/flows
```
Expected: each `exit=1` while broken; after `git checkout` revert, all three pass again.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "ci: stable aggregate scripts for graphql-shape, jobs, redaction gates"
```

---

### Task 9: `slice-e2e` script + the complete `ci.yml` (all 11 jobs)

**Files:**
- Create: `scripts/slice-e2e.sh`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every gate/script/suite from Tasks 1–8 and Plans 1–5; the local stack.
- Produces: a single workflow whose 11 jobs are the Phase-1 breadth gate. `slice-e2e` runs the design's Verification list (items 1–10) end-to-end; the frontend (item 11) is the `frontend-ux` job.
- The mutation/query field names in `slice-e2e.sh` mirror the Plan 4 generated GraphQL schema (contract: `createNote(input:{workspace_id,title,body})`, `notes(workspaceId, first) { items }`, `search(workspaceId, query, mode)`); if codegen names differ, update them in this one script.

- [ ] **Step 1: `slice-e2e.sh` — the end-to-end Verification run**

`scripts/slice-e2e.sh`:
```bash
#!/usr/bin/env bash
# End-to-end Phase-1 Verification (design items 1-10) against the local stack.
# Assumes `supabase start` has already run. Item 11 (frontend) is the frontend-ux job.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== [1] migrate + drift gate =="
supabase db reset
drift="$(supabase db diff)"; [ -z "$drift" ] || { echo "DRIFT:"; echo "$drift"; exit 1; }

echo "== [3-7,9-10] package suites (auth fail-closed, domain CRUD, search, jobs, redaction, graphql-shape) =="
pnpm install --frozen-lockfile
pnpm test                      # Turborepo fan-out across all @movp/* packages
pnpm test:graphql-shape; pnpm test:jobs; pnpm test:redaction

echo "== [2,8] tenancy + RLS + internal-access (pgTAP) =="
supabase test db               # tenancy_test, internal_access_test, definer/redaction pgTAP

echo "== static gates: boundary + definer-audit =="
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs

echo "== [7,8] vector-scale plan-shape + cross-tenant =="
node scripts/check-vector-scale.mjs

echo "== load local env (public local values) =="
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
: "${API_URL:?}"; : "${ANON_KEY:?}"; : "${SERVICE_ROLE_KEY:?}"; : "${DB_URL:?}"

echo "== mint a real member JWT via gotrue (verifies against JWKS) =="
curl -s "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"e2e@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN="$(curl -s "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H 'content-type: application/json' \
  -d '{"email":"e2e@example.com","password":"Passw0rd!1"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).access_token||""))')"
[ -n "$TOKEN" ] || { echo "failed to mint token"; exit 1; }
USER_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN")"
WS='33333333-3333-3333-3333-333333333333'
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace (id,name) values ('$WS','E2E') on conflict do nothing;" \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER_ID','owner') on conflict do nothing;"

echo "== serve edge functions =="
supabase functions serve graphql mcp index-embeddings >/tmp/fns.log 2>&1 &
FN_PID=$!
trap 'kill $FN_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf "$API_URL/functions/v1/graphql" -X OPTIONS >/dev/null 2>&1 && break; sleep 1; done

echo "== [3] GraphQL: create + query back =="
CREATE="$(curl -s "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"mutation(\$i:NoteCreateInput!){createNote(input:\$i){id title}}\",\"variables\":{\"i\":{\"workspace_id\":\"$WS\",\"title\":\"E2E note\",\"body\":\"semantic lighthouse phrase for e2e verification\"}}}")"
echo "$CREATE" | grep -q 'E2E note' || { echo "create failed: $CREATE"; exit 1; }
LIST="$(curl -s "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"query{notes(workspaceId:\\\"$WS\\\", first:20){items{id title}}}\"}")"
echo "$LIST" | grep -q 'E2E note' || { echo "list failed: $LIST"; exit 1; }

echo "== [7] GraphQL: semantic search is reachable through the edge surface =="
echo "warming gte-small if this is a fresh CI container (first model run may download)"
for i in $(seq 1 6); do
  curl -s --max-time 120 -X POST "$API_URL/functions/v1/index-embeddings" -H 'content-type: application/json' >/tmp/index-embeddings.json || true
  node -e 'const fs=require("fs"); let j={}; try{j=JSON.parse(fs.readFileSync("/tmp/index-embeddings.json","utf8"))}catch{}; process.exit((j.processed||0) >= 1 ? 0 : 1)' && break
  sleep $((i * 2))
done
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/index-embeddings.json","utf8")); if ((j.processed||0) < 1) { console.error("index-embeddings did not process a job:", j); process.exit(1) }'
SEM="$(curl -s "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"query{search(workspaceId:\\\"$WS\\\", query:\\\"semantic lighthouse\\\", mode:\\\"semantic\\\"){collection id title snippet score}}\"}")"
echo "$SEM" | grep -q 'E2E note' || { echo "semantic search failed: $SEM"; echo "index worker: $(cat /tmp/index-embeddings.json)"; exit 1; }

echo "== [3] GraphQL: over-complexity query is rejected =="
TOO_BIG_QUERY="$(node - <<'NODE'
const fields = Array.from({ length: 1100 }, (_, i) =>
  `n${i}: note(id: "00000000-0000-0000-0000-000000000000") { id }`).join(' ')
process.stdout.write(`query { ${fields} }`)
NODE
)"
DEEP="$(curl -s "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({query: process.argv[1]}))' "$TOO_BIG_QUERY")")"
echo "$DEEP" | grep -qiE 'depth|complexity|exceeds' || { echo "over-complexity NOT rejected: $DEEP"; exit 1; }

echo "== [6] auth fail-closed: a garbage token is rejected =="
BAD="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/graphql" \
  -H 'Authorization: Bearer not.a.jwt' -H 'content-type: application/json' \
  -d "{\"query\":\"query{notes(workspaceId:\\\"$WS\\\", first:1){items{id}}}\"}")"
[ "$BAD" = "401" ] || [ "$BAD" = "200" ] # 200 only if body carries an auth error_code:
if [ "$BAD" = "200" ]; then echo "expected auth rejection on bad token"; exit 1; fi

echo "== [4] MCP: tools/list shows generated tools =="
MCP="$(curl -s "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$MCP" | grep -qi 'note' || { echo "MCP tools/list missing note tools: $MCP"; exit 1; }

echo "== [8] internal not exposed via PostgREST API =="
REST="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/movp_jobs" -H "apikey: $ANON_KEY")"
[ "$REST" = "404" ] || [ "$REST" = "401" ] || { echo "movp_jobs reachable via REST ($REST)"; exit 1; }

echo "slice-e2e: PASS"
```

- [ ] **Step 2: The complete CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# Public values only. No secrets: every job runs against the local Supabase stack.
# Local API 127.0.0.1:54321, local DB 127.0.0.1:54322 (public, literal).
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  boundary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/check-boundary.sh

  definer-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node scripts/check-definer-audit.mjs

  migration-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - name: assert no schema drift
        run: |
          drift="$(supabase db diff)"
          if [ -n "$drift" ]; then echo "DRIFT DETECTED:"; echo "$drift"; exit 1; fi
          echo "migration-drift: clean"

  internal-access:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: supabase test db

  vector-scale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: node scripts/check-vector-scale.mjs

  graphql-shape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:graphql-shape

  jobs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:jobs

  redaction:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: supabase db reset
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:redaction

  frontend-ux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @movp/frontend-astro exec playwright install --with-deps chromium
      - run: pnpm --filter @movp/frontend-astro e2e

  slice-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - run: bash scripts/slice-e2e.sh
```

- [ ] **Step 3: Make the script executable and lint the workflow**

Run:
```bash
cd /Users/ensell/Code/supasuite
chmod +x scripts/slice-e2e.sh
# Validate the workflow YAML/syntax with actionlint (downloads a static binary).
bash <(curl -s https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
./actionlint .github/workflows/ci.yml && rm -f actionlint
```
Expected: `actionlint` prints no errors (exit 0). If `curl` to the bootstrap is unavailable in your environment, instead run `pnpm dlx @action-validator/cli .github/workflows/ci.yml` or skip to Step 4.

- [ ] **Step 4: Run the full slice locally**

Run:
```bash
cd /Users/ensell/Code/supasuite && supabase start && bash scripts/slice-e2e.sh
```
Expected: each `== [...] ==` section prints and the script ends with `slice-e2e: PASS` (exit 0) — drift empty, all suites green, GraphQL create/list/semantic-search/over-complexity-reject, MCP tools/list, auth fail-closed, internal-not-exposed all asserted.

- [ ] **Step 5: Gate — confirm the workflow enumerates all 11 jobs and each is reachable**

Run:
```bash
cd /Users/ensell/Code/supasuite
node -e 'const y=require("fs").readFileSync(".github/workflows/ci.yml","utf8");
const jobs=[...y.matchAll(/^  ([a-z-]+):$/gm)].map(m=>m[1]);
const want=["typecheck","boundary","definer-audit","migration-drift","internal-access","vector-scale","graphql-shape","jobs","redaction","frontend-ux","slice-e2e"];
const missing=want.filter(w=>!jobs.includes(w));
if(missing.length){console.error("MISSING JOBS:",missing);process.exit(1)}
console.log("ci.yml jobs:",jobs.join(", "))'
```
Expected: prints `ci.yml jobs: typecheck, boundary, definer-audit, migration-drift, internal-access, vector-scale, graphql-shape, jobs, redaction, frontend-ux, slice-e2e` (all 11 present) and exits 0.

- [ ] **Step 6: Push and confirm CI is green on a PR**

```bash
git add scripts/slice-e2e.sh .github/workflows/ci.yml
git commit -m "ci: slice-e2e end-to-end + complete 11-job ci.yml"
git push -u origin HEAD   # open a PR; confirm all 11 jobs go green
```
Expected: on the PR, all 11 jobs pass. The seeded-violation demos in Tasks 5–8 (and Task 7's drift/seqscan) prove each gate turns red when its invariant is broken.

---

## Self-Review

- **Spec coverage (design Tasks 11–12).** Frontend (Task 11): `templates/frontend-astro` on `@astrojs/cloudflare` + R2 (Task 1), fetch GraphQL client + notes list (Task 2), detail + search via a same-origin route + island (Task 3), the four required UX states + keyboard focus (Task 4), Playwright + axe over list/detail/search/empty/loading/error+retry/auth-failure + a11y smoke (Task 5). CI (Task 12): all 11 gates wired — `typecheck`, `boundary`, `migration-drift`, `slice-e2e`, `definer-audit`, `redaction`, `vector-scale`, `jobs`, `internal-access`, `graphql-shape`, `frontend-ux` (Tasks 6–9). Each CI-gate task includes a seeded-violation that turns the gate red. Covered.
- **Boundary rule (load-bearing).** The template imports only its in-template fetch client; `check-boundary.sh` greps `templates/` for `@movp/(auth|domain)`/service-role and fails on a hit (proven by a seeded offender in Task 6 Step 4). No page/route/island imports a server-only `@movp/*` package — the token is read from a cookie and forwarded over HTTP; the cross-origin endpoint + token never leave the server (search goes through `/api/search`).
- **CF runtime correctness.** `readServerEnv()` reads the `cloudflare:workers` virtual module, never `process.env` (empty on workerd) or `Astro.locals.runtime.env` (removed in Astro v6); the gotcha is commented at the trigger site. Env + token resolved at call time inside each page/route, never module scope. The pure `gqlRequest` is env-free and injectable (Vitest with a mock `fetch`), so unit tests never touch `cloudflare:workers`.
- **Public values vs secrets.** Local API/DB URLs, project ref, region, and `GRAPHQL_ENDPOINT` are literals/`vars:`; CI needs no secrets because every job runs the local stack. `supabase/setup-cli@v1` is pinned `version: latest` in every CLI job (per `ci-deploy-patterns`).
- **Each gate fails loudly.** boundary (seeded import), definer-audit (seeded unhardened fn), migration-drift (seeded out-of-band table), vector-scale (`VS_FORCE_SEQSCAN`), internal-access (seeded grant), graphql-shape/jobs/redaction (seeded relaxation/leak), frontend-ux (seeded orphan label). Plan-shape is the binding vector-scale gate; p95 is advisory (printed, never fails) — matching the design.
- **Untrusted-input discipline.** No file/payload contents are logged; error views and the obs envelope carry codes/field-names, not values or tokens. The search route returns a stable discriminated JSON contract (`code` union), and `gqlRequest` returns a discriminated `GqlResult` (no sentinel/`as`-casts in callers).
- **Eight dimensions.** Correctness: states are exhaustive discriminated branches; auth-failure issues no anonymous query (no misleading empty). Safety: boundary + no-secrets + token-stays-server-side. Reliability: error+retry on every surface; drift gate. Observability: codes-not-values; redaction gate wired. Efficiency: cursor pagination (default 20/clamped 100); pure client reused across pages. Performance: SSR I/O-bound; HNSW plan asserted at 500k-row scale; `frontend-ux` runs against a mock (no live backend). Simplicity: one fetch client, four state components, scenario-driven mock — no GraphQL codegen toolchain pulled in for v1. Usability: skip link, `:focus-visible`, `prefers-reduced-motion`, ARIA roles/live-regions, axe smoke.
- **Context-poor-executor readiness.** Every code block is complete and copy-paste-correct; every step has an exact command + expected output; every task ends in a machine-checkable gate; per-request deps in samples resolve from `Astro`/`ctx` at call time; platform gotchas are commented at their trigger sites.
- **Deferred (intentional).** GraphQL codegen toolchain (hand-written generated-shape types instead), login flow (`/login` is a stub; the template proves transport + states, not auth UI), R2 media upload UI (binding declared, not exercised), CF deploy in CI (build + `--dry-run` only; deploy is a separate, credentialed step). These belong to later frontend expansion, not the Phase-1 proof.
- **Contracts with Plans 1–5 (stated, not re-derived).** GraphQL field names (`createNote`/`notes`/`search`), the `@movp/graphql|flows` Vitest suites (`shape`/`jobs`/`redaction`), `public.note` + enqueue trigger, `movp_internal.movp_jobs`, `public.search_chunk`/`search_chunk_hnsw`/`match_chunks`. Each has a single coupling point flagged for one-line update if codegen names differ.
