# MOVP Stage C1 - OSS Packaging & Onboarding

> Implementation plan for Stage C, Phase C1. Expand and execute task-by-task with TDD.
> This plan changes docs, packaging, template auth, demo seeding, bootstrap, and CI. It
> does not change tenant data-model semantics.

## Goal

A new adopter can clone MOVP Suite, understand the license and architecture, bootstrap the
local stack, log in through the Astro template, see seeded data on every primary surface,
and verify packages are buildable before publishing under `@movp`.

## Architecture

C1 makes the repo externally consumable without weakening the existing platform. The plan
adds public-facing docs and legal files, a real template login flow that sets the existing
`sb-access-token` cookie, an idempotent demo seed, a bootstrap command, package build
metadata, and a quickstart CI job. It preserves the local 64xxx Supabase port isolation
unless C1 proves a safe override strategy.

## Tech Stack

Node 22, pnpm 9.12.0, tsup, TypeScript, Astro 6, Supabase CLI, Playwright, GitHub
Actions, existing scripts (`slice-e2e.sh`, `check-boundary.sh`, `check-forward-only-
migrations.mjs`, `check-vector-scale.mjs`).

## Global Constraints

- **No implementation before failing tests.** Each task starts by adding the named failing
  test/gate and proving its expected failure.
- **No port normalization.** `supabase/config.toml` keeps this repo's 64xxx ports unless
  Task 5 proves a supported override strategy.
- **No secrets in docs or tests.** Demo credentials are local-only. Real tokens stay out of
  files and logs.
- **No generated-file hand edits.** C1 should not touch
  `20260701000002_movp_generated.sql` or generated TypeScript.
- **AGENTS/CLAUDE convention.** Root `CLAUDE.md` becomes the real file; `AGENTS.md` becomes
  a relative symlink to it.
- **Package publishing is preflighted, not performed.** C1 proves package artifacts and npm
  auth/scope access checks. It does not publish.
- **One-command bootstrap is additive.** It may wrap existing commands but must not hide
  failing gates.

## File Structure

```text
LICENSE                              # NEW Apache-2.0
README.md                            # NEW public README
CONTRIBUTING.md                      # NEW
SECURITY.md                          # NEW
CLAUDE.md                            # NEW canonical agent instructions
AGENTS.md                            # REPLACE with symlink to CLAUDE.md
package.json                         # UPDATE scripts/dev deps
packages/*/package.json              # UPDATE exports/files/build metadata
packages/*/tsup.config.ts            # NEW or shared config if chosen
scripts/
  check-docs-presence.mjs            # NEW
  check-package-artifacts.mjs        # NEW
  check-release-preflight.mjs        # NEW
  seed-demo.ts                       # NEW
  bootstrap.mjs                      # NEW
  check-quickstart-docs.mjs          # NEW
templates/frontend-astro/src/
  pages/login.astro                  # NEW
  pages/auth/callback.astro          # NEW
  lib/auth.ts                        # NEW
templates/frontend-astro/tests/e2e/
  login.spec.ts                      # NEW
.github/workflows/ci.yml             # UPDATE quickstart job
docs/
  quickstart.md                      # NEW
```

## Task 1: Legal, README, and agent-instruction baseline

**Files**

- Create: `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CLAUDE.md`,
  `scripts/check-docs-presence.mjs`
- Replace: `AGENTS.md` with a relative symlink to `CLAUDE.md`
- Update: `.github/workflows/ci.yml`, root `package.json`

**Interfaces**

- Produces root script:

```json
"check:docs": "node scripts/check-docs-presence.mjs"
```

- Produces canonical instruction file:

```text
CLAUDE.md        # real file
AGENTS.md        # symlink -> CLAUDE.md
```

**TDD steps**

- [ ] Add `scripts/check-docs-presence.mjs` first. It must fail while the public files are
  absent and while `AGENTS.md` is not a symlink to `CLAUDE.md`.

