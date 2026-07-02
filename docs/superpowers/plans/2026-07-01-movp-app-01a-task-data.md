# MOVP App — Task Management Phase 3, Part A: Data Model, Config & Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the nine task-management collections — two config/reference tables (`task_status_option`, `task_priority_option`) and seven internal task tables (`task`, `task_revision`, `task_assignment`, `task_observer`, `task_dependency`, `task_status_history`, `task_attachment`) — to the config-first schema so codegen emits their base tables + generated types, then hand-author migration `20260701000008_task.sql` for the parts codegen cannot express: the circular `task ↔ task_revision` back-FK, composite uniques + guards + hot-path indexes, the `public.can_access_entity()` `'task'` arm, hardened RLS overrides on the append-only/immutable/membership-gated tables, and the per-workspace default-option seeding trigger.

**Architecture:** Collections are defined in `packages/core-schema/src/collections/`, wired into `defineSchema()` (`schema.ts`) and re-exported (`index.ts`). Running `pnpm codegen` regenerates BOTH `supabase/migrations/20260701000002_movp_generated.sql` (base tables, the blanket `<name>_rw` `is_workspace_member` RLS policy, grants, FTS for searchable fields, `<name>_delete_chunks` triggers, metadata registry rows) AND `packages/domain/src/generated/types.ts` (`Task*`, `TaskStatusOption*`, `TaskPriorityOption*`, … `*Row/*Create/*Update` — **consumed by Part B**). User references are plain `f.uuid` columns (never `relation('user')`). Relations emit `<fieldkey>_id` FK columns: `task.status`→`status_id` (required → `not null … on delete cascade`), `task.priority`→`priority_id`, `task.parent`→`parent_id` (optional self-FK → `on delete set null`), and every child's `task`→`task_id` (required → cascade). `task.current_revision_id` is a **plain `f.uuid`** (NOT a relation) because `task → task_revision → task` is circular and codegen cannot inline it; its FK is hand-added in `20260701000008_task.sql`. Everything codegen cannot emit lives in the hand-authored `20260701000008_task.sql`, which sorts AFTER `20260701000007_collaboration_rpcs.sql`: the back-FK, uniques/guards/indexes, a re-declared `public.can_access_entity()` (the 000006 body copied verbatim with a `'task'` branch added before the `else`), the RLS overrides on `task_revision`/`task_status_history`/`task_assignment`/`task_observer`, and a hardened `SECURITY DEFINER` AFTER-INSERT trigger on `public.workspace` that seeds each new workspace with a starter set of status/priority options.

**Tech Stack:** TypeScript (`@movp/core-schema`, `@movp/codegen`), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres RLS + `SECURITY DEFINER`, the existing `public.workspace` / `public.workspace_membership` / `public.is_workspace_member(uuid)` tenancy backbone.

**This is Part A of the Phase 3 (Task Management) series.** It depends on: bootstrap tenancy (`public.workspace`, `public.workspace_membership`, `public.is_workspace_member(uuid)` — `20260701000001`); the codegen pipeline + `public.note` (`20260701000002`); and the Collaboration phase, which committed `public.can_access_entity(text, uuid, uuid)` (in `20260701000006_collaboration.sql`) and added the `internal?: boolean` flag to `CollectionDef`. **Part B** (services/resolvers/UI, dependency-recompute, due-soon notifier) consumes the generated `Task*` types, the `can_access_entity('task', …)` gate, and the seeded options — do not rename a field, constraint, or option label without updating Part B.

## Global Constraints

- **Config-first collections.** New tables are added by defining a collection and running `pnpm codegen` — never by hand-writing a `create table` in a migration. The generated `20260701000002_movp_generated.sql` is a build artifact; commit it, never edit it by hand.
- **`pnpm codegen` is reproducible and committed.** After changing collections, run `pnpm codegen`, commit the regenerated migration AND `packages/domain/src/generated/types.ts`. Re-running codegen must produce no diff (`git diff --exit-code` on both files is clean). CI's migration-drift job (`supabase db reset` → `supabase db diff` empty) fails if the committed migration is stale.
- **Every field needs a `label`.** `defineCollection` throws if any field omits `label` or if an enum has empty `values`; `pnpm codegen` imports the schema and therefore fails loudly on a malformed collection. User references are `f.uuid`, never `relation('user')`.
- **The `internal` flag already exists.** `internal?: boolean` was added to `CollectionDef` in the Collaboration phase. Part A only SETS it (`internal: true`) on the seven task tables; it does NOT re-add the flag. `task_status_option` and `task_priority_option` are NOT internal (they are user-facing reference data with a generic CRUD surface).
- **`internal` is codegen-transparent.** `emit-sql`/`emit-types` ignore `internal`, so the base tables, blanket `<name>_rw` RLS, grants, and the `*Row/*Create/*Update` types Part B consumes are emitted for the internal task tables exactly as for a non-internal one. The flag only tells the generic GraphQL/MCP/CLI surface builders (implemented in Part B) to SKIP the collection, because its FK relations and bespoke atomic writes (revision/status transitions, dependency recompute) cannot go through the generic surface.
- **Collection order encodes FK dependencies.** `task_status_option`/`task_priority_option` MUST precede `task` (`task.status_id`/`priority_id` reference them). `task` MUST precede every `task_*` child (`task_id` → `task`). `task.parent_id` and `task_dependency.blocker_id` are same-statement / already-created self-references. `task.current_revision_id` is a PLAIN uuid, so `task` need NOT precede `task_revision` at codegen time — the circular FK is hand-added in `000008`.
- **Hand-authored migration for the rest.** `20260701000008_task.sql` (sorts after `000007`) holds the back-FK, uniques/guards, indexes, the `can_access_entity` `'task'` arm, RLS overrides, and the seed trigger — in that top-to-bottom order (policies reference the function defined above them; the trigger references tables created above it).
- **All `SECURITY DEFINER` functions hardened:** `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon` (and `authenticated` for trigger fns). The definer-audit gate (`node scripts/check-definer-audit.mjs`) fails any `security definer` function missing a pinned `search_path`.
- **Authoritative authz at the data boundary.** RLS is the gate. The authoritative visibility check is `public.can_access_entity('task', task_id, workspace_id)`, resolved server-side; membership-gated policies use `public.is_workspace_member(workspace_id)`; owner checks use `(select auth.uid())`.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  packages/
    core-schema/src/
      collections/
        task_status_option.ts    # NEW (NOT internal)
        task_priority_option.ts   # NEW (NOT internal)
        task.ts                   # NEW (internal: true)
        task_revision.ts          # NEW (internal: true)
        task_assignment.ts        # NEW (internal: true)
        task_observer.ts          # NEW (internal: true)
        task_dependency.ts        # NEW (internal: true)
        task_status_history.ts    # NEW (internal: true)
        task_attachment.ts        # NEW (internal: true)
      schema.ts                   # EDIT: append the nine collections to defineSchema([...])
      index.ts                    # EDIT: re-export the nine collections
    domain/src/generated/
      types.ts                    # REGENERATED by `pnpm codegen` (commit)
  supabase/
    migrations/
      20260701000002_movp_generated.sql   # REGENERATED by `pnpm codegen` (commit)
      20260701000008_task.sql              # NEW hand-authored (built up across Tasks 2–5)
    tests/
      task_test.sql                        # NEW pgTAP (built up across Tasks 2–5)
      collaboration_test.sql               # EDIT (Task 3): task seed + two 'task' assertions
