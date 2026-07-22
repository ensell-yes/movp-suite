# MOVP Agent Access Preferences — design

**Status:** approved and implemented. **Date:** 2026-07-21.

**Implementation boundary:** this design was implemented through the separately approved companion
execution plan. Future changes must preserve its negative bypass, seam-inventory, RLS, TTL, and retry gates.

## 1. Goal

Give each authenticated user two self-managed controls:

1. **MCP access** — an authoritative endpoint gate on `/functions/v1/mcp` for every credential kind.
2. **CLI & API access (PAT)** — an authoritative gate on PAT-backed access through
   `/functions/v1/auth-exchange`, `/functions/v1/graphql`, and `/functions/v1/ingest`.

The names are deliberately asymmetric. The server can always identify the MCP endpoint, but it cannot
prove that an ordinary Supabase session JWT came from a browser rather than a CLI or copied cookie.
Therefore the second switch controls PAT-backed CLI/API access only. `MOVP_ACCESS_TOKEN` remains outside
that switch and the UI must say so.

## 2. Current architecture and complete seam inventory

`resolvePrincipal` authenticates identity and currently returns `{ userId, db, accessToken }` for both
PATs and session JWTs. PATs are resolved into a minted Supabase session by `resolvePatToken`. Production
has exactly four PAT-capable entrypoints:

| Entrypoint | Authentication call | Required authorization |
|---|---|---|
| `supabase/functions/mcp/index.ts` | `resolvePrincipal` | MCP preference for PAT and session JWT |
| `supabase/functions/graphql/index.ts` | `resolvePrincipal` | PAT preference only when credential kind is `pat` |
| `supabase/functions/ingest/index.ts` | `resolvePrincipal` | PAT preference only when credential kind is `pat`; API-key path unchanged |
| `supabase/functions/auth-exchange/index.ts` | `resolvePatToken` | PAT preference after token validity resolves |

A structural seam test inventories **both** `resolvePrincipal` and direct `resolvePatToken` production
calls. A new unregistered callsite fails CI. The scanner must `lstat`, reject symlinks, and size-bound
every source file before reading it.

## 3. Semantics and invariants

### 3.1 Authentication stays identity-only

`resolvePrincipal` does not return authorization failures. Its success type becomes a discriminated
union with `credentialKind: 'pat' | 'session'`. PAT success also carries the effective access snapshot
returned by `resolve_pat`; session success does not.

Authorization uses a separate closed decision:

```ts
type AgentAccessDecision =
  | { ok: true }
  | { ok: false; code: 'mcp_access_disabled' | 'cli_access_disabled' | 'agent_access_check_failed' }
```

`agent_session_ttl_out_of_bounds` belongs to PAT/session mint validation, not this authorization union.

### 3.2 Self-only persistence

`movp_internal.user_agent_access` is keyed by `user_id` and stores two non-null booleans. It is not a
workspace-owner feature: every authenticated user may manage their own row.

- RLS enabled; no policies.
- No `anon` or `authenticated` table grants.
- `service_role` retains the internal access required by authorization functions.
- Caller RPCs accept no user id and use `auth.uid()`.
- The service-role evaluator is not executable by `anon` or `authenticated`.
- A missing row resolves to both settings enabled, preserving existing behavior at migration time.
- User A cannot read or update user B through any public surface.

### 3.3 PAT preference piggybacks on token resolution

The forward-only migration replaces `public.resolve_pat(text)` without changing its signature. Its
successful JSON gains `mcp_enabled` and `cli_enabled`. Existing identity keys remain unchanged and no
secret/hash is returned.

This prevents a second preference RPC on PAT hot paths:

- MCP + PAT uses the resolved `mcp_enabled` value.
- GraphQL/ingest + PAT uses the resolved `cli_enabled` value.
- Auth exchange uses the resolved `cli_enabled` value.
- MCP + session JWT performs one indexed service-role preference lookup per request.

The session-JWT lookup is intentionally uncached. Immediate MCP disablement is the security invariant;
adding a cache would create an unstated stale-authorization window.

