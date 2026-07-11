# MOVP Stage C3d — `[agents]` End-to-End Slice + CI

> **EXECUTION DEVIATION (2026-07-10):** `mcp-remote@0.1.38` intermittently dropped static PAT
> headers and attempted OAuth during the C3c gate, so the plan-sanctioned fallback shipped as
> `@movp/mcp-bridge`. The executed slice uses `scripts/mcp-bridge-probe.mjs`; see
> `docs/agents/mcp/stdio-bridge.md` for the decision and supported configuration. References to
> `mcp-remote` below are preserved as the original TDD instructions, not the current runtime path.

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the bash verbatim — it is grounded in the real committed
> `scripts/slice-e2e.sh` (line-verified 2026-07-09), the frozen C3 contracts, and the
> committed MCP/CLI/auth code. This is the **integration/gate** part of Stage C3: it wires
> the pieces C3a/C3b/C3c already delivered into one end-to-end slice, plus CI.
>
> **PRECONDITION (hard, cross-part): C3a + C3b + C3c are all merged.** C3d is LAST. It consumes
> their surfaces (PAT lifecycle RPCs + GraphQL, `auth-exchange` edge fn, `resolvePrincipal` PAT
> branch, `movp login`/PAT credential mode/`--mode hybrid`, MCP streamable-HTTP endpoint, the
> `mcp-remote` stdio bridge decision). Do **not** start C3d until all three are on `main`.
> Design source: `docs/superpowers/specs/2026-07-09-movp-stage-c-03-agent-connectivity-design.md`
> (§13, and "Testing strategy → Slice (C3d)"). Frozen contracts: the C3 contracts sheet.

**Goal:** one `scripts/slice-e2e.sh` `[agents]` block proves the full headless-agent chain
against the live local stack — **mint a user-scoped PAT → exchange it for a real session →
reach MCP (streamable HTTP + `mcp-remote` stdio) and the CLI with that PAT → run a real authed
action + a hybrid search → revoke the PAT → every surface fails closed with the auth code** —
and it runs in CI as part of the existing `slice-e2e` job. Closing gate: full CI green
including `[agents]`; the C3 phase review is **≥ 9.2**.

**Architecture:** C3d adds **no product code**. It adds (1) a small Node driver
`scripts/mcp-remote-probe.mjs` that drives the community `mcp-remote` stdio↔HTTP bridge
headlessly (init → tools/list) so a shell can assert real tool output; (2) an `[agents]`
section in `scripts/slice-e2e.sh` that greps REAL output at every step and fails loud (no
`|| true` on any assertion); (3) the one enabling harness edit — adding `auth-exchange` to the
script's `supabase functions serve …` list so the CLI/exchange HTTP surface is up. The
`slice-e2e` CI job already runs the **whole** script, so **no `.github/workflows/ci.yml` edit
is required** — the wiring is entirely inside the script. The block reuses the functions,
tokens, workspace (`$WS`), and seeded rows (`E2E note`, `E2E task`) that the earlier blocks
already created; it is inserted after `[admin]` and before the final `[8]` check.

**Tech stack:** bash + `curl` + `psql` + `node` (the slice harness), Deno edge functions
(`mcp`, `auth-exchange`, `graphql` — unchanged, served locally), `@movp/cli` (commander, run
from source via `pnpm exec tsx`), community `mcp-remote@0.1.38` (stdio bridge, run via `npx`),
Supabase CLI local stack.

---

## Global Constraints (every task inherits these)

- **TDD, failing assertion first.** The `[agents]` block is authored so it **fails loud before
  the flow is wired** (the `auth-exchange` function is not in the serve list yet → the exchange
  step 404s), then passes once the serve-list edit lands. Prove the red before the green.
- **No product code in C3d.** Do not add/modify migrations, `packages/*`, or edge-function
  bodies. If a surface the slice calls is missing or misbehaves, that is a C3a/C3b/C3c defect —
  **stop and fix the upstream part**, do not paper over it in the slice.
- **Every assertion greps REAL output and fails loud.** Mirror the existing blocks' idiom:
  `echo "$X" | grep -q '<real substring>' || { echo "<why> : $X"; exit 1; }`. Never `|| true`
  on an assertion (only on best-effort cleanup, exactly as the existing script does).
