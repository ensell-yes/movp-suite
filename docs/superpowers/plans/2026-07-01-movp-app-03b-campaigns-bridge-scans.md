# MOVP App — Campaigns Phase 5, Part B: Task-Reuse Bridge, Date-Scans & Domain Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Campaigns the reuse mechanics that make a `campaign_deliverable` a thin front for a real Task, plus the date-driven lifecycle scans, without inventing an event-subscription engine. Hand-author migration `20260701000018_campaigns_bridge.sql` (sorts after Part A's `20260701000017_*`) to: (1) install a hardened DEFINER AFTER-INSERT trigger on **Task's own** `public.task_assignment` that recovers the backing deliverable by a REVERSE `public.edges` lookup and emits `deliverable.assigned`; (2) install a hardened DEFINER AFTER-UPDATE-OF-`status_id` trigger on **Task's own** `public.task` that emits `deliverable.completed` (per recipient) on a transition INTO a `done`-category status; (3) add `public.scan_campaigns()` — a date-driven scan that flips `scheduled→active` (emit `campaign.started`), `active→completed` (emit `campaign.ended`), and emits per-recipient date-keyed `deliverable.due_soon` for deliverables whose backing task is due within a day; and (4, optional/deferred) a `content_publish_event` readiness bridge. Then add the TypeScript **`campaign` domain service** (`packages/domain/src/campaign.ts`) that writes the reuse edges via `makeGraphService(ctx).link(...)` and reads a deliverable's schedule off its backing task.

**Architecture:** Part A committed the seven config-first campaign collections (`campaign`, `campaign_deliverable`, `marketing_plan`, `campaign_channel`, `campaign_metric`, `campaign_calendar_event`, `campaign_segment`) with blanket RLS and the `campaign.created` / `deliverable.created` AFTER-INSERT emit triggers. **`campaign_deliverable` is column-thin — it has no schedule, status, or assignee of its own.** The reuse model is: a deliverable is *implemented by* a Task, and the Task is the source of truth for schedule/status/assignee. **There is NO event-subscription engine.** The committed flows worker (`packages/flows/src/flows-worker.ts`) ONLY drains the `movp_internal.movp_jobs` queue (`notify`/`webhook`); nothing consumes `movp_internal.movp_events`. So the deliverable↔task bridge is a **NET-NEW primitive: DB triggers on Task's OWN tables** that recover the backing deliverable and emit `deliverable.*`. **Do NOT write a "flows subscription" — it does not exist.** **`public.traverse_edges` is FORWARD-only** (src→dst); the bridge edge is `(src_type='campaign_deliverable', src_id=<deliverable>, rel='implemented_by', dst_type='task', dst_id=<task>)`, and Task events carry only `task_id`, so every bridge trigger recovers the deliverable by a **DIRECT REVERSE lookup** on `public.edges` (never `traverse_edges`):
```sql
select src_id into deliv_id from public.edges
 where workspace_id = <ws> and dst_type = 'task' and dst_id = <task>
   and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
```
All fan-out goes through the committed `public.emit_event(ev_type, ws, payload, trace)` (Task's `000009`), which writes `movp_internal.movp_events` and enqueues `movp_internal.movp_jobs` with `on conflict (kind, idempotency_key) do nothing`, enqueuing a `notify` job **only** when the payload carries `recipient_user_id` or `email`.

**Tech Stack:** Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` triggers + functions, the committed `public.emit_event` / `movp_internal.{movp_events,movp_jobs,webhooks}` async backbone, the `public.edges` graph + `public.task_notify_recipients(uuid)` (Task `000009`), `public.task` / `public.task_status_option` / `public.task_assignment` / `public.task_observer` (Task Part A), Part A's `public.campaign` / `public.campaign_deliverable`, the definer-audit gate (`node scripts/check-definer-audit.mjs`), and the TypeScript domain package (`packages/domain` — `makeGraphService`, `createDomain`) with its vitest integration harness. The flows worker is **unchanged** (it already resolves `payload.recipient_user_id` → email).

**This is Part B of the Campaigns Phase 5 series.** It depends on **Part A** (`20260701000017_*` — the seven campaign collections + `campaign.created`/`deliverable.created` triggers), on **Task `000009`** (which adds `public.emit_event` with the notify guard, `public.task_notify_recipients`, and the emit-event triggers) atop the underlying Task tables `public.task` + `public.task_status_option` + `public.task_assignment` + `public.task_observer` (these tables come from codegen `000002` + the hand-augmented `000008` (01a), NOT `000009`), and on the **graph edges** migration (`public.edges`). Downstream consumers depend on the **event names verbatim** (`deliverable.assigned`, `deliverable.completed`, `deliverable.due_soon`, `campaign.started`, `campaign.ended`) and on the `recipient_user_id` payload field — do not rename either without updating the notify worker and any webhook subscribers.

## Global Constraints

- **Hand-authored migration only — no codegen.** Part A already generated the campaign tables; this part adds no collection and runs no `pnpm codegen`. It is one hand-authored SQL migration plus one pgTAP file, plus one TypeScript domain service + its test. Do NOT hand-edit any generated migration.
- **Exact filename, not `supabase migration new`.** The migration MUST be `supabase/migrations/20260701000018_campaigns_bridge.sql` (a wall-clock timestamp from `supabase migration new` would sort wrong; Part A used `...000017`). It is built top-to-bottom across Tasks 1–3 in dependency order: bridge triggers → `scan_campaigns` → (optional) content-publish bridge.
- **The bridge uses the REVERSE `public.edges` lookup — NEVER `traverse_edges`.** `traverse_edges` is forward-only (src→dst); a Task event carries only `task_id` (a `dst`), so the deliverable (`src`) is recovered by the direct reverse `select src_id ... where dst_type='task' and dst_id=<task> and rel='implemented_by' and src_type='campaign_deliverable'`. Any use of `traverse_edges` here is a bug.
- **Bridge triggers live on Task's OWN tables, and COEXIST with Task's triggers.** `public.task_assignment` already has Task's `task_assignment_emit_event_tg` (emits `task.assigned`); `public.task` already has Task's `task_status_transition_tg` + `task_status_recompute_dependents_tg` (both `after update of status_id`). This migration ADDS `deliverable_assigned_emit_event_tg` and `deliverable_completed_emit_event_tg` alongside them — both sets fire; each is independent; distinct event types never collide. Postgres fires per-statement row triggers in **alphabetical trigger-name order**; order is irrelevant here because the triggers do not read each other's effects.
- **All `SECURITY DEFINER` functions hardened.** Every function: `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated`. The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits SQL on `create ... function` and FAILS any `security definer` block missing `set search_path =`. Every function below sets it — do not drop the clause.
- **Recipient split is explicit per event (flag the roadmap divergence).** The roadmap's "reuse Task's observer edges" note is **WRONG** and must NOT be followed. Task uses `task_assignment(role='owner')` + `task_observer` TABLES via `public.task_notify_recipients(task uuid)` (DISTINCT owner ∪ observer). Campaigns use their OWN recipients: `campaign.owner_id` + `campaign→user rel='observer'` **edges**. **Deliverable-event recipients are the BACKING TASK's `public.task_notify_recipients(task_id)`** — because a deliverable has no assignees of its own; its people are the Task's people. `deliverable.assigned` targets the single assignee on the inserted `task_assignment` row; `deliverable.completed` / `deliverable.due_soon` fan out to the full `task_notify_recipients` set.
- **Per-recipient / per-date fan-out keys.** Every recipient-bearing event emits ONE event per recipient with `recipient_user_id` = that user and `payload.id = <entity_id>::text || ':' || <recipient>::text`, so `emit_event`'s notify key (`ev_type || ':' || payload->>'id`) is unique per recipient (no dedupe of a 2nd recipient). `entity_type`/`entity_id` = the `campaign_deliverable` / `campaign` id. For `deliverable.due_soon` the key ALSO carries the date: `payload.id = deliverable_id || ':' || recipient || ':' || to_char(due_date,'YYYY-MM-DD')`, so re-scanning the SAME day re-computes the SAME key and the `movp_jobs unique(kind, idempotency_key)` constraint de-dups the notify job.
- **`campaign_deliverable` has NO `*_notified_at` stamp — due_soon idempotency is JOB-level, not event-level.** Unlike Task's `emit_due_soon` (which stamps `due_soon_notified_at` to suppress even the event), the column-thin deliverable has no such column, so a re-scan on the same day WILL insert a duplicate `deliverable.due_soon` *event* but will NOT enqueue a duplicate *notify job* (deduped by the date-keyed idempotency key). Assertions therefore count `movp_jobs`, not `movp_events`, for due_soon idempotency. State this in the trigger comment and the test.
- **`campaign.started` / `campaign.ended` are audit-only and idempotent via the state transition.** No `recipient_user_id` → `emit_event` records the event + webhook but enqueues no notify. The `update ... where status='scheduled'` (resp. `='active'`) predicate is FALSIFIED by the update itself, so a re-scan finds no rows and emits nothing — idempotent without any stamp.
- **`movp_internal` is not reachable by `authenticated`.** Triggers write it only through the DEFINER `emit_event`; pgTAP reads `movp_internal.movp_events`/`movp_jobs` as the table owner (the default test role), never as `authenticated`.
- **Deploy-time cron is NOT committed.** `scan_campaigns()` is committed; the `cron.schedule(...)` that calls it (with any Vault-held key) is applied out-of-band at deploy time so `supabase db diff` stays empty. pgTAP/e2e call `select public.scan_campaigns();` directly. Mirror Task's `emit_due_soon` cron doc.
- **Domain service reuses the graph, not a private helper.** `packages/domain/src/campaign.ts` writes edges via `makeGraphService(ctx).link(...)`. `content` and `campaign` are SIBLINGS — instantiate a LOCAL `const graph = makeGraphService(ctx)`; there is NO `this.graph`. No new dependency is added.

## File Structure

```
supasuite/
  supabase/
    migrations/
      20260701000018_campaigns_bridge.sql   # NEW hand-authored (built up across Tasks 1–3)
    tests/
      campaigns_bridge_test.sql             # NEW pgTAP (built up across Tasks 1–3)
  packages/
    domain/
      src/
        campaign.ts                         # NEW makeCampaignService (Task 4)
        types.ts                            # EDIT: add CampaignService + campaign field on the Domain interface
        domain.ts                           # EDIT: wire campaign: makeCampaignService(ctx) into createDomain (createDomain lives HERE)
        index.ts                            # EDIT: re-export ONLY (export { makeCampaignService } + CampaignService type)
      test/
        campaign.integration.test.ts        # NEW (clone collab.integration.test.ts harness)
```

**Per-task apply gate (SQL tasks — Tasks 1–3 end with it):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: migration applies, `campaigns_bridge_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing.

**Per-task gate (Task 4 — TypeScript):**
```bash
pnpm --filter @movp/domain typecheck && pnpm --filter @movp/domain test campaign.integration
```
Expected: typecheck clean; `campaign.integration.test.ts` passes; existing suites unaffected. (If the repo runs domain tests via a different script, use the SAME one `collab.integration.test.ts` runs under — see `packages/domain/package.json` `scripts`.)

---

### Task 1: Bridge triggers — `deliverable.assigned` (on `task_assignment`) + `deliverable.completed` (on `task`) + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000018_campaigns_bridge.sql`
- Create: `supabase/tests/campaigns_bridge_test.sql`

**Interfaces:**
- Consumes: `public.emit_event`, `public.task_notify_recipients` (Task `000009`), `public.edges`, `public.task`, `public.task_status_option`, `public.task_assignment`, Part A's `public.campaign`, `public.campaign_deliverable`.
- Produces: two hardened DEFINER trigger functions + triggers on Task's own tables. `deliverable_assigned_emit_event()` (AFTER INSERT on `task_assignment`) recovers the deliverable via the reverse `edges` lookup on `new.task_id`; if found, emits ONE `deliverable.assigned` for the single assignee (`recipient_user_id = new.assignee_user_id`, `entity_id = deliverable_id`). `deliverable_completed_emit_event()` (AFTER UPDATE OF `status_id` on `task`) emits `deliverable.completed` per recipient of the backing task's `task_notify_recipients` on a transition INTO a `done`-category status. No deliverable found → no-op.

- [ ] **Step 1: Write the failing pgTAP (red)**

Create `supabase/tests/campaigns_bridge_test.sql` with the shared seed + Task 1 block. `plan(6)` now; later tasks bump it. Fixtures: workspace **W1**; member **A** (`aaaa…`, campaign owner + task owner/recipient); member **D** (`dddd…`, task observer). Task status options with **labels differing from categories** (proving category-keyed logic): `In Progress`(active), `Shipped`(done). Campaign **c3** (`c333…`, active) hosts deliverable **d0** (`d000…`), backed by task **tA** (`a000…`).
```sql
begin;
select plan(6);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','dddddddd-dddd-dddd-dddd-dddddddddddd','member');
-- NOTE: inserting the workspace fired Task Part A's AFTER-INSERT seed trigger, which already
-- created W1's default task status + priority options (each is_default=true). So these
-- fixed-id fixtures are is_default=FALSE — a 2nd is_default in the same workspace would
-- violate the one-default-per-workspace partial unique. Tasks below use these ids EXPLICITLY.
-- Labels intentionally != categories, so category-keyed logic is label-agnostic.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('0000000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','In Progress','active',1,false,true),
  ('0000000d-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Shipped','done',2,false,true);
-- priority is a REQUIRED relation on public.task (priority_id NOT NULL) — seed ONE option.
insert into public.task_priority_option (id, workspace_id, label, rank, sort_order, is_default, is_active) values
  ('0000000e-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Normal',5,0,false,true);
-- Task's task_status_transition writes task_status_history.changed_by = auth.uid(); set the
-- claim so that resolves to A when we move tA to done below (avoids a null changed_by).
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- host campaign c3 (active). Inserting it fires Part A's campaign.created trigger (harmless:
-- our assertions filter on campaign.started/ended/deliverable.* by type, never campaign.created).
insert into public.campaign (id, workspace_id, owner_id, start_date, end_date, status) values
  ('c3333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', current_date - 30, current_date + 30, 'active');
-- deliverable d0. channel_id omitted (assumed nullable). GOTCHA: if Part A made channel_id
-- NOT NULL, seed a public.campaign_channel first and set channel_id here; deliverable_type
-- 'email' must be a value Part A allows (adjust if it is a constrained enum). Inserting it
-- fires Part A's deliverable.created trigger (harmless — filtered out by type as above).
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('d0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','Launch Email','email');
-- backing task tA (active). implemented_by edge d0 -> tA. observer D on tA.
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('a0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task A','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','d0000000-0000-0000-0000-000000000000',
   'implemented_by','task','a0000000-0000-0000-0000-000000000000');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');

-- ── Task 1: deliverable.assigned (task_assignment insert recovers the deliverable) ──
-- assigning A to tA fires Task's task.assigned AND our deliverable.assigned (edge exists).
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.assigned'
             and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'assigning the backing task emits deliverable.assigned carrying entity_id=deliverable + recipient=the assignee');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.assigned:d0000000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'the deliverable.assigned notify job uses a per-recipient idempotency key (deliverable_id:assignee)');

-- negative: a task with NO implemented_by edge -> assignment fires the trigger but emits nothing.
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('000000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Unbridged Task','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','000000ff-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.assigned' and payload->>'task_id'='000000ff-0000-0000-0000-000000000000'),
          0, 'a task with no implemented_by edge emits no deliverable.assigned (no-op)');

-- deliverable.completed: move backing task tA INTO a done-category status ('Shipped').
-- recipients = task_notify_recipients(tA) = owner A UNION observer D = 2, PLUS one audit-only
-- companion event (no recipient) emitted once per completion.
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='a0000000-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and payload ? 'recipient_user_id'),
          2, 'completing the backing task emits one deliverable.completed PER RECIPIENT (owner + observer)');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and not (payload ? 'recipient_user_id') and payload->>'id'='d0000000-0000-0000-0000-000000000000'),
          1, 'completing the backing task ALSO emits exactly one audit-only deliverable.completed (bare payload.id, no recipient)');

-- zero-recipient completion still records an audit event. dNR is backed by tNR, which has NO
-- owner/observer -> task_notify_recipients(tNR) is empty -> zero per-recipient events; the audit-only
-- companion guarantees the completion stays observable in the events/audit layer.
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('d00000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','No-Recipient Deliverable','email');
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('a00000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task NR','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','d00000ff-0000-0000-0000-000000000000',
   'implemented_by','task','a00000ff-0000-0000-0000-000000000000');
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='a00000ff-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d00000ff-0000-0000-0000-000000000000'),
          1, 'completing a bridged task whose backing task has NO recipients still yields >=1 audit deliverable.completed (entity_id=deliverable)');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — with only Part A + Task migrations applied (no `000018` yet), no bridge triggers exist: assertions 1, 2, 4, 5, and 6 return `0` (no `deliverable.assigned`/`deliverable.completed` events or jobs — including the audit-only companion and the zero-recipient audit); assertion 3 (`0` expected) happens to pass. (5 failing assertions.)

- [ ] **Step 3: Create the migration with the two bridge triggers (green)**

Create `supabase/migrations/20260701000018_campaigns_bridge.sql` (exact path — do NOT use `supabase migration new`):
```sql
-- Campaigns Phase 5 — Part B. Sorts AFTER Part A's 20260701000017_* campaign migration.
-- Hand-authored task-reuse bridge: DB triggers on Task's OWN tables recover the backing
-- deliverable by a REVERSE public.edges lookup (traverse_edges is forward-only) and emit
-- deliverable.* through public.emit_event. Plus scan_campaigns() (Task 2) and an optional
-- content-publish bridge (Task 3). There is NO event-subscription engine; nothing consumes
-- movp_internal.movp_events — all reuse is these triggers on task_assignment / task.

-- ── deliverable.assigned: task_assignment insert -> recover deliverable -> emit ─
-- REVERSE lookup: Task events carry only task_id (a dst); recover the deliverable (src)
-- directly. NEVER use traverse_edges (forward-only). Coexists with Task's own
-- task_assignment_emit_event_tg (which emits task.assigned) on the same table.
-- Single target = the inserted assignee; per-recipient key deliverable_id:assignee so a 2nd
-- assignee is not deduped. entity_id stays the bare deliverable for inbox/entity resolution.
create or replace function public.deliverable_assigned_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare deliv_id uuid;
begin
  select src_id into deliv_id from public.edges
   where workspace_id = new.workspace_id and dst_type = 'task' and dst_id = new.task_id
     and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
  if deliv_id is not null then
    perform public.emit_event('deliverable.assigned', new.workspace_id,
      jsonb_build_object('id', deliv_id::text || ':' || new.assignee_user_id::text,
                         'entity_type','campaign_deliverable','entity_id', deliv_id,
                         'task_id', new.task_id,
                         'recipient_user_id', new.assignee_user_id),
      gen_random_uuid()::text);
  end if;
  return new;
end; $$;
revoke all on function public.deliverable_assigned_emit_event() from public, anon, authenticated;
drop trigger if exists deliverable_assigned_emit_event_tg on public.task_assignment;
create trigger deliverable_assigned_emit_event_tg after insert on public.task_assignment
  for each row execute function public.deliverable_assigned_emit_event();

-- ── deliverable.completed: backing task transitions INTO a done-category status ─
-- Mirrors Task's category-keyed transition. Coexists with Task's task_status_transition_tg
-- and task_status_recompute_dependents_tg (both after update of status_id on public.task);
-- all three fire, independent. Deliverable recipients = the BACKING TASK's notify set.
create or replace function public.deliverable_completed_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  from_cat text;
  to_cat   text;
  deliv_id uuid;
  r        record;
begin
  -- `after update of status_id` fires even when the value is unchanged; guard it.
  if new.status_id is not distinct from old.status_id then
    return new;
  end if;
  select category into from_cat from public.task_status_option where id = old.status_id;
  select category into to_cat   from public.task_status_option where id = new.status_id;
  if to_cat = 'done' and from_cat is distinct from 'done' then
    select src_id into deliv_id from public.edges
     where workspace_id = new.workspace_id and dst_type = 'task' and dst_id = new.id
       and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
    if deliv_id is not null then
      -- AUDIT-ONLY companion: exactly ONE deliverable.completed per completion, emitted even when
      -- the backing task has zero recipients. Mirrors Task's task_status_transition, which emits an
      -- audit-only task.status_changed on every change (01b). No recipient_user_id/email in the
      -- payload -> emit_event records the event (+ webhook) but enqueues NO notify job. payload.id
      -- is the BARE deliverable id (no ':<recipient>' suffix), so it never collides with a
      -- per-recipient notify key. Without this, a completion whose task has no owner/observer would
      -- emit NOTHING -> the state change would be invisible to the events/audit layer.
      perform public.emit_event('deliverable.completed', new.workspace_id,
        jsonb_build_object('id', deliv_id::text,
                           'entity_type','campaign_deliverable','entity_id', deliv_id,
                           'task_id', new.id),
        gen_random_uuid()::text);
      -- per-recipient notify events: owner ∪ observer of the BACKING task.
      for r in select recipient from public.task_notify_recipients(new.id) loop
        perform public.emit_event('deliverable.completed', new.workspace_id,
          jsonb_build_object('id', deliv_id::text || ':' || r.recipient::text,
                             'entity_type','campaign_deliverable','entity_id', deliv_id,
                             'task_id', new.id,
                             'recipient_user_id', r.recipient),
          gen_random_uuid()::text);
      end loop;
    end if;
  end if;  -- no deliverable / not a done-transition -> no-op
  return new;
end; $$;
revoke all on function public.deliverable_completed_emit_event() from public, anon, authenticated;
drop trigger if exists deliverable_completed_emit_event_tg on public.task;
create trigger deliverable_completed_emit_event_tg after update of status_id on public.task
  for each row execute function public.deliverable_completed_emit_event();
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `campaigns_bridge_test.sql .. ok` (6 assertions); definer-audit exits 0 (`all definers pinned`); `db diff` empty.

- [ ] **Step 5: Gate — both bridge triggers present, reverse lookup used, no `traverse_edges`**

Run:
```bash
grep -cE 'create trigger deliverable_(assigned|completed)_emit_event_tg' \
  supabase/migrations/20260701000018_campaigns_bridge.sql
grep -c "dst_type = 'task' and dst_id" supabase/migrations/20260701000018_campaigns_bridge.sql
grep -c 'traverse_edges' supabase/migrations/20260701000018_campaigns_bridge.sql
```
Expected: the first grep prints `2`; the second prints `2` (both triggers use the reverse lookup); the third prints `0` (traverse_edges is never used in the bridge).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000018_campaigns_bridge.sql supabase/tests/campaigns_bridge_test.sql
git commit -m "feat(db): deliverable assigned/completed task-reuse bridge triggers"
```

---

### Task 2: `scan_campaigns()` date-scan (`campaign.started`/`campaign.ended`/`deliverable.due_soon`) + documented deploy-time cron + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000018_campaigns_bridge.sql` (append part 2)
- Edit: `supabase/tests/campaigns_bridge_test.sql` (add Task 2 block)

**Interfaces:**
- Consumes: `public.emit_event`, `public.task_notify_recipients`, `public.edges`, `public.task`, `public.task_status_option`, Part A's `public.campaign`, `public.campaign_deliverable`.
- Produces: `public.scan_campaigns()` (DEFINER, `search_path=''`). (a) flips `scheduled→active` and emits audit-only `campaign.started`; (b) flips `active→completed` and emits audit-only `campaign.ended`; (c) for each `campaign_deliverable` whose `implemented_by` task is due within one day and not `done`, emits per-recipient DATE-keyed `deliverable.due_soon`. Invariants: (a)/(b) idempotent via the falsified status predicate; (c) idempotent per (deliverable,recipient,date) via the `movp_jobs unique(kind, idempotency_key)` constraint (NOT a stamp — the deliverable has no `*_notified_at` column). The cron that calls it is applied out-of-band (NOT in this migration).

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/campaigns_bridge_test.sql`: change `select plan(6);` to `select plan(16);`, and insert this block immediately BEFORE the final `select * from finish();`. Campaign **c1** (`c111…`, scheduled, starts today, ends future) exercises `campaign.started`; **c2** (`c222…`, active, ended in the past) exercises `campaign.ended`; deliverable **dDue** (`dddd…`) backed by task **tB** (`b000…`, due tomorrow, owner A only) exercises `deliverable.due_soon`:
```sql
-- ── Task 2: scan_campaigns (started / ended / due_soon) ──────────────────────
insert into public.campaign (id, workspace_id, owner_id, start_date, end_date, status) values
  ('c1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', current_date, current_date + 30, 'scheduled'),
  ('c2222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', current_date - 60, current_date - 1, 'active'),
-- c4: scheduled with its ENTIRE window already past -> exercises the catch-up double-flip
-- (scheduled -> active -> completed) in a single scan.
  ('c4444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', current_date - 10, current_date - 5, 'scheduled');
-- due_soon fixture: deliverable dDue (on active c3) -> task tB due tomorrow, owner A only (1 recipient).
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('dddd0000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','Due Soon Deliverable','email');
insert into public.task (id, workspace_id, title, status_id, priority_id, due_date) values
  ('b0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task B','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000', current_date + 1);
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','dddd0000-0000-0000-0000-000000000000',
   'implemented_by','task','b0000000-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');

select public.scan_campaigns();
select is((select status::text from public.campaign where id='c1111111-1111-1111-1111-111111111111'),
          'active', 'a scheduled campaign whose start_date has arrived becomes active');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c1111111-1111-1111-1111-111111111111'),
          1, 'the scheduled->active flip emits exactly one campaign.started (audit-only)');
select is((select status::text from public.campaign where id='c2222222-2222-2222-2222-222222222222'),
          'completed', 'an active campaign past its end_date becomes completed');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.ended' and payload->>'entity_id'='c2222222-2222-2222-2222-222222222222'),
          1, 'the active->completed flip emits exactly one campaign.ended (audit-only)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.due_soon:dddd0000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:'
                                 || to_char(current_date + 1,'YYYY-MM-DD')),
          1, 'a deliverable whose backing task is due tomorrow enqueues one DATE-keyed due_soon notify job');

-- catch-up double-flip: c4's whole window is already past, so the SAME scan flips it
-- scheduled -> active -> completed and emits BOTH campaign.started and campaign.ended.
select is((select status::text from public.campaign where id='c4444444-4444-4444-4444-444444444444'),
          'completed', 'a scheduled campaign whose entire window is past reaches the terminal completed state in one scan (catch-up)');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c4444444-4444-4444-4444-444444444444'),
          1, 'the catch-up double-flip still emits exactly one campaign.started for c4');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.ended' and payload->>'entity_id'='c4444444-4444-4444-4444-444444444444'),
          1, 'the catch-up double-flip also emits exactly one campaign.ended for c4');

-- re-run the SAME day: campaign flips are falsified (idempotent); the due_soon date-key de-dups the job.
select public.scan_campaigns();
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c1111111-1111-1111-1111-111111111111'),
          1, 're-scanning emits no further campaign.started (c1 is no longer scheduled)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.due_soon:dddd0000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:'
                                 || to_char(current_date + 1,'YYYY-MM-DD')),
          1, 're-scanning the same day enqueues no duplicate due_soon notify job (movp_jobs unique on the date key)');
```

Run: `supabase test db`
Expected: FAIL — `function public.scan_campaigns() does not exist`, so the file errors on the first `select public.scan_campaigns();`. (The first 6 Task-1 assertions would otherwise pass.)

- [ ] **Step 2: Append `scan_campaigns` + the cron doc (green)**

Append to `supabase/migrations/20260701000018_campaigns_bridge.sql`:
```sql
-- ── scan_campaigns: date-driven lifecycle flips + deliverable.due_soon ────────
-- Called by a deploy-time cron (documented below, NOT committed); pgTAP/e2e call it directly.
create or replace function public.scan_campaigns()
returns void language plpgsql security definer set search_path = '' as $$
declare
  c record;
  d record;
  r record;
begin
  -- CATCH-UP semantics: this scan is a reconciler, not an event stream. Blocks (a) and (b) run in
  -- sequence, so a `scheduled` campaign whose ENTIRE window is already past flips scheduled->active
  -- in (a) and then active->completed in (b) within the SAME scan, emitting BOTH campaign.started
  -- and campaign.ended and landing in the terminal `completed` state in one pass. That double-flip
  -- is intended (a cron that missed the start_date still reconciles to the correct terminal state).
  -- (a) campaign.started: scheduled -> active once start_date has arrived. The UPDATE's
  -- predicate is falsified by the write, so a re-scan finds no rows -> idempotent, no stamp.
  for c in
    update public.campaign set status = 'active'
     where start_date <= current_date and status = 'scheduled'
    returning id, workspace_id
  loop
    perform public.emit_event('campaign.started', c.workspace_id,
      jsonb_build_object('id', c.id, 'entity_type','campaign','entity_id', c.id, 'status','active'),
      gen_random_uuid()::text);  -- audit-only: no recipient -> emit_event enqueues no notify job
  end loop;

  -- (b) campaign.ended: active -> completed once end_date has passed. Same idempotency.
  for c in
    update public.campaign set status = 'completed'
     where end_date < current_date and status = 'active'
    returning id, workspace_id
  loop
    perform public.emit_event('campaign.ended', c.workspace_id,
      jsonb_build_object('id', c.id, 'entity_type','campaign','entity_id', c.id, 'status','completed'),
      gen_random_uuid()::text);
  end loop;

  -- (c) deliverable.due_soon: each deliverable's implemented_by task due within one day and
  -- not done. REVERSE-join campaign_deliverable -> edges -> task. Fan out per recipient of the
  -- BACKING task's notify set. IDEMPOTENCY: the deliverable has no *_notified_at column, so a
  -- re-scan re-inserts the event but the DATE-keyed payload.id makes the notify idempotency_key
  -- identical -> movp_jobs unique(kind, idempotency_key) drops the duplicate job.
  -- RECIPIENT-GATED (deliberate, UNLIKE deliverable.completed): due_soon has NO audit-only
  -- companion. A reminder for a deliverable whose backing task has zero recipients has nobody to
  -- remind and carries no audit value, so it emits nothing. Completion, by contrast, is a state
  -- fact worth recording even with no recipients (hence its audit-only companion above).
  for d in
    select cd.id as deliverable_id, cd.workspace_id, tk.id as task_id, tk.due_date
      from public.campaign_deliverable cd
      join public.edges e
        on e.workspace_id = cd.workspace_id and e.src_type = 'campaign_deliverable'
       and e.src_id = cd.id and e.rel = 'implemented_by' and e.dst_type = 'task'
      join public.task tk on tk.id = e.dst_id
      join public.task_status_option so on so.id = tk.status_id
     where tk.due_date is not null and tk.due_date <= (current_date + 1) and so.category <> 'done'
  loop
    for r in select recipient from public.task_notify_recipients(d.task_id) loop
      perform public.emit_event('deliverable.due_soon', d.workspace_id,
        jsonb_build_object('id', d.deliverable_id::text || ':' || r.recipient::text || ':'
                                 || to_char(d.due_date,'YYYY-MM-DD'),
                           'entity_type','campaign_deliverable','entity_id', d.deliverable_id,
                           'task_id', d.task_id,
                           'recipient_user_id', r.recipient,
                           'due_date', to_char(d.due_date,'YYYY-MM-DD')),
        gen_random_uuid()::text);
    end loop;
  end loop;
end; $$;
revoke all on function public.scan_campaigns() from public, anon, authenticated;

-- ── DEPLOY-TIME CRON (documentation only — NOT applied by this migration) ────
-- Schedule out-of-band so `supabase db diff` stays empty and no secret is committed.
-- At deploy time (with any service key sourced from Vault, never a literal), run e.g.:
--   select cron.schedule('campaigns-scan', '*/15 * * * *', $cron$ select public.scan_campaigns(); $cron$);
-- scan_campaigns reads only local tables and fans out via emit_event -> movp_jobs, so it needs
-- no secret itself; the Vault key belongs to the notify worker that drains the jobs. Mirrors
-- Task's emit_due_soon cron doc. pgTAP/e2e call `select public.scan_campaigns();` directly.
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `campaigns_bridge_test.sql .. ok` (16 assertions); definer-audit exits 0; `db diff` empty (the cron is not committed, so no `cron.*` object appears).

- [ ] **Step 4: Gate — function committed, cron NOT committed**

Run:
```bash
grep -q "create or replace function public.scan_campaigns()" supabase/migrations/20260701000018_campaigns_bridge.sql && echo FN_OK
grep -c "^select cron.schedule" supabase/migrations/20260701000018_campaigns_bridge.sql
```
Expected: prints `FN_OK`; the second grep prints `0` (the only `cron.schedule` mention is inside a `--` comment, never an executable statement).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000018_campaigns_bridge.sql supabase/tests/campaigns_bridge_test.sql
git commit -m "feat(db): scan_campaigns date-scan (started/ended/due_soon) + documented cron"
```

---

### Task 3 (OPTIONAL / DEFERRED): `content.published` → `deliverable.published_ready` readiness bridge + pgTAP

> **This task is OPTIONAL and DEFERRED by default.** The roadmap lists it as "optional." It has a **cross-phase dependency**: `public.content_publish_event` is produced by the CMS phase (app-02). If that table does not yet exist in the applied schema, **SKIP this task entirely** — Tasks 1, 2, and 4 are the core deliverable and stand without it. Implement it only once `public.content_publish_event` exists; do not add a placeholder table for it here.

**Files (only if implementing):**
- Edit: `supabase/migrations/20260701000018_campaigns_bridge.sql` (append part 3)
- Edit: `supabase/tests/campaigns_bridge_test.sql` (add Task 3 block; bump `plan(16)` → `plan(18)`)

**Interfaces:**
- Consumes: `public.emit_event`, `public.edges`, Part A's `public.campaign_deliverable`, and the CMS phase's `public.content_publish_event` (`content_item_id`, `action`) + `public.campaign` (`owner_id`).
- Produces: `public.content_published_ready_emit_event()` (DEFINER, AFTER INSERT on `content_publish_event` WHEN `new.action='publish'`). Recovers the deliverable via the reverse `produces` edge (`dst_type='content_item', dst_id=new.content_item_id, rel='produces', src_type='campaign_deliverable'`), resolves its campaign (`campaign_deliverable.campaign_id`), and emits `deliverable.published_ready` to the campaign owner. No deliverable → no-op.

- [ ] **Step 0: Guard — is the dependency present?**

Run:
```bash
grep -rlE 'create table[^;]*public\.content_publish_event|content_publish_event' supabase/migrations/ | head -1
```
If this returns nothing (or the table is absent from `supabase db reset`), **STOP and mark this task DEFERRED** in the tracking checklist; proceed to Task 4. Otherwise continue.

- [ ] **Step 1: Extend the pgTAP (red)** — bump `select plan(16);` to `select plan(18);` and add, before `finish()`, a block that: seeds a content_item + a `produces` edge (`campaign_deliverable d0 -> content_item ci`), inserts a `content_publish_event` with `action='publish'`, then asserts one `deliverable.published_ready` event with `entity_id=d0` and `recipient_user_id` = c3's `owner_id` (A); plus a negative `action='unpublish'` row → no event. Run `supabase test db`; Expected: FAIL — `function public.content_published_ready_emit_event()` (and its trigger) do not exist, so the two new assertions return `0`.

- [ ] **Step 2: Append the trigger (green)**

Append to `supabase/migrations/20260701000018_campaigns_bridge.sql`:
```sql
-- ── (OPTIONAL) content publish -> deliverable.published_ready ─────────────────
-- Only meaningful once the CMS phase's public.content_publish_event exists. Reverse edges:
-- content_item (dst) -> its producing deliverable (src). Notify the campaign owner.
create or replace function public.content_published_ready_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  deliv_id  uuid;
  camp_id   uuid;
  camp_ws   uuid;
  camp_owner uuid;
begin
  if new.action <> 'publish' then
    return new;
  end if;
  select src_id into deliv_id from public.edges
   where workspace_id = new.workspace_id and dst_type = 'content_item' and dst_id = new.content_item_id
     and rel = 'produces' and src_type = 'campaign_deliverable' limit 1;
  if deliv_id is null then
    return new;  -- content not tied to a deliverable -> no-op
  end if;
  select cd.campaign_id, cd.workspace_id into camp_id, camp_ws
    from public.campaign_deliverable cd where cd.id = deliv_id;
  select c.owner_id into camp_owner from public.campaign c where c.id = camp_id;
  perform public.emit_event('deliverable.published_ready', camp_ws,
    jsonb_build_object('id', deliv_id::text || ':' || camp_owner::text,
                       'entity_type','campaign_deliverable','entity_id', deliv_id,
                       'campaign_id', camp_id, 'content_item_id', new.content_item_id,
                       'recipient_user_id', camp_owner),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.content_published_ready_emit_event() from public, anon, authenticated;
drop trigger if exists content_published_ready_emit_event_tg on public.content_publish_event;
create trigger content_published_ready_emit_event_tg after insert on public.content_publish_event
  for each row execute function public.content_published_ready_emit_event();
```

- [ ] **Step 3: Apply + test + definer audit + drift** — `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff`. Expected: `campaigns_bridge_test.sql .. ok` (18 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Commit** — `git commit -m "feat(db): optional content.published deliverable-ready bridge"`.

---

### Task 4: `campaign` domain service (`campaign.ts`) + `createDomain` wiring + integration test

**Files:**
- Create: `packages/domain/src/campaign.ts`
- Edit: `packages/domain/src/types.ts` (add `CampaignService` + a `campaign` field on the aggregate `Domain` interface)
- Edit: `packages/domain/src/domain.ts` (wire `campaign: makeCampaignService(ctx)` into `createDomain`, ALONGSIDE the existing `collab: makeCollabService(ctx)` entry — `createDomain` lives in `domain.ts`, which currently returns `{ note, tag, search, graph, collab }`)
- Edit: `packages/domain/src/index.ts` (re-export ONLY — `export { makeCampaignService } from './campaign.ts'` + the `CampaignService` type; `index.ts` does NOT construct `createDomain`)
- Create: `packages/domain/test/campaign.integration.test.ts`

**Interfaces:**
- Consumes: `DomainCtx` + the `fail`-closure idiom from the SIBLING `content.ts`; `makeGraphService(ctx).link(...)` from `./graph.ts` (camelCase `{ workspaceId, srcType, srcId, rel, dstType, dstId }`); `ctx.db` (caller-RLS Supabase client) against `campaign`, `campaign_deliverable`, `edges`, `task`.
- Produces: `makeCampaignService(ctx: DomainCtx): CampaignService`. Edges written: `linkTask` → `campaign_deliverable --implemented_by--> task`; `linkContent` → `campaign_deliverable --produces--> content_item`; `linkSegment` → `campaign --targets--> campaign_segment` (inert until Phase 6); `addObserver` → `campaign --observer--> user`. `deliverableSchedule` reverse-reads the `implemented_by` task and returns its `{ taskId, startDate, dueDate }` or `null`; `deliverableSchedules` BATCHES that same read across many deliverables in exactly two queries (edges `.in('src_id', …)` + task `.in('id', …)`) so Part C's timeline view never issues an N+1. All failures route through `fail(op, code)` → `domain.campaign.<op> failed [<code>]`. GRAPH-WRITE BOUNDARY: because `public.edges` has no FK to its polymorphic destination, `linkTask` validates the task is a same-workspace, caller-visible row (`fail [task_not_found]`) and `addObserver` validates the target is a workspace member (`fail [user_not_member]`) BEFORE writing the edge — so no dangling backing-task edge and no outsider-notification edge can persist. `linkContent`/`linkSegment` intentionally skip destination validation (see their impl notes).

- [ ] **Step 1: Write the failing integration test (red)**

Create `packages/domain/test/campaign.integration.test.ts` by CLONING the five harness helpers from `packages/domain/test/collab.integration.test.ts` — `serviceClient()`, `userClient(token)`, `makeUser()`, `makeWorkspace(name)`, `addMember(ws, userId)` — VERBATIM (same `env`/`admin` header preamble). NOTE: `collab.integration.test.ts` is a **single `it()` with all setup inline — it has NO `beforeAll`/`afterAll` and NO seed helpers**, so the `beforeAll` and the `seed*` helpers below are NET-NEW, defined in this file (do not claim to "reuse" them). Cloned-helper signatures to honor exactly: `makeUser(): Promise<{ id: string; token: string }>`, `makeWorkspace(name: string): Promise<string>` (takes a workspace NAME, returns its id, and firing that insert runs the `000008` workspace-seed trigger that creates the workspace's default `task_status_option`/`task_priority_option`), `addMember(ws, userId)` (adds as role `member`). Then the campaign-specific body:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'
// serviceClient(), userClient(token), makeUser(), makeWorkspace(name), addMember(ws, userId)
// are pasted VERBATIM from collab.integration.test.ts (with its env/admin preamble). That file
// is a single it() with inline setup — it has NO beforeAll/afterAll and NO seed helpers, so the
// beforeAll + seed* helpers here are new. All seeding uses the SERVICE-ROLE client (RLS-independent,
// so it can seed a workspace the acting user is NOT a member of); the acting `domain` is built from
// a USER-JWT client (createDomain runs under caller RLS — production-shaped, no service role injected).

let ws: string        // the acting user IS a member here
let otherWs: string   // the acting user is NOT a member here (RLS must hide its rows)
let db: ReturnType<typeof userClient>          // caller-RLS client for the acting user
let domain: ReturnType<typeof createDomain>    // createDomain({ db, userId }) — RLS-bound
let OTHER_USER_ID: string
const wsOwner: Record<string, string> = {}     // ws -> the user id that owns campaigns seeded in it

beforeAll(async () => {
  const user = await makeUser()                 // primary actor
  const other = await makeUser()                // 2nd user: observer target + owner of otherWs
  OTHER_USER_ID = other.id
  ws = await makeWorkspace('Campaign WS')        // insert fires 000008 seed -> default task options
  await addMember(ws, user.id)
  await addMember(ws, other.id)                  // OTHER_USER_ID is a MEMBER of ws — a valid observer target (addObserver member-gates)
  otherWs = await makeWorkspace('Other WS')      // user deliberately NOT added -> RLS hides it
  wsOwner[ws] = user.id
  wsOwner[otherWs] = other.id                    // otherWs campaigns owned by `other`, not the actor
  db = userClient(user.token)                    // user JWT -> caller RLS
  domain = createDomain({ db, userId: user.id }) // production-shaped user ctx (NO service role)
})

// ── seed helpers (service-role inserts; return the ids the assertions use) ──────
// GOTCHA: campaign.owner_id / deliverable / task all need valid workspace-scoped rows; task
// needs NON-NULL status_id + priority_id resolved from the 000008 workspace-seed default options.
async function defaultTaskOptions(wsId: string): Promise<{ statusId: string; priorityId: string }> {
  const svc = serviceClient()
  const { data: st } = await svc.from('task_status_option').select('id')
    .eq('workspace_id', wsId).eq('is_default', true).limit(1).single()
  const { data: pr } = await svc.from('task_priority_option').select('id')
    .eq('workspace_id', wsId).eq('is_default', true).limit(1).single()
  return { statusId: (st as { id: string }).id, priorityId: (pr as { id: string }).id }
}

async function seedCampaign(wsId: string): Promise<string> {
  const { data, error } = await serviceClient().from('campaign')
    .insert({ workspace_id: wsId, owner_id: wsOwner[wsId], start_date: '2026-01-01', end_date: '2026-12-31', status: 'active' })
    .select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

// deliverable + backing task, but NO implemented_by edge — the edge is written by the tests that
// need it (via domain.campaign.linkTask), so the "no backing task" + isolation cases stay valid.
async function seedDeliverableAndTask(
  wsId: string,
  opts: { dueDate?: string } = {},
): Promise<{ campaignId: string; deliverableId: string; taskId: string }> {
  const svc = serviceClient()
  const campaignId = await seedCampaign(wsId)
  const { data: deliv, error: dErr } = await svc.from('campaign_deliverable')
    .insert({ workspace_id: wsId, campaign_id: campaignId, name: 'Launch Email', deliverable_type: 'email' })
    .select('id').single()
  if (dErr) throw dErr
  const { statusId, priorityId } = await defaultTaskOptions(wsId)
  const { data: task, error: tErr } = await svc.from('task')
    .insert({ workspace_id: wsId, title: 'Backing Task', status_id: statusId, priority_id: priorityId, due_date: opts.dueDate ?? null })
    .select('id').single()
  if (tErr) throw tErr
  return { campaignId, deliverableId: (deliv as { id: string }).id, taskId: (task as { id: string }).id }
}

// content_item is a CMS-phase table; edges.dst_id is an opaque typed-uuid (heterogeneous dst_types
// -> NO FK), so a produces-edge test needs only an id, not a real content_item row.
async function seedContentItem(_wsId: string): Promise<string> {
  return crypto.randomUUID()
}

describe('campaign domain service', () => {
  it('linkTask writes an implemented_by edge deliverable -> task', async () => {
    const { deliverableId, taskId } = await seedDeliverableAndTask(ws)
    await domain.campaign.linkTask({ deliverableId, taskId })
    const { data } = await db.from('edges').select('rel, dst_id')
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId)
      .eq('rel', 'implemented_by').eq('dst_type', 'task').maybeSingle()
    expect(data?.dst_id).toBe(taskId)
  })

  it('linkContent writes a produces edge deliverable -> content_item', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws)
    const contentItemId = await seedContentItem(ws)
    await domain.campaign.linkContent({ deliverableId, contentItemId })
    const { data } = await db.from('edges').select('dst_id')
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId)
      .eq('rel', 'produces').eq('dst_type', 'content_item').maybeSingle()
    expect(data?.dst_id).toBe(contentItemId)
  })

  it('addObserver writes a campaign -> user observer edge', async () => {
    const campaignId = await seedCampaign(ws)
    await domain.campaign.addObserver({ campaignId, userId: OTHER_USER_ID })
    const { data } = await db.from('edges').select('dst_id')
      .eq('src_type', 'campaign').eq('src_id', campaignId)
      .eq('rel', 'observer').eq('dst_type', 'user').maybeSingle()
    expect(data?.dst_id).toBe(OTHER_USER_ID)
  })

  it('linkTask rejects a missing/cross-workspace task and writes NO dangling edge', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws) // deliverable in ws; do NOT link
    await expect(domain.campaign.linkTask({ deliverableId, taskId: crypto.randomUUID() }))
      .rejects.toThrow(/domain\.campaign\.linkTask failed \[task_not_found\]/)
    const { count } = await db.from('edges').select('*', { count: 'exact', head: true })
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId).eq('rel', 'implemented_by')
    expect(count).toBe(0) // no dangling backing-task edge persisted
  })

  it('addObserver rejects a NON-member target and writes NO observer edge (no email to outsiders)', async () => {
    const campaignId = await seedCampaign(ws)
    const outsider = crypto.randomUUID() // not in workspace_membership for ws
    await expect(domain.campaign.addObserver({ campaignId, userId: outsider }))
      .rejects.toThrow(/domain\.campaign\.addObserver failed \[user_not_member\]/)
    const { count } = await db.from('edges').select('*', { count: 'exact', head: true })
      .eq('src_type', 'campaign').eq('src_id', campaignId).eq('rel', 'observer')
    expect(count).toBe(0) // the non-member never enters the notification fan-out
  })

  it('deliverableSchedule returns the backing task dates', async () => {
    const { deliverableId, taskId } = await seedDeliverableAndTask(ws, { dueDate: '2026-08-01' })
    await domain.campaign.linkTask({ deliverableId, taskId })
    const sched = await domain.campaign.deliverableSchedule(deliverableId)
    expect(sched).toEqual({ taskId, startDate: null, dueDate: '2026-08-01' })
  })

  it('deliverableSchedules resolves two deliverables in ONE batched call (no N+1)', async () => {
    const a = await seedDeliverableAndTask(ws, { dueDate: '2026-08-01' })
    const b = await seedDeliverableAndTask(ws, { dueDate: '2026-09-01' })
    await domain.campaign.linkTask({ deliverableId: a.deliverableId, taskId: a.taskId })
    await domain.campaign.linkTask({ deliverableId: b.deliverableId, taskId: b.taskId })
    const rows = await domain.campaign.deliverableSchedules([a.deliverableId, b.deliverableId])
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      { deliverableId: a.deliverableId, taskId: a.taskId, startDate: null, dueDate: '2026-08-01' },
      { deliverableId: b.deliverableId, taskId: b.taskId, startDate: null, dueDate: '2026-09-01' },
    ]))
  })

  it('deliverableSchedule returns null when the deliverable has no backing task', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws) // no linkTask
    expect(await domain.campaign.deliverableSchedule(deliverableId)).toBeNull()
  })

  it('is workspace-isolated: a deliverable in another workspace is invisible under RLS', async () => {
    const other = await seedDeliverableAndTask(otherWs) // seeded in a workspace the signed-in user is NOT a member of
    await expect(domain.campaign.deliverableSchedule(other.deliverableId)).resolves.toBeNull()
    await expect(domain.campaign.linkTask({ deliverableId: other.deliverableId, taskId: other.taskId }))
      .rejects.toThrow(/domain\.campaign\.linkTask failed \[deliverable_not_found\]/)
  })
})
```
Run: `pnpm --filter @movp/domain test campaign.integration`
Expected: FAIL — `domain.campaign` is `undefined` (the service is not created yet) / `campaign.ts` does not exist. (All cases error.)

- [ ] **Step 2: Add the `CampaignService` interface to `types.ts` (green scaffolding)**

In `packages/domain/src/types.ts`, add the interface (verbatim) next to the other service interfaces, and add a `campaign: CampaignService` field to the aggregate `Domain` interface (the one that already lists `content`, `collab`, `graph`, etc. — mirror that field's placement):
```ts
export interface CampaignService {
  linkTask(i: { deliverableId: string; taskId: string }): Promise<void>                 // edge deliverable -> task (implemented_by); rejects [task_not_found] if the task is missing or cross-workspace
  linkContent(i: { deliverableId: string; contentItemId: string }): Promise<void>       // edge deliverable -> content_item (produces)
  linkSegment(i: { campaignId: string; segmentId: string }): Promise<void>              // edge campaign -> segment (targets; inert until Phase 6)
  addObserver(i: { campaignId: string; userId: string }): Promise<void>                 // edge campaign -> user (observer); rejects [user_not_member] — target MUST be a workspace member (feeds notification fan-out); NOT owner-gated by design (see impl note)
  deliverableSchedule(deliverableId: string): Promise<{ taskId: string; startDate: string | null; dueDate: string | null } | null> // reverse edge -> backing task's dates
  deliverableSchedules(deliverableIds: string[]): Promise<Array<{ deliverableId: string; taskId: string; startDate: string | null; dueDate: string | null }>> // BATCHED: all backing-task dates in TWO queries (edges .in + task .in) — avoids Part C timeline N+1
}
```

- [ ] **Step 3: Create `campaign.ts` (green)**

Create `packages/domain/src/campaign.ts`. Mirror the SIBLING `content.ts` for the exact `DomainCtx` import path and the `fail` idiom (copy them from `content.ts` so they match). GOTCHA: `content` and `campaign` are siblings — instantiate a LOCAL `const graph = makeGraphService(ctx)`; there is NO `this.graph`. `link` is camelCase. Resolve a deliverable's workspace via a `campaign_deliverable` probe, and a campaign's workspace via a `campaign` probe — both under caller RLS, so a cross-workspace id returns no row (→ `fail(op, 'deliverable_not_found')` / `'campaign_not_found'`), which is how RLS isolation surfaces.
```ts
import { makeGraphService } from './graph.ts'
import type { DomainCtx, CampaignService } from './types.ts' // match content.ts's import style/paths

export function makeCampaignService(ctx: DomainCtx): CampaignService {
  const graph = makeGraphService(ctx) // sibling — NOT this.graph

  const fail = (op: string, code: string): never => {
    throw new Error(`domain.campaign.${op} failed [${code}]`)
  }

  // probe a deliverable's workspace (+ its campaign) under caller RLS
  async function deliverableWorkspace(op: string, deliverableId: string): Promise<{ workspaceId: string; campaignId: string }> {
    const { data, error } = await ctx.db
      .from('campaign_deliverable')
      .select('workspace_id, campaign_id')
      .eq('id', deliverableId)
      .maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'deliverable_not_found') // includes cross-workspace (RLS hides the row)
    return { workspaceId: data.workspace_id, campaignId: data.campaign_id }
  }

  // probe a campaign's workspace under caller RLS
  async function campaignWorkspace(op: string, campaignId: string): Promise<string> {
    const { data, error } = await ctx.db
      .from('campaign')
      .select('workspace_id')
      .eq('id', campaignId)
      .maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'campaign_not_found')
    return data.workspace_id
  }

  // GRAPH-WRITE BOUNDARY (load-bearing): `public.edges` has NO FK to its polymorphic (dst_type,dst_id),
  // so graph.link will happily persist a DANGLING or CROSS-WORKSPACE edge. The two ops whose bad edge causes
  // real harm validate their destination under caller RLS BEFORE writing: linkTask (a bad task edge silently
  // never bridges/schedules → validate same-workspace task) and addObserver (an observer edge feeds the email
  // fan-out → validate the target is a member). linkContent + linkSegment document why they intentionally don't.
  async function requireSameWorkspace(op: string, table: string, id: string, workspaceId: string, code: string): Promise<void> {
    const { data, error } = await ctx.db.from(table).select('workspace_id').eq('id', id).maybeSingle()
    if (error) return fail(op, 'probe_failed') // fail(): never — matches the deliverableWorkspace idiom above
    // null → missing OR RLS-hidden (caller not a member of its workspace); mismatch → cross-workspace.
    if (!data || data.workspace_id !== workspaceId) return fail(op, code)
  }
  // member_read RLS (`using is_workspace_member(workspace_id)`, migration 000001) lets a member SELECT
  // co-member rows, so the caller can confirm the target is a member of the campaign's workspace.
  async function requireMember(op: string, workspaceId: string, userId: string): Promise<void> {
    const { data, error } = await ctx.db.from('workspace_membership').select('user_id')
      .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
    if (error) return fail(op, 'probe_failed')
    if (!data) return fail(op, 'user_not_member')
  }

  return {
    async linkTask({ deliverableId, taskId }) {
      const { workspaceId } = await deliverableWorkspace('linkTask', deliverableId)
      await requireSameWorkspace('linkTask', 'task', taskId, workspaceId, 'task_not_found')
      await graph.link({ workspaceId, srcType: 'campaign_deliverable', srcId: deliverableId, rel: 'implemented_by', dstType: 'task', dstId: taskId })
    },
    async linkContent({ deliverableId, contentItemId }) {
      const { workspaceId } = await deliverableWorkspace('linkContent', deliverableId)
      // NOTE: contentItemId is NOT strictly validated — a dangling produces-edge is a MINOR gap (it yields no
      // readiness signal, but no email fan-out and no silent bridge failure, unlike a bad linkTask). Validating
      // it would couple this phase's test to CMS's content_item insert shape; deferred by choice. (linkTask and
      // addObserver, whose bad edges DO cause harm, are validated.)
      await graph.link({ workspaceId, srcType: 'campaign_deliverable', srcId: deliverableId, rel: 'produces', dstType: 'content_item', dstId: contentItemId })
    },
    async linkSegment({ campaignId, segmentId }) {
      const workspaceId = await campaignWorkspace('linkSegment', campaignId)
      // FORWARD SEAM: segmentId is intentionally NOT validated — the `segment` table does not exist until
      // Phase 6. The edge is written now (targeting INTENT) and resolves to zero rows until Phase 6 lands
      // `segment` (roadmap forward-compat design). This is the only link op whose destination cannot be checked.
      await graph.link({ workspaceId, srcType: 'campaign', srcId: campaignId, rel: 'targets', dstType: 'campaign_segment', dstId: segmentId })
    },
    async addObserver({ campaignId, userId }) {
      // AUTHORIZATION: NOT owner-gated (any member may add an observer — additive, grants no row visibility),
      // BUT the target userId MUST be a workspace member. A campaign observer edge feeds the notification/
      // webhook fan-out (campaign recipients = owner_id + observer edges), so an edge to a NON-member would
      // route campaign emails to someone outside the tenant. requireMember enforces membership. (If a product
      // rule later requires owner-only observer management, add that gate too — this only bounds the target.)
      const workspaceId = await campaignWorkspace('addObserver', campaignId)
      await requireMember('addObserver', workspaceId, userId)
      await graph.link({ workspaceId, srcType: 'campaign', srcId: campaignId, rel: 'observer', dstType: 'user', dstId: userId })
    },
    async deliverableSchedule(deliverableId) {
      const { data: edge, error: edgeErr } = await ctx.db
        .from('edges')
        .select('dst_id')
        .eq('src_type', 'campaign_deliverable')
        .eq('src_id', deliverableId)
        .eq('rel', 'implemented_by')
        .eq('dst_type', 'task')
        .maybeSingle()
      if (edgeErr) return fail('deliverableSchedule', 'edge_probe_failed')
      if (!edge) return null
      const taskId = edge.dst_id as string
      const { data: task, error: taskErr } = await ctx.db
        .from('task')
        .select('id, start_date, due_date')
        .eq('id', taskId)
        .maybeSingle()
      if (taskErr) return fail('deliverableSchedule', 'task_probe_failed')
      if (!task) return null
      return { taskId: task.id, startDate: task.start_date, dueDate: task.due_date }
    },
    // BATCHED sibling of deliverableSchedule: resolve every deliverable's backing-task dates in
    // exactly TWO caller-RLS queries (edges .in + task .in), so a timeline over N deliverables is
    // O(1) round-trips, not O(N). Deliverables with no implemented_by edge are simply absent from
    // the result (no null placeholder). Order is not guaranteed — callers key by deliverableId.
    async deliverableSchedules(deliverableIds) {
      if (deliverableIds.length === 0) return []
      const { data: edges, error: edgeErr } = await ctx.db
        .from('edges')
        .select('src_id, dst_id')
        .in('src_id', deliverableIds)
        .eq('src_type', 'campaign_deliverable')
        .eq('rel', 'implemented_by')
        .eq('dst_type', 'task')
      if (edgeErr) return fail('deliverableSchedules', 'edge_probe_failed')
      const rows = edges ?? []
      const taskIds = rows.map((e) => e.dst_id as string)
      if (taskIds.length === 0) return []
      const { data: tasks, error: taskErr } = await ctx.db
        .from('task')
        .select('id, start_date, due_date')
        .in('id', taskIds)
      if (taskErr) return fail('deliverableSchedules', 'task_probe_failed')
      const byId = new Map((tasks ?? []).map((t) => [t.id as string, t]))
      return rows.flatMap((e) => {
        const t = byId.get(e.dst_id as string)
        return t
          ? [{ deliverableId: e.src_id as string, taskId: t.id as string,
               startDate: t.start_date as string | null, dueDate: t.due_date as string | null }]
          : []
      })
    },
  }
}
```

- [ ] **Step 4: Wire `createDomain` in `domain.ts` + re-export in `index.ts` (green)**

`createDomain` lives in `packages/domain/src/domain.ts`, NOT `index.ts` — `index.ts` only re-exports. Make TWO edits: (a) add the wiring to `createDomain` in `domain.ts`, alongside the existing `collab: makeCollabService(ctx)` entry (same `ctx` variable it already threads; `createDomain` currently returns `{ note, tag, search, graph, collab }`); (b) add the value + type re-exports to `index.ts`, mirroring how the other services are re-exported there:
```ts
// packages/domain/src/domain.ts — the wiring goes HERE (this is where createDomain is defined)
import { makeCampaignService } from './campaign.ts'
// ...inside createDomain's returned object, next to collab: makeCollabService(ctx):
    campaign: makeCampaignService(ctx),

// packages/domain/src/index.ts — RE-EXPORT ONLY (index.ts does NOT construct createDomain):
export { makeCampaignService } from './campaign.ts'
export type { CampaignService } from './types.ts'
```

- [ ] **Step 5: Typecheck + run the integration test**

Run:
```bash
pnpm --filter @movp/domain typecheck && pnpm --filter @movp/domain test campaign.integration
```
Expected: typecheck clean (no `any`; the `edge.dst_id as string` cast is the only assertion and is bounded); `campaign.integration.test.ts` passes all cases; other domain suites unaffected.

- [ ] **Step 6: Gate — service wired, no `this.graph`, no `any`**

Run:
```bash
grep -q "campaign: makeCampaignService(ctx)" packages/domain/src/domain.ts && echo WIRED_OK
grep -q "export { makeCampaignService } from './campaign.ts'" packages/domain/src/index.ts && echo REEXPORT_OK
grep -c "this.graph" packages/domain/src/campaign.ts
grep -cE ':\s*any(\b|\[)' packages/domain/src/campaign.ts
```
Expected: prints `WIRED_OK` (the wiring is in `domain.ts` where `createDomain` lives — NOT `index.ts`); prints `REEXPORT_OK` (`index.ts` re-exports only); the third grep prints `0` (local `const graph`, never `this.graph`); the fourth prints `0` (no `any`).

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/campaign.ts packages/domain/src/types.ts packages/domain/src/domain.ts packages/domain/src/index.ts packages/domain/test/campaign.integration.test.ts
git commit -m "feat(domain): campaign service (task-reuse edges + deliverable schedule)"
```

---

## Self-Review

- **Spec coverage (Part B scope):** the two task-reuse bridge triggers on Task's OWN tables — `deliverable.assigned` (AFTER INSERT on `task_assignment`) and `deliverable.completed` (AFTER UPDATE OF `status_id` on `task`), both recovering the deliverable by the REVERSE `edges` lookup (Task 1); `scan_campaigns()` emitting `campaign.started`/`campaign.ended`/`deliverable.due_soon` with documented (uncommitted) cron (Task 2); the OPTIONAL/DEFERRED `content.published` readiness bridge (Task 3); and the `campaign` domain service + `createDomain` wiring + integration test (Task 4). Tasks 1–3 are TDD (red → green) ending with the apply gate `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` + a targeted grep; Task 4 ends with typecheck + vitest + a grep gate.
- **Bridge trigger SITES + the REVERSE lookup (not `traverse_edges`):**
  - `deliverable_assigned_emit_event_tg` — `after insert on public.task_assignment`; recovers `deliv_id` from `new.task_id`.
  - `deliverable_completed_emit_event_tg` — `after update of status_id on public.task`; recovers `deliv_id` from `new.id` on a done-transition.
  - Both use the DIRECT reverse lookup (traverse_edges is forward-only and MUST NOT be used):
    ```sql
    select src_id into deliv_id from public.edges
     where workspace_id = <ws> and dst_type = 'task' and dst_id = <task>
       and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
    ```
  - Both coexist with Task's own triggers on the same tables (`task_assignment_emit_event_tg`, `task_status_transition_tg`, `task_status_recompute_dependents_tg`); distinct event types, no interference.
- **`scan_campaigns()` STRUCTURE:** one DEFINER function, `search_path=''`, three sequential blocks — (a) `update campaign set status='active' where start_date<=current_date and status='scheduled' returning …` → audit-only `campaign.started`; (b) `update … status='completed' where end_date<current_date and status='active' returning …` → audit-only `campaign.ended`; (c) `campaign_deliverable ⨝ edges(implemented_by) ⨝ task ⨝ task_status_option` filtered `due_date<=current_date+1 and category<>'done'`, fanning out per `task_notify_recipients(task_id)` with the DATE-keyed per-recipient `payload.id`. (a)/(b) are idempotent because the update falsifies its own predicate; (c) is idempotent at the JOB level via the date key + `movp_jobs unique(kind, idempotency_key)`. CATCH-UP double-flip (documented + pgTAP-pinned): because (a) then (b) run in sequence, a `scheduled` campaign whose entire window is already past reaches the terminal `completed` state in a single scan, emitting BOTH `campaign.started` and `campaign.ended` — intended reconciler behavior, not a bug.
- **`CampaignService` INTERFACE (verbatim):**
  ```
  linkTask(i:{deliverableId,taskId}):Promise<void>                 // deliverable --implemented_by--> task
  linkContent(i:{deliverableId,contentItemId}):Promise<void>       // deliverable --produces--> content_item
  linkSegment(i:{campaignId,segmentId}):Promise<void>              // campaign --targets--> segment (inert until Phase 6)
  addObserver(i:{campaignId,userId}):Promise<void>                 // campaign --observer--> user; NOT owner-gated, but target MUST be a member (rejects [user_not_member])
  deliverableSchedule(deliverableId):Promise<{taskId,startDate,dueDate}|null>  // reverse edge -> backing task dates
  deliverableSchedules(deliverableIds[]):Promise<Array<{deliverableId,taskId,startDate,dueDate}>>  // BATCHED (2 queries) -> avoids Part C timeline N+1
  ```
  Edges written via `makeGraphService(ctx).link(...)` (local `const graph`, NOT `this.graph`); failures via `fail(op, code)` → `domain.campaign.<op> failed [<code>]`. GRAPH-WRITE BOUNDARY: `linkTask` validates a same-workspace, caller-visible task (`[task_not_found]`) and `addObserver` validates the target is a workspace member (`[user_not_member]`) BEFORE writing the edge — no dangling backing-task edge, no outsider-notification edge. `addObserver` is intentionally not OWNER-gated (any member may add an observer), but IS member-gated on the target.
- **OWNER/OBSERVER RECIPIENT SPLIT (roadmap divergence flagged):** the roadmap's "reuse Task's observer edges" for campaigns is WRONG and is NOT followed. Explicit split:
  - **Deliverable events** (`deliverable.assigned`/`completed`/`due_soon`) → the BACKING TASK's people: `deliverable.assigned` targets the single inserted assignee; `deliverable.completed`/`due_soon` fan out over `public.task_notify_recipients(task_id)` (DISTINCT owner ∪ observer). A deliverable has no assignees of its own, so its recipients ARE the Task's.
  - **Campaign recipients** (used by the domain `addObserver` and, downstream, campaign-scoped notifications) → Campaigns' OWN `campaign.owner_id` + `campaign --observer--> user` EDGES (written by `addObserver`), never Task's observer tables. `addObserver` is deliberately NOT OWNER-gated (any member may add an observer — additive, grants no row visibility), BUT it IS member-gated on the TARGET: a campaign observer edge feeds the notification/webhook fan-out, so `addObserver` rejects a non-member `userId` (`[user_not_member]`) to prevent routing campaign emails to someone outside the tenant. If a product rule later also needs owner-only observer *management*, add that gate on top.
- **Fan-out / date-key idempotency:** every recipient-bearing event emits ONE event per recipient with `recipient_user_id` set and `payload.id = <entity_id>::text || ':' || <recipient>::text` so `emit_event`'s notify key is unique per recipient (a 2nd recipient is never deduped). `deliverable.due_soon` additionally appends `':' || to_char(due_date,'YYYY-MM-DD')`, so a same-day re-scan re-computes the SAME notify key and `movp_jobs unique(kind, idempotency_key)` drops the duplicate JOB. NOTE (stated in-migration + in tests): because `campaign_deliverable` is column-thin (no `*_notified_at` stamp), a re-scan DOES re-insert a duplicate `movp_events` row for due_soon — de-dup is JOB-level only, so due_soon tests assert on `movp_jobs`, not `movp_events`.
- **Correctness / self-consistency:** every SQL sample is schema-qualified and copy-paste-ready against the pasted `emit_event` (notify iff `payload ? 'recipient_user_id' or ? 'email'`, key `ev_type||':'||payload->>'id'`) and `task_notify_recipients` (rows of `recipient uuid`). Event names verbatim: `deliverable.assigned`, `deliverable.completed`, `deliverable.due_soon`, `campaign.started`, `campaign.ended` (+ optional `deliverable.published_ready`). FK/edge names match Part A's contract: `campaign_deliverable(campaign_id, channel_id, name, deliverable_type)`, `campaign(owner_id, start_date, end_date, status, marketing_plan_id)`, edge `rel='implemented_by'` from `campaign_deliverable` to `task`. `plan(N)` bumps 6 → 16 (→ 18 only if the optional Task 3 is implemented) — the extra Task-1 assertions cover the audit-only `deliverable.completed` companion (bare + zero-recipient), and the extra Task-2 assertions cover the catch-up double-flip. All fixture UUIDs are valid hex. The TS interface, `campaign.ts`, and `types.ts` agree; `createDomain` wiring lives in `domain.ts` (NOT `index.ts`, which re-exports only); `deliverableSchedule` returns `{taskId, startDate, dueDate}|null` and `deliverableSchedules` returns the batched array (both shapes identical minus the added `deliverableId` key). The batched `deliverableSchedules` integration assertion (two deliverables, one call) is a vitest `it()`, so it does not count toward the pgTAP `plan(N)`.
- **Safety / observability:** every new function is a hardened `SECURITY DEFINER` — `set search_path = ''`, fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated`; all pass `check-definer-audit.mjs`. The bridge triggers are DEFINER so the deliverable-recovery + recipient set are authoritative and RLS-independent (a client cannot suppress a notify by lacking edge/assignment visibility). `deliverable.completed` emits an AUDIT-ONLY companion (no `recipient_user_id`, bare `payload.id`) exactly once per completion IN ADDITION to the per-recipient notify events, so a completion whose backing task has zero owner/observer is still observable in the events/audit layer — never silently swallowed (mirrors Task's audit-only `task.status_changed`). `deliverable.due_soon` is deliberately recipient-gated (no audit companion): a reminder with nobody to remind carries no audit value. The domain service runs under CALLER RLS (`ctx.db`), so cross-workspace ids simply return no row and surface as `fail(op,'…_not_found')` — enforced at the DB boundary, tested by the isolation case. Payloads carry ids + entity refs + `recipient_user_id` only — no free-text/PII. `movp_internal` is read in pgTAP as the owner only.
- **Reliability / drift:** each SQL task ends with `supabase db reset` + `db diff` empty; `drop trigger if exists` + `create or replace` keep the migration re-runnable in a fresh reset. `scan_campaigns` is safe to re-run (falsified predicates + date-keyed job de-dup). The deploy-time cron is deliberately NOT committed so `db diff` stays clean and no secret is committed (mirrors Task's `emit_due_soon`).
- **Efficiency / performance:** the bridge triggers do a single `limit 1` reverse-edge probe and skip entirely when no deliverable backs the task (the common case for non-campaign tasks); `deliverable_completed` also guards on the category transition before probing. `scan_campaigns` uses two set-based `UPDATE … RETURNING` flips and one join for due_soon. `deliverable_completed` is scoped `after update of status_id`, so unrelated task edits never invoke it. The domain exposes BOTH a single `deliverableSchedule` and a batched `deliverableSchedules(ids[])` (edges `.in(...)` + task `.in(...)` = exactly two round-trips for N deliverables), so Part C's timeline over many deliverables reads O(1) round-trips, not an N+1 of single probes.
- **Simplicity / usability:** no new abstraction beyond the two contract-required primitives (bridge triggers + scan); the domain service reuses `makeGraphService.link` rather than a private edge writer. `linkSegment` is included per the interface but noted inert until Phase 6 (its edge is written, simply unconsumed) — no speculative machinery. Task 3 is clearly gated OPTIONAL/DEFERRED with a dependency check so a context-poor executor skips it cleanly when the CMS table is absent.
- **Deferred (intentional):** no event-subscription/flows engine (does not exist; the bridge is DB triggers on Task's tables); no `deliverable.unassigned`/`deliverable.reopened` events (out of scope); no worker change (the notify worker already resolves `recipient_user_id` → email); Task 3 deferred by default; no UI. None are needed for this DB + domain deliverable.
- **Placeholder scan:** none — every SQL and TS block is complete and copy-paste-ready; each step has an exact command + expected output. The only executor-verification notes are the two genuinely Part-A-schema-dependent details (deliverable `channel_id` nullability / `deliverable_type` allowed values) and the sibling-`content.ts` idioms (`DomainCtx` import path, `fail` shape), each flagged inline at its trigger site with the exact check.
