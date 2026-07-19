# Gemini CLI — MOVP MCP (streamable HTTP)

Gemini CLI reads MCP config from `~/.gemini/settings.json`. The **streamable-HTTP** transport uses
the `httpUrl` key (not `url`, which is SSE) plus `headers`.

## Option A — CLI

Load `MOVP_PAT` from a credential store without typing its value into a command or shell history.

```sh
: "${MOVP_PAT:?MOVP_PAT is not set; load it from your credential store}"
gemini mcp add --transport http \
  --header 'Authorization: Bearer ${MOVP_PAT}' \
  movp https://your-project-ref.supabase.co/functions/v1/mcp
```

The single quotes write the literal `${MOVP_PAT}` into `settings.json`; Gemini expands it at load.

## Option B — settings.json
Merge `gemini-cli.json` in this directory into `~/.gemini/settings.json`. `${VAR}` expansion is
supported, so prefer `"Authorization": "Bearer ${MOVP_PAT}"`. Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
