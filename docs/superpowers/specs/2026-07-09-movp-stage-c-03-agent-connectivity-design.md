# MOVP Suite — Stage C3: Agent Connectivity (PATs + MCP/CLI) — Design Spec

> Design spec for Stage C3. Source of truth for the four bite-sized TDD
> implementation plans (`…-c3a`, `…-c3b`, `…-c3c`, `…-c3d`). This document is the
> *design*; the plans carry copy-paste-correct code, exact file paths, expected
> failures, and per-task commits. Author: brainstormed 2026-07-09, grounded in the
> committed C1/C2 code (`principal.ts`, `client.ts`, `mcp/index.ts`, `config.toml`,
> `ingest_key_admin.sql`, `member_admin.sql`, `api-keys.astro`).

## Outcome

Named agent clients (Claude Code, Codex, Cursor, Gemini CLI, Copilot) and the
`movp` CLI can connect to a MOVP instance over **MCP (streamable HTTP + stdio)**
and the **CLI** with **headless, revocable auth via Personal Access Tokens
(PATs)** — without a browser session cookie. A PAT is workspace-scoped and
inherits the creating user's role in that workspace. Every existing RLS policy
and SECURITY DEFINER RPC is reused **unchanged**.

## Inherited constraints & invariants (do not violate)

- **Forward-only migrations** from the freeze baseline. New timestamped migrations
  only (`20260709…`); never edit `20260701000002_movp_generated.sql` or any merged
  migration. Guard: `node scripts/check-forward-only-migrations.mjs`.
- **Asymmetric-JWT-only.** `principal.ts` verifies `['RS256','ES256']` via JWKS and
  rejects HS\*; `config.toml` has **no symmetric `jwt_secret`** and uses
  `signing_keys` (asymmetric). ⇒ **We cannot self-sign a JWT that PostgREST will
  accept.** A PAT must resolve to a *real* GoTrue-issued session. This is the
  load-bearing design fact.
- **`movp_internal` posture:** new secret tables are `enable row level security`
  with **no policies**, `revoke all … from anon, authenticated`, `grant all … to
  service_role`. Privileged operations are surfaced only through
  `security definer … set search_path = ''` RPCs granted to `authenticated`, with
  an in-body `auth.uid()` / membership guard.
- **Secrets:** hashed at rest (`encode(extensions.digest(raw,'sha256'),'hex')`),
  one-time display, **never logged** (auth events are keys-only:
  field names / codes, no token values, no raw email — salted hash if an email
  identifier is ever needed).
- **Cloudflare Workers runtime rules** apply to the new Astro `/settings/tokens`
  page: `readServerEnv(ctx.locals)` not `process.env`; resolve per-request deps at
  call time; no server-only import from a client-importable path; boundary test
  covers new files.
- **Deno edge rules** (the analog): the exchange resolves service-role clients and
  env **per request**, never captured at module init.
- Full CI including `slice-e2e` stays green; C3 ships an `[agents]` slice.

## Architecture — the linchpin: PAT → RLS principal

A PAT is an **opaque, hashed, revocable secret** that resolves to a real GoTrue
**session JWT** for the PAT's user, scoped to one workspace. The session is what
every downstream consumer already understands.

### The exchange (shared, server-side, service-role)

Lives in `packages/auth` and is called by **both** the edge (`resolvePrincipal`)
and a thin standalone edge endpoint (for the CLI). Steps:

1. Detect a `movp_pat_` prefix on the `Authorization: Bearer …` value.
2. `sha256(presented_token)` → look up `movp_internal.personal_access_token` by
   `token_hash` (service-role, or a SECURITY DEFINER `resolve_pat(hash)` RPC).
   Reject when: not found / `revoked_at is not null` / `expires_at <= now()`.
   On any reject → keys-only auth event + `invalid_token`/`expired_token`.
3. Resolve the PAT's `user_id` → email (service-role read of `auth.users`).
4. **Mint a real session:** `auth.admin.generateLink({type:'magiclink', email})`
   → `hashed_token`; then `auth.verifyOtp({type:'magiclink', token_hash})` →
   `{ session: { access_token, expires_at, … } }`. No email is sent (generateLink
   only *returns* the token; verifyOtp consumes it server-side). Service-role.