- **Keys-only observability.** Never `echo` the raw PAT. The one place the raw token appears is
  the create response (captured into a variable). The block asserts the PAT is **absent** from
  the metadata list and from the function log (mirrors `[workflows]` `grep -q "$WF_OLD_SECRET"
  /tmp/movp-functions.log`).
- **A revoked PAT MUST fail closed.** Revocation is enforced at the exchange gate (`resolve_pat`
  → `revoked` → `invalid_token`). The block asserts `401` + the stable code on MCP HTTP and
  `auth-exchange`, and a non-zero exit on the CLI. `invalid_token` is the agent-facing code
  (the internal `revoked` collapses to it — do not expect a `revoked_token` code on the wire).
- **Local-run hygiene (inline at trigger sites):**
  - The script only kills edge-runtime processes **in CI or with `MOVP_CLEAN_EDGE_RUNTIME=1`**
    (`cleanup_edge_runtime`, unchanged). The `[agents]` block does **not** restart or kill
    functions — it reuses the already-served ones — so a local run never disturbs other
    Supabase projects.
  - Functions are served with the env-file pattern and `MOVP_JWT_ISSUER=$API_URL/auth/v1`
    (unchanged). `auth-exchange` is added to the **same** `--env-file "$FN_ENV_FILE"` serve
    line, so it inherits that env and the auto-injected `SUPABASE_SERVICE_ROLE_KEY` (verified:
    `flows`/`ingest` already read `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` from local serve).
  - The CLI is exercised in **headless `MOVP_PAT` env mode** with the **file-based `0600`
    credential store forced** (`MOVP_SECURE_STORE=file`) and an **isolated `XDG_CONFIG_HOME`**, so
    a macOS run never writes to the developer's login Keychain and CI (Linux, file store
    always) behaves identically.
- **CI-tool version pinning.** `mcp-remote` is pinned (`mcp-remote@0.1.38`) — never an
  unpinned `npx mcp-remote`. This MUST equal the version C3c documented in `docs/agents/mcp/`;
  if C3c pinned a different version, use **that** version here (single source of truth).
- **One commit per task; a task is done only when its gate passes.** The phase (C3) is DONE
  only when C3a+C3b+C3c+C3d have all landed and the full gate below is green.

## File Structure

```text
scripts/
  mcp-remote-probe.mjs        # NEW  (C3d.1) headless mcp-remote stdio driver: init -> tools/list
  slice-e2e.sh                # MODIFY (C3d.1) serve auth-exchange + add the [agents] block
.github/workflows/
  ci.yml                      # NO EDIT (C3d.2) the slice-e2e job runs the whole script; verify only
docs/superpowers/plans/
  README.md                   # MODIFY (C3d.2) Stage C status table: C3 -> EXECUTED
```

---

## Task C3d.1: `auth-exchange` in the harness + the `[agents]` slice block

**Files**
- Create: `scripts/mcp-remote-probe.mjs`
- Modify: `scripts/slice-e2e.sh` (serve `auth-exchange`; add the `[agents]` section)

**Interfaces consumed (from C3a/C3b/C3c — must already be merged):**
```text
GraphQL (C3a, called with the user's session JWT $TOKEN via post_graphql):
  mutation createPersonalAccessToken(defaultWorkspaceId: ID!, name: String!, ttlDays: Int): CreatedPat!  -> { tokenId, token }
  query    personalAccessTokens: [PersonalAccessToken!]!                                                 -> [{ id, name, defaultWorkspaceId, createdAt, revokedAt, ... }]
  mutation revokePersonalAccessToken(tokenId: ID!): Boolean!
Edge (C3a):
  POST $API_URL/functions/v1/auth-exchange   Authorization: Bearer movp_pat_…  -> 200 { access_token, expires_at, default_workspace_id, user_id } | 401 { error: <code> }
  POST $API_URL/functions/v1/mcp             Authorization: Bearer movp_pat_…  (resolvePrincipal PAT branch) streamable-HTTP JSON-RPC
CLI (C3b, from source via `pnpm exec tsx packages/cli/src/bin.ts`):
  MOVP_PAT env credential mode  ·  `movp task list --workspace <id>`  ·  `movp search <q> --workspace <id> --mode hybrid`  ·  `movp login --token <pat>`
Stdio bridge (C3c decision): community `mcp-remote@0.1.38` with `--header` static auth + `--allow-http`.
```

