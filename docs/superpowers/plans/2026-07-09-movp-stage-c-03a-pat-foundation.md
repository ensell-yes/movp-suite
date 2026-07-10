# MOVP Stage C3a — PAT Foundation + Resolution

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-09) and the frozen C3 contracts. Precondition:
> **C1 merged** (session + magic-link + seed) and **C2 merged** (admin RPCs, `adminCall`,
> `api-keys.astro`). This plan is the first of four (`c3a`…`c3d`) expanded from the design spec
> `docs/superpowers/specs/2026-07-09-movp-stage-c-03-agent-connectivity-design.md` and the
> frozen contracts. Interfaces below are VERBATIM from the contracts — do not paraphrase them.

**Goal:** a `movp_pat_` Personal Access Token resolves to an ordinary, **user-scoped** GoTrue
session (the same identity a browser login yields), so the edge (`resolvePrincipal`) and a thin
`auth-exchange` endpoint can authenticate agents/CLI headlessly with **zero changes to any RLS
policy or SECURITY DEFINER RPC**. A member self-mints/lists/revokes their own PATs at
`/settings/tokens`. A leaked PAT grants the owning user's *full* access across their workspaces
until revoked — `default_workspace_id` is a CLI home hint, **NOT** an access boundary.

**Architecture — the linchpin:** the stack is asymmetric-JWT-only (`principal.ts` verifies
`['RS256','ES256']` via JWKS; `config.toml` has no symmetric `jwt_secret`), so we **cannot
self-sign** a JWT PostgREST accepts. A PAT therefore resolves to a *real* GoTrue session via
`generateLink({type:'magiclink'})` → `verifyOtp({type:'email', token_hash})` (server-side, no
email sent). **C3a.1 is a fail-first spike that empirically PINS this pairing before C3a.2–7
build on it.** Downstream, `resolvePrincipal` builds its `db` client with the minted
`access_token` exactly as today; RLS applies transparently.

**Tech stack:** Postgres 17 + pgTAP, Supabase CLI (`supabase test db`, migrations), Deno edge,
`@movp/auth` (TS, vitest + Web Crypto), `@movp/domain`, `@movp/graphql` (Pothos), Astro 6 +
Cloudflare adapter, `@supabase/supabase-js` v2.

---

## Baselines (state so Codex knows the expected deltas)

| Gate | Baseline on `main` | After C3a |
|---|---|---|
| pgTAP (`supabase test db`) | **583 tests / 29 files** | **609 tests / 30 files** (+26 in 1 new file) |
| definer-audit (`node scripts/check-definer-audit.mjs`) | **175 function block(s), all pinned** | **179** (+4 SECURITY DEFINER RPCs) |
| typecheck (`turbo run typecheck`) | **12/12 packages** | **12/12** (no new package) |
| boundary (`bash scripts/check-boundary.sh`) | `boundary: clean` | `boundary: clean` |
| forward-only (`node scripts/check-forward-only-migrations.mjs`) | pass | pass (one new `20260709…` migration) |

---

## Global Constraints (every task inherits these)

- **TDD, failing test first.** Each task adds its failing test/gate and proves the expected
  failure *before* implementation.
- **Forward-only migrations.** The last frozen baseline entry is `20260706000001`; the merged C2
  migrations are `20260708000001`…`20260708000005`. C3a's only migration is
  **`20260709000001_personal_access_tokens.sql`** (today is 2026-07-09; it sorts strictly after
  all of them). **Never** edit, rename, or regenerate a merged migration or
  `20260701000002_movp_generated.sql`. Guard: `node scripts/check-forward-only-migrations.mjs`.
- **`movp_internal` posture** for the new secret table: `enable row level security` with **no
  policies**, `revoke all … from anon, authenticated`, `grant all … to service_role`. It is
  reached only through `public` SECURITY DEFINER RPCs. Direct access by anon/authenticated →
  `42501`.
- **Every SECURITY DEFINER function:** `language … security definer set search_path = ''`,
  schema-qualify every object (`public.`, `movp_internal.`, `extensions.`, `auth.`), then
  `revoke all on function … from public, anon[, authenticated]` and `grant execute … to
  authenticated` (or **`to service_role`** for `resolve_pat`). The definer-audit gate fails any
  definer block lacking `set search_path =`.
- **Secrets:** hashed at rest (`encode(extensions.digest(raw,'sha256'),'hex')`), **one-time**
  display, **never logged**. Auth events are keys-only: `surface` + `error_code`, no token
  value, no raw email.
- **Deno edge rule** (workerd analog): resolve service-role clients and env **per request**,
  never captured at module init. Inlined as a comment at each trigger site below.
- **Web env on workerd:** the new Astro page reads env via the committed **no-arg
  `readServerEnv()`** (from `src/lib/env.ts`), **never** `process.env`, **never**
  `readServerEnv(ctx.locals)`.
- **Client/server boundary.** `scripts/check-boundary.sh` greps `templates/` for
  `@movp/(auth|domain)`, `service_role`, `SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE`. The new
  page reaches the backend **only** via `gqlRequest` (Bearer user token). Query strings + types
  live in `src/lib/pat-queries.ts` (no `@movp/*` runtime import). The grep walks the whole tree,
  so it covers new files automatically.
- **Per-task gate + one commit per task.** A task is done only when its gate passes.

## File Structure

```text
scripts/
  spike-pat-exchange.mjs                              # C3a.1 fail-first exchange spike
supabase/migrations/
  20260709000001_personal_access_tokens.sql           # C3a.2 table + 4 RPCs
supabase/tests/
  personal_access_token_test.sql                       # C3a.2 pgTAP matrix (plan 26)
packages/auth/src/
  pat.ts                                               # C3a.3 PatExchange, resolvePatToken, sha256hex, PAT_PREFIX
  index.ts                                             # C3a.3 MODIFY: re-export pat.ts
  principal.ts                                         # C3a.4 MODIFY: PAT branch + Env + deps seam
packages/auth/test/
  pat.test.ts                                          # C3a.3 reject-path + sha256 unit tests
  principal.test.ts                                    # C3a.4 MODIFY: PAT-branch tests + env field
supabase/functions/
  auth-exchange/index.ts                               # C3a.5 thin exchange endpoint
  auth-exchange/deno.json                              # C3a.5 import map
  graphql/index.ts                                     # C3a.4 MODIFY: pass SUPABASE_SERVICE_ROLE_KEY
  mcp/index.ts                                         # C3a.4 MODIFY: pass SUPABASE_SERVICE_ROLE_KEY
supabase/config.toml                                   # C3a.5 MODIFY: [functions.auth-exchange] verify_jwt = false
packages/obs/src/
  event.ts                                             # C3a.5 MODIFY: add 'exchange' to Surface union
  emit.ts                                              # C3a.5 MODIFY: add 'exchange' to SURFACES allow-list
packages/domain/src/
  pat.ts                                               # C3a.6 makePatService
  types.ts                                             # C3a.6 MODIFY: PatService + Pat types + Domain.pat
  domain.ts                                            # C3a.6 MODIFY: pat: makePatService(ctx)
  index.ts                                             # C3a.6 MODIFY: exports
packages/graphql/src/schema.ts                         # C3a.6 MODIFY: PAT refs + query/mutations
packages/graphql/test/schema.test.ts                   # C3a.6 MODIFY: PAT SDL shape assertions
templates/frontend-astro/src/
  lib/pat-queries.ts                                   # C3a.7 pure query strings + types
  lib/graphql.ts                                       # C3a.7 MODIFY: friendly-copy reasons
  pages/settings/tokens.astro                          # C3a.7 self-service PAT page
```

---

## Task C3a.1: The exchange SPIKE (fail-first) — PIN the verify type

**Why first:** the whole mechanism rests on `generateLink({type:'magiclink'})` →
`verifyOtp({type:'email', token_hash})` yielding a **PostgREST-accepted, RLS-bound** session.
If that pairing fails against real local GoTrue, C3a.2–7 are invalid and the design's fallback
ladder applies. This spike proves it end-to-end and PINS `type:'email'` empirically.

**Files**
- Create: `scripts/spike-pat-exchange.mjs`