```

---

### Task 1: Define the nine task collections + regenerate

**Files:**
- Create: `packages/core-schema/src/collections/task_status_option.ts`, `task_priority_option.ts`, `task.ts`, `task_revision.ts`, `task_assignment.ts`, `task_observer.ts`, `task_dependency.ts`, `task_status_history.ts`, `task_attachment.ts`
- Edit: `packages/core-schema/src/schema.ts`, `packages/core-schema/src/index.ts`
- Regenerate (do NOT hand-edit): `supabase/migrations/20260701000002_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `f` + `defineCollection` (`packages/core-schema/src/builders.ts`, `define.ts`); the existing `note`/`tag`/collaboration collections; `CollectionDef.internal` (already present from the Collaboration phase).
- Produces (Part B consumes): base tables `public.{task_status_option,task_priority_option,task,task_revision,task_assignment,task_observer,task_dependency,task_status_history,task_attachment}` with blanket `<name>_rw` RLS + grants, and generated types `TaskStatusOption*`, `TaskPriorityOption*`, `Task*`, `TaskRevision*`, `TaskAssignment*`, `TaskObserver*`, `TaskDependency*`, `TaskStatusHistory*`, `TaskAttachment*`.

This task is config + codegen; its gates are `pnpm codegen` succeeding, a clean `supabase db reset`/`db diff`, `pnpm typecheck`, and greps proving the nine tables + 27 interfaces were emitted (including that the seven `internal: true` tables were emitted — the flag suppresses no SQL).

- [ ] **Step 1: Create the two reference-option collections (NOT internal)**

`packages/core-schema/src/collections/task_status_option.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskStatusOption = defineCollection({
  name: 'task_status_option',
  label: 'Task Status Option',
  labelPlural: 'Task Status Options',
  workspaceScoped: true,
  fields: {
    label: f.text({ label: 'Label', required: true }),
    category: f.enum(['backlog', 'active', 'blocked', 'done'], {
      label: 'Category',
      required: true,
      reporting: { role: 'dimension' },
    }),
    color: f.text({ label: 'Color' }),
    sort_order: f.number({ label: 'Sort Order' }),
    is_default: f.boolean({ label: 'Is Default' }),
    is_active: f.boolean({ label: 'Is Active' }),
  },
})
```

`packages/core-schema/src/collections/task_priority_option.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskPriorityOption = defineCollection({
  name: 'task_priority_option',
  label: 'Task Priority Option',
  labelPlural: 'Task Priority Options',
  workspaceScoped: true,
  fields: {
    label: f.text({ label: 'Label', required: true }),
    rank: f.number({ label: 'Rank', required: true }),
    color: f.text({ label: 'Color' }),
    is_default: f.boolean({ label: 'Is Default' }),
    is_active: f.boolean({ label: 'Is Active' }),
  },
})
```

- [ ] **Step 2: Create the `task` collection (internal)**

`packages/core-schema/src/collections/task.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const task = defineCollection({
  name: 'task',
  label: 'Task',
  labelPlural: 'Tasks',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    // Required relations -> `status_id`/`priority_id uuid not null references ... on delete cascade`.
    status: f.relation('task_status_option', { label: 'Status', cardinality: 'many-to-one', required: true }),
    priority: f.relation('task_priority_option', { label: 'Priority', cardinality: 'many-to-one', required: true }),
    // Optional self-FK -> `parent_id uuid references public.task(id) on delete set null`.
    parent: f.relation('task', { label: 'Parent Task', cardinality: 'many-to-one' }),
    start_date: f.date({ label: 'Start Date' }),
    due_date: f.date({ label: 'Due Date' }),
    // PLAIN uuid, NOT a relation: task <-> task_revision is a circular FK, so codegen
    // cannot inline it. The FK `task_current_revision_fk` is hand-added in
    // 20260701000008_task.sql. Emits `current_revision_id uuid` (nullable, no FK here).
    current_revision_id: f.uuid({ label: 'Current Revision' }),
    dependency_blocked: f.boolean({ label: 'Dependency Blocked' }),
    completed_at: f.datetime({ label: 'Completed At' }),
    due_soon_notified_at: f.datetime({ label: 'Due Soon Notified At' }),
  },
})
```

- [ ] **Step 3: Create the seven remaining internal child collections**

`packages/core-schema/src/collections/task_revision.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskRevision = defineCollection({
  name: 'task_revision',
  label: 'Task Revision',
  labelPlural: 'Task Revisions',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    // Required relation -> `task_id uuid not null references public.task(id) on delete cascade`.
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true, embeddable: true }),
    content_hash: f.text({ label: 'Content Hash', required: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
  },
})
```

`packages/core-schema/src/collections/task_assignment.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskAssignment = defineCollection({
  name: 'task_assignment',
  label: 'Task Assignment',
  labelPlural: 'Task Assignments',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    assignee_user_id: f.uuid({ label: 'Assignee', required: true }),
    role: f.enum(['owner'], { label: 'Role', default: 'owner' }),
  },
})
```

`packages/core-schema/src/collections/task_observer.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskObserver = defineCollection({
  name: 'task_observer',
  label: 'Task Observer',
  labelPlural: 'Task Observers',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    observer_user_id: f.uuid({ label: 'Observer', required: true }),
  },
})
```

`packages/core-schema/src/collections/task_dependency.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskDependency = defineCollection({
  name: 'task_dependency',
  label: 'Task Dependency',
  labelPlural: 'Task Dependencies',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    // Both are required self-relations -> `task_id`/`blocker_id uuid not null references public.task(id) on delete cascade`.
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    blocker: f.relation('task', { label: 'Blocker', cardinality: 'many-to-one', required: true }),
  },
})
```

`packages/core-schema/src/collections/task_status_history.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskStatusHistory = defineCollection({
  name: 'task_status_history',
  label: 'Task Status History',
  labelPlural: 'Task Status History',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    from_status_id: f.uuid({ label: 'From Status' }),
    to_status_id: f.uuid({ label: 'To Status', required: true }),
    changed_by: f.uuid({ label: 'Changed By', required: true }),
  },
})
```

`packages/core-schema/src/collections/task_attachment.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskAttachment = defineCollection({
  name: 'task_attachment',
  label: 'Task Attachment',
  labelPlural: 'Task Attachments',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    r2_key: f.text({ label: 'R2 Key', required: true }),
    filename: f.text({ label: 'Filename', required: true }),
    content_type: f.text({ label: 'Content Type' }),
    bytes: f.number({ label: 'Bytes' }),
    uploaded_by: f.uuid({ label: 'Uploaded By', required: true }),
  },
})
```

- [ ] **Step 4: Wire the collections into the schema**

Replace `packages/core-schema/src/schema.ts` entirely with:
```ts
import { comment } from './collections/comment.ts'
import { mention } from './collections/mention.ts'
import { note } from './collections/note.ts'
import { reaction } from './collections/reaction.ts'
import { savedItem } from './collections/saved_item.ts'
import { shareLink } from './collections/share_link.ts'
import { tag } from './collections/tag.ts'
import { task } from './collections/task.ts'
import { taskAssignment } from './collections/task_assignment.ts'
import { taskAttachment } from './collections/task_attachment.ts'
import { taskDependency } from './collections/task_dependency.ts'
import { taskObserver } from './collections/task_observer.ts'
import { taskPriorityOption } from './collections/task_priority_option.ts'
import { taskRevision } from './collections/task_revision.ts'
import { taskStatusHistory } from './collections/task_status_history.ts'
import { taskStatusOption } from './collections/task_status_option.ts'
import { defineSchema } from './define.ts'

// Order encodes FK dependencies:
//  - task_status_option / task_priority_option precede `task` (task.status_id/priority_id -> them).
//  - `task` precedes every task_* child (child.task_id -> task) and its own parent_id / blocker_id.
//  - task.current_revision_id is a PLAIN uuid, so `task` need NOT precede task_revision at
//    codegen time; the circular FK is hand-added in 20260701000008_task.sql.
export const schema = defineSchema([
  note,
  tag,
  comment,
  reaction,
  savedItem,
  mention,
  shareLink,
  taskStatusOption,
  taskPriorityOption,
  task,
  taskRevision,
  taskAssignment,
  taskObserver,
  taskDependency,
  taskStatusHistory,
  taskAttachment,
])
```

