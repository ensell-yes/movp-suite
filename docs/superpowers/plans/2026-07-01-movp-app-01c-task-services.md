# MOVP App — Task Management Phase 3, Part C: Domain Service, RPCs, Surfaces & Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Build the read/write behaviour of MOVP task management on top of the config, tables, RLS, and lifecycle triggers delivered by **Parts A & B**. This part adds: two workspace-scoped SECURITY **INVOKER** RPCs (`create_task_with_revision`, `update_task_description`) in migration `20260701000010_task_rpcs.sql`; a domain `task` service (`packages/domain/src/task.ts`) wired into `createDomain`; the GraphQL, MCP, and CLI surfaces for the internal `task` collection (custom ops only); the frontend task list / detail / kanban board plus the inbox **Assigned** tab; and an end-to-end task slice in `scripts/slice-e2e.sh` with a domain integration test.

**Architecture:** Parts A & B add the task collections config-first. `task` is marked `internal: true` (FK columns `status_id`/`priority_id`/`parent_id`/`current_revision_id`), so the schema-driven builders (GraphQL `packages/graphql/src/schema.ts`, MCP `packages/mcp/src/server.ts`, CLI `packages/cli/src/program.ts`) **skip** its generic CRUD — no `createTask` mutation from the generic loop, no `task.create` generic tool, no `movp task create` generic command. `task_revision` is also `internal: true` and immutable. The `task_status_option` / `task_priority_option` config tables are **NOT** internal: they are generic-surfaced (auto object types + `Page` + `create*/update*` ops + generic `CollectionService`s in `createDomain`) exactly like `note`/`tag`. The internal `task` collection is reached **exclusively** through a hand-written `task` service (wired into `createDomain`) that owns the composite writes — a task plus its first immutable revision via the `create_task_with_revision` RPC; a versioned description update via `update_task_description` — mirroring the committed hand-written `collab` service. Codegen still produces the `Task*`/`TaskRevision*` row types, which the `task` service consumes. Task **discussion** reuses the existing `collab` comment ops on `entity_type='task'` (no new code). The inbox **Assigned** tab reads through the existing `collab.inbox` service (Part B extended `public.inbox_feed`'s `assigned` branch to return the caller's assigned tasks).

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, pgTAP, Supabase CLI. `.ts` relative imports with explicit extensions; bare `@movp/*` workspace specifiers. `extensions.digest` (pgcrypto, installed `with schema extensions`) for content hashing inside SQL. Pothos (`@pothos/core`) for GraphQL; `@modelcontextprotocol/sdk` + `zod` for MCP; `commander` for the CLI. Astro + GraphQL-over-HTTP (no `@movp/{auth,domain}`) for the frontend; Playwright + `@axe-core/playwright` for the a11y smoke.