Use this core script:

```js
import { lstatSync, readlinkSync, existsSync } from 'node:fs'

const required = ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md']
const missing = required.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`missing required docs: ${missing.join(', ')}`)
  process.exit(1)
}

let stat
try {
  stat = lstatSync('AGENTS.md')
} catch {
  console.error('AGENTS.md must be a relative symlink to CLAUDE.md')
  process.exit(1)
}

if (!stat.isSymbolicLink() || readlinkSync('AGENTS.md') !== 'CLAUDE.md') {
  console.error('AGENTS.md must be a relative symlink to CLAUDE.md')
  process.exit(1)
}
```

Expected failure:

```text
missing required docs: LICENSE, README.md, CONTRIBUTING.md, SECURITY.md, CLAUDE.md
```

- [ ] Add `pnpm check:docs` to root `package.json`.
- [ ] Run `pnpm check:docs`.

Expected: FAIL with the messages above.

- [ ] Add Apache-2.0 `LICENSE`.
- [ ] Add `README.md` with: positioning statement, architecture overview, prerequisite
  table, quickstart pointer, package status, CI badges placeholder, and "not production
  hosted service" scope note.
- [ ] Add `CONTRIBUTING.md` with: forward-only migrations, 9.2 review gate, local Supabase
  port isolation, test gates, and PR requirements.
- [ ] Add `SECURITY.md` with: supported versions, disclosure channel placeholder, no
  secrets in issues, response expectations, and a note that link-based auth can switch the
  current browser session after the token is verified; users should only open login links
  they requested.
- [ ] Move the current `AGENTS.md` content into `CLAUDE.md`, preserving the review harness
  and CLI-first rules.
- [ ] Replace `AGENTS.md` with a relative symlink:

```sh
ln -sf CLAUDE.md AGENTS.md
```

- [ ] Add a CI step to run `pnpm check:docs`.

**Gate**

```sh
pnpm check:docs
pnpm typecheck
```

Expected: PASS.

**Commit message**

```text
docs: add oss legal and contributor baseline
```

## Task 2: Package build and publish artifact checks

**Files**

- Update: root `package.json`, `packages/*/package.json`
- Create: `scripts/check-package-artifacts.mjs`, `scripts/check-release-preflight.mjs`
- Create: `tsup.config.ts` or per-package `tsup.config.ts`
- Update: `.github/workflows/ci.yml`

**Interfaces**

- Produces root scripts:

```json
"build": "turbo run build",
"check:packages": "node scripts/check-package-artifacts.mjs",
"check:release-preflight": "node scripts/check-release-preflight.mjs"
```