Replace `packages/core-schema/src/index.ts` entirely with:
```ts
export type {
  Cardinality,
  CollectionDef,
  FieldDef,
  FieldType,
  MovpSchema,
  ReportingRole,
} from './types.ts'
export { f, type FieldOptions } from './builders.ts'
export { defineCollection, defineSchema } from './define.ts'
export { comment } from './collections/comment.ts'
export { mention } from './collections/mention.ts'
export { note } from './collections/note.ts'
export { reaction } from './collections/reaction.ts'
export { savedItem } from './collections/saved_item.ts'
export { shareLink } from './collections/share_link.ts'
export { tag } from './collections/tag.ts'
export { task } from './collections/task.ts'
export { taskAssignment } from './collections/task_assignment.ts'
export { taskAttachment } from './collections/task_attachment.ts'
export { taskDependency } from './collections/task_dependency.ts'
export { taskObserver } from './collections/task_observer.ts'
export { taskPriorityOption } from './collections/task_priority_option.ts'
export { taskRevision } from './collections/task_revision.ts'
export { taskStatusHistory } from './collections/task_status_history.ts'
export { taskStatusOption } from './collections/task_status_option.ts'
export { schema } from './schema.ts'
```

- [ ] **Step 5: Regenerate**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints `wrote .../supabase/migrations/20260701000002_movp_generated.sql` and `wrote .../packages/domain/src/generated/types.ts`, exit 0. (A missing `label` or empty enum `values` makes `defineCollection` throw here — fix the collection and re-run.)

`packages/domain/src/generated/types.ts` will now contain the interfaces below (codegen output — **verify, do NOT hand-edit; Part B imports these**). Column ORDER is `id`, `workspace_id`, then data fields in definition order, then FK `_id` columns in definition order, then `created_at`, `updated_at` (the same `dataFields`-then-`fkFields` ordering the Collaboration types use). Nullability is `required || default` → non-null, else nullable. Scalar TS types (e.g. whether `numeric` maps to `number` or `string`) are whatever `emit-types.ts` produces — the committed file is authoritative; the shapes below are load-bearing only for the FK `_id` column NAMES and their nullability:
```ts
export interface TaskStatusOptionRow {
  id: string
  workspace_id: string
  label: string
  category: 'backlog' | 'active' | 'blocked' | 'done'
  color: string | null
  sort_order: number | null
  is_default: boolean | null
  is_active: boolean | null
  created_at: string
  updated_at: string
}

export interface TaskPriorityOptionRow {
  id: string
  workspace_id: string
  label: string
  rank: number
  color: string | null
  is_default: boolean | null
  is_active: boolean | null
  created_at: string
  updated_at: string
}

export interface TaskRow {
  id: string
  workspace_id: string
  title: string
  start_date: string | null
  due_date: string | null
  current_revision_id: string | null   // plain uuid; FK added in 000008
  dependency_blocked: boolean | null
  completed_at: string | null
  due_soon_notified_at: string | null
  status_id: string                     // FK -> task_status_option (required)
  priority_id: string                   // FK -> task_priority_option (required)
  parent_id: string | null              // self-FK (optional)
  created_at: string
  updated_at: string
}

export interface TaskRevisionRow {
  id: string
  workspace_id: string
  body: string
  content_hash: string
  author_id: string
  task_id: string                       // FK -> task (required)
  created_at: string
  updated_at: string
}

export interface TaskAssignmentRow {
  id: string
  workspace_id: string
  assignee_user_id: string
  role: 'owner'
  task_id: string
  created_at: string
  updated_at: string
}

export interface TaskObserverRow {
  id: string
  workspace_id: string
  observer_user_id: string
  task_id: string
  created_at: string
  updated_at: string
}

export interface TaskDependencyRow {
  id: string
  workspace_id: string
  task_id: string                       // FK -> task
  blocker_id: string                    // FK -> task
  created_at: string
  updated_at: string
}

export interface TaskStatusHistoryRow {
  id: string
  workspace_id: string
  from_status_id: string | null
  to_status_id: string
  changed_by: string
  task_id: string
  created_at: string
  updated_at: string
}

export interface TaskAttachmentRow {
  id: string
  workspace_id: string
  r2_key: string
  filename: string
  content_type: string | null
  bytes: number | null
  uploaded_by: string
  task_id: string
  created_at: string
  updated_at: string
}
// Codegen also emits a *Create and *Update interface per collection (27 interfaces total).
```

- [ ] **Step 6: Apply + drift check + typecheck**

Run:
```bash
supabase db reset && supabase db diff && pnpm typecheck
```
Expected: `db reset` applies the regenerated migration cleanly (the nine tables + blanket `<name>_rw` policies are created); `supabase db diff` prints **nothing** (no drift); `pnpm typecheck` PASSES.

- [ ] **Step 7: Machine-checkable gate — tables + types emitted (internal is codegen-transparent), codegen reproducible**

Run:
```bash
cd /Users/ensell/Code/supasuite
grep -cE 'create table if not exists public\.(task|task_status_option|task_priority_option|task_revision|task_assignment|task_observer|task_dependency|task_status_history|task_attachment) \(' \
  supabase/migrations/20260701000002_movp_generated.sql
grep -cE 'interface (Task|TaskStatusOption|TaskPriorityOption|TaskRevision|TaskAssignment|TaskObserver|TaskDependency|TaskStatusHistory|TaskAttachment)(Row|Create|Update)' \
  packages/domain/src/generated/types.ts
grep -cE '(status_id|priority_id|parent_id|current_revision_id)' packages/domain/src/generated/types.ts
pnpm codegen && git diff --exit-code \
  supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
```
Expected: first grep prints `9` (all nine tables emitted, INCLUDING the seven `internal: true` ones — the flag suppresses no SQL); second grep prints `27` (9 collections × Row/Create/Update); third grep is `>= 4` (the FK `_id` columns and the plain `current_revision_id` are present); the `git diff --exit-code` exits `0` (re-running codegen changed nothing — reproducible).

- [ ] **Step 8: Commit**

```bash
git add packages/core-schema/src supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
git commit -m "feat(schema): add task-management collections (task + options + revision/assignment/observer/dependency/history/attachment)"
```

---

### Task 2: Migration `000008` part 1 — back-FK, uniques/guards, indexes + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000008_task.sql`
- Create: `supabase/tests/task_test.sql`

**Interfaces:**
- Consumes: the nine generated tables from Task 1; `public.task_revision(id)` (for the back-FK).
- Produces: `task_current_revision_fk`; uniques `task_assignment_uniq`, `task_observer_uniq`, `task_dependency_uniq`, `task_revision_content_uniq`; check `task_dependency_no_self`; partial unique indexes `task_status_option_default_uniq`, `task_priority_option_default_uniq`; indexes `task_ws_status_idx`, `task_parent_idx`, `task_due_open_idx`, `task_assignment_assignee_idx`, `task_dependency_blocker_idx`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/task_test.sql` (this file grows in Tasks 3–5; `plan(N)` is bumped each time). The base seed at the top runs as the table owner (RLS bypassed); it seeds W1 with members A (owner) and C (member), B is NOT a member. Options are seeded with `is_default = false` so they never collide with the per-workspace default-option trigger added in Task 5 (that trigger seeds exactly one `is_default = true` row per option table per workspace, and the partial unique index allows only one):
```sql
begin;
select plan(24);