**This is Part C of the Phase-3 Task series.** It depends on **Parts A & B** (migrations `...000008`, `...000009`; the task collection config in `@movp/core-schema`; the generated task types in `packages/domain/src/generated/types.ts`; the assign/transition/dependency lifecycle triggers; and the `inbox_feed` `assigned`-tab extension) being merged first. Your migration is `20260701000010_task_rpcs.sql` (sorts after Part B's `...000009`).

## Global Constraints

- **Consume Parts A & B; do not rebuild them.** The task tables, their RLS, the option config tables, the AFTER-INSERT/UPDATE lifecycle triggers (assign → `task.assigned`, transition → `task.completed`/history + `completed_at`, dependency → `dependency_blocked`), the `inbox_feed` `assigned`-tab extension, and the generated task types are fixed inputs. Do not redefine them. Your only migration is `20260701000010_task_rpcs.sql`.
- **The `TaskService` interface is a fixed contract** (see "Inputs consumed → TaskService interface"). Implement it exactly; do not add or rename methods.
- **Per-request dependencies resolved at call time.** `task.ts` reads `ctx.db` / `ctx.userId` from the `DomainCtx` passed into `makeTaskService(ctx)` — never module scope. Surfaces build a fresh `createDomain({ db: ctx.db, userId: ctx.userId })` per request (existing `domainFrom(ctx)` pattern).
- **Hardened SECURITY INVOKER.** Both new RPCs run under the caller's RLS. They still pin `set search_path = ''`, schema-qualify every object, `revoke all … from public, anon`, and `grant execute … to authenticated`. `node scripts/check-definer-audit.mjs` must stay green (the audit does not flag invokers, but the search_path pin is still required and greppable).
- **Reuse Part B's async spine + collab.** No new queue, no new `movp_job_kind`. Assign/transition notifications ride Part B's triggers → `emit_event` → `notify` jobs (each `task.assigned` job carries `recipient_user_id`). Task discussion reuses `collab` comments; the Assigned inbox reuses `collab.inbox`.
- **Observability discipline.** The service throws `domain.task.<op> failed [<code>]` with the bounded PostgREST error code only — never a row value, title, or body.
- **Boundary gate.** `templates/` must stay free of `@movp/{auth,domain}` and service-role references. The frontend reaches the backend via GraphQL-over-HTTP only. `bash scripts/check-boundary.sh` must stay green.
- **Supabase CLI is the only migration applier.** Plain SQL in `supabase/migrations/`.

## Inputs consumed from Parts A & B (verify BEFORE Task 1)

Parts A & B's deliverables. Part C references them by exact name; a mismatch here is a reconciliation defect, not something to work around.

**Naming invariant (load-bearing):** the task collection `name` in `schema.collections` equals its snake_case DB table name: `task`, `task_revision`, `task_status_option`, `task_priority_option`, `task_assignment`, `task_observer`, `task_dependency`, `task_attachment`. Generated TypeScript types are Pascal-singular: `TaskRow`, `TaskRevisionRow`, `TaskStatusOptionRow`, `TaskPriorityOptionRow`, `TaskAttachmentRow`. The `task` service reaches internal tables by literal name (`ctx.db.from('task')…`, the two RPCs). If Part A named a collection or table differently, STOP and reconcile.

**`internal` flags (load-bearing):** `task` and `task_revision` are `internal: true`; `task_status_option` / `task_priority_option` / `task_assignment` / `task_observer` / `task_dependency` / `task_attachment` are surfaced only through the custom `task` service (they are reached by table name, never generic-surfaced) EXCEPT the two option config tables, which are **NOT** internal and ARE generic-surfaced. The GraphQL/MCP/CLI builders' existing `if (c.internal) continue` guards (added in the collab phase) already skip `task`/`task_revision`. If those guards are absent, STOP — this plan's surface tasks depend on them.

**Tables & columns Part C reads/writes** (Parts A & B own their creation, RLS, defaults, triggers):
- `public.task (id uuid, workspace_id uuid, title text, status_id uuid not null, priority_id uuid not null, parent_id uuid null, current_revision_id uuid null, start_date date null, due_date date null, completed_at timestamptz null, dependency_blocked boolean, created_at, updated_at)`
- `public.task_revision (id uuid, workspace_id uuid, task_id uuid, body text, content_hash text, author_id uuid, created_at)` — workspace-scoped (`workspace_id` NOT NULL), internal, **immutable** (no UPDATE/DELETE; INSERT of a new revision allowed).
- `public.task_status_option (id, workspace_id, label, category [enum: backlog|active|blocked|done], color, sort_order int, is_default boolean, is_active boolean)` — **NO `rank` column** — and `public.task_priority_option (id, workspace_id, label, rank [NUMERIC], color, sort_order, is_default, is_active)` — NOT internal; generic-surfaced. Both auto-seeded per workspace by Part A's trigger.
- `public.task_assignment (task_id uuid, assignee_user_id uuid, role text)` unique `(task_id, assignee_user_id)`.
- `public.task_observer (task_id uuid, observer_user_id uuid)` unique `(task_id, observer_user_id)`.
- `public.task_dependency (task_id uuid, blocker_id uuid)` unique `(task_id, blocker_id)`.
- `public.task_attachment (id, workspace_id uuid, task_id uuid, r2_key text, filename text, content_type text null, bytes bigint null, uploaded_by uuid, created_at)`.
- `extensions.digest(bytea/text, text)` — pgcrypto in the `extensions` schema.

**Lifecycle assumptions Part C relies on (Part B):** inserting a `task_assignment` fires a trigger that emits `task.assigned` (payload carries `recipient_user_id` = the assignee) and enqueues one `notify` job per assignee; updating `task.status_id` to a `done`-category status fires a trigger that sets `task.completed_at`, emits `task.completed`, and writes a task-history row; inserting a `task_dependency` whose blocker is not `done` sets the blocked task's `task.dependency_blocked = true`. `public.inbox_feed(ws, tab, lim)`'s `assigned` branch returns the caller's assigned tasks (reads `task_assignment` joined to `task` where `assignee_user_id = auth.uid()`).

**`createDomain` baseline:** the committed `createDomain(ctx)` returns `{ note, tag, search, graph, collab }` — **Part A is data-only and wires NO domain service** (it only edits `schema.ts`/migrations/RLS). Part C (Task 2) adds `task: makeTaskService(ctx)` AND generic `CollectionService`s for the two non-internal config tables (`task_status_option`, `task_priority_option`) — the schema-driven GraphQL/MCP/CLI builders resolve non-internal collections via `service(domain, name)`, which THROWS `no domain service for collection` if the member is absent. `DomainCtx = { db: SupabaseClient; userId: string }`.

**TaskService interface (fixed contract — Task 2 implements it verbatim):**
```ts
export interface TaskBoardColumn {
  status: TaskStatusOptionRow
  tasks: TaskRow[]
}

export interface TaskService {
  create(i: { workspaceId: string; title: string; description?: string; statusId?: string; priorityId?: string; parentId?: string; startDate?: string; dueDate?: string }): Promise<TaskRow>
  get(id: string): Promise<TaskRow | null>
  list(a: { workspaceId: string; statusId?: string; assigneeId?: string; parentId?: string | null; first?: number; after?: string | null }): Promise<Page<TaskRow>>
  board(a: { workspaceId: string }): Promise<TaskBoardColumn[]>
  updateDescription(id: string, body: string): Promise<TaskRow>
  assign(i: { taskId: string; userId: string }): Promise<void>
  unassign(i: { taskId: string; userId: string }): Promise<void>
  addObserver(i: { taskId: string; userId: string }): Promise<void>
  removeObserver(i: { taskId: string; userId: string }): Promise<void>
  transition(i: { taskId: string; statusId: string }): Promise<TaskRow>
  addDependency(i: { taskId: string; blockerId: string }): Promise<void>
  removeDependency(i: { taskId: string; blockerId: string }): Promise<void>
  attach(i: { taskId: string; r2Key: string; filename: string; contentType?: string; bytes?: number }): Promise<void>
}
```

- [ ] **Precondition check** — confirm Parts A & B are merged. Run:
```bash
cd /Users/ensell/Code/supasuite
grep -q 'TaskRow' packages/domain/src/generated/types.ts && echo GEN_TASK_OK || echo GEN_TASK_MISSING
grep -q 'TaskRevisionRow' packages/domain/src/generated/types.ts && echo GEN_REV_OK || echo GEN_REV_MISSING
grep -q 'TaskStatusOptionRow' packages/domain/src/generated/types.ts && echo GEN_OPT_OK || echo GEN_OPT_MISSING
ls supabase/migrations/20260701000008_*.sql supabase/migrations/20260701000009_*.sql >/dev/null 2>&1 && echo MIG_OK || echo MIG_MISSING
grep -Rnq "if (c.internal) continue" packages/graphql/src/schema.ts packages/mcp/src/server.ts packages/cli/src/program.ts && echo GUARDS_OK || echo GUARDS_MISSING
grep -q "task_assignment" supabase/migrations/20260701000009_*.sql && echo INBOX_ASSIGNED_OK || echo INBOX_ASSIGNED_CHECK
```
Expected: `GEN_TASK_OK`, `GEN_REV_OK`, `GEN_OPT_OK`, `MIG_OK`, `GUARDS_OK`. For `INBOX_ASSIGNED_*`: confirm Part B's migration wired the `assigned` branch of `public.inbox_feed` to read `task_assignment` (the Assigned inbox tab and the e2e depend on it). If any check fails, STOP — the prerequisite phase is not merged; this plan cannot execute.

## File Structure

```
supasuite/
  supabase/
    migrations/
      20260701000010_task_rpcs.sql              # NEW: create_task_with_revision + update_task_description (INVOKER, authenticated)
    tests/
      task_rpcs_test.sql                        # NEW: pgTAP for the two RPCs
  packages/
    domain/
      src/task.ts                               # NEW: makeTaskService
      src/types.ts                              # EDIT: TaskBoardColumn, TaskService, Domain.task
      src/domain.ts                             # EDIT: wire the task service
      src/index.ts                              # EDIT: export task symbols/types
      test/task.integration.test.ts             # NEW: create defaults, assign→inbox, dep blocks, transition completes, dedupe, comment, cross-ws
    graphql/
      src/schema.ts                             # EDIT: task/tasks/taskBoard queries + 8 task mutations
      test/task.test.ts                         # NEW
    mcp/
      src/server.ts                             # EDIT: 8 custom task tools
      test/server.test.ts                       # EDIT: mock task + option services + task-tool assertions
    cli/
      src/program.ts                            # EDIT: task command group
      test/program.test.ts                      # EDIT: mock task + task-command assertions
  templates/
    frontend-astro/
      src/lib/task-queries.ts                   # NEW: GraphQL documents (list/board/detail/mutations)
      src/pages/tasks/index.astro               # NEW: task list
      src/pages/tasks/board.astro               # NEW: kanban board
      src/pages/tasks/[id].astro                # NEW: task detail
      src/components/InboxAssignedTab.*         # EDIT: wire the Assigned tab
      tests/tasks.a11y.spec.ts                  # NEW: Playwright + axe smoke
  scripts/
    slice-e2e.sh                                # EDIT: [task] slice
```

---

### Task 1: Task RPCs (`20260701000010_task_rpcs.sql`) + pgTAP

Two `public` SECURITY **INVOKER** write RPCs granted to `authenticated`. `create_task_with_revision` inserts a task, inserts its first immutable `task_revision`, and points `current_revision_id` at it — all in one transaction. `update_task_description` computes the body hash; if it equals the current revision's `content_hash` it returns the task unchanged (dedupe); otherwise it inserts a new immutable revision and advances `current_revision_id`. Both run under the caller's RLS.

**Files:**
- Create: `supabase/migrations/20260701000010_task_rpcs.sql`
- Test: `supabase/tests/task_rpcs_test.sql`

**Interfaces produced:**
- `public.create_task_with_revision(ws uuid, p_title text, p_status_id uuid, p_priority_id uuid, p_parent_id uuid, p_start_date date, p_due_date date, p_body text) returns jsonb` (INVOKER, `search_path=''`, `authenticated`).
- `public.update_task_description(p_task_id uuid, p_body text) returns jsonb` (INVOKER, `search_path=''`, `authenticated`).

- [ ] **Step 1: Write the failing pgTAP test**

`supabase/tests/task_rpcs_test.sql`:
```sql
begin;
select plan(13);

-- structure + grants
select has_function('public', 'create_task_with_revision',
  array['uuid','text','uuid','uuid','uuid','date','date','text'], 'create_task_with_revision exists');
select has_function('public', 'update_task_description', array['uuid','text'], 'update_task_description exists');
select is(has_function_privilege('authenticated',
  'public.create_task_with_revision(uuid,text,uuid,uuid,uuid,date,date,text)', 'execute'),
  true, 'authenticated can execute create_task_with_revision');
select is(has_function_privilege('anon',
  'public.create_task_with_revision(uuid,text,uuid,uuid,uuid,date,date,text)', 'execute'),
  false, 'anon cannot execute create_task_with_revision');
select is(has_function_privilege('authenticated',
  'public.update_task_description(uuid,text)', 'execute'),
  true, 'authenticated can execute update_task_description');
select is(has_function_privilege('anon',
  'public.update_task_description(uuid,text)', 'execute'),
  false, 'anon cannot execute update_task_description');

-- seed as superuser (reset role bypasses RLS)
reset role;
insert into public.workspace (id, name)
  values ('77777777-7777-7777-7777-777777777777', 'TaskWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('77777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
-- NOTE: the workspace INSERT above already auto-seeded default options (Part A's
-- AFTER-INSERT trigger). These extra options are is_default=FALSE to avoid the
-- one-default-per-workspace partial unique. task_status_option has NO `rank` column;
-- `category` is the enum backlog|active|blocked|done. task_priority_option.rank is NUMERIC.
insert into public.task_status_option (id, workspace_id, label, category, is_default, is_active, sort_order)
  values ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777',
          'Todo', 'backlog', false, true, 10)
  on conflict (id) do nothing;
insert into public.task_priority_option (id, workspace_id, label, is_default, is_active, sort_order, rank)
  values ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777',
          'Normal', false, true, 10, 5)
  on conflict (id) do nothing;

-- act as the member
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- create returns a task with an id
select ok(
  (public.create_task_with_revision(
     '77777777-7777-7777-7777-777777777777', 'First task',
     '88888888-8888-8888-8888-888888888888', '99999999-9999-9999-9999-999999999999',
     null, null, null, 'initial body'
   ) ->> 'id') is not null,
  'create_task_with_revision returns a task with an id');

-- exactly one revision at creation
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id
    where t.workspace_id = '77777777-7777-7777-7777-777777777777' and t.title = 'First task'),
  1, 'create writes exactly one revision');

-- current_revision_id points at that revision
select is(
  (select case when t.current_revision_id = r.id then 1 else 0 end
     from public.task t join public.task_revision r on r.task_id = t.id
    where t.title = 'First task'),
  1, 'current_revision_id points at revision #1');

-- update with the SAME body -> still one revision (dedupe)
select public.update_task_description(
  (select id from public.task where title = 'First task'), 'initial body');
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id where t.title = 'First task'),
  1, 'identical body does not add a revision (dedupe)');

-- update with a NEW body -> two revisions + current advanced
select public.update_task_description(
  (select id from public.task where title = 'First task'), 'revised body');
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id where t.title = 'First task'),
  2, 'a changed body adds a second revision');
select is(
  (select r.content_hash from public.task t
     join public.task_revision r on r.id = t.current_revision_id where t.title = 'First task'),
  encode(extensions.digest('revised body', 'sha256'), 'hex'),
  'current_revision_id advanced to the new revision');

-- task_revision is workspace-scoped (workspace_id NOT NULL): both revisions must carry the
-- task's workspace_id, else the RPC inserts would have failed the NOT NULL constraint.
select is(
  (select count(*)::int from public.task_revision r
     join public.task t on t.id = r.task_id
    where t.title = 'First task' and r.workspace_id = t.workspace_id),
  2, 'every revision inherits the task workspace_id (workspace-scoped)');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
supabase db reset && supabase test db
```
Expected: FAIL — `function public.create_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text) does not exist`. (`db reset` applies Parts A & B's migrations first; the pgTAP references their tables.)

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260701000010_task_rpcs.sql`:
```sql
-- Task RPCs: two SECURITY INVOKER writes. `task` and `task_revision` are internal
-- (custom-op-only). A task and its first immutable revision must commit together and
-- current_revision_id must point at the newly-inserted revision — a single
-- transactional INVOKER RPC does this under the CALLER's RLS. pgcrypto lives in the
-- `extensions` schema (installed `with schema extensions`), so hashing is
-- extensions.digest, fully schema-qualified. Both functions pin search_path=''.

create or replace function public.create_task_with_revision(
  ws uuid,
  p_title text,
  p_status_id uuid,
  p_priority_id uuid,
  p_parent_id uuid,
  p_start_date date,
  p_due_date date,
  p_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_task_id uuid;
  new_rev_id uuid;
  result jsonb;
begin
  insert into public.task (workspace_id, title, status_id, priority_id, parent_id, start_date, due_date)
    values (ws, p_title, p_status_id, p_priority_id, p_parent_id, p_start_date, p_due_date)
    returning id into new_task_id;

  -- author_id resolved at call time from the JWT; NEVER trust a client-passed author.
  -- task_revision is workspace-scoped (workspace_id NOT NULL) — use the task's ws.
  insert into public.task_revision (workspace_id, task_id, body, content_hash, author_id)
    values (
      ws,
      new_task_id,
      coalesce(p_body, ''),
      encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex'),
      (select auth.uid())
    )
    returning id into new_rev_id;

  update public.task set current_revision_id = new_rev_id where id = new_task_id;

  select to_jsonb(t) into result from public.task t where t.id = new_task_id;
  return result;
end;
$$;

create or replace function public.update_task_description(
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_hash text := encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex');
  v_ws uuid;
  current_hash text;
  new_rev_id uuid;
  result jsonb;
begin
  -- Resolve the task's workspace + current-revision hash under the caller's RLS. LEFT join
  -- so a task with no current revision still yields its workspace_id; a task the caller
  -- cannot read yields no row (v_ws stays null).
  select t.workspace_id, r.content_hash
    into v_ws, current_hash
    from public.task t
    left join public.task_revision r on r.id = t.current_revision_id
   where t.id = p_task_id;

  -- Not found / inaccessible under RLS -> stable error (task_revision.workspace_id is
  -- NOT NULL, so we must have the ws before inserting).
  if v_ws is null then
    raise exception 'task not found or inaccessible' using errcode = 'no_data_found';
  end if;

  -- Dedupe: identical body -> no new revision, return the task unchanged.
  if current_hash is not null and current_hash = new_hash then
    select to_jsonb(t) into result from public.task t where t.id = p_task_id;
    return result;
  end if;

  insert into public.task_revision (workspace_id, task_id, body, content_hash, author_id)
    values (v_ws, p_task_id, coalesce(p_body, ''), new_hash, (select auth.uid()))
    returning id into new_rev_id;

  update public.task set current_revision_id = new_rev_id where id = p_task_id;

  select to_jsonb(t) into result from public.task t where t.id = p_task_id;
  return result;
end;
$$;

-- INVOKER write RPCs: revoke from public/anon, grant to authenticated only.
revoke all on function public.create_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text) from public, anon;
revoke all on function public.update_task_description(uuid, text) from public, anon;
grant execute on function public.create_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text) to authenticated;
grant execute on function public.update_task_description(uuid, text) to authenticated;
```

> **Why `SECURITY INVOKER` (not `DEFINER`).** Both functions must run under the caller's RLS so Parts A & B enforce workspace-membership + author-scoping on the task and revision inserts. Because the revision is inserted in the SAME transaction as the task, a task the caller cannot write rolls the whole thing back — no orphan task persists. They carry `set search_path = ''` and full schema-qualification like the DEFINER RPCs, but `check-definer-audit.mjs` does not flag them (they are not definers).

- [ ] **Step 4: Apply, run the test, drift + definer gates**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: migration applies; `task_rpcs_test.sql .. ok` (13 assertions pass); definer-audit prints `all definers pinned`; `db diff` reports no schema changes.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260701000010_task_rpcs.sql supabase/tests/task_rpcs_test.sql
git commit -m "feat(db): create_task_with_revision + update_task_description task RPCs (invoker, authenticated)"
```

---

### Task 2: Domain `task` service + `createDomain` wiring

Implement `makeTaskService(ctx)` in `packages/domain/src/task.ts`; add `TaskBoardColumn` + `TaskService` to `types.ts` and extend `Domain`; wire `task` into `createDomain`; export from `index.ts`. The `task` collection is `internal` and reached ONLY through this custom service (NOT a generic `CollectionService`). The test is the domain integration test (requires the local stack + Parts A & B tables).

**Files:**
- Create: `packages/domain/src/task.ts`
- Edit: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/task.integration.test.ts`

**Interfaces produced:** `makeTaskService(ctx: DomainCtx): TaskService`; `Domain.task`; `TaskBoardColumn`, `TaskService` types.

- [ ] **Step 1: Write the failing integration test**

`packages/domain/test/task.integration.test.ts` (clones `packages/domain/test/collab.integration.test.ts`'s `serviceClient`/`userClient`/`makeUser`/`makeWorkspace`/`addMember`/`assertOk` helpers verbatim — copy them, then add the task-specific `seedTaskConfig` and the test below):
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

function serviceClient(): SupabaseClient {
  return createClient(env.url, env.serviceRole, { auth: { persistSession: false } })
}
function userClient(token: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}
async function assertOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
  return res
}
async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `task-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const cu = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }),
    }), 'create user',
  )).json()
  const si = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), 'sign in',
  )).json()
  return { id: cu.id as string, token: si.access_token as string }
}
async function makeWorkspace(name: string): Promise<string> {
  const rows = await (await assertOk(
    await fetch(`${env.url}/rest/v1/workspace`, {
      method: 'POST', headers: { ...admin, Prefer: 'return=representation' }, body: JSON.stringify({ name }),
    }), 'create workspace',
  )).json()
  return rows[0].id as string
}
async function addMember(ws: string, userId: string): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST', headers: admin, body: JSON.stringify({ workspace_id: ws, user_id: userId, role: 'member' }),
    }), 'add member',
  )
}
// Part A's AFTER-INSERT-on-workspace trigger already auto-seeds this workspace's default
// status/priority options (Backlog/In Progress/Blocked/Done + High/Medium/Low). READ them —
// do NOT insert new is_default rows (that violates the one-default-per-workspace partial
// unique), and note task_status_option has NO `rank` column and `category` is the enum
// backlog|active|blocked|done. `openStatus` = the default status, `doneStatus` = the
// done-category status, `priority` = the default priority.
async function seedTaskConfig(ws: string): Promise<{ openStatus: string; doneStatus: string; priority: string }> {
  const db = serviceClient()
  const openS = await db.from('task_status_option').select('id')
    .eq('workspace_id', ws).eq('is_default', true).eq('is_active', true).single()
  const doneS = await db.from('task_status_option').select('id')
    .eq('workspace_id', ws).eq('category', 'done').eq('is_active', true).limit(1).single()
  const priP = await db.from('task_priority_option').select('id')
    .eq('workspace_id', ws).eq('is_default', true).eq('is_active', true).single()
  return {
    openStatus: (openS.data as { id: string }).id,
    doneStatus: (doneS.data as { id: string }).id,
    priority: (priP.data as { id: string }).id,
  }
}

