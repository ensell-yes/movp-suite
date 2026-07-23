# MOVP Suite — Deploy agent-access switches + account shell (PR #30) to movp-prod

> **For agentic workers:** This is an **operator-executed deployment runbook**, NOT a subagent-auto-executed plan. It applies schema to a live production database and redeploys production edge functions + the frontend Worker — outward-facing, hard-to-reverse actions. A human runs each task and confirms its gate before the next. Steps use checkbox (`- [ ]`) syntax for tracking. Do not auto-execute end-to-end.

**Goal:** Ship PR #30 (`691bdd6`, "agent-access-controls") to the live `movp-prod` stack: per-user **MCP access** and **PAT-backed CLI/API access** switches with real server-side enforcement, plus the responsive account shell (nav, profile, security hub, prefetch-safe password recovery, POST logout).

**The one ordering fact this runbook exists to enforce (R-b):** the new `packages/auth/pat.ts` **requires** `mcp_enabled`/`cli_enabled` booleans back from the `resolve_pat` RPC; without them it returns `invalid_token`. Migration `20260721000001_user_agent_access.sql` adds those fields (via `create or replace resolve_pat`). Therefore:

- **Migration BEFORE functions** is safe: the currently-deployed *old* `pat.ts` reads only `status`/`user_id`/`default_workspace_id` and ignores the new columns, so applying the migration is a no-op for live traffic.
- **Functions BEFORE migration** is a **PAT outage**: new `pat.ts` + old `resolve_pat` → every PAT fails closed as `invalid_token`.

This asymmetry makes the sequence strict, not a set. It is also why the migration is safe to leave in place on rollback (see Rollback).

**Architecture — four layers, sequenced:**
1. **Database** — `20260721000001`: `movp_internal.user_agent_access` (self-only RLS, service_role-only grants), caller-bound `get_/update_agent_access_preferences` (via `auth.uid()`), service-role-only `evaluate_agent_access(uuid)`, and `resolve_pat` folded to carry the access snapshot. Missing row ⇒ both prefs default **enabled**, so applying the migration disables nobody.
2. **Edge functions** — the four PAT-capable seams, all sharing the rebuilt `@movp/auth` bundle: `auth-exchange` (PAT exchange, `cli` gate), `mcp` (MCP gate for **both** credential kinds), `graphql` and `ingest` (`cli` gate for `credentialKind === 'pat'` only). `graphql` also newly exposes the `agentAccessPreferences` query + `updateAgentAccessPreferences` mutation the Security page uses.
3. **Hosted Auth config** — the recovery email template + redirect allowlist. `config.toml` is LOCAL-ONLY; hosted must be set separately (the F4 landmine — see [[movp-frontend-auth-config]]).
4. **Frontend Worker** — Astro → Cloudflare (Norcal Crew): `TopNav`/`Base` shell, `settings/profile.astro`, `settings/security.astro` (+ `security/password.astro`), `logout.astro`, recovery-aware `auth/callback.astro`.

**Tech Stack:** Supabase Cloud (Postgres/GoTrue/Deno edge), Supabase CLI `2.109.1`, Deno `2.9.2`, Cloudflare Workers (Norcal Crew), `wrangler ^4`, Astro 7 + `@astrojs/cloudflare` v14. All infra already provisioned at v0.1.x — this deploy recreates nothing.

**Prior art:** `docs/superpowers/plans/2026-07-17-movp-v0.1.1-redeploy.md` and `…-2026-07-16-movp-v0.1-supabase-cloudflare-deploy.md`. This runbook reuses their ref-safety, `db push`, `functions deploy`, and frontend build/deploy idioms and **skips** every provisioning step.

## Global constraints

