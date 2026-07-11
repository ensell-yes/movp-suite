# MOVP agent connectivity — error codes & conventions

## Stable, agent-facing error codes
MCP/HTTP returns HTTP **401** with `{ "error": "<code>" }`; the CLI maps each to a non-zero exit +
friendly message. These four codes are **stable** — agents branch on them and must not expect others:

| Code | Meaning | Agent remedy |
|---|---|---|
| `missing_token` | No `Authorization` bearer was presented. | Attach `Authorization: Bearer movp_pat_…`. |
| `invalid_token` | Bad / not-found / **revoked** PAT, or an unverifiable JWT. | Re-authenticate; mint a new PAT. Do **not** blind-retry. |
| `expired_token` | The PAT (or minted session) is past `expires_at`. | Mint a fresh PAT / re-exchange. |
| `invalid_claims` | The verified session lacks required claims. | Re-authenticate. |

(A revoked PAT collapses to `invalid_token` at the principal boundary — agents should re-auth, not
retry the same token.)

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