describe('task integration', () => {
  it('create defaults, assign->assigned inbox, dependency blocks, transition completes, dedupe, comment, cross-ws', async () => {
    const ws1 = await makeWorkspace('Task WS')
    const ws2 = await makeWorkspace('Other WS')
    const owner = await makeUser()
    const assignee = await makeUser()
    await addMember(ws1, owner.id)
    await addMember(ws1, assignee.id)
    const cfg = await seedTaskConfig(ws1)

    const ownerDomain = createDomain({ db: userClient(owner.token), userId: owner.id })
    const assigneeDomain = createDomain({ db: userClient(assignee.token), userId: assignee.id })
    const adminDb = serviceClient()

    // create with NO status/priority -> service applies the workspace is_default active options
    const task = await ownerDomain.task.create({ workspaceId: ws1, title: 'Ship it', description: 'first body' })
    expect(task.status_id).toBe(cfg.openStatus)
    expect(task.priority_id).toBe(cfg.priority)
    expect(task.current_revision_id).toBeTruthy()

    // exactly one revision at creation (service role bypasses RLS/internal)
    const rev1 = await adminDb.from('task_revision').select('id').eq('task_id', task.id)
    expect((rev1.data ?? []).length).toBe(1)

    // assign the 2nd member -> Part B trigger emits task.assigned; assigned inbox shows it
    await ownerDomain.task.assign({ taskId: task.id, userId: assignee.id })
    const assignedInbox = await assigneeDomain.collab.inbox({ workspaceId: ws1, tab: 'assigned' })
    expect(assignedInbox.some((i) => i.entity_id === task.id)).toBe(true)
    // idempotent: a second assign neither errors nor duplicates
    await ownerDomain.task.assign({ taskId: task.id, userId: assignee.id })
    const asg = await adminDb.from('task_assignment').select('task_id').eq('task_id', task.id).eq('assignee_user_id', assignee.id)
    expect((asg.data ?? []).length).toBe(1)

    // add a not-done blocker -> the blocked task reports dependency_blocked = true
    const blocker = await ownerDomain.task.create({ workspaceId: ws1, title: 'Blocker' })
    await ownerDomain.task.addDependency({ taskId: task.id, blockerId: blocker.id })
    const blocked = await ownerDomain.task.get(task.id)
    expect(blocked?.dependency_blocked).toBe(true)

    // transition to a done-category status -> Part B trigger sets completed_at
    const done = await ownerDomain.task.transition({ taskId: task.id, statusId: cfg.doneStatus })
    expect(done.status_id).toBe(cfg.doneStatus)
    expect(done.completed_at).toBeTruthy()

    // updateDescription twice with the SAME body -> ONE new revision total (2nd dedupes)
    await ownerDomain.task.updateDescription(task.id, 'second body')
    await ownerDomain.task.updateDescription(task.id, 'second body')
    const revs = await adminDb.from('task_revision').select('id').eq('task_id', task.id)
    expect((revs.data ?? []).length).toBe(2) // rev #1 (create) + rev #2 (first update); 2nd identical update dedupes

    // discussion reuses the collab service on entity_type='task'
    const comment = await ownerDomain.collab.comment.create({ entityType: 'task', entityId: task.id, body: 'nice' })
    expect(comment.entity_id).toBe(task.id)

    // cross-workspace isolation: a task in ws2 (owner is NOT a member) is invisible.
    // ws2's default status/priority options were auto-seeded by the trigger — read them
    // (status_id AND priority_id are both required/NOT NULL on task).
    const fStatus = await adminDb.from('task_status_option').select('id')
      .eq('workspace_id', ws2).eq('is_default', true).single()
    const fPriority = await adminDb.from('task_priority_option').select('id')
      .eq('workspace_id', ws2).eq('is_default', true).single()
    const foreign = await adminDb.from('task').insert({
      workspace_id: ws2, title: 'Foreign',
      status_id: (fStatus.data as { id: string }).id,
      priority_id: (fPriority.data as { id: string }).id,
    }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    expect(await ownerDomain.task.get(foreignId)).toBeNull()
    await expect(ownerDomain.task.transition({ taskId: foreignId, statusId: cfg.doneStatus }))
      .rejects.toThrow(/not found or inaccessible/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (with the local stack up — `supabase start` beforehand):
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run task
```
Expected: FAIL — `createDomain(...).task` is undefined (`Cannot read properties of undefined (reading 'create')`).

- [ ] **Step 3: Implement `task.ts`**

`packages/domain/src/task.ts`:
```ts
import type { TaskRow, TaskStatusOptionRow } from './generated/types.ts'
import type { DomainCtx, Page, TaskBoardColumn, TaskService } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)

export function makeTaskService(ctx: DomainCtx): TaskService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.task.${op} failed [${code ?? 'unknown'}]`)
  }

  // The workspace is_default active option of a kind (status/priority), or null.
  async function defaultOption(table: 'task_status_option' | 'task_priority_option', ws: string): Promise<string | null> {
    const { data, error } = await ctx.db
      .from(table)
      .select('id')
      .eq('workspace_id', ws)
      .eq('is_default', true)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) fail('defaultOption', error.code)
    return (data as { id?: string } | null)?.id ?? null
  }

  // Resolve a task's workspace under the CALLER's RLS; doubles as an access check.
  async function taskWorkspace(taskId: string): Promise<string> {
    const { data, error } = await ctx.db.from('task').select('workspace_id').eq('id', taskId).maybeSingle()
    if (error) fail('resolveTask', error.code)
    const ws = (data as { workspace_id?: string } | null)?.workspace_id
    if (!ws) throw new Error('domain.task: task not found or inaccessible')
    return ws
  }

  return {
    async create(i) {
      // Default status/priority to the workspace is_default active option when omitted.
      const statusId = i.statusId ?? (await defaultOption('task_status_option', i.workspaceId))
      const priorityId = i.priorityId ?? (await defaultOption('task_priority_option', i.workspaceId))
      // Single transactional RPC (SECURITY INVOKER): task + first immutable revision
      // commit atomically under the caller's RLS, and current_revision_id is set to it.
      const { data, error } = await ctx.db.rpc('create_task_with_revision', {
        ws: i.workspaceId,
        p_title: i.title,
        p_status_id: statusId,
        p_priority_id: priorityId,
        p_parent_id: i.parentId ?? null,
        p_start_date: i.startDate ?? null,
        p_due_date: i.dueDate ?? null,
        p_body: i.description ?? null,
      })
      if (error) fail('create', error.code)
      return data as TaskRow
    },

    async get(id) {
      const { data, error } = await ctx.db.from('task').select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as TaskRow | null) ?? null
    },

    async list(a) {
      const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db.from('task').select('*').eq('workspace_id', a.workspaceId)
      if (a.statusId) q = q.eq('status_id', a.statusId)
      if (a.parentId === null) q = q.is('parent_id', null)
      else if (a.parentId != null) q = q.eq('parent_id', a.parentId)
      if (a.assigneeId) {
        // Two-step to keep TaskRow clean (no embedded join): ids from task_assignment.
        const { data: asg, error: asgErr } = await ctx.db
          .from('task_assignment').select('task_id').eq('assignee_user_id', a.assigneeId)
        if (asgErr) fail('list.assignee', asgErr.code)
        const ids = (asg ?? []).map((r: { task_id: string }) => r.task_id)
        if (ids.length === 0) return { items: [], nextCursor: null }
        q = q.in('id', ids)
      }
      q = q.order('id', { ascending: true }).limit(first + 1)
      if (a.after) q = q.gt('id', decodeCursor(a.after))
      const { data, error } = await q
      if (error) fail('list', error.code)
      const rows = (data ?? []) as TaskRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async board(a) {
      const { data: statusData, error: statusErr } = await ctx.db
        .from('task_status_option').select('*')
        .eq('workspace_id', a.workspaceId).eq('is_active', true)
        .order('sort_order', { ascending: true })
      if (statusErr) fail('board.status', statusErr.code)
      const statuses = (statusData ?? []) as TaskStatusOptionRow[]
      const { data: taskData, error: taskErr } = await ctx.db
        .from('task').select('*').eq('workspace_id', a.workspaceId).order('id', { ascending: true })
      if (taskErr) fail('board.tasks', taskErr.code)
      const tasks = (taskData ?? []) as TaskRow[]
      return statuses.map((status) => ({ status, tasks: tasks.filter((t) => t.status_id === status.id) }))
    },

    async updateDescription(id, body) {
      const { data, error } = await ctx.db.rpc('update_task_description', { p_task_id: id, p_body: body })
      if (error) fail('updateDescription', error.code)
      return data as TaskRow
    },

    async assign(i) {
      // Idempotent: the trigger emits task.assigned; a repeat assign must not re-notify.
      // task_assignment is workspace-scoped (workspace_id NOT NULL) and role is a CHECK'd
      // enum whose ONLY value is 'owner' — derive the ws from the task; never 'assignee'.
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_assignment').upsert(
        { workspace_id: ws, task_id: i.taskId, assignee_user_id: i.userId, role: 'owner' },
        { onConflict: 'task_id,assignee_user_id', ignoreDuplicates: true },
      )
      if (error) fail('assign', error.code)
    },

    async unassign(i) {
      const { error } = await ctx.db.from('task_assignment').delete()
        .eq('task_id', i.taskId).eq('assignee_user_id', i.userId)
      if (error) fail('unassign', error.code)
    },

    async addObserver(i) {
      const ws = await taskWorkspace(i.taskId)   // task_observer is workspace-scoped (NOT NULL)
      const { error } = await ctx.db.from('task_observer').upsert(
        { workspace_id: ws, task_id: i.taskId, observer_user_id: i.userId },
        { onConflict: 'task_id,observer_user_id', ignoreDuplicates: true },
      )
      if (error) fail('addObserver', error.code)
    },

    async removeObserver(i) {
      const { error } = await ctx.db.from('task_observer').delete()
        .eq('task_id', i.taskId).eq('observer_user_id', i.userId)
      if (error) fail('removeObserver', error.code)
    },

    async transition(i) {
      // Update status_id; Part B's transition trigger emits the event, writes a history
      // row, and sets completed_at when the target status is a done-category option.
      const { data, error } = await ctx.db.from('task').update({ status_id: i.statusId })
        .eq('id', i.taskId).select('*').maybeSingle()
      if (error) fail('transition', error.code)
      if (!data) throw new Error('domain.task.transition: task not found or inaccessible')
      return data as TaskRow
    },

    async addDependency(i) {
      // Idempotent; Part B's dependency trigger maintains task.dependency_blocked.
      // task_dependency is workspace-scoped (NOT NULL); both tasks share the workspace.
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_dependency').upsert(
        { workspace_id: ws, task_id: i.taskId, blocker_id: i.blockerId },
        { onConflict: 'task_id,blocker_id', ignoreDuplicates: true },
      )
      if (error) fail('addDependency', error.code)
    },

    async removeDependency(i) {
      const { error } = await ctx.db.from('task_dependency').delete()
        .eq('task_id', i.taskId).eq('blocker_id', i.blockerId)
      if (error) fail('removeDependency', error.code)
    },

    async attach(i) {
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_attachment').insert({
        workspace_id: ws,
        task_id: i.taskId,
        r2_key: i.r2Key,
        filename: i.filename,
        content_type: i.contentType ?? null,
        bytes: i.bytes ?? null,
        uploaded_by: ctx.userId,
      })
      if (error) fail('attach', error.code)
    },
  }
}
```

- [ ] **Step 4: Extend `types.ts`**

In `packages/domain/src/types.ts`, extend the generated-types import to add `TaskRow` and `TaskStatusOptionRow`, then add the interfaces. Change the generated-types import line to include:
```ts
import type {
  CommentRow,
  NoteCreate, NoteRow, NoteUpdate,
  TagCreate, TagRow, TagUpdate,
  TaskRow, TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate,
  TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate,
} from './generated/types.ts'
```
(`CollectionService` is already defined/exported in `types.ts` — the same type `note`/`tag` use — so no new import is needed for it.)
Add these interfaces (place before `export interface Domain`):
```ts
export interface TaskBoardColumn {
  status: TaskStatusOptionRow
  tasks: TaskRow[]
}

export interface TaskService {
  create(i: { workspaceId: string; title: string; description?: string; statusId?: string; priorityId?: string; parentId?: string; startDate?: string; dueDate?: string }): Promise<TaskRow>
  get(id: string): Promise<TaskRow | null>
  list(a: { workspaceId: string; statusId?: string; assigneeId?: string; parentId?: string | null; first?: number; after?: string | null }): Promise<Page<TaskRow>>
  board(a: { workspaceId: string }): Promise<TaskBoardColumn[]>
  updateDescription(id: string, body: string): Promise<TaskRow>
  assign(i: { taskId: string; userId: string }): Promise<void>
  unassign(i: { taskId: string; userId: string }): Promise<void>
  addObserver(i: { taskId: string; userId: string }): Promise<void>
  removeObserver(i: { taskId: string; userId: string }): Promise<void>
  transition(i: { taskId: string; statusId: string }): Promise<TaskRow>
  addDependency(i: { taskId: string; blockerId: string }): Promise<void>
  removeDependency(i: { taskId: string; blockerId: string }): Promise<void>
  attach(i: { taskId: string; r2Key: string; filename: string; contentType?: string; bytes?: number }): Promise<void>
}
```
Add `task: TaskService` AND the two generic option-table services to the existing `Domain` interface. The committed `Domain` has only `note`/`tag`/`search`/`graph`/`collab`; the option-table members are added HERE (Part A never edits `domain.ts`). Use the same `CollectionService<Row, Create, Update>` type `note`/`tag` use (already imported in `types.ts`):
```ts
  task: TaskService
  task_status_option: CollectionService<TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate>
  task_priority_option: CollectionService<TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate>
```

- [ ] **Step 5: Wire `domain.ts`**

In `packages/domain/src/domain.ts`, add the import (next to the other `make*` imports):
```ts
import { makeTaskService } from './task.ts'
```
and add these lines to `createDomain`'s returned object (alongside `collab: makeCollabService(ctx)`). Also extend the generated-types import at the top of `domain.ts` to bring in `TaskStatusOptionRow/Create/Update` and `TaskPriorityOptionRow/Create/Update` (next to the existing `Note*`/`Tag*` imports). **The two option config tables are NON-internal**, so the schema-driven builders resolve them via `service(domain, name)` — which THROWS `no domain service for collection` if the member is absent. **Part A is data-only and never edits `domain.ts`, so these generic services MUST be wired here in Part C** (the committed `createDomain` has only `note`/`tag`/`search`/`graph`/`collab`):
```ts
    // NON-internal config tables → generic CRUD surface. Wire generic services so
    // service(domain,'task_status_option') / service(domain,'task_priority_option')
    // resolve (else the GraphQL/MCP/CLI builders throw "no domain service for collection").
    task_status_option: makeCollectionService<TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate>(ctx, { table: 'task_status_option' }),
    task_priority_option: makeCollectionService<TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate>(ctx, { table: 'task_priority_option' }),
    // `task` is internal — reached ONLY through this custom service (ctx.db.from('task')…
    // + the create_task_with_revision / update_task_description RPCs). The generic
    // GraphQL/MCP/CLI builders already `if (c.internal) continue` past it. Wiring it
    // generically would re-expose the FK-relation-broken CRUD this design removes.
    task: makeTaskService(ctx),
```
(`makeCollectionService` is already imported in `domain.ts` for `note`/`tag`.)

- [ ] **Step 6: Export from `index.ts`**

In `packages/domain/src/index.ts`, add after the existing `export { makeCollabService, resolveShareLink } from './collab.ts'` line:
```ts
export { makeTaskService } from './task.ts'
```
Add `TaskBoardColumn` and `TaskService` to the type export block from `./types.ts` (alphabetical, alongside `CollabService`, `Domain`, etc.):
```ts
  TaskBoardColumn,
  TaskService,
```
Extend the generated-types re-export line to include the task rows the surfaces need (`TaskRow`, `TaskStatusOptionRow`, `TaskPriorityOptionRow`):
```ts
export type {
  CommentRow,
  NoteCreate, NoteRow, NoteUpdate,
  TagCreate, TagRow, TagUpdate,
  TaskRow, TaskStatusOptionRow, TaskPriorityOptionRow,
} from './generated/types.ts'
```

- [ ] **Step 7: Run the test + typecheck**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run task && pnpm --filter @movp/domain typecheck
```
Expected: PASS — `task.integration.test.ts` (1 test) green; `tsc --noEmit` clean.

- [ ] **Step 8: Commit**
```bash
git add packages/domain
git commit -m "feat(domain): task service (create/get/list/board/assign/transition/dependency/describe/attach) + wiring"
```

---

### Task 3: GraphQL surface — task/tasks/taskBoard queries + task mutations

Add custom `task`, `tasks`, `taskBoard`, and `comments` queries plus `createTask`, `assignTask`, `unassignTask`, `addTaskObserver`, `transitionTask`, `addTaskDependency`, `updateTaskDescription`, `attachTask` mutations to `packages/graphql/src/schema.ts`, mirroring the hand-written `collab` block. (`comments` surfaces the existing `collab.comment.listByEntity` — 05b exposed `addComment` but no read query for the thread — so the task detail page has a discussion source.) Gate the whole block behind `refs.has('task')` so schemas without the task collections are unaffected. The `if (c.internal) continue` guards (from the collab phase) already skip `task`/`task_revision`; the two option config tables stay fully generic-surfaced.

**Files:**
- Edit: `packages/graphql/src/schema.ts`
- Test: `packages/graphql/test/task.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/graphql/test/task.test.ts`:
```ts
import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 't1', workspace_id: 'w', title: 'Ship it', status_id: 's1', priority_id: 'p1',
    parent_id: null, current_revision_id: 'r1', start_date: null, due_date: null,
    completed_at: null, dependency_blocked: false, created_at: 't', updated_at: 't', ...over,
  })
  return {
    row,
    create: vi.fn(async (i: any) => row({ title: i.title, status_id: i.statusId ?? 's1', priority_id: i.priorityId ?? 'p1' })),
    get: vi.fn(async () => row()),
    list: vi.fn(async () => ({ items: [row()], nextCursor: null })),
    board: vi.fn(async () => [{ status: { id: 's1', label: 'Todo', category: 'backlog', is_default: true, is_active: true, sort_order: 0 }, tasks: [row()] }]),
    assign: vi.fn(async () => undefined),
    transition: vi.fn(async (i: any) => row({ id: i.taskId, status_id: i.statusId, completed_at: 't' })),
    addDependency: vi.fn(async () => undefined),
    updateDescription: vi.fn(async (id: string) => row({ id })),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    task: {
      create: mocks.create, get: mocks.get, list: mocks.list, board: mocks.board,
      assign: mocks.assign, unassign: vi.fn(), addObserver: vi.fn(), removeObserver: vi.fn(),
      transition: mocks.transition, addDependency: mocks.addDependency, removeDependency: vi.fn(),
      updateDescription: mocks.updateDescription, attach: vi.fn(),
    },
    // the `comments` query resolves through collab.comment.listByEntity
    collab: {
      comment: {
        listByEntity: vi.fn(async () => ({
          items: [{ id: 'c1', workspace_id: 'w', entity_type: 'task', entity_id: 't1', body: 'hi', author_id: 'u2', parent_id: null, created_at: 't', updated_at: 't' }],
          nextCursor: null,
        })),
      },
    },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }

describe('task GraphQL surface', () => {
  it('createTask routes to task.create with default passthrough', async () => {
    const res = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { createTask(workspaceId: "w", title: "Ship it") { id title status_id } }', contextValue: ctx })
    expect(res.errors).toBeUndefined()
    expect(mocks.create).toHaveBeenCalledWith({ workspaceId: 'w', title: 'Ship it', description: undefined, statusId: undefined, priorityId: undefined, parentId: undefined, startDate: undefined, dueDate: undefined })
    expect((res.data as { createTask: { id: string } }).createTask.id).toBe('t1')
  })

  it('tasks returns a page; taskBoard returns columns grouped by status', async () => {
    const p = await graphql({ schema: buildSchema(movpSchema), source: 'query { tasks(workspaceId: "w") { items { id } nextCursor } }', contextValue: ctx })
    expect(p.errors).toBeUndefined()
    expect((p.data as { tasks: { items: Array<{ id: string }> } }).tasks.items[0].id).toBe('t1')
    const b = await graphql({ schema: buildSchema(movpSchema), source: 'query { taskBoard(workspaceId: "w") { status { id } tasks { id } } }', contextValue: ctx })
    expect(b.errors).toBeUndefined()
    const col = (b.data as { taskBoard: Array<{ status: { id: string }; tasks: Array<{ id: string }> }> }).taskBoard[0]
    expect(col.status.id).toBe('s1')
    expect(col.tasks[0].id).toBe('t1')
  })

  it('transitionTask + updateTaskDescription + assignTask + addTaskDependency route correctly', async () => {
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { transitionTask(taskId: "t1", statusId: "s2") { id status_id completed_at } }', contextValue: ctx })
    expect(mocks.transition).toHaveBeenCalledWith({ taskId: 't1', statusId: 's2' })
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { updateTaskDescription(taskId: "t1", body: "new") { id } }', contextValue: ctx })
    expect(mocks.updateDescription).toHaveBeenCalledWith('t1', 'new')
    const a = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { assignTask(taskId: "t1", userId: "u2") }', contextValue: ctx })
    expect(mocks.assign).toHaveBeenCalledWith({ taskId: 't1', userId: 'u2' })
    expect((a.data as { assignTask: boolean }).assignTask).toBe(true)
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { addTaskDependency(taskId: "t1", blockerId: "t2") }', contextValue: ctx })
    expect(mocks.addDependency).toHaveBeenCalledWith({ taskId: 't1', blockerId: 't2' })
  })

  it('comments query returns the entity thread via collab.comment.listByEntity', async () => {
    const res = await graphql({ schema: buildSchema(movpSchema), source: 'query { comments(workspaceId: "w", entityType: "task", entityId: "t1") { id body } }', contextValue: ctx })
    expect(res.errors).toBeUndefined()
    expect((res.data as { comments: Array<{ id: string; body: string }> }).comments[0].id).toBe('c1')
  })

  it('surfaces custom task ops + generic option CRUD, but NO generic CRUD for internal task/task_revision', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    // custom task ops present
    expect(sdl).toMatch(/\bcreateTask\(/)
    expect(sdl).toMatch(/\btaskBoard\(/)
    expect(sdl).toMatch(/\btransitionTask\(/)
    expect(sdl).toMatch(/type Task\b/)
    // internal task_revision gets NO generic type / mutation
    expect(sdl).not.toMatch(/type TaskRevision\b/)
    expect(sdl).not.toMatch(/\bcreateTaskRevision\(/)
    // option config tables ARE generic-surfaced
    expect(sdl).toMatch(/type TaskStatusOption\b/)
    expect(sdl).toMatch(/\bcreateTaskStatusOption\(/)
    expect(sdl).toMatch(/type TaskPriorityOption\b/)
    // note/tag stay fully surfaced
    expect(sdl).toContain('createNote(')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run task
```
Expected: FAIL — `Cannot query field "createTask" on type "Mutation"` (the custom task ops don't exist yet); the SDL test also fails (`createTask` absent from the printed schema).

- [ ] **Step 3: Implement — edit `schema.ts`**

Extend the `@movp/domain` import to add the `Page`, `TaskBoardColumn`, and `TaskRow` types (append to whatever collab already imports):
```ts
import { createDomain, resolveShareLink, type CollectionService, type Domain, type InboxItem, type Page, type SearchHit, type TaskBoardColumn, type TaskRow } from '@movp/domain'
```
The two `if (c.internal) continue` guards already skip `task`/`task_revision` (added in the collab phase — do NOT re-add). The `refs` map is still built for every collection, so `refs.has('task')` and `refs.get('task_status_option')` both resolve.

Add these object refs immediately after the collab refs (still inside `buildSchema`, before `return builder.toSchema()`), then the guarded block. The `task` objectRef was created but never implemented (the object-building loop skipped it), so — like collab's `comment` — the task surface owns and implements it here:
```ts
  // Collaboration-style task surface — only when the task collections are present.
  if (refs.has('task')) {
    const taskRef = refs.get('task')
    const statusRef = refs.get('task_status_option') // generic-surfaced; reuse its object type

    taskRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        title: t.exposeString('title', { complexity: 0 }),
        status_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.status_id == null ? null : String(r.status_id)) }),
        priority_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.priority_id == null ? null : String(r.priority_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        current_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.current_revision_id == null ? null : String(r.current_revision_id)) }),
        start_date: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.start_date == null ? null : String(r.start_date)) }),
        due_date: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.due_date == null ? null : String(r.due_date)) }),
        completed_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.completed_at == null ? null : String(r.completed_at)) }),
        dependency_blocked: t.boolean({ complexity: 0, resolve: (r: Row) => Boolean(r.dependency_blocked) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.exposeString('updated_at', { complexity: 0 }),
        // Description lives in the immutable task_revision (versioned). Resolve the
        // current revision body under the caller's RLS. Only selected on the DETAIL
        // query (a single task), so no N+1 on list/board — clients must NOT select
        // `description` in list/board results.
        description: t.field({
          type: 'String', nullable: true, complexity: 5,
          resolve: async (r: Row, _a: unknown, ctx: GraphQLContext) => {
            if (r.current_revision_id == null) return null
            const { data } = await ctx.db.from('task_revision').select('body').eq('id', String(r.current_revision_id)).maybeSingle()
            return (data as { body?: string } | null)?.body ?? null
          },
        }),
      }),
    })

    const taskPage = builder.objectRef<Page<TaskRow>>('TaskPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [taskRef], resolve: (p: Page<TaskRow>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<TaskRow>) => p.nextCursor ?? null }),
      }),
    })
    const taskBoardColumn = builder.objectRef<TaskBoardColumn>('TaskBoardColumn').implement({
      fields: (t: any) => ({
        status: t.field({ type: statusRef, resolve: (c: TaskBoardColumn) => c.status }),
        tasks: t.field({ type: [taskRef], resolve: (c: TaskBoardColumn) => c.tasks }),
      }),
    })

    builder.queryField('task', (t: any) =>
      t.field({
        type: taskRef, nullable: true, complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) => domainFrom(ctx).task.get(String(args.id)),
      }),
    )

    builder.queryField('tasks', (t: any) =>
      t.field({
        type: taskPage,
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          statusId: t.arg.id({ required: false }),
          assigneeId: t.arg.id({ required: false }),
          parentId: t.arg.id({ required: false }),
          topLevel: t.arg.boolean({ required: false }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.list({
            workspaceId: String(args.workspaceId),
            statusId: args.statusId ? String(args.statusId) : undefined,
            assigneeId: args.assigneeId ? String(args.assigneeId) : undefined,
            // topLevel=true -> parent_id IS NULL; else a specific parent; else any.
            parentId: args.topLevel ? null : (args.parentId ? String(args.parentId) : undefined),
            first: clampPageSize(args.first),
            after: args.after ?? undefined,
          }),
      }),
    )

    builder.queryField('taskBoard', (t: any) =>
      t.field({
        type: [taskBoardColumn], complexity: 10,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.board({ workspaceId: String(args.workspaceId) }),
      }),
    )

    builder.mutationField('createTask', (t: any) =>
      t.field({
        type: taskRef, complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          title: t.arg.string({ required: true }),
          description: t.arg.string({ required: false }),
          statusId: t.arg.id({ required: false }),
          priorityId: t.arg.id({ required: false }),
          parentId: t.arg.id({ required: false }),
          startDate: t.arg.string({ required: false }),
          dueDate: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.create({
            workspaceId: String(args.workspaceId),
            title: String(args.title),
            description: args.description ?? undefined,
            statusId: args.statusId ? String(args.statusId) : undefined,
            priorityId: args.priorityId ? String(args.priorityId) : undefined,
            parentId: args.parentId ? String(args.parentId) : undefined,
            startDate: args.startDate ?? undefined,
            dueDate: args.dueDate ?? undefined,
          }),
      }),
    )

    builder.mutationField('transitionTask', (t: any) =>
      t.field({
        type: taskRef, complexity: 5,
        args: { taskId: t.arg.id({ required: true }), statusId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.transition({ taskId: String(args.taskId), statusId: String(args.statusId) }),
      }),
    )

    builder.mutationField('updateTaskDescription', (t: any) =>
      t.field({
        type: taskRef, complexity: 10,
        args: { taskId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.updateDescription(String(args.taskId), String(args.body)),
      }),
    )

    // Boolean-returning membership/relation mutations. Each is written out inline
    // because the arg builder `t.arg.*` is only in scope inside a mutationField
    // callback — do NOT try to factor these into a shared helper that takes a
    // pre-built `args` object; `t.arg` would be out of scope there.
    builder.mutationField('assignTask', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => { await domainFrom(ctx).task.assign({ taskId: String(a.taskId), userId: String(a.userId) }); return true } }))
    builder.mutationField('unassignTask', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => { await domainFrom(ctx).task.unassign({ taskId: String(a.taskId), userId: String(a.userId) }); return true } }))
    builder.mutationField('addTaskObserver', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => { await domainFrom(ctx).task.addObserver({ taskId: String(a.taskId), userId: String(a.userId) }); return true } }))
    builder.mutationField('addTaskDependency', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5,
        args: { taskId: t.arg.id({ required: true }), blockerId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => { await domainFrom(ctx).task.addDependency({ taskId: String(a.taskId), blockerId: String(a.blockerId) }); return true } }))
    builder.mutationField('attachTask', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5,
        args: {
          taskId: t.arg.id({ required: true }),
          r2Key: t.arg.string({ required: true }),
          filename: t.arg.string({ required: true }),
          contentType: t.arg.string({ required: false }),
          bytes: t.arg.int({ required: false }),
        },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.attach({ taskId: String(a.taskId), r2Key: String(a.r2Key), filename: String(a.filename), contentType: a.contentType ?? undefined, bytes: a.bytes ?? undefined })
          return true
        } }))

    // Task discussion read. 05b surfaced `addComment` but NO comments-list query, so the
    // detail page's thread has no source. Surface the existing `collab.comment.listByEntity`
    // as a `comments` query. `refs.get('comment')` is the objectRef the committed collab
    // block already implements (that block runs before this one), so it is safe to use as a
    // field type here. Returns the first page of the thread (items); pass first/after to page.
    builder.queryField('comments', (t: any) =>
      t.field({
        type: [refs.get('comment')], complexity: 10, nullable: false,
        args: {
          workspaceId: t.arg.id({ required: true }),
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          const page = await domainFrom(ctx).collab.comment.listByEntity({
            workspaceId: String(a.workspaceId),
            entityType: String(a.entityType),
            entityId: String(a.entityId),
            first: a.first ?? undefined,
            after: a.after ?? null,
          })
          return page.items
        },
      }),
    )
  }