- **This is a deploy onto EXISTING movp-prod infra. Do NOT recreate anything.** Project, workspace, users, PATs, R2, edge secrets, cron rows, and the base Auth Site-URL/Magic-Link config already exist and are unchanged.
- **Target ref = `poocqnzsrwipbweeacbd` (movp-prod).** norcalOS `fmnwipusmtloximgtzww` is a look-alike — **DO NOT TOUCH**. Verify against `supabase projects list` before any `link`/`db push` (documented near-miss — see [[movp-prod-vs-norcalos-ref-lookalike]]).
- **Supabase CLI = `2.109.1`** (matches `pnpm check:supabase-cli-pins`); **Deno = `2.9.2`**. Confirm before any `supabase` call.
- **Migrations are forward-only and frozen.** Exactly **one** new migration reaches prod: `20260721000001_user_agent_access.sql`. Never set `MOVP_ALLOW_MERGED_MIGRATION_REWRITE`.
- **Deploy from clean `main` at `ae86c86` or later** (PR #30 `691bdd6` + PR #31 dependabot). Working tree clean.
- **Enforcement fails CLOSED.** The risk direction is "a legitimate agent is denied," never "a disabled agent leaks." Treat any post-deploy `503 agent_access_check_failed` as an availability incident, not a security one.
- Prod DB writes/deploys are gated by the local CC classifier — run Tasks 1–5 yourself via `!` or a terminal. Cloudflare token comes from Keychain `cloudflare/norcal-crew/admin-token`; never print it.

---

### Task 0 (optional, pre-build): fold in R-a

- [ ] In `packages/auth/src/agent-access.ts`, `lookupPreferences`: classify a `{ error, status: 0 }` (or absent-status) postgrest response as **retryable**, so "retry once on transport error" fires for the representation supabase-js actually returns on a transport failure. Add a unit case (`rpc` resolves `{error, status:0}` → `attempt: 2`). Fail-closed already holds without this; it is resilience only. If skipped, note it in the execution record.

### Task 1: Pre-flight — code, target, and single pending migration

- [ ] `git rev-parse --short HEAD` → `ae86c86` (or later); `git status` clean.
- [ ] `pnpm check:supabase-cli-pins` passes; `supabase --version` → `2.109.1`; `deno --version` → `2.9.2`.
- [ ] `supabase projects list` → confirm `movp-prod == poocqnzsrwipbweeacbd`; **not** `fmnwipusmtloximgtzww`.
- [ ] `supabase link --project-ref poocqnzsrwipbweeacbd` (no `--yes` on `link`).
- [ ] `supabase migration list --linked` → **exactly one** local-only pending: `20260721000001`. If more appear, STOP and reconcile — a foreign migration history means the wrong target.

**Gate:** one pending migration, correct ref, pins green.

### Task 2: Apply the migration (DB layer — safe while old functions run)

- [ ] `supabase db push` → applies `20260721000001_user_agent_access.sql` only.
- [ ] Verify the new RPC shape is live (old functions still fine):
  ```sh
  supabase db query --linked "select public.resolve_pat('movp_pat_nope') ->> 'status';"   # expect: not_found
  supabase db query --linked "select has_function_privilege('authenticated','public.evaluate_agent_access(uuid)','execute');"  # expect: f
  ```

**Gate:** migration applied; `resolve_pat` returns a status; `authenticated` CANNOT execute `evaluate_agent_access`.

### Task 3: Deploy the four PAT-snapshot edge functions (only after Task 2's gate)

Order within is not significant, but do `auth-exchange` first. Confirm multi-name support with `supabase functions deploy --help` if you want to collapse these into one call.

- [ ] `supabase functions deploy auth-exchange --project-ref poocqnzsrwipbweeacbd`
- [ ] `supabase functions deploy mcp --project-ref poocqnzsrwipbweeacbd`
- [ ] `supabase functions deploy graphql --project-ref poocqnzsrwipbweeacbd`
- [ ] `supabase functions deploy ingest --project-ref poocqnzsrwipbweeacbd`

**Gate:** all four deploy clean; a PAT that is enabled still authenticates end-to-end (Task 6c).

### Task 4: Hosted Auth config — recovery template + redirect (F4 landmine)

`config.toml` does not reach hosted. In Studio → Authentication:

- [ ] **Email Templates → Reset Password:** paste the body of `supabase/templates/recovery.html`. It MUST keep `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` and MUST NOT use `{{ .ConfirmationURL }}`.
- [ ] **URL Configuration:** Site URL = deployed frontend origin; Redirect URLs allow the exact `/auth/callback`.

**Gate:** a recovery request email links to the confirm page (not a one-click implicit URL).

### Task 5: Frontend Worker (Astro → Cloudflare Norcal Crew)

**Dependency:** Task 3's `graphql` deployment and gate MUST be complete before this task. The Security
page calls the new `agentAccessPreferences` query and `updateAgentAccessPreferences` mutation; deploying
the frontend first would publish controls whose backend operations do not exist yet.

- [ ] Export the existing public production values, load the account-scoped token from Keychain, and
      prove both the Cloudflare account and Worker name before building:
  ```sh
  export MOVP_API="https://poocqnzsrwipbweeacbd.supabase.co"
  export FRONTEND_URL="https://movp-frontend-astro.norcal-crew.workers.dev"
  export CLOUDFLARE_ACCOUNT_ID="ab0a68585c2155286627e8ea385e8709"
  export CLOUDFLARE_API_TOKEN="$(security find-generic-password -a "$USER" -s "cloudflare/norcal-crew/admin-token" -w)"
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  : "${ANON_KEY:?load the recorded public movp-prod anon key}"
  : "${WORKSPACE_ID:?load the recorded production workspace id}"

  cd "$REPO_ROOT/templates/frontend-astro"
  test ! -L wrangler.jsonc
  test "$(wc -c < wrangler.jsonc)" -le 65536
  test "$(jq -r '.name' wrangler.jsonc)" = "movp-frontend-astro"
  pnpm exec wrangler whoami --account "$CLOUDFLARE_ACCOUNT_ID"
  ```
  Expected: `whoami` identifies **Norcal Crew** account
  `ab0a68585c2155286627e8ea385e8709`; the config assertion identifies
  `movp-frontend-astro`. Any other account or Worker name is a STOP.

- [ ] Build first, then run the mandatory dry-run with a bounded, private output directory:
  ```sh
  set -euo pipefail
  TASK5_TMP_BASE="${TMPDIR:-/tmp}"
  TASK5_TMP_BASE="${TASK5_TMP_BASE%/}"
  TASK5_TMP="$(mktemp -d "$TASK5_TMP_BASE/movp-frontend-dry-run.XXXXXX")"

  pnpm build
  test -f dist/server/entry.mjs
  test -d dist/client
  test -f dist/server/wrangler.json
  pnpm exec wrangler deploy --dry-run --outdir "$TASK5_TMP/bundle" 2>&1 \
    | tee "$TASK5_TMP/dry-run.log"
  test ! -L "$TASK5_TMP/dry-run.log"
  test "$(wc -c < "$TASK5_TMP/dry-run.log")" -le 1048576
  for binding in SESSION ASSETS GRAPHQL_ENDPOINT SUPABASE_URL SUPABASE_ANON_KEY WORKSPACE_ID; do
    grep -F "$binding" "$TASK5_TMP/dry-run.log" >/dev/null
  done
  ```
  Expected: Astro creates `dist/server/wrangler.json`; Wrangler exits 0 and lists `SESSION`,
  `ASSETS`, and all four public vars. Source `wrangler.jsonc` remains pointed at
  `@astrojs/cloudflare/entrypoints/server`, never a generated `dist/*` entrypoint.

- [ ] Deploy with the four production values explicitly overriding the localhost placeholders in
      source `wrangler.jsonc`:
  ```sh
  pnpm exec wrangler deploy \
    --var GRAPHQL_ENDPOINT:"$MOVP_API/functions/v1/graphql" \
    --var SUPABASE_URL:"$MOVP_API" \
    --var SUPABASE_ANON_KEY:"$ANON_KEY" \
    --var WORKSPACE_ID:"$WORKSPACE_ID"
  unset CLOUDFLARE_API_TOKEN
  rm -rf -- "$TASK5_TMP"
  cd "$REPO_ROOT"
  ```
  Expected: `Deployed movp-frontend-astro` and
  `https://movp-frontend-astro.norcal-crew.workers.dev`. The existing `SESSION` binding is
  reused; no namespace or Worker is created under another account.

**Gate:** correct account and Worker name; build + dry-run pass with all six bindings; production
deploy receives all four explicit prod vars; the deployed origin serves the signed-in sticky nav.

### Task 6: Verification gate — enforcement is real and nothing regressed

Use the existing production owner **`ensell@norcalcrew.org`**, whose permanent membership was
asserted unchanged by the v0.1.1 execution record. Do NOT toggle the `norcalos-service` identity:
its permanent PAT is live integration infrastructure.

- [ ] **Setup — disposable credentials with explicit provenance and cleanup.**

  1. Sign in at `$FRONTEND_URL` as `ensell@norcalcrew.org` using the production magic-link flow.
  2. At `/settings/tokens`, create one PAT named `agent-access-deploy-YYYYMMDD`; record its token id
     and copy the one-time raw token.
  3. At `/admin/api-keys`, create one ingest key with the same label; record its key id and copy the
     one-time raw key.
  4. In browser DevTools → Application/Storage → Cookies, copy the HttpOnly `sb-access-token` value
     for `$FRONTEND_URL`. It is the same owner session that renders the Security page.
  5. Load the three values without echoing them or placing their literal values in shell history,
     then define bounded curl helpers that pass credentials over stdin rather than process argv:

  ```sh
  set -euo pipefail
  export MOVP_API="https://poocqnzsrwipbweeacbd.supabase.co"
  export FRONTEND_URL="https://movp-frontend-astro.norcal-crew.workers.dev"
  : "${ANON_KEY:?load the recorded public movp-prod anon key}"
  : "${WORKSPACE_ID:?load the recorded production workspace id}"

  printf 'Paste owner session JWT: ' >&2
  IFS= read -r -s SESSION_JWT
  printf '\nPaste scratch PAT: ' >&2
  IFS= read -r -s SCRATCH_PAT
  printf '\nPaste scratch ingest key: ' >&2
  IFS= read -r -s SCRATCH_INGEST_KEY
  printf '\n' >&2

  VERIFY_TMP_BASE="${TMPDIR:-/tmp}"
  VERIFY_TMP_BASE="${VERIFY_TMP_BASE%/}"
  VERIFY_DIR="$(mktemp -d "$VERIFY_TMP_BASE/movp-agent-access-verify.XXXXXX")"
  MAX_VERIFY_RESPONSE_BYTES=262144 # 256 KiB; the 176-tool tools/list frame is ~78 KiB.
  cleanup_verify() {
    unset SESSION_JWT SCRATCH_PAT SCRATCH_INGEST_KEY
    if [ -n "${VERIFY_DIR:-}" ] && [ -d "$VERIFY_DIR" ] && [ ! -L "$VERIFY_DIR" ]; then
      case "$VERIFY_DIR" in
        "$VERIFY_TMP_BASE"/movp-agent-access-verify.*) rm -rf -- "$VERIFY_DIR" ;;
        *) printf 'Refusing to remove unexpected verification path: %s\n' "$VERIFY_DIR" >&2 ;;
      esac
    fi
  }
  trap cleanup_verify EXIT INT TERM

  curl_bearer() {
    local token="$1"
    shift
    printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$token" "$ANON_KEY" \
      | curl --config - --silent --show-error --max-time 30 \
          --max-filesize "$MAX_VERIFY_RESPONSE_BYTES" "$@"
  }
  curl_ingest_key() {
    local key="$1"
    shift
    printf 'header = "apikey: %s"\nheader = "x-ingest-key: %s"\n' "$ANON_KEY" "$key" \
      | curl --config - --silent --show-error --max-time 30 \
          --max-filesize "$MAX_VERIFY_RESPONSE_BYTES" "$@"
  }
  assert_response_file() {
    test -f "$1"
    test ! -L "$1"
    test "$(wc -c < "$1")" -le "$MAX_VERIFY_RESPONSE_BYTES"
  }
  assert_denial() {
    local status="$1" expected_status="$2" body="$3" expected_code="$4"
    test "$status" = "$expected_status"
    assert_response_file "$body"
    jq -e --arg code "$expected_code" '.error == $code' "$body" >/dev/null
  }
  mcp_json_frames() {
    local body="$1"
    assert_response_file "$body"
    if grep -q '^data:' "$body"; then
      sed -n 's/^data:[[:space:]]*//p' "$body"
    else
      cat "$body"
    fi
  }
  assert_mcp_tools() {
    local body="$1" request_id="$2"
    mcp_json_frames "$body" \
      | jq -se --argjson request_id "$request_id" \
          'any(.[]; .id == $request_id and ((.result.tools // []) | length > 0))' >/dev/null
  }
  ```

- [ ] **a) MCP disabled — both credential kinds deny.** At `/settings/security`, set MCP access
      OFF and PAT-backed CLI/API access ON; refresh and confirm the authoritative values persist.
      Then run:
  ```sh
  mcp_session_status="$(curl_bearer "$SESSION_JWT" \
    -o "$VERIFY_DIR/mcp-session-disabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  assert_denial "$mcp_session_status" 403 "$VERIFY_DIR/mcp-session-disabled.json" mcp_access_disabled

  mcp_pat_status="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/mcp-pat-disabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
  assert_denial "$mcp_pat_status" 403 "$VERIFY_DIR/mcp-pat-disabled.json" mcp_access_disabled
  ```
  Expected: both assertions exit 0. The session-JWT denial is the load-bearing no-bypass gate.

