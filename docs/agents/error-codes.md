# MOVP agent connectivity — error codes & conventions

## Stable, agent-facing error codes
MCP/HTTP returns `{ "error": "<code>" }`; the CLI maps each code it can encounter to a non-zero exit.
These codes are stable:

| Code | Meaning | Agent remedy |
|---|---|---|
| `missing_token` | No `Authorization` bearer was presented. | Attach `Authorization: Bearer movp_pat_…`. |
| `invalid_token` | Bad / not-found / **revoked** PAT, or an unverifiable JWT. | Re-authenticate; mint a new PAT. Do **not** blind-retry. |
| `expired_token` | The PAT (or minted session) is past `expires_at`. | Mint a fresh PAT / re-exchange. |
| `invalid_claims` | The verified session lacks required claims. | Re-authenticate. |
| `mcp_access_disabled` | The authenticated user's MCP preference is disabled. | Do not retry; the user must enable MCP access in Security settings. |
| `cli_access_disabled` | The authenticated user's PAT-backed CLI/API preference is disabled. | Do not retry; the user must enable CLI & API access (PAT). |
| `agent_access_check_failed` | The server could not evaluate preferences after its one bounded retry. | Retry later; if it persists, contact the operator. |
| `agent_session_ttl_out_of_bounds` | The server is configured to mint a PAT session longer than 3,600 seconds. | Do not retry until the operator corrects the session lifetime. |

(A revoked PAT collapses to `invalid_token` at the principal boundary — agents should re-auth, not
retry the same token.)

Authentication failures return HTTP **401**, disabled preferences return **403**, and preference-check or
session-lifetime failures return **503**. Revocation and the PAT preference block new exchanges immediately;
already-minted sessions can remain valid for up to 1 hour, until their JWT expires. The MCP preference is
checked without a preference cache on every request, including requests authenticated by a session JWT.
A directly supplied `MOVP_ACCESS_TOKEN` is outside the PAT CLI/API preference. Rotate credentials and
terminate active agent processes after a leak.

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
