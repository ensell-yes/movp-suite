# Phase 3 — Task Management Roadmap Plan

> Plan `2026-06-30-movp-app-01-task-management.md` ; build order Phase 3 ; depends on Core, Collaboration.

## Goal

Model the full **MOVP Task** domain — the task backend that powers project management,
marketing planning, and CRM pipelines — entirely in Core config: `defineCollection`
definitions + lifecycle triggers + a per-workspace status/priority configuration + a
board/list/detail frontend. Tasks carry a title, a **versioned** description, start/due
dates, workspace-**customizable** priority and status, parent/child subtasks, **multi-owner**
assignment, observers, task→task blocking dependencies (driving a derived `dependency_blocked`
flag), an append-only status history, and R2-backed attachments. Discussion
(comment/mention/reaction/save/share) and the Inbox are **reused from the shared
Collaboration layer (Phase 2)** — this plan defines **no** task-specific comment tables.
The eight Task lifecycle events flow through Core's existing `emit_event` spine
(`movp_events` + `movp_jobs`); notifications reuse `@movp/notifications` (Resend default).
No new infrastructure — this is domain modeling on the Core substrate.

## Collections

All collections are `defineCollection({ …, workspaceScoped: true })`; codegen emits the
table, `workspace_id` + `is_workspace_member` RLS, FTS/vector, edges, GraphQL/MCP/CLI, TS
types, and metadata-registry rows. User references (`*_id uuid`) point at `auth.users(id)`
and are **member-validated** in the DB (see RLS & tenancy) — there is no `user` collection,
matching Core's `workspace_membership.user_id` pattern. `reporting` = `dimension`/`measure`.

### `task`

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `title` | `f.text` (required) | Title | — | dimension | searchable |
| `current_revision` | `f.relation('task_revision')` | Description (current) | many-to-one → `task_revision` (pointer) | — | — |
| `start_date` | `f.datetime` | Start date | — | dimension | — |
| `due_date` | `f.datetime` | Due date | — | dimension | — |
| `priority` | `f.relation('task_priority_option')` | Priority | many-to-one → `task_priority_option` | dimension | — |
| `status` | `f.relation('task_status_option')` | Status | many-to-one → `task_status_option` | dimension | — |
| `parent` | `f.relation('task')` | Parent task | many-to-one → `task` (self; subtasks) | dimension | — |
| `dependency_blocked` | `f.boolean` (default `false`) | Blocked by dependency | — (derived) | dimension | — |
| `completed_at` | `f.datetime` (nullable) | Completed at | — (set by completion trigger) | dimension | — |

The description text is **not** a column on `task`; it lives in `task_revision` and is
reached through the `current_revision` pointer (see Versioning). Only the current revision's
body is FTS-/vector-indexed. `dependency_blocked` and `completed_at` are **derived** by
triggers, never written directly by clients.

### `task_status_option` — per-workspace status config (customizable status)

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `label` | `f.text` (required) | Label | — | dimension | searchable |
| `category` | `f.enum(['backlog','active','blocked','done'])` | Category | — | dimension | — |
| `color` | `f.text` | Color (hex) | — | — | — |
| `sort_order` | `f.number` | Board order | — | dimension | — |
| `is_default` | `f.boolean` | Default for new tasks | — | dimension | — |

`category` is the **label-independent** semantic the lifecycle logic keys on, so custom
labels never break completion/blocked/board behaviour. Seeded per workspace with
**Backlog / In Progress / Blocked / Done** (categories `backlog/active/blocked/done`).

### `task_priority_option` — per-workspace priority config (customizable priority)

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `label` | `f.text` (required) | Label | — | dimension | searchable |
| `rank` | `f.number` | Severity rank (higher = more urgent) | — | measure | — |
| `color` | `f.text` | Color (hex) | — | — | — |
| `is_default` | `f.boolean` | Default for new tasks | — | dimension | — |