- [ ] **b) PAT-backed CLI/API disabled — PAT seams deny; ingest API-key seam remains live.**
      Set MCP access ON and PAT-backed CLI/API access OFF; refresh and confirm the authoritative
      values persist. Then run:
  ```sh
  exchange_status="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/exchange-disabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/auth-exchange" \
    -H 'content-type: application/json' -d '{}')"
  assert_denial "$exchange_status" 403 "$VERIFY_DIR/exchange-disabled.json" cli_access_disabled

  graphql_pat_status="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/graphql-pat-disabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/graphql" \
    -H 'content-type: application/json' -d '{"query":"query{__typename}"}')"
  assert_denial "$graphql_pat_status" 403 "$VERIFY_DIR/graphql-pat-disabled.json" cli_access_disabled

  ingest_pat_status="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/ingest-pat-disabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/ingest" \
    -H 'content-type: application/json' -d '{"events":[]}')"
  assert_denial "$ingest_pat_status" 403 "$VERIFY_DIR/ingest-pat-disabled.json" cli_access_disabled

  ingest_key_status="$(curl_ingest_key "$SCRATCH_INGEST_KEY" \
    -o "$VERIFY_DIR/ingest-key-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/ingest" \
    -H 'content-type: application/json' -d '{"events":[]}')"
  test "$ingest_key_status" = 200
  assert_response_file "$VERIFY_DIR/ingest-key-enabled.json"
  jq -e '.inserted == 0 and .dropped == 0 and .duplicate == 0 and .conflict == 0' \
    "$VERIFY_DIR/ingest-key-enabled.json" >/dev/null
  ```
  Expected: the three PAT requests return `403 cli_access_disabled`; the API-key empty-batch
  preflight returns `200` without inserting an event.