**Interfaces (consumed):** GoTrue admin API + PostgREST via `@supabase/supabase-js` (a repo-root
devDependency — `node` resolves it from root `node_modules`). Local creds come from
`supabase status -o env` (`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`), matching
`scripts/slice-e2e.sh`.

**TDD steps**

- [ ] **Step 1 — write the spike** `scripts/spike-pat-exchange.mjs`. Note the verify type is
  deliberately WRONG (`'magiclink'`) on this first pass — we do NOT assume; we let real GoTrue
  tell us:

```js
// scripts/spike-pat-exchange.mjs
// C3a.1 fail-first spike: prove generateLink({type:'magiclink'}) -> verifyOtp mints a
// PostgREST-accepted, RLS-bound, USER-SCOPED session. Run against a live local stack:
//   eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
//   node scripts/spike-pat-exchange.mjs
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? process.env.API_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY
// The verify type under test. Step 1 uses the tempting-but-unproven 'magiclink'; Step 2 pins 'email'.
const VERIFY_TYPE = 'magiclink'

function die(msg) { console.error(`SPIKE RED: ${msg}`); process.exit(1) }
if (!url || !anonKey || !serviceKey) die('stack env missing (run: eval "$(supabase status -o env | sed ...)")')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

async function mintSession(email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) die(`generateLink failed: ${linkErr.message}`)
  const tokenHash = link?.properties?.hashed_token
  if (!tokenHash) die('generateLink returned no hashed_token')
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: VERIFY_TYPE, token_hash: tokenHash })
  if (otpErr || !otp?.session?.access_token) {
    die(`verifyOtp(type=${VERIFY_TYPE}) returned no session${otpErr ? `: ${otpErr.message}` : ''} — the type is WRONG; pin type:'email' (magic_link.html uses &type=email)`)
  }
  return otp.session.access_token
}

function sessionClient(accessToken) {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  })
}

const stamp = Date.now()
const emailA = `spike-a-${stamp}@example.test`
const emailB = `spike-b-${stamp}@example.test`
for (const email of [emailA, emailB]) {
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (error && !String(error.message).includes('already been registered')) die(`createUser failed: ${error.message}`)
}

// A: mint a real session, prove it is PostgREST-accepted + RLS-bound (creator becomes owner).
const tokenA = await mintSession(emailA)
const claimsA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString())
if (claimsA.aud !== 'authenticated' || !claimsA.sub) die(`minted token is not an authenticated session: aud=${claimsA.aud}`)
const clientA = sessionClient(tokenA)

const { data: ws, error: wsErr } = await clientA.rpc('create_workspace', { p_name: `Spike WS ${stamp}` })
if (wsErr || !ws?.id) die(`create_workspace via minted session failed: ${wsErr?.message ?? 'no row'}`)
const { data: note, error: noteErr } = await clientA.from('note').insert({ workspace_id: ws.id, title: 'spike-secret' }).select('id').single()
if (noteErr || !note?.id) die(`RLS insert via minted session failed: ${noteErr?.message ?? 'no row'}`)
const { data: ownRead } = await clientA.from('note').select('id').eq('id', note.id)
if (!ownRead || ownRead.length !== 1) die('owner cannot read its own note — session is not RLS-bound to the user')

// B: a DIFFERENT user's session cannot read A's private note (identity boundary).
const tokenB = await mintSession(emailB)
const { data: crossRead } = await sessionClient(tokenB).from('note').select('id').eq('id', note.id)
if (crossRead && crossRead.length !== 0) die('IDENTITY BOUNDARY BROKEN: user B read user A private note')

console.log('SPIKE GREEN: verifyOtp(type=' + VERIFY_TYPE + ') minted a PostgREST-accepted, RLS-bound, user-scoped session; identity boundary holds.')
```

- [ ] **Step 2 — run it, expect RED** (start the stack first if needed: `supabase start`):

```sh
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
node scripts/spike-pat-exchange.mjs
```
Expected: **FAIL** — `SPIKE RED: verifyOtp(type=magiclink) returned no session … — the type is
WRONG; pin type:'email'` (exit 1). This is the empirical "do not assume" moment: this repo's
GoTrue tags the magic-link `hashed_token` as an **`email`** OTP (see
`supabase/templates/magic_link.html` `&type=email` and `auth/callback.astro` default `'email'`).
*If Step 1 unexpectedly PASSES, that is still fine — proceed and pin `'email'` per the committed
template; the load-bearing outcome is that `'email'` works, which Step 3 proves.*

- [ ] **Step 3 — pin the type, run, expect GREEN.** Change exactly one line:

```js
const VERIFY_TYPE = 'email'
```
Run again:
```sh
node scripts/spike-pat-exchange.mjs
```
Expected: **PASS** — `SPIKE GREEN: verifyOtp(type=email) minted a PostgREST-accepted, RLS-bound,
user-scoped session; identity boundary holds.` (exit 0). **`type:'email'` is now the pinned
value used by `pat.ts` (C3a.3) and the spec.**

- [ ] **Step 4 — gate + commit.**
Gate: `node scripts/spike-pat-exchange.mjs` prints `SPIKE GREEN` and exits 0.
```bash
git add scripts/spike-pat-exchange.mjs
git commit -m "test(pat): C3a.1 exchange spike pins verifyOtp type=email"
```

---

## Task C3a.2: PAT table + lifecycle RPCs + pgTAP matrix

**Files**
- Create: `supabase/migrations/20260709000001_personal_access_tokens.sql`
- Create: `supabase/tests/personal_access_token_test.sql`

**Interfaces (produced) — VERBATIM from the frozen contracts:**
```sql
public.create_personal_access_token(default_ws uuid, name text, ttl_days int default 90) returns jsonb
  -- { "token_id": <uuid>, "token": "movp_pat_<64hex>" } ONCE.  authenticated.
public.list_personal_access_tokens() returns jsonb
  -- jsonb_agg of own rows metadata; NEVER token_hash.  authenticated.
public.revoke_personal_access_token(token_id uuid) returns void
  -- own tokens only; not found -> P0001 'pat_not_found'.  authenticated.
public.resolve_pat(p_token_hash text) returns jsonb
  -- {status:ok|revoked|expired|not_found, ...}.  service_role ONLY.
```

**Invariants:** create returns the raw token **once** (`movp_pat_` + 64 hex = 73 chars); only the
64-hex sha256 is stored (`token_hash <> token`). `user_id = auth.uid()` is the security identity.
`default_workspace_id` gates creation (must be a member) but does **not** confine access. `list`
and `revoke` are own-only. `resolve_pat` is the only path that reads the table's user identity and
is **service-role-only**; it never returns the hash/token; it throttles `last_used_at` to ≤ once
per 5 min.

**TDD steps**

- [ ] **Step 1 — write the failing pgTAP** `supabase/tests/personal_access_token_test.sql`
  (plan 26, complete). Users U/V, workspaces W1/W2 (U is a member of BOTH → non-confinement),
  W3 (V-only → identity boundary):

