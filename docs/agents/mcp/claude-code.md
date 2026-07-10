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
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

## Self-hosted / local gateways
A hosted MOVP `mcp` function is `verify_jwt = false`, so only `Authorization` is required. If you
front the endpoint with a gateway that requires the Supabase `apikey` header (e.g. a local Supabase
stack), add `"apikey": "<ANON_KEY>"` to `headers`.
