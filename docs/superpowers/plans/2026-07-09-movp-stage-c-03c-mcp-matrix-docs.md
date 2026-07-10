# MOVP Stage C3c — MCP HTTP Client Matrix + stdio Bridge + Agent Docs

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code/config samples **verbatim** — they are grounded in the
> committed code (`supabase/functions/mcp/index.ts`, `packages/mcp/src/server.ts`,
> `scripts/slice-e2e.sh`, `scripts/check-event-catalog.mjs`, line-verified 2026-07-09) and in the
> C3 **frozen contracts**. This plan is bite-sized TDD, expanded from the C3 design spec
> (`docs/superpowers/specs/2026-07-09-movp-stage-c-03-agent-connectivity-design.md`, §10–§12) and
> is the third of four parts (`c3a`, `c3b`, **`c3c`**, `c3d`).
>
> **CROSS-PART DEPENDENCY (read first):** C3c needs a **working PAT** and **MCP-over-HTTP-with-a-PAT**,
> both delivered by **C3a**. **Precondition: C3a MERGED** (PAT table + lifecycle RPCs
> `create_workspace`/`create_personal_access_token`, `resolvePrincipal` PAT branch that accepts a
> `movp_pat_…` bearer on `/functions/v1/mcp`, and the stable error codes). C3b is **optional** for
> C3c (it only adds `movp login` convenience — C3c seeds its own PAT directly via the RPCs, so it
> does not depend on the CLI). C3d consumes C3c's smokes.

**Goal:** a named agent client (**Claude Code, Codex, Cursor, Gemini CLI, Copilot**) can connect to
a MOVP instance over the existing **streamable-HTTP MCP endpoint** (`${apiUrl}/functions/v1/mcp`)
using a **Personal Access Token** (`Authorization: Bearer movp_pat_…`), and a stdio-only client can
reach the same endpoint through the community **`mcp-remote`** bridge — with copy-paste-correct
per-client config samples, a config-lint that fails when the samples drift from the real endpoint or
tool registry, an HTTP + stdio connectivity smoke, and agent docs (`llms.txt`, a consumer
`AGENTS.md` template, and a stable error-code / conventions doc) that a downstream operator drops
into their repo.

**Architecture:** C3c adds **no runtime code to the MCP server** — the endpoint, transport, SDK
version, and tool registry already exist and are reused unchanged. It adds (1) five per-client
config samples + prose under `docs/agents/mcp/`; (2) one Node config-lint
(`scripts/check-agent-configs.mjs`) that parses each sample, asserts the endpoint path + bearer
shape, and cross-checks every documented tool-call against the **live** registered tool names in
`packages/mcp/src/server.ts` (drift guard); (3) two connectivity smokes
(`scripts/mcp-http-smoke.mjs`, `scripts/mcp-stdio-smoke.mjs`) sharing a helper lib
(`scripts/lib/mcp-frames.mjs`); (4) a **conditional** `@movp/mcp-bridge` package built **only if**
the `mcp-remote` stdio smoke fails; (5) agent docs (`llms.txt`, `docs/agents/AGENTS.template.md`,
`docs/agents/error-codes.md`) with the docs-lint folded into the same config-lint. No migration, no
codegen change, no new runtime dependency (the stdio bridge uses `npx -y mcp-remote`, invoked at
runtime, not added to any `package.json`).

**Tech stack:** Node ≥ 20 ESM lint/smoke scripts (dependency-free, mirror
`scripts/check-event-catalog.mjs`); the committed Deno edge `mcp` function
(`@modelcontextprotocol/sdk@1.26.0`, `WebStandardStreamableHTTPServerTransport`, **stateless**:
`sessionIdGenerator: undefined`); Supabase local stack (ports per this repo's `CLAUDE.md` —
API `64321`); PostgREST RPCs from C3a for PAT seeding; community `mcp-remote` (runtime `npx`).

---

## Global Constraints (every task inherits these)

- **TDD, failing check first.** Each lint/smoke task writes the check, runs it and observes the
  **exact expected failure**, then implements the sample/script and re-runs to **PASS**. For the
  pure-docs task the "test" is the docs-lint asserting the documented facts (endpoint path, stable
  error codes, real tool names) — never "write docs" without a machine check.
- **Consumes from C3a (interfaces, do NOT re-implement):**
  - **MCP endpoint** — `${apiUrl}/functions/v1/mcp`, streamable HTTP, `verify_jwt = false`
    (the function authenticates itself via `resolvePrincipal`). Verified: `supabase/config.toml`
    `[functions.mcp] verify_jwt = false`.
  - **PAT bearer** — `Authorization: Bearer movp_pat_<64hex>`. `resolvePrincipal` detects the
    `movp_pat_` prefix and exchanges it for a real session (C3a). Prefix constant `PAT_PREFIX = 'movp_pat_'`.
  - **Stable, agent-facing error codes** — `missing_token` | `invalid_token` | `expired_token` |
    `invalid_claims`. A bad/not-found/revoked PAT → **`invalid_token`**; an expired PAT →
    **`expired_token`**. MCP/HTTP returns **401** with `{"error":"<code>"}` (verified shape in
    `supabase/functions/mcp/index.ts`). **Do not invent new agent-visible codes.**
  - **PAT seeding RPCs** (C3a) — `create_workspace(name)` → workspace row; and
    `create_personal_access_token(default_ws, name, ttl_days)` → `{ token_id, token }` **once**,
    reachable via PostgREST `/rest/v1/rpc/<name>` with an authenticated session.
- **Endpoint gotcha (inline everywhere it is typed):** the path is exactly **`/functions/v1/mcp`**
  (streamable HTTP, SDK 1.26.0). Not `/mcp`, not `/functions/v1/mpc`. The lint pins `new URL(url).pathname === '/functions/v1/mcp'`.
- **Tool-registry gotcha:** the config-lint cross-checks every documented `tools/call` example
  against the **literal** `server.registerTool('<name>', …)` registrations in
  `packages/mcp/src/server.ts`. Docs must reference **statically-registered** tools (e.g.
  `task.list`, `task.create`, `workflow.event_types`) — NOT the dynamic per-collection
  `` `${c.name}.*` `` tools (which the lint cannot see and which vary by schema). If a registration
  is renamed in `server.ts`, the lint FAILS on the stale doc — that is the drift guard working.
- **`apikey` gotcha:** the endpoint is `verify_jwt = false`, so a **hosted** invocation needs only
  `Authorization: Bearer <PAT>`. The **local** Kong gateway and both smokes additionally send
  `apikey: <ANON_KEY>` (exactly as the existing slice does — `scripts/slice-e2e.sh` MCP block). The
  per-client config samples target **hosted** and are `Authorization`-only; each sample's prose
  notes the `apikey` header for self-hosted/local gateways that require it. **(Forced assumption —
  see the head note in the returned summary.)**
