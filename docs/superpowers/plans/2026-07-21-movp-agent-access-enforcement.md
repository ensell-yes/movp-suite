# MOVP Agent Access Preferences — execution plan

> **Status:** completed on 2026-07-21 after explicit approval. All seven tasks and their independent
> unit, pgTAP, integration, browser, typecheck, build, Deno, and Cloudflare dry-run gates pass.

**Goal:** implement the approved design in
`docs/superpowers/specs/2026-07-21-movp-agent-access-design.md` so MCP is gated for every identity and
PAT-backed CLI/API access is gated at every current PAT-capable non-MCP endpoint.

**Preserve these invariants:** authentication and authorization remain separate; missing preference
rows default enabled; direct table access is closed; MCP session checks are uncached; PAT checks reuse
the `resolve_pat` result; exchanged sessions are bounded to 3,600 seconds; over-TTL sessions never enter
the cache; the ingest API-key path is unchanged.

## Task 1 — Forward-only preference storage and RPCs

**Create:**

- `supabase/migrations/20260721000001_user_agent_access.sql`
- `supabase/tests/agent_access_preferences_test.sql`

Write the pgTAP test first with exactly 20 assertions covering table posture, caller-bound reads and
updates, missing-row defaults, cross-user denial, service-only evaluation, the augmented `resolve_pat`
shape, and absence of token/hash material.

The migration must use `security definer`, `set search_path = ''`, fully qualified names, explicit
revokes from `public`/`anon`/`authenticated`, and explicit grants. Do not edit
`20260709000001_personal_access_tokens.sql`.

Run after the test-only change:

```sh
supabase status
supabase test db supabase/tests/agent_access_preferences_test.sql
```

Expected: status identifies `supasuite` on API `64321` / DB `64322`; pgTAP fails because the new table
and RPCs do not exist.

Run after the migration:

```sh
supabase db reset
supabase test db supabase/tests/agent_access_preferences_test.sql
pnpm test:forward-only-migrations
```

Expected: `20` assertions pass; reset and forward-only guard exit 0. If status targets another local
project, stop before trusting any result. Do not change the intentional port remap.

## Task 2 — Domain and GraphQL self-service surface

**Create:**

- `packages/domain/src/agent-access.ts`
- `packages/domain/test/agent-access.test.ts`
- `packages/graphql/test/agent-access.test.ts`

**Modify:**

- `packages/domain/src/types.ts`
- `packages/domain/src/domain.ts`
- `packages/domain/src/index.ts`
- `packages/graphql/src/schema.ts`

Add `agentAccessPreferences: { mcpEnabled, cliEnabled }` and
`updateAgentAccessPreferences(mcpEnabled, cliEnabled)`. The domain calls caller-bound RPCs through
`ctx.db`; no resolver accepts a user id. Map database failures through the existing safe GraphQL error
boundary. Add no dependency and no `any`.

Run after each package change:

```sh
pnpm --filter @movp/domain exec vitest run test/agent-access.test.ts
pnpm --filter @movp/graphql exec vitest run test/agent-access.test.ts
pnpm --filter @movp/domain typecheck
pnpm --filter @movp/graphql typecheck
```

Expected: each new test file has exactly 6 passing tests; both typechecks exit 0.

## Task 3 — Credential classification, PAT preference snapshot, and TTL bound

**Create:**

- `packages/auth/src/agent-access.ts`
- `packages/auth/test/agent-access.test.ts`
- `packages/auth/test/surface-seam.test.ts`

**Modify:**

- `packages/auth/src/principal.ts`
- `packages/auth/src/pat.ts`
- `packages/auth/src/index.ts`
- `packages/auth/test/principal.test.ts`
- `packages/auth/test/pat.test.ts`

Add `credentialKind` to successful principals. PAT success carries the effective preference snapshot
from `resolve_pat`; session success does not. Implement the separate `AgentAccessDecision` and the exact
retry classification from the design.

Define `MAX_AGENT_SESSION_TTL_SECONDS = 3600`. Validate `expiresAt - floor(Date.now()/1000)` before a
mint promise can become reusable. An over-limit promise rejects through a typed internal error so the
existing cache cleanup path deletes it. Test a rejected mint followed by a successful mint for the same
token and Supabase URL.

The seam test recursively inventories production `supabase/functions/**/index.ts` callsites for both
`resolvePrincipal` and direct `resolvePatToken`. Every file is `lstat`-checked, symlink-rejected, and
size-bounded before reading. Its fixture tests add one unregistered call of each kind and expect failure.
Authentication resolution must remain in each function entrypoint; extracting it into a helper requires
widening the scanner beyond `index.ts` before moving the callsite.

Run:

```sh
pnpm --filter @movp/auth test
pnpm --filter @movp/auth typecheck
```

