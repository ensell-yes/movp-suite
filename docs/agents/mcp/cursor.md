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