**Grounding (verified in the committed code):**
- `post_graphql` sends `Authorization: Bearer $TOKEN` (the `e2e@example.com` session JWT) +
  `apikey: $ANON_KEY`. `$USER_ID` is that user's `sub`; `$WS =
  33333333-3333-3333-3333-333333333333`; that user is the **owner** of `$WS`. Seeded rows in
  `$WS` that later steps assert on: a note titled **`E2E note`** (body `semantic lighthouse
  phrase for e2e verification`) and a task titled **`E2E task`**.
- MCP tool names are `${collection}.list` / `.get` / `.search` (e.g. **`note.list`**); `note`
  is non-internal so it is listed. The MCP edge fn returns `content-type: application/json` (or
  an SSE frame when `accept: text/event-stream`); the existing `[4]` block greps the raw body
  regardless, so this block does too.
- The MCP streamable-HTTP transport is **stateless** (`sessionIdGenerator: undefined`), which is
  why the existing `[4]` block issues a bare `tools/list` with no `initialize` handshake; a bare
  `tools/call` is handled the same way. (`mcp-remote` stdio, by contrast, IS a stateful client,
  so the probe below performs the full init → initialized → tools/list handshake.)
- The MCP PAT branch does the GoTrue exchange **in-process** (`resolvePrincipal` →
  `resolvePatToken`), so MCP-over-HTTP works even if the `auth-exchange` HTTP fn is not served.
  Only the direct exchange curl and the CLI need the `auth-exchange` endpoint — the block calls
  the exchange curl **first**, which is what makes the red step fail cleanly.

### TDD steps

- [ ] **Step 1 — create the headless stdio driver** `scripts/mcp-remote-probe.mjs` (verbatim).
  It spawns `mcp-remote`, feeds newline-delimited JSON-RPC to its stdin, and asserts a real
  tool (`note.list`) appears in `tools/list`. Prints `MCP_STDIO_TOOLS_OK` and exits `0` on
  success; non-zero otherwise.

```js
#!/usr/bin/env node
// C3d [agents] slice: drive the community `mcp-remote` stdio<->HTTP bridge headlessly and
// assert the streamable-HTTP MCP endpoint lists a real generated tool over stdio.
// GOTCHA: mcp-remote starts an OAuth *browser* flow unless a static `--header` is supplied,
// and it refuses a non-https endpoint without `--allow-http` (the local endpoint is http).
// Both flags + the pinned version MUST match what C3c documented in docs/agents/mcp/.
import { spawn } from 'node:child_process'

const endpoint = process.env.MCP_ENDPOINT
const pat = process.env.MCP_PAT
const apikey = process.env.MCP_APIKEY
if (!endpoint || !pat) {
  console.error('MCP_ENDPOINT and MCP_PAT are required')
  process.exit(2)
}
const timeoutMs = Number(process.env.MCP_PROBE_TIMEOUT ?? 90000)

const args = ['-y', 'mcp-remote@0.1.38', endpoint, '--header', `Authorization: Bearer ${pat}`]
if (apikey) args.push('--header', `apikey: ${apikey}`)
args.push('--allow-http')