Seeded per workspace with **High / Medium / Low**. Chosen over a single workspace-settings
JSON blob because statuses/priorities are **reportable dimensions** tasks group by (BI /
segmentation) and are naturally RLS-scoped rows.

### `task_revision` — immutable description history (versioning)

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `task` | `f.relation('task')` | Task | many-to-one → `task` | — | — |
| `body` | `f.richText` | Description | — | — | searchable, embeddable |
| `content_hash` | `f.text` | Content hash | — | — | — |
| `author_id` | `f.uuid` | Author | → `auth.users(id)` | dimension | — |
| `created_at` | `f.datetime` (default `now()`) | Created at | — | dimension | — |

Append-only. `body` is `searchable`/`embeddable`, but indexing is **restricted to the row the
`task.current_revision` pointer targets** (partial/pointer-guarded enqueue) so historical
revisions are never re-embedded — otherwise every edit would multiply embedding spend
(Efficiency).

### `task_assignment` — multi-owner assignment

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `task` | `f.relation('task')` | Task | many-to-one → `task` | — | — |
| `assignee_id` | `f.uuid` | Owner | → `auth.users(id)` (member-checked) | dimension | — |
| `assigned_by` | `f.uuid` | Assigned by | → `auth.users(id)` | dimension | — |

`unique(task_id, assignee_id)`. A row **is** ownership; a task may have many rows (multi-owner).
This collection is the **Inbox "Assigned Items"** seam the Collaboration Inbox references.

### `task_observer` — observers

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `task` | `f.relation('task')` | Task | many-to-one → `task` | — | — |
| `observer_id` | `f.uuid` | Observer | → `auth.users(id)` (member-checked) | dimension | — |
| `added_by` | `f.uuid` | Added by | → `auth.users(id)` | dimension | — |

`unique(task_id, observer_id)`. Observers receive notifications but do not own the task.

### `task_dependency` — task→task blocking

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `blocker` | `f.relation('task')` | Blocker (must finish first) | many-to-one → `task` | dimension | — |
| `blocked` | `f.relation('task')` | Blocked (waiting) | many-to-one → `task` | dimension | — |

`unique(blocker_id, blocked_id)`, `check (blocker_id <> blocked_id)`, + a **cycle guard**
(reject inserts that would close a `blocks` cycle via a recursive check). Chosen as a
dedicated link table over `edges` because the relationship (a) drives the
`task.dependency_blocked` recompute trigger, (b) needs FK cascade on both ends and a cycle
check, all of which sit cleanly on a dedicated table instead of loading task-specific logic
onto the shared `edges` table. (Alternative: `edges` with `rel='blocks'` — recorded, not chosen.)

### `task_status_history` — append-only transitions

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `task` | `f.relation('task')` | Task | many-to-one → `task` | — | — |
| `from_status` | `f.relation('task_status_option')` (nullable) | From | many-to-one → `task_status_option` | dimension | — |
| `to_status` | `f.relation('task_status_option')` | To | many-to-one → `task_status_option` | dimension | — |
| `changed_by` | `f.uuid` | Changed by | → `auth.users(id)` | dimension | — |
| `changed_at` | `f.datetime` (default `now()`) | Changed at | — | dimension | — |

Append-only (feeds cycle-time / lead-time analytics). Written atomically by the status trigger.

### `task_attachment` — R2-backed attachments

| Field | Type (`f.*`) | Label | Cardinality / relation | Reporting | Search/Embed |
|---|---|---|---|---|---|
| `task` | `f.relation('task')` | Task | many-to-one → `task` | — | — |
| `filename` | `f.text` (required) | File name | — | dimension | searchable |
| `r2_key` | `f.text` (required) | R2 object key | — | — | — |
| `content_type` | `f.text` | MIME type | — | dimension | — |
| `size_bytes` | `f.number` | Size | — | measure | — |
| `uploaded_by` | `f.uuid` | Uploaded by | → `auth.users(id)` | dimension | — |

