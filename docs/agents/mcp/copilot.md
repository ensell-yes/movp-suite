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