```sql
begin;
select plan(26);

-- seed as table owner (bypasses RLS): U in W1 AND W2 (multi-workspace); V in W3
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2'),
  ('33333333-3333-3333-3333-333333333333','W3');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('33333333-3333-3333-3333-333333333333','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','owner');
insert into public.note (id, workspace_id, title) values
  ('d1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','w1-note'),
  ('d2000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','w2-note'),
  ('d3000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','v-secret');

-- (1)(2) signatures exist
select has_function('public','create_personal_access_token',array['uuid','text','integer'],'create_personal_access_token exists');
select has_function('public','resolve_pat',array['text'],'resolve_pat exists');

-- U creates a PAT with home W1; capture the one-time result
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
create temp table _pat as
  select public.create_personal_access_token('11111111-1111-1111-1111-111111111111','main') as r;

-- (3)(4) one-time secret shape: movp_pat_ + 64 hex = 73 chars, prefixed
select is(length((select r->>'token' from _pat)), 73, 'pat token is movp_pat_ + 64 hex = 73 chars');
select ok((select (r->>'token') like 'movp_pat_%' from _pat), 'pat token carries the movp_pat_ prefix');

-- (5)(6) hash stored != raw; stored value is sha256hex of the raw token (read as table owner)
reset role;
select is(
  (select length(token_hash) from movp_internal.personal_access_token where id = (select (r->>'token_id')::uuid from _pat)),
  64, 'stored token_hash is 64 hex chars');
select ok(
  (select token_hash = encode(extensions.digest((select r->>'token' from _pat), 'sha256'), 'hex')
          and token_hash <> (select r->>'token' from _pat)
   from movp_internal.personal_access_token where id = (select (r->>'token_id')::uuid from _pat)),
  'stored hash is sha256hex of the raw token and differs from it');

-- (7) empty name -> 22023 pat_name_required
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.create_personal_access_token('11111111-1111-1111-1111-111111111111','')$$,
  '22023','pat_name_required','empty name is rejected');

-- (8) home workspace the caller is NOT a member of -> 42501 not_workspace_member
select throws_ok(
  $$select public.create_personal_access_token('33333333-3333-3333-3333-333333333333','x')$$,
  '42501','not_workspace_member','cannot mint a PAT homed in a workspace you are not a member of');

-- (9) movp_internal posture: authenticated cannot read the table directly
select throws_ok(
  $$select * from movp_internal.personal_access_token$$,
  '42501',null,'authenticated cannot SELECT movp_internal.personal_access_token directly');

-- seed MAIN (valid), EXPIRED, and REVOKED pats directly with known raw tokens for the resolve
-- tests. NB: the create-RPC result (_pat) is a temp table owned by the `authenticated` role, so
-- it must NOT be read while role = service_role; the resolve tests use literal seeded hashes.
reset role;
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','seeded-main',
   encode(extensions.digest('movp_pat_main','sha256'),'hex'));
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, expires_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','expired',
   encode(extensions.digest('movp_pat_expired','sha256'),'hex'), now() - interval '1 minute');
insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, revoked_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','revoked',
   encode(extensions.digest('movp_pat_revoked','sha256'),'hex'), now());

-- (10-13) resolve_pat as service_role on the valid seeded PAT: ok + identity + no secret leak
set local role service_role;
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'status',
  'ok','valid PAT resolves ok');
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'user_id',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','resolve returns the owning user_id');
select is(
  public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) ->> 'default_workspace_id',
  '11111111-1111-1111-1111-111111111111','resolve returns the home workspace hint');
select ok(
  (with j as (select public.resolve_pat(encode(extensions.digest('movp_pat_main','sha256'),'hex')) as v)
   select not (v ? 'token') and not (v ? 'token_hash') from j),
  'resolve_pat never returns secret material');

-- (15-17) not_found / expired / revoked discriminants (still service_role)
select is(public.resolve_pat('deadbeef') ->> 'status', 'not_found', 'unknown hash -> not_found');
select is(public.resolve_pat(encode(extensions.digest('movp_pat_expired','sha256'),'hex')) ->> 'status', 'expired', 'expired PAT -> expired');
select is(public.resolve_pat(encode(extensions.digest('movp_pat_revoked','sha256'),'hex')) ->> 'status', 'revoked', 'revoked PAT -> revoked');

-- (14) resolve_pat is service-role only: authenticated is denied
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.resolve_pat('deadbeef')$$,
  '42501',null,'authenticated cannot call resolve_pat (service-role only)');

-- (18) list exposes metadata, never the hash
select ok(
  public.list_personal_access_tokens()::text not like '%token_hash%'
  and (public.list_personal_access_tokens() -> 0 ? 'name'),
  'list exposes metadata, never token_hash');

-- (19) list is own-only: V sees none of U's tokens
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(jsonb_array_length(public.list_personal_access_tokens()), 0, 'list is own-only (V sees no PATs)');

-- (20) list requires a caller
set local request.jwt.claims = '{}';
select throws_ok(
  $$select public.list_personal_access_tokens()$$,
  '42501',null,'unauthenticated cannot list');

-- (21) revoke is own-only: V cannot revoke U's PAT
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  format($$select public.revoke_personal_access_token(%L)$$, (select r->>'token_id' from _pat)),
  'P0001','pat_not_found','V cannot revoke U''s PAT (own-only)');

-- (22) revoke of an unknown id -> pat_not_found
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.revoke_personal_access_token('99999999-9999-9999-9999-999999999999')$$,
  'P0001','pat_not_found','revoking an unknown id is rejected');

-- (23) U revokes its own PAT
select lives_ok(
  format($$select public.revoke_personal_access_token(%L)$$, (select r->>'token_id' from _pat)),
  'U revokes its own PAT');

-- (24-26) identity boundary + non-confinement, proven via the RLS the minted session inherits
select is((select count(*)::int from public.note where id = 'd1000000-0000-0000-0000-000000000001'), 1, 'U sees its W1 note');
select is((select count(*)::int from public.note where id = 'd2000000-0000-0000-0000-000000000002'), 1, 'U sees its W2 note too (PAT is user-scoped, NOT confined to default_workspace_id)');
select is((select count(*)::int from public.note where id = 'd3000000-0000-0000-0000-000000000003'), 0, 'U cannot see V''s private note (identity boundary)');

select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect FAIL** (functions/table missing):
Run: `supabase test db`
Expected: **FAIL** — `personal_access_token_test` errors
`function public.create_personal_access_token(uuid, text) does not exist` (the other 29 files
still pass).

- [ ] **Step 3 — write the migration** `supabase/migrations/20260709000001_personal_access_tokens.sql`
  (table VERBATIM from contracts; each RPC is `security definer set search_path = ''`):

```sql
-- C3a.2 Personal Access Tokens — user-scoped, hashed, revocable.
-- FORWARD-ONLY: this is a NEW timestamped migration; never edit a merged migration.

create table movp_internal.personal_access_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  default_workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index personal_access_token_user_idx
  on movp_internal.personal_access_token (user_id, created_at desc);

-- movp_internal posture: RLS on, NO policies, closed to anon/authenticated, service_role only.
alter table movp_internal.personal_access_token enable row level security;
revoke all on movp_internal.personal_access_token from anon, authenticated;
grant all on movp_internal.personal_access_token to service_role;

create or replace function public.create_personal_access_token(default_ws uuid, name text, ttl_days int default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_token text := 'movp_pat_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id    uuid;
begin
  if v_user is null or not public.is_workspace_member(default_ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  if length(btrim(coalesce(create_personal_access_token.name, ''))) = 0 then
    raise exception 'pat_name_required' using errcode = '22023';
  end if;

  insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, expires_at)
    values (
      v_user, default_ws, btrim(create_personal_access_token.name),
      encode(extensions.digest(v_token, 'sha256'), 'hex'),
      now() + make_interval(days => greatest(coalesce(ttl_days, 90), 1)))
    returning id into v_id;

  return jsonb_build_object('token_id', v_id, 'token', v_token);
end;
$$;

create or replace function public.list_personal_access_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- metadata only; token_hash is NEVER selected.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'default_workspace_id', p.default_workspace_id,
      'created_at', p.created_at, 'last_used_at', p.last_used_at,
      'expires_at', p.expires_at, 'revoked_at', p.revoked_at)
      order by p.created_at desc)
    from movp_internal.personal_access_token p
    where p.user_id = (select auth.uid())
  ), '[]'::jsonb);
end;
$$;

