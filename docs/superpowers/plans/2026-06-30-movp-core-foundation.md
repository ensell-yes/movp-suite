# MOVP Core — Foundation (Scaffold, Tenancy & Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the MOVP Core monorepo with a local Supabase stack, create the bootstrap workspace tenancy tables with a hardened RLS membership helper, and ship a tested `@movp/auth` that verifies Supabase JWTs in-function and returns an RLS-bound client.

**Architecture:** A pnpm + Turborepo monorepo. Supabase (local CLI stack) owns the database and is the only migration applier. Tenancy is workspace-scoped: every future collection carries `workspace_id` and authorizes via the `public.is_workspace_member()` RLS helper. `@movp/auth` is a runtime-agnostic package (runs in both Node and Deno) that verifies the Supabase access token against the project JWKS and hands back a `supabase-js` client bound to the caller's token so Postgres RLS sees the right principal.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Supabase CLI (local stack + pgTAP), Vitest, `jose` (JWT/JWKS), `@supabase/supabase-js`, `msw` (test-time JWKS mock).

**This plan is Plan 1 of the Phase 1 (MOVP Core) series.** The full north-star + Phase 1 design lives at `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`. Plans 2–6 (Schema DSL & Codegen, Domain Core, API Surfaces, Search & Async, Frontend & CI) follow this one.

## Global Constraints

- **Runtime-agnostic core:** `@movp/*` library packages import nothing Node-only or Deno-only. Use bare specifiers (`jose`, `@supabase/supabase-js`) and standard web APIs (`Request`, `fetch`, `crypto.subtle`). Deno edge functions resolve bare specifiers via per-function `deno.json` import maps (added in Plan 4); Node/Vitest resolve them via node_modules.
- **Relative imports inside `@movp/*` packages use explicit `.ts` extensions** (so Deno resolves them). `tsconfig.base.json` sets `moduleResolution: "bundler"` + `allowImportingTsExtensions: true` + `noEmit: true` — source is consumed directly, never tsc-emitted.
- **Per-request dependencies resolved at call time**, never module scope. The ONE exception is the JWKS set (public keys, keyed by URL) which is safely cached at module scope.
- **Authoritative authz at the data boundary:** RLS + the verified principal are authoritative. Auth verification **fails closed** with a stable `code`.
- **All `SECURITY DEFINER` functions are hardened:** `language sql`/`plpgsql` with `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon` and granted only to `authenticated`.
- **Supabase CLI is the only migration applier.** Migrations are plain timestamped SQL in `supabase/migrations/`.
- **Public values** (project ref, region) are literals; only credentials are secrets.
- **Observability discipline:** never log field values or PII — names/codes only.

## File Structure

```
supasuite/
  package.json              # root: pnpm workspace, turbo scripts
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json        # shared TS config (bundler resolution, .ts ext imports)
  .gitignore
  supabase/
    config.toml             # from `supabase init`
    migrations/
      <ts>_bootstrap_tenancy.sql   # workspace, membership, is_workspace_member, RLS
    tests/
      tenancy_test.sql      # pgTAP: tables, helper, RLS member/non-member
  packages/
    auth/
      package.json          # @movp/auth
      tsconfig.json
      vitest.config.ts
      src/
        index.ts            # re-exports
        principal.ts        # resolvePrincipal(req, env) -> Principal
      test/
        principal.test.ts   # JWT matrix via jose + msw-mocked JWKS
```

---

