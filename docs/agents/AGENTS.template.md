<!-- MOVP consumer AGENTS.md template. Copy into your repo root as AGENTS.md and
     fill in <YOUR-INSTANCE> + your PAT storage. Endpoint path is fixed. -->
# Agents guide — <YOUR PROJECT> on MOVP

This project exposes a MOVP instance over MCP (streamable HTTP) and the `movp` CLI.

## Connect (MCP, streamable HTTP)
- Endpoint: `https://<YOUR-INSTANCE>/functions/v1/mcp`
- Auth: `Authorization: Bearer movp_pat_…` (a **user-scoped** Personal Access Token minted at
  `/settings/tokens`; treat it as an account credential and revoke on leak).
- Per-client config: see `docs/agents/mcp/` (Claude Code, Codex, Cursor, Gemini CLI, Copilot) and
  `docs/agents/mcp/stdio-bridge.md` for stdio clients.

## Rules for agents
- Pass `workspaceId` on every workspace-scoped tool call (the PAT's default workspace is only a hint).
- Enumerate tools with `tools/list`; tools are named `<collection>.<verb>` / `<domain>.<verb>`.
- On `invalid_token` / `expired_token` (HTTP 401), re-authenticate — do not blind-retry. Full code
  list: `docs/agents/error-codes.md`.
- Revocation blocks new PAT exchanges immediately; already-minted sessions can remain valid for up to
  1 hour. Terminate active agent processes when rotating a leaked credential.

## Example
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "<YOUR-WORKSPACE-UUID>" } } }
```