create or replace function public.revoke_personal_access_token(token_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update movp_internal.personal_access_token
     set revoked_at = now()
   where id = revoke_personal_access_token.token_id
     and user_id = (select auth.uid())
     and revoked_at is null;
  if not found then
    raise exception 'pat_not_found' using errcode = 'P0001';
  end if;
end;
$$;

-- resolve_pat is SERVICE-ROLE ONLY: the only path that reads a PAT's identity.
create or replace function public.resolve_pat(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row movp_internal.personal_access_token;
begin
  select * into v_row from movp_internal.personal_access_token where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.revoked_at is not null then return jsonb_build_object('status', 'revoked'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;

  -- throttled last_used_at: at most once / 5 min per PAT (no write amplification on hot agents).
  update movp_internal.personal_access_token
     set last_used_at = now()
   where token_hash = p_token_hash
     and (last_used_at is null or last_used_at < now() - interval '5 minutes');

  return jsonb_build_object('status', 'ok', 'user_id', v_row.user_id, 'default_workspace_id', v_row.default_workspace_id);
end;
$$;

revoke all on function public.create_personal_access_token(uuid, text, int) from public, anon;
revoke all on function public.list_personal_access_tokens() from public, anon;
revoke all on function public.revoke_personal_access_token(uuid) from public, anon;
revoke all on function public.resolve_pat(text) from public, anon, authenticated;

grant execute on function public.create_personal_access_token(uuid, text, int) to authenticated;
grant execute on function public.list_personal_access_tokens() to authenticated;
grant execute on function public.revoke_personal_access_token(uuid) to authenticated;
grant execute on function public.resolve_pat(text) to service_role;
```
⚠ Gotcha: `resolve_pat` is granted to `service_role` only — NOT `authenticated`. pgTAP
assertion (14) pins that authenticated gets `42501`. ⚠ Gotcha: never `select token_hash` in
`list_…`; assertion (18) pins it.

- [ ] **Step 4 — run it, expect PASS**:
Run: `supabase db reset && supabase test db`
Expected: **PASS** — `personal_access_token_test … ok` (plan 26); **609 tests across 30 files**
(583 + 26).

- [ ] **Step 5 — gate + commit**:
Run: `node scripts/check-definer-audit.mjs && node scripts/check-forward-only-migrations.mjs && supabase db diff`
Expected: `definer-audit: 179 function block(s) scanned, all definers pinned`; forward-only pass
(only status `A` on the new file); empty `db diff`.
```bash
git add supabase/migrations/20260709000001_personal_access_tokens.sql supabase/tests/personal_access_token_test.sql
git commit -m "feat(pat): personal_access_token table + lifecycle/resolve RPCs"
```

---

## Task C3a.3: `packages/auth/src/pat.ts` — the shared exchange

**Files**
- Create: `packages/auth/src/pat.ts`, `packages/auth/test/pat.test.ts`
- Modify: `packages/auth/src/index.ts`

**Interfaces (produced) — VERBATIM from the frozen contracts:**
```ts
export type PatExchange =
  | { ok: true; userId: string; defaultWorkspaceId: string; accessToken: string; expiresAt: number }
  | { ok: false; code: 'invalid_token' | 'expired_token' }

export async function resolvePatToken(
  token: string,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string },
  admin: SupabaseClient,   // a service-role client, resolved by the caller at call time
): Promise<PatExchange>
// PAT_PREFIX = 'movp_pat_' exported; sha256hex via Web Crypto.
```

**TDD steps**

- [ ] **Step 1 — write the failing unit test** `packages/auth/test/pat.test.ts`. It covers the
  PURE `sha256hex` (a known vector) and every **reject path** (which short-circuit before any
  GoTrue call) production-shaped — the real `resolvePatToken` runs, only the DB response is
  faked. The success path (real `generateLink`/`verifyOtp`) is proven by the C3a.1 spike and the
  C3d `[agents]` slice, not mocked here:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAT_PREFIX, resolvePatToken, sha256hex } from '../src/pat.ts'

const env = { SUPABASE_URL: 'http://127.0.0.1:64321', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }

function adminReturningStatus(status: string): SupabaseClient {
  return { rpc: vi.fn(async () => ({ data: { status }, error: null })) } as unknown as SupabaseClient
}

describe('pat exchange (pure + reject paths — no GoTrue)', () => {
  it('exports the movp_pat_ prefix', () => {
    expect(PAT_PREFIX).toBe('movp_pat_')
  })

  it('sha256hex matches the known "abc" vector', async () => {
    expect(await sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('maps resolve_pat not_found -> invalid_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('not_found')))
      .toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps resolve_pat revoked -> invalid_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('revoked')))
      .toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps resolve_pat expired -> expired_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('expired')))
      .toEqual({ ok: false, code: 'expired_token' })
  })

  it('maps an rpc error -> invalid_token', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) } as unknown as SupabaseClient
    expect(await resolvePatToken('movp_pat_x', env, admin)).toEqual({ ok: false, code: 'invalid_token' })
  })
})
```

- [ ] **Step 2 — run it, expect FAIL** (module missing):
Run: `pnpm --filter @movp/auth exec vitest run pat`
Expected: **FAIL** — `Failed to resolve import "../src/pat.ts"` (module not found).

- [ ] **Step 3 — write** `packages/auth/src/pat.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const PAT_PREFIX = 'movp_pat_'

export type PatExchange =
  | { ok: true; userId: string; defaultWorkspaceId: string; accessToken: string; expiresAt: number }
  | { ok: false; code: 'invalid_token' | 'expired_token' }

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function resolvePatToken(
  token: string,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string },
  // Deno edge gotcha: `admin` MUST be resolved by the caller PER REQUEST (never captured at
  // module init) — see resolvePrincipal / auth-exchange call sites.
  admin: SupabaseClient,
): Promise<PatExchange> {
  const tokenHash = await sha256hex(token)
  const { data, error } = await admin.rpc('resolve_pat', { p_token_hash: tokenHash })
  if (error) return { ok: false, code: 'invalid_token' }
  const row = (data ?? {}) as { status?: string; user_id?: string; default_workspace_id?: string }
  if (row.status === 'expired') return { ok: false, code: 'expired_token' }
  // revoked | not_found | anything non-ok collapse to invalid_token (agents re-auth, not retry).
  if (row.status !== 'ok' || !row.user_id || !row.default_workspace_id) return { ok: false, code: 'invalid_token' }

  const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(row.user_id)
  const email = userRes?.user?.email
  if (userErr || !email) return { ok: false, code: 'invalid_token' }

  const { data: linkRes, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const hashedToken = linkRes?.properties?.hashed_token
  if (linkErr || !hashedToken) return { ok: false, code: 'invalid_token' }

  // verify with an ANON client. type MUST be 'email' — PINNED by C3a.1's spike and by the
  // committed magic-link path (supabase/templates/magic_link.html `&type=email`,
  // auth/callback.astro default 'email'). No email is sent; verifyOtp consumes the token server-side.
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: 'email', token_hash: hashedToken })
  const session = otp?.session
  if (otpErr || !session?.access_token) return { ok: false, code: 'invalid_token' }

  return {
    ok: true,
    userId: row.user_id,
    defaultWorkspaceId: row.default_workspace_id,
    accessToken: session.access_token,
    expiresAt: session.expires_at ?? 0,
  }
}
```

- [ ] **Step 4 — re-export from** `packages/auth/src/index.ts` (append):

```ts
export { PAT_PREFIX, resolvePatToken, sha256hex } from './pat.ts'
export type { PatExchange } from './pat.ts'
```

- [ ] **Step 5 — run, expect PASS**:
Run: `pnpm --filter @movp/auth exec vitest run pat`
Expected: **PASS** — 6 tests in `pat.test.ts`.

- [ ] **Step 6 — gate + commit**:
Run: `pnpm --filter @movp/auth exec vitest run && pnpm --filter @movp/auth typecheck`
Expected: all auth tests PASS; typecheck clean.
```bash
git add packages/auth/src/pat.ts packages/auth/src/index.ts packages/auth/test/pat.test.ts
git commit -m "feat(pat): resolvePatToken exchange (sha256 + generateLink/verifyOtp email)"
```

---

## Task C3a.4: `resolvePrincipal` PAT branch + `Env` + production-shaped `deps` seam

**Files**
- Modify: `packages/auth/src/principal.ts`, `packages/auth/test/principal.test.ts`
- Modify: `supabase/functions/graphql/index.ts`, `supabase/functions/mcp/index.ts`
  (the two callers must supply the new required `Env.SUPABASE_SERVICE_ROLE_KEY`)

**Interfaces (produced) — VERBATIM from the frozen contracts:**
```ts
// Env gains SUPABASE_SERVICE_ROLE_KEY: string
// resolvePrincipal(req, env, deps?: { resolvePat?: typeof resolvePatToken })
// PAT branch: if token.startsWith(PAT_PREFIX) -> resolve admin at call time, exchange, build db.
// JWT path stays byte-identical. Principal error union UNCHANGED.
```

**TDD steps**

- [ ] **Step 1 — extend** `packages/auth/test/principal.test.ts`. First add
  `SUPABASE_SERVICE_ROLE_KEY` to the existing `env` object (line ~50) so the JWT-path assertions
  still typecheck; add `resolvePrincipal, sign, vi` are already imported/available (`vi` needs
  adding to the vitest import at line 1). Then append the PAT-branch describe block:

  Change line 1:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
```
  Change the `env` assignment (line ~50):
```ts
  env = { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-test-key', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' }
```
  Append this describe block at the end of the file:
```ts
describe('resolvePrincipal PAT branch (production-shaped: real branch, injected exchange)', () => {
  it('routes a movp_pat_ token through the exchange and returns an RLS principal', async () => {
    const resolvePat = vi.fn(async () => ({
      ok: true as const, userId: SUB, defaultWorkspaceId: 'w1', accessToken: 'minted.jwt.token', expiresAt: 9999999999,
    }))
    const r = await resolvePrincipal(req('movp_pat_deadbeef'), env, { resolvePat })
    expect(resolvePat).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.userId).toBe(SUB)
      expect(r.db).toBeDefined()
    }
  })

  it('maps an exchange invalid_token to the principal code', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'invalid_token' as const }))
    const r = await resolvePrincipal(req('movp_pat_bad'), env, { resolvePat })
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps an exchange expired_token to the principal code', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'expired_token' as const }))
    const r = await resolvePrincipal(req('movp_pat_expired'), env, { resolvePat })
    expect(r).toEqual({ ok: false, code: 'expired_token' })
  })

  it('does NOT invoke the exchange for a non-PAT JWT token (JWT path byte-identical)', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'invalid_token' as const }))
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env, { resolvePat })
    expect(resolvePat).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2 — run it, expect FAIL** (PAT branch + 3rd param not yet present):