Expected from the current 24-test baseline: exactly 41 tests pass; typecheck exits 0.

## Task 4 — Enforce all four endpoint seams

**Modify:**

- `supabase/functions/mcp/index.ts`
- `supabase/functions/graphql/index.ts`
- `supabase/functions/ingest/index.ts`
- `supabase/functions/auth-exchange/index.ts`
- `scripts/slice-e2e.sh`

MCP evaluates every successful principal. GraphQL and the authenticated ingest branch evaluate only PAT
principals. Auth exchange evaluates the `resolvePatToken` snapshot. The ingest API-key branch must remain
byte-for-byte behaviorally unchanged. Resolve env/service clients inside each request; never capture them
at module initialization.

Disabled is terminal `403`. A preference transport/`502`/`503`/`504` failure receives exactly one retry,
then `503`. Emit the content-disciplined event described by the design. Do not emit credential or payload
contents.

Add slice negatives for session-JWT MCP denial, PAT MCP denial, PAT exchange denial, direct PAT GraphQL
denial, PAT ingest denial, API-key ingest non-regression, and retry exhaustion.

Run:

```sh
deno check --no-lock --config supabase/functions/mcp/deno.json supabase/functions/mcp/index.ts
deno check --no-lock --config supabase/functions/graphql/deno.json supabase/functions/graphql/index.ts
deno check --no-lock --config supabase/functions/ingest/deno.json supabase/functions/ingest/index.ts
deno check --no-lock --config supabase/functions/auth-exchange/deno.json supabase/functions/auth-exchange/index.ts
bash scripts/slice-e2e.sh
```

Expected: all four Deno checks exit 0; slice ends `PASS` and prints no token, JWT, email, or payload body.

## Task 5 — Official CLI revalidation and stable errors

**Modify:**

- `packages/cli/src/client.ts`
- `packages/cli/src/error-code.ts`
- `packages/cli/test/client.test.ts`
- `packages/cli/test/error-code.test.ts`

PAT mode exchanges once when each CLI process resolves its context, even if the secure store contains an
unexpired cached session. Keep the returned session for the entire command so auth covers the operation.
Do not claim this client behavior is the server boundary. Preserve raw `MOVP_ACCESS_TOKEN` and service-role
modes and document that they are outside the PAT preference.

Recognize `cli_access_disabled`, `agent_access_check_failed`, and
`agent_session_ttl_out_of_bounds` as stable nonzero CLI errors. Machine output and exit behavior remain
unchanged for success.

Run:

```sh
pnpm --filter @movp/cli test
pnpm --filter @movp/cli typecheck
```

Expected from the current 70-test baseline: exactly 75 tests pass; typecheck exits 0.

## Task 6 — Add functional Security switches

**Create:**

- `templates/frontend-astro/src/lib/agent-access-queries.ts`
- `templates/frontend-astro/tests/agent-access-queries.test.ts`

**Modify:**

- `templates/frontend-astro/src/pages/settings/security.astro`
- `templates/frontend-astro/tests/e2e/account.spec.ts`
- `templates/frontend-astro/tests/mock/graphql-mock.mjs`

Render switches only for an authenticated, successfully loaded preference result. Submit both booleans so
an update never overloads or silently resets the sibling field. Do not optimistically display success.
Use the exact labels/disclosure from the design and retain links to the existing token/member pages.

Run:

```sh
pnpm --filter @movp/frontend-astro exec vitest run tests/agent-access-queries.test.ts
pnpm --filter @movp/frontend-astro exec playwright test tests/e2e/account.spec.ts
pnpm --filter @movp/frontend-astro typecheck
```

Expected: 4 query tests pass; account E2E expands from 12 to exactly 18 passing tests; typecheck has zero
errors. Final frontend unit count is 64 and E2E count is 113 from the baselines recorded on 2026-07-21.

## Task 7 — Documentation and complete gates

**Modify:**

- `CLAUDE.md`
- Agent-facing auth/CLI documentation that lists the four existing auth codes
- `.github/workflows/ci.yml` and its wiring test if the seam test is not already reached by `@movp/auth test`

Document the two settings, exact seams, self-only RLS, uncached MCP JWT lookup, PAT piggyback, stable
codes, 3,600-second residual window, and raw-JWT exclusion. Update the existing statement that lists only
four public auth codes.

Run:

```sh
pnpm --filter @movp/auth test
pnpm --filter @movp/cli test
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro exec playwright test
pnpm check:agent-configs
pnpm test:forward-only-migrations
pnpm typecheck
pnpm build
```

Expected: all commands exit 0; auth 41, CLI 75, frontend unit 64, frontend E2E 113. Report domain
and GraphQL totals exactly as printed rather than assuming a count. Do not mark this plan complete if any
negative bypass, RLS, Deno, typecheck, build, or full-suite gate is skipped.
