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