```

Note: the `comments` query resolves through `collab.comment.listByEntity`, which is why Step 1's `vi.mock('@movp/domain')` returns a `collab.comment.listByEntity` stub alongside `task` and the test has a fifth `it(...)` asserting the thread — both are already in the test block above (no extra editing needed).

> **Gotcha — `description` reads an internal table directly.** The `description` field resolver is the ONE place a surface reads `task_revision` (internal) directly, via `ctx.db` under the caller's RLS. This is intentional (the versioned body the domain create/update own). Keep it OFF list/board selections to avoid an N+1; the frontend selects `description` only on the single-task detail query.

- [ ] **Step 4: Run the test + typecheck + the existing schema gate**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `task.test.ts` (5, incl. the `comments` query) AND the existing `schema.test.ts` + `relations.test.ts` + collab test still green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/graphql/src/schema.ts packages/graphql/test/task.test.ts
git commit -m "feat(graphql): task/tasks/taskBoard queries + createTask/transitionTask/updateTaskDescription/assign/observer/dependency/attach"
```

---

### Task 4: MCP surface — custom task tools

Add `task.create`, `task.get`, `task.list`, `task.board`, `task.assign`, `task.transition`, `task.add_dependency`, `task.update_description` to `packages/mcp/src/server.ts` via `registerTool`, after the generated-tool loop. The existing `if (c.internal) continue` guard (collab phase) already skips `task`/`task_revision`, so no generic `task.create` collides with the custom one. The two option config tables ARE generic-surfaced, so `buildMcpServer` resolves a `service()` for them at build time — the test mock must therefore provide `note`/`tag`/`task_status_option`/`task_priority_option` CRUD stubs plus a `task` stub for the custom tools.