- [ ] **c) Positive paths and missing-row default.** Restore both switches ON, refresh, and confirm
      both remain ON. First prove the database default without manufacturing a production Auth user:
  ```sh
  supabase db query --linked \
    "select
       not exists (
         select 1
           from movp_internal.user_agent_access
          where user_id = '00000000-0000-4000-8000-000000000001'::uuid
       ) as preference_row_absent,
       public.evaluate_agent_access('00000000-0000-4000-8000-000000000001'::uuid) as preferences;"
  ```
  Expected: `preference_row_absent = true` and
  `{"mcp_enabled": true, "cli_enabled": true}`. If the fixed probe id unexpectedly has a row,
  STOP and choose another non-user UUID before evaluating the default.
  Then run the live positive gates:
  ```sh
  mcp_pat_ok="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/mcp-pat-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')"
  test "$mcp_pat_ok" = 200
  assert_mcp_tools "$VERIFY_DIR/mcp-pat-enabled.json" 3

  mcp_session_ok="$(curl_bearer "$SESSION_JWT" \
    -o "$VERIFY_DIR/mcp-session-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')"
  test "$mcp_session_ok" = 200
  assert_mcp_tools "$VERIFY_DIR/mcp-session-enabled.json" 4

  exchange_ok="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/exchange-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/auth-exchange" \
    -H 'content-type: application/json' -d '{}')"
  test "$exchange_ok" = 200
  assert_response_file "$VERIFY_DIR/exchange-enabled.json"
  jq -e '.access_token | type == "string" and length > 0' "$VERIFY_DIR/exchange-enabled.json" >/dev/null

  graphql_pat_ok="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/graphql-pat-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/graphql" \
    -H 'content-type: application/json' -d '{"query":"query{__typename}"}')"
  test "$graphql_pat_ok" = 200
  assert_response_file "$VERIFY_DIR/graphql-pat-enabled.json"
  jq -e '.data.__typename == "Query"' "$VERIFY_DIR/graphql-pat-enabled.json" >/dev/null

  ingest_pat_ok="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/ingest-pat-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/ingest" \
    -H 'content-type: application/json' -d '{"events":[]}')"
  test "$ingest_pat_ok" = 200
  assert_response_file "$VERIFY_DIR/ingest-pat-enabled.json"
  jq -e '.inserted == 0 and .dropped == 0' "$VERIFY_DIR/ingest-pat-enabled.json" >/dev/null
  ```
  Expected: every status assertion exits 0; MCP normalizes its raw-JSON/SSE response and returns a
  non-empty registry for each matching request id; exchange returns a bounded session; GraphQL
  returns `Query`; ingest authenticates without inserting an event.