### 3.4 CLI residual window

The official PAT-backed CLI re-exchanges once at the start of every command, so it observes disablement
promptly. This is cooperative client behavior, not the server enforcement boundary.

An already-exchanged session JWT cannot be distinguished from a browser session and remains usable
until `exp`. `MAX_AGENT_SESSION_TTL_SECONDS = 3600` is enforced on every PAT-minted session, independent
of hosted GoTrue configuration. A remaining lifetime greater than 3,600 seconds fails closed with
`agent_session_ttl_out_of_bounds`.

TTL validation happens inside the pending mint before cache eligibility. An over-TTL promise rejects,
`cachedOrMintedSession` deletes it, and the same PAT can succeed immediately after configuration repair.
The regression test performs an over-TTL mint followed by an acceptable mint for the same cache key.

Raw `MOVP_ACCESS_TOKEN` and service-role modes are outside the PAT preference. The UI and CLI help must
not describe them as operator-only credentials.

## 4. Failure and retry contract

| Condition | HTTP | Stable code | Retry |
|---|---:|---|---|
| MCP disabled | 403 | `mcp_access_disabled` | none |
| PAT CLI/API disabled | 403 | `cli_access_disabled` | none |
| Preference transport or `502`/`503`/`504` failure | 503 | `agent_access_check_failed` | exactly once, then fail closed |
| PAT-minted JWT exceeds 3,600 seconds | 503 | `agent_session_ttl_out_of_bounds` | none until configuration is corrected |

Malformed responses, permission errors, and other 4xx outcomes are terminal and fail closed. Retry is
limited to a thrown transport error or HTTP `502`/`503`/`504`; it must not retry a definitive denial.

## 5. Observability

Every denial or final check failure emits exactly one content-disciplined event containing:

- `trace_id`, `request_id`
- `actor_id` after identity resolution
- `surface`, `operation`, stable `error_code`
- `redaction_version`
- `attempt: 2` and `latency_ms` on an exhausted retry

Never emit email, PAT, JWT, preference values, response bodies, or payload previews. MCP preference-check
latency is measurable because that lookup is part of its request hot path.

## 6. Frontend contract

The existing `/settings/security` page gains two functional switches only after enforcement lands.
It continues to link to `/settings/tokens` and `/admin/members` instead of duplicating those interfaces.

Labels and help text:

- **MCP access:** “Allow your account to connect through the MOVP MCP endpoint.”
- **CLI & API access (PAT):** “Allow personal access tokens to use the MOVP CLI and PAT-backed API
  endpoints. Already-issued exchanged sessions may remain valid for up to 60 minutes. A directly
  supplied `MOVP_ACCESS_TOKEN` is not controlled by this setting.”

Switch POSTs are self-only, preserve the other setting, and show hard failure feedback. The UI never
optimistically claims success before the server mutation succeeds.

## 7. Load-bearing acceptance tests

1. MCP disabled + session JWT -> `403 mcp_access_disabled`.
2. MCP disabled + PAT -> same denial.
3. PAT access disabled + auth exchange -> `403 cli_access_disabled`.
4. PAT access disabled + GraphQL PAT -> same denial.
5. PAT access disabled + ingest PAT -> same denial; ingest API-key path remains unchanged.
6. Ordinary browser JWT + GraphQL/ingest -> unchanged.
7. Preference lookup fails twice -> `503 agent_access_check_failed`, one final event with `attempt: 2`.
8. User A cannot read/update B; direct application-role table access fails.
9. A 3,601-second mint is rejected and not cached; a repaired 3,600-second mint for the same PAT succeeds.
10. A fixture containing an unregistered `resolvePrincipal` or `resolvePatToken` call makes the seam test fail.

## 8. Non-goals

- Inferring a client channel from a normal session JWT.
- Revoking already-issued session JWTs before their bounded expiry.
- Rebuilding token or member management inside Security.
- Changing the API-key ingest path.
- Implementing the authorization boundary as part of the responsive-navigation change.