Run: `pnpm --filter @movp/auth exec vitest run principal`
Expected: **FAIL** — the `movp_pat_` cases fall through to `jwtVerify` and return
`{ ok:false, code:'invalid_token' }` (so `resolvePat` is never called; the first PAT assertion
`expect(r.ok).toBe(true)` fails). Also a type error until the `deps` param exists.

- [ ] **Step 3 — implement the branch** in `packages/auth/src/principal.ts`. Edit the `Env`
  type, add the imports and the branch; keep everything else byte-identical:

  Change the imports (line 1-2) to add the pat import:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createRemoteJWKSet, errors as jose, jwtVerify } from 'jose'
import { PAT_PREFIX, resolvePatToken } from './pat.ts'
```
  Change the `Env` type (line 4) — `SUPABASE_SERVICE_ROLE_KEY` is now required:
```ts
export type Env = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  SUPABASE_JWT_ISSUER?: string
}

export type PrincipalDeps = { resolvePat?: typeof resolvePatToken }
```
  Change the `resolvePrincipal` signature and insert the PAT branch immediately after the
  `missing_token` guard (before the `jwtVerify` block):
```ts
export async function resolvePrincipal(req: Request, env: Env, deps?: PrincipalDeps): Promise<Principal> {
  const token = bearerToken(req)
  if (!token) return { ok: false, code: 'missing_token' }

  // PAT branch — a movp_pat_ token is NOT a JWT, so it must resolve BEFORE jwtVerify.
  if (token.startsWith(PAT_PREFIX)) {
    // Deno edge gotcha: resolve the service-role client at CALL TIME from request-bound env;
    // never capture env/clients at module init (no per-request module instance on workerd/Deno).
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const ex = await (deps?.resolvePat ?? resolvePatToken)(token, env, admin)
    if (!ex.ok) return { ok: false, code: ex.code }
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ex.accessToken}` } },
      auth: { persistSession: false },
    })
    return { ok: true, userId: ex.userId, db }
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  // ... existing jwtVerify block through the final return — UNCHANGED ...
```
  ⚠ Do NOT touch the `jwtVerify` block, the `invalid_claims` check, or the final `createClient`
  return — the JWT path stays byte-identical. The `Principal` union is UNCHANGED.

- [ ] **Step 4 — update the two edge callers** so they supply the new required env field. In
  BOTH `supabase/functions/graphql/index.ts` and `supabase/functions/mcp/index.ts`, add one line
  to the `env` object literal:
```ts
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,   // <-- add this line
    SUPABASE_JWT_ISSUER: Deno.env.get('MOVP_JWT_ISSUER') ?? Deno.env.get('SUPABASE_JWT_ISSUER') ?? undefined,
  }
```

- [ ] **Step 5 — run, expect PASS**:
Run: `pnpm --filter @movp/auth exec vitest run principal`
Expected: **PASS** — all original 9 `resolvePrincipal` tests + 4 new PAT-branch tests.

- [ ] **Step 6 — gate + commit**:
Run: `pnpm --filter @movp/auth exec vitest run && pnpm --filter @movp/auth typecheck`
Expected: all PASS; typecheck clean (the JWT-path tests are unchanged).
```bash
git add packages/auth/src/principal.ts packages/auth/test/principal.test.ts supabase/functions/graphql/index.ts supabase/functions/mcp/index.ts
git commit -m "feat(pat): resolvePrincipal PAT branch + service-role Env + deps seam"
```

---

## Task C3a.5: `auth-exchange` edge endpoint (for the CLI in C3b)

**Files**
- Create: `supabase/functions/auth-exchange/index.ts`, `supabase/functions/auth-exchange/deno.json`
- Modify: `supabase/config.toml`
- Modify: `packages/obs/src/event.ts`, `packages/obs/src/emit.ts` (add the `'exchange'` surface)

**Interfaces (produced) — VERBATIM from the frozen contracts:**
```
POST ${apiUrl}/functions/v1/auth-exchange
  Authorization: Bearer movp_pat_…   (must start with movp_pat_, else 401)
  200 -> { access_token, expires_at, default_workspace_id, user_id }
  fail -> 401 { error: <code> } + keys-only emit({surface:'exchange', operation:'authenticate', error_code})
  config.toml: [functions.auth-exchange] verify_jwt = false
```

**TDD steps**

- [ ] **Step 0 — register the `'exchange'` obs surface (or the keys-only event is silently
  downgraded).** `emit()` validates `surface` against an allow-list and rewrites any unknown
  value to `'unknown'` + emits an `observability_enum_violation`. The frozen contract uses
  `surface:'exchange'`, which is NOT yet in the enum, so it MUST be added first. In
  `packages/obs/src/event.ts` extend the union:
```ts
export type Surface = 'graphql' | 'mcp' | 'cli' | 'flows' | 'embed' | 'ingest' | 'exchange'
```
  And in `packages/obs/src/emit.ts` extend the runtime allow-list to match:
```ts
const SURFACES: readonly string[] = ['graphql', 'mcp', 'cli', 'flows', 'embed', 'ingest', 'exchange']
```
Run: `pnpm test:redaction`
Expected: **PASS** — the existing obs `emit.test.ts` (which uses `'webhook'` as its invalid-surface
example) is unaffected; `'exchange'` is now a recognized surface.

- [ ] **Step 1 — write the config as a failing grep gate first.** Add to `supabase/config.toml`
  immediately after the `[functions.ingest]` block:
```toml
# The CLI exchanges a movp_pat_ token for a session here with NO session JWT; the function does
# its OWN fail-closed PAT auth (verify_jwt would 401 the PAT before our code runs).
[functions.auth-exchange]
verify_jwt = false
```
Gate check: `grep -q '\[functions.auth-exchange\]' supabase/config.toml && grep -A1 '\[functions.auth-exchange\]' supabase/config.toml | grep -q 'verify_jwt = false'`
Expected before writing the fn: config present, but no function file → this task is incomplete
until the endpoint exists.

- [ ] **Step 2 — write the import map** `supabase/functions/auth-exchange/deno.json` (mirror
  `supabase/functions/graphql/deno.json`, trimmed to what this fn imports):
```json
{
  "imports": {
    "@movp/auth": "../../../packages/auth/src/index.ts",
    "@movp/obs": "../../../packages/obs/src/index.ts",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "jose": "npm:jose@5"
  }
}
```

- [ ] **Step 3 — write the endpoint** `supabase/functions/auth-exchange/index.ts` (mirror the
  fail-closed shape of `graphql/index.ts`; service-role client resolved per request):
```ts
import { createClient } from '@supabase/supabase-js'
import { PAT_PREFIX, resolvePatToken } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'

Deno.serve(async (req: Request): Promise<Response> => {
  // Deno edge gotcha: resolve env + the service-role client PER REQUEST, never at module init.
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  }
  const header = req.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''

  const fail = (code: string): Response => {
    // keys-only auth event: surface + code only — NEVER the token or email value.
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'exchange',
      operation: 'authenticate',
      error_code: code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: code }), { status: 401, headers: { 'content-type': 'application/json' } })
  }

  if (!token.startsWith(PAT_PREFIX)) return fail('invalid_token')

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const ex = await resolvePatToken(token, env, admin)
  if (!ex.ok) return fail(ex.code)

  return new Response(
    JSON.stringify({
      access_token: ex.accessToken,
      expires_at: ex.expiresAt,
      default_workspace_id: ex.defaultWorkspaceId,
      user_id: ex.userId,
    }),
    { headers: { 'content-type': 'application/json' } },
  )
})
```
⚠ Gotcha: `verify_jwt = false` (Step 1) is REQUIRED — otherwise the gateway 401s the
`movp_pat_` bearer before this code runs. The function does its own fail-closed PAT auth.

> **Coverage note:** edge functions are not unit-tested in this repo; the functional end-to-end
> proof (`auth-exchange` returns a session for a seeded PAT, 401 + keys-only on a bad PAT, and
> revoke → 401) is the C3d `[agents]` slice, which serves `auth-exchange` and drives it. C3a's
> guarantee that the exchange *primitive* works is the C3a.1 spike. Do not add a bespoke unit
> harness for the Deno fn here.

- [ ] **Step 4 — gate + commit**:
Run:
```sh
grep -q '\[functions.auth-exchange\]' supabase/config.toml \
  && test -f supabase/functions/auth-exchange/index.ts \
  && test -f supabase/functions/auth-exchange/deno.json \
  && bash scripts/check-boundary.sh \
  && echo OK
```
Expected: `boundary: clean` then `OK` (the fn lives under `supabase/`, not `templates/`, so the
boundary grep is unaffected).
```bash
git add supabase/functions/auth-exchange/index.ts supabase/functions/auth-exchange/deno.json supabase/config.toml packages/obs/src/event.ts packages/obs/src/emit.ts
git commit -m "feat(pat): auth-exchange edge endpoint (verify_jwt=false, keys-only fail)"
```

---

## Task C3a.6: GraphQL PAT surfaces + `@movp/domain` PAT service

**Files**
- Create: `packages/domain/src/pat.ts`
- Modify: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`, `packages/domain/src/index.ts`
- Modify: `packages/graphql/src/schema.ts`, `packages/graphql/test/schema.test.ts`

**Interfaces (produced) — VERBATIM from the frozen contracts:**
```graphql
personalAccessTokens: [PersonalAccessToken!]!
  # { id, name, defaultWorkspaceId, createdAt, lastUsedAt, expiresAt, revokedAt }
createPersonalAccessToken(defaultWorkspaceId: ID!, name: String!, ttlDays: Int): CreatedPat!
  # { tokenId: ID!, token: String! }
revokePersonalAccessToken(tokenId: ID!): Boolean!
```
Domain: `makePatService(ctx)` → `createToken`, `listTokens`, `revokeToken`; throws
`AdminDomainError` (reuse from `admin.ts`) so the existing `adminCall`/`adminGraphqlError` +
frontend friendly-copy apply. Wire into `createDomain` as `domain.pat`.

**TDD steps**

- [ ] **Step 1 — write the failing GraphQL shape assertion** in
  `packages/graphql/test/schema.test.ts` (append inside the existing `describe('buildSchema', …)`
  — it uses `printSchema(buildSchema(movpSchema))`):
```ts
  it('exposes the PAT surfaces (self-service, user-scoped)', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toContain('type PersonalAccessToken')
    expect(sdl).toContain('type CreatedPat')
    expect(sdl).toContain('personalAccessTokens: [PersonalAccessToken!]!')
    expect(sdl).toContain('createPersonalAccessToken(')
    expect(sdl).toContain('revokePersonalAccessToken(')
  })