5. Best-effort update `last_used_at` (throttled — at most once/5 min per PAT to
   avoid write amplification on hot agents).
6. Return the `access_token` (a genuine ES256 GoTrue JWT, `sub = user_id`,
   `aud = authenticated`) + `expires_at`.

Downstream:

- **Edge (`resolvePrincipal`)** builds its `db` client exactly as today —
  `createClient(SUPABASE_URL, ANON_KEY, { headers: { Authorization: Bearer
  <access_token> } })` — and returns the same `{ ok, userId, db }`. RLS applies
  transparently; **zero changes to any policy or RPC.**
- **CLI** exchanges the stored PAT → session, caches the session locally
  (keychain/0600, with `expires_at`), and uses the `access_token` as its
  `MOVP_ACCESS_TOKEN`-equivalent for **direct PostgREST** *and* for the
  authenticated **GraphQL** call that powers `--mode hybrid`.

### Why a real session (not impersonation) is the primary mechanism

The CLI talks **directly to PostgREST** for CRUD and must present a JWT PostgREST
accepts; raw-PG `request.jwt.claims` impersonation only helps edge-side and would
force a full CLI rewrite to route everything through the edge. GoTrue exchange
produces one artifact (a real session JWT) that serves the CLI **and** the edge.

### C3.1 is a real spike (fail-first), with a named fallback ladder

C3a's first failing test drives an **end-to-end spike**: a PAT-authenticated
request proves workspace-scoped RLS. The spike **empirically confirms** the
GoTrue-exchange mechanism (availability of `generateLink`/`verifyOtp` in local +
hosted GoTrue, latency, that the minted `access_token` is PostgREST-accepted)
before C3b–C3d build on it. Fallback ladder if the exchange is unworkable:

1. **Primary:** GoTrue `generateLink` + `verifyOtp` exchange (above).
2. **Fallback A:** edge-only raw-PG impersonation (`set_config('request.jwt.claims',
   …, true)` + `set local role authenticated`) via a Deno `postgres` connection;
   the **CLI is refactored to route all calls through the GraphQL/MCP edge** (no
   direct PostgREST). Heavier CLI change.
3. **Fallback B:** service-role + PAT-aware SECURITY DEFINER RPC variants that take
   a resolved `user_id`/`workspace_id` explicitly (never `auth.uid()`, never raw
   table access). Largest surface; last resort.

The spec's downstream parts assume the **primary**; if the spike selects a
fallback, C3a's plan is revised before C3b–C3d are executed.

## Components

Each unit states purpose / interface / dependencies.

### 1. `movp_internal.personal_access_token` (C3a)
- **Purpose:** hashed, workspace-scoped, revocable token records.
- **Shape** (mirrors `movp_internal.workspace_invite`):
  `id uuid pk`, `user_id uuid not null` (the principal),
  `workspace_id uuid not null references public.workspace(id) on delete cascade`,
  `name text not null` (human label), `token_hash text not null unique`,
  `created_at`, `expires_at timestamptz` (nullable = no expiry; default e.g.
  `now() + interval '90 days'`), `last_used_at timestamptz`,
  `revoked_at timestamptz`. Index `(user_id, workspace_id, created_at desc)`.
- **Posture:** RLS enabled, no policies, revoke anon/authenticated, grant
  service_role.
- **Deps:** `public.workspace`, `public.workspace_membership`.