The row stores **metadata only** — bytes live in R2. Uploads go through a server-minted
presigned PUT; downloads through a member-scoped presigned GET. `content_type`/`size_bytes`
are validated at the upload boundary (bound-before-store); the row is never a channel for
object bytes.

## Relationships

- **FK (many-to-one `relation` fields):** every `*.task` link; `task.parent` (self-referential
  subtask tree, traversed by recursive query — not edges); `task.priority`, `task.status`,
  `task.current_revision`; `task_status_history.from_status`/`to_status`;
  `task_dependency.blocker`/`blocked`. Subtasks are children where `parent_id = <task>`.
- **Link tables (rich behaviour):** `task_assignment`, `task_observer`, `task_dependency`,
  `task_status_history` — each carries attributes and/or drives triggers, so a table beats
  `edges` (convention 2).
- **`edges` (graph):** none introduced here beyond Core defaults; the Collaboration layer
  writes `(entity_type='task', entity_id)` edges for comment/mention/reaction/save/share.
- **User references:** `assignee_id`, `observer_id`, `author_id`, `changed_by`, `*_by`,
  `uploaded_by` are `auth.users(id)` uuids, member-validated in RLS — not a collection relation.

## Versioning

Task descriptions use the roadmap's **immutable `*_revision` + current-pointer + `content_hash`**
pattern (defined in CMS, reused here):

- Editing the description **inserts** a `task_revision` (never mutates one) and repoints
  `task.current_revision` to it. `task_revision` is append-only.
- The service computes `content_hash` over the normalized body; if it equals the current
  revision's hash, **no new revision is created and the pointer is unchanged** — idempotent
  edits do not churn history or re-embed (Efficiency).
- Only the current revision's `body` is FTS/vector-indexed (pointer-guarded enqueue), so
  search reflects the live description and stale revisions cost nothing.
- Description edits emit **no** lifecycle event (the registry defines no task-revision event);
  history is queryable via `task_revision` ordered by `created_at`.

## Lifecycle events

Emitted verbatim per the roadmap registry, each via a DB `AFTER` trigger →
`movp_internal.on_*()` (`SECURITY DEFINER`, pinned `search_path`) → `public.emit_event(type,
ws, payload, trace)`, which writes `movp_events` and enqueues `notify` + `webhook` jobs.
**Exactly one event per transition** — at the "done" boundary, `task.completed`/`task.reopened`
are emitted **instead of** `task.status_changed`, not in addition. Payloads carry **ids and
hashes, never emails/PII** (Observability).

| Event | Trigger source | Fires when | Default notify recipients |
|---|---|---|---|
| `task.created` | `AFTER INSERT` on `task` | new task | workspace owners of the task (creator) |
| `task.assigned` | `AFTER INSERT` on `task_assignment` | owner added | the new assignee |
| `task.observer_added` | `AFTER INSERT` on `task_observer` | observer added | the new observer |
| `task.status_changed` | `AFTER UPDATE OF status` on `task` | status changes, **not** crossing done | owners + observers |
| `task.completed` | same trigger | new `status.category='done'`, old ≠ done | owners + observers |
| `task.reopened` | same trigger | old `status.category='done'`, new ≠ done | owners + observers |
| `task.due_soon` | `pg_cron` scan | `due_date` within window, not done, not yet notified | owners + observers |
| `task.dependency_blocked` | recompute trigger | `dependency_blocked` flips `false → true` | owners + observers |