```
Run: `pnpm --filter @movp/graphql exec vitest run schema`
Expected: **FAIL** — SDL has no `PersonalAccessToken`/`CreatedPat`/`personalAccessTokens`.

- [ ] **Step 2 — domain types** in `packages/domain/src/types.ts`. Add these interfaces (place
  near `IngestKeySecret`, ~line 283) and add `pat: PatService` to the `Domain` interface
  (alongside `admin: AdminService`, ~line 346):
```ts
export interface PatTokenRow {
  id: string
  name: string
  default_workspace_id: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export interface CreatedPat {
  tokenId: string
  token: string
}

export interface PatService {
  createToken(i: { defaultWorkspaceId: string; name: string; ttlDays?: number | null }): Promise<CreatedPat>
  listTokens(): Promise<PatTokenRow[]>
  revokeToken(i: { tokenId: string }): Promise<void>
}
```
```ts
export interface Domain {
  // ... existing fields ...
  admin: AdminService
  pat: PatService   // <-- add
}
```

- [ ] **Step 3 — domain service** `packages/domain/src/pat.ts` (mirror `admin.ts`'s
  `fail`/`rpc` pattern; reuse `AdminDomainError` so error mapping is identical):
```ts
import { AdminDomainError } from './admin.ts'
import type { CreatedPat, DomainCtx, PatService, PatTokenRow } from './types.ts'

function fail(op: string, code: string, reason?: string): never {
  throw new AdminDomainError(op, code, reason)
}

export function makePatService(ctx: DomainCtx): PatService {
  return {
    async createToken({ defaultWorkspaceId, name, ttlDays }) {
      const { data, error } = await ctx.db.rpc('create_personal_access_token', {
        default_ws: defaultWorkspaceId,
        name,
        ttl_days: ttlDays ?? null,
      })
      if (error) fail('createToken', error.code ?? 'unknown', error.message)
      const row = (data ?? {}) as Record<string, unknown>
      return { tokenId: String(row.token_id ?? ''), token: String(row.token ?? '') }
    },

    async listTokens() {
      const { data, error } = await ctx.db.rpc('list_personal_access_tokens')
      if (error) fail('listTokens', error.code ?? 'unknown', error.message)
      return Array.isArray(data) ? (data as PatTokenRow[]) : []
    },

    async revokeToken({ tokenId }) {
      const { error } = await ctx.db.rpc('revoke_personal_access_token', { token_id: tokenId })
      if (error) fail('revokeToken', error.code ?? 'unknown', error.message)
    },
  }
}
```

- [ ] **Step 4 — wire into** `packages/domain/src/domain.ts`: add the import and the field.
```ts
import { makePatService } from './pat.ts'
```
```ts
    admin: makeAdminService(ctx),
    pat: makePatService(ctx),   // <-- add inside the createDomain return object
```
  And `packages/domain/src/index.ts`: export the factory and types.
```ts
export { makePatService } from './pat.ts'
```
  Add `CreatedPat`, `PatService`, `PatTokenRow` to the existing `export type { … } from './types.ts'` block.

- [ ] **Step 5 — GraphQL refs + surfaces** in `packages/graphql/src/schema.ts`.
  (a) Add the domain types to the existing `@movp/domain` import block (~line 6-22):
```ts
  type CreatedPat,
  type PatTokenRow,
```
  (b) Add the two object refs immediately after `replayDeadJobsRef` (~line 191):
```ts
  const personalAccessTokenRef = builder.objectRef<PatTokenRow>('PersonalAccessToken').implement({
    fields: (t) => ({
      id: t.exposeID('id'),
      name: t.exposeString('name'),
      defaultWorkspaceId: t.exposeID('default_workspace_id'),
      createdAt: t.exposeString('created_at'),
      lastUsedAt: t.string({ nullable: true, resolve: (r) => r.last_used_at }),
      expiresAt: t.string({ nullable: true, resolve: (r) => r.expires_at }),
      revokedAt: t.string({ nullable: true, resolve: (r) => r.revoked_at }),
    }),
  })
  const createdPatRef = builder.objectRef<CreatedPat>('CreatedPat').implement({
    fields: (t) => ({
      tokenId: t.exposeID('tokenId'),
      token: t.exposeString('token'),
    }),
  })
```
  (c) Add the query + two mutations immediately after the `replayDeadJobs` mutation block
  (~line 721), before the `for (const c of schema.collections …)` loop:
```ts
  builder.queryField('personalAccessTokens', (t: any) =>
    t.field({
      type: [personalAccessTokenRef],
      complexity: 10,
      resolve: (_r: unknown, _args: any, ctx: GraphQLContext) =>
        adminCall(() => domainFrom(ctx).pat.listTokens()),
    }),
  )