- [ ] **d) Browser session remains unaffected on GraphQL and ingest.**
  ```sh
  graphql_session_ok="$(curl_bearer "$SESSION_JWT" \
    -o "$VERIFY_DIR/graphql-session-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/graphql" \
    -H 'content-type: application/json' -d '{"query":"query{__typename}"}')"
  test "$graphql_session_ok" = 200
  assert_response_file "$VERIFY_DIR/graphql-session-enabled.json"
  jq -e '.data.__typename == "Query"' "$VERIFY_DIR/graphql-session-enabled.json" >/dev/null

  ingest_session_ok="$(curl_bearer "$SESSION_JWT" \
    -o "$VERIFY_DIR/ingest-session-enabled.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/ingest" \
    -H 'content-type: application/json' -d '{"events":[]}')"
  test "$ingest_session_ok" = 200
  assert_response_file "$VERIFY_DIR/ingest-session-enabled.json"
  jq -e '.inserted == 0 and .dropped == 0' "$VERIFY_DIR/ingest-session-enabled.json" >/dev/null
  ```
  Expected: both session-JWT requests return 200 with the asserted bodies.

- [ ] **e) Restore and destroy the disposable credentials before the recovery smoke logs the
      browser out.** Confirm both switches are ON. Revoke the recorded scratch PAT at
      `/settings/tokens` and the scratch ingest key at `/admin/api-keys`, then prove both secrets
      are dead:
  ```sh
  revoked_pat_status="$(curl_bearer "$SCRATCH_PAT" \
    -o "$VERIFY_DIR/pat-revoked.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}')"
  assert_denial "$revoked_pat_status" 401 "$VERIFY_DIR/pat-revoked.json" invalid_token

  revoked_ingest_status="$(curl_ingest_key "$SCRATCH_INGEST_KEY" \
    -o "$VERIFY_DIR/ingest-key-revoked.json" -w '%{http_code}' -X POST \
    "$MOVP_API/functions/v1/ingest" \
    -H 'content-type: application/json' -d '{"events":[]}')"
  assert_denial "$revoked_ingest_status" 401 "$VERIFY_DIR/ingest-key-revoked.json" invalid_ingest_key
  ```
  Expected: the PAT returns `401 invalid_token`; the API key returns `401 invalid_ingest_key`.