-- ── base seed (as table owner; RLS bypassed) ────────────────────────────────
-- W1 members: A (owner), C (member). B is NOT a member of W1. W2 has no seeded members.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- Manual options: is_default=false so they never collide with the Task 5 seed trigger.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('50000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Seed Status', 'active', 10, false, true);
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active) values
  ('60000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Seed Priority', 5, false, true);

-- Seed task T1 in W1 (references the manual options).
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('70000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'T1',
   '50000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001');

-- ── Task 2: structural — tables, back-FK, uniques/guards, indexes ───────────
select has_table('public', 'task',                'task table exists');
select has_table('public', 'task_status_option',  'task_status_option table exists');
select has_table('public', 'task_priority_option','task_priority_option table exists');
select has_table('public', 'task_revision',       'task_revision table exists');
select has_table('public', 'task_assignment',     'task_assignment table exists');
select has_table('public', 'task_observer',       'task_observer table exists');
select has_table('public', 'task_dependency',     'task_dependency table exists');
select has_table('public', 'task_status_history', 'task_status_history table exists');
select has_table('public', 'task_attachment',     'task_attachment table exists');

select is((select count(*)::int from pg_constraint where conname='task_current_revision_fk' and contype='f'),
          1, 'task.current_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='task_assignment_uniq' and contype='u'),
          1, 'task_assignment (task_id, assignee_user_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_observer_uniq' and contype='u'),
          1, 'task_observer (task_id, observer_user_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_dependency_uniq' and contype='u'),
          1, 'task_dependency (task_id, blocker_id) unique');
select is((select count(*)::int from pg_constraint where conname='task_dependency_no_self' and contype='c'),
          1, 'task_dependency (task_id <> blocker_id) check');
select is((select count(*)::int from pg_constraint where conname='task_revision_content_uniq' and contype='u'),
          1, 'task_revision (task_id, content_hash) unique');

select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_status_option_default_uniq'),
          1, 'one-default-status partial unique index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_priority_option_default_uniq'),
          1, 'one-default-priority partial unique index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_ws_status_idx'),
          1, 'task (workspace_id, status_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_parent_idx'),
          1, 'task (parent_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_due_open_idx'),
          1, 'task (due_date) where completed_at is null index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_assignment_assignee_idx'),
          1, 'task_assignment (assignee_user_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='task_dependency_blocker_idx'),
          1, 'task_dependency (blocker_id) index exists');

-- Behavioral: the self-dependency check fires (constraints apply even to the owner; only RLS is bypassed).
select throws_ok(
  $$insert into public.task_dependency (workspace_id, task_id, blocker_id)
    values ('11111111-1111-1111-1111-111111111111',
            '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001')$$,
  '23514', NULL, 'a task cannot depend on itself (check constraint)');

-- Behavioral: the composite unique on task_assignment fires. The first insert is wrapped
-- in a savepoint and rolled back so no row leaks into later tasks' assertions.
savepoint sp_dup;
insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'dddddddd-dddd-dddd-dddd-dddddddddddd');
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'dddddddd-dddd-dddd-dddd-dddddddddddd')$$,
  '23505', NULL, 'duplicate (task_id, assignee_user_id) rejected');
rollback to savepoint sp_dup;

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `task_test.sql` fails the back-FK, unique/check, and index assertions (none exist yet), and both `throws_ok` behavioral assertions fail (the inserts succeed instead of throwing). The `has_table` assertions pass (Task 1 created the tables). All other test files (`collaboration_test.sql`, `generated_schema_test.sql`, `tenancy_test.sql`, `internal_access_test.sql`, `collaboration_rpcs_test.sql`) still pass. **The seed itself must apply cleanly** — if the base seed errors, the table/column names are wrong; fix before proceeding.

- [ ] **Step 3: Create the migration with part 1**

Create `supabase/migrations/20260701000008_task.sql` (exact path — do NOT use `supabase migration new`, which mints a wall-clock timestamp; this filename must sort right after `20260701000007_collaboration_rpcs.sql`):
```sql
-- Task Management Phase 3 — Part A. Sorts AFTER 20260701000007_collaboration_rpcs.sql.
-- Hand-authored: the circular task<->task_revision back-FK, uniques/guards + hot-path
-- indexes codegen cannot emit, the can_access_entity 'task' arm, hardened RLS overrides,
-- and the per-workspace default-option seeding trigger.

-- ── back-FK codegen cannot inline (task <-> task_revision is circular) ────────
alter table public.task
  add constraint task_current_revision_fk
  foreign key (current_revision_id) references public.task_revision(id) on delete set null;

-- ── composite uniques + guards codegen cannot emit ───────────────────────────
alter table public.task_assignment
  add constraint task_assignment_uniq unique (task_id, assignee_user_id);
alter table public.task_observer
  add constraint task_observer_uniq unique (task_id, observer_user_id);
alter table public.task_dependency
  add constraint task_dependency_uniq unique (task_id, blocker_id);
alter table public.task_dependency
  add constraint task_dependency_no_self check (task_id <> blocker_id);
alter table public.task_revision
  add constraint task_revision_content_uniq unique (task_id, content_hash);

-- One default status option and one default priority option per workspace
-- (partial unique index: NULL / false is_default rows are excluded from the index).
create unique index task_status_option_default_uniq
  on public.task_status_option (workspace_id) where is_default;
create unique index task_priority_option_default_uniq
  on public.task_priority_option (workspace_id) where is_default;

-- ── hot-path indexes ─────────────────────────────────────────────────────────
create index task_ws_status_idx           on public.task            (workspace_id, status_id);
create index task_parent_idx              on public.task            (parent_id);
create index task_due_open_idx            on public.task            (due_date) where completed_at is null;
create index task_assignment_assignee_idx on public.task_assignment (assignee_user_id);
create index task_dependency_blocker_idx  on public.task_dependency (blocker_id);
```

- [ ] **Step 4: Apply + test + drift check**

Run:
```bash
supabase db reset && supabase test db && supabase db diff
```
Expected: migration applies; `task_test.sql .. ok` (all 24 assertions pass); every other test file still `ok`; `supabase db diff` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000008_task.sql supabase/tests/task_test.sql
git commit -m "feat(db): task back-FK, uniques/guards, and hot-path indexes"
```

---

### Task 3: `public.can_access_entity` `'task'` arm + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000008_task.sql` (append part 2)
- Edit: `supabase/tests/task_test.sql` (add can_access assertions)
- Edit: `supabase/tests/collaboration_test.sql` (task seed + retarget the two `'task'` assertions)

**Interfaces:**
- Consumes: `public.is_workspace_member(uuid)` (from `000001`), `public.note`/`public.comment` (existing arms), `public.task`.
- Produces: a re-declared `public.can_access_entity(text, uuid, uuid)` with a `'task'` branch. **Invariant:** the `'note'` and `'comment'` arms and the fail-closed `else` are preserved byte-for-byte from `000006` — only the new `'task'` branch is inserted before the `else`. `execute` stays granted to `authenticated` only.

- [ ] **Step 1: Update `collaboration_test.sql` (red)**