```sql
-- status trigger: one event per transition; done-boundary specializes; history is atomic
-- SECURITY DEFINER + set search_path = '' (Core hardening); all refs schema-qualified.
if new.status_id is distinct from old.status_id then
  insert into public.task_status_history(task_id, from_status, to_status, changed_by)
    values (new.id, old.status_id, new.status_id, auth.uid());
  if new_category = 'done' and old_category <> 'done' then
    update public.task set completed_at = now() where id = new.id;   -- derived
    perform public.emit_event('task.completed',  new.workspace_id, jsonb_build_object('id', new.id), null);
  elsif old_category = 'done' and new_category <> 'done' then
    update public.task set completed_at = null where id = new.id;
    perform public.emit_event('task.reopened',   new.workspace_id, jsonb_build_object('id', new.id), null);
  else
    perform public.emit_event('task.status_changed', new.workspace_id,
      jsonb_build_object('id', new.id, 'to_category', new_category), null);
  end if;
end if;
```

## Workflows / automation

- **Config seeding.** On workspace creation (Core bootstrap hook), seed the four default
  `task_status_option` rows and three `task_priority_option` rows so a new workspace has
  working defaults, all overridable.
- **Dependency-blocked recompute.** A trigger on `task_dependency` insert/delete **and** on a
  blocker task's status crossing into/out of `done` recomputes each affected `blocked` task:
  `dependency_blocked = exists(blocker whose status.category <> 'done')`. On a `false → true`
  flip it emits `task.dependency_blocked`. Recompute is bounded to the directly affected tasks.
- **`task.due_soon` scan.** A `pg_cron` job (hourly) invokes the `flows` worker / an
  `emit_due_soon()` RPC that selects tasks with `due_date` inside the reminder window,
  `status.category <> 'done'`, and not already reminded for this `due_date`, emitting
  `task.due_soon`. The `notify` idempotency key includes `task_id + due_date` so re-scans and
  worker retries never double-notify (Reliability). Reuses the existing per-minute worker cron
  shape (`cron.schedule(... net.http_post(...))`) — no new infra.

```sql
select cron.schedule('movp-task-due-soon', '0 * * * *', $$ select public.emit_due_soon() $$);
```

- **Notification recipient resolution.** The `flows` worker resolves recipients per task event
  by reading `task_assignment` (owners), `task_observer` (observers), and Collaboration
  `mention` rows on the task (for comment/mention events) via the service-role client, then
  sends through `@movp/notifications` (Resend default). Recipients are resolved, never
  hardcoded (convention 5).
- **Inbox seam.** `task_assignment` rows where `assignee_id = me` populate the Collaboration
  Inbox **Assigned Items** tab; task comment/mention/save activity flows through the shared
  Collaboration primitives into All Updates / Mentions / Saved.

## RLS & tenancy

- Every collection is `workspaceScoped` → codegen emits `is_workspace_member` RLS (read/write
  for members). Authoritative at the data boundary, not the UI (Core invariant 3).
- **Append-only tables** (`task_revision`, `task_status_history`): RLS grants `SELECT` +
  `INSERT` to members, **no `UPDATE`/`DELETE`** policy — immutability enforced in the DB.
- **Config collections** (`task_status_option`, `task_priority_option`): `SELECT` for all
  members, but `INSERT`/`UPDATE`/`DELETE` restricted to **admin/owner** membership roles via
  an RLS predicate on `workspace_membership.role` — a member cannot rename or delete a shared
  status/priority.
- **User-reference validation:** `assignee_id`/`observer_id` (and other user refs) must be a
  member of the task's workspace — enforced by a `with check` predicate / FK to
  `workspace_membership`, so a client cannot assign a non-member (Safety).
- **Attachments:** workspace RLS on the row; R2 access only via server-minted presigned URLs
  for verified members; `r2_key` is not a bearer capability on its own.
- **Derived fields** (`dependency_blocked`, `completed_at`) are written only by triggers; RLS/
  grants exclude them from client writes so clients cannot forge blocked/completed state.
- Events/jobs continue through the hardened `emit_event` (`service_role`) into `movp_internal`;
  users never touch the queue directly.

## Surfaces & frontend

- **Auto-generated (codegen):** tables + RLS + FTS/vector + `edges`, Pothos GraphQL
  (cursor-paginated, depth/complexity-bounded), MCP tools, CLI (`movp task create|list|…`),
  TS types/Zod, metadata-registry rows.
