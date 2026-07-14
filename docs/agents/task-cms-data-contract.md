# MOVP Task and CMS data contract

This is the consumer-facing data contract for applications built on MOVP Task and MOVP CMS. The
authoritative implementation remains the schema definitions under `packages/core-schema`, the generated
row types in `packages/domain/src/generated/types.ts`, and the invariant-bearing RPC migrations. Consumers
must use MCP or the `movp` CLI for writes that span more than one row.

## Shared conventions

- IDs are UUID strings. Date values use `YYYY-MM-DD`; timestamps are ISO-8601 strings.
- Every application row is scoped by `workspace_id`. A Personal Access Token is user-scoped, while
  membership and row-level security determine access to each workspace.
- Rows normally carry `id`, `workspace_id`, `created_at`, and `updated_at` in addition to the fields below.
- Foreign keys use snake-case names such as `status_id`; MCP arguments use camel case such as `statusId`.
- An inaccessible row is commonly indistinguishable from a missing row. Do not infer that another tenant's
  row exists from an empty result.
- List contracts use `{ "items": [...], "nextCursor": string | null }`. Treat cursors as opaque.

## Task model

### Task

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Required display title. |
| `status_id` | UUID | Required reference to an active workspace status option. |
| `priority_id` | UUID | Required reference to an active workspace priority option. |
| `parent_id` | UUID or null | Parent task for a subtask. |
| `current_revision_id` | UUID or null | Current immutable description revision. |
| `start_date`, `due_date` | date or null | Scheduling bounds. |
| `dependency_blocked` | boolean | Derived from unfinished blockers; clients do not set it directly. |
| `completed_at` | timestamp or null | Maintained from the target status category. |

`task_status_option.category` is one of `backlog`, `active`, `blocked`, or `done`. Labels and colors are
workspace configuration; business logic branches on the category, not on a label such as "Complete".
`task_priority_option` provides a required numeric `rank` plus optional label/color configuration.

Task descriptions are append-only revisions. Creating a task and its first description, or replacing a
description and advancing `current_revision_id`, is one atomic operation. Identical replacement bodies are
deduplicated. Never update `task_revision` directly.

Related records are:

- `task_assignment`: `(task_id, assignee_user_id)`, role `owner`.
- `task_observer`: `(task_id, observer_user_id)`.
- `task_dependency`: `task_id` is blocked by `blocker_id`; both tasks must be in the same workspace.
- `task_status_history`: append-only status transitions with `from_status_id`, `to_status_id`, and actor.
- `task_attachment`: an R2 key plus filename, MIME type, byte size, and uploader.

Assignments, dependencies, status transitions, and description changes can emit lifecycle events. Writes are
idempotent where the interface says so; clients must not emulate those guarantees with direct table writes.

## CMS model

### Content type

A content type has a workspace-unique `key`, display `label`, `field_schema`, `moderation_policy`, and
`approval_policy`. Moderation is `none`, `pre`, or `post`; approval is `none`, `single`, or `multi`.

`field_schema` is an array of objects:

| Field | Required | Contract |
|---|---|---|
| `name` | yes | Non-empty and unique within the type. |
| `type` | yes | `text`, `richtext`, `number`, `bool`, `date`, `enum`, `asset`, `reference`, or `json`. |
| `required` | no | Boolean; omitted means optional. |
| `values` | for `enum` | Non-empty string array. |

Content data must match the current field schema. Unknown keys are removed by validation. Data is
canonicalized before hashing, so object-key order does not change `content_hash`.

### Content item and revisions

| Field | Type | Meaning |
|---|---|---|
| `content_type_id` | UUID | Required content type. |
| `slug` | string | Workspace/type route identity. |
| `status` | enum | `draft`, `in_review`, `approved`, `published`, or `archived`. |
| `current_revision_id` | UUID or null | Latest editable immutable revision. |
| `approved_revision_id` | UUID or null | Exact revision approved by workflow. |
| `published_revision_id` | UUID or null | Exact revision currently delivered. |
| `published_at` | timestamp or null | Publication time. |
| `search_text`, `search_body` | string or null | Derived search material; clients do not author it. |

`content_revision` is immutable and contains `revision_number`, structured `data`, `content_hash`,
`author_id`, and optional `parent_id`. Updates create a new revision. Clients should submit the revision they
edited as `expectedRevisionId`; a mismatch is an optimistic-concurrency conflict rather than a last-write win.

Editing approved or published content advances the draft pointer and demotes the editable state without
silently changing the revision already published. Publishing and scheduled publishing always pin an exact
revision and hash.

### Approval and publication

An approval is `pending`, `approved`, `rejected`, or `superseded`, with policy `single`, `multi`, or
`moderation`. Votes are immutable and are either `approve` or `reject`. Approval records pin the approved
revision and hash. Publication events are append-only audit rows for `publish` or `unpublish`.

A schedule pins `content_item_id`, `revision_id`, action, and `run_at`; its state is `scheduled`, `fired`,
`canceled`, or `failed`. A later edit does not retarget a previously scheduled revision.

### Assets, curation, and links

- `asset` records include filename, MIME type, R2 key, size, checksum, optional dimensions, and alt text.
  Upload is a two-step issue/finalize flow with server-side size and MIME bounds.
- `content_collection` is a keyed ordered curation list. `content_collection_entry.position` controls order.
- `content_seo` stores advisory metadata, JSON-LD, score, and checklist; it does not gate publication.
- Graph edges use `references` from content to an asset or another content item, and `editorial_task` from a
  content item to the task that implements the editorial work.

## Safe write boundary

Use the Task/CMS MCP tools or matching CLI commands for task creation and description changes, content
create/update, approvals, publication, schedules, and asset upload. PostgREST remains useful for RLS-filtered
reads, but direct multi-row writes can bypass revision, hash, event, or state-machine invariants.