### Task 1: Scaffold monorepo + local Supabase

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`
- Create (via CLI): `supabase/config.toml` and the `supabase/` tree

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working dev environment + workspace globs `packages/*`, `templates/*`; root scripts `pnpm test` / `pnpm typecheck` (Turborepo fan-out).

This task is environment setup; its gate is command-based (no unit test yet).

- [ ] **Step 1: Initialize git + ignore file**

Run:
```bash
cd /Users/ensell/Code/supasuite && git init
```
Create `.gitignore`:
```gitignore
node_modules/
dist/
.turbo/
supabase/.branches/
supabase/.temp/
*.log
.env
.env.*
```

- [ ] **Step 2: Create root workspace files**

`package.json`:
```json
{
  "name": "movp-suite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "templates/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "test": { "dependsOn": ["^test"] },
    "typecheck": { "dependsOn": ["^typecheck"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM"],
    "types": []
  }
}
```

- [ ] **Step 3: Install + initialize Supabase**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm install && supabase init
```
Expected: `pnpm install` completes; `supabase init` prints `Finished supabase init.` and creates `supabase/config.toml`. (If prompted about VS Code/Deno settings, answer `N`.)

- [ ] **Step 4: Boot the local stack and verify**

Run:
```bash
supabase start && supabase status
```
Expected: services start; `supabase status` prints `API URL: http://127.0.0.1:54321`, a `DB URL`, `anon key`, and `service_role key`. (Requires Docker running.)

- [ ] **Step 5: Verify the root toolchain**

Run:
```bash
pnpm typecheck
```
Expected: PASS — Turborepo finds no package `typecheck` tasks yet and exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold monorepo + local supabase"
```

---

### Task 2: Bootstrap tenancy migration (workspace, membership, RLS helper)

**Files:**
- Create: `supabase/migrations/<timestamp>_bootstrap_tenancy.sql`
- Test: `supabase/tests/tenancy_test.sql` (pgTAP)

**Interfaces:**
- Consumes: the local Supabase stack from Task 1.
- Produces (relied on by every later collection migration):
  - `public.workspace(id uuid pk, name text, created_at timestamptz)`
  - `public.workspace_membership(workspace_id uuid, user_id uuid, role text, created_at timestamptz, pk(workspace_id,user_id))`
  - `public.is_workspace_member(ws uuid) returns boolean` — hardened `SECURITY DEFINER`, the RLS predicate every workspace-scoped table uses.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/tenancy_test.sql`:
```sql
begin;
select plan(7);

select has_table('public', 'workspace', 'workspace table exists');
select has_table('public', 'workspace_membership', 'membership table exists');
select has_function('public', 'is_workspace_member', array['uuid'], 'membership helper exists');

-- seed as the migration owner (RLS is bypassed for the table owner)
insert into public.workspace (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Acme');
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

-- act as member A
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.is_workspace_member('11111111-1111-1111-1111-111111111111'),
          true, 'member is recognized');
select is((select count(*)::int from public.workspace),
          1, 'member sees the workspace row via RLS');

-- act as non-member B
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.is_workspace_member('11111111-1111-1111-1111-111111111111'),
          false, 'non-member is excluded');
select is((select count(*)::int from public.workspace),
          0, 'non-member sees zero rows via RLS');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `tenancy_test.sql` errors with `relation "public.workspace" does not exist` (the migration is not written yet).

- [ ] **Step 3: Write the migration**

Run:
```bash
supabase migration new bootstrap_tenancy
```
Put this in the created `supabase/migrations/<timestamp>_bootstrap_tenancy.sql`:
```sql
-- Bootstrap tenancy: workspaces, memberships, and the RLS membership helper.

create table public.workspace (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspace_membership (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null,                      -- = auth.users.id (no hard FK: keeps this migration self-contained)
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_membership_user_idx on public.workspace_membership (user_id);

-- Hardened SECURITY DEFINER: pinned empty search_path, fully schema-qualified,
-- least-privilege execute grant.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_membership m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;

alter table public.workspace enable row level security;
alter table public.workspace_membership enable row level security;

create policy workspace_read on public.workspace
  for select to authenticated
  using (public.is_workspace_member(id));

create policy membership_read on public.workspace_membership
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
```

- [ ] **Step 4: Apply the migration and run the test**

Run:
```bash
supabase db reset && supabase test db
```
Expected: `db reset` applies the migration cleanly; `supabase test db` prints `tenancy_test.sql .. ok` with all 7 assertions passing.

- [ ] **Step 5: Confirm no schema drift**

Run:
```bash
supabase db diff
```
Expected: empty output (no diff between migrations and the running DB).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations supabase/tests
git commit -m "feat(db): bootstrap workspace tenancy + RLS membership helper"
```

---

### Task 3: `@movp/auth` — verify Supabase JWT, return RLS-bound client

**Files:**
- Create: `packages/auth/package.json`, `packages/auth/tsconfig.json`, `packages/auth/vitest.config.ts`
- Create: `packages/auth/src/principal.ts`, `packages/auth/src/index.ts`
- Test: `packages/auth/test/principal.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure library).
- Produces (relied on by Plan 4's GraphQL/MCP/CLI surfaces):
  - `type Env = { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }`
  - `type Principal = { ok: true; userId: string; db: SupabaseClient } | { ok: false; code: 'missing_token' | 'invalid_token' | 'expired_token' | 'invalid_claims' }`
  - `resolvePrincipal(req: Request, env: Env): Promise<Principal>`

- [ ] **Step 1: Create the package skeleton**

`packages/auth/package.json`:
```json
{
  "name": "@movp/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "jose": "^5.9.6",
    "@supabase/supabase-js": "^2.45.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "msw": "^2.4.0"
  }
}
```

`packages/auth/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/auth/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Run:
```bash
pnpm install
```
Expected: installs `jose`, `@supabase/supabase-js`, `vitest`, `msw` into the workspace.

- [ ] **Step 2: Write the failing test (full JWT matrix)**

`packages/auth/test/principal.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { resolvePrincipal } from '../src/principal.ts'

const SUPABASE_URL = 'https://test.supabase.co'
const ISS = `${SUPABASE_URL}/auth/v1`
const env = { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-test-key' }
const KID = 'test-key-1'
const SUB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const server = setupServer()
let rsPriv: CryptoKey       // matches the published JWKS
let rsPrivOther: CryptoKey  // valid RS256 key NOT in the JWKS (bad signature)
let esPriv: CryptoKey       // ES256 key (wrong alg)

beforeAll(async () => {
  const rs = await generateKeyPair('RS256')
  const rsOther = await generateKeyPair('RS256')
  const es = await generateKeyPair('ES256')
  rsPriv = rs.privateKey
  rsPrivOther = rsOther.privateKey
  esPriv = es.privateKey

  const jwk = await exportJWK(rs.publicKey)
  jwk.kid = KID
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  server.use(
    http.get(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, () =>
      HttpResponse.json({ keys: [jwk] })),
  )
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())

function req(token?: string): Request {
  return new Request('https://gateway/graphql', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

async function sign(
  key: CryptoKey,
  alg: 'RS256' | 'ES256',
  claims: Record<string, unknown>,
  expSeconds?: number,
) {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT(claims)
    .setProtectedHeader({ alg, kid: KID })
    .setIssuedAt(now)
    .setExpirationTime(expSeconds ?? now + 3600)
    .sign(key)
}

describe('resolvePrincipal', () => {
  it('accepts a valid member token', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.userId).toBe(SUB)
      expect(r.db).toBeDefined()
    }
  })

  it('rejects a missing token', async () => {
    const r = await resolvePrincipal(req(), env)
    expect(r).toEqual({ ok: false, code: 'missing_token' })
  })

  it('rejects a bad signature', async () => {
    const token = await sign(rsPrivOther, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a wrong issuer', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: 'https://evil/auth/v1', aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a wrong audience', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'service_role', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a wrong algorithm (ES256)', async () => {
    const token = await sign(esPriv, 'ES256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a missing sub', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated' })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_claims' })
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB }, past)
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'expired_token' })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/auth test
```
Expected: FAIL — cannot resolve `../src/principal.ts` / `resolvePrincipal` is not defined.

- [ ] **Step 4: Implement `principal.ts` + `index.ts`**

`packages/auth/src/principal.ts`:
```ts
import { createRemoteJWKSet, jwtVerify, errors as jose } from 'jose'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Env = { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }

export type Principal =
  | { ok: true; userId: string; db: SupabaseClient }
  | { ok: false; code: 'missing_token' | 'invalid_token' | 'expired_token' | 'invalid_claims' }

// JWKS = public keys; safe to cache at module scope, keyed by project URL.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
function jwksFor(supabaseUrl: string) {
  let jwks = jwksCache.get(supabaseUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    jwksCache.set(supabaseUrl, jwks)
  }
  return jwks
}

// Resolve principal + RLS-bound client AT CALL TIME from the request. Fails closed.
export async function resolvePrincipal(req: Request, env: Env): Promise<Principal> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return { ok: false, code: 'missing_token' }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    ;({ payload } = await jwtVerify(token, jwksFor(env.SUPABASE_URL), {
      issuer: `${env.SUPABASE_URL}/auth/v1`, // pin iss
      audience: 'authenticated',              // pin aud
      algorithms: ['RS256'],                  // pin alg — reject alg-confusion / ES256 drift
    }))
  } catch (e) {
    if (e instanceof jose.JWTExpired) return { ok: false, code: 'expired_token' }
    return { ok: false, code: 'invalid_token' } // bad sig / wrong iss/aud/alg
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, code: 'invalid_claims' }
  }

  // Per-request client carrying the user's JWT so Postgres RLS sees the right principal.
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })

  return { ok: true, userId: payload.sub, db }
}
```

`packages/auth/src/index.ts`:
```ts
export { resolvePrincipal } from './principal.ts'
export type { Env, Principal } from './principal.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
pnpm --filter @movp/auth test
```
Expected: PASS — all 8 cases green.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @movp/auth typecheck
```
Expected: PASS — no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/auth
git commit -m "feat(auth): resolvePrincipal with pinned-claim JWT verify + RLS-bound client"
```

---

## Self-Review

- **Spec coverage (design Tasks 1–2):** Scaffold + local Supabase (Task 1); `workspace`/`workspace_membership`/`is_workspace_member` + RLS (Task 2); `@movp/auth` JWKS verify with pinned `iss`/`aud`/`alg` + non-empty `sub`, fail-closed, RLS-bound client, full JWT matrix test (Task 3). The non-member RLS denial (design Gate 2) is proven in `tenancy_test.sql`. Covered.
- **Deferred to later plans (intentional):** `movp_internal` schema, `movp_jobs`, `search_chunk`, metadata registry, the `vector` extension, codegen, and the domain core — these belong to Plans 2–3 and are not needed for the tenancy/auth deliverable.
- **Placeholder scan:** none — every code/SQL block is complete; every step has an exact command + expected output.
- **Type consistency:** `Env`, `Principal`, and `resolvePrincipal(req, env)` are defined once in `principal.ts`, re-exported from `index.ts`, and consumed by name in the test. The four `code` values match between the type, the implementation, and the test assertions.
- **Hardening checks:** `is_workspace_member` uses `security definer` + `set search_path = ''` + schema-qualified objects + least-priv grant (satisfies the global SECURITY DEFINER constraint and the design's `definer-audit` gate, which Plan 6 wires into CI).