- **Streamable-HTTP framing gotcha:** the transport is **stateless** (`sessionIdGenerator: undefined`)
  — each POST is independent; `initialize` is informational and `tools/list`/`tools/call` succeed as
  standalone POSTs (the existing slice already calls `tools/list` with no prior initialize).
  Responses arrive **either** as a raw JSON body **or** as an SSE stream (`event: message\ndata: {…}`);
  the shared `parseRpc()` helper normalises both (and the newline-delimited JSON that `mcp-remote`
  emits over stdio).
- **YAGNI / stdio-first:** prefer the community **`mcp-remote`** bridge; build the custom
  `@movp/mcp-bridge` **only if** the `mcp-remote` stdio smoke fails. Task **C3c.3-FALLBACK** is
  explicitly gated "execute only if the previous smoke fails."
- **Docs invariants:** the repo-root `AGENTS.md` is a **symlink to `CLAUDE.md`** and is pinned by
  `scripts/check-docs-presence.mjs`. **Do NOT create or overwrite root `AGENTS.md`.** The consumer
  template is a separate file `docs/agents/AGENTS.template.md`. `llms.txt` lives at the repo root
  (the well-known `/llms.txt` location); no existing lint forbids it.
- **No new runtime dependency** (global rule). Lints/smokes use only Node built-ins + global `fetch`.
  The Codex sample is TOML; Node has no built-in TOML parser, so the lint regex-extracts the two
  fixed keys (mirrors the repo's regex-lint style). `mcp-remote` is invoked via `npx -y` at runtime,
  not declared as a dependency.
- **Per-task gate + one commit per task.** A task is done only when its gate passes. C3c (a *part*,
  not the C3 *phase*) is complete when C3c.1–C3c.4 land; the C3 phase is done only when C3a–C3d all
  land (`CLAUDE.md` Phase Completion Signal).

## File Structure

```text
docs/agents/
  mcp/
    claude-code.json        # C3c.1  HTTP config sample (mcpServers, type:"http")
    claude-code.md          # C3c.1  prose + example tools/call frame
    codex.toml              # C3c.1  ~/.codex/config.toml (rmcp, bearer_token_env_var)
    codex.md                # C3c.1
    cursor.json             # C3c.1  .cursor/mcp.json (mcpServers, url)
    cursor.md               # C3c.1
    gemini-cli.json         # C3c.1  ~/.gemini/settings.json (mcpServers, httpUrl)
    gemini-cli.md           # C3c.1
    copilot.json            # C3c.1  .vscode/mcp.json (servers, type:"http", inputs)
    copilot.md              # C3c.1
    stdio-mcp-remote.md     # C3c.3  stdio via community mcp-remote (+ stdio config sample)
  error-codes.md            # C3c.4  stable agent-facing codes + tool-naming + workspace-id convention
  AGENTS.template.md        # C3c.4  consumer AGENTS.md template (NOT the repo-root symlink)
llms.txt                    # C3c.4  repo-root llms.txt (well-known agent index)
scripts/
  check-agent-configs.mjs   # C3c.1 config-lint + tool-drift; extended by C3c.4 (docs-lint)
  lib/mcp-frames.mjs        # C3c.2  shared smoke helpers (parseRpc / seedPat / assert / env)
  mcp-http-smoke.mjs        # C3c.2  streamable-HTTP smoke (initialize/tools-list/tools-call)
  mcp-stdio-smoke.mjs       # C3c.3  mcp-remote stdio smoke
packages/mcp-bridge/        # C3c.3-FALLBACK — CONDITIONAL: only if the stdio smoke fails
  package.json
  src/index.ts
  test/bridge.test.ts
package.json                # add script "check:agent-configs"
```

---

## Task C3c.1: Per-client MCP config samples + config-lint (drift guard)

**Files**
- Create: `scripts/check-agent-configs.mjs`
- Create: `docs/agents/mcp/claude-code.json`, `docs/agents/mcp/claude-code.md`,
  `docs/agents/mcp/codex.toml`, `docs/agents/mcp/codex.md`,
  `docs/agents/mcp/cursor.json`, `docs/agents/mcp/cursor.md`,
  `docs/agents/mcp/gemini-cli.json`, `docs/agents/mcp/gemini-cli.md`,
  `docs/agents/mcp/copilot.json`, `docs/agents/mcp/copilot.md`
- Modify: `package.json` (add `"check:agent-configs": "node scripts/check-agent-configs.mjs"`)

**Interfaces (consumed from C3a):** the MCP endpoint path `/functions/v1/mcp`; the PAT bearer shape
`Bearer movp_pat_…`; the registered tool names in `packages/mcp/src/server.ts` (read-only
cross-check — this task adds no server code).

**Per-client config schema (researched + fixed — transcribe exactly):**

| Client | Config file | Top-level key | URL key | Auth mechanism |
|---|---|---|---|---|
| Claude Code | `.mcp.json` (or `claude mcp add --transport http`) | `mcpServers` | `url` (+ `"type":"http"`) | `headers.Authorization: "Bearer movp_pat_…"` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.movp]` | `url` | **`bearer_token_env_var = "MOVP_PAT"`** + top-level `experimental_use_rmcp_client = true` |
| Cursor | `.cursor/mcp.json` (or `~/.cursor/mcp.json`) | `mcpServers` | `url` (no `type`) | `headers.Authorization: "Bearer movp_pat_…"` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | **`httpUrl`** | `headers.Authorization: "Bearer movp_pat_…"` |
| Copilot (VS Code) | `.vscode/mcp.json` | **`servers`** | `url` (+ `"type":"http"`) | `headers.Authorization` + top-level `inputs` prompt |

> ⚠ **Codex is the odd one out** (forced assumption, researched): Codex's rmcp streamable-HTTP
> client authenticates via **`bearer_token_env_var`** — the *name* of an environment variable whose
> value it sends as the Bearer token — **not** a literal `Authorization` header, and it requires
> `experimental_use_rmcp_client = true`. So the Codex sample references the env var `MOVP_PAT`
> (holding `movp_pat_…`), and the lint validates Codex by a **different** rule than the JSON clients.

- [ ] **Step 1 — write the config-lint** `scripts/check-agent-configs.mjs` (dependency-free; mirrors
  `check-event-catalog.mjs` structure — shebang, `node:fs`/`node:path`, `fileURLToPath`, `process.exit`):

```js
#!/usr/bin/env node
// Config-lint for the per-client MCP samples under docs/agents/mcp/.
// Asserts: (1) each sample points at the real streamable-HTTP endpoint path,
// (2) the bearer/auth shape is correct per client, (3) every documented
// tools/call example names a CURRENTLY-registered MCP tool (drift guard vs.
// packages/mcp/src/server.ts). Section 4 (error-codes + llms.txt presence) is
// appended in Task C3c.4.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENDPOINT_PATH = '/functions/v1/mcp'
const serverPath = join(root, 'packages', 'mcp', 'src', 'server.ts')
const mcpDir = join(root, 'docs', 'agents', 'mcp')

const errors = []
const fail = (msg) => errors.push(msg)

// --- 1. Registered MCP tool names (literal registrations only; the dynamic
//        `${c.name}.*` collection tools are intentionally excluded so docs must
//        reference a statically-guaranteed tool). ---
function registeredTools() {
  const src = readFileSync(serverPath, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/registerTool\(\s*'([a-z][\w.]*)'/g)) names.add(m[1])
  return names
}

// --- 2. Per-client config sample descriptors ---
const samples = [
  { file: 'claude-code.json', kind: 'json', url: (c) => c.mcpServers?.movp?.url,     auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'cursor.json',      kind: 'json', url: (c) => c.mcpServers?.movp?.url,     auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'gemini-cli.json',  kind: 'json', url: (c) => c.mcpServers?.movp?.httpUrl, auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'copilot.json',     kind: 'json', url: (c) => c.servers?.movp?.url,        auth: (c) => c.servers?.movp?.headers?.Authorization },
  { file: 'codex.toml',       kind: 'codex' },
]

// literal PAT prefix, or an env-expansion placeholder (${VAR} / ${input:x} / ${env:x} / $VAR)
const BEARER_RE = /^Bearer\s+(movp_pat_|\$\{|\$[A-Za-z])/

function checkUrl(file, url) {
  if (typeof url !== 'string' || url.length === 0) return fail(`${file}: missing MCP endpoint url`)
  let path
  try { path = new URL(url).pathname } catch { return fail(`${file}: url is not a valid absolute URL: ${url}`) }
  if (path !== MCP_ENDPOINT_PATH) fail(`${file}: endpoint path must be ${MCP_ENDPOINT_PATH}, got ${path}`)
}

for (const s of samples) {
  const p = join(mcpDir, s.file)
  if (!existsSync(p)) { fail(`missing config sample: docs/agents/mcp/${s.file}`); continue }
  const raw = readFileSync(p, 'utf8')
  if (s.kind === 'json') {
    let cfg
    try { cfg = JSON.parse(raw) } catch (e) { fail(`${s.file}: invalid JSON: ${e.message}`); continue }
    checkUrl(s.file, s.url(cfg))
    const auth = s.auth(cfg)
    if (typeof auth !== 'string' || !BEARER_RE.test(auth)) {
      fail(`${s.file}: headers.Authorization must be "Bearer movp_pat_…" or an env placeholder, got ${JSON.stringify(auth)}`)
    }
  } else {
    // Codex TOML: no built-in parser + no new dependency -> regex-extract the two fixed keys.
    checkUrl(s.file, raw.match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1])
    if (!/^\s*bearer_token_env_var\s*=\s*"[^"]+"/m.test(raw)) {
      fail(`${s.file}: Codex HTTP MCP auth requires bearer_token_env_var = "<ENV VAR NAME>" (rmcp sends its value as the Bearer token)`)
    }
    if (!/^\s*experimental_use_rmcp_client\s*=\s*true/m.test(raw)) {
      fail(`${s.file}: Codex streamable-HTTP MCP requires experimental_use_rmcp_client = true`)
    }
  }
}

// --- 3. Every documented tools/call example must name a registered tool ---
const tools = registeredTools()
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(fp))
    else if (['.md', '.txt'].includes(extname(e.name))) out.push(fp)
  }
  return out
}
const docFiles = walk(join(root, 'docs', 'agents'))
const rootLlms = join(root, 'llms.txt')
if (existsSync(rootLlms)) docFiles.push(rootLlms)
const FENCE = /```json\s*([\s\S]*?)```/g
for (const file of docFiles) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(FENCE)) {
    let frame
    try { frame = JSON.parse(m[1]) } catch { continue } // non-JSON-RPC blocks (e.g. configs) are skipped
    if (frame?.method !== 'tools/call') continue
    const name = frame?.params?.name
    if (typeof name !== 'string') { fail(`${file}: a tools/call example is missing params.name`); continue }
    if (!tools.has(name)) fail(`${file}: tools/call references unregistered tool "${name}" (drifted from packages/mcp/src/server.ts)`)
  }
}

// --- 4. (appended in Task C3c.4) error-codes.md + llms.txt + AGENTS.template presence ---
// C3C4_ANCHOR

if (errors.length) {
  console.error('agent-config lint: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('agent-config lint: ok')
```

- [ ] **Step 2 — add the npm script** to `package.json` (`scripts` block, alongside the other
  `check:*` entries):

```json
    "check:agent-configs": "node scripts/check-agent-configs.mjs",
```

- [ ] **Step 3 — write the samples with TWO deliberate breaks (fail-first fixture).** Create all
  ten files below **but** (a) in `codex.toml` write the endpoint as `…/functions/v1/mpc` (typo),
  and (b) in `claude-code.md`'s example frame use the tool name `task.frobnicate` (unregistered).
  These two breaks are the fail-first fixture; you correct them in Step 5.

  `docs/agents/mcp/claude-code.json`:
```json
{
  "mcpServers": {
    "movp": {
      "type": "http",
      "url": "https://your-project-ref.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

  `docs/agents/mcp/claude-code.md`:
```md
# Claude Code — MOVP MCP (streamable HTTP)

MOVP exposes a streamable-HTTP MCP endpoint at `${apiUrl}/functions/v1/mcp`. Authenticate with a
Personal Access Token (`movp_pat_…`, minted at `/settings/tokens`). A PAT is **user-scoped** — it
grants exactly the creating user's access; treat it as an account credential and revoke on leak.

## Option A — CLI
```sh
claude mcp add --transport http movp \
  https://your-project-ref.supabase.co/functions/v1/mcp \
  --header "Authorization: Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN"
```

## Option B — `.mcp.json` (project scope)
Copy `claude-code.json` in this directory. `${VAR}` / `${VAR:-default}` expansion is supported in
`url` and `headers`, so prefer `"Authorization": "Bearer ${MOVP_PAT}"` and export `MOVP_PAT` rather
than committing the token.

## Example call
Agents pass `workspaceId` on every call (see `../error-codes.md`):
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.frobnicate", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

## Self-hosted / local gateways
A hosted MOVP `mcp` function is `verify_jwt = false`, so only `Authorization` is required. If you
front the endpoint with a gateway that requires the Supabase `apikey` header (e.g. a local Supabase
stack), add `"apikey": "<ANON_KEY>"` to `headers`.
```

  `docs/agents/mcp/codex.toml`:
```toml
# ~/.codex/config.toml — MOVP MCP over streamable HTTP (rmcp client).
# Codex's HTTP MCP client sends the value of `bearer_token_env_var` as the Bearer
# token, so export MOVP_PAT=movp_pat_... before launching codex.
experimental_use_rmcp_client = true

[mcp_servers.movp]
url = "https://your-project-ref.supabase.co/functions/v1/mpc"
bearer_token_env_var = "MOVP_PAT"
```

  `docs/agents/mcp/codex.md`:
```md
# Codex — MOVP MCP (streamable HTTP via rmcp)

Codex reads MCP config from `~/.codex/config.toml`. Streamable-HTTP servers require the rmcp client
(`experimental_use_rmcp_client = true`) and authenticate via `bearer_token_env_var` — the **name**
of an env var whose value Codex sends as the Bearer token (Codex does not take a literal
`Authorization` header for HTTP servers).

```sh
export MOVP_PAT=movp_pat_REPLACE_WITH_YOUR_TOKEN
codex   # picks up ~/.codex/config.toml
```

Copy `codex.toml` in this directory into `~/.codex/config.toml` (or a trusted-project
`.codex/config.toml`). Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
```

  `docs/agents/mcp/cursor.json`:
```json
{
  "mcpServers": {
    "movp": {
      "url": "https://your-project-ref.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

  `docs/agents/mcp/cursor.md`:
```md
# Cursor — MOVP MCP (streamable HTTP)

Cursor reads MCP config from `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). A remote
server is configured by `url` (Cursor infers streamable HTTP) plus a static `headers.Authorization`.
Cursor interpolates `${env:NAME}` in `url` and `headers`, so prefer
`"Authorization": "Bearer ${env:MOVP_PAT}"` and keep the token in your shell env.

Copy `cursor.json` in this directory. Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.create", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000", "title": "from Cursor" } } }
```

## Self-hosted / local gateways
Add `"apikey": "<ANON_KEY>"` to `headers` if your gateway requires it (hosted needs only Authorization).
```

  `docs/agents/mcp/gemini-cli.json`:
```json
{
  "mcpServers": {
    "movp": {
      "httpUrl": "https://your-project-ref.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

  `docs/agents/mcp/gemini-cli.md`:
```md
# Gemini CLI — MOVP MCP (streamable HTTP)

Gemini CLI reads MCP config from `~/.gemini/settings.json`. The **streamable-HTTP** transport uses
the `httpUrl` key (not `url`, which is SSE) plus `headers`.

## Option A — CLI
```sh
gemini mcp add --transport http \
  --header "Authorization: Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN" \
  movp https://your-project-ref.supabase.co/functions/v1/mcp
```

## Option B — settings.json
Merge `gemini-cli.json` in this directory into `~/.gemini/settings.json`. `${VAR}` expansion is
supported, so prefer `"Authorization": "Bearer ${MOVP_PAT}"`. Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
```

  `docs/agents/mcp/copilot.json`:
```json
{
  "servers": {
    "movp": {
      "type": "http",
      "url": "https://your-project-ref.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${input:movpPat}"
      }
    }
  },
  "inputs": [
    {
      "id": "movpPat",
      "type": "promptString",
      "description": "MOVP Personal Access Token (movp_pat_…)",
      "password": true
    }
  ]
}
```

  `docs/agents/mcp/copilot.md`:
```md
# GitHub Copilot (VS Code) — MOVP MCP (streamable HTTP)

VS Code reads MCP config from `.vscode/mcp.json`. The top-level key is **`servers`** (not
`mcpServers`), each server has `"type": "http"`, and secrets are prompted once via a top-level
`inputs` array (`${input:id}`) and stored securely by VS Code.

Copy `copilot.json` in this directory into `.vscode/mcp.json`. On first start VS Code prompts for the
PAT and injects it into `Authorization`. Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "workflow.event_types", "arguments": {} } }
```

## Self-hosted / local gateways
Add `"apikey": "<ANON_KEY>"` to `headers` if your gateway requires it.
```

- [ ] **Step 4 — run the lint, expect FAIL** (the two deliberate breaks):
  Run: `node scripts/check-agent-configs.mjs`
  Expected: **FAIL**, listing exactly:
  ```
  agent-config lint: FAIL
    - codex.toml: endpoint path must be /functions/v1/mcp, got /functions/v1/mpc
    - .../docs/agents/mcp/claude-code.md: tools/call references unregistered tool "task.frobnicate" (drifted from packages/mcp/src/server.ts)
  ```

- [ ] **Step 5 — fix the two deliberate breaks:** in `codex.toml` change `…/functions/v1/mpc` →
  `…/functions/v1/mcp`; in `claude-code.md`'s example frame change `task.frobnicate` → `task.list`.

- [ ] **Step 6 — run the lint, expect PASS:**
  Run: `node scripts/check-agent-configs.mjs`
  Expected: `agent-config lint: ok`

- [ ] **Step 7 — gate + commit.** Gate = the lint passes AND typecheck is unaffected (docs/scripts only):
  Run: `node scripts/check-agent-configs.mjs`
  Expected: `agent-config lint: ok`
```bash
git add scripts/check-agent-configs.mjs package.json docs/agents/mcp
git commit -m "feat(agents): per-client MCP config matrix + drift-guard config-lint"
```

---

## Task C3c.2: MCP HTTP smoke (initialize → tools/list → tool-call over streamable HTTP)

**Files**
- Create: `scripts/lib/mcp-frames.mjs`
- Create: `scripts/mcp-http-smoke.mjs`

**Interfaces (consumed from C3a):** the `/functions/v1/mcp` endpoint that accepts a `movp_pat_…`
bearer; the `create_workspace` + `create_personal_access_token` RPCs (PostgREST) used to seed a real
PAT; the `invalid_token` 401 reject for a bad PAT.

**Precondition to run:** a local stack (`supabase start`) **and** the `mcp` edge function served.
Serve it exactly as the slice does (`CLAUDE.md` env-file rule — shell-prefixed vars can fail to
propagate into the edge runtime):
```sh
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
FN_ENV_FILE="$(mktemp)"; printf 'MOVP_JWT_ISSUER=%s\n' "$API_URL/auth/v1" > "$FN_ENV_FILE"
supabase functions serve mcp --env-file "$FN_ENV_FILE" >/tmp/movp-mcp.log 2>&1 &
```

- [ ] **Step 1 — write the smoke** `scripts/mcp-http-smoke.mjs` **importing the not-yet-created lib**
  (this import is the fail-first trigger):

```js
#!/usr/bin/env node
// MCP streamable-HTTP smoke: seed a PAT -> initialize -> tools/list -> tools/call
// (one safe read tool). Prints the exact JSON-RPC frames. Also proves a bad PAT
// is rejected 401 invalid_token.
// GOTCHA: endpoint is /functions/v1/mcp (streamable HTTP, SDK 1.26.0, STATELESS:
// each POST is independent, no Mcp-Session-Id). Responses may be raw JSON or SSE
// (event: message / data: {…}) -> parseRpc() normalises both.
import { assert, env, parseRpc, seedPat } from './lib/mcp-frames.mjs'

const API_URL = env('API_URL', 'http://127.0.0.1:64321')
const ANON_KEY = env('ANON_KEY')
const SERVICE_ROLE_KEY = env('SERVICE_ROLE_KEY')
const MCP_URL = `${API_URL}/functions/v1/mcp`

async function mcp(frame, bearer) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      apikey: ANON_KEY, // local Kong requires it; hosted (verify_jwt=false) ignores it
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(frame),
  })
  return { status: res.status, body: await res.text() }
}

async function main() {
  const { token, workspaceId } = await seedPat({ apiUrl: API_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY })

  // negative: a syntactically-valid but unregistered PAT -> 401 invalid_token
  const bogus = await mcp({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, `movp_pat_${'0'.repeat(64)}`)
  assert(bogus.status === 401, `bogus PAT should be 401, got ${bogus.status}`)
  assert(/"invalid_token"/.test(bogus.body), `bogus PAT should map to invalid_token, got ${bogus.body.slice(0, 120)}`)
  console.log('  [negative] bogus PAT -> 401 invalid_token: ok')

  // 1. initialize
  const initReq = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'movp-http-smoke', version: '0.1.0' } } }
  console.log('>>', JSON.stringify(initReq))
  const initRes = await mcp(initReq, token)
  assert(initRes.status === 200, `initialize status ${initRes.status}: ${initRes.body.slice(0, 160)}`)
  const init = parseRpc(initRes.body)
  console.log('<<', JSON.stringify(init))
  assert(init.result?.serverInfo?.name === 'movp', 'initialize did not return serverInfo.name=movp')

  // 2. tools/list
  const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  console.log('>>', JSON.stringify(listReq))
  const list = parseRpc((await mcp(listReq, token)).body)
  console.log('<< tools/list ->', (list.result?.tools ?? []).length, 'tools')
  assert((list.result?.tools ?? []).some((t) => t.name === 'task.list'), 'tools/list missing the task.list read tool')

  // 3. tools/call task.list (safe read; an empty task list is a valid pass)
  const callReq = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.list', arguments: { workspaceId } } }
  console.log('>>', JSON.stringify(callReq))
  const call = parseRpc((await mcp(callReq, token)).body)
  console.log('<<', JSON.stringify(call))
  assert(!call.error, `tools/call returned an error: ${JSON.stringify(call.error)}`)
  assert(Array.isArray(call.result?.content), 'tools/call task.list returned no content array')

  console.log('mcp-http-smoke: ok')
}

main().catch((e) => { console.error('mcp-http-smoke: FAIL', e.message); process.exit(1) })
```

- [ ] **Step 2 — run it, expect FAIL** (the shared lib does not exist yet):
  Run: `node scripts/mcp-http-smoke.mjs`
  Expected: **FAIL** — `Cannot find module '.../scripts/lib/mcp-frames.mjs'`.

- [ ] **Step 3 — write the shared lib** `scripts/lib/mcp-frames.mjs` (also consumed by the stdio
  smoke in C3c.3, so it lives in `lib/`):

```js
// Shared helpers for the MCP HTTP + stdio smokes. Dependency-free (global fetch).
export function assert(cond, msg) { if (!cond) throw new Error(msg) }

export function env(name, fallback) {
  const v = process.env[name] ?? fallback
  if (!v) {
    console.error(`missing env ${name} (run: eval "$(supabase status -o env | sed 's/^\\([A-Z_]*\\)=/export \\1=/')")`)
    process.exit(1)
  }
  return v
}

// Streamable HTTP returns a raw JSON body OR an SSE stream (event: message /
// data: {…}); mcp-remote emits newline-delimited JSON over stdio. Normalise all.
export function parseRpc(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    return JSON.parse(lines[lines.length - 1])
  }
  const dataLines = trimmed.split('\n').filter((l) => l.startsWith('data:'))
  if (dataLines.length === 0) throw new Error(`no JSON-RPC payload in response (prefix: ${trimmed.slice(0, 60)})`)
  return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim())
}

async function restJson(apiUrl, path, anonKey, { token, body, method = 'POST' }) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', apikey: anonKey, Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 160)}`)
  return text.length ? JSON.parse(text) : null
}

// Seed a real user -> session -> workspace -> PAT against the local stack, using
// the C3a lifecycle RPCs over PostgREST. Returns { token: 'movp_pat_…', workspaceId }.
export async function seedPat({ apiUrl, anonKey, serviceRoleKey }) {
  const email = `mcp-smoke-${Date.now()}@example.test`
  const password = 'MovpSmoke123!'
  await restJson(apiUrl, '/auth/v1/admin/users', anonKey, { token: serviceRoleKey, body: { email, password, email_confirm: true } })
  const session = await restJson(apiUrl, '/auth/v1/token?grant_type=password', anonKey, { token: anonKey, body: { email, password } })
  assert(session?.access_token, 'password grant returned no access_token')
  const ws = await restJson(apiUrl, '/rest/v1/rpc/create_workspace', anonKey, { token: session.access_token, body: { name: 'MCP Smoke WS' } })
  assert(ws?.id, 'create_workspace returned no id')
  const pat = await restJson(apiUrl, '/rest/v1/rpc/create_personal_access_token', anonKey, { token: session.access_token, body: { default_ws: ws.id, name: 'mcp-smoke', ttl_days: 1 } })
  assert(typeof pat?.token === 'string' && pat.token.startsWith('movp_pat_'), 'create_personal_access_token did not return a movp_pat_ token')
  return { token: pat.token, workspaceId: ws.id }
}
```

- [ ] **Step 4 — run it, expect PASS** (stack up + `mcp` served per the Precondition block):
  Run: `node scripts/mcp-http-smoke.mjs`
  Expected: the three request/response frames printed, then:
  ```
    [negative] bogus PAT -> 401 invalid_token: ok
  >> {"jsonrpc":"2.0","id":1,"method":"initialize",...}
  << {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":...,"serverInfo":{"name":"movp",...}}}
  >> {"jsonrpc":"2.0","id":2,"method":"tools/list"}
  << tools/list -> <N> tools
  >> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"task.list",...}}
  << {"jsonrpc":"2.0","id":3,"result":{"content":[...]}}
  mcp-http-smoke: ok
  ```

- [ ] **Step 5 — gate + commit.** Gate = the config-lint still passes AND the HTTP smoke passes:
  Run: `node scripts/check-agent-configs.mjs && node scripts/mcp-http-smoke.mjs`
  Expected: `agent-config lint: ok` then `mcp-http-smoke: ok`.
```bash
git add scripts/lib/mcp-frames.mjs scripts/mcp-http-smoke.mjs
git commit -m "test(agents): MCP streamable-HTTP smoke over a seeded PAT"
```

---

## Task C3c.3: stdio via community `mcp-remote` (+ conditional `@movp/mcp-bridge`)

**Files**
- Create: `docs/agents/mcp/stdio-mcp-remote.md`
- Create: `scripts/mcp-stdio-smoke.mjs`
- *(CONDITIONAL — C3c.3-FALLBACK only)* Create: `packages/mcp-bridge/package.json`,
  `packages/mcp-bridge/src/index.ts`, `packages/mcp-bridge/test/bridge.test.ts`

**Interfaces (consumed):** the same `/functions/v1/mcp` endpoint + PAT bearer; `seedPat` and
`parseRpc` from `scripts/lib/mcp-frames.mjs` (C3c.2). **Decision rule (spec §11):** if the
`mcp-remote` stdio smoke passes, **document it and ship no code** (skip C3c.3-FALLBACK). Build
`@movp/mcp-bridge` **only if** the smoke fails.

- [ ] **Step 1 — write the stdio doc** `docs/agents/mcp/stdio-mcp-remote.md` (with a stdio config
  sample for stdio-only clients; the `${apiUrl}/functions/v1/mcp` path lives inside `args`):

```md
# stdio bridge — MOVP MCP via `mcp-remote`

MOVP's MCP endpoint is streamable HTTP. A stdio-only MCP client reaches it through the community
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge — no MOVP-specific code required.

## One-liner
```sh
npx -y mcp-remote@0.1.38 https://your-project-ref.supabase.co/functions/v1/mcp \
  --header "Authorization: Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN"
```
`mcp-remote` is pinned to `@0.1.38` — the single documented version across C3c and C3d's CI
probe (bump both together when validating a newer release). `npx -y` fetches it on first run (network required). For a local/self-hosted gateway that
requires the Supabase `apikey`, add `--header "apikey: <ANON_KEY>"`.

## Config for a stdio-only client
```json
{
  "mcpServers": {
    "movp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.1.38",
        "https://your-project-ref.supabase.co/functions/v1/mcp",
        "--header", "Authorization: Bearer ${MOVP_PAT}"
      ]
    }
  }
}
```

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
```

- [ ] **Step 2 — write the stdio smoke** `scripts/mcp-stdio-smoke.mjs`:

```js
#!/usr/bin/env node
// MCP stdio smoke via the community `mcp-remote` bridge (no custom code).
// Spawns `npx -y mcp-remote <endpoint> --header "Authorization: Bearer <PAT>"`
// and drives initialize / tools/list / tools/call over stdio (newline-delimited
// JSON-RPC). GOTCHA: `npx -y` fetches mcp-remote on first run (network required).
import { spawn } from 'node:child_process'
import { assert, env, seedPat } from './lib/mcp-frames.mjs'

const API_URL = env('API_URL', 'http://127.0.0.1:64321')
const ANON_KEY = env('ANON_KEY')
const SERVICE_ROLE_KEY = env('SERVICE_ROLE_KEY')
const MCP_URL = `${API_URL}/functions/v1/mcp`

function waitFor(map, id, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (map.has(id)) { clearInterval(iv); resolve(map.get(id)) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timed out waiting for JSON-RPC id=${id} from mcp-remote`)) }
    }, 200)
  })
}

async function main() {
  const { token, workspaceId } = await seedPat({ apiUrl: API_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY })

  const child = spawn('npx', ['-y', 'mcp-remote@0.1.38', MCP_URL,
    '--header', `Authorization: Bearer ${token}`,
    '--header', `apikey: ${ANON_KEY}`,
  ], { stdio: ['pipe', 'pipe', 'inherit'] })
  child.on('error', (e) => { console.error('mcp-stdio-smoke: FAIL spawning npx/mcp-remote:', e.message); process.exit(1) })

  const seen = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try { const msg = JSON.parse(line); if (msg.id != null) seen.set(msg.id, msg) } catch {}
    }
  })

  const send = (f) => child.stdin.write(JSON.stringify(f) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'movp-stdio-smoke', version: '0.1.0' } } })
  await waitFor(seen, 1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const list = await waitFor(seen, 2)
  assert(list?.result?.tools?.some((t) => t.name === 'task.list'), 'stdio tools/list missing task.list')
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.list', arguments: { workspaceId } } })
  const call = await waitFor(seen, 3)
  assert(!call?.error && Array.isArray(call?.result?.content), `stdio tools/call failed: ${JSON.stringify(call?.error ?? call?.result)}`)

  child.stdin.end(); child.kill()
  console.log('mcp-stdio-smoke: ok (mcp-remote bridge)')
}

main().catch((e) => { console.error('mcp-stdio-smoke: FAIL', e.message); process.exit(1) })
```

- [ ] **Step 3 — run the config-lint first (expect FAIL until the stdio doc is well-formed),
  then run the stdio smoke.** The lint now also scans `stdio-mcp-remote.md`:
  Run: `node scripts/check-agent-configs.mjs`
  Expected: `agent-config lint: ok` (the stdio doc's `task.list` frame is registered; the stdio
  config `json` block has no `method` and is skipped).

  Then, with the stack up + `mcp` served (C3c.2 Precondition) and network available:
  Run: `node scripts/mcp-stdio-smoke.mjs`
  Expected (the **decision gate**): **`mcp-stdio-smoke: ok (mcp-remote bridge)`**.
  - **If it passes:** `mcp-remote` is the shipped stdio path. **STOP — do NOT do C3c.3-FALLBACK.**
    Proceed to Step 4.
  - **If it fails** (e.g. `mcp-remote` refuses the endpoint / cannot bridge): record the exact
    failure at the top of `stdio-mcp-remote.md` and **do C3c.3-FALLBACK** below, then re-run its
    bridge test as the stdio gate.

- [ ] **Step 4 — gate + commit** (mcp-remote path):
  Run: `node scripts/check-agent-configs.mjs && node scripts/mcp-stdio-smoke.mjs`
  Expected: `agent-config lint: ok` then `mcp-stdio-smoke: ok (mcp-remote bridge)`.
```bash
git add docs/agents/mcp/stdio-mcp-remote.md scripts/mcp-stdio-smoke.mjs
git commit -m "test(agents): MCP stdio smoke via community mcp-remote bridge"
```

### Task C3c.3-FALLBACK (CONDITIONAL — EXECUTE ONLY IF the Step 3 `mcp-remote` smoke FAILED)

> Skip this entire sub-task if `mcp-stdio-smoke: ok` in Step 3. This exists solely so a failed
> community bridge does not block the stdio surface. Keep it **narrow**: a stdio↔streamable-HTTP
> proxy that forwards `tools/list` and `tools/call` (the two methods MOVP agents use), nothing more.

- [ ] **F1 — create the package** `packages/mcp-bridge/package.json`:
```json
{
  "name": "@movp/mcp-bridge",
  "version": "0.0.0",
  "type": "module",
  "bin": { "movp-mcp-bridge": "./src/index.ts" },
  "main": "./src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0"
  },
  "devDependencies": { "vitest": "^3.2.6" }
}
```
  ⚠ This adds `@modelcontextprotocol/sdk` (already used by `@movp/mcp`, so it is not a *new*
  repo dependency) to one new package — allowed because the community path failed. **Do not** run
  this step if the community smoke passed.

- [ ] **F2 — write the failing bridge test** `packages/mcp-bridge/test/bridge.test.ts`: start a stub
  streamable-HTTP MCP server (reuse `buildMcpServer` from `@movp/mcp` with an in-memory fake `db`, or
  a minimal `WebStandardStreamableHTTPServerTransport` fixture), spawn the bridge pointed at it, send
  `initialize`/`tools/list` over the bridge's stdio, and assert `tools/list` returns a `task.list`
  tool. Run: `pnpm --filter @movp/mcp-bridge exec vitest run` → Expected: **FAIL** (no `src/index.ts`).

- [ ] **F3 — implement** `packages/mcp-bridge/src/index.ts` — a stdio MCP **server** that forwards to
  a streamable-HTTP MCP **client** (verify the exact SDK 1.26.0 export paths at implementation time;
  `@movp/mcp` imports the server transport from
  `npm:@modelcontextprotocol/sdk@1.26.0/server/webStandardStreamableHttp.js`):

```ts
#!/usr/bin/env node
// Narrow stdio -> streamable-HTTP MCP proxy. Built ONLY because `mcp-remote` failed
// the stdio smoke. Reads MOVP_MCP_URL + MOVP_PAT from env.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const url = process.env.MOVP_MCP_URL
const pat = process.env.MOVP_PAT
if (!url || !pat) { console.error('movp-mcp-bridge: set MOVP_MCP_URL and MOVP_PAT'); process.exit(1) }

const upstream = new Client({ name: 'movp-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
await upstream.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${pat}` } },
}))

const server = new Server({ name: 'movp-bridge', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools())
server.setRequestHandler(CallToolRequestSchema, (req) => upstream.callTool(req.params))
await server.connect(new StdioServerTransport())
```

- [ ] **F4 — run the bridge test, expect PASS:**
  Run: `pnpm --filter @movp/mcp-bridge exec vitest run`
  Expected: PASS (bridge `tools/list` returns `task.list`).
  Then update `stdio-mcp-remote.md` to document the `@movp/mcp-bridge` fallback and commit both the
  package and the doc.

---

## Task C3c.4: Agent docs — `llms.txt`, consumer `AGENTS.md` template, error-code doc (+ docs-lint)

**Files**
- Create: `llms.txt` (repo root), `docs/agents/AGENTS.template.md`, `docs/agents/error-codes.md`
- Modify: `scripts/check-agent-configs.mjs` (append Section 4 at the `// C3C4_ANCHOR` line)

**Interfaces (consumed from C3a):** the four **stable** error codes
(`missing_token`/`invalid_token`/`expired_token`/`invalid_claims`); the endpoint path; the
tool-naming convention (`<collection>.<verb>` and `<domain>.<verb>`); the **workspace-id
convention** (agents pass `workspaceId` per call; the PAT's `default_workspace_id` is a *hint*, not
a boundary — a PAT is user-scoped).

> ⚠ **Do NOT touch the repo-root `AGENTS.md`** — it is a symlink to `CLAUDE.md`, pinned by
> `scripts/check-docs-presence.mjs`. The consumer template is the separate file
> `docs/agents/AGENTS.template.md`.

- [ ] **Step 1 — write** `docs/agents/error-codes.md` (the machine-checked facts: all four codes,
  the tool-naming convention, and the workspace-id convention):

```md
# MOVP agent connectivity — error codes & conventions

## Stable, agent-facing error codes
MCP/HTTP returns HTTP **401** with `{ "error": "<code>" }`; the CLI maps each to a non-zero exit +
friendly message. These four codes are **stable** — agents branch on them and must not expect others:

| Code | Meaning | Agent remedy |
|---|---|---|
| `missing_token` | No `Authorization` bearer was presented. | Attach `Authorization: Bearer movp_pat_…`. |
| `invalid_token` | Bad / not-found / **revoked** PAT, or an unverifiable JWT. | Re-authenticate; mint a new PAT. Do **not** blind-retry. |
| `expired_token` | The PAT (or minted session) is past `expires_at`. | Mint a fresh PAT / re-exchange. |
| `invalid_claims` | The verified session lacks required claims. | Re-authenticate. |

(A revoked PAT collapses to `invalid_token` at the principal boundary — agents should re-auth, not
retry the same token.)

## Tool naming
Tools are `<collection>.<verb>` for schema collections (e.g. `task.list`, `task.create`,
`content.publish`) and `<domain>.<verb>` for cross-cutting domains (e.g. `workflow.event_types`,
`inbox.list`, `comment.add`). The authoritative registry is `packages/mcp/src/server.ts`; call
`tools/list` at runtime to enumerate what an instance exposes.

## Workspace-id convention
Pass **`workspaceId`** as a tool argument on every workspace-scoped call. A PAT is **user-scoped**:
it grants exactly the creating user's access across **all** their workspaces. The PAT's
`default_workspace_id` is a **CLI home hint**, **NOT** a security boundary — do not assume a PAT is
confined to one workspace.

## Example calls
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "workflow.event_types", "arguments": {} } }
```
```

- [ ] **Step 2 — write** `docs/agents/AGENTS.template.md` (a template a *consumer* drops into their
  own repo root as `AGENTS.md` to teach their agents how to reach their MOVP instance):

```md
<!-- MOVP consumer AGENTS.md template. Copy into your repo root as AGENTS.md and
     fill in <YOUR-INSTANCE> + your PAT storage. Endpoint path is fixed. -->
# Agents guide — <YOUR PROJECT> on MOVP

This project exposes a MOVP instance over MCP (streamable HTTP) and the `movp` CLI.

## Connect (MCP, streamable HTTP)
- Endpoint: `https://<YOUR-INSTANCE>/functions/v1/mcp`
- Auth: `Authorization: Bearer movp_pat_…` (a **user-scoped** Personal Access Token minted at
  `/settings/tokens`; treat it as an account credential and revoke on leak).
- Per-client config: see `docs/agents/mcp/` (Claude Code, Codex, Cursor, Gemini CLI, Copilot) and
  `docs/agents/mcp/stdio-mcp-remote.md` for stdio clients.

## Rules for agents
- Pass `workspaceId` on every workspace-scoped tool call (the PAT's default workspace is only a hint).
- Enumerate tools with `tools/list`; tools are named `<collection>.<verb>` / `<domain>.<verb>`.
- On `invalid_token` / `expired_token` (HTTP 401), re-authenticate — do not blind-retry. Full code
  list: `docs/agents/error-codes.md`.

## Example
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "<YOUR-WORKSPACE-UUID>" } } }
```
```

- [ ] **Step 3 — write** `llms.txt` at the **repo root** (well-known `/llms.txt`; H1 + blockquote +
  linked sections, per the llms.txt convention):

```md
# MOVP — agent connectivity

> MOVP is an OSS Supabase-backed suite. Named agent clients connect over MCP (streamable HTTP at
> `/functions/v1/mcp`, or stdio via `mcp-remote`) and the `movp` CLI, using user-scoped Personal
> Access Tokens (`Authorization: Bearer movp_pat_…`).

## MCP client configs
- [Claude Code](docs/agents/mcp/claude-code.md): streamable-HTTP `.mcp.json` sample.
- [Codex](docs/agents/mcp/codex.md): `~/.codex/config.toml` (rmcp, `bearer_token_env_var`).
- [Cursor](docs/agents/mcp/cursor.md): `.cursor/mcp.json` sample.
- [Gemini CLI](docs/agents/mcp/gemini-cli.md): `~/.gemini/settings.json` (`httpUrl`).
- [Copilot](docs/agents/mcp/copilot.md): `.vscode/mcp.json` (`servers`, prompted input).
- [stdio via mcp-remote](docs/agents/mcp/stdio-mcp-remote.md): stdio-only clients.

## Conventions
- [Error codes & conventions](docs/agents/error-codes.md): stable codes, tool naming, workspace-id.
- [Consumer AGENTS.md template](docs/agents/AGENTS.template.md).
```

- [ ] **Step 4 — extend the lint** `scripts/check-agent-configs.mjs`: **replace** the anchor line
  `// C3C4_ANCHOR` with the block below (adds error-code + llms.txt + AGENTS-template assertions):

```js
// --- 4. Agent-docs facts: stable error codes, llms.txt index, consumer template ---
const STABLE_CODES = ['missing_token', 'invalid_token', 'expired_token', 'invalid_claims']
const errCodesDoc = join(root, 'docs', 'agents', 'error-codes.md')
if (!existsSync(errCodesDoc)) fail('missing docs/agents/error-codes.md')
else {
  const t = readFileSync(errCodesDoc, 'utf8')
  for (const c of STABLE_CODES) if (!t.includes(`\`${c}\``)) fail(`error-codes.md missing stable code: ${c}`)
}
const llms = join(root, 'llms.txt')
if (!existsSync(llms)) fail('missing repo-root llms.txt')
else {
  const t = readFileSync(llms, 'utf8')
  if (!t.includes(MCP_ENDPOINT_PATH)) fail(`llms.txt must reference the MCP endpoint path ${MCP_ENDPOINT_PATH}`)
  for (const f of ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot']) {
    if (!t.includes(`agents/mcp/${f}`)) fail(`llms.txt must link to docs/agents/mcp/${f}`)
  }
}
if (!existsSync(join(root, 'docs', 'agents', 'AGENTS.template.md'))) fail('missing docs/agents/AGENTS.template.md (consumer template)')
```

- [ ] **Step 5 — run the extended lint, expect PASS** (the docs now satisfy every asserted fact; the
  `error-codes.md` / template / llms.txt `tools/call` frames also pass the Section-3 tool-drift check):
  Run: `node scripts/check-agent-configs.mjs`
  Expected: `agent-config lint: ok`.
  Sanity fail-check (optional, revert after): temporarily delete the `invalid_token` row from
  `error-codes.md` → re-run → Expected FAIL `error-codes.md missing stable code: invalid_token`;
  restore the row.

- [ ] **Step 6 — prove the root-AGENTS symlink invariant is intact** (we added a *different* template
  file, not the root symlink):
  Run: `node scripts/check-docs-presence.mjs`
  Expected: exits 0 (no output on success), i.e. root `AGENTS.md` is still the `CLAUDE.md` symlink.

- [ ] **Step 7 — gate + commit.**
  Run: `node scripts/check-agent-configs.mjs && node scripts/check-docs-presence.mjs`
  Expected: `agent-config lint: ok` then a clean `check-docs-presence` (exit 0).
```bash
git add llms.txt docs/agents/AGENTS.template.md docs/agents/error-codes.md scripts/check-agent-configs.mjs
git commit -m "docs(agents): llms.txt + consumer AGENTS template + stable error-code doc"
```

- [ ] **Step 8 — part close (NOT phase close).** In the SAME commit series, record C3c as landed in
  the Stage C tracking in `docs/superpowers/plans/README.md` (mark **C3c** done within the C3 row;
  do **not** mark the C3 *phase* done — that requires C3a–C3d all merged; `CLAUDE.md` Phase
  Completion Signal). C3d wires the `mcp-http-smoke` + `mcp-stdio-smoke` + revoke path into the
  `[agents]` slice-e2e and CI.

---

## Cross-cutting acceptance criteria (verify before requesting review)

- **Correctness:** all five samples point at the exact endpoint `/functions/v1/mcp`; each uses its
  client's **real** schema (Codex `bearer_token_env_var`+`experimental_use_rmcp_client`; Gemini
  `httpUrl`; Copilot `servers`+`inputs`; Claude/Cursor `mcpServers`). Every documented `tools/call`
  names a tool that `registerTool('<name>')`s in `packages/mcp/src/server.ts` — pinned by the lint,
  so a rename in `server.ts` fails CI (drift guard). Spec §10–§12 ↔ samples ↔ lint agree.
- **Safety:** no PAT value is committed (samples use `movp_pat_REPLACE_WITH_YOUR_TOKEN` or an
  env-expansion placeholder; Copilot uses a prompted `${input:}`); the smokes seed an ephemeral
  1-day PAT and never print it; docs state the **user-scoped** blast radius + revoke-on-leak. The
  negative smoke proves a bad PAT is **401 `invalid_token`** (fail-closed).
- **Reliability:** the HTTP smoke asserts a bad PAT rejects AND a real PAT completes
  initialize/tools-list/tools-call; `parseRpc` handles raw-JSON, SSE, and newline-delimited stdio
  framing; the stdio path prefers the community bridge and falls back to a narrow custom bridge only
  on failure (bounded, explicit decision gate — no silent swallow).
- **Observability:** the lint and both smokes fail **hard and loud** with a specific message
  (`endpoint path must be …`, `unregistered tool "…"`, `bogus PAT should map to invalid_token`); the
  smokes print the exact JSON-RPC frames for diagnosis; no token value is logged.
- **Efficiency / Performance:** no MCP server code added (endpoint/transport/registry reused); the
  lint is a single dependency-free pass over docs + one source file; the smokes seed once and reuse
  the session; `mcp-remote` is `npx`-run (no install, no bundle weight).
- **Simplicity:** one lint script grows across C3c.1→C3c.4 (config + drift + docs) rather than three
  scripts; `scripts/lib/mcp-frames.mjs` has two real consumers (HTTP + stdio smokes); the custom
  bridge is **conditional** (YAGNI). No TOML dependency (regex-extract the two Codex keys).
- **Usability:** each client gets a copy-paste config + a CLI one-liner where the client has one +
  a self-hosted `apikey` note; `error-codes.md` gives each code an agent remedy; `llms.txt` +
  `AGENTS.template.md` are drop-in for a downstream operator.

## Self-check (author, satisfied)
1. Every sample is copy-paste-correct against the client's researched schema; the lint validates each
   by its own rule (Codex ≠ the JSON clients). ✅
2. Every task ends with a machine-checkable gate (exact command + expected output); pure-docs facts
   are asserted by the extended lint, not "write docs." ✅
3. Fail-first is real and observable: config-lint (endpoint typo + unregistered tool), HTTP smoke
   (`Cannot find module .../lib/mcp-frames.mjs`), docs-lint (missing stable code). ✅
4. Endpoint (`/functions/v1/mcp`), stateless-SSE framing, and `apikey`/`verify_jwt=false` gotchas are
   commented at the code that triggers them, not only here. ✅
5. Tool-drift guard cross-checks against the **live** registry, so docs cannot rot silently. ✅
6. Cross-part dependency (C3a merged; C3b optional) and the phase-vs-part completion rule are stated
   as preconditions, not assumed. ✅
7. Root-`AGENTS.md`-is-a-symlink invariant is preserved (separate template file) and re-checked. ✅
8. stdio prefers the community bridge; the custom `@movp/mcp-bridge` is conditional with its own
   minimal test. ✅
```