const child = spawn('npx', args, { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let ok = false
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
const finish = (code) => {
  clearTimeout(timer)
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(code)
}
const timer = setTimeout(() => {
  console.error(`mcp-remote stdio probe timed out after ${timeoutMs}ms`)
  finish(1)
}, timeoutMs)

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue } // mcp-remote also logs non-JSON to stdout
    if (msg.id === 1 && msg.result) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    } else if (msg.id === 2) {
      const tools = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools : []
      if (tools.some((t) => t && t.name === 'note.list')) {
        ok = true
        console.log('MCP_STDIO_TOOLS_OK')
        finish(0)
      } else {
        console.error(`tools/list via mcp-remote is missing note.list: ${line}`)
        finish(1)
      }
    }
  }
})
child.on('exit', (code) => {
  if (!ok) {
    console.error(`mcp-remote exited before tools/list succeeded (code=${code})`)
    finish(1)
  }
})
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'movp-slice-probe', version: '0.0.0' } },
})
```

- [ ] **Step 2 — add the `[agents]` block** to `scripts/slice-e2e.sh`, **immediately after** the
  `[admin] (d)` section (after the current line 805, the `ADMIN_NOTE_WS` check) and **before**
  the `== [8] internal not exposed via PostgREST API ==` section (current line 807). Paste
  verbatim:

```bash
echo "== [agents] mint a user-scoped PAT via the web RPC (as the e2e owner) =="
# PATs are USER-SCOPED: this PAT grants exactly $USER_ID's own access. default_workspace_id
# ($WS) is a CLI home hint, NOT an access boundary. Minted via the GraphQL surface with the
# user's session JWT ($TOKEN) — mirrors how [admin] mints an ingest key via createIngestKey.
AGENTS_PAT_CREATE="$(post_graphql "{\"query\":\"mutation{createPersonalAccessToken(defaultWorkspaceId:\\\"$WS\\\", name:\\\"agents-slice\\\"){tokenId token}}\"}")"
AGENTS_PAT="$(echo "$AGENTS_PAT_CREATE" | json_get data.createPersonalAccessToken.token)"
AGENTS_PAT_ID="$(echo "$AGENTS_PAT_CREATE" | json_get data.createPersonalAccessToken.tokenId)"
[ -n "$AGENTS_PAT" ] && [ -n "$AGENTS_PAT_ID" ] || { echo "createPersonalAccessToken failed: $AGENTS_PAT_CREATE"; exit 1; }
# assert the movp_pat_ prefix WITHOUT echoing the raw token (keys-only obs)
case "$AGENTS_PAT" in movp_pat_*) : ;; *) echo "PAT missing movp_pat_ prefix (create response shape wrong)"; exit 1;; esac

echo "== [agents] the metadata list exposes the PAT but never the raw token/hash =="
AGENTS_PAT_LIST="$(post_graphql '{"query":"query{personalAccessTokens{id name defaultWorkspaceId createdAt revokedAt}}"}')"
echo "$AGENTS_PAT_LIST" | grep -q 'agents-slice' || { echo "personalAccessTokens did not list the PAT: $AGENTS_PAT_LIST"; exit 1; }
echo "$AGENTS_PAT_LIST" | grep -q "$AGENTS_PAT" && { echo "personalAccessTokens leaked the raw PAT: $AGENTS_PAT_LIST"; exit 1; } || true

echo "== [agents] exchange the PAT for a real session via the auth-exchange edge fn =="
# The CLI login/headless path relies on THIS endpoint being served (see the serve-list edit).
AGENTS_EX="$(curl -sS "$API_URL/functions/v1/auth-exchange" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d '{}')"
echo "$AGENTS_EX" | grep -q 'access_token' || { echo "auth-exchange did not return a session (is auth-exchange served?): $AGENTS_EX"; exit 1; }
AGENTS_EX_SUB="$(echo "$AGENTS_EX" | json_get user_id)"
[ "$AGENTS_EX_SUB" = "$USER_ID" ] || { echo "exchange resolved the wrong user ($AGENTS_EX_SUB != $USER_ID): $AGENTS_EX"; exit 1; }

echo "== [agents] MCP over streamable HTTP with the PAT: tools/list + a real tool-call =="
# Bearer is the movp_pat_ token -> resolvePrincipal's PAT branch mints a session in-process and
# binds principal.db under RLS. The transport is stateless (no initialize handshake needed),
# exactly as the [4] block already proves for tools/list.
AGENTS_MCP_LIST="$(curl -sS "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$AGENTS_MCP_LIST" | grep -q 'note.list' || { echo "MCP tools/list (PAT auth) missing note.list: $AGENTS_MCP_LIST"; exit 1; }
AGENTS_MCP_CALL="$(curl -sS "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"note.list\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")"
echo "$AGENTS_MCP_CALL" | grep -q 'E2E note' || { echo "MCP note.list (PAT auth) returned no real data: $AGENTS_MCP_CALL"; exit 1; }

echo "== [agents] MCP over stdio via mcp-remote with the PAT: tools/list =="
AGENTS_STDIO="$(MCP_ENDPOINT="$API_URL/functions/v1/mcp" MCP_PAT="$AGENTS_PAT" MCP_APIKEY="$ANON_KEY" \
  node scripts/mcp-remote-probe.mjs)"
echo "$AGENTS_STDIO" | grep -q 'MCP_STDIO_TOOLS_OK' || { echo "mcp-remote stdio tools/list did not list note.list: $AGENTS_STDIO"; exit 1; }