  builder.mutationField('createPersonalAccessToken', (t: any) =>
    t.field({
      type: createdPatRef,
      complexity: 10,
      args: {
        defaultWorkspaceId: t.arg.id({ required: true }),
        name: t.arg.string({ required: true }),
        ttlDays: t.arg.int({ required: false }),
      },
      resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
        adminCall(() => domainFrom(ctx).pat.createToken({
          defaultWorkspaceId: String(args.defaultWorkspaceId),
          name: String(args.name),
          ttlDays: args.ttlDays == null ? null : Number(args.ttlDays),
        })),
    }),
  )

  builder.mutationField('revokePersonalAccessToken', (t: any) =>
    t.field({
      type: 'Boolean',
      complexity: 10,
      args: { tokenId: t.arg.id({ required: true }) },
      resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
        await adminCall(() => domainFrom(ctx).pat.revokeToken({ tokenId: String(args.tokenId) }))
        return true
      },
    }),
  )
```
  ⚠ Note: `personalAccessTokens` takes NO `workspaceId` arg — PATs are the caller's, not a
  workspace's (the RPC filters on `auth.uid()`).

- [ ] **Step 6 — run, expect PASS**:
Run: `pnpm --filter @movp/graphql exec vitest run schema && pnpm --filter @movp/domain exec vitest run && pnpm --filter @movp/graphql typecheck && pnpm --filter @movp/domain typecheck`
Expected: the new PAT SDL assertions PASS; domain + graphql suites green; typecheck clean.

- [ ] **Step 7 — gate + commit**:
Run: `pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/domain exec vitest run && bash scripts/check-boundary.sh`
Expected: all PASS; `boundary: clean`.
```bash
git add packages/domain/src/pat.ts packages/domain/src/types.ts packages/domain/src/domain.ts packages/domain/src/index.ts packages/graphql/src/schema.ts packages/graphql/test/schema.test.ts
git commit -m "feat(pat): GraphQL PAT surfaces + @movp/domain pat service"
```

---

## Task C3a.7: Web `/settings/tokens` — self-service PAT minting

**Files**
- Create: `templates/frontend-astro/src/lib/pat-queries.ts`,
  `templates/frontend-astro/src/pages/settings/tokens.astro`
- Modify: `templates/frontend-astro/src/lib/graphql.ts` (friendly-copy reasons)

**Interfaces (consumed):** the 3 GraphQL PAT surfaces (C3a.6) via `gqlRequest` with the C1
session token. Self-service for **any member** — NOT admin-gated. Mirrors
`admin/api-keys.astro`: no-arg `readServerEnv()`, `Cache-Control: no-store` on the mint response,
one-time token display, confirm-to-revoke, per-row `aria-label`, friendly errors.

**TDD steps**

- [ ] **Step 1 — add the failing boundary/friendly-copy expectations.** First extend
  `friendlyAdminMessage` in `templates/frontend-astro/src/lib/graphql.ts` — add these three
  reason mappings BEFORE the trailing `if (code === 'BAD_USER_INPUT')` line (~line 56):
```ts
  if (reason === 'not_workspace_member') return "You're not a member of this workspace."
  if (reason === 'pat_name_required') return 'Enter a name for the access token.'
  if (reason === 'pat_not_found') return 'That access token could not be found or is already revoked.'
```

- [ ] **Step 2 — write** `templates/frontend-astro/src/lib/pat-queries.ts` (pure strings +
  types; **no `@movp/*` runtime import** — the boundary grep must stay clean):
```ts
export type PersonalAccessToken = {
  id: string
  name: string
  defaultWorkspaceId: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export type CreatedPat = { tokenId: string; token: string }

export const PERSONAL_ACCESS_TOKENS_QUERY = /* GraphQL */ `
  query PersonalAccessTokens {
    personalAccessTokens { id name defaultWorkspaceId createdAt lastUsedAt expiresAt revokedAt }
  }
`

export const CREATE_PAT_MUTATION = /* GraphQL */ `
  mutation CreatePersonalAccessToken($defaultWorkspaceId: ID!, $name: String!, $ttlDays: Int) {
    createPersonalAccessToken(defaultWorkspaceId: $defaultWorkspaceId, name: $name, ttlDays: $ttlDays) { tokenId token }
  }
`

export const REVOKE_PAT_MUTATION = /* GraphQL */ `
  mutation RevokePersonalAccessToken($tokenId: ID!) {
    revokePersonalAccessToken(tokenId: $tokenId)
  }
`
```

- [ ] **Step 3 — write** `templates/frontend-astro/src/pages/settings/tokens.astro` (mirror
  `admin/api-keys.astro` state machine; the home workspace for `create` is the configured
  `workspaceId` from `readServerEnv()`):
```astro
---
import Base from '../../layouts/Base.astro'
import AuthFailure from '../../components/states/AuthFailure.astro'
import ErrorRetry from '../../components/states/ErrorRetry.astro'
import EmptyState from '../../components/states/EmptyState.astro'
import { readServerEnv } from '../../lib/env.ts'
import { gqlRequest } from '../../lib/graphql.ts'
import { getSessionToken } from '../../lib/session.ts'
import {
  CREATE_PAT_MUTATION,
  PERSONAL_ACCESS_TOKENS_QUERY,
  REVOKE_PAT_MUTATION,
  type CreatedPat,
  type PersonalAccessToken,
} from '../../lib/pat-queries.ts'

type TokensData = { personalAccessTokens: PersonalAccessToken[] }

const token = getSessionToken(Astro.cookies)
let state: 'auth' | 'error' | 'empty' | 'ok' = 'auth'
let tokens: PersonalAccessToken[] = []
let notice = ''
let formError = ''
let oneTimeToken: CreatedPat | null = null

