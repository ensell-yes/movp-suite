# Codex — MOVP MCP (streamable HTTP via rmcp)

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
Codex reads MCP config from `~/.codex/config.toml`. Streamable-HTTP servers require the rmcp client
(`experimental_use_rmcp_client = true`) and authenticate via `bearer_token_env_var` — the **name**
of an env var whose value Codex sends as the Bearer token (Codex does not take a literal
`Authorization` header for HTTP servers).