**Files:**
- Edit: `packages/mcp/src/server.ts`
- Edit: `packages/mcp/test/server.test.ts`

- [ ] **Step 1: Update + extend the test (red)**

In `packages/mcp/test/server.test.ts`, extend the mocked `createDomain` return: add `task_status_option: crud()`, `task_priority_option: crud()` (buildMcpServer resolves a service for every NON-internal collection at build time), plus a `task` object. Add task-specific fakes at the top:
```ts
const taskCreate = vi.fn(async () => ({ id: 't1', title: 'Ship it', status_id: 's1' }))
const taskBoard = vi.fn(async () => [{ status: { id: 's1', label: 'Todo' }, tasks: [{ id: 't1' }] }])
```
Add to the mocked domain (alongside `note`, `tag`, `search`, `graph`, `collab`):
```ts
    // Generic-surfaced option tables need a build-time service (like note/tag).
    task_status_option: crud(),
    task_priority_option: crud(),
    // `task` is internal — no generic tool; the custom task tools use `task`.
    task: {
      create: taskCreate,
      get: vi.fn(async () => ({ id: 't1' })),
      list: vi.fn(async () => ({ items: [{ id: 't1' }], nextCursor: null })),
      board: taskBoard,
      assign: vi.fn(async () => undefined),
      unassign: vi.fn(), addObserver: vi.fn(), removeObserver: vi.fn(),
      transition: vi.fn(async () => ({ id: 't1', status_id: 's2' })),
      addDependency: vi.fn(async () => undefined),
      removeDependency: vi.fn(),
      updateDescription: vi.fn(async () => ({ id: 't1' })),
      attach: vi.fn(),
    },
```
Add a task-tools test case inside `describe('buildMcpServer', …)`:
```ts
  it('registers and calls the custom task tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['task.create', 'task.get', 'task.list', 'task.board', 'task.assign', 'task.transition', 'task.add_dependency', 'task.update_description']))
    // internal task_revision gets NO generic CRUD tool; option tables DO
    expect(names).not.toContain('task_revision.create')
    expect(names).toEqual(expect.arrayContaining(['task_status_option.create', 'task_priority_option.create']))

    const createRes = await client.callTool({ name: 'task.create', arguments: { workspaceId: 'w', title: 'Ship it' } })
    expect(taskCreate).toHaveBeenCalledWith({ workspaceId: 'w', title: 'Ship it', description: undefined, statusId: undefined, priorityId: undefined, parentId: undefined, startDate: undefined, dueDate: undefined })
    expect(JSON.stringify(createRes.content)).toContain('t1')

    const boardRes = await client.callTool({ name: 'task.board', arguments: { workspaceId: 'w' } })
    expect(taskBoard).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(JSON.stringify(boardRes.content)).toContain('s1')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run server
```
Expected: FAIL — `task.create` (etc.) absent from `tools/list`, so the `arrayContaining([...])` assertion fails and the `callTool({ name: 'task.create' })` rejects with `Tool task.create not found`.