echo "== [agents] CLI authed action + hybrid search via the PAT (headless MOVP_PAT mode) =="
# GOTCHA: force the file-based 0600 credential store (MOVP_SECURE_STORE=file) and an isolated
# XDG_CONFIG_HOME so a local macOS run never writes to the developer login Keychain; CI (Linux)
# uses the file store anyway. The CLI is run from source via tsx (no build step needed).
AGENTS_XDG="$(mktemp -d "${TMPDIR:-/tmp}/movp-agents-xdg.XXXXXX")"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_SECURE_STORE=file XDG_CONFIG_HOME="$AGENTS_XDG"
AGENTS_TASKS="$(MOVP_PAT="$AGENTS_PAT" pnpm exec tsx packages/cli/src/bin.ts task list --workspace "$WS")"
echo "$AGENTS_TASKS" | grep -q 'E2E task' || { echo "movp task list (PAT auth) returned no real data: $AGENTS_TASKS"; exit 1; }
AGENTS_HYBRID="$(MOVP_PAT="$AGENTS_PAT" pnpm exec tsx packages/cli/src/bin.ts search 'semantic lighthouse' --workspace "$WS" --mode hybrid)"
echo "$AGENTS_HYBRID" | grep -q 'E2E note' || { echo "movp search --mode hybrid (PAT auth) returned no hit: $AGENTS_HYBRID"; exit 1; }

echo "== [agents] revoke the PAT -> every surface fails closed with the auth code =="
post_graphql "{\"query\":\"mutation{revokePersonalAccessToken(tokenId:\\\"$AGENTS_PAT_ID\\\")}\"}" | grep -q 'true' \
  || { echo "revokePersonalAccessToken did not return true"; exit 1; }
# (1) MCP over HTTP with the revoked PAT -> 401 + stable code (mirrors the [6] fail-closed block)
AGENTS_MCP_401="$(curl -sS -o /tmp/agents-mcp-revoked.json -w '%{http_code}' "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$AGENTS_MCP_401" = "401" ] || { echo "revoked PAT still reached MCP ($AGENTS_MCP_401): $(cat /tmp/agents-mcp-revoked.json)"; exit 1; }
grep -q 'invalid_token' /tmp/agents-mcp-revoked.json || { echo "MCP 401 body missing the stable auth code: $(cat /tmp/agents-mcp-revoked.json)"; exit 1; }
# (2) auth-exchange with the revoked PAT -> 401 + stable code
AGENTS_EX_401="$(curl -sS -o /tmp/agents-ex-revoked.json -w '%{http_code}' "$API_URL/functions/v1/auth-exchange" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d '{}')"
[ "$AGENTS_EX_401" = "401" ] || { echo "revoked PAT still exchanged a session ($AGENTS_EX_401): $(cat /tmp/agents-ex-revoked.json)"; exit 1; }
grep -q 'invalid_token' /tmp/agents-ex-revoked.json || { echo "exchange 401 body missing the stable auth code: $(cat /tmp/agents-ex-revoked.json)"; exit 1; }
# (3) the CLI re-validates via the exchange on EVERY login, so a revoked PAT fails closed
# (non-zero) immediately. GOTCHA: an already-minted session stays valid up to jwt_expiry (~1h);
# `movp login` re-exchanges, so it does not depend on that documented residual window.
if MOVP_PAT="$AGENTS_PAT" pnpm exec tsx packages/cli/src/bin.ts login --token "$AGENTS_PAT" >/tmp/agents-cli-revoked.log 2>&1; then
  echo "revoked PAT was accepted by movp login: $(cat /tmp/agents-cli-revoked.log)"; exit 1
fi
grep -qiE 'token|auth' /tmp/agents-cli-revoked.log || { echo "movp login failure did not surface an auth/token error: $(cat /tmp/agents-cli-revoked.log)"; exit 1; }