- **Frontend (Astro on CF Workers + R2, GraphQL client only):**
  - **Task list** — filter/sort by status, priority (`rank`), assignee, due date; paginated.
  - **Task detail** — description with **revision history**; owners; observers; subtask tree
    (`parent`); dependencies + `dependency_blocked` badge; attachments; a **Discussion** tab
    that mounts the shared Collaboration comment/mention/reaction components (no bespoke UI).
  - **Board (kanban)** — columns = `task_status_option` ordered by `sort_order`; dragging a
    card issues a status mutation → status trigger → event. Manual within-column reordering is
    **deferred** (v1 orders by `priority.rank` then `due_date`); no `board_rank` field until a
    real consumer needs it (Simplicity/YAGNI).
  - **Assignee / observer / subtask** views over the respective link tables.
- A11y/empty/loading/error states inherit the Core Astro template's UX+axe gate.

## Dependencies

- **Core (Phase 1):** config-first collections + codegen, workspace tenancy + RLS,
  FTS+graph+vector search, `movp_events`/`movp_jobs` + `emit_event`, `@movp/notifications`
  (Resend), `pg_cron`, the Astro/CF+R2 template.
- **Collaboration (Phase 2):** polymorphic `comment`/`mention`/`reaction`/`saved_item`/
  `share_link` attached via `(entity_type='task', entity_id)` + edges, and the **Inbox**
  aggregation into which `task_assignment` feeds **Assigned Items**. Task defines **no** social
  primitives of its own.
- **No new infrastructure** — every event, job, notification, and search path reuses Core.

## Verification sketch

1. **Create/assign/observe.** Create a task → `task.created` in `movp_events` + a `notify`
   job. Add a `task_assignment` → `task.assigned` to that assignee; add a `task_observer` →
   `task.observer_added`. Assigning a **non-member** is rejected by RLS.
2. **Versioning.** Edit description → new `task_revision` + repointed `current_revision` +
   re-embed of the current revision only. Re-save identical content → **no** new revision, no
   re-embed (hash idempotency). History lists both edits in order.
3. **Status lifecycle.** Backlog→In Progress → `task.status_changed` + one
   `task_status_history` row. →Done → `task.completed` (not status_changed), `completed_at`
   set. →In Progress → `task.reopened`, `completed_at` cleared. Custom-labeled statuses behave
   identically (keyed on `category`).
4. **Dependencies.** Add `task_dependency` where the blocker is not done → `dependency_blocked
   = true` + `task.dependency_blocked`. Complete the blocker → recompute clears the flag. A
   self- or cycle-creating dependency is rejected.
5. **Due-soon.** `emit_due_soon()` (or the cron) emits `task.due_soon` + notify for a task
   inside the window; running it twice does **not** double-notify (idempotency key).
6. **RLS/immutability/config.** A non-member sees 0 rows on every collection; a non-admin
   cannot insert/update `task_status_option`/`task_priority_option`; `UPDATE`/`DELETE` on
   `task_revision`/`task_status_history` are denied.
7. **Surfaces.** GraphQL/MCP/CLI CRUD + search return the task; the board renders columns from
   `task_status_option`; the Discussion tab renders Collaboration comments; the Inbox
   **Assigned Items** tab lists my assignments.

## When built

Expands into a bite-sized TDD implementation series (like the Phase 1 Core plans) when
scheduled: config-first collections + seeding, versioning/revision pointer, the status/
dependency/due-soon triggers wired to `emit_event`, task-event recipient resolution in the
`flows` worker, RLS specifics (admin-only config, append-only, member-checked user refs), and
the list/detail/board/discussion frontend. Sits after **Collaboration (Phase 2)** — whose
primitives it consumes — and before **CMS (Phase 4)**, which graph-links deliverables to tasks.