- [ ] **Step 3: Implement — edit `server.ts`**

The `if (c.internal) continue` guard already exists at the top of the generated-tool loop (collab phase) — do NOT re-add. After that loop and before `return server`, add:
```ts
  // Custom task tools (non-CRUD; the `task` collection is internal). domain.task is
  // provided by createDomain.
  server.registerTool(
    'task.create',
    {
      title: 'Create task',
      description: 'Create a task (status/priority default to the workspace defaults when omitted)',
      inputSchema: {
        workspaceId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        statusId: z.string().optional(),
        priorityId: z.string().optional(),
        parentId: z.string().optional(),
        startDate: z.string().optional(),
        dueDate: z.string().optional(),
      },
    },
    async ({ workspaceId, title, description, statusId, priorityId, parentId, startDate, dueDate }) =>
      text(await domain.task.create({ workspaceId, title, description, statusId, priorityId, parentId, startDate, dueDate })),
  )

  server.registerTool(
    'task.get',
    { title: 'Get task', description: 'Fetch a task by id', inputSchema: { id: z.string() } },
    async ({ id }) => text(await domain.task.get(id)),
  )

  server.registerTool(
    'task.list',
    {
      title: 'List tasks',
      description: 'List tasks in a workspace, optionally filtered by status or assignee',
      inputSchema: {
        workspaceId: z.string(),
        statusId: z.string().optional(),
        assigneeId: z.string().optional(),
        parentId: z.string().optional(),
        first: z.number().optional(),
      },
    },
    async ({ workspaceId, statusId, assigneeId, parentId, first }) =>
      text(await domain.task.list({ workspaceId, statusId, assigneeId, parentId, first })),
  )

  server.registerTool(
    'task.board',
    { title: 'Task board', description: 'Kanban columns (active statuses) with their tasks', inputSchema: { workspaceId: z.string() } },
    async ({ workspaceId }) => text(await domain.task.board({ workspaceId })),
  )

  server.registerTool(
    'task.assign',
    { title: 'Assign task', description: 'Assign a user to a task (idempotent)', inputSchema: { taskId: z.string(), userId: z.string() } },
    async ({ taskId, userId }) => {
      await domain.task.assign({ taskId, userId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'task.transition',
    { title: 'Transition task', description: 'Move a task to a status', inputSchema: { taskId: z.string(), statusId: z.string() } },
    async ({ taskId, statusId }) => text(await domain.task.transition({ taskId, statusId })),
  )

  server.registerTool(
    'task.add_dependency',
    { title: 'Add task dependency', description: 'Mark a task as blocked by another (idempotent)', inputSchema: { taskId: z.string(), blockerId: z.string() } },
    async ({ taskId, blockerId }) => {
      await domain.task.addDependency({ taskId, blockerId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'task.update_description',
    { title: 'Update task description', description: 'Replace a task description (dedupes an identical body)', inputSchema: { taskId: z.string(), body: z.string() } },
    async ({ taskId, body }) => text(await domain.task.updateDescription(taskId, body)),
  )
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run && pnpm --filter @movp/mcp typecheck
```
Expected: PASS — the new `it` block plus the existing note/search + collab blocks green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/mcp/src/server.ts packages/mcp/test/server.test.ts
git commit -m "feat(mcp): custom task tools (create/get/list/board/assign/transition/add_dependency/update_description)"
```

---

### Task 5: CLI surface — `movp task` command group

Add a `task` command group (`create`, `list`, `board`, `assign`, `transition`, `depend`, `describe`) to `packages/cli/src/program.ts`, using `createDomain(resolveCtx()).task`. The existing `if (c.internal) continue` guard (collab phase) already skips the internal `task`/`task_revision` collections, so no generic `movp task` group collides with the custom one. The option config tables get their own generic `movp task_status_option …` / `movp task_priority_option …` groups (no work needed).

**Files:**
- Edit: `packages/cli/src/program.ts`
- Edit: `packages/cli/test/program.test.ts`

- [ ] **Step 1: Extend the test (red)**

In `packages/cli/test/program.test.ts`, add task fakes at the top (next to the existing `noteCreate`/`search` consts):
```ts
const taskCreate = vi.fn(async () => ({ id: 't1', title: 'Ship it' }))
const taskList = vi.fn(async () => ({ items: [{ id: 't1' }], nextCursor: null }))
const taskBoard = vi.fn(async () => [{ status: { id: 's1' }, tasks: [{ id: 't1' }] }])
```
Add a `task` object to the mocked `createDomain` return (alongside `note`, `tag`, `search`, `graph`, `collab`):
```ts
    task: {
      create: taskCreate, get: vi.fn(), list: taskList, board: taskBoard,
      assign: vi.fn(async () => undefined), unassign: vi.fn(), addObserver: vi.fn(), removeObserver: vi.fn(),
      transition: vi.fn(async () => ({ id: 't1', status_id: 's2' })), addDependency: vi.fn(async () => undefined), removeDependency: vi.fn(),
      updateDescription: vi.fn(async () => ({ id: 't1' })), attach: vi.fn(),
    },