echo "== [agents] keys-only: the function log never printed the raw PAT =="
grep -q "$AGENTS_PAT" /tmp/movp-functions.log && { echo "function log leaked the raw PAT (keys-only obs violated)"; exit 1; } || true
rm -rf "$AGENTS_XDG"
```

- [ ] **Step 3 — run the slice with `auth-exchange` NOT yet served, expect RED:**
Run: `bash scripts/slice-e2e.sh`
Expected: **FAIL** inside `== [agents] exchange the PAT for a real session … ==` with
`auth-exchange did not return a session (is auth-exchange served?): …` — the `functions serve`
line does not yet include `auth-exchange`, so `$API_URL/functions/v1/auth-exchange` 404s. (All
earlier blocks, through `[admin]`, still print their `==` headers and pass.)

- [ ] **Step 4 — wire the harness (make it GREEN):** add `auth-exchange` to the script's
  `supabase functions serve …` line. Exact single-token edit at the current line 144:

```diff
-supabase_local functions serve graphql mcp index-embeddings flows ingest --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
+supabase_local functions serve graphql mcp index-embeddings flows ingest auth-exchange --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
```
  Nothing else changes: `auth-exchange` inherits `--env-file "$FN_ENV_FILE"` (so
  `MOVP_JWT_ISSUER=$API_URL/auth/v1`) and the auto-injected `SUPABASE_SERVICE_ROLE_KEY`; the
  existing GraphQL readiness wait (which blocks until the served functions boot) covers it.

- [ ] **Step 5 — run the slice, expect GREEN:**
Run: `bash scripts/slice-e2e.sh`
Expected: prints an `== [agents] … ==` section (mint → list → exchange → MCP HTTP → mcp-remote
stdio → CLI task-list + hybrid → revoke→401/401/non-zero → keys-only), then `slice-e2e: PASS`.

- [ ] **Step 6 — gate + commit:**
Run: `bash scripts/slice-e2e.sh` (final line `slice-e2e: PASS`) and confirm the transcript
contains an `[agents]` section whose revoke step asserts `401` on MCP + a non-zero `movp login`.
```bash
git add scripts/mcp-remote-probe.mjs scripts/slice-e2e.sh
git commit -m "test(agents): [agents] end-to-end slice (PAT -> exchange -> MCP/CLI -> revoke)"
```

---

## Task C3d.2: CI verification + C3-complete full gate

**Files**
- Verify (no edit): `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/README.md` (Stage C EXECUTION STATUS table)

**Context (grounded):** the `slice-e2e` job in `.github/workflows/ci.yml` (currently lines
157–180) runs `pkill -f 'supabase.*functions serve|edge-runtime' || true` then
`bash scripts/slice-e2e.sh` — i.e. the **whole** script, so the new `[agents]` block runs with
no yaml change. `ubuntu-latest` provides `npx`/`node` (for `mcp-remote` + the probe) and the
job already runs `pnpm install --frozen-lockfile` (so `tsx` and the CLI's workspace deps are
present) and `supabase start`. The only service the block adds — `auth-exchange` — is served by
the script's serve-list edit from C3d.1, not by CI config.

### TDD steps

- [ ] **Step 1 — verify the CI job needs no edit.** Confirm, by reading
  `.github/workflows/ci.yml`, that the `slice-e2e` job runs `bash scripts/slice-e2e.sh`
  unchanged and that nothing pins the served-functions list in yaml (it is only in the script).
Run: `grep -n 'slice-e2e.sh' .github/workflows/ci.yml`
Expected: one hit inside the `slice-e2e` job's run step — **no yaml edit required.** (If, and
only if, a reviewer wants the mcp-remote download pre-warmed to cut flakiness, add
`- run: npx -y mcp-remote@0.1.38 --help >/dev/null 2>&1 || true` before the slice step; this is
optional and not required for correctness.)

- [ ] **Step 2 — run the full C3-complete local gate** (the phase-close sequence; every command
  must pass, and the slice must print `slice-e2e: PASS` including `[agents]`):
```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node scripts/check-forward-only-migrations.mjs
node scripts/check-definer-audit.mjs
node scripts/check-event-catalog.mjs
bash scripts/check-boundary.sh
supabase db reset && supabase test db
supabase db diff                       # expect empty / "No schema changes found"
bash scripts/slice-e2e.sh              # expect: slice-e2e: PASS  (incl. an [agents] section)
```
Expected: all PASS. The migration/definer/event/boundary/typecheck/test gates are unchanged by
C3d (no product code), so they pass exactly as after C3c; the new signal is `slice-e2e: PASS`
with the `[agents]` section present.

- [ ] **Step 3 — update the Stage C status table** in `docs/superpowers/plans/README.md`
  (current line 60). Replace the C3 row:
```diff
-> | C3 Agent Connectivity (PATs/MCP/CLI) | breakdown only | ⬜ expand before build (unblocked by C1) |
+> | C3 Agent Connectivity (PATs/MCP/CLI) | `2026-07-09-movp-stage-c-03a…d-*.md` | ✅ EXECUTED (C3a PAT foundation; C3b CLI login/parity; C3c MCP matrix+stdio+docs; C3d `[agents]` slice — full CI green incl. `slice-e2e: PASS`) |
```
  (Fill the four plan filenames exactly as merged. This is the authoritative completion record
  per the repo's Phase Completion Signal — update it in the same PR/commit that closes C3.)

- [ ] **Step 4 — commit, open the PR, get CI green, request review ≥ 9.2.**
```bash
git add docs/superpowers/plans/README.md
git commit -m "docs(agents): mark Stage C3 executed after [agents] slice"
```
  Open the PR; confirm **every** CI job is green (`typecheck`, `boundary`, `definer-audit`,
  `event-catalog`, `forward-only-migrations`, `migration-drift`, `internal-access`,
  `graphql-shape`, `jobs`, `redaction`, `frontend-ux`, `quickstart`, and **`slice-e2e`**).
  Request the C3 phase review; the target is **≥ 9.2** across all eight dimensions (a
  ready/approved claim holds only when the mean clears 9.2 **and** no single dimension is below
  it). C3 is DONE only when C3a+C3b+C3c+C3d are all merged.

---

## Cross-cutting acceptance criteria (verify before requesting review)

- **Correctness:** the block proves the *whole* frozen chain — PAT mint (GraphQL) → exchange
  (`auth-exchange` + user_id match) → MCP HTTP (`tools/list` + real `note.list` tool-call) →
  MCP stdio (`mcp-remote` init/tools-list) → CLI (`task list` real data + `--mode hybrid` hit)
  → revoke → fail-closed. Every step greps a REAL substring (`E2E note`, `E2E task`,
  `note.list`, `access_token`, `MCP_STDIO_TOOLS_OK`), never a tautology.
- **Safety:** the raw PAT is never echoed; asserted absent from the metadata list AND the
  function log. Revocation is enforced at the exchange gate: MCP `401` + `invalid_token`,
  `auth-exchange` `401` + `invalid_token`, CLI non-zero exit. `invalid_token` is the only
  agent-facing code for a revoked PAT (internal `revoked` collapses to it).
- **Reliability:** the stdio probe is bounded by a timeout and kills the child on every exit
  path (no hung `mcp-remote`). Every assertion fails loud (`exit 1`); no `|| true` on any
  assertion. The revoke→CLI-fail check uses `movp login` (re-exchanges every time), so it does
  not depend on the ≤1h minted-session residual window.
- **Observability:** keys-only — the block validates that no raw token reaches logs, matching
  the existing `[workflows]` secret-in-log assertions.
- **Efficiency/Performance:** the block reuses the already-served functions, `$TOKEN`, `$WS`,
  and seeded rows — no extra `supabase start`, no re-seed, no function restart. `mcp-remote` is
  the single network-download addition (pinned; optionally pre-warmed in CI).
- **Simplicity:** no product code, no new CI job, one serve-list token added, one small driver
  script. The stdio bridge is the community `mcp-remote` (per C3c), not bespoke code.
- **Usability (operator):** every failure prints *why* + the offending payload, so a red CI run
  names the exact broken surface (exchange vs MCP vs stdio vs CLI vs revoke).

## Self-check (author, satisfied)
1. Red→green is real: the `[agents]` block fails at the exchange step until `auth-exchange` is
   added to the serve list (Step 3 RED → Step 4/5 GREEN). ✅
2. Every step is a command with expected output; the final gate is machine-checkable
   (`slice-e2e: PASS` + an `[agents]` section with the revoke→401/non-zero assertions). ✅
3. No dependency on facts outside this plan: tool names, seeded rows, token vars, workspace id,
   MCP statelessness, and service-role auto-injection are all stated inline. ✅
4. Platform gotchas are commented at their trigger sites: edge-runtime cleanup is opt-in
   locally; env-file `MOVP_JWT_ISSUER`; forced file store vs macOS Keychain; `mcp-remote`
   `--allow-http`/`--header` (else OAuth); revoked-PAT ≤1h residual window. ✅
5. Cross-part precondition stated as a precondition (C3a+C3b+C3c merged; C3d is LAST). ✅
6. CI wiring resolved: the `slice-e2e` job runs the whole script → the only edit is in the
   script (serve `auth-exchange`); `.github/workflows/ci.yml` needs no change. ✅
```
