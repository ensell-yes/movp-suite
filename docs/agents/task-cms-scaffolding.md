# Scaffold an application on MOVP Task and CMS

This sequence gives Claude or Codex enough context to scaffold an application without reverse-engineering MOVP.
Read the [data contract](task-cms-data-contract.md) and [interface contract](task-cms-interface-contract.md)
before generating application models, forms, or workflows.

## 1. Connect and resolve the workspace

Configure MCP with the client-specific sample under `docs/agents/mcp`, then call `tools/list`. Obtain the target
workspace UUID from the operator; the PAT's default workspace is only a CLI preference and is not authorization.
Do not place the PAT in source, prompts committed to the repository, command arguments, or logs.

## 2. Load Task configuration

Before rendering task forms or creating a task, list `task_status_option` and `task_priority_option` for the
workspace. Persist their UUIDs as configuration, not hard-coded labels. Branch on status `category`, never on a
translated label.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```

Use `task.create` for a task plus initial description, `task.update_description` for later description revisions,
and `task.transition` for state changes. Use `task.board` when the UI needs tasks grouped by active status.

## 3. Load or create the content type

Content is schema-driven. Resolve the type by workspace and key before generating an editor. A minimal article
field schema is:

```json
[
  { "name": "title", "type": "text", "required": true },
  { "name": "body", "type": "richtext", "required": true },
  { "name": "hero", "type": "asset" },
  { "name": "category", "type": "enum", "values": ["news", "guide"] }
]
```

Call `content.create_type` and pass that array directly as MCP `fieldSchema`; JSON-encoded strings remain
compatible. Likewise, pass structured
objects as MCP `data` to `content.create` and `content.update`. The CLI uses JSON strings in `--field-schema` and
`--data` because it crosses a shell boundary.

## 4. Preserve the editorial lifecycle

Create draft content, read it with `content.get_detail`, and retain `currentRevision.id`. Pass that ID as
`expectedRevisionId` on update, submit it for approval, decide the approval, and publish the approved revision.
Do not set status or revision-pointer columns directly. If editorial work needs tracking, connect it with
`content.link_editorial_task` (CLI: `movp content link-task`).

Assets use issue, upload, then finalize. Never treat receipt of a presigned URL as proof that the asset is complete.
Keep the returned asset UUID in content data or a `references` edge according to the content-type design.

## 5. Generate application boundaries

The scaffold should keep these layers separate:

- Server adapter: owns MCP or CLI invocation, PAT/session handling, pagination, and stable error mapping.
- Application model: maps MOVP snake-case rows to local view models without changing IDs or enum meanings.
- UI: renders workspace configuration and content field schemas; it never holds service-role credentials.
- Tests: use fixed fake UUIDs and contract-shaped fixtures, plus one authenticated create/read integration smoke.

For a workerd deployment, resolve the request-bound client, environment, and execution context at call time.
Never capture them in module scope or a constructor, and do not use `process.env` inside the Worker.

## Consumer agent instructions

Copy this block into the downstream repository's agent instructions and fill in the contract location:

```md
## MOVP Task/CMS contract

- Read the MOVP Task/CMS data, interface, and scaffolding contracts before changing integration code.
- Use MCP or `movp` CLI invariant-bearing operations; do not assemble revisions, approvals, or publishes with
  direct table writes.
- Treat all IDs and cursors as opaque. Pass the workspace explicitly on every scoped call.
- Use status categories and content-type field schemas as configuration; do not hard-code labels.
- Keep PATs out of argv, repository files, logs, fixtures, and browser bundles.
```