- Package entrypoints must resolve to built artifacts, not raw source:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
},
"types": "./dist/index.d.ts",
"files": ["dist"]
```

**TDD steps**

- [ ] Add `scripts/check-package-artifacts.mjs`. It must:
  - find publishable `packages/*/package.json` files;
  - verify the invocation against `pnpm pack --help`;
  - run `(cd packages/<pkg> && pnpm pack --pack-destination <tmp>)`;
  - inspect the tarball file list;
  - fail if `dist/` files are absent;
  - fail if `main`, `exports`, or `types` point at `src/*.ts`.

Publishable C1 package set:

```text
@movp/auth
@movp/cli
@movp/codegen
@movp/core-schema
@movp/domain
@movp/flows
@movp/graphql
@movp/mcp
@movp/notifications
@movp/obs
@movp/search
```

Keep `@movp/frontend-astro` and all template/e2e artifacts `"private": true`.

Use this core artifact-check logic:

```js
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const publishable = [
  'auth',
  'cli',
  'codegen',
  'core-schema',
  'domain',
  'flows',
  'graphql',
  'mcp',
  'notifications',
  'obs',
  'search',
]

execFileSync('pnpm', ['pack', '--help'], { stdio: 'pipe' })

for (const dirName of publishable) {
  const dir = join('packages', dirName)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entryValues = []
  const collect = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      entryValues.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) collect(item)
    }
  }
  collect(pkg.main)
  collect(pkg.exports)
  collect(pkg.types)
  collect(pkg.bin)

  const sourceEntrypoints = entryValues.filter((value) => {
    return value.includes('/src/') || (value.endsWith('.ts') && !value.endsWith('.d.ts'))
  })
  if (sourceEntrypoints.length > 0) {
    console.error(`package artifact check failed: ${pkg.name} points at source`)
    process.exit(1)
  }

  const out = mkdtempSync(join(tmpdir(), `movp-pack-${dirName}-`))
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'pipe' })
    const tgz = readdirSync(out).find((name) => name.endsWith('.tgz'))
    if (!tgz) throw new Error('missing tarball')
    const listing = execFileSync('tar', ['-tzf', join(out, tgz)], { encoding: 'utf8' })
    if (!listing.includes('package/dist/')) {
      console.error(`package artifact check failed: ${pkg.name} has no dist artifacts`)
      process.exit(1)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
```

Expected failure:

```text
package artifact check failed: @movp/<pkg> points at source
```

Pin both branches in the plan's test fixture: the compliant sample with
`"types":"./dist/index.d.ts"` must pass the source-entrypoint check, and
`"main":"./src/index.ts"` must fail it.

- [ ] Add `scripts/check-release-preflight.mjs`. It must run `npm org --help` before using
  `npm org`, then check `npm whoami` and `npm org ls movp`. It should skip in CI unless
  `MOVP_RELEASE_PREFLIGHT=1`.

Use this core preflight:

```js
import { execFileSync } from 'node:child_process'

if (process.env.CI === 'true' && process.env.MOVP_RELEASE_PREFLIGHT !== '1') {
  console.log('release preflight skipped in CI')
  process.exit(0)
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    console.error('release preflight failed: npm auth or movp org access unavailable')
    process.exit(1)
  }
}

run('npm', ['org', '--help'])
run('npm', ['whoami'])
run('npm', ['org', 'ls', 'movp'])
```

Expected local failure when not authenticated:

```text
release preflight failed: npm auth or movp org access unavailable
```

- [ ] Add `build` scripts to every publishable package.
- [ ] Add tsup config and package metadata (`exports`, `types`, `files`).
- [ ] Mark the eleven packages listed above publishable (`private: false` or omit
  `private`), keep `@movp/frontend-astro` private, and do not publish.
- [ ] Keep Supabase edge functions importing workspace package **source** through their
  Deno maps for now. The npm build output is for external package consumers. Do not change
  these import maps in C1:
  - `supabase/functions/graphql/deno.json`
  - `supabase/functions/mcp/deno.json`
  - `supabase/functions/index-embeddings/deno.json`
  - `supabase/functions/flows/deno.json`
  - `supabase/functions/segment-recompute/deno.json`
  - `supabase/functions/ingest/deno.json`
  `slice-e2e` remains the gate that proves packaging changes did not break edge runtime
  source imports.
- [ ] Add CI package-artifact check after build.

Shared tsup config shape:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
})
```

Do not add a public npm subpath export for `@movp/search/gte-small` in C1. `GteSmallProvider`
depends on the Supabase edge runtime's `Supabase.ai` global and is consumed through the
edge-function `deno.json` source maps above, not by external npm consumers.

**Gate**

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check:packages
MOVP_RELEASE_PREFLIGHT=1 pnpm check:release-preflight
```

Expected: build and package checks PASS. Release preflight PASS only on a machine with npm
auth and `movp` org access; otherwise fail loudly with no publish side effect.

**Commit message**

```text
build: add package artifact checks
```

## Task 3: Astro template login flow

**Files**

- Create: `templates/frontend-astro/src/pages/login.astro`
- Create: `templates/frontend-astro/src/pages/auth/callback.astro`
- Create/update: `templates/frontend-astro/src/lib/auth.ts`
- Create: `templates/frontend-astro/tests/e2e/login.spec.ts`
- Update: `templates/frontend-astro/tests/mock/graphql-mock.mjs` if the login test needs a
  local callback fixture.

**Interfaces**

- Existing session cookie remains the contract:

```ts
const COOKIE_NAME = 'sb-access-token'
```

- Login page states:

```text
data-testid="login-form"
data-testid="login-sent"
data-testid="login-error"
```

**TDD steps**

- [ ] Add `login.spec.ts` first:
  - unauthenticated `/` redirects or links to `/login`;
  - `/login` renders email input and OAuth button placeholders;
  - callback with `token_hash` calls Supabase Auth verify and sets `sb-access-token`;
  - callback with an invalid `token_hash` sets no cookie and renders `login-error`;
  - callback with a verified test token sets `sb-access-token`;
  - callback with an invalid token sets no cookie and renders `login-error`;
  - test shortcut returns 404 when `MOVP_E2E_TEST_AUTH` is not `1`;
  - protected page renders seeded data after callback.
- [ ] Extend `templates/frontend-astro/tests/mock/graphql-mock.mjs` with a minimal
  `/auth/v1/user` route and `/auth/v1/verify` route for login tests. `/auth/v1/verify`
  returns a session for the seeded `token_hash` and 400 for an invalid hash. `/auth/v1/user`
  returns 200 only for the seeded direct test token and 401 for anything else, so callback
  e2e proves verification rather than bypassing it.

Expected failure: `/login` is 404 or protected pages render `auth-failure`.

- [ ] Implement `templates/frontend-astro/src/lib/auth.ts`. Any caller-supplied token path
  must verify the token with Supabase Auth before setting the cookie. Do not persist an
  unverified token.
- [ ] Extend `templates/frontend-astro/src/lib/env.ts` to return `supabaseUrl`,
  `supabaseAnonKey`, and optional `movpE2eTestAuth` using the existing
  `cloudflare:workers` `env` pattern. Do not use `Astro.locals.runtime.env`.

Use this verification helper:

```ts
export const SESSION_COOKIE = 'sb-access-token'

export type AuthEnv = {
  supabaseUrl: string
  anonKey: string
  fetchImpl?: typeof fetch
}

export type VerifiedSession = { accessToken: string }

export async function verifyAccessToken(env: AuthEnv, token: string): Promise<boolean> {
  if (!token || token.length < 20) return false
  const doFetch = env.fetchImpl ?? fetch
  const res = await doFetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  return res.ok
}

export async function verifyMagicLink(env: AuthEnv, tokenHash: string, type = 'email'): Promise<VerifiedSession | null> {
  if (!tokenHash) return null
  const doFetch = env.fetchImpl ?? fetch
  const res = await doFetch(`${env.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type, token_hash: tokenHash }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { access_token?: string; session?: { access_token?: string } }
  const accessToken = json.session?.access_token ?? json.access_token
  return accessToken ? { accessToken } : null
}
```

- [ ] Implement `/login` using Supabase Auth magic-link form for production. Keep
  service-role out of the template. Pin Supabase Auth redirect config in docs/tests:
  `site_url` or `additional_redirect_urls` must point magic links at `/auth/callback`.
- [ ] Implement `/auth/callback` so it exchanges or receives a valid local session and sets
  the httpOnly cookie only after verification.

The callback must follow this guard shape:

```astro
---
import { SESSION_COOKIE, verifyAccessToken, verifyMagicLink } from '../../lib/auth.ts'
import { readServerEnv } from '../../lib/env.ts'

const url = new URL(Astro.request.url)
const directToken = url.searchParams.get('access_token')
const tokenHash = url.searchParams.get('token_hash')
const linkType = url.searchParams.get('type') ?? 'email'
const isTestShortcut = url.searchParams.get('test') === '1'

const env = readServerEnv()

if (isTestShortcut && env.movpE2eTestAuth !== '1') {
  return new Response('not found', { status: 404 })
}

let token = ''
if (tokenHash) {
  const session = await verifyMagicLink({
    supabaseUrl: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
  }, tokenHash, linkType)
  token = session?.accessToken ?? ''
} else if (directToken) {
  const ok = await verifyAccessToken({
    supabaseUrl: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
  }, directToken)
  token = ok ? directToken : ''
}

if (!token && !tokenHash && !directToken) {
  return Astro.redirect('/login?error=missing_token')
}

if (!token) {
  Astro.cookies.delete(SESSION_COOKIE, { path: '/' })
  return Astro.redirect('/login?error=invalid_token')
}

Astro.cookies.set(SESSION_COOKIE, token, {
  path: '/',
  httpOnly: true,
  secure: url.protocol === 'https:',
  sameSite: 'lax',
})

return Astro.redirect('/')
---
```

- [ ] Preserve existing `AuthFailure` rendering for invalid/expired sessions.

**Gate**

```sh
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro e2e -- login
bash scripts/check-boundary.sh
```

Expected: PASS.

**Commit message**

```text
feat(frontend): add template login flow
```

## Task 4: Idempotent demo seed

**Files**

- Create: `scripts/seed-demo.ts`
- Create: `scripts/check-demo-seed.mjs` or include assertions in the seed script
- Update: root `package.json`
- Optional: `docs/demo-seed.md`

**Interfaces**

- Produces scripts:

```json
"seed:demo": "tsx scripts/seed-demo.ts",
"check:demo-seed": "node scripts/check-demo-seed.mjs"
```

- Seed creates one stable workspace:

```text
workspace name: MOVP Demo
member emails: demo-owner@example.test, demo-member@example.test
```

**TDD steps**

- [ ] Add seed idempotence test first. It should run the seed twice against local DB and
  compare row counts/stable ids for workspace, membership, note, task, content, campaign,
  segment, automation rule, and workflow events.

Expected failure: `pnpm seed:demo` script missing.

- [ ] Implement `scripts/seed-demo.ts` using service-role/local DB credentials from
  `supabase status -o env` or `DB_URL`. Use deterministic UUIDs or unique keys and
  `on conflict` upserts.
- [ ] Create demo users through the GoTrue admin API, never by inserting into
  `auth.users` directly. Add `@supabase/supabase-js` to root devDependencies if the root
  script imports it.

Use this helper shape:

```ts
import { createClient } from '@supabase/supabase-js'

type LocalEnv = {
  API_URL: string
  SERVICE_ROLE_KEY: string
  DB_URL: string
}

function requireEnv(name: keyof LocalEnv): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing_env:${name}`)
  return value
}

const apiUrl = requireEnv('API_URL')
const serviceRoleKey = requireEnv('SERVICE_ROLE_KEY')
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function upsertDemoUser(email: string, password: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { source: 'movp_demo_seed' },
  })
  if (!error && created.user) return created.user.id

  const { data: users, error: listError } = await admin.auth.admin.listUsers()
  if (listError) throw listError
  const existing = users.users.find((u) => u.email === email)
  if (!existing) throw error ?? new Error(`demo_user_missing:${email}`)
  return existing.id
}
```

Representative deterministic SQL upsert:

```ts
import { execFileSync } from 'node:child_process'

function psql(sql: string): void {
  execFileSync('psql', [requireEnv('DB_URL'), '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdio: 'inherit',
  })
}

psql(`
  insert into public.workspace (id, name)
  values ('33333333-3333-3333-3333-333333333333', 'MOVP Demo')
  on conflict (id) do update set name = excluded.name;
`)
```

- [ ] Seed enough data for every major page: notes/search, tasks/board/detail/inbox,
  content/editor/approvals/calendar, campaigns/list/detail/timeline/board, segments,
  workflows/rules/webhooks/runs.
- [ ] Ensure seed emits no external webhooks/emails; use disabled webhooks or local test URLs.
- [ ] Add docs warning that demo credentials are local-only.

**Gate**

```sh
supabase db reset
pnpm seed:demo
pnpm seed:demo
pnpm check:demo-seed
```

Expected: PASS and stable row counts.

**Commit message**

```text
feat(seed): add idempotent demo data
```

## Task 5: One-command bootstrap and port strategy proof

**Files**

- Create: `scripts/bootstrap.mjs`
- Create: `scripts/check-supabase-port-strategy.mjs`
- Update: root `package.json`
- Update: `README.md` / `docs/quickstart.md`

**Interfaces**

- Produces script:

```json
"bootstrap": "node scripts/bootstrap.mjs"
```

- Bootstrap options:

```text
--skip-start
--skip-functions
--skip-frontend
--ci
```

**TDD steps**

- [ ] Add `check-supabase-port-strategy.mjs` first. It should fail if a change attempts to
  normalize `supabase/config.toml` away from 64xxx without a proven override strategy and
  docs update.

The check must be mechanical: by default it asserts the committed 64xxx ports. If a future
override strategy exists, it must require an explicit marker in docs and a separate
positive test.

Use this core check:

```js
import { readFileSync } from 'node:fs'

const configPath = process.argv[2] ?? 'supabase/config.toml'
const text = readFileSync(configPath, 'utf8')

const expected = new Map([
  ['api.port', '64321'],
  ['db.port', '64322'],
  ['db.shadow_port', '64320'],
  ['studio.port', '64323'],
  ['local_smtp.port', '64324'],
  ['analytics.port', '64327'],
  ['db.pooler.port', '64329'],
])

function sectionValue(section, key) {
  const sectionPattern = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?:\\n\\[|$)`)
  const sectionMatch = text.match(sectionPattern)
  const body = sectionMatch?.[1] ?? ''
  return body.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'))?.[1]
}

const actual = new Map([
  ['api.port', sectionValue('api', 'port')],
  ['db.port', sectionValue('db', 'port')],
  ['db.shadow_port', sectionValue('db', 'shadow_port')],
  ['studio.port', sectionValue('studio', 'port')],
  ['local_smtp.port', sectionValue('local_smtp', 'port')],
  ['analytics.port', sectionValue('analytics', 'port')],
  ['db.pooler.port', sectionValue('db.pooler', 'port')],
])

const mismatches = [...expected].filter(([key, value]) => actual.get(key) !== value)
if (mismatches.length > 0) {
  console.error(`supabase port strategy changed without proven override: ${mismatches.map(([k]) => k).join(', ')}`)
  process.exit(1)
}
```

Mechanical green step:

```sh
node scripts/check-supabase-port-strategy.mjs supabase/config.toml
```

Expected: exit 0 on the pristine committed config.

Mechanical red step:

```sh
tmp="$(mktemp)"
cp supabase/config.toml "$tmp"
perl -0pi -e 's/port = 64322/port = 54322/' "$tmp"
node scripts/check-supabase-port-strategy.mjs "$tmp" && exit 1
```

Expected: the red step exits non-zero with `supabase port strategy changed`.

- [ ] Add a bootstrap smoke test that invokes `pnpm bootstrap -- --ci --skip-frontend`
  and fails because `scripts/bootstrap.mjs` is missing.
- [ ] Implement bootstrap:
  - checks prerequisites (`node`, `pnpm`, `supabase`);
  - starts Supabase unless `--skip-start`;
  - runs `supabase db reset`;
  - runs `pnpm seed:demo`;
  - optionally starts edge functions and frontend;
  - prints the local URLs and test login instructions.

Use this core command runner:

```js
import { spawnSync } from 'node:child_process'

const args = new Set(process.argv.slice(2))

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

for (const cmd of ['node', 'pnpm', 'supabase']) {
  run(cmd, ['--version'], { stdio: 'ignore' })
}

if (!args.has('--skip-start')) run('supabase', ['start'])
run('supabase', ['db', 'reset'])
run('pnpm', ['seed:demo'])

if (!args.has('--skip-functions') && !args.has('--ci')) {
  console.log('Start functions separately with: supabase functions serve graphql mcp index-embeddings flows ingest')
}

if (!args.has('--skip-frontend') && !args.has('--ci')) {
  console.log('Start frontend separately with: pnpm --filter @movp/frontend-astro dev')
}

if (!args.has('--ci')) {
  console.log('MOVP local stack ready')
  console.log('Login: /login with demo-owner@example.test')
}
```

- [ ] Document the port strategy. If no safe per-user Supabase override exists, keep 64xxx
  committed and explain why.

**Gate**

```sh
pnpm bootstrap -- --ci --skip-frontend
node scripts/check-supabase-port-strategy.mjs
```

Expected: PASS.

**Commit message**

```text
chore: add local bootstrap command
```

## Task 6: Public quickstart docs and command lint

**Files**

- Update: `README.md`
- Create: `docs/quickstart.md`
- Create: `scripts/check-quickstart-docs.mjs`
- Update: root `package.json`

**Interfaces**

- Produces script:

```json
"check:quickstart-docs": "node scripts/check-quickstart-docs.mjs"
```

**TDD steps**

- [ ] Add `check-quickstart-docs.mjs` first. It must fail if docs reference missing files,
  unknown root package scripts, the invalid pnpm package dry-run form, or the scoped npm
  org-list form instead of `npm org ls movp`.

Use this core assertion:

```js
import { existsSync, readFileSync } from 'node:fs'

const docs = ['README.md', 'docs/quickstart.md']
const missing = docs.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`quickstart docs missing: ${missing.join(', ')}`)
  process.exit(1)
}

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
const scripts = rootPkg.scripts ?? {}
const text = docs.map((file) => readFileSync(file, 'utf8')).join('\n')

for (const name of ['bootstrap', 'seed:demo', 'check:docs', 'check:packages']) {
  if (!scripts[name]) {
    console.error(`quickstart references required missing script: ${name}`)
    process.exit(1)
  }
}

const forbidden = [/pnpm\s+pack\s+--dry-run/, /npm\s+org\s+ls\s+@movp/]
for (const pattern of forbidden) {
  if (pattern.test(text)) {
    console.error(`quickstart docs contain stale command: ${pattern}`)
    process.exit(1)
  }
}
```

Expected failure: quickstart doc missing.

- [ ] Write quickstart docs:
  - prerequisites;
  - clone/install;
  - `pnpm bootstrap`;
  - login path;
  - seeded pages to inspect;
  - common local failures: Docker/storage healthcheck, orphan edge runtime, port collisions;
  - how to run full gates.
- [ ] Ensure README links all public docs and states project status plainly.

**Gate**

```sh
pnpm check:quickstart-docs
pnpm check:docs
```

Expected: PASS.

**Commit message**

```text
docs: add public quickstart
```

## Task 7: Known C1 debt burn-down

**Files**

- Update: `.github/workflows/ci.yml`
- Update: `docs/superpowers/plans/README.md`
- Update: stale plan-doc grep gates if still present
- Update: deploy/retention docs from Task 1/6

**Interfaces**

- CI should use maintained action versions available at execution time.
- Stage B plan README must no longer carry stale uncommitted/review wording.

**TDD steps**

- [ ] Add a lightweight docs lint that flags:
  - stale "uncommitted/held for review" Stage B rows;
  - grep gates that match explanatory comments instead of executable lines;
  - missing retention scheduling docs.

Expected failure: any stale wording still present.

- [ ] Update GitHub Actions versions if current CI emits deprecation warnings.
- [ ] Update retention schedule docs with deploy-time pg_cron/Supabase Vault snippet.
- [ ] Fix stale plan README rows and known grep-gate docs.

**Gate**

```sh
pnpm check:quickstart-docs
pnpm test:forward-only-migrations
node scripts/check-definer-audit.mjs
node scripts/check-event-catalog.mjs
```

Expected: PASS.

**Commit message**

```text
docs: burn down onboarding debt
```

## Task 8: Quickstart CI and onboarding slice

**Files**

- Update: `.github/workflows/ci.yml`
- Update: `scripts/slice-e2e.sh`
- Create/update: quickstart fixtures if needed

**Interfaces**

- CI job:

```yaml
quickstart:
  runs-on: ubuntu-latest
```

- Slice section:

```text
== [quickstart] bootstrap + login + seeded pages ==
```

**TDD steps**

- [ ] Add a failing quickstart CI job locally as a script or workflow section:
  clone-equivalent checkout, `pnpm install --frozen-lockfile`, `pnpm bootstrap -- --ci`,
  login e2e, `slice-e2e`.

Expected failure: bootstrap/login pieces missing until Tasks 3-6 land.

- [ ] Add `[quickstart]` coverage to `scripts/slice-e2e.sh`:
  - reset DB;
  - run seed;
  - mint or use demo login;
  - assert seeded pages render non-empty;
  - run existing GraphQL/MCP/CLI smoke.
- [ ] Keep edge-runtime cleanup behavior from current `slice-e2e.sh`; do not broaden local
  `pkill` behavior.
- [ ] Upload logs on failure using the existing artifact pattern.

**Gate**

```sh
pnpm install --frozen-lockfile
pnpm check:docs
pnpm check:packages
pnpm check:quickstart-docs
pnpm --filter @movp/frontend-astro e2e -- login
bash scripts/slice-e2e.sh
```

Expected: PASS locally and in CI.

**Commit message**

```text
ci: add quickstart onboarding gate
```

## Final C1 Verification

Run the full gate set before requesting review:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm check:docs
pnpm check:packages
pnpm check:quickstart-docs
pnpm test:graphql-shape
pnpm test:jobs
pnpm test:redaction
pnpm test:event-catalog
pnpm test:forward-only-migrations
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs
supabase db reset
supabase test db
supabase db diff
bash scripts/slice-e2e.sh
```

Expected: all pass. If `MOVP_RELEASE_PREFLIGHT=1 pnpm check:release-preflight` fails only
because npm auth is unavailable in CI, document that as local maintainer-only and keep the
artifact checks as the CI gate.

## Self-Review

**Correctness:** C1 maps every roadmap item to a task: legal/docs, CLAUDE/AGENTS, package
builds, login, seed, bootstrap, quickstart CI, and debt burn-down. The package gate uses
`pnpm pack --pack-destination <tmp>` plus tarball assertions, and the npm org command is
verified with `npm org --help` before `npm org ls movp`.

**Safety:** No service-role secrets enter frontend code. Login uses the existing httpOnly
cookie boundary. Demo secrets are local-only. Package publishing is preflighted but not
performed.

**Reliability:** Seed and bootstrap are idempotent gates. Quickstart CI proves the path on
a clean runner. Known local stack flakes remain documented and observable.

**Observability:** Failing docs/package/bootstrap gates produce actionable messages. Slice
keeps log artifact behavior.

**Efficiency:** C1 reuses existing scripts, template state components, and slice structure.
No new docs site or hosted demo is introduced in this phase.

**Performance:** No hot-path platform changes. Login and docs additions do not affect
GraphQL/MCP/domain performance.

**Simplicity:** The plan keeps package publishing to build metadata and checks only. It
does not add a release manager, docs site, or hosted environment.

**Usability:** First-run path is the main deliverable: README, login, seed, bootstrap, and
clear failure docs. Login e2e and seeded non-empty pages prevent a blank first experience.