In `supabase/tests/collaboration_test.sql`, in the shared seed block (after the `insert into public.note ...` statement, still as the table owner), add a task in W1 whose id matches the id the two existing `'task'` assertions already probe (`99999999-9999-9999-9999-999999999999`):
```sql
-- Task-subsystem seed so can_access_entity('task', ...) resolves against a real row.
-- Options use is_default=false so they never collide with the per-workspace default-option
-- trigger (20260701000008): that trigger seeds one is_default=true row per option table per
-- workspace, and the partial unique index allows only one.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active)
  values ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1','11111111-1111-1111-1111-111111111111','Seed Status','backlog',10,false,true);
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active)
  values ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1','11111111-1111-1111-1111-111111111111','Seed Priority',5,false,true);
insert into public.task (id, workspace_id, title, status_id, priority_id)
  values ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','Seed Task',
          'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1','b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1');
```
> The workspace id `11111111-1111-1111-1111-111111111111` is exactly the W1 id already used throughout `collaboration_test.sql`; reuse that literal.

Then retarget the two existing `'task'` assertions. Find:
```sql
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed) even for a member');
```
and change the expected value and message to:
```sql
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          true, 'member + task in ws -> true (task arm resolves against public.task)');
```
Then find:
```sql
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed), non-member');
```
and change only the message (value stays `false`):
```sql
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false (task arm), even for an existing task');
```
Leave `select plan(33);` unchanged — two assertions are modified in place, none added.

- [ ] **Step 2: Extend `task_test.sql` (red)**

In `supabase/tests/task_test.sql`: change `select plan(24);` to `select plan(27);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 3: can_access_entity('task', ...) (act as member A of W1) ───────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('task','70000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111'),
          true,  'member + task in ws -> true');
select is(public.can_access_entity('task','7fffffff-ffff-ffff-ffff-ffffffffffff','11111111-1111-1111-1111-111111111111'),
          false, 'member + absent task -> false');
-- act as non-member B (not in W1)
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('task','70000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false (base gate) even for an existing task');
```

Run: `supabase test db`
Expected: FAIL — in `task_test.sql`, `can_access_entity('task', T1, W1)` returns `false` (the `'task'` arm hits the fail-closed `else` in the 000006 function) but the assertion expects `true`; in `collaboration_test.sql` the retargeted member assertion likewise expects `true` and gets `false`. The earlier assertions in both files still pass.

- [ ] **Step 3: Append the `'task'` arm to the migration (green)**

Append to `supabase/migrations/20260701000008_task.sql`. This is the `20260701000006_collaboration.sql` body copied VERBATIM with a single `'task'` branch added before the `else` — the `'note'`/`'comment'` arms and the fail-closed `else` are unchanged:
```sql
-- ── can_access_entity: add the 'task' arm (re-declares the full function) ────
-- Verbatim copy of the 20260701000006 body with a 'task' branch added before the
-- else. SECURITY DEFINER so the existence probe bypasses RLS; empty search_path;
-- params qualified with the function name to avoid collisions with same-named columns.
create or replace function public.can_access_entity(entity_type text, entity_id uuid, ws uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  -- Base gate: the caller must be a member of the workspace.
  if not public.is_workspace_member(ws) then
    return false;
  end if;

  -- Per-entity_type dispatch. Extension seam: future app phases add explicit
  -- arms before their collaboration surfaces go live.
  case entity_type
    when 'note' then
      select exists (
        select 1 from public.note n
        where n.id = can_access_entity.entity_id
          and n.workspace_id = can_access_entity.ws
      ) into v_exists;
    when 'comment' then
      select exists (
        select 1 from public.comment c
        where c.id = can_access_entity.entity_id
          and c.workspace_id = can_access_entity.ws
      ) into v_exists;
    when 'task' then
      select exists (
        select 1 from public.task t
        where t.id = can_access_entity.entity_id
          and t.workspace_id = can_access_entity.ws
      ) into v_exists;
    else
      -- Unknown entity_type: fail closed.
      return false;
  end case;

  return v_exists;
end;
$$;

revoke all on function public.can_access_entity(text, uuid, uuid) from public, anon;
grant execute on function public.can_access_entity(text, uuid, uuid) to authenticated;
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_test.sql .. ok` (27 assertions) AND `collaboration_test.sql .. ok` (33 assertions, the retargeted member assertion now returns `true`); every other file still `ok`; definer-audit prints `all definers pinned` (exit 0); `db diff` empty.

- [ ] **Step 5: Gate — the note/comment arms survived the re-declaration**