if (token) {
  Astro.response.headers.set('Cache-Control', 'no-store')
  state = 'ok'
  // no-arg readServerEnv() (NOT process.env, NOT readServerEnv(ctx.locals)).
  const { graphqlEndpoint, workspaceId } = readServerEnv()

  if (Astro.request.method === 'POST') {
    const form = await Astro.request.formData()
    const action = String(form.get('action') ?? '')
    if (action === 'create') {
      const result = await gqlRequest<{ createPersonalAccessToken: CreatedPat }>(
        { endpoint: graphqlEndpoint, token },
        CREATE_PAT_MUTATION,
        { defaultWorkspaceId: workspaceId, name: String(form.get('name') ?? ''), ttlDays: null },
      )
      if (!result.ok && result.code === 'auth_error') state = 'auth'
      else if (!result.ok) formError = result.message ?? 'Could not create access token.'
      else {
        oneTimeToken = result.data.createPersonalAccessToken
        notice = 'Access token created.'
      }
    } else if (action === 'revoke') {
      if (form.get('confirm_revoke') !== '1') {
        formError = 'Confirm revocation before continuing.'
      } else {
        const result = await gqlRequest(
          { endpoint: graphqlEndpoint, token },
          REVOKE_PAT_MUTATION,
          { tokenId: String(form.get('tokenId') ?? '') },
        )
        if (!result.ok && result.code === 'auth_error') state = 'auth'
        else if (!result.ok) formError = result.message ?? 'Could not revoke access token.'
        else notice = 'Access token revoked.'
      }
    }
  }

  if (state !== 'auth') {
    const result = await gqlRequest<TokensData>({ endpoint: graphqlEndpoint, token }, PERSONAL_ACCESS_TOKENS_QUERY, {})
    if (!result.ok && result.code === 'auth_error') state = 'auth'
    else if (!result.ok) state = 'error'
    else {
      tokens = result.data.personalAccessTokens
      state = tokens.length === 0 ? 'empty' : 'ok'
    }
  }
}
---
<Base title="Personal Access Tokens">
  <h1 tabindex="-1" id="settings-tokens-heading">Personal Access Tokens</h1>
  <p>Tokens grant your full access across your workspaces. Store them securely and revoke any you no longer use.</p>
  {state === 'auth' && <AuthFailure resource="personal access tokens" />}
  {state === 'error' && <ErrorRetry message="Could not load personal access tokens." retryHref={Astro.url.pathname} />}
  {notice && <p role="status" data-testid="tokens-notice">{notice}</p>}
  {formError && <p role="alert" data-testid="tokens-form-error">{formError}</p>}

  {oneTimeToken && (
    <section data-testid="pat-secret" role="status" aria-labelledby="pat-secret-heading">
      <h2 id="pat-secret-heading">One-time access token</h2>
      <p>Store this token now. It will not be shown again.</p>
      <code>{oneTimeToken.token}</code>
      <script is:inline>
        history.replaceState(null, '', location.pathname)
      </script>
    </section>
  )}

  {(state === 'ok' || state === 'empty') && (
    <section aria-labelledby="create-pat-heading">
      <h2 id="create-pat-heading">Create token</h2>
      <form method="post" data-testid="pat-create-form">
        <input type="hidden" name="action" value="create" />
        <label>
          Name
          <input name="name" required />
        </label>
        <button type="submit">Create access token</button>
      </form>
    </section>
  )}

  {state === 'empty' && <EmptyState message="No personal access tokens yet." />}

  {state === 'ok' && (
    <table data-testid="pat-tokens">
      <thead>
        <tr><th>Name</th><th>Status</th><th>Created</th><th>Last used</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {tokens.map((pat) => (
          <tr>
            <td>{pat.name}</td>
            <td>{pat.revokedAt ? 'revoked' : 'active'}</td>
            <td>{pat.createdAt}</td>
            <td>{pat.lastUsedAt ?? '—'}</td>
            <td>
              <form method="post">
                <input type="hidden" name="action" value="revoke" />
                <input type="hidden" name="tokenId" value={pat.id} />
                <label>
                  <input
                    type="checkbox"
                    name="confirm_revoke"
                    value="1"
                    aria-label={`Confirm revocation of access token ${pat.name}`}
                  />
                  Confirm revocation
                </label>
                <button type="submit" aria-label={`Revoke access token ${pat.name}`}>Revoke token</button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</Base>
```
  ⚠ Gotcha: never re-render `oneTimeToken` on a subsequent GET — it is set only on the `create`
  POST, and the inline `history.replaceState` strips the POST from history (mirrors
  `api-keys.astro`). ⚠ Boundary: `pat-queries.ts` and this page import NOTHING from `@movp/*`
  and never reference `service_role`.

- [ ] **Step 4 — run the gate, expect PASS**:
Run: `bash scripts/check-boundary.sh && pnpm --filter @movp/frontend-astro typecheck`
Expected: `boundary: clean` (the grep walks `templates/` and finds no forbidden import/token in
the two new files or the edited `graphql.ts`); frontend typecheck clean.

- [ ] **Step 5 — commit**:
```bash
git add templates/frontend-astro/src/lib/pat-queries.ts templates/frontend-astro/src/pages/settings/tokens.astro templates/frontend-astro/src/lib/graphql.ts
git commit -m "feat(pat): self-service /settings/tokens page + friendly PAT copy"
```

---

## Final gate (run before opening the C3a PR)

```sh
pnpm install --frozen-lockfile
node scripts/spike-pat-exchange.mjs                     # SPIKE GREEN (needs a live local stack)
supabase db reset && supabase test db                    # 609 tests / 30 files PASS
supabase db diff                                         # empty
node scripts/check-forward-only-migrations.mjs           # only status A on 20260709000001
node scripts/check-definer-audit.mjs                     # 179 blocks, all pinned
pnpm --filter @movp/auth exec vitest run                 # pat + principal PASS
pnpm --filter @movp/domain exec vitest run               # pat service PASS
pnpm --filter @movp/graphql exec vitest run schema       # PAT SDL surfaces PASS
pnpm test:redaction                                      # obs emit incl. 'exchange' surface PASS
pnpm typecheck                                           # 12/12 packages
bash scripts/check-boundary.sh                           # boundary: clean
grep -q '\[functions.auth-exchange\]' supabase/config.toml && echo "auth-exchange registered"
```
Expected: every line PASS; `supabase test db` total **609 across 30 files**; definer-audit
**179**; typecheck **12/12**; `boundary: clean`.

---

## Cross-cutting acceptance criteria (verify before requesting review)

- **Correctness:** one mechanism (a real GoTrue session) serves the edge and (in C3b) the CLI;
  every RLS policy and DEFINER RPC is reused UNCHANGED. The scope claim is honest — **user-scoped**,
  proven by pgTAP (24)/(25) (U sees BOTH W1 and W2) and (26) (U cannot see V's note). The verify
  type is empirically PINNED to `'email'` by C3a.1 before anything depends on it. spec ↔ migration
  ↔ contracts ↔ tests agree on the 4 RPC signatures and the `PatExchange` union.
- **Safety:** token hashed at rest (`token_hash <> token`, pinned (6)); one-time display; `movp_pat_`
  prefix; `movp_internal` posture closed to authenticated (pinned (9)); `resolve_pat` service-role
  only (pinned (14)); auth-reject events keys-only (surface + code, no token/email); the web page
  never imports `@movp/*`/`service_role` (boundary grep). A leaked PAT = the owner's full access —
  documented on the page and in the spec; narrower-than-user PATs are the deferred enhancement.
- **Reliability:** identity boundary (U cannot read V), expired, revoked, not_found all covered by
  pgTAP + the `resolvePatToken` reject-mapping unit tests; the exchange fails CLOSED (any non-ok →
  `invalid_token`/`expired_token`, never a silent success); revocation is immediate at the
  `resolve_pat` gate (already-minted sessions are ≤1h per `jwt_expiry`).
- **Observability:** `auth-exchange` emits a keys-only event on every reject
  (`surface:'exchange', operation:'authenticate', error_code`); the `resolvePrincipal` PAT branch
  inherits the existing graphql/mcp keys-only emit; `last_used_at` is metadata, never logged.
- **Efficiency:** `resolve_pat` throttles `last_used_at` to ≤ once/5 min (no write amplification);
  the edge re-exchanges per request (no at-rest server session) — the CLI-side cache is C3b.
- **Performance:** the per-request exchange cost is called out and spike-measured in C3a.1;
  `personal_access_token_user_idx (user_id, created_at desc)` backs `list`.
- **Simplicity:** reuses the `workspace_invite`/`ingest_key_admin` table+RPC template, the
  `AdminDomainError`/`adminCall` error path, and the `api-keys.astro` one-time-secret UX. No new
  RLS surface, no new package, no codegen change.
- **Usability:** self-service web minting for any member; one-time display with `no-store`;
  confirm-to-revoke with per-row `aria-label`; friendly CLI/edge error copy; the stable
  agent-facing `Principal` codes are unchanged (`missing_token`/`invalid_token`/`expired_token`/
  `invalid_claims`).

## Self-check (author, satisfied)

1. Every code sample is copy-paste-correct and consistent with its prose (RPC arg names match the
   domain `rpc(...)` calls; `verifyOtp` type is `'email'` everywhere; `Env` gains
   `SUPABASE_SERVICE_ROLE_KEY` AND both edge callers are updated so typecheck stays 12/12). ✅
2. Every per-request dependency (the service-role `admin` client) is resolved at CALL TIME with an
   inline Deno-edge comment at each trigger site (`pat.ts`, `principal.ts`, `auth-exchange`). ✅
3. Every platform gotcha is commented at its trigger, not only here (forward-only migration;
   `movp_internal` posture; `resolve_pat` service-role only; one-time secret + hash-at-rest;
   keys-only obs; no-arg `readServerEnv()`; `verifyOtp({type:'email'})`). ✅
4. Every task has exact paths, commands, and EXPECTED output (fail-first red, then the exact
   pass count — 609/30, definer-audit 179, 12/12 typecheck). ✅
5. Every task ends with a machine-checkable gate (a named vitest suite, `supabase test db`, a
   grep, a typecheck, `db diff`, `check-definer-audit.mjs`, `check-forward-only-migrations.mjs`,
   `check-boundary.sh`). ✅
6. No task relies on a fact available only in the authoring conversation — baselines, the pinned
   verify type, and the frozen interfaces are all stated inline. ✅