### 2. PAT lifecycle RPCs (C3a) — mirror `ingest_key_admin`
- `create_personal_access_token(ws uuid, name text, ttl_days int default 90)
  returns jsonb` → `{ token_id, token }` **once**. Token =
  `'movp_pat_' || encode(gen_random_bytes(32),'hex')`; stores
  `sha256(token)`. Gate: `auth.uid() is null or not is_workspace_member(ws)`
  (self-service; the PAT's `user_id = auth.uid()`).
- `list_personal_access_tokens(ws uuid) returns jsonb` → own tokens, **metadata
  only** (id, name, created_at, last_used_at, expires_at, revoked_at); never the
  hash/token.
- `revoke_personal_access_token(token_id uuid) returns void` → own tokens only
  (`user_id = auth.uid()`), sets `revoked_at = now()`.
- Grants: `authenticated` only; `revoke … from public, anon`.

### 3. `packages/auth` PAT resolve + exchange module (C3a)
- **Purpose:** the shared exchange (above). New file
  `packages/auth/src/pat.ts`; re-exported from `index.ts`.
- **Interface:** `resolvePatToken(token, env, admin): Promise<PatExchange>` where
  `PatExchange = { ok:true; userId; workspaceId; accessToken; expiresAt } |
  { ok:false; code:'invalid_token'|'expired_token'|'revoked_token' }`.
- **Deps:** a service-role `SupabaseClient` (resolved **per request**, not
  captured); GoTrue admin API. **Gotcha to inline in the plan:** resolve the
  service-role client from request-bound env at call time (Deno edge analog of
  the workerd rule).

### 4. `resolvePrincipal` PAT branch (C3a)
- Add before JWT verification: if `bearerToken(req)` starts with `movp_pat_`,
  call `resolvePatToken`, and on success build the `db` client with the minted
  `access_token` (reusing the existing `createClient` block) and return
  `{ ok:true, userId, db }`. On failure, map to the existing `Principal` error
  codes. **Keep the JWT path byte-identical** for session-cookie callers.
- **Test seam:** `resolvePrincipal` gains an injectable admin/exchange dependency
  so unit tests exercise the PAT branch **production-shaped** (no shortcut the
  real call site doesn't perform).

### 5. Web `/settings/tokens` page (C3a) — self-service PAT minting
- **Purpose:** resolve the bootstrap (first PAT needs a session; CLI needs a PAT).
  A member creates/lists/revokes their own PATs in the browser using the C1
  magic-link session; token shown **once**. Mirrors `admin/api-keys.astro`
  (confirm-to-revoke, `no-store` on the mint response, `aria-label` per row,
  friendly error copy).
- **Interface:** SSR Astro page calling the lifecycle RPCs via the GraphQL edge
  (new `createPersonalAccessToken` / `personalAccessTokens` / `revokePersonalAccessToken`
  surfaces) with the caller's session. Not admin-gated — self-service for any
  member.
- **Deps:** C1 session, GraphQL admin-error mapping (reuse `AdminDomainError` +
  friendly copy). **Gotcha:** `readServerEnv(ctx.locals)`, boundary test covers
  the new page.

### 6. CLI `init` / `login` / `logout` + PAT credential mode (C3b)
- `movp init` — writes `~/.config/movp/config.json` (or `$MOVP_CONFIG`): instance
  `apiUrl` (= `SUPABASE_URL`), `anonKey`, default `workspaceId`. Introduces the
  missing instance-URL concept (today only `SUPABASE_URL` env).
- `movp login` — prompts for / accepts a pasted PAT, validates it via the
  **exchange endpoint**, stores the **PAT** securely (see §8). `movp logout`
  clears it.
- `resolveCliCtx` gains a **PAT mode**: stored PAT (or `MOVP_PAT` env for
  headless/CI) → exchange → session `access_token` → existing supabase-js client
  path. Precedence: `MOVP_ACCESS_TOKEN` (raw JWT, unchanged) > `MOVP_PAT`/stored
  PAT > `MOVP_SERVICE_ROLE_KEY` (local admin, unchanged). Cache the exchanged
  session (with `expires_at`) in the secure store; re-exchange when expired.
- **Deps:** exchange endpoint (§7), secure storage (§8).

### 7. `auth-exchange` edge endpoint (C3a — consumed by the CLI in C3b) — for the CLI
- Thin `supabase/functions/*` (or a route on an existing fn) taking
  `Authorization: Bearer movp_pat_…` → `{ access_token, expires_at, workspace_id,
  user_id }` by calling the shared `resolvePatToken`. `verify_jwt = false`;
  fail-closed 401 + keys-only event, matching the graphql/mcp pattern.

### 8. CLI secure storage (C3b)
- macOS **Keychain** via `security add/find-generic-password` when available
  (per the global keychain rule); else a **`0600`** file under the config dir;
  `MOVP_PAT`/`MOVP_ACCESS_TOKEN` env always overrides stored creds. Never print
  the PAT after creation; never log it. **Gotcha:** `lstat`-safe, `0600` perms on
  the fallback file (untrusted-io rule).

### 9. CLI `--mode hybrid` via the GraphQL edge (C3b)
- Since the direct-PG CLI has no embedder, `movp search --mode semantic|hybrid`
  routes through the **GraphQL edge** `search(...)` using the session
  `access_token`. `--mode fts` stays on the direct-PG path (unchanged). New tiny
  authenticated GraphQL HTTP client in the CLI.

### 10. MCP HTTP client matrix + config-lint (C3c)
- Per-client config samples for **Claude Code, Codex, Cursor, Gemini CLI,
  Copilot** pointing at the existing streamable-HTTP endpoint
  (`${apiUrl}/functions/v1/mcp`) with `Authorization: Bearer movp_pat_…`.
- A **config-lint** script validates each sample against the current tool
  names/URL shape (fails when the schema drifts).
- **MCP HTTP smoke** (CI): `initialize` → `tools/list` → call one safe read tool
  over streamable HTTP with a seeded PAT.

### 11. Stdio bridge decision (C3c)
- **First** test community **`mcp-remote`** as the stdio→HTTP bridge; if the
  smoke (initialize/tools-list/tool-call) passes, **document it** and ship no
  code. Build a narrow `@movp/mcp-bridge` **only if `mcp-remote` fails** the
  smoke. (Decision recorded in memory: reuse `mcp-remote` first.)

### 12. Agent docs & plugin artifacts (C3c)
- `llms.txt`, a consumer `AGENTS.md` template, and per-agent connection docs
  covering tool naming, the **workspace-id convention**, the **stable error
  codes**, and recommended agent prompts. Docs-config lint asserts the example
  tool calls exist.

### 13. `[agents]` slice + CI (C3d)
- One `scripts/slice-e2e.sh` `[agents]` block proving **PAT → (MCP HTTP + stdio
  bridge + CLI) → tool action**: mint a PAT (seed or web-RPC), `movp login`,
  MCP `initialize`/`tools/list`/tool-call over HTTP and via `mcp-remote`, a CLI
  authed action, then **revoke → all three fail with the auth code**. Wired into
  CI; C3 review ≥ 9.2.

## Security posture

- Hashed at rest; one-time display; `movp_pat_` prefix (enables detection + secret
  scanners). Workspace-scoped, role-inherited (a leaked PAT = the user's power in
  that one workspace until revoked). Mitigations: expiry (default 90d), self-serve
  revoke, `last_used_at` for anomaly review, one-time display, keys-only auth
  events, secure client storage (`0600`/keychain).
- **Revocation is immediate at the exchange gate** — a revoked/expired PAT never
  mints a session; already-minted sessions are short-lived (`jwt_expiry`, 1h) and
  the CLI re-exchanges (which then fails). Document the ≤1h residual window.
- No raw email, no token value, no session value in any log. Wrong-workspace and
  auth-reject paths emit keys-only events (surface + code, `redaction_version`).

## Error codes (stable, agent-facing)

Keep the `Principal` union's codes stable and **do not add agent-visible codes** —
map the exchange's internal reject reasons onto the existing four:
`missing_token`, `invalid_token` (bad/not-found/revoked PAT or bad JWT),
`expired_token` (expired PAT or JWT), `invalid_claims`. (The exchange's internal
`revoked_token` collapses to `invalid_token` at the principal boundary — agents
should re-auth, not retry.) CLI maps these to non-zero exit + friendly message;
MCP/HTTP returns 401 with the code.

## Observability

- Reuse the keys-only auth-event pattern from `graphql/mcp/index.ts` for the new
  `auth-exchange` endpoint and the PAT branch of `resolvePrincipal`
  (`operation: 'authenticate'`, `error_code: <code>`, no values).
- PAT lifecycle RPCs emit no secret; `last_used_at` is metadata, not a log.
- CLI `--format json` errors carry the stable code (per the idempotency/CLI rule).

## Testing strategy (fail-first per task)

- **pgTAP matrix (C3a):** create → one-time secret shape; hash stored ≠ raw;
  valid PAT resolves to own workspace only; wrong-workspace read returns
  zero/denied; expired PAT rejected; revoked PAT rejected; list/revoke are
  own-tokens-only; auth-reject event is keys-only. Role-switched, negative cases
  explicit.
- **Auth integration (C3a):** `resolvePrincipal` PAT branch, production-shaped
  (exchange dependency exercised, not stubbed away) — success builds an
  RLS-bound client; each reject maps to the right code + 401 + keys-only event.
- **CLI integration (C3b):** `init` → `login` (paste PAT) → `list tasks` →
  `search --mode hybrid` returns ≥1 seeded hit → `revoke` → command fails with
  auth code. Secure-store fallback file is `0600`.
- **MCP smoke (C3c):** HTTP + `mcp-remote` stdio: initialize/tools-list/tool-call
  with a seeded PAT; config-lint passes for all five client samples.
- **Slice (C3d):** the `[agents]` block above, in CI.

## Four-part decomposition (roadmap tasks → parts)

| Part | Roadmap | Scope | Gate |
|---|---|---|---|
| **C3a** PAT foundation + resolution | C3.1, C3.2 | Spike-first RLS proof; PAT table + lifecycle RPCs; `packages/auth` resolve+exchange; `resolvePrincipal` PAT branch; `auth-exchange` endpoint; **web `/settings/tokens`** + GraphQL PAT surfaces | pgTAP matrix + redaction; auth integration; boundary; forward-only; full repo gates |
| **C3b** CLI login/init/parity | C3.3 | `init`/`login`/`logout`; PAT credential mode + secure storage; `--mode hybrid` via GraphQL edge | CLI integration (init→login→list→hybrid-hit→revoke→auth-fail); `0600` store test |
| **C3c** MCP matrix + stdio + docs | C3.4, C3.5, C3.6 | 5 client config samples + config-lint; MCP HTTP smoke; `mcp-remote` stdio (+`@movp/mcp-bridge` only on failure); `llms.txt`/`AGENTS.md`/error-code docs | config-lint + HTTP/stdio smokes + docs lint |
| **C3d** `[agents]` slice + CI | C3.7 | End-to-end `[agents]` slice; CI wiring | full CI incl. `[agents]`; C3 review ≥ 9.2 |

Dependencies: C3a → C3b → C3c → C3d (C3c's smoke needs a PAT from C3a; C3d needs
all three). Precondition: C1 merged (session + seed). C5 and C8 depend on C3.

## Risks, open questions, deferred (YAGNI)

- **RISK (spike-gated):** GoTrue `generateLink`/`verifyOtp` availability/latency;
  per-MCP-request exchange cost. Mitigation: isolate-local best-effort session
  cache keyed by `pat_hash` (perf layer only; correctness path re-exchanges);
  measured in C3a. If unworkable → fallback ladder.
- **RISK:** exchanged session at rest on the client — must be keychain/`0600`,
  same as the PAT.
- **Deferred (explicit):** read-only / RBAC-scoped PATs (needs custom-claim
  plumbing — out of scope per user decision + roadmap); interactive magic-link
  `movp login` (web `/settings/tokens` covers minting); a bespoke
  `@movp/mcp-bridge` (only if `mcp-remote` fails); PKCE for the magic-link login
  (carry-forward from C1, fold into a later hardening pass).

## Eight-dimension self-check (author pass)

- **Correctness:** one mechanism (real session) serves CLI + edge; RLS reused
  unchanged; spike proves it before dependents build.
- **Safety:** hashed/one-time/revocable; workspace-scoped role-inherited decision
  is explicit; keys-only events; `0600`/keychain; immediate revocation at the
  exchange gate (≤1h residual documented).
- **Reliability:** expired/revoked/wrong-ws all covered by pgTAP; exchange failure
  fails closed; fallback ladder named.
- **Observability:** keys-only auth events on every reject; stable agent-facing
  codes; CLI machine output carries the code.
- **Efficiency:** re-exchange only when the cached session is expired (CLI);
  optional isolate-local cache (edge) — no live-JWT at-rest storage.
- **Performance:** per-request exchange cost called out + spike-measured; cache is
  the mitigation, not a correctness dependency.
- **Simplicity:** reuses `workspace_invite`/`ingest_key_admin`/`api-keys.astro`
  templates; no new RLS surface; stdio via community bridge before custom code.
- **Usability:** self-service web minting; one-time display; friendly CLI/edge
  error copy; documented per-agent config + error codes.
