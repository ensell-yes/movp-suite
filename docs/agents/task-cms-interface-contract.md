# MOVP Task and CMS agent interface contract

Claude, Codex, and other agents should prefer MCP for runtime discovery and use the `movp` CLI for shell
automation. Both authenticate as an ordinary MOVP user and therefore share the same row-level security.

## Connection and discovery

- MCP endpoint: `https://<instance>/functions/v1/mcp`.
- MCP authentication: `Authorization: Bearer movp_pat_...`.
- CLI authentication: pipe a PAT to `movp login`; never pass it in argv. The CLI stores it in the macOS
  Keychain by default and exchanges it for a bounded user session.
- A PAT is user-scoped. Pass `workspaceId` to every workspace-scoped MCP call; use `--workspace` in the CLI.
- Call MCP `tools/list` at startup. Static tools use `<domain>.<verb>` names; schema-generated tools use
  `<collection>.<verb>`.

Successful MCP Task/CMS tools return the same value twice: JSON in the first text content item for older clients,
and `{ "result": <value> }` in `structuredContent`. Contract 1 does not yet declare per-tool output schemas;
clients should use the documented result shapes, with typed MCP output schemas deferred. Successful CLI commands
emit one JSON value on stdout. Operational failures exit nonzero in the CLI. Authentication errors are the stable
codes documented in [error-codes.md](error-codes.md).

## Existing Task surface

| Capability | MCP | CLI |
|---|---|---|
| Create | `task.create` | `movp task create` |
| Read metadata | `task.get` | — |
| Read complete detail | `task.get_detail` | `movp task get` |
| List/filter | `task.list` | `movp task list` |
| Board | `task.board` | `movp task board` |
| Assign | `task.assign` | `movp task assign` |
| Unassign | `task.unassign` | `movp task unassign` |
| Add/remove observer | `task.add_observer`, `task.remove_observer` | `movp task observe`, `movp task unobserve` |
| Transition | `task.transition` | `movp task transition` |
| Add/remove dependency | `task.add_dependency`, `task.remove_dependency` | `movp task depend`, `movp task undepend` |
| Replace description | `task.update_description` | `movp task describe` |
| Attach uploaded object | `task.attach` | `movp task attach` |
| Status/priority configuration | `task_status_option.*`, `task_priority_option.*` | matching generated command groups |

`task.create` accepts `workspaceId`, `title`, and optional `description`, `statusId`, `priorityId`, `parentId`,
`startDate`, `dueDate`, and `idempotencyKey`. Reuse the same idempotency key after an indeterminate create
failure. When status or priority is omitted, the active workspace default is selected. `task.list` accepts
`statusId`, `assigneeId`, `parentId`, `topLevel`, `first`, and `after`. `task.get_detail` returns `{ task,
description, assignments, observers, dependencies, attachments }`.

## Existing CMS surface

| Capability | MCP | CLI |
|---|---|---|
| Create type | `content.create_type` | `movp content create-type` |
| List types | `content.list_types` | `movp content types` |
| Create/update item | `content.create`, `content.update` | `movp content create`, `movp content update` |
| Read item metadata | `content.get` | — |
| Read complete detail | `content.get_detail` | `movp content get` |
| List item metadata | `content.list` | `movp content list` |
| Revision history | `content.list_revisions` | `movp content revisions` |
| Published revision | `content.get_published` | `movp content published` |
| Approval queue | `content.list_approvals` | `movp content approvals` |
| Submit/decide | `content.submit_for_approval`, `content.decide_approval` | `movp content submit`, `movp content decide` |
| Publish/unpublish | `content.publish`, `content.unpublish` | `movp content publish`, `movp content unpublish` |
| Schedule | `content.schedule` | `movp content schedule` |
| SEO audit | `content.run_seo_audit` | `movp content seo-audit` |
| Issue upload | `content.issue_asset_upload` | `movp content asset-upload` |
| Finalize upload | `content.finalize_asset` | `movp content asset-finalize` |
| Collections | `content.create_collection`, `content.add_to_collection`, `content.reorder_collection` | `movp content collection-create`, `movp content collection-add`, `movp content collection-reorder` |
| Content links | `content.link_asset`, `content.link_item`, `content.link_editorial_task` | `movp content link-asset`, `movp content link-item`, `movp content link-task` |

MCP accepts `fieldSchema` and content `data` as structured JSON values; it also retains JSON-encoded strings for
older callers. The CLI accepts JSON through flags. Do not shell-interpolate untrusted content. `content.update`
accepts `expectedRevisionId`; the CLI equivalent is `--expected-revision`. A stale value fails instead of
overwriting a newer revision. `content.get_detail` returns `{ item, type, currentRevision }`, while
`content.get_published` returns `{ item, revision }` or `null`.

## Pagination and retry rules

- Page size defaults to 20 and is bounded to 100 by the domain.
- `nextCursor` is opaque. Reuse it only with the same operation, workspace, and filters.
- Retry an indeterminate transport failure with the same idempotency key when the operation accepts one.
- Do not retry `invalid_token`, validation failures, authorization denials, or optimistic-concurrency conflicts.
- Do not reconstruct a failed multi-row write with direct table calls.

## Compatibility policy

This is Contract 1. Existing tool and command names are retained; the completed reads and mutations are additive.
MCP structured output mirrors the existing JSON text so old clients continue to work. A field may be added to an
object, but an existing field will not be renamed or change meaning without a versioned contract.

## Other transports

GraphQL has broader web-application coverage, and PostgREST provides RLS-filtered table/RPC access. They are
documented implementation surfaces, not a reason for an agent to bypass a Task/CMS invariant-bearing MCP or CLI
operation. See [the REST boundary](../rest.md).
