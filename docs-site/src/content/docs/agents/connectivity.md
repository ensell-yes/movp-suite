---
title: Agent connectivity
description: Connect coding agents to MOVP over the hosted MCP endpoint.
---

MOVP exposes a **streamable-HTTP MCP** endpoint at `${apiUrl}/functions/v1/mcp`. Authenticate with a
**Personal Access Token** (`movp_pat_…`), minted at `/settings/tokens`. A PAT is **user-scoped**: it
grants exactly the creating user's access across all their workspaces — treat it as an account
credential and revoke on leak. `default_workspace_id` is a CLI home hint, not a security boundary.

## Transport matrix

| Client | Transport | Config |
| --- | --- | --- |
| Claude Code | streamable HTTP | `claude mcp add --transport http movp <apiUrl>/functions/v1/mcp --header "Authorization: Bearer movp_pat_…"` |
| Cursor / Copilot / Gemini / Codex | streamable HTTP | copy the matching config from `docs/agents/mcp/` |
| Stdio-only clients | `@movp/mcp-bridge` | set `MOVP_MCP_URL` + `MOVP_PAT` (local gateways may also need `MOVP_MCP_APIKEY`) |
| CLI | direct | `movp` reads a stored PAT and exchanges it for a session |

The hosted `mcp` function is `verify_jwt = false`, so only `Authorization` is required. If you front
the endpoint with a gateway that requires the Supabase `apikey` header, add `"apikey": "<ANON_KEY>"`.

## Every call carries `workspaceId`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

## Stable error codes

Agents branch on exactly these four (HTTP 401 with `{ "error": "<code>" }`):

| Code | Meaning | Remedy |
| --- | --- | --- |
| `missing_token` | no `Authorization` bearer | attach `Authorization: Bearer movp_pat_…` |
| `invalid_token` | bad / not-found / **revoked** PAT, or unverifiable JWT | re-authenticate; do not blind-retry |
| `expired_token` | PAT or session past `expires_at` | mint a fresh PAT / re-exchange |
| `invalid_claims` | verified session lacks required claims | re-authenticate |