Run:
```bash
grep -cE "when '(note|comment|task)' then" supabase/migrations/20260701000008_task.sql
```
Expected: `3` (all three arms present — the re-declaration did not drop `'note'`/`'comment'`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000008_task.sql supabase/tests/task_test.sql supabase/tests/collaboration_test.sql
git commit -m "feat(db): can_access_entity 'task' arm"
```

---

### Task 4: Hardened RLS overrides + pgTAP matrix

**Files:**
- Edit: `supabase/migrations/20260701000008_task.sql` (append part 3)
- Edit: `supabase/tests/task_test.sql` (add RLS matrix)

**Interfaces:**
- Consumes: the generated `<name>_rw` policies (from `000002`), `public.is_workspace_member(uuid)`, `public.workspace_membership`.
- Produces: per-verb RLS policies on `task_revision`, `task_status_history`, `task_assignment`, `task_observer`, `task_dependency`, `task_attachment`, `task_status_option`, `task_priority_option`. **Invariants:** (1) ONLY `public.task` keeps its generated `task_rw` `is_workspace_member` blanket policy (NOT dropped). (2) `task_revision` and `task_status_history` are SELECT + INSERT only (no UPDATE/DELETE policy → immutable / append-only). (3) `task_assignment`/`task_observer` INSERT requires the target user to be a workspace member AND `can_access_entity('task', task_id, workspace_id)` (the task lives in the submitted workspace — no cross-tenant child rows); each also has a SELECT and a **DELETE** policy (`is_workspace_member`) so the service's `unassign`/`removeObserver` are not silent no-ops. (4) `task_dependency` gets SELECT/INSERT/DELETE (previously left on its blanket policy); INSERT requires `can_access_entity('task', …)` on BOTH `task_id` and `blocker_id`. (5) `task_attachment` INSERT requires `can_access_entity('task', task_id, workspace_id)` AND `uploaded_by = auth.uid()` (no forged uploader); DELETE requires being the uploader. (6) `task_status_option`/`task_priority_option` are SELECT + INSERT + UPDATE only (NO DELETE — a required-FK `on delete cascade` would delete tasks; removal is `is_active = false`).

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_test.sql`: change `select plan(27);` to `select plan(43);`, and insert this block immediately BEFORE the final `select * from finish();` (it continues in the `authenticated` role set by Task 3):
```sql
-- ── Task 4: RLS matrix (still role=authenticated) ───────────────────────────
-- member A assigns member C -> allowed
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'cccccccc-cccc-cccc-cccc-cccccccccccc');
select is((select count(*)::int from public.task_assignment
           where task_id='70000000-0000-0000-0000-000000000001'
             and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'member can assign another member');
-- non-member B cannot assign into W1 (with-check requires is_workspace_member)
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501', NULL, 'a non-member cannot create assignments in the workspace');
-- member A cannot assign a NON-member (B): with-check requires the assignee to be a member
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$insert into public.task_assignment (workspace_id, task_id, assignee_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL, 'assigning a non-member is denied (assignee must be a workspace member)');

-- observer: member A adds member C -> allowed; adding non-member B -> denied
insert into public.task_observer (workspace_id, task_id, observer_user_id)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'cccccccc-cccc-cccc-cccc-cccccccccccc');
select is((select count(*)::int from public.task_observer
           where task_id='70000000-0000-0000-0000-000000000001'
             and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'member can add another member as observer');
select throws_ok(
  $$insert into public.task_observer (workspace_id, task_id, observer_user_id)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL, 'observing a non-member is denied (observer must be a workspace member)');

-- task_revision is IMMUTABLE: member A appends a revision, then an UPDATE is a no-op.
insert into public.task_revision (id, workspace_id, task_id, body, content_hash, author_id)
  values ('80000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '70000000-0000-0000-0000-000000000001','rev body','hash-1',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_revision where id='80000000-0000-0000-0000-000000000001'),
          1, 'member can append a task revision');
update public.task_revision set body='mutated' where id='80000000-0000-0000-0000-000000000001';
select is((select body from public.task_revision where id='80000000-0000-0000-0000-000000000001'),
          'rev body', 'task_revision is immutable (UPDATE is a no-op — no update policy)');

-- task_status_history is APPEND-ONLY: member A appends, then an UPDATE is a no-op.
insert into public.task_status_history (id, workspace_id, task_id, from_status_id, to_status_id, changed_by)
  values ('90000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '70000000-0000-0000-0000-000000000001', null,
          '50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_status_history where id='90000000-0000-0000-0000-000000000001'),
          1, 'member can append a status-history row');
update public.task_status_history set to_status_id='60000000-0000-0000-0000-000000000001'
  where id='90000000-0000-0000-0000-000000000001';
select is((select to_status_id from public.task_status_history where id='90000000-0000-0000-0000-000000000001'),
          '50000000-0000-0000-0000-000000000001', 'task_status_history is append-only (UPDATE is a no-op)');

-- task_attachment boundary: a member may attach to a task they can access, AS themselves.
insert into public.task_attachment (workspace_id, task_id, r2_key, filename, uploaded_by)
  values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
          'ws/att-1','a.pdf','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.task_attachment
           where task_id='70000000-0000-0000-0000-000000000001' and r2_key='ws/att-1'),
          1, 'a member can attach to an accessible task as themselves');
-- forging the uploader is denied (with-check requires uploaded_by = auth.uid()).
select throws_ok(
  $$insert into public.task_attachment (workspace_id, task_id, r2_key, filename, uploaded_by)
    values ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
            'ws/att-2','b.pdf','cccccccc-cccc-cccc-cccc-cccccccccccc')$$,
  '42501', NULL, 'a member cannot forge uploaded_by on an attachment');
-- a config option cannot be hard-DELETEd (status_id/priority_id cascade → would delete tasks);
-- DELETE matches zero rows (no DELETE policy) — removal is via is_active=false.
delete from public.task_status_option where id='50000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.task_status_option where id='50000000-0000-0000-0000-000000000001'),
          1, 'task_status_option cannot be hard-deleted (no DELETE policy; deactivate via is_active)');

-- unassign / removeObserver must ACTUALLY delete under the final RLS (the blanket policy
-- that allowed DELETE was dropped; a dedicated DELETE policy restores it — else the
-- service's remove ops match zero rows and silently no-op).
delete from public.task_assignment where task_id='70000000-0000-0000-0000-000000000001'
  and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';
select is((select count(*)::int from public.task_assignment
           where task_id='70000000-0000-0000-0000-000000000001'
             and assignee_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          0, 'a member can unassign (DELETE policy present, not a silent no-op)');
delete from public.task_observer where task_id='70000000-0000-0000-0000-000000000001'
  and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';
select is((select count(*)::int from public.task_observer
           where task_id='70000000-0000-0000-0000-000000000001'
             and observer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          0, 'a member can remove an observer (DELETE policy present)');

-- task_dependency: same-workspace add + remove. Member A seeds a 2nd task (task keeps its
-- blanket member RLS), then both tasks are in W1 so can_access_entity passes on both arms.
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('70000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','T2',
   '50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');
insert into public.task_dependency (workspace_id, task_id, blocker_id) values
  ('11111111-1111-1111-1111-111111111111','70000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.task_dependency
           where task_id='70000000-0000-0000-0000-000000000001'
             and blocker_id='70000000-0000-0000-0000-000000000002'),
          1, 'a member can add a same-workspace dependency (task_dependency override present)');
delete from public.task_dependency where task_id='70000000-0000-0000-0000-000000000001'
  and blocker_id='70000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.task_dependency
           where task_id='70000000-0000-0000-0000-000000000001'
             and blocker_id='70000000-0000-0000-0000-000000000002'),
          0, 'a member can remove a dependency (DELETE policy present)');
```

Run: `supabase test db`
Expected: FAIL — under the still-active generated `<name>_rw` blanket policies (every verb gated only on `is_workspace_member`), the tightening assertions mismatch: assigning/observing a non-member does NOT throw (the blanket INSERT policy has no assignee-membership check, so the `throws_ok`s fail); the `task_revision`/`task_status_history` UPDATEs SUCCEED (blanket policy permits UPDATE), so the immutability read-backs return the mutated value; the forged-`uploaded_by` attachment INSERT does NOT throw (blanket policy has no uploader check); and the `task_status_option` DELETE SUCCEEDS (blanket policy permits DELETE), so its read-back returns `0`. The positive assertions and the earlier 27 hold.

- [ ] **Step 2: Append the RLS overrides (green)**

Append to `supabase/migrations/20260701000008_task.sql`:
```sql
-- ── RLS overrides: tighten the internal task tables ──────────────────────────
-- KEEP the generated <name>_rw is_workspace_member policy (NOT dropped here) for:
--   public.task ONLY (members read/write workspace tasks through the blanket policy).
-- Every other task table below replaces its blanket policy with fine-grained per-verb rules.

-- task_revision: immutable. Members read and append; no UPDATE/DELETE policy exists,
-- so those verbs match zero rows (silent no-op) — a revision can never be altered.
drop policy if exists task_revision_rw on public.task_revision;
create policy task_revision_select on public.task_revision for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_revision_insert on public.task_revision for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

-- task_status_history: append-only audit trail. SELECT + INSERT only.
drop policy if exists task_status_history_rw on public.task_status_history;
create policy task_status_history_select on public.task_status_history for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_status_history_insert on public.task_status_history for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

-- task_assignment: a member may add an assignment, but ONLY (a) targeting a user who is
-- themselves a workspace member, and (b) onto a task that lives in the SAME workspace
-- (tenant consistency — the FK alone does not check task.workspace_id == the row's ws).
drop policy if exists task_assignment_rw on public.task_assignment;
create policy task_assignment_select on public.task_assignment for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_assignment_insert on public.task_assignment for insert to authenticated
  with check (
    public.is_workspace_member(task_assignment.workspace_id)
    and public.can_access_entity('task', task_assignment.task_id, task_assignment.workspace_id)
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = task_assignment.workspace_id
        and m.user_id      = task_assignment.assignee_user_id
    )
  );
-- DELETE: a member may unassign within their workspace. Without this the service's
-- `unassign` matches zero rows under RLS and silently no-ops (the blanket policy that
-- had permitted DELETE was dropped above).
create policy task_assignment_delete on public.task_assignment for delete to authenticated
  using (public.is_workspace_member(workspace_id));

-- task_observer: same member + same-workspace-task rule on observer_user_id, plus DELETE.
drop policy if exists task_observer_rw on public.task_observer;
create policy task_observer_select on public.task_observer for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_observer_insert on public.task_observer for insert to authenticated
  with check (
    public.is_workspace_member(task_observer.workspace_id)
    and public.can_access_entity('task', task_observer.task_id, task_observer.workspace_id)
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = task_observer.workspace_id
        and m.user_id      = task_observer.observer_user_id
    )
  );
create policy task_observer_delete on public.task_observer for delete to authenticated
  using (public.is_workspace_member(workspace_id));

-- task_dependency: BOTH the dependent task and the blocker must live in the submitted
-- workspace (no cross-tenant dependency rows). Members add/remove within their workspace.
-- (This table was previously left on its blanket <name>_rw policy — replaced here.)
drop policy if exists task_dependency_rw on public.task_dependency;
create policy task_dependency_select on public.task_dependency for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_dependency_insert on public.task_dependency for insert to authenticated
  with check (
    public.is_workspace_member(task_dependency.workspace_id)
    and public.can_access_entity('task', task_dependency.task_id, task_dependency.workspace_id)
    and public.can_access_entity('task', task_dependency.blocker_id, task_dependency.workspace_id)
  );
create policy task_dependency_delete on public.task_dependency for delete to authenticated
  using (public.is_workspace_member(workspace_id));

-- task_attachment: internal (attachments flow through the domain service, not raw CRUD).
-- Authoritative boundary: attach only to a task you can access, and never forge the
-- uploader. uploaded_by is set to auth.uid() at the RLS boundary, not merely by the service.
drop policy if exists task_attachment_rw on public.task_attachment;
create policy task_attachment_select on public.task_attachment for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_attachment_insert on public.task_attachment for insert to authenticated
  with check (
    public.can_access_entity('task', task_attachment.task_id, task_attachment.workspace_id)
    and task_attachment.uploaded_by = (select auth.uid())
  );
create policy task_attachment_delete on public.task_attachment for delete to authenticated
  using (
    public.is_workspace_member(task_attachment.workspace_id)
    and task_attachment.uploaded_by = (select auth.uid())
  );

-- Config option tables: members read / add / edit (incl. toggling is_active), but must NOT
-- hard-DELETE. status_id/priority_id are REQUIRED FKs (on delete cascade), so deleting an
-- in-use option would cascade-delete its tasks — "removal" is is_active=false. Replace the
-- generated blanket <name>_rw (which permitted DELETE) with SELECT + INSERT + UPDATE only.
drop policy if exists task_status_option_rw on public.task_status_option;
create policy task_status_option_select on public.task_status_option for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_status_option_insert on public.task_status_option for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy task_status_option_update on public.task_status_option for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists task_priority_option_rw on public.task_priority_option;
create policy task_priority_option_select on public.task_priority_option for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_priority_option_insert on public.task_priority_option for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy task_priority_option_update on public.task_priority_option for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
```

- [ ] **Step 3: Apply + test + drift**

Run:
```bash
supabase db reset && supabase test db && supabase db diff
```
Expected: `task_test.sql .. ok` (43 assertions); every other file still `ok`; `db diff` empty.

- [ ] **Step 4: Gate — exactly the tightened tables' blanket policies are dropped; `task` keeps its blanket**

Run:
```bash
grep -cE '^drop policy if exists (task_revision|task_status_history|task_assignment|task_observer|task_dependency|task_attachment|task_status_option|task_priority_option)_rw' \
  supabase/migrations/20260701000008_task.sql
grep -cE '^drop policy if exists task_rw ' \
  supabase/migrations/20260701000008_task.sql
```
Expected: first grep prints `8` (revision/history/assignment/observer/dependency/attachment/status_option/priority_option blanket policies are all replaced with fine-grained ones); second grep prints `0` (only `public.task` keeps its generated `is_workspace_member` blanket policy — it is never dropped). The trailing space in the second pattern pins the bare `task_rw ` token so the `task_*_rw` names do not match it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000008_task.sql supabase/tests/task_test.sql
git commit -m "feat(db): hardened RLS for task revision/history/assignment/observer"
```

---

### Task 5: Default-option seeding trigger + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000008_task.sql` (append part 4)
- Edit: `supabase/tests/task_test.sql` (add seed-trigger assertions)

**Interfaces:**
- Consumes: `public.workspace` (AFTER INSERT), `public.task_status_option`, `public.task_priority_option`.
- Produces: `public.workspace_seed_task_options()` (hardened `SECURITY DEFINER`) + trigger `workspace_seed_task_options_tg`. Every new workspace receives 4 status options (Backlog/In Progress/Blocked/Done, default = Backlog) and 3 priority options (High/Medium/Low, default = Medium).

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_test.sql`: change `select plan(43);` to `select plan(50);`, and insert this block immediately BEFORE the final `select * from finish();`. It returns to the table owner and inserts a FRESH workspace W3 (not in the base seed, so its options are EXCLUSIVELY trigger-generated):
```sql
-- ── Task 5: default-option seeding trigger (read as table owner) ─────────────
reset role;
insert into public.workspace (id, name)
  values ('33333333-3333-3333-3333-333333333333', 'W3');
select is((select count(*)::int from public.task_status_option
           where workspace_id='33333333-3333-3333-3333-333333333333'),
          4, 'new workspace is seeded with 4 status options');
select is((select count(*)::int from public.task_priority_option
           where workspace_id='33333333-3333-3333-3333-333333333333'),
          3, 'new workspace is seeded with 3 priority options');
select is((select count(distinct category)::int from public.task_status_option
           where workspace_id='33333333-3333-3333-3333-333333333333'),
          4, 'the four status categories are each present exactly once');
select is((select count(*)::int from public.task_status_option
           where workspace_id='33333333-3333-3333-3333-333333333333' and is_default),
          1, 'exactly one default status option');
select is((select category from public.task_status_option
           where workspace_id='33333333-3333-3333-3333-333333333333' and is_default),
          'backlog', 'the default status option is the backlog one');
select is((select count(*)::int from public.task_priority_option
           where workspace_id='33333333-3333-3333-3333-333333333333' and is_default),
          1, 'exactly one default priority option');
select is((select label from public.task_priority_option
           where workspace_id='33333333-3333-3333-3333-333333333333' and is_default),
          'Medium', 'the default priority option is Medium');
```

Run: `supabase test db`
Expected: FAIL — no trigger exists yet, so inserting W3 seeds no options; the two count assertions return `0` (expect 4 / 3) and the dependent assertions fail. The earlier 36 hold.

- [ ] **Step 2: Append the seed trigger (green)**

Append to `supabase/migrations/20260701000008_task.sql`. Hardened `SECURITY DEFINER` with a pinned empty `search_path` and fully schema-qualified writes (the definer-audit gate fails otherwise):
```sql
-- ── default-option seeding: every new workspace gets a starter set ───────────
-- SECURITY DEFINER so the seed inserts bypass RLS; set search_path = '' and fully
-- schema-qualify every object (required by scripts/check-definer-audit.mjs).
create or replace function public.workspace_seed_task_options()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.task_status_option (workspace_id, label, category, sort_order, is_default, is_active) values
    (new.id, 'Backlog',     'backlog', 0, true,  true),
    (new.id, 'In Progress', 'active',  1, false, true),
    (new.id, 'Blocked',     'blocked', 2, false, true),
    (new.id, 'Done',        'done',    3, false, true);
  insert into public.task_priority_option (workspace_id, label, rank, is_default, is_active) values
    (new.id, 'High',   3, false, true),
    (new.id, 'Medium', 2, true,  true),
    (new.id, 'Low',    1, false, true);
  return new;
end;
$$;
revoke all on function public.workspace_seed_task_options() from public, anon, authenticated;

drop trigger if exists workspace_seed_task_options_tg on public.workspace;
create trigger workspace_seed_task_options_tg
  after insert on public.workspace
  for each row execute function public.workspace_seed_task_options();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_test.sql .. ok` (50 assertions); every other test file STILL `ok` (the trigger fires on their workspace inserts too, but none of them assert task-option counts, so no regression); definer-audit prints `all definers pinned` (exit 0); `db diff` empty.

- [ ] **Step 4: Gate — the seed trigger is a pinned definer**

Run:
```bash
grep -cE 'create trigger workspace_seed_task_options_tg' supabase/migrations/20260701000008_task.sql
node scripts/check-definer-audit.mjs
```
Expected: grep prints `1`; definer-audit exits `0` with `all definers pinned`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000008_task.sql supabase/tests/task_test.sql
git commit -m "feat(db): per-workspace default status/priority option seeding"
```

---

## Self-Review

- **Spec coverage (Part A scope):** Nine task collections defined config-first — two user-facing reference tables (`task_status_option`, `task_priority_option`, NOT internal) and seven `internal: true` task tables — wired into `defineSchema`/`index.ts`, regenerated + committed (Task 1); the circular `task ↔ task_revision` back-FK plus composite uniques/guards and hot-path indexes codegen cannot emit (Task 2); the `can_access_entity('task', …)` arm added by verbatim re-declaration (Task 3); hardened RLS overrides making `task_revision` immutable, `task_status_history` append-only, and `task_assignment`/`task_observer` membership-gated (Task 4); the per-workspace default-option seeding trigger (Task 5). Each task ends with a machine-checkable gate (`pnpm codegen`+`git diff --exit-code`, `supabase db reset`/`test db`/`db diff`, `check-definer-audit.mjs`, greps).
- **`internal` collections (surfacing decision):** the seven task tables set `internal: true`; the two option tables do not. The flag is codegen-transparent — `emit-sql`/`emit-types` ignore it, so base tables, blanket `<name>_rw` RLS, grants, and `*Row/*Create/*Update` types are emitted for internal tables exactly as for the option tables (Task 1's `grep -c 'create table … public.task'` = 9 pins that the internal `task` table IS emitted). Its only effect is that the generic GraphQL/MCP/CLI CRUD surface builders (Part B) SKIP the internal tables, whose FK relations and bespoke atomic writes (revision append, status transition + history, dependency recompute) cannot go through the generic surface.
- **Contract fidelity (Part B depends on these):**
  - FK column names: `task.status`→`status_id` (required, cascade), `task.priority`→`priority_id` (required, cascade), `task.parent`→`parent_id` (optional self-FK, set null), every child `task`→`task_id` (required, cascade), `task_dependency.blocker`→`blocker_id` (required, cascade). `task.current_revision_id` is a PLAIN `uuid` (nullable, no inline FK) with `task_current_revision_fk` hand-added in `000008` — the circular-reference avoidance is the reason it is `f.uuid`, not `f.relation`, and this is commented at the field and in the schema-order note.
  - `can_access_entity(text, uuid, uuid)` gains a `'task'` arm; the `'note'`/`'comment'` arms and the fail-closed `else` are preserved (Task 3 gate greps for all three arms). `execute` stays `authenticated`-only.
  - Seed values: status options `Backlog`(backlog, default)/`In Progress`(active)/`Blocked`(blocked)/`Done`(done), sort_order 0–3; priority options `High`(rank 3)/`Medium`(rank 2, default)/`Low`(rank 1).
- **Correctness / self-consistency:** collection order (`task_status_option`/`task_priority_option` before `task`; `task` before every child) satisfies every codegen-inlined FK, and `current_revision_id` being a plain uuid is exactly why `task` need not precede `task_revision`. The generated `<Name>Row` shapes follow the Collaboration types' `dataFields`-then-`fkFields` ordering and `required || default` nullability. `plan(N)` is bumped 24 → 27 → 43 → 50 as blocks are inserted before the single `select * from finish();`; `collaboration_test.sql` stays `plan(33)` (two assertions modified in place). Every red step is genuinely red under the prior migration state (fail-closed `else` for the `'task'` arm; blanket `<name>_rw` for the RLS tightening; no trigger for the seed).
- **Safety:** the authoritative check is `can_access_entity` (server-side, `SECURITY DEFINER`, RLS-bypassing existence probe against the verified principal via `is_workspace_member`), and its `else` still fails closed. `task_revision` and `task_status_history` have NO UPDATE/DELETE policy, so those verbs match zero rows — a revision/audit row can never be altered (pinned by the read-back-unchanged assertions, not a throw, which is the accurate RLS no-op behavior). `task_assignment`/`task_observer` INSERT requires the target to be a workspace member AND `can_access_entity('task', task_id, workspace_id)` (the task must live in the submitted workspace — the FK alone does not stop a member from pointing a child row at another tenant's task), pinned by `throws_ok '42501'` negatives; both also get an explicit DELETE policy so `unassign`/`removeObserver` actually delete (pinned by delete→count-0 reads) instead of silently no-op'ing. `task_dependency` (previously left on its blanket policy) gets SELECT/INSERT/DELETE, with INSERT requiring `can_access_entity('task', …)` on BOTH `task_id` and `blocker_id` (pinned by same-workspace add + remove reads). `task_attachment` INSERT enforces `can_access_entity('task', …)` AND `uploaded_by = auth.uid()` at the RLS boundary (not merely in the service), so the uploader cannot be forged (pinned by a `throws_ok '42501'`). The config option tables have NO DELETE policy — because `status_id`/`priority_id` are required FKs (`on delete cascade`), a hard-delete would cascade-delete tasks; removal is `is_active=false` (pinned by a delete-is-a-no-op read-back). The one-default partial unique indexes prevent two default options per workspace. All new definers (`can_access_entity` re-declaration, `workspace_seed_task_options`) are pinned (`search_path=''`, schema-qualified) — `check-definer-audit.mjs` runs in Tasks 3 and 5.
- **Reliability / drift:** every task ends with `supabase db reset` + `supabase db diff` empty; codegen reproducibility pinned by `git diff --exit-code`. `drop policy if exists`, `drop trigger if exists`, and `create or replace function` keep `000008` re-runnable on a fresh reset. The full `supabase test db` (all six test files) is the regression net for the seed trigger's cross-test side effects; it was confirmed by inspection that no existing test asserts task-option counts and that `generated_schema_test.sql` uses filtered counts (`name in ('note','tag')`, `collection_name='note'`), so nine new collections do not perturb it.
- **Observability:** N/A for Part A beyond structural pgTAP — no event emission is in scope (task lifecycle events + the due-soon notifier are Part B). Stated N/A rather than skipped.
- **Efficiency / Performance:** `task (workspace_id, status_id)` powers board/status queries; `task (parent_id)` powers subtree fetch; the partial `task (due_date) where completed_at is null` keeps the due-soon scan bounded to open tasks; `task_assignment (assignee_user_id)` powers "my tasks"; `task_dependency (blocker_id)` powers reverse-dependency recompute. Composite uniques prevent duplicate assignments/observers/dependencies/revisions. `can_access_entity` is `stable` and does one existence probe per call.
- **Simplicity / Usability:** no speculative fields beyond the contract; `task_assignment.role` is a single-value enum (`owner`) today, deliberately an enum so Part B can widen it without a type change. No user-facing UI in Part A (deferred to Part B — N/A here).
- **Known limitation (stated):** `workspace_seed_task_options_tg` fires only for workspaces created AFTER `000008` is applied; it does not backfill workspaces that predate it. On a fresh `supabase db reset` every application/test workspace is created after all migrations apply, so this is not observable here; a backfill (if a pre-existing workspace ever lacks options) is out of Part A scope and belongs with Part B's option-management surface.
- **Deferred to Part B (intentional):** domain services/resolvers, the generic-surface skip for the internal tables, task lifecycle events, dependency-blocked recompute, the due-soon notifier, R2 attachment upload, and any UI — none are needed for the data/access/seeding deliverable and none are touched here.
- **Placeholder scan:** none — every SQL/TS block is complete and copy-paste-ready; every step has an exact command + expected output. The only intentionally-illustrative content is the regenerated `types.ts` scalar mapping (labeled "codegen output — verify, do NOT hand-edit"; the committed file is authoritative and the greps + `git diff --exit-code` pin it).