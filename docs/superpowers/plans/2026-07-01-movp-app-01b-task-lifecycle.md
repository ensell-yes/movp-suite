# MOVP App — Task Management Phase 3, Part B: Lifecycle, Transitions, Events & Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the task collections built in Part A into the async event/notification backbone. Hand-author migration `20260701000009_task_lifecycle.sql` (sorts after Part A) to: (1) re-declare `public.emit_event` with a notify-enqueue guard so only recipient-bearing events schedule a notify job; (2) install AFTER-INSERT lifecycle triggers (`task.created`, `task.assigned`, `task.observer_added`); (3) install a category-keyed status-transition trigger (`task.completed`/`task.reopened`/`task.status_changed`, `completed_at` set/clear, a `task_status_history` row per transition); (4) add `public.recompute_task_blocked(uuid)` + dependency/status triggers emitting `task.dependency_blocked` on a false→true flip; (5) add `public.emit_due_soon()` (a scan the deploy-time cron calls); and (6) re-declare `public.inbox_feed` with an `assigned` tab. The notify worker is unchanged — it already resolves `payload.recipient_user_id` → email.

**Architecture:** Part A generated the config-first task tables (`task`, `task_status_option`, `task_assignment`, `task_observer`, `task_dependency`, `task_status_history`) with blanket RLS. This Part B is **DB-only, hand-authored** — no collections change and no codegen runs. All fan-out goes through the existing `public.emit_event(ev_type, ws, payload, trace)`, which writes `movp_internal.movp_events` and enqueues `movp_internal.movp_jobs` (`notify`/`webhook`) with `on conflict (kind, idempotency_key) do nothing`. The **notify guard** added to `emit_event` gates the notify-job enqueue on `payload ? 'recipient_user_id' or payload ? 'email'`, so audit-only events (`task.created`, `task.status_changed`) record + webhook but never notify. **Every recipient-bearing event uses `payload.id = task_id || ':' || recipient_user_id`** (a unique notify key per recipient) with `entity_type='task'` and `entity_id=task_id` (the bare task, for inbox `all`). Single-target events (`task.assigned` → the assignee, `task.observer_added` → the observer) emit ONE such event with `recipient_user_id` = that user — the per-recipient key is what lets **multi-owner** notify EVERY owner (a bare `task_id` key would dedupe the 2nd assignee). **Multi-recipient** events (`task.completed`, `task.reopened`, `task.dependency_blocked`, `task.due_soon`) fan out to the DISTINCT union of each **owner** (`task_assignment.role='owner'`) + each **observer**, emitting ONE event PER recipient with the same payload shape. All transition/blocked logic keys on `task_status_option.category` (backlog/active/blocked/done), **never the label**.

**Tech Stack:** Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` triggers + functions, the existing `public.emit_event` / `movp_internal.{movp_events,movp_jobs,webhooks}` async backbone, `public.is_workspace_member` / `public.inbox_feed` (from the collaboration inbox migration), the definer-audit gate (`node scripts/check-definer-audit.mjs`), and the notify worker (`packages/flows/src/flows-worker.ts`, unchanged).

**This is Part B of the Task Management Phase 3 series.** It depends on **Part A** (the six task collections + their generated tables and blanket RLS), on the async RPC backbone (`public.emit_event`, `movp_internal.movp_events`/`movp_jobs`/`webhooks`), and on the collaboration inbox (`public.inbox_feed`, `public.is_workspace_member`). Downstream consumers depend on the **event names verbatim** (`task.created`, `task.assigned`, `task.observer_added`, `task.status_changed`, `task.completed`, `task.reopened`, `task.due_soon`, `task.dependency_blocked`) and on the `recipient_user_id` payload field — do not rename either without updating the notify worker and any webhook subscribers.

## Global Constraints

- **Hand-authored migration only — no codegen.** Part A already generated the task tables. This part adds no collection and runs no `pnpm codegen`; it is one hand-authored SQL migration plus one pgTAP file. Do NOT hand-edit any generated migration.
- **Exact filename, not `supabase migration new`.** The migration MUST be `supabase/migrations/20260701000009_task_lifecycle.sql` (a wall-clock timestamp from `supabase migration new` would sort wrong). It is built up top-to-bottom across Tasks 1–6, in dependency order: `emit_event` (used by every trigger) → insert-event triggers → status-transition trigger → `recompute_task_blocked` + dependency triggers → `emit_due_soon` → `inbox_feed`.
- **All `SECURITY DEFINER` functions hardened.** Every function: `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` for trigger and internal functions. The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits SQL on `create ... function` and FAILS any `security definer` block missing `set search_path =`. Every function below sets it — do not drop the clause.
- **`create or replace` preserves privileges.** Re-declaring `public.emit_event` and `public.inbox_feed` with `create or replace` keeps their existing `grant execute ... to authenticated` from the prior migrations. Do NOT add or remove grants on these two.
- **Notify guard is the only change to `emit_event` semantics.** The event insert and the webhook enqueue are byte-for-byte unchanged; the guard only conditions the `notify` enqueue on the payload carrying a `recipient_user_id` (or `email`).
- **Event names are verbatim** (see the list above). Payload discipline: ids + entity refs + `recipient_user_id` where a notify is intended; never free-text/PII beyond what the row already contains (`title` is the row's own title).
- **Fan-out rule.** EVERY recipient-bearing event uses `payload.id = task_id || ':' || recipient_user_id` (unique notify key per recipient) with `entity_id = task_id`. Single-target (`task.assigned`/`task.observer_added`) → one such event for the assignee/observer. Multi-recipient → one event per DISTINCT (owner ∪ observer). The recipient set comes from `public.task_notify_recipients(uuid)`, a `SECURITY DEFINER` function so the recipient list is authoritative and does NOT depend on the acting user's RLS visibility.
- **Transitions key on `category`, not label.** Completed = to-category `done` while from-category ≠ `done`; reopened = from-category `done` while to-category ≠ `done`. A task is dependency-blocked iff it has any blocker whose status category ≠ `done`.
- **`movp_internal` is not reachable by `authenticated`.** Triggers write it only through the `SECURITY DEFINER` `emit_event`; pgTAP reads `movp_internal.movp_events`/`movp_jobs` as the table owner (the default test role), never as `authenticated`.
- **Deploy-time cron is NOT committed.** `emit_due_soon()` is committed; the `cron.schedule(...)` that calls it (with any Vault-held key) is applied out-of-band at deploy time so `supabase db diff` stays empty. pgTAP/e2e call `select public.emit_due_soon()` directly.
- **No worker change.** `packages/flows/src/flows-worker.ts` already resolves `payload.recipient_user_id` → email via `db.auth.admin.getUserById`. This part touches no TypeScript.
- **pgTAP built incrementally.** One file, `plan(N)` bumped 2 → 6 → 14 → 18 → 21 → 23 as each task inserts its block immediately BEFORE the single `select * from finish();`.

## File Structure

```
supasuite/
  supabase/
    migrations/
      20260701000009_task_lifecycle.sql   # NEW hand-authored (built up across Tasks 1–6)
    tests/
      task_lifecycle_test.sql             # NEW pgTAP (built up across Tasks 1–6)
```

**Per-task apply gate (every task ends with it):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: migration applies, `task_lifecycle_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing.

---

### Task 1: `emit_event` notify-enqueue guard + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000009_task_lifecycle.sql`
- Create: `supabase/tests/task_lifecycle_test.sql`

**Interfaces:**
- Consumes: the committed `public.emit_event` (from the async-RPC migration), `movp_internal.{movp_events,movp_jobs,webhooks}`, `public.workspace`.
- Produces: `public.emit_event` re-declared with the notify guard. Invariant: a recipient-bearing payload enqueues exactly one `notify` job; a recipient-less payload enqueues none. Event insert + webhook enqueue unchanged.

- [ ] **Step 1: Write the failing pgTAP (red)**

Create `supabase/tests/task_lifecycle_test.sql` with the shared seed + Task 1 block. `plan(2)` now; later tasks bump it. Fixtures used throughout: workspace **W1**, member **A** (`aaaa…`, task owner), member **D** (`dddd…`, observer), member **C** (`cccc…`, unassigned — for the Task 6 negative), and three status options whose **labels differ from their categories** (proving category-keyed logic): `Backlog`(backlog), `In Progress`(active), `Shipped`(done).
```sql
begin;
select plan(2);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','dddddddd-dddd-dddd-dddd-dddddddddddd','member'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','member');
-- NOTE: inserting the workspace above fired Part A's AFTER-INSERT seed trigger, which already
-- created W1's default status + priority options (a Backlog status and a Medium priority, each
-- is_default=true). So these fixed-id fixtures are is_default=FALSE — a 2nd is_default in the
-- same workspace would violate the one-default-per-workspace partial unique. Tasks below use
-- these ids EXPLICITLY (no defaulting), so is_default does not matter for them.
-- labels intentionally != categories, so category-keyed logic is label-agnostic.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('0000000b-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Backlog','backlog',0,false,true),
  ('0000000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','In Progress','active',1,false,true),
  ('0000000d-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Shipped','done',2,false,true);
-- priority is a REQUIRED relation (task.priority_id is NOT NULL) — seed ONE option and
-- reference it on every task insert below. rank is NUMERIC; is_default=false (see note above).
insert into public.task_priority_option (id, workspace_id, label, rank, sort_order, is_default, is_active) values
  ('0000000e-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Normal',5,0,false,true);
-- auth.uid() reads request.jwt.claims regardless of DB role; set it so
-- task_status_history.changed_by resolves to A during status-transition tests.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- ── Task 1: emit_event notify guard ─────────────────────────────────────────
-- recipient-bearing payload -> exactly one notify job
select public.emit_event('task.assigned','11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id','deadbeef-0000-0000-0000-000000000000',
                     'recipient_user_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  gen_random_uuid()::text);
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key='task.assigned:deadbeef-0000-0000-0000-000000000000'),
          1, 'an event carrying recipient_user_id enqueues exactly one notify job');
-- recipient-less payload -> no notify job
select public.emit_event('task.created','11111111-1111-1111-1111-111111111111',
  jsonb_build_object('id','feedface-0000-0000-0000-000000000000'),
  gen_random_uuid()::text);
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'task.created:%'),
          0, 'an event with no recipient enqueues no notify job');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — with only Part A + prior migrations applied (no `000009` yet), the pre-guard `emit_event` enqueues a `notify` job unconditionally, so the **recipient-less** assertion returns `1`, not `0`. The recipient-bearing assertion passes. (1 failing assertion.)

- [ ] **Step 3: Create the migration with the guarded `emit_event` (green)**

Create `supabase/migrations/20260701000009_task_lifecycle.sql` (exact path — do NOT use `supabase migration new`):
```sql
-- Task Management Phase 3 — Part B. Sorts AFTER Part A's task migrations.
-- Hand-authored: emit_event notify guard, task lifecycle/transition/dependency/
-- due-soon triggers, and the inbox_feed 'assigned' tab. All fan-out goes through
-- public.emit_event -> movp_internal.movp_events/movp_jobs.

-- ── emit_event: add the notify-enqueue guard ────────────────────────────────
-- create or replace PRESERVES the existing grants from the async-RPC migration.
-- GOTCHA: keep `set search_path = ''` (definer-audit gate fails without it); the
-- event insert and webhook enqueue are unchanged — only the notify enqueue is
-- now guarded on the payload carrying a recipient.
create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
  values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text));
  -- GUARD: only enqueue a notify job when there is a recipient
  if payload ? 'recipient_user_id' or payload ? 'email' then
    insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    values ('notify', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
            payload || jsonb_build_object('event', ev_type), ws)
    on conflict (kind, idempotency_key) do nothing;
  end if;
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  select 'webhook', ev_type || ':' || coalesce(payload->>'id','') || ':' || w.id::text,
         payload || jsonb_build_object('event', ev_type, 'url', w.url, 'secret', w.secret), ws
    from movp_internal.webhooks w
   where w.workspace_id = ws and w.event_type = ev_type and w.active
  on conflict (kind, idempotency_key) do nothing;
end; $$;
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (2 assertions); definer-audit exits 0 (`all definers pinned` — `emit_event` still pins `search_path`); `db diff` empty.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): emit_event notify-enqueue guard (task lifecycle Part B)"
```

---

### Task 2: `task.created` / `task.assigned` / `task.observer_added` AFTER-INSERT triggers + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000009_task_lifecycle.sql` (append part 2)
- Edit: `supabase/tests/task_lifecycle_test.sql` (add Task 2 block)

**Interfaces:**
- Consumes: `public.emit_event` (Task 1), Part A's `public.task`, `public.task_assignment`, `public.task_observer`.
- Produces: three hardened `SECURITY DEFINER` AFTER-INSERT trigger functions + triggers. `task.created` is audit-only (no recipient); `task.assigned` and `task.observer_added` are per-recipient (`payload.id = task_id || ':' || recipient_user_id`, `entity_id = task_id`, `recipient_user_id` = the assignee/observer) so multi-owner notifies every owner.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_lifecycle_test.sql`: change `select plan(2);` to `select plan(6);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 2: insert-event triggers (task.created/assigned/observer_added) ─────
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('00000002-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Task Two','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.created' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'inserting a task emits task.created (audit-only)');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.assigned' and payload->>'entity_id'='00000002-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'task_assignment insert emits task.assigned carrying recipient_user_id (the assignee)');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.observer_added' and payload->>'entity_id'='00000002-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='dddddddd-dddd-dddd-dddd-dddddddddddd'),
          1, 'task_observer insert emits task.observer_added carrying recipient_user_id (the observer)');
-- Per-recipient notify key: `task.assigned:<task_id>:<assignee_id>`, so a 2nd owner
-- gets a DISTINCT job (multi-owner is not deduped). See the trigger comment above.
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key='task.assigned:00000002-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'the task.assigned notify job uses a per-recipient idempotency key + carries recipient_user_id');
```

Run: `supabase test db`
Expected: FAIL — the four new assertions return `0` (no insert triggers exist yet); the first 2 pass.

- [ ] **Step 2: Append the trigger functions (green)**

Append to `supabase/migrations/20260701000009_task_lifecycle.sql`. Each mirrors the committed `comment_emit_event` pattern (hardened definer, `revoke ... from public, anon, authenticated`, drop-then-create trigger). GOTCHA: `jsonb_build_object('id', new.id)` stores the uuid as a JSON string, so `payload->>'id'` reads back the uuid text — no `::text` needed for a single-value id.
```sql
-- ── insert-event triggers: fan out through public.emit_event ─────────────────
-- task.created: audit-only (no recipient -> emit_event enqueues no notify job).
create or replace function public.task_created_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.created', new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type','task','entity_id', new.id, 'title', new.title),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_created_emit_event() from public, anon, authenticated;
drop trigger if exists task_created_emit_event_tg on public.task;
create trigger task_created_emit_event_tg after insert on public.task
  for each row execute function public.task_created_emit_event();

-- task.assigned: per-recipient. payload.id = task_id:assignee so emit_event's
-- notify key (ev_type || ':' || payload->>'id') is UNIQUE per assignee — under
-- MULTI-OWNER a 2nd assignee is still notified, not deduped by the 1st's job.
-- entity_id stays the bare task_id so inbox 'all' resolves the task.
create or replace function public.task_assignment_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.assigned', new.workspace_id,
    jsonb_build_object('id', new.task_id::text || ':' || new.assignee_user_id::text,
                       'entity_type','task','entity_id', new.task_id,
                       'assignee_user_id', new.assignee_user_id, 'role', new.role,
                       'recipient_user_id', new.assignee_user_id),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_assignment_emit_event() from public, anon, authenticated;
drop trigger if exists task_assignment_emit_event_tg on public.task_assignment;
create trigger task_assignment_emit_event_tg after insert on public.task_assignment
  for each row execute function public.task_assignment_emit_event();

-- task.observer_added: per-recipient. payload.id = task_id:observer (unique
-- notify key per observer). entity_id stays the bare task_id for inbox 'all'.
create or replace function public.task_observer_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.observer_added', new.workspace_id,
    jsonb_build_object('id', new.task_id::text || ':' || new.observer_user_id::text,
                       'entity_type','task','entity_id', new.task_id,
                       'observer_user_id', new.observer_user_id,
                       'recipient_user_id', new.observer_user_id),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_observer_emit_event() from public, anon, authenticated;
drop trigger if exists task_observer_emit_event_tg on public.task_observer;
create trigger task_observer_emit_event_tg after insert on public.task_observer
  for each row execute function public.task_observer_emit_event();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (6 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — three insert triggers, all pinned definers**

Run:
```bash
grep -cE 'create trigger task_(created|assignment|observer)_emit_event_tg' \
  supabase/migrations/20260701000009_task_lifecycle.sql
node scripts/check-definer-audit.mjs
```
Expected: grep prints `3`; definer-audit exits `0` with `all definers pinned`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): task created/assigned/observer_added lifecycle triggers"
```

---

### Task 3: Category-keyed status-transition trigger + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000009_task_lifecycle.sql` (append part 3)
- Edit: `supabase/tests/task_lifecycle_test.sql` (add Task 3 block)

**Interfaces:**
- Consumes: `public.emit_event`, Part A's `public.task`, `public.task_status_option` (the `category` enum), `public.task_status_history`, `(select auth.uid())`.
- Produces: `public.task_notify_recipients(uuid)` (the DISTINCT owner ∪ observer recipient set — a `SECURITY DEFINER` function so the set is authoritative and RLS-independent) and `public.task_status_transition()` on `AFTER UPDATE OF status_id`. Emits audit `task.status_changed` on every change; multi-recipient `task.completed` on a transition INTO a `done`-category status and `task.reopened` on a transition OUT of one; sets/clears `completed_at`; writes one `task_status_history` row per transition.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_lifecycle_test.sql`: change `select plan(6);` to `select plan(14);`, and insert this block immediately BEFORE the final `select * from finish();`. The done-category option is labeled **`Shipped`** (not `Done`), proving the transition keys on `category`:
```sql
-- ── Task 3: status transition (label-agnostic: 'Shipped' == category done) ───
select is((select label from public.task_status_option where id='0000000d-0000-0000-0000-000000000000'),
          'Shipped', 'the done-category option is labeled Shipped (transition keys on category, not label)');
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('00000003-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Task Three','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','00000003-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','00000003-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');
-- transition INTO done ('Shipped')
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='00000003-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='task.completed' and payload->>'entity_id'='00000003-0000-0000-0000-000000000000'),
          2, 'entering a done-category status emits task.completed per recipient (owner + observer)');
select isnt((select completed_at from public.task where id='00000003-0000-0000-0000-000000000000'),
            null, 'completed_at is set on completion');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.status_changed' and payload->>'entity_id'='00000003-0000-0000-0000-000000000000'),
          1, 'the transition emits exactly one audit-only task.status_changed');
select is((select count(*)::int from public.task_status_history
           where task_id='00000003-0000-0000-0000-000000000000'),
          1, 'a task_status_history row is written for the completion transition');
-- transition OUT of done (reopen)
update public.task set status_id='0000000a-0000-0000-0000-000000000000'
  where id='00000003-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='task.reopened' and payload->>'entity_id'='00000003-0000-0000-0000-000000000000'),
          2, 'leaving a done-category status emits task.reopened per recipient');
select is((select completed_at from public.task where id='00000003-0000-0000-0000-000000000000'),
          null, 'completed_at is cleared on reopen');
select is((select count(*)::int from public.task_status_history
           where task_id='00000003-0000-0000-0000-000000000000'),
          2, 'a second task_status_history row is written for the reopen transition');
```

Run: `supabase test db`
Expected: FAIL — the 6 status/history/completed_at assertions fail (no transition trigger yet: no `task.completed`/`task.reopened`/`task.status_changed` events, `completed_at` unchanged, no history rows); the `Shipped` label assertion and the first 6 pass.

- [ ] **Step 2: Append the helper + transition trigger (green)**

Append to `supabase/migrations/20260701000009_task_lifecycle.sql`:
```sql
-- ── task_notify_recipients: DISTINCT owner-assignees ∪ observers ─────────────
-- SECURITY DEFINER so the recipient set is authoritative and does NOT depend on
-- the acting user's RLS visibility of task_assignment/task_observer. `union`
-- de-duplicates a user who is both an owner and an observer.
create or replace function public.task_notify_recipients(t uuid)
returns table(recipient uuid)
language sql stable security definer set search_path = '' as $$
  select ta.assignee_user_id from public.task_assignment ta
    where ta.task_id = t and ta.role = 'owner'
  union
  select o.observer_user_id from public.task_observer o
    where o.task_id = t;
$$;
revoke all on function public.task_notify_recipients(uuid) from public, anon, authenticated;

-- ── task_status_transition: category-keyed completed/reopened/status_changed ─
create or replace function public.task_status_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  from_cat text;
  to_cat   text;
  r        record;
begin
  -- `AFTER UPDATE OF status_id` fires even when the value is unchanged; guard it.
  if new.status_id is not distinct from old.status_id then
    return new;
  end if;

  select category into from_cat from public.task_status_option where id = old.status_id;
  select category into to_cat   from public.task_status_option where id = new.status_id;

  -- audit-only status change (no recipient -> emit_event enqueues no notify job)
  perform public.emit_event('task.status_changed', new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type','task','entity_id', new.id,
                       'from_status_id', old.status_id, 'to_status_id', new.status_id,
                       'from_category', from_cat, 'to_category', to_cat),
    gen_random_uuid()::text);

  -- one history row per transition; changed_by from the verified principal
  insert into public.task_status_history (workspace_id, task_id, from_status_id, to_status_id, changed_by)
    values (new.workspace_id, new.id, old.status_id, new.status_id, (select auth.uid()));

  if to_cat = 'done' and from_cat is distinct from 'done' then
    -- GOTCHA: this inner UPDATE sets completed_at only (not status_id), so this
    -- `AFTER UPDATE OF status_id` trigger does NOT re-fire -> no recursion.
    update public.task set completed_at = now() where id = new.id;
    for r in select recipient from public.task_notify_recipients(new.id) loop
      perform public.emit_event('task.completed', new.workspace_id,
        jsonb_build_object('id', new.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', new.id::text,
                           'recipient_user_id', r.recipient, 'title', new.title),
        gen_random_uuid()::text);
    end loop;
  elsif from_cat = 'done' and to_cat is distinct from 'done' then
    update public.task set completed_at = null where id = new.id;  -- status_id untouched -> no re-fire
    for r in select recipient from public.task_notify_recipients(new.id) loop
      perform public.emit_event('task.reopened', new.workspace_id,
        jsonb_build_object('id', new.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', new.id::text,
                           'recipient_user_id', r.recipient, 'title', new.title),
        gen_random_uuid()::text);
    end loop;
  end if;

  return new;
end; $$;
revoke all on function public.task_status_transition() from public, anon, authenticated;
drop trigger if exists task_status_transition_tg on public.task;
create trigger task_status_transition_tg
  after update of status_id on public.task
  for each row execute function public.task_status_transition();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (14 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — transition keys on category, self-update won't recurse**

Run:
```bash
grep -q "after update of status_id on public.task" supabase/migrations/20260701000009_task_lifecycle.sql && echo TRIGGER_SCOPED_OK
grep -q "set completed_at = now() where id = new.id" supabase/migrations/20260701000009_task_lifecycle.sql && echo COMPLETED_AT_SET_OK
```
Expected: prints `TRIGGER_SCOPED_OK` and `COMPLETED_AT_SET_OK` (the trigger is scoped `OF status_id`, so the `completed_at`-only self-update cannot re-fire it).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): category-keyed task status-transition trigger"
```

---

### Task 4: `recompute_task_blocked` + dependency triggers (`task.dependency_blocked`) + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000009_task_lifecycle.sql` (append part 4)
- Edit: `supabase/tests/task_lifecycle_test.sql` (add Task 4 block)

**Interfaces:**
- Consumes: `public.emit_event`, `public.task_notify_recipients` (Task 3), Part A's `public.task`, `public.task_dependency`, `public.task_status_option`.
- Produces: `public.recompute_task_blocked(uuid)` (recompute `dependency_blocked`; emit multi-recipient `task.dependency_blocked` ONLY on a false→true flip); an AFTER INSERT OR DELETE trigger on `task_dependency`; and an `AFTER UPDATE OF status_id` trigger on `task` recomputing every DEPENDENT of the changed task. Invariant: a task is blocked iff it has any blocker whose status category ≠ `done`; unblocking (true→false) updates the flag but emits nothing (there is no `task.unblocked` event).

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_lifecycle_test.sql`: change `select plan(14);` to `select plan(18);`, and insert this block immediately BEFORE the final `select * from finish();`. `dependency_blocked` is seeded explicitly `false` so the flip is deterministic regardless of the column default:
```sql
-- ── Task 4: dependency_blocked (dependent T4 blocked by BC) ──────────────────
insert into public.task (id, workspace_id, title, status_id, priority_id, dependency_blocked) values
  ('00000004-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Dependent','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000', false),
  ('000000bc-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Blocker','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000', false);
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','00000004-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','00000004-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');
-- add a blocker that is NOT done -> T4 becomes blocked (false -> true)
insert into public.task_dependency (workspace_id, task_id, blocker_id) values
  ('11111111-1111-1111-1111-111111111111','00000004-0000-0000-0000-000000000000',
   '000000bc-0000-0000-0000-000000000000');
select is((select dependency_blocked from public.task where id='00000004-0000-0000-0000-000000000000'),
          true, 'a task with a not-done blocker is dependency_blocked');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.dependency_blocked' and payload->>'entity_id'='00000004-0000-0000-0000-000000000000'),
          2, 'becoming blocked emits task.dependency_blocked per recipient (owner + observer)');
-- move the blocker to a done status -> T4 unblocks (true -> false), no new event
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='000000bc-0000-0000-0000-000000000000';
select is((select dependency_blocked from public.task where id='00000004-0000-0000-0000-000000000000'),
          false, 'when the blocker becomes done the dependent unblocks');
select is((select count(*)::int from movp_internal.movp_events
           where type='task.dependency_blocked' and payload->>'entity_id'='00000004-0000-0000-0000-000000000000'),
          2, 'unblocking emits no new task.dependency_blocked event');
```

Run: `supabase test db`
Expected: FAIL — the 4 new assertions fail (no recompute/dependency triggers yet: `dependency_blocked` stays `false`, no `task.dependency_blocked` events). The first 14 pass.

- [ ] **Step 2: Append recompute + dependency/status triggers (green)**

Append to `supabase/migrations/20260701000009_task_lifecycle.sql`:
```sql
-- ── recompute_task_blocked: recompute dependency_blocked; emit on false->true ─
create or replace function public.recompute_task_blocked(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  was_blocked boolean;
  now_blocked boolean;
  ws          uuid;
  ttitle      text;
  r           record;
begin
  select dependency_blocked, workspace_id, title into was_blocked, ws, ttitle
    from public.task where id = t;
  if not found then return; end if;

  -- blocked iff any blocker's status category is not 'done'
  select exists (
    select 1
      from public.task_dependency d
      join public.task bt on bt.id = d.blocker_id
      join public.task_status_option so on so.id = bt.status_id
     where d.task_id = t and so.category <> 'done'
  ) into now_blocked;

  if now_blocked is distinct from was_blocked then
    -- GOTCHA: updates dependency_blocked only (not status_id), so neither
    -- task_status_transition_tg nor task_status_recompute_dependents_tg re-fires.
    update public.task set dependency_blocked = now_blocked where id = t;
    if now_blocked then
      for r in select recipient from public.task_notify_recipients(t) loop
        perform public.emit_event('task.dependency_blocked', ws,
          jsonb_build_object('id', t::text || ':' || r.recipient::text,
                             'entity_type','task','entity_id', t::text,
                             'recipient_user_id', r.recipient, 'title', ttitle),
          gen_random_uuid()::text);
      end loop;
    end if;  -- unblocking (true->false) updates the flag but emits nothing
  end if;
end; $$;
revoke all on function public.recompute_task_blocked(uuid) from public, anon, authenticated;

-- recompute the dependent when a dependency edge is added or removed
create or replace function public.task_dependency_recompute()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_task_blocked(old.task_id);
    return old;
  end if;
  perform public.recompute_task_blocked(new.task_id);
  return new;
end; $$;
revoke all on function public.task_dependency_recompute() from public, anon, authenticated;
drop trigger if exists task_dependency_recompute_tg on public.task_dependency;
create trigger task_dependency_recompute_tg
  after insert or delete on public.task_dependency
  for each row execute function public.task_dependency_recompute();

-- when a task's status changes, recompute every task that depends on it
create or replace function public.task_status_recompute_dependents()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct d.task_id from public.task_dependency d where d.blocker_id = new.id loop
    perform public.recompute_task_blocked(r.task_id);
  end loop;
  return new;
end; $$;
revoke all on function public.task_status_recompute_dependents() from public, anon, authenticated;
drop trigger if exists task_status_recompute_dependents_tg on public.task;
create trigger task_status_recompute_dependents_tg
  after update of status_id on public.task
  for each row execute function public.task_status_recompute_dependents();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (18 assertions); definer-audit exits 0; `db diff` empty. (Note: moving blocker BC to `done` also fires BC's own `task_status_transition` — BC has no owner/observer, so `task.completed` fans out to zero recipients; this is fine and does not touch T4's counts, which filter on `entity_id`.)

- [ ] **Step 4: Gate — recompute + both dependency triggers present, all pinned**

Run:
```bash
grep -cE 'create trigger (task_dependency_recompute|task_status_recompute_dependents)_tg' \
  supabase/migrations/20260701000009_task_lifecycle.sql
node scripts/check-definer-audit.mjs
```
Expected: grep prints `2`; definer-audit exits `0` with `all definers pinned`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): task dependency-blocked recompute + triggers"
```

---

### Task 5: `emit_due_soon()` scan + documented deploy-time cron + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000009_task_lifecycle.sql` (append part 5)
- Edit: `supabase/tests/task_lifecycle_test.sql` (add Task 5 block)

**Interfaces:**
- Consumes: `public.emit_event`, `public.task_notify_recipients` (Task 3), Part A's `public.task`, `public.task_status_option`.
- Produces: `public.emit_due_soon()` — scans tasks due within one day whose status category ≠ `done` and whose `due_soon_notified_at` is null, emits multi-recipient `task.due_soon`, and stamps `due_soon_notified_at`. Invariant: idempotent per task via the `due_soon_notified_at` stamp — a re-scan emits nothing. The cron that calls it is applied out-of-band (NOT in this migration).

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_lifecycle_test.sql`: change `select plan(18);` to `select plan(21);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 5: emit_due_soon (T5 due tomorrow, status active) ───────────────────
insert into public.task (id, workspace_id, title, status_id, priority_id, due_date) values
  ('00000005-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Due Soon Task','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000', current_date + 1);
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','00000005-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','00000005-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');
select public.emit_due_soon();
select is((select count(*)::int from movp_internal.movp_events
           where type='task.due_soon' and payload->>'entity_id'='00000005-0000-0000-0000-000000000000'),
          2, 'emit_due_soon emits task.due_soon per recipient (owner + observer)');
select isnt((select due_soon_notified_at from public.task where id='00000005-0000-0000-0000-000000000000'),
            null, 'due_soon_notified_at is stamped after the scan');
-- re-scan: the stamp suppresses a second emit
select public.emit_due_soon();
select is((select count(*)::int from movp_internal.movp_events
           where type='task.due_soon' and payload->>'entity_id'='00000005-0000-0000-0000-000000000000'),
          2, 're-scanning emits no further task.due_soon (idempotent via due_soon_notified_at)');
```

Run: `supabase test db`
Expected: FAIL — `function public.emit_due_soon() does not exist`, so the whole file errors on the first `select public.emit_due_soon();`. (The first 18 assertions would otherwise pass.)

- [ ] **Step 2: Append `emit_due_soon` + the cron doc (green)**

Append to `supabase/migrations/20260701000009_task_lifecycle.sql`:
```sql
-- ── emit_due_soon: notify owners+observers of tasks due within one day ───────
create or replace function public.emit_due_soon()
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
  r record;
begin
  for t in
    select tk.id, tk.workspace_id, tk.title
      from public.task tk
      join public.task_status_option so on so.id = tk.status_id
     where tk.due_date is not null
       and tk.due_date <= (current_date + 1)     -- due within one day (incl. overdue)
       and so.category <> 'done'
       and tk.due_soon_notified_at is null
  loop
    for r in select recipient from public.task_notify_recipients(t.id) loop
      perform public.emit_event('task.due_soon', t.workspace_id,
        jsonb_build_object('id', t.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', t.id::text,
                           'recipient_user_id', r.recipient, 'title', t.title),
        gen_random_uuid()::text);
    end loop;
    -- stamp so a re-scan is a no-op (GOTCHA: stamps due_soon_notified_at only,
    -- not status_id -> no status/recompute trigger re-fires).
    update public.task set due_soon_notified_at = now() where id = t.id;
  end loop;
end; $$;
revoke all on function public.emit_due_soon() from public, anon, authenticated;

-- ── DEPLOY-TIME CRON (documentation only — NOT applied by this migration) ────
-- Schedule out-of-band so `supabase db diff` stays empty and no secret is
-- committed. At deploy time (with the service key sourced from Vault, never a
-- literal), run e.g.:
--   select cron.schedule('task-due-soon', '*/15 * * * *', $cron$ select public.emit_due_soon(); $cron$);
-- emit_due_soon reads only local tables and fans out via emit_event -> movp_jobs,
-- so it needs no secret itself; the Vault key belongs to the notify worker that
-- drains the jobs. pgTAP/e2e call `select public.emit_due_soon();` directly.
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (21 assertions); definer-audit exits 0; `db diff` empty (the cron is not committed, so no `cron.*` object appears).

- [ ] **Step 4: Gate — function committed, cron NOT committed**

Run:
```bash
grep -q "create or replace function public.emit_due_soon()" supabase/migrations/20260701000009_task_lifecycle.sql && echo FN_OK
grep -c "^select cron.schedule" supabase/migrations/20260701000009_task_lifecycle.sql
```
Expected: prints `FN_OK`; the second grep prints `0` (the only `cron.schedule` mention is inside a `--` comment, never an executable statement).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): emit_due_soon scan (+documented deploy-time cron)"
```

---

### Task 6: `inbox_feed` `assigned` tab + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000009_task_lifecycle.sql` (append part 6)
- Edit: `supabase/tests/task_lifecycle_test.sql` (add Task 6 block)

**Interfaces:**
- Consumes: the committed `public.inbox_feed` (from the collaboration inbox migration), `public.is_workspace_member`, Part A's `public.task_assignment`, `public.task`.
- Produces: `public.inbox_feed` re-declared with an `assigned` tab. Invariant: the `mentions`/`saved`/`all` branches are byte-identical to the committed version; only the final `else result := '[]'` is preceded by a new `elsif tab = 'assigned'` branch (the trailing `else result := '[]'::jsonb; end if;` stays). `create or replace` preserves the existing `grant execute ... to authenticated`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/task_lifecycle_test.sql`: change `select plan(21);` to `select plan(23);`, and insert this block immediately BEFORE the final `select * from finish();`. A (a member) is assigned to Task Two; C (a member with no assignments) proves the branch filters on the assignee, not merely on membership:
```sql
-- ── Task 6: inbox_feed 'assigned' tab ───────────────────────────────────────
-- act as A (still the current request.jwt.claims sub)
select ok(
  public.inbox_feed('11111111-1111-1111-1111-111111111111','assigned',20)
    @> '[{"kind":"task.assigned","entity_type":"task","entity_id":"00000002-0000-0000-0000-000000000000"}]'::jsonb,
  'the assignee A sees a task.assigned inbox item for Task Two');
-- act as C: a workspace member with no assignments
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is(
  public.inbox_feed('11111111-1111-1111-1111-111111111111','assigned',20),
  '[]'::jsonb,
  'a member with no assignments sees an empty assigned feed');
```

Run: `supabase test db`
Expected: FAIL — the committed `inbox_feed` has no `assigned` branch, so it falls through to `else '[]'` and A's containment assertion fails (`[] @> [...]` is false). C's `[]` assertion happens to pass. (1 failing assertion; the first 21 pass.)

- [ ] **Step 2: Re-declare `inbox_feed` with the `assigned` branch (green)**

Append to `supabase/migrations/20260701000009_task_lifecycle.sql`. The `mentions`/`saved`/`all` branches are copied verbatim from the committed function; the ONLY change is the inserted `elsif tab = 'assigned'` branch before the trailing `else`. GOTCHA: keep `set search_path = ''`; `create or replace` preserves the committed grant to `authenticated`.
```sql
-- ── inbox_feed: add the 'assigned' tab (mentions/saved/all unchanged) ────────
create or replace function public.inbox_feed(ws uuid, tab text, lim int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); capped int := least(greatest(coalesce(lim,20),1),100); result jsonb;
begin
  if not public.is_workspace_member(ws) then return '[]'::jsonb; end if;
  if tab = 'mentions' then
    select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result from (
      select jsonb_build_object('kind','user.mentioned','entity_type',m.entity_type,'entity_id',m.entity_id::text,'ref_id',m.id::text,'created_at',m.created_at,'payload',jsonb_build_object('comment_id',m.comment_id::text,'body',c.body)) as item, m.created_at
      from public.mention m join public.comment c on c.id=m.comment_id
      where m.workspace_id=ws and m.mentioned_user_id=uid order by m.created_at desc limit capped) s;
  elsif tab = 'saved' then
    select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result from (
      select jsonb_build_object('kind','item.saved','entity_type',si.entity_type,'entity_id',si.entity_id::text,'ref_id',si.id::text,'created_at',si.created_at,'payload','{}'::jsonb) as item, si.created_at
      from public.saved_item si where si.workspace_id=ws and si.user_id=uid order by si.created_at desc limit capped) s;
  elsif tab = 'all' then
    select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result from (
      select jsonb_build_object('kind',e.type,'entity_type',coalesce(e.payload->>'entity_type',''),'entity_id',coalesce(e.payload->>'entity_id',e.payload->>'id',''),'ref_id',e.id::text,'created_at',e.created_at,'payload',e.payload) as item, e.created_at
      from movp_internal.movp_events e where e.workspace_id=ws order by e.created_at desc limit capped) s;
  elsif tab = 'assigned' then
    select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result from (
      select jsonb_build_object('kind','task.assigned','entity_type','task','entity_id',t.id::text,'ref_id',ta.id::text,'created_at',ta.created_at,'payload',jsonb_build_object('title',t.title)) as item, ta.created_at
      from public.task_assignment ta join public.task t on t.id=ta.task_id
      where ta.workspace_id=ws and ta.assignee_user_id=uid order by ta.created_at desc limit capped) s;
  else result := '[]'::jsonb; end if;
  return result;
end; $$;
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `task_lifecycle_test.sql .. ok` (23 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — assigned branch present, other branches intact**

Run:
```bash
grep -q "elsif tab = 'assigned' then" supabase/migrations/20260701000009_task_lifecycle.sql && echo ASSIGNED_OK
grep -cE "tab = '(mentions|saved|all|assigned)'" supabase/migrations/20260701000009_task_lifecycle.sql
```
Expected: prints `ASSIGNED_OK`; the second grep prints `4` (all four tabs branch; the trailing `else` remains the fall-through).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000009_task_lifecycle.sql supabase/tests/task_lifecycle_test.sql
git commit -m "feat(db): inbox_feed assigned tab"
```

---

## Self-Review

- **Spec coverage (Part B scope):** `emit_event` notify guard (Task 1); `task.created`/`task.assigned`/`task.observer_added` AFTER-INSERT triggers (Task 2); category-keyed status-transition trigger with `completed`/`reopened`/`status_changed` + `completed_at` set/clear + per-transition history rows (Task 3); `recompute_task_blocked` + dependency/status triggers emitting `task.dependency_blocked` on false→true (Task 4); `emit_due_soon()` scan + documented (uncommitted) cron (Task 5); `inbox_feed` `assigned` tab (Task 6). Every task is TDD (red → green) and ends with the apply gate `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` plus a targeted grep.
- **Event → recipient mapping (verbatim names):**
  - `task.created` — AUDIT-ONLY, no recipient (records + webhook; no notify).
  - `task.status_changed` — AUDIT-ONLY, no recipient.
  - `task.assigned` — single target = the assignee; `payload.id = task_id || ':' || assignee_user_id` (per-recipient notify key, so multi-owner notifies every owner).
  - `task.observer_added` — single target = the observer; `payload.id = task_id || ':' || observer_user_id`.
  - `task.completed` — MULTI: each owner (`task_assignment.role='owner'`) ∪ each observer; one event per recipient, `payload.id = task_id || ':' || recipient_user_id`.
  - `task.reopened` — MULTI: same recipient set/shape as completed.
  - `task.dependency_blocked` — MULTI: same recipient set/shape; emitted only on false→true.
  - `task.due_soon` — MULTI: same recipient set/shape; emitted by the scan, once per task (stamped).
  ALL recipient-bearing events carry `entity_type='task'`, `entity_id=task_id`, `recipient_user_id`=the recipient, and a per-recipient `payload.id` (`task_id:recipient`) so no recipient is deduped.
- **`emit_event` guard predicate:** the notify job is enqueued iff `payload ? 'recipient_user_id' or payload ? 'email'`; the event insert and webhook enqueue are unchanged. Audit-only events (no `recipient_user_id`) therefore record + webhook but never notify.
- **Transition category rules (keyed on `task_status_option.category`, never the label):**
  - **completed** when `to_cat = 'done'` AND `from_cat is distinct from 'done'` → set `completed_at = now()`, emit multi `task.completed`.
  - **reopened** when `from_cat = 'done'` AND `to_cat is distinct from 'done'` → set `completed_at = null`, emit multi `task.reopened`.
  - **status_changed** on every actual change (guarded by `new.status_id is not distinct from old.status_id`) → one audit event + one `task_status_history` row.
  - **dependency-blocked** iff any blocker's status category `<> 'done'`. The Task 3 pgTAP proves label-agnosticism by using a `done`-category option labeled `Shipped`.
- **The `assigned` SQL (inbox_feed branch):**
  ```sql
  elsif tab = 'assigned' then
    select coalesce(jsonb_agg(item order by created_at desc),'[]'::jsonb) into result from (
      select jsonb_build_object('kind','task.assigned','entity_type','task','entity_id',t.id::text,'ref_id',ta.id::text,'created_at',ta.created_at,'payload',jsonb_build_object('title',t.title)) as item, ta.created_at
      from public.task_assignment ta join public.task t on t.id=ta.task_id
      where ta.workspace_id=ws and ta.assignee_user_id=uid order by ta.created_at desc limit capped) s;
  ```
- **Correctness / self-consistency:** the two `AFTER UPDATE OF status_id` triggers (`task_status_transition_tg`, `task_status_recompute_dependents_tg`) are independent (one updates this row's `completed_at`, the other recomputes DEPENDENTS); the transition/recompute/due-soon self-updates all touch non-`status_id` columns, so no `OF status_id` trigger re-fires — the no-recursion argument is inline-commented at each self-update. `plan(N)` is bumped 2 → 6 → 14 → 18 → 21 → 23 as blocks are inserted before the single `select * from finish();`. All fixture UUIDs are valid hex.
- **Safety / observability:** every new function is a hardened `SECURITY DEFINER` — `set search_path = ''`, fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` (trigger + internal fns); `create or replace` preserves the committed grants on `emit_event`/`inbox_feed`. `task_notify_recipients` is DEFINER so the recipient set is authoritative and does not depend on the acting user's RLS visibility. Payloads carry ids + entity refs + `recipient_user_id` + the row's own `title` — no free-text/PII beyond the row. `movp_internal` is read in tests only as the owner. All definers pass `check-definer-audit.mjs`.
- **Reliability / drift:** every task ends with `supabase db reset` + `supabase db diff` empty; `drop trigger if exists` + `create or replace` keep the migration re-runnable in a fresh reset. `emit_due_soon` is idempotent per task via the `due_soon_notified_at` stamp; multi-recipient `payload.id` includes the recipient so per-recipient notify keys never collide. The deploy-time cron is deliberately NOT committed so `db diff` stays clean.
- **Efficiency / performance:** `emit_due_soon` scans with a single indexed-friendly predicate and stamps in one pass; `recompute_task_blocked` does one `exists(...)` probe and only writes/emits on a state flip; the transition trigger is scoped `OF status_id` so unrelated task updates never invoke it.
- **Multi-owner notify (per-recipient keys):** `task.assigned`/`task.observer_added` set `payload.id = task_id || ':' || recipient_user_id`, so `emit_event`'s notify key (`ev_type:payload.id`) is unique per recipient — adding a SECOND assignee/observer to a task enqueues a DISTINCT notify job (every owner is notified; the 2nd is never deduped by the 1st). `entity_id` stays the bare `task_id` for inbox `all`. This shares one convention with the MULTI-recipient events (`task.completed`/`reopened`/`dependency_blocked`/`due_soon`).
- **Deferred (intentional):** no `task.unblocked` event (only false→true emits); no worker change (the notify worker already resolves `recipient_user_id` → email); no UI. None are needed for the DB lifecycle/event deliverable.
- **Placeholder scan:** none — every SQL block is complete and copy-paste-ready; every step has an exact command + expected output.