- [ ] **f) Frontend smoke.** Confirm the nav renders signed-in; profile save persists and updates
      the display name in the nav; security switches still show both ON after refresh; then run the
      recovery flow end-to-end (request → email → confirm page → password form → forced re-login).

**Failure diagnosis:** hosted CLI `2.109.1` has no `supabase functions logs` command. In the
Supabase Dashboard for `movp-prod`, open **Functions → affected function → Invocations/Logs**.
Filter by the request time, HTTP status, `surface`, and stable `error_code`; correlate
`request_id`/`trace_id` and `actor_id`. Ordinary policy denials do not carry timing fields.
An exhausted preference transport failure additionally carries `attempt: 2` and `latency_ms`.
Never paste a JWT, PAT, ingest key, request body, or response containing `access_token` into the
execution record.

**Gate:** every negative denial has the exact status and stable code; every positive has both the
expected status and body shape; the missing-row default is true; both disposable credentials are
revoked; both switches finish ON; recovery completes.

## Risks & rollback

- **Functions-before-migration = PAT outage.** The whole point of the sequence. If you suspect it happened, apply the migration immediately (Task 2) — it repairs live PAT auth without a redeploy.
- **Recovery template not set in hosted (Task 4 skipped) ⇒ broken password recovery in prod** even though local E2E is green (local uses `config.toml`). This is F4; do not treat local green as proof.
- **Rollback:** the migration is additive and backward-compatible — **leave it applied**. The exact
  pre-PR #30 source is `ecbdb604fd97a7042d0aae799a74f0891a0f24d1` (`691bdd6^`). In a separate
  clean worktree at that commit, install the frozen workspace and redeploy the four prior functions
  to the explicit production ref:
  ```sh
  ROLLBACK_BASE="${TMPDIR:-/tmp}"
  ROLLBACK_BASE="${ROLLBACK_BASE%/}"
  ROLLBACK_PARENT="$(mktemp -d "$ROLLBACK_BASE/movp-agent-access-rollback.XXXXXX")"
  git worktree add "$ROLLBACK_PARENT/source" ecbdb604fd97a7042d0aae799a74f0891a0f24d1
  cd "$ROLLBACK_PARENT/source"
  pnpm install --frozen-lockfile
  for function_name in auth-exchange mcp graphql ingest; do
    supabase functions deploy "$function_name" --project-ref poocqnzsrwipbweeacbd
  done
  ```
  Expected: all four prior functions deploy from the named commit. The old `pat.ts` ignores the new
  columns and the switches stop being enforced. Do not revert the migration. After the incident is
  closed, remove the worktree with `git worktree remove "$ROLLBACK_PARENT/source"` and then remove
  the now-empty task-specific parent directory. Because enforcement fails closed, a misbehaving
  check denies legitimate agents (availability), never over-grants.
- **R-a residual:** until folded in (Task 0), a transport-level preference-read failure that surfaces as `{status:0}` denies on attempt 1 instead of retrying once. Fail-closed; Reliability-only.

## Execution record — YYYY-MM-DD

_(fill on deploy: HEAD deployed, migration applied Y/N, four functions + versions, hosted-auth-config
set Y/N, confirmed Cloudflare account id + Worker name, frontend deploy id, Task 6 a–f results,
scratch PAT/API-key ids + revocation confirmations (never raw values), final switch state, whether
Task 0/R-a was folded in, any deviation.)_