```
Add test cases inside `describe('movp CLI', …)`:
```ts
  it('task create routes to task.create', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'task', 'create', '--workspace', 'w', '--title', 'Ship it'])
    expect(taskCreate).toHaveBeenCalledWith({ workspaceId: 'w', title: 'Ship it', description: undefined, statusId: undefined, priorityId: undefined, parentId: undefined, startDate: undefined, dueDate: undefined })
    expect(out[0]).toContain('t1')
  })

  it('task list and task board print results', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'task', 'list', '--workspace', 'w'])
    expect(taskList).toHaveBeenCalledWith({ workspaceId: 'w', statusId: undefined, assigneeId: undefined })
    expect(out[0]).toContain('t1')
    const p2 = program()
    await p2.cmd.parseAsync(['node', 'movp', 'task', 'board', '--workspace', 'w'])
    expect(taskBoard).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(p2.out[0]).toContain('s1')
  })

  it('surfaces the custom task group but NO generic CRUD group for internal task/task_revision', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    expect(top).not.toContain('task_revision')
    // option config tables ARE generic-surfaced; the custom task group exists
    expect(top).toEqual(expect.arrayContaining(['task', 'task_status_option', 'task_priority_option']))
    // the `task` group is the CUSTOM one: exactly these subcommands
    const task = cmd.commands.find((c) => c.name() === 'task')
    expect(task?.commands.map((s) => s.name())).toEqual(['create', 'list', 'board', 'assign', 'transition', 'depend', 'describe'])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/cli exec vitest run program
```
Expected: FAIL — commander errors on the unknown `task create` subcommand (`error: unknown command 'task create'`), and the custom-group assertion fails (no `task` group with those subcommands yet).

- [ ] **Step 3: Implement — edit `program.ts`**

The `if (c.internal) continue` guard already exists at the top of the generated-command loop (collab phase) — do NOT re-add. After that loop and before `program.command('search <query>')`, add:
```ts
  const taskCmd = program.command('task').description('Manage tasks')
  taskCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--title <text>', 'task title')
    .option('--description <text>', 'initial description')
    .option('--status <id>', 'status option id (defaults to workspace default)')
    .option('--priority <id>', 'priority option id (defaults to workspace default)')
    .option('--parent <id>', 'parent task id')
    .option('--start <date>', 'start date (YYYY-MM-DD)')
    .option('--due <date>', 'due date (YYYY-MM-DD)')
    .action(async (o: { workspace: string; title: string; description?: string; status?: string; priority?: string; parent?: string; start?: string; due?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.create({
        workspaceId: o.workspace, title: o.title, description: o.description,
        statusId: o.status, priorityId: o.priority, parentId: o.parent, startDate: o.start, dueDate: o.due,
      })))
    })
  taskCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--status <id>', 'filter by status option id')
    .option('--assignee <id>', 'filter by assignee user id')
    .action(async (o: { workspace: string; status?: string; assignee?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.list({ workspaceId: o.workspace, statusId: o.status, assigneeId: o.assignee })))
    })
  taskCmd
    .command('board')
    .requiredOption('--workspace <id>', 'workspace id')
    .action(async (o: { workspace: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.board({ workspaceId: o.workspace })))
    })
  taskCmd
    .command('assign')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'assignee user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(resolveCtx())
      await domain.task.assign({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('transition')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--status <id>', 'target status option id')
    .action(async (o: { task: string; status: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.transition({ taskId: o.task, statusId: o.status })))
    })
  taskCmd
    .command('depend')
    .requiredOption('--task <id>', 'blocked task id')
    .requiredOption('--blocker <id>', 'blocking task id')
    .action(async (o: { task: string; blocker: string }) => {
      const domain = createDomain(resolveCtx())
      await domain.task.addDependency({ taskId: o.task, blockerId: o.blocker })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('describe')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--body <text>', 'new description body')
    .action(async (o: { task: string; body: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.updateDescription(o.task, o.body)))
    })
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/cli exec vitest run && pnpm --filter @movp/cli typecheck
```
Expected: PASS — the three new task cases plus the existing note/search + collab cases green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/cli/src/program.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp task group (create/list/board/assign/transition/depend/describe)"
```

---

### Task 6: Frontend — task list, detail, board + inbox Assigned tab

**Files:**
- Create: `templates/frontend-astro/src/lib/task-queries.ts`
- Create: `templates/frontend-astro/src/pages/tasks/index.astro`, `templates/frontend-astro/src/pages/tasks/[id].astro`, `templates/frontend-astro/src/pages/tasks/board.astro`, `templates/frontend-astro/src/pages/inbox.astro`
- Test: `templates/frontend-astro/tests/tasks.spec.ts`

**Interfaces:**
- Consumes (all already in the template — mirror `src/pages/index.astro` / `notes/[id].astro`): `gqlRequest<T>({ endpoint, token, query, variables })` from `src/lib/graphql.ts`; `getSessionToken(cookies)` from `src/lib/session.ts`; `readServerEnv() -> { graphqlEndpoint, workspaceId }` from `src/lib/env.ts`; `Base.astro` layout; the state components `src/components/states/{AuthFailure,LoadingState,EmptyState,ErrorRetry}.astro`. GraphQL ops from Task 3 (`tasks` — including its `parentId` arg, used for subtasks — `task`, `taskBoard`, `comments`, `createTask`, `assignTask`, `transitionTask`, `updateTaskDescription`) + `inbox(workspaceId, tab)` (Part B). **Detail-page scope (load-bearing):** the detail page renders the task fields + `description` (`TASK_QUERY`), the discussion thread (`comments`), and subtasks (`tasks(parentId:)`) — all three are concretely queryable and gated. **Assignee / observer / dependency DISPLAY is explicitly deferred**: there is no GraphQL read for a task's assignees/observers/blockers yet (only filters + write ops), and their write paths + RLS + notifications are already built and tested at the DB/service/e2e layers. A richer detail view is a documented follow-up, NOT part of this gate.
- **Boundary (load-bearing):** no `@movp/auth`/`@movp/domain`/service-role imports — GraphQL over HTTP only. `bash scripts/check-boundary.sh` stays green.

- [ ] **Step 1: GraphQL documents** — `src/lib/task-queries.ts` exporting the query/mutation strings the pages use (mirror `src/lib/*` doc style):
```ts
export const TASKS_QUERY = /* GraphQL */ `
  query Tasks($workspaceId: ID!, $first: Int) {
    tasks(workspaceId: $workspaceId, first: $first) { items { id title status_id due_date } nextCursor }
  }`
export const TASK_BOARD_QUERY = /* GraphQL */ `
  query TaskBoard($workspaceId: ID!) {
    taskBoard(workspaceId: $workspaceId) { status { id label category sort_order } tasks { id title due_date } }
  }`
export const TASK_QUERY = /* GraphQL */ `
  query Task($id: ID!) {
    task(id: $id) { id title description status_id priority_id parent_id due_date dependency_blocked completed_at }
  }`
export const INBOX_QUERY = /* GraphQL */ `
  query Inbox($workspaceId: ID!, $tab: String!) {
    inbox(workspaceId: $workspaceId, tab: $tab) { kind entity_type entity_id ref_id created_at }
  }`
export const COMMENTS_QUERY = /* GraphQL */ `
  query Comments($workspaceId: ID!, $entityType: String!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: $entityType, entityId: $entityId) { id body author_id created_at }
  }`
export const SUBTASKS_QUERY = /* GraphQL */ `
  query Subtasks($workspaceId: ID!, $parentId: ID!) {
    tasks(workspaceId: $workspaceId, parentId: $parentId) { items { id title status_id } nextCursor }
  }`
```

- [ ] **Step 2: Failing Playwright/axe test** — `tests/tasks.spec.ts` mirroring the notes/search spec. In setup, seed one task that has a `description`, one comment (via `addComment` on `entityType:'task'`), and one subtask (a task with `parentId` = the seeded task) so the detail assertions have data. Cases: `/tasks` shows the auth-failure view with no cookie; with a seeded session it lists tasks; `/tasks/board` renders status columns; **`/tasks/<seededId>` (detail) renders the task title, the `description`, the discussion thread (at least one comment), and the subtasks section (at least one subtask)**; `/inbox?tab=assigned` shows the Assigned tab; an axe smoke pass over `/tasks`, `/tasks/board`, **`/tasks/<seededId>`**, and `/inbox`.
Run: `pnpm --filter @movp/frontend-astro exec playwright test tasks` → Expected: FAIL (routes 404 — pages not created).

- [ ] **Step 3: Implement the pages** — each Astro page mirrors `src/pages/index.astro`: read `token = getSessionToken(Astro.cookies)`; if `!token` render `AuthFailure`; else `const { graphqlEndpoint, workspaceId } = readServerEnv()`, `try { const r = await gqlRequest(...) } catch { render ErrorRetry }`, render `EmptyState` when the list is empty. `tasks/index.astro` → `TASKS_QUERY` list; `tasks/board.astro` → `TASK_BOARD_QUERY` rendering one column per status (ordered by `sort_order`) with its `tasks`; `tasks/[id].astro` → `TASK_QUERY` (task fields + `description`) + `COMMENTS_QUERY` (discussion thread, `entityType: "task"`, `entityId` = the id) + `SUBTASKS_QUERY` (`tasks(parentId:` the id `)`) — renders the task, its description, the discussion, and its subtasks (assignee/observer/dependency display is deferred per the Interfaces note — no read surface yet); `inbox.astro` → tabs `all|mentions|saved|assigned` (from `Astro.url.searchParams.get('tab') ?? 'all'`) running `INBOX_QUERY`. Keyboard-focusable nav + `aria-current` on the active inbox tab.
Run: `pnpm --filter @movp/frontend-astro exec playwright test tasks` → Expected: PASS (incl. axe).

- [ ] **Step 4: Boundary + build gate**
Run: `bash scripts/check-boundary.sh && pnpm --filter @movp/frontend-astro build`
Expected: boundary grep clean; Astro build succeeds (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`).

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/task-queries.ts templates/frontend-astro/src/pages/tasks templates/frontend-astro/src/pages/inbox.astro templates/frontend-astro/tests/tasks.spec.ts
git commit -m "feat(frontend): task list/detail/board + inbox Assigned tab"
```

---

### Task 7: End-to-end task slice

**Files:**
- Modify: `scripts/slice-e2e.sh` (add a `[task]` section BEFORE the final `== [8] internal not exposed ==` / `slice-e2e: PASS` lines)

> The **domain** integration test is Task 2's `packages/domain/test/task.integration.test.ts` (it already exercises create-defaults → assign → inbox → dependency-blocks → transition-completes → description-dedupe → comment → cross-workspace). Task 7 does NOT re-create it — Step 2's gate re-runs it. Task 7's new work is the GraphQL-surface end-to-end slice.

**Interfaces:**
- Consumes the committed slice helpers/vars EXACTLY as the current `scripts/slice-e2e.sh` defines them: `post_graphql` (uses the owner's global `$TOKEN`), `json_get`, `psql "$DB_URL"`, `$API_URL`, `$ANON_KEY`, and the already-provisioned `$WS` (workspace id), `$USER2_ID` (a second member's id), `$TOKEN2` (that member's JWT). **Do NOT invent `$WS_ID`/`$MEMBER2_ID` — those names do not exist in the script.** Also consumes the task GraphQL surface (Task 3), Part B triggers, and `inbox_feed('assigned')`.

- [ ] **Step 1: Add the `[task]` section to `scripts/slice-e2e.sh`** (insert immediately before the `echo "== [8] internal not exposed via PostgREST API =="` line), mirroring the `[collab]` blocks:
```bash
echo "== [task] create a task (workspace defaults applied) =="
TASK="$(post_graphql "{\"query\":\"mutation{createTask(workspaceId:\\\"$WS\\\", title:\\\"E2E task\\\"){id status_id current_revision_id}}\"}")"
TASK_ID="$(echo "$TASK" | json_get data.createTask.id)"
[ -n "$TASK_ID" ] || { echo "createTask failed: $TASK"; exit 1; }

echo "== [task] assign USER2 -> a task.assigned notify job carries recipient_user_id =="
post_graphql "{\"query\":\"mutation{assignTask(taskId:\\\"$TASK_ID\\\", userId:\\\"$USER2_ID\\\")}\"}" >/dev/null
ASSIGN_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='notify' and payload->>'event'='task.assigned' and payload->>'recipient_user_id'='$USER2_ID';")"
[ "$(echo "$ASSIGN_JOBS" | tr -d '[:space:]')" -ge 1 ] || { echo "no task.assigned notify for USER2 (got $ASSIGN_JOBS)"; exit 1; }

echo "== [task] inbox Assigned lists the task for USER2 (queried AS USER2) =="
INBOX="$(curl -sS "$API_URL/functions/v1/graphql" \
  -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d "{\"query\":\"query{inbox(workspaceId:\\\"$WS\\\", tab:\\\"assigned\\\"){entity_id}}\"}")"
echo "$INBOX" | grep -q "$TASK_ID" || { echo "inbox assigned did not include the task: $INBOX"; exit 1; }

echo "== [task] transition to a done-category status -> completed_at + history + task.completed =="
DONE_ID="$(psql "$DB_URL" -tAc "select id from public.task_status_option where workspace_id='$WS' and category='done' limit 1;" | tr -d '[:space:]')"
[ -n "$DONE_ID" ] || { echo "no done-category status option seeded for WS"; exit 1; }
post_graphql "{\"query\":\"mutation{transitionTask(taskId:\\\"$TASK_ID\\\", statusId:\\\"$DONE_ID\\\"){id completed_at}}\"}" | grep -q 'completed_at' || { echo "transition failed"; exit 1; }
HIST="$(psql "$DB_URL" -tAc "select count(*) from public.task_status_history where task_id='$TASK_ID';")"
[ "$(echo "$HIST" | tr -d '[:space:]')" -ge 1 ] || { echo "no task_status_history row (got $HIST)"; exit 1; }
COMPLETED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='task.completed' and payload->>'entity_id'='$TASK_ID';")"
[ "$(echo "$COMPLETED" | tr -d '[:space:]')" -ge 1 ] || { echo "no task.completed event (got $COMPLETED)"; exit 1; }
```

- [ ] **Step 2: Gate**

Run:
```bash
bash -n scripts/slice-e2e.sh && pnpm --filter @movp/domain exec vitest run task.integration && bash scripts/slice-e2e.sh
```
Expected: `bash -n` clean (no syntax error); Task 2's `task.integration.test.ts` green; the slice ends `slice-e2e: PASS` with the four `[task]` assertions passing.

- [ ] **Step 3: Commit**
```bash
git add scripts/slice-e2e.sh
git commit -m "test(e2e): task lifecycle GraphQL slice"
```

---

## Self-Review

- **Spec coverage (Part C scope):** the two `SECURITY INVOKER` RPCs `create_task_with_revision`/`update_task_description` (Task 1); `makeTaskService` + `createDomain` wiring + integration test (Task 2); GraphQL custom `task`/`tasks`/`taskBoard` + `createTask`/`assignTask`/`transitionTask`/`updateTaskDescription`/… under `if (refs.has('task'))` (Task 3); MCP `task.*` tools (Task 4); CLI `movp task` group (Task 5); the Astro list/detail/board + inbox Assigned tab (Task 6); the end-to-end GraphQL task slice (Task 7 — the domain integration test lives in Task 2 and is re-run as Task 7's gate). Each task ends in a machine-checkable gate.
- **Correctness:** `create` defaults `statusId`/`priorityId` to the workspace `is_default` active option; `updateDescription` dedupes by `content_hash` (a repeat identical body yields no new revision); `transition` is a plain `status_id` update so Part B's trigger owns the event + history; task discussion reuses the existing `collab` service (comments on `entity_type='task'`, enabled by Part A's `can_access_entity('task')` arm).
- **Safety:** both RPCs are `SECURITY INVOKER` with `set search_path=''` so Part A's RLS (workspace membership; immutable revision; assignee-must-be-member) is authoritative; `task` is `internal` so no generic CRUD bypasses the service; the frontend honors the boundary rule (GraphQL over HTTP only, no privileged imports) — `check-boundary.sh` + `check-definer-audit.mjs` stay green.
- **Reliability:** `assign`/`addObserver` are idempotent `upsert`s (`ignoreDuplicates`) mirroring the collab react/save fix, so a double-assign is a no-op; the create RPC is atomic (task + revision + pointer in one transaction).
- **Observability / Efficiency / Performance:** events/notify come from Part B (N/A here beyond asserting the `task.assigned` recipient in e2e); `board` reads the indexed `task(workspace_id,status_id)`; list uses keyset pagination; no duplicate fetches.
- **Simplicity / Usability:** the service is the single write path; three surfaces + a frontend cover the flows; option tables stay generically surfaced for admin config.
- **Placeholder scan:** the frontend page bodies and the integration-test body are described against the real committed template/harness files (`gqlRequest`/`getSessionToken`/`readServerEnv`/`Base.astro`/state components; `collab.integration.test.ts` helpers) and the `[collab]` slice pattern — the executor mirrors those existing files; all commands + expected outputs are concrete.

---
