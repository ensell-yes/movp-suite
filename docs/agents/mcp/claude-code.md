# Claude Code — MOVP MCP (streamable HTTP)

MOVP exposes a streamable-HTTP MCP endpoint at `${apiUrl}/functions/v1/mcp`. Authenticate with a
Personal Access Token (`movp_pat_…`, minted at `/settings/tokens`). A PAT is **user-scoped** — it
grants exactly the creating user's access; treat it as an account credential and revoke on leak.

## Option A — CLI

Load `MOVP_PAT` from Keychain, a password manager, or another secure environment injector without
typing its value into a command or shell history. The example assumes it is already set.

```sh
: "${MOVP_PAT:?MOVP_PAT is not set; load it from your credential store}"
claude mcp add --transport http movp \
  https://your-project-ref.supabase.co/functions/v1/mcp \
  --header 'Authorization: Bearer ${MOVP_PAT}'
claude mcp get movp
```

The single quotes keep the PAT out of argv and store only the environment placeholder. Claude Code
expands it when connecting.

## Option B — `.mcp.json` (project scope)
Copy `claude-code.json` in this directory and securely inject `MOVP_PAT` before launching Claude Code.
`${VAR}` / `${VAR:-default}` expansion is supported in `url` and `headers`. Claude Code asks you to
approve a project-scoped server before connecting; after approval, `claude mcp get movp` should show
`Connected`.

## Example call
Agents pass `workspaceId` on every call (see `../error-codes.md`):
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

## Self-hosted / local gateways
A hosted MOVP `mcp` function is `verify_jwt = false`, so only `Authorization` is required. If you
front the endpoint with a gateway that requires the Supabase `apikey` header (e.g. a local Supabase
stack), add `"apikey": "<ANON_KEY>"` to `headers`.
