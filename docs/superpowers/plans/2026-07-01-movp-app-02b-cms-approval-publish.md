# MOVP App — CMS Phase 4, Part B: Approval, Publish & Lifecycle Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the CMS approval/publish workflow on top of Part A's `content_type`/`content_item`/`content_revision` + the `content` domain service. Config-first, add three internal collections (`content_approval`, `content_approval_vote`, `content_publish_event`) and regenerate the codegen migration. Then hand-author `20260701000013_cms_workflow.sql` for: (1) `unique(approval_id, voter_id)` on votes; (2) `public.has_content_capability(ws, cap)` (hardened DEFINER, mirrors `is_workspace_member`); (3) capability-enforcing RLS (drop the generated blanket `_rw`, add specific SELECT/INSERT/UPDATE policies, publish/approve gated in the RLS `with check`); (4) immutability guard triggers on the two append-only tables; (5) seven lifecycle emit triggers; (6) a demote-on-edit trigger. Then hand-author `20260701000014_cms_workflow_rpcs.sql` (SECURITY **INVOKER** RPCs so RLS stays in force) backing six new `ContentService` methods (four RPC-backed writes + `getPublished`/`listApprovals` reads). Finally, add HMAC-SHA256 signing to the committed webhook worker (sign with the subscriber secret, strip it from the delivered body).

**Architecture:** Part A generated the config-first CMS tables with blanket RLS and shipped the `content` domain service (`create`/`update`, domain-computed `content_hash`), `can_access_entity('content_item', …)`, and two INVOKER RPCs. This Part B is **config + hand-authored SQL + one worker change**. All fan-out goes through the committed `public.emit_event(ev_type, ws, payload, trace)` — it writes `movp_internal.movp_events` and enqueues a `webhook` job per active `movp_internal.webhooks` row for the type (secret threaded in). **I do not modify `emit_event`.** My triggers call it exactly like the committed `comment_emit_event`. Publish/unpublish thus emit webhooks for free; the worker (Task 5) signs them, and the frontend subscribes to `content.published`/`content.unpublished` to purge its cache (subscriber side, out of scope). **Capability authority lives in RLS `with check`, not the service** — a member without the `approve`/`publish` capability cannot flip an approval decision or insert a publish event even via direct SQL. **Immutability** of votes and publish events is enforced by a guard trigger (not merely absent UPDATE policies), so an owner-role/direct write still raises. **Payload discipline:** every event payload carries IDs/hashes/status/actor only — `id`, `content_type_id`, `content_item_id`, `revision_id`, `content_hash`, `approval_id`, `actor_id`, `status` — **never `data` or PII.**

**Tech Stack:** Config-first collections + `pnpm codegen` (regenerates the single generated migration), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` triggers/functions + `SECURITY INVOKER` RPCs (all `set search_path = ''`), the committed `public.emit_event` / `movp_internal.{movp_events,movp_jobs,webhooks}` async backbone, `public.is_workspace_member` / `public.can_access_entity` (Part A), the definer-audit gate (`node scripts/check-definer-audit.mjs`), `@movp/domain`'s `ContentService`, and the `@movp/flows` webhook worker (`packages/flows/src/flows-worker.ts`).

**This is Part B of the CMS Phase 4 series.** It depends on **Part A** (the `content_type`/`content_item`/`content_revision` collections + tables, the `content` domain service, `can_access_entity('content_item', …)`, migrations `000001`–`000012`) and on the async backbone (`public.emit_event`, `movp_internal.*`, `public.is_workspace_member`). **Part C** (scheduling) owns the eighth event `content.scheduled`; this part defines the other **seven**. Downstream consumers depend on the **event names verbatim** — `content.created`, `content.revision_created`, `content.submitted_for_approval`, `content.approved`, `content.rejected`, `content.published`, `content.unpublished` — do not rename them.

## Global Constraints

- **Config-first for tables; hand-authored for workflow.** The three new collections are added to the collections config and their tables come from `pnpm codegen` (which regenerates the single generated migration, the `…000002…` codegen output). RLS overrides, capability, triggers, and RPCs are hand-authored in `20260701000013_cms_workflow.sql` and `20260701000014_cms_workflow_rpcs.sql`. Do NOT hand-edit the generated migration.
- **All CMS collections `internal: true`, `workspaceScoped: true`.** The two append-only collections are also `immutable: true`.
- **Exact migration filenames, not `supabase migration new`.** They MUST be `supabase/migrations/20260701000013_cms_workflow.sql` (built across Tasks 2–3) and `supabase/migrations/20260701000014_cms_workflow_rpcs.sql` (Task 4). A wall-clock timestamp would sort wrong.
- **Every new definer/trigger sets `set search_path = ''`.** Every `SECURITY DEFINER` function: `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` for trigger/internal functions. The RPCs are `SECURITY INVOKER` (so RLS applies) but ALSO set `search_path = ''`. The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits SQL on `create … function` and FAILS any `security definer` block missing `set search_path =`. Do not drop the clause anywhere.
- **`has_content_capability` grant is asymmetric.** It is called inside RLS `with check` expressions evaluated in the `authenticated` role, so it needs `grant execute … to authenticated` (unlike the trigger functions, which are revoked from `authenticated`). Contract: `revoke all … from public, anon; grant execute … to authenticated`.
- **Capability map:** role `owner`/`admin` → all caps (incl. `approve`, `publish`); role `member` (and anything else) → no caps. There are exactly two caps: `approve`, `publish`.
- **RLS override is security-critical.** Drop the generated blanket `<table>_rw` policy on each of the three tables BEFORE adding specific policies — a surviving permissive blanket policy is OR'd with yours and bypasses the capability check. The Task-2 `policies_are(…)` assertions fail loudly if any `_rw` policy survives.
- **`emit_event` is unchanged.** My triggers only `perform public.emit_event(…)`. The notify/webhook enqueue logic is the committed version.
- **Payload discipline (verbatim):** IDs/hashes/status/actor only — never `data`/PII. The Task-3 pgTAP asserts `not (payload ? 'data')`.
- **`create or replace` preserves privileges** on any function re-declared. `drop trigger if exists … ; create trigger …` keeps the migration re-runnable across `supabase db reset`.
- **Part A facts to confirm before you start (Step 0 — do this once):** run `supabase db reset` then inspect the exact Part A shapes the samples below assume. The three items flagged here are the only places codegen/Part A can diverge from this plan; confirm each and reconcile the sample if it differs:
  1. `psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" -c '\d public.content_type' -c '\d public.content_item' -c '\d public.content_revision'` — confirm: `content_item` has columns `content_type_id`, `status`, `current_revision_id`, `approved_revision_id`, `published_revision_id`, and **`published_at`** (Task 4's `publish` stamps it — if Part A omitted it, add `published_at: f.datetime()` to the `content_item` collection config in Task 1 so codegen adds it, rather than a hand-migration column which would drift). Confirm `content_revision` has `content_item_id`, `revision_number`, `data`, `content_hash`, and is `workspaceScoped` (has `workspace_id`). Note `content_type`'s NOT NULL columns for the pgTAP seed (this plan assumes `id, workspace_id, label, key` — Part A's `content_type` has a `label` column, not `name`).
  2. Grep for the collections config + registration files: `grep -rln "content_item" --include=schema.ts --include=index.ts .` — that is where Part A's `content_item` collection lives and is registered; add the three new collections there.
  3. Confirm the domain service is Part A's `makeContentService(ctx)` FACTORY (NOT a class): `grep -nE "ctx\.db\.(from|rpc)\(" packages/domain/src/content.ts | head` — the Task-4 samples use `ctx.db` (the per-request client, resolved at call time) and route failures through `fail(op, error.code)`, closing over the same `ctx`/`fail` as `create()`/`update()`. There is NO `this.client`.

## File Structure

```
supasuite/
  <collections-config-dir>/            # located in Step 0.2 (e.g. packages/collections/src)
    schema.ts                          # EDIT — add 3 collections (+ published_at if missing)
    index.ts                           # EDIT — register the 3 collections
  supabase/
    migrations/
      <…000002…>_generated.sql         # REGENERATED by `pnpm codegen` (do not hand-edit)
      20260701000013_cms_workflow.sql  # NEW hand-authored (built across Tasks 2–3)
      20260701000014_cms_workflow_rpcs.sql # NEW hand-authored (Task 4)
    tests/
      cms_workflow_test.sql            # NEW pgTAP (built across Tasks 1–3)
  packages/
    domain/
      src/content.ts                   # EDIT — 6 new ContentService methods (Task 4)
      src/types.ts                     # EDIT — interface + ContentApprovalRow (Task 4)
      test/content_workflow.integration.test.ts # NEW vitest (Task 4)
    flows/
      src/flows-worker.ts              # EDIT — HMAC signing (Task 5)
      test/webhook-hmac.test.ts        # NEW vitest (Task 5)
```

**Per-DB-task apply gate (Tasks 1–3):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: migrations apply, `cms_workflow_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing.

---

### Task 1: Three collections + codegen + pgTAP catalog checks

**Files:**
- Edit: `<collections-config-dir>/schema.ts`, `<collections-config-dir>/index.ts`
- Regenerate: the `…000002…` generated migration (via `pnpm codegen`)
- Create: `supabase/tests/cms_workflow_test.sql`

**Interfaces:**
- Consumes: Part A's `content_item`/`content_revision`/`content_type` collections + the field builder `f`.
- Produces: tables `public.content_approval`, `public.content_approval_vote`, `public.content_publish_event` with generated blanket `_rw` RLS. Invariant (pinned by pgTAP): the FK columns are named exactly `content_item_id`, `approval_id`, `revision_id`, `approved_revision_id`.

- [ ] **Step 0: Confirm Part A shapes** — run the three Step-0 commands from Global Constraints. Record `content_type`'s required columns and whether `content_item.published_at` exists.

- [ ] **Step 1: Add the three collections to `schema.ts`**

Add after Part A's CMS collections (transcribe the field configs EXACTLY — the FK column each produces is named in the trailing comment and is load-bearing downstream). GOTCHA: if Step 0 found `content_item` has no `published_at`, also add `published_at: f.datetime()` to the existing `content_item` collection here (publish stamps it in Task 4).
```ts
  content_approval: {
    internal: true,
    workspaceScoped: true,
    fields: {
      item: f.relation('content_item', { cardinality: 'many-to-one', required: true }),          // -> content_item_id
      state: f.enum(['pending', 'approved', 'rejected', 'superseded'], { default: 'pending', reporting: { role: 'dimension' } }),
      policy: f.enum(['single', 'multi', 'moderation'], { required: true, reporting: { role: 'dimension' } }),
      approvals_required: f.number({ default: 1 }),
      approved_revision: f.relation('content_revision', { cardinality: 'many-to-one' }),           // -> approved_revision_id
      approved_content_hash: f.text(),
      decided_at: f.datetime(),
      decided_by: f.uuid(),
    },
  },
  content_approval_vote: {
    internal: true,
    workspaceScoped: true,
    immutable: true,
    fields: {
      approval: f.relation('content_approval', { cardinality: 'many-to-one', required: true }),    // -> approval_id
      voter_id: f.uuid({ required: true }),
      vote: f.enum(['approve', 'reject'], { required: true }),
    },
  },
  content_publish_event: {
    internal: true,
    workspaceScoped: true,
    immutable: true,
    fields: {
      item: f.relation('content_item', { cardinality: 'many-to-one', required: true }),            // -> content_item_id
      action: f.enum(['publish', 'unpublish'], { required: true, reporting: { role: 'dimension' } }),
      revision: f.relation('content_revision', { cardinality: 'many-to-one', required: true }),     // -> revision_id
      content_hash: f.text({ required: true }),
      actor_id: f.uuid({ required: true }),
    },
  },
```

- [ ] **Step 2: Register the three collections in `index.ts`** — mirror how Part A registers `content_item` (add the three new keys to the same export/array).

- [ ] **Step 3: Regenerate + typecheck**

```bash
pnpm codegen
pnpm typecheck
git status --porcelain
```
Expected: `pnpm codegen` succeeds; `pnpm typecheck` passes; `git status` shows ONLY `schema.ts`, `index.ts`, the `…000002…` generated migration, and generated type files changed — nothing else.

- [ ] **Step 4: Write the pgTAP catalog checks (pins the codegen column names)**

Create `supabase/tests/cms_workflow_test.sql`. `has_column` fails loudly if codegen named a FK column differently than this plan assumes (the one place codegen can surprise you). GOTCHA: the shared seed's `content_type` insert must satisfy ALL of `content_type`'s NOT NULL columns found in Step 0 — adjust the column list if yours differs.
```sql
begin;
select plan(7);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
-- Fixtures reused by Tasks 2-3: workspace W1, member A (owner role -> approve+publish
-- caps), member B (member role -> no caps), content_type CT1.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');
-- content_type CT1 (Part A). VERIFY required columns via Step 0 and add any other NOT NULLs.
insert into public.content_type (id, workspace_id, label, key) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Article', 'article');

-- ── Task 1: codegen produced the tables with the contract's FK column names ──
select has_table('public', 'content_approval', 'content_approval table exists');
select has_table('public', 'content_approval_vote', 'content_approval_vote table exists');
select has_table('public', 'content_publish_event', 'content_publish_event table exists');
select has_column('public', 'content_approval', 'content_item_id', 'content_approval.content_item_id (item relation FK)');
select has_column('public', 'content_approval', 'approved_revision_id', 'content_approval.approved_revision_id FK');
select has_column('public', 'content_approval_vote', 'approval_id', 'content_approval_vote.approval_id FK');
select has_column('public', 'content_publish_event', 'revision_id', 'content_publish_event.revision_id FK');

select * from finish();
rollback;
```

- [ ] **Step 5: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `cms_workflow_test.sql .. ok` (7 assertions); definer-audit exits 0 (`all definers pinned` — no new definers yet); `db diff` empty. If a `has_column` FAILS, codegen named that FK differently — reconcile before proceeding (every later task references these exact names).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cms): approval/publish collections + codegen (CMS Part B)"
```

---

### Task 2: `has_content_capability` + capability RLS + immutability guards + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000013_cms_workflow.sql`
- Edit: `supabase/tests/cms_workflow_test.sql` (add Task 2 block)

**Interfaces:**
- Consumes: `public.workspace_membership`, `public.is_workspace_member`, `public.can_access_entity` (Part A), the three new tables.
- Produces: `public.has_content_capability(ws uuid, cap text) returns boolean` (hardened DEFINER, mirrors `is_workspace_member`); the `unique(approval_id, voter_id)` constraint; capability-enforcing RLS on all three tables (blanket `_rw` dropped); immutability guard triggers on the two append-only tables. Invariants: `approve`/`publish` decisions require the capability in the RLS `with check` (a member without it gets `42501`); double-vote → `23505`; any UPDATE/DELETE of a vote or publish event raises `P0001`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/cms_workflow_test.sql`: change `select plan(7);` to `select plan(21);`, and insert this block immediately BEFORE the final `select * from finish();`. GOTCHA: capability + `42501` assertions run under `set local role authenticated` (so RLS is enforced — the owner bypasses RLS); immutability + `23505` assertions run as the owner (a guard trigger / unique constraint fires regardless of role, and there is no UPDATE policy on the vote table so `authenticated` would silently match 0 rows).
```sql
-- ── Task 2: capability + RLS + immutability ─────────────────────────────────
-- seed I1 (item), R1 (revision), AP1 (pending approval) as owner
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('00000001-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'i1', 'draft');
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000a1-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000', 1, '{"t":"v1"}'::jsonb, 'hash-1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.content_approval (id, workspace_id, content_item_id, state, policy, approvals_required) values
  ('000000a9-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000', 'pending', 'single', 1);

-- RLS override dropped the blanket _rw: assert the EXACT policy set (fails if _rw survived)
select policies_are('public', 'content_approval',
  ARRAY['content_approval_select', 'content_approval_insert', 'content_approval_update'],
  'content_approval has exactly the workflow policies (no surviving _rw)');
select policies_are('public', 'content_approval_vote',
  ARRAY['content_approval_vote_select', 'content_approval_vote_insert'],
  'content_approval_vote is SELECT+INSERT only (no surviving _rw)');
select policies_are('public', 'content_publish_event',
  ARRAY['content_publish_event_select', 'content_publish_event_insert'],
  'content_publish_event is SELECT+INSERT only (no surviving _rw)');

-- capability map: owner A gets both caps; member B gets neither
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select ok(public.has_content_capability('11111111-1111-1111-1111-111111111111', 'approve'), 'owner has approve cap');
select ok(public.has_content_capability('11111111-1111-1111-1111-111111111111', 'publish'), 'owner has publish cap');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select ok(not public.has_content_capability('11111111-1111-1111-1111-111111111111', 'approve'), 'member lacks approve cap');
select ok(not public.has_content_capability('11111111-1111-1111-1111-111111111111', 'publish'), 'member lacks publish cap');

-- member B (no approve) cannot flip an approval decision even via direct SQL (with-check -> 42501)
select throws_ok(
  $$ update public.content_approval set state='approved' where id='000000a9-0000-0000-0000-000000000000' $$,
  '42501', null, 'a member without approve cap cannot decide an approval');
-- member B (no publish) cannot insert a publish event (with-check -> 42501)
select throws_ok(
  $$ insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
     values ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000','publish',
             '000000a1-0000-0000-0000-000000000000','hash-1','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '42501', null, 'a member without publish cap cannot insert a publish event');
reset role;

-- immutability + double-vote (owner context)
insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote) values
  ('11111111-1111-1111-1111-111111111111', '000000a9-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'approve');
select throws_ok(
  $$ insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote)
     values ('11111111-1111-1111-1111-111111111111','000000a9-0000-0000-0000-000000000000',
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','reject') $$,
  '23505', null, 'a voter cannot vote twice on one approval');
select throws_ok(
  $$ update public.content_approval_vote set vote='reject' where approval_id='000000a9-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_approval_vote is immutable (UPDATE raises)');
select throws_ok(
  $$ delete from public.content_approval_vote where approval_id='000000a9-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_approval_vote is immutable (DELETE raises)');
insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id) values
  ('11111111-1111-1111-1111-111111111111', '00000001-0000-0000-0000-000000000000', 'publish',
   '000000a1-0000-0000-0000-000000000000', 'hash-1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select throws_ok(
  $$ update public.content_publish_event set action='unpublish' where content_item_id='00000001-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_publish_event is immutable (UPDATE raises)');
select throws_ok(
  $$ delete from public.content_publish_event where content_item_id='00000001-0000-0000-0000-000000000000' $$,
  'P0001', null, 'content_publish_event is immutable (DELETE raises)');
```

Run: `supabase test db`
Expected: FAIL — with only Task 1 applied, `has_content_capability` does not exist (the capability `ok(...)` calls error), the blanket `_rw` policy is still present (`policies_are` fail), the `42501` writes succeed instead of raising, and no immutability guard exists. The 7 Task-1 assertions still pass.

- [ ] **Step 2: Create the migration — capability + unique + RLS + guards (green)**

Create `supabase/migrations/20260701000013_cms_workflow.sql` (exact path — do NOT use `supabase migration new`):
```sql
-- CMS Phase 4 — Part B. Sorts AFTER Part A + the generated migration.
-- Capability, capability-enforcing RLS, immutability guards, lifecycle emit
-- triggers, and demote-on-edit. All fan-out goes through the committed
-- public.emit_event (unchanged here).

-- ── has_content_capability: mirrors is_workspace_member; DEFINER so it reads ──
-- workspace_membership regardless of the caller's RLS. GOTCHA: keep
-- `set search_path = ''` (definer-audit gate) and fully qualify every object,
-- incl. auth.uid(). owner/admin grant every cap; member/others grant none.
create or replace function public.has_content_capability(ws uuid, cap text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when wm.role in ('owner', 'admin') then cap in ('approve', 'publish')
      else false
    end
    from public.workspace_membership wm
    where wm.workspace_id = ws and wm.user_id = (select auth.uid())
  ), false);
$$;
revoke all on function public.has_content_capability(uuid, text) from public, anon;
grant execute on function public.has_content_capability(uuid, text) to authenticated;

-- ── no double-vote ──────────────────────────────────────────────────────────
alter table public.content_approval_vote
  add constraint content_approval_vote_uniq unique (approval_id, voter_id);

-- ── content_approval RLS: capability gate on the decision ────────────────────
-- Drop the generated blanket policy FIRST (a surviving permissive policy is
-- OR'd with ours and bypasses the capability check). USING lets a member SEE
-- the row; WITH CHECK requires the approve cap to write the decision.
drop policy if exists content_approval_rw on public.content_approval;
create policy content_approval_select on public.content_approval
  for select using (public.is_workspace_member(workspace_id));
create policy content_approval_insert on public.content_approval
  for insert with check (
    public.is_workspace_member(workspace_id)
    and public.can_access_entity('content_item', content_item_id, workspace_id));
create policy content_approval_update on public.content_approval
  for update using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'approve'));

-- ── content_approval_vote RLS: immutable — SELECT + INSERT only ──────────────
drop policy if exists content_approval_vote_rw on public.content_approval_vote;
create policy content_approval_vote_select on public.content_approval_vote
  for select using (public.is_workspace_member(workspace_id));
create policy content_approval_vote_insert on public.content_approval_vote
  for insert with check (public.is_workspace_member(workspace_id));

-- ── content_publish_event RLS: publish cap gates the INSERT ──────────────────
drop policy if exists content_publish_event_rw on public.content_publish_event;
create policy content_publish_event_select on public.content_publish_event
  for select using (public.is_workspace_member(workspace_id));
create policy content_publish_event_insert on public.content_publish_event
  for insert with check (
    public.is_workspace_member(workspace_id)
    and public.has_content_capability(workspace_id, 'publish')
    and public.can_access_entity('content_item', content_item_id, workspace_id));

-- ── immutability guards (raise on UPDATE/DELETE of the append-only tables) ───
-- DEFINER + set search_path = '' for uniformity with the audit gate; the body
-- only raises, so it touches no tables.
create or replace function public.content_vote_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'content_approval_vote is immutable (% not allowed)', tg_op using errcode = 'P0001';
end; $$;
revoke all on function public.content_vote_immutable() from public, anon, authenticated;
drop trigger if exists content_vote_immutable_tg on public.content_approval_vote;
create trigger content_vote_immutable_tg
  before update or delete on public.content_approval_vote
  for each row execute function public.content_vote_immutable();

create or replace function public.content_publish_event_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'content_publish_event is immutable (% not allowed)', tg_op using errcode = 'P0001';
end; $$;
revoke all on function public.content_publish_event_immutable() from public, anon, authenticated;
drop trigger if exists content_publish_event_immutable_tg on public.content_publish_event;
create trigger content_publish_event_immutable_tg
  before update or delete on public.content_publish_event
  for each row execute function public.content_publish_event_immutable();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `cms_workflow_test.sql .. ok` (21 assertions); definer-audit exits 0 (`has_content_capability` + both guards pin `search_path`); `db diff` empty.

- [ ] **Step 4: Gate — capability granted to authenticated; no blanket policy survives**

```bash
grep -q "grant execute on function public.has_content_capability(uuid, text) to authenticated" \
  supabase/migrations/20260701000013_cms_workflow.sql && echo CAP_GRANT_OK
grep -cE "drop policy if exists content_(approval|approval_vote|publish_event)_rw" \
  supabase/migrations/20260701000013_cms_workflow.sql
```
Expected: prints `CAP_GRANT_OK`; the second grep prints `3` (all three blanket policies dropped; the `policies_are` assertions confirm none survived).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000013_cms_workflow.sql supabase/tests/cms_workflow_test.sql
git commit -m "feat(cms): has_content_capability + capability RLS + immutability guards"
```

---

### Task 3: Seven lifecycle emit triggers + demote-on-edit + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000013_cms_workflow.sql` (append)
- Edit: `supabase/tests/cms_workflow_test.sql` (add Task 3 block)

**Interfaces:**
- Consumes: the committed `public.emit_event`, `(select auth.uid())`, the three tables + Part A's `content_item`/`content_revision`.
- Produces: seven hardened `SECURITY DEFINER` emit triggers (`content.created`, `content.revision_created`, `content.submitted_for_approval`, `content.approved`, `content.rejected`, `content.published`, `content.unpublished`) + a demote-on-edit trigger. Invariants: each transition emits exactly one event, payloads carry IDs/hashes/status/actor only (never `data`); editing an approved item supersedes the open approval and returns `content_item.status` to `in_review` while `approved_revision_id`/`approved_content_hash` are preserved for audit.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/cms_workflow_test.sql`: change `select plan(21);` to `select plan(32);`, and insert this block immediately BEFORE the final `select * from finish();`. It runs as the owner (RLS bypassed, so trigger inserts/updates fire) with `auth.uid()` pinned to A. GOTCHA: assertions evaluate at their point in the sequence — `content.submitted_for_approval` is asserted BEFORE the demote (which re-sets `status='in_review'`), so its count is 1 at that moment.
```sql
-- ── Task 3: lifecycle triggers + demote-on-edit ─────────────────────────────
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- inserting an item -> content.created (ids/status only)
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('00000003-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'i3', 'draft');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.created' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'inserting a content_item emits content.created');
select ok((select not (payload ? 'data') from movp_internal.movp_events
           where type='content.created' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          'content.created payload carries no data/PII');

-- inserting a revision -> content.revision_created; set current_revision_id
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000c1-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000003-0000-0000-0000-000000000000', 1, '{"t":"v1"}'::jsonb, 'hash-v1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
update public.content_item set current_revision_id='000000c1-0000-0000-0000-000000000000'
  where id='00000003-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='content.revision_created' and payload->>'id'='000000c1-0000-0000-0000-000000000000'),
          1, 'inserting a content_revision emits content.revision_created');

-- status -> in_review => content.submitted_for_approval (asserted before demote)
update public.content_item set status='in_review' where id='00000003-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='content.submitted_for_approval' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'status -> in_review emits content.submitted_for_approval');

-- approve an approval => content.approved
insert into public.content_approval (id, workspace_id, content_item_id, state, policy, approvals_required) values
  ('000000d3-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000003-0000-0000-0000-000000000000', 'pending', 'single', 1);
update public.content_approval
   set state='approved', approved_revision_id='000000c1-0000-0000-0000-000000000000',
       approved_content_hash='hash-v1', decided_at=now(), decided_by='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
 where id='000000d3-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='content.approved' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'approval state -> approved emits content.approved');
-- mirror what the approve RPC does to the item, so demote later has an approved revision to preserve
update public.content_item set status='approved', approved_revision_id='000000c1-0000-0000-0000-000000000000'
  where id='00000003-0000-0000-0000-000000000000';

-- reject a separate approval => content.rejected
insert into public.content_approval (id, workspace_id, content_item_id, state, policy, approvals_required) values
  ('000000d4-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000003-0000-0000-0000-000000000000', 'pending', 'single', 1);
update public.content_approval set state='rejected', decided_at=now(), decided_by='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
 where id='000000d4-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='content.rejected' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'approval state -> rejected emits content.rejected');

-- publish / unpublish events
insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id) values
  ('11111111-1111-1111-1111-111111111111', '00000003-0000-0000-0000-000000000000', 'publish',
   '000000c1-0000-0000-0000-000000000000', 'hash-v1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.published' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'content_publish_event action=publish emits content.published');
insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id) values
  ('11111111-1111-1111-1111-111111111111', '00000003-0000-0000-0000-000000000000', 'unpublish',
   '000000c1-0000-0000-0000-000000000000', 'hash-v1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.unpublished' and payload->>'id'='00000003-0000-0000-0000-000000000000'),
          1, 'content_publish_event action=unpublish emits content.unpublished');

-- demote-on-edit: item has approved_revision_id=R1; inserting a new revision supersedes + resets
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000c2-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   '00000003-0000-0000-0000-000000000000', 2, '{"t":"v2"}'::jsonb, 'hash-v2',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
update public.content_item set current_revision_id='000000c2-0000-0000-0000-000000000000'
  where id='00000003-0000-0000-0000-000000000000';
select is((select count(*)::int from public.content_approval
           where content_item_id='00000003-0000-0000-0000-000000000000' and state='superseded'),
          1, 'editing an approved item supersedes the open approval');
select is((select status from public.content_item where id='00000003-0000-0000-0000-000000000000'),
          'in_review', 'demote-on-edit returns the item to in_review');
select is((select approved_revision_id from public.content_item where id='00000003-0000-0000-0000-000000000000'),
          '000000c1-0000-0000-0000-000000000000', 'demote-on-edit preserves approved_revision_id for audit');
```

Run: `supabase test db`
Expected: FAIL — with no lifecycle triggers yet, the seven event counts are 0, and the demote assertions fail (approval stays `approved`, `status` stays `approved`). The 21 prior assertions pass.

- [ ] **Step 2: Append the emit triggers + demote-on-edit (green)**

Append to `supabase/migrations/20260701000013_cms_workflow.sql`. Each mirrors the committed `comment_emit_event` (hardened definer, `revoke … from public, anon, authenticated`, drop-then-create trigger). GOTCHA: keep `set search_path = ''` and fully qualify `public.emit_event` / `auth.uid()`. `payload->>'id'` reads a single-value uuid back as text.
```sql
-- ── content.created: AFTER INSERT on content_item (ids/status only) ──────────
create or replace function public.content_item_created_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('content.created', new.workspace_id,
    jsonb_build_object('id', new.id, 'content_type_id', new.content_type_id, 'status', new.status),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.content_item_created_emit_event() from public, anon, authenticated;
drop trigger if exists content_item_created_emit_event_tg on public.content_item;
create trigger content_item_created_emit_event_tg after insert on public.content_item
  for each row execute function public.content_item_created_emit_event();

-- ── content.revision_created: AFTER INSERT on content_revision (id=revision) ─
create or replace function public.content_revision_created_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('content.revision_created', new.workspace_id,
    jsonb_build_object('id', new.id, 'content_item_id', new.content_item_id, 'content_hash', new.content_hash),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.content_revision_created_emit_event() from public, anon, authenticated;
drop trigger if exists content_revision_created_emit_event_tg on public.content_revision;
create trigger content_revision_created_emit_event_tg after insert on public.content_revision
  for each row execute function public.content_revision_created_emit_event();

-- ── content.submitted_for_approval: AFTER UPDATE OF status, into in_review ───
-- Also fires when demote-on-edit resets status to in_review (a re-submit) — intended.
create or replace function public.content_item_submitted_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'in_review' and new.status is distinct from old.status then
    perform public.emit_event('content.submitted_for_approval', new.workspace_id,
      jsonb_build_object('id', new.id, 'content_type_id', new.content_type_id,
                         'status', new.status, 'actor_id', (select auth.uid())),
      gen_random_uuid()::text);
  end if;
  return new;
end; $$;
revoke all on function public.content_item_submitted_emit_event() from public, anon, authenticated;
drop trigger if exists content_item_submitted_emit_event_tg on public.content_item;
create trigger content_item_submitted_emit_event_tg
  after update of status on public.content_item
  for each row execute function public.content_item_submitted_emit_event();

-- ── content.approved / content.rejected: AFTER UPDATE OF state on approval ───
-- state -> 'superseded' (demote) is neither branch, so it emits nothing.
create or replace function public.content_approval_decided_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.state = 'approved' and new.state is distinct from old.state then
    perform public.emit_event('content.approved', new.workspace_id,
      jsonb_build_object('id', new.content_item_id, 'approval_id', new.id,
                         'revision_id', new.approved_revision_id, 'content_hash', new.approved_content_hash,
                         'actor_id', new.decided_by, 'status', 'approved'),
      gen_random_uuid()::text);
  elsif new.state = 'rejected' and new.state is distinct from old.state then
    perform public.emit_event('content.rejected', new.workspace_id,
      jsonb_build_object('id', new.content_item_id, 'approval_id', new.id,
                         'actor_id', new.decided_by, 'status', 'rejected'),
      gen_random_uuid()::text);
  end if;
  return new;
end; $$;
revoke all on function public.content_approval_decided_emit_event() from public, anon, authenticated;
drop trigger if exists content_approval_decided_emit_event_tg on public.content_approval;
create trigger content_approval_decided_emit_event_tg
  after update of state on public.content_approval
  for each row execute function public.content_approval_decided_emit_event();

-- ── content.published / content.unpublished: AFTER INSERT on publish_event ───
-- status derived from action (not read from the item, which may be mid-update).
create or replace function public.content_publish_event_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.action = 'publish' then
    perform public.emit_event('content.published', new.workspace_id,
      jsonb_build_object('id', new.content_item_id, 'revision_id', new.revision_id,
                         'content_hash', new.content_hash, 'actor_id', new.actor_id, 'status', 'published'),
      gen_random_uuid()::text);
  elsif new.action = 'unpublish' then
    perform public.emit_event('content.unpublished', new.workspace_id,
      jsonb_build_object('id', new.content_item_id, 'revision_id', new.revision_id,
                         'content_hash', new.content_hash, 'actor_id', new.actor_id, 'status', 'archived'),
      gen_random_uuid()::text);
  end if;
  return new;
end; $$;
revoke all on function public.content_publish_event_emit_event() from public, anon, authenticated;
drop trigger if exists content_publish_event_emit_event_tg on public.content_publish_event;
create trigger content_publish_event_emit_event_tg after insert on public.content_publish_event
  for each row execute function public.content_publish_event_emit_event();

-- ── demote-on-edit: a new revision on an approved item invalidates the approval ─
create or replace function public.content_demote_on_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_approved uuid;
  v_status   text;
begin
  select approved_revision_id, status into v_approved, v_status
    from public.content_item where id = new.content_item_id;
  if v_approved is not null and v_approved <> new.id then
    -- supersede the open approval (pending or approved); preserve the item's
    -- approved_revision_id / approved_content_hash for audit (untouched here).
    update public.content_approval
       set state = 'superseded', decided_at = now()
     where content_item_id = new.content_item_id and state in ('pending', 'approved');
    -- return the item to in_review. NO-RECURSION: this updates status only (not
    -- content_revision), so THIS AFTER-INSERT-on-content_revision trigger cannot
    -- re-fire; it does fire content_item's AFTER UPDATE OF status trigger
    -- (submitted_for_approval), which only emits an event -> terminates.
    update public.content_item set status = 'in_review'
     where id = new.content_item_id and status <> 'in_review';
  end if;
  return new;
end; $$;
revoke all on function public.content_demote_on_edit() from public, anon, authenticated;
drop trigger if exists content_demote_on_edit_tg on public.content_revision;
create trigger content_demote_on_edit_tg after insert on public.content_revision
  for each row execute function public.content_demote_on_edit();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `cms_workflow_test.sql .. ok` (32 assertions); definer-audit exits 0; `db diff` empty.

- [ ] **Step 4: Gate — seven emit triggers + demote present, all pinned**

```bash
grep -cE 'create trigger content_(item_created|revision_created|item_submitted|approval_decided|publish_event)_emit_event_tg|create trigger content_demote_on_edit_tg' \
  supabase/migrations/20260701000013_cms_workflow.sql
node scripts/check-definer-audit.mjs
```
Expected: grep prints `6` (five emit trigger statements — two events share the approval/publish triggers — plus demote); definer-audit exits `0` with `all definers pinned`. (The five emit trigger functions cover seven event types: the decided trigger emits approved+rejected; the publish trigger emits published+unpublished.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000013_cms_workflow.sql supabase/tests/cms_workflow_test.sql
git commit -m "feat(cms): lifecycle emit triggers + demote-on-edit"
```

---

### Task 4: Workflow RPCs + `ContentService` ops + integration test

**Files:**
- Create: `supabase/migrations/20260701000014_cms_workflow_rpcs.sql`
- Edit: `packages/domain/src/content.ts`, `packages/domain/src/types.ts`
- Create: `packages/domain/test/content_workflow.integration.test.ts`

**Interfaces:**
- Consumes: the three tables + RLS (Task 2), Part A's `content_item`/`content_revision`, `(select auth.uid())`.
- Produces: four `SECURITY INVOKER` RPCs (`submit_for_approval`, `decide_approval`, `publish_content`, `unpublish_content`) and six `ContentService` methods (the four RPC-backed writes plus the `getPublished`/`listApprovals` reads). Invariants: RPCs are INVOKER so the capability RLS `with check` stays in force (approve/publish gated); `decide_approval` counts DISTINCT approving voters **server-side** (`single` → first approve decides; `multi`/`moderation` → `>= approvals_required`; any reject → rejected); approve freezes `approved_revision_id` + `approved_content_hash` from the item's `current_revision_id`; publish sets `published_revision_id`/`published_at`/`status`; `getPublished` reads the exact revision at `published_revision_id`.

- [ ] **Step 0: Locate the client accessor + integration harness** — from Step 0.3 confirm the per-request client accessor is `ctx.db` (from the `makeContentService(ctx)` factory, resolved at call time), and locate the existing collab integration test to clone its bootstrap (auth as a user, create a workspace + membership): `ls packages/domain/test/*integration*` and read it.

- [ ] **Step 1: Write the failing integration test (red)**

Create `packages/domain/test/content_workflow.integration.test.ts`. Adapt the bootstrap (client creation, `authAs`, workspace/membership setup) from the harness found in Step 0; keep the assertions below verbatim (they are the load-bearing contract). The multi-vote case needs two owner-role users (both have the approve cap).
```ts
import { describe, it, expect, beforeAll } from 'vitest'
// Adapt these imports/helpers to the existing collab integration harness (Step 0):
//   makeService(clientForUser)  -> ContentService bound to an authed client
//   authAs(userId)              -> a Supabase client authed as userId (owner-role member)
//   seedWorkspace(...)          -> workspace + memberships + a content_type

describe('CMS approval + publish workflow (integration)', () => {
  let ws: string, ct: string, ownerA: string, ownerB: string, member: string

  beforeAll(async () => {
    ;({ ws, ct, ownerA, ownerB, member } = await seedWorkspace()) // A,B owner-role; member no caps
  })

  it('single-policy: one approve decides and freezes the revision + hash', async () => {
    const svc = makeService(authAs(ownerA))
    const item = await svc.create({ workspaceId: ws, contentTypeId: ct, data: { t: 'v1' } })
    const submitted = await svc.submitForApproval({ itemId: item.id }) // policy defaults to 'single'
    expect(submitted.status).toBe('in_review')
    // find the pending approval (via the service's own read, or a direct select in the harness)
    const approvalId = await latestApprovalId(item.id)
    const decided = await svc.decideApproval({ approvalId, vote: 'approve' })
    expect(decided.state).toBe('approved')
    expect(decided.approved_revision_id).toBe(item.current_revision_id)
    expect(decided.approved_content_hash).toBeTruthy()
  })

  it('multi-policy: flips only when distinct approvers reach the threshold', async () => {
    const item = await makeService(authAs(ownerA)).create({ workspaceId: ws, contentTypeId: ct, data: { t: 'm' } })
    await makeService(authAs(ownerA)).submitForApproval({ itemId: item.id, policy: 'multi', approvalsRequired: 2 })
    const approvalId = await latestApprovalId(item.id)
    const first = await makeService(authAs(ownerA)).decideApproval({ approvalId, vote: 'approve' })
    expect(first.state).toBe('pending') // 1 of 2
    const second = await makeService(authAs(ownerB)).decideApproval({ approvalId, vote: 'approve' })
    expect(second.state).toBe('approved') // 2 of 2 distinct voters
  })

  it('rejects a duplicate vote from the same voter', async () => {
    const item = await makeService(authAs(ownerA)).create({ workspaceId: ws, contentTypeId: ct, data: { t: 'd' } })
    await makeService(authAs(ownerA)).submitForApproval({ itemId: item.id, policy: 'multi', approvalsRequired: 2 })
    const approvalId = await latestApprovalId(item.id)
    await makeService(authAs(ownerA)).decideApproval({ approvalId, vote: 'approve' })
    await expect(makeService(authAs(ownerA)).decideApproval({ approvalId, vote: 'approve' }))
      .rejects.toThrow() // 23505 unique(approval_id, voter_id) -> rolls back the whole RPC
  })

  it('publish freezes the snapshot; getPublished returns it while a newer draft exists', async () => {
    const svc = makeService(authAs(ownerA))
    const item = await svc.create({ workspaceId: ws, contentTypeId: ct, data: { t: 'p1' } })
    await svc.submitForApproval({ itemId: item.id })
    const decided = await svc.decideApproval({ approvalId: await latestApprovalId(item.id), vote: 'approve' })
    const approvedRev = decided.approved_revision_id
    expect(approvedRev).toBe(item.current_revision_id)
    // create a NEWER draft revision BEFORE publish (demote fires: approval superseded,
    // status -> in_review). Publish must still use the frozen approved revision, not
    // the newer current_revision_id.
    await svc.update({ itemId: item.id, data: { t: 'p2' } })
    const published = await svc.publish({ itemId: item.id })
    expect(published.status).toBe('published')
    expect(published.published_revision_id).toBe(approvedRev)
    const got = await svc.getPublished(item.id)
    expect(got).not.toBeNull()
    expect(got!.revision.id).toBe(approvedRev) // still the FROZEN v1 snapshot
    expect(got!.revision.data).toEqual({ t: 'p1' })
  })

  it('denies decide/publish to a member without the capability', async () => {
    const svc = makeService(authAs(ownerA))
    const item = await svc.create({ workspaceId: ws, contentTypeId: ct, data: { t: 'x' } })
    await svc.submitForApproval({ itemId: item.id })
    const approvalId = await latestApprovalId(item.id)
    await expect(makeService(authAs(member)).decideApproval({ approvalId, vote: 'approve' }))
      .rejects.toThrow() // 42501 from content_approval UPDATE with-check
    await expect(makeService(authAs(member)).publish({ itemId: item.id }))
      .rejects.toThrow() // 42501 from content_publish_event INSERT with-check
  })
})
```

Run (local stack must be up — `supabase start`): `pnpm --filter @movp/domain test`
Expected: FAIL — the RPCs and the five methods do not exist yet (`svc.submitForApproval is not a function` / `function public.submit_for_approval does not exist`).

- [ ] **Step 2: Create the RPC migration (INVOKER, so RLS enforces capability)**

Create `supabase/migrations/20260701000014_cms_workflow_rpcs.sql`. GOTCHA: these are `SECURITY INVOKER` — a `SECURITY DEFINER` owned by postgres would BYPASS RLS and defeat the capability gate. Keep `set search_path = ''` (hygiene; the audit gate ignores invoker functions) and fully qualify everything incl. `auth.uid()`.
```sql
-- CMS Phase 4 — Part B RPCs. SECURITY INVOKER so the capability RLS with-check
-- on content_approval (approve) / content_publish_event (publish) stays in force.

-- submit_for_approval: create a pending approval + set the item to in_review.
create or replace function public.submit_for_approval(
  p_item_id uuid, p_policy text default 'single', p_approvals_required int default 1)
returns public.content_item language plpgsql security invoker set search_path = '' as $$
declare v_ws uuid; v_item public.content_item;
begin
  select workspace_id into v_ws from public.content_item where id = p_item_id;
  if v_ws is null then raise exception 'content_item_not_found' using errcode = 'P0002'; end if;
  insert into public.content_approval (workspace_id, content_item_id, state, policy, approvals_required)
    values (v_ws, p_item_id, 'pending', p_policy, coalesce(p_approvals_required, 1));
  update public.content_item set status = 'in_review' where id = p_item_id returning * into v_item;
  return v_item;
end; $$;
revoke all on function public.submit_for_approval(uuid, text, int) from public, anon;
grant execute on function public.submit_for_approval(uuid, text, int) to authenticated;

-- decide_approval: record the vote, count DISTINCT approvers server-side, flip
-- when the policy threshold is met. The content_approval UPDATE below is gated
-- by the approve-cap with-check -> a non-approver's call raises 42501 (and the
-- whole function rolls back, so the vote is not left behind).
create or replace function public.decide_approval(p_approval_id uuid, p_vote text)
returns public.content_approval language plpgsql security invoker set search_path = '' as $$
declare
  v_appr public.content_approval;
  v_uid uuid := (select auth.uid());
  v_approve_count int;
  v_rev uuid;
  v_hash text;
begin
  select * into v_appr from public.content_approval where id = p_approval_id;
  if v_appr.id is null then raise exception 'approval_not_found' using errcode = 'P0002'; end if;

  insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote)
    values (v_appr.workspace_id, p_approval_id, v_uid, p_vote); -- 23505 on a duplicate voter

  if p_vote = 'reject' then
    update public.content_approval set state='rejected', decided_at=now(), decided_by=v_uid
     where id = p_approval_id returning * into v_appr;
    return v_appr;
  end if;

  select count(distinct voter_id) into v_approve_count
    from public.content_approval_vote where approval_id = p_approval_id and vote = 'approve';

  if (v_appr.policy = 'single' and v_approve_count >= 1)
     or (v_appr.policy in ('multi', 'moderation') and v_approve_count >= v_appr.approvals_required) then
    select current_revision_id into v_rev from public.content_item where id = v_appr.content_item_id;
    select content_hash into v_hash from public.content_revision where id = v_rev;
    update public.content_approval
       set state='approved', decided_at=now(), decided_by=v_uid,
           approved_revision_id=v_rev, approved_content_hash=v_hash
     where id = p_approval_id returning * into v_appr;
    update public.content_item set status='approved', approved_revision_id=v_rev
     where id = v_appr.content_item_id;
  end if;
  return v_appr;
end; $$;
revoke all on function public.decide_approval(uuid, text) from public, anon;
grant execute on function public.decide_approval(uuid, text) to authenticated;

-- publish_content: append a publish event (publish-cap-gated) + point the item.
-- Prefer approved_revision_id over current_revision_id: if an approved item was edited
-- afterward, demote-on-edit leaves the approved revision frozen for audit/publish while
-- current_revision_id points at the newer draft.
create or replace function public.publish_content(p_item_id uuid)
returns public.content_item language plpgsql security invoker set search_path = '' as $$
declare v_item public.content_item; v_ws uuid; v_rev uuid; v_hash text; v_uid uuid := (select auth.uid());
begin
  select workspace_id, coalesce(approved_revision_id, current_revision_id)
    into v_ws, v_rev from public.content_item where id = p_item_id;
  if v_ws is null then raise exception 'content_item_not_found' using errcode = 'P0002'; end if;
  if v_rev is null then raise exception 'content_no_revision' using errcode = 'P0001'; end if;
  select content_hash into v_hash from public.content_revision where id = v_rev;
  insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (v_ws, p_item_id, 'publish', v_rev, v_hash, v_uid);
  update public.content_item set status='published', published_revision_id=v_rev, published_at=now()
   where id = p_item_id returning * into v_item;
  return v_item;
end; $$;
revoke all on function public.publish_content(uuid) from public, anon;
grant execute on function public.publish_content(uuid) to authenticated;

-- unpublish_content: append an unpublish event + archive the item.
create or replace function public.unpublish_content(p_item_id uuid)
returns public.content_item language plpgsql security invoker set search_path = '' as $$
declare v_item public.content_item; v_ws uuid; v_rev uuid; v_hash text; v_uid uuid := (select auth.uid());
begin
  select workspace_id, published_revision_id into v_ws, v_rev from public.content_item where id = p_item_id;
  if v_ws is null then raise exception 'content_item_not_found' using errcode = 'P0002'; end if;
  if v_rev is null then raise exception 'content_not_published' using errcode = 'P0001'; end if;
  select content_hash into v_hash from public.content_revision where id = v_rev;
  insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (v_ws, p_item_id, 'unpublish', v_rev, v_hash, v_uid);
  update public.content_item set status='archived', published_revision_id=null
   where id = p_item_id returning * into v_item;
  return v_item;
end; $$;
revoke all on function public.unpublish_content(uuid) from public, anon;
grant execute on function public.unpublish_content(uuid) to authenticated;
```

- [ ] **Step 3: Extend `ContentService` (types.ts + content.ts)**

In `packages/domain/src/types.ts`, import the generated `ContentApprovalRow` (codegen produced it in Task 1) and add to the `ContentService` interface:
```ts
  submitForApproval(i: { itemId: string; policy?: 'single' | 'multi' | 'moderation'; approvalsRequired?: number }): Promise<ContentItemRow>
  decideApproval(i: { approvalId: string; vote: 'approve' | 'reject' }): Promise<ContentApprovalRow>
  publish(i: { itemId: string }): Promise<ContentItemRow>
  unpublish(i: { itemId: string }): Promise<ContentItemRow>
  getPublished(id: string): Promise<{ item: ContentItemRow; revision: ContentRevisionRow } | null>
  listApprovals(a: { workspaceId: string; itemId?: string; state?: 'pending' | 'approved' | 'rejected' | 'superseded'; first?: number; after?: string | null }): Promise<Page<ContentApprovalRow>>
```
(`Page` is already imported in `types.ts` — Part A uses it for `listTypes`/`list`; `ContentApprovalRow` was imported above.) In `packages/domain/src/content.ts`, add these methods to the object returned by `makeContentService(ctx)` — a factory (Part A Task 4), NOT a class; they close over the same `ctx` and `fail` as `create()`/`update()` (per-request client `ctx.db`, resolved at call time — never `this`, never module scope). Route every failure through `fail(op, error.code)` (the stable `domain.content.<op> failed [<code>]` contract).
```ts
  async submitForApproval(i: { itemId: string; policy?: 'single' | 'multi' | 'moderation'; approvalsRequired?: number }): Promise<ContentItemRow> {
    const { data, error } = await ctx.db.rpc('submit_for_approval', {
      p_item_id: i.itemId, p_policy: i.policy ?? 'single', p_approvals_required: i.approvalsRequired ?? 1,
    })
    if (error) fail('submitForApproval', error.code)
    return data as ContentItemRow
  },
  async decideApproval(i: { approvalId: string; vote: 'approve' | 'reject' }): Promise<ContentApprovalRow> {
    const { data, error } = await ctx.db.rpc('decide_approval', { p_approval_id: i.approvalId, p_vote: i.vote })
    if (error) fail('decideApproval', error.code)
    return data as ContentApprovalRow
  },
  async publish(i: { itemId: string }): Promise<ContentItemRow> {
    const { data, error } = await ctx.db.rpc('publish_content', { p_item_id: i.itemId })
    if (error) fail('publish', error.code)
    return data as ContentItemRow
  },
  async unpublish(i: { itemId: string }): Promise<ContentItemRow> {
    const { data, error } = await ctx.db.rpc('unpublish_content', { p_item_id: i.itemId })
    if (error) fail('unpublish', error.code)
    return data as ContentItemRow
  },
  async getPublished(id: string): Promise<{ item: ContentItemRow; revision: ContentRevisionRow } | null> {
    const { data: item, error: e1 } = await ctx.db.from('content_item').select('*').eq('id', id).maybeSingle()
    if (e1) fail('getPublished', e1.code)
    if (!item?.published_revision_id) return null
    const { data: revision, error: e2 } = await ctx.db
      .from('content_revision').select('*').eq('id', item.published_revision_id).maybeSingle()
    if (e2) fail('getPublished', e2.code)
    if (!revision) return null
    return { item: item as ContentItemRow, revision: revision as ContentRevisionRow }
  },
  // A read (no RPC — like getPublished/list): lists approvals so a surface (Part D's
  // approval queue + e2e) can obtain an approvalId for decideApproval. RLS SELECT gates
  // visibility. Keyset on id, mirroring Part A's list(); clamp/DEFAULT_PAGE/MAX_PAGE/
  // encodeCursor/decodeCursor are already in scope (Part A, same file).
  async listApprovals(a: { workspaceId: string; itemId?: string; state?: 'pending' | 'approved' | 'rejected' | 'superseded'; first?: number; after?: string | null }) {
    const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
    let q = ctx.db.from('content_approval').select('*').eq('workspace_id', a.workspaceId)
    if (a.itemId) q = q.eq('content_item_id', a.itemId)
    if (a.state) q = q.eq('state', a.state)
    q = q.order('id', { ascending: true }).limit(first + 1)
    if (a.after) q = q.gt('id', decodeCursor(a.after))
    const { data, error } = await q
    if (error) fail('listApprovals', error.code)
    const rows = (data ?? []) as ContentApprovalRow[]
    const items = rows.length > first ? rows.slice(0, first) : rows
    const last = items.at(-1)
    return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
  },
```

- [ ] **Step 4: Apply + run integration + migration drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
pnpm --filter @movp/domain test
```
Expected: pgTAP still `ok` (32); definer-audit exits 0 (the RPCs are invoker — not flagged); `db diff` empty; `@movp/domain` tests pass (all five `content_workflow.integration` cases green).

- [ ] **Step 5: Gate — RPCs are INVOKER, capability enforced by RLS not the service**

```bash
grep -c "security invoker set search_path = ''" supabase/migrations/20260701000014_cms_workflow_rpcs.sql
grep -c "security definer" supabase/migrations/20260701000014_cms_workflow_rpcs.sql
```
Expected: the first grep prints `4` (all four RPCs are invoker); the second prints `0` (no definer in the RPC migration — a definer here would bypass the capability RLS).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000014_cms_workflow_rpcs.sql packages/domain/src/content.ts \
  packages/domain/src/types.ts packages/domain/test/content_workflow.integration.test.ts
git commit -m "feat(cms): workflow RPCs + ContentService approval/publish ops"
```

---

### Task 5: HMAC-SHA256 webhook signing + unit test

**Files:**
- Edit: `packages/flows/src/flows-worker.ts`
- Create: `packages/flows/test/webhook-hmac.test.ts`

**Interfaces:**
- Consumes: the committed webhook-delivery loop + `stringField`; `crypto.subtle` (available on workerd AND in vitest/Node 18+).
- Produces: `buildWebhookRequest(payload)` (extracted, testable) that signs the delivered body with the subscriber secret and STRIPS the secret from the body. Invariants: header `x-movp-signature: sha256=<hex>` is present iff a secret is present; the signature validates against the exact sent body with the secret; the secret never appears in the sent body.

- [ ] **Step 1: Write the failing unit test (red)**

Create `packages/flows/test/webhook-hmac.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildWebhookRequest } from '../src/flows-worker'

async function verify(secret: string, body: string, sigHex: string): Promise<boolean> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const sig = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(body))
}

describe('webhook HMAC signing', () => {
  it('signs the sent body and strips the secret', async () => {
    const { headers, body } = await buildWebhookRequest({
      url: 'https://example.test/hook', event: 'content.published',
      id: '00000003-0000-0000-0000-000000000000', secret: 's3cr3t',
    })
    expect(JSON.parse(body).secret).toBeUndefined()       // secret stripped from the delivered body
    expect(body).not.toContain('s3cr3t')
    expect(headers['x-movp-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    const sigHex = headers['x-movp-signature'].slice('sha256='.length)
    expect(await verify('s3cr3t', body, sigHex)).toBe(true) // validates against the exact sent body
  })

  it('omits the signature header when no secret is present', async () => {
    const { headers, body } = await buildWebhookRequest({ url: 'https://example.test/hook', id: 'x' })
    expect(headers['x-movp-signature']).toBeUndefined()
    expect(JSON.parse(body).secret).toBeUndefined()
  })
})
```

Run: `pnpm --filter @movp/flows test`
Expected: FAIL — `buildWebhookRequest` is not exported (`does not provide an export named 'buildWebhookRequest'`).

- [ ] **Step 2: Add signing + extract the builder (green)**

In `packages/flows/src/flows-worker.ts`, add the helper + exported builder, then have the webhook loop call it. GOTCHA (workerd): use `crypto.subtle` (global on workerd and Node 18+) — do NOT import Node's `crypto` module.
```ts
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Sign the delivered body with the subscriber secret and STRIP the secret from
// the body actually sent — the secret proves authenticity, it is never leaked
// to the subscriber.
export async function buildWebhookRequest(
  payload: Record<string, unknown>,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const url = stringField(payload.url)
  if (!url) throw new Error('webhook_missing_url')
  const secret = stringField(payload.secret)
  const sent: Record<string, unknown> = { ...payload }
  delete sent.secret
  const body = JSON.stringify(sent)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) headers['x-movp-signature'] = `sha256=${await hmacHex(secret, body)}`
  return { url, headers, body }
}
```
Then replace the body of the webhook loop (the `for (const job of await claimDueJobs(db, 'webhook', limit))` block) so its `try` delivers via the builder:
```ts
  for (const job of await claimDueJobs(db, 'webhook', limit)) {
    try {
      const { url, headers, body } = await buildWebhookRequest(job.payload as Record<string, unknown>)
      const res = await fetch(url, { method: 'POST', headers, body })
      if (!res.ok) throw new Error(`webhook:${res.status}`)
      await completeJob(db, job.id, true); processed++
    } catch (e) { await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown'); failed++ }
  }
```

- [ ] **Step 3: Run the unit test + typecheck**

```bash
pnpm --filter @movp/flows test
pnpm --filter @movp/flows typecheck
```
Expected: both `webhook-hmac` cases pass; typecheck clean.

- [ ] **Step 4: Gate — secret is stripped, signature header emitted, no Node crypto import**

```bash
grep -q "delete sent.secret" packages/flows/src/flows-worker.ts && echo SECRET_STRIPPED_OK
grep -q "x-movp-signature" packages/flows/src/flows-worker.ts && echo SIG_HEADER_OK
grep -cE "from ['\"](node:)?crypto['\"]" packages/flows/src/flows-worker.ts
```
Expected: prints `SECRET_STRIPPED_OK` and `SIG_HEADER_OK`; the third grep prints `0` (uses global `crypto.subtle`, not the Node `crypto` module — workerd-safe).

- [ ] **Step 5: Commit**

```bash
git add packages/flows/src/flows-worker.ts packages/flows/test/webhook-hmac.test.ts
git commit -m "feat(flows): HMAC-SHA256 sign webhooks; strip secret from delivered body"
```

---

## Self-Review

- **Spec coverage (Part B scope):** three collections + codegen with FK-name pins (Task 1); `has_content_capability` + capability RLS with-check + immutability guards (Task 2); seven lifecycle emit triggers + demote-on-edit (Task 3); four INVOKER RPCs + six `ContentService` ops (incl. the `listApprovals` read) + integration test (Task 4); HMAC webhook signing + unit test (Task 5). Tasks 1–3 are TDD (red → green) with the apply gate `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` + a targeted grep; Tasks 4–5 are TDD via vitest.
- **Event → trigger-site map (verbatim names; Part C owns `content.scheduled`):**
  - `content.created` — AFTER INSERT on `content_item` → payload `id`(item), `content_type_id`, `status`.
  - `content.revision_created` — AFTER INSERT on `content_revision` → payload `id`(revision), `content_item_id`, `content_hash`.
  - `content.submitted_for_approval` — AFTER UPDATE OF status on `content_item` WHEN `new.status='in_review'` and distinct → `id`(item), `content_type_id`, `status`, `actor_id`.
  - `content.approved` — AFTER UPDATE OF state on `content_approval` WHEN `new.state='approved'` → `id`(item), `approval_id`, `revision_id`, `content_hash`, `actor_id`, `status`.
  - `content.rejected` — same trigger WHEN `new.state='rejected'` → `id`(item), `approval_id`, `actor_id`, `status`.
  - `content.published` — AFTER INSERT on `content_publish_event` WHEN `action='publish'` → `id`(item), `revision_id`, `content_hash`, `actor_id`, `status='published'`.
  - `content.unpublished` — same trigger WHEN `action='unpublish'` → same shape, `status='archived'`.
  All payloads carry IDs/hashes/status/actor only; the Task-3 pgTAP asserts `not (payload ? 'data')`.
- **`has_content_capability(ws, cap)` contract:** hardened `SECURITY DEFINER` `set search_path=''`; reads `(select auth.uid())`'s `workspace_membership.role` for `ws`; returns true iff role ∈ {`owner`,`admin`} AND cap ∈ {`approve`,`publish`}; false for `member`/absent; `revoke all from public, anon` + `grant execute to authenticated` (needed because it is evaluated inside RLS `with check` in the authenticated role). Capability authority is in the RLS `with check` (content_approval UPDATE → `approve`; content_publish_event INSERT → `publish`), NOT the service — Task 2 pgTAP proves a `member` gets `42501` via direct SQL; the integration test proves it end-to-end.
- **Approval/publish op semantics:** `submitForApproval` inserts a pending `content_approval`(policy) + sets item `in_review`. `decideApproval` inserts a vote (unique per voter → `23505` on repeat), counts DISTINCT approve-voters **server-side**; `single` → first approve flips; `multi`/`moderation` → `>= approvals_required`; any reject → `rejected`; on flip it freezes `approved_revision_id` = item `current_revision_id` + `approved_content_hash` and sets item `approved`. `publish` appends a `publish` event (revision = `approved_revision_id` ?? `current_revision_id`) + sets `published_revision_id`/`published_at`/`status='published'`, so a post-approval draft edit cannot accidentally publish the unapproved newer draft. `unpublish` appends an `unpublish` event (revision = `published_revision_id`) + `status='archived'`/clears `published_revision_id`. `getPublished` reads the exact revision at `published_revision_id` (frozen snapshot even when a newer draft exists). RPCs are INVOKER so the capability RLS stays authoritative; a failed capability check raises inside the single-statement RPC → full rollback (no orphan vote).
- **Demote-on-edit:** AFTER INSERT on `content_revision`; when `approved_revision_id is not null and <> new.id`, supersedes the open approval (`state in (pending,approved) → superseded`) and resets item to `in_review`, preserving `approved_revision_id`/`approved_content_hash` for audit. No-recursion is inline-commented: the status-only update fires `content_item`'s AFTER UPDATE OF status trigger (which only emits) and inserts no revision, so the AFTER-INSERT-on-`content_revision` trigger cannot re-fire.
- **HMAC header format:** `x-movp-signature: sha256=<hex>` where `<hex>` = HMAC-SHA256(secret, sentBody) via `crypto.subtle` (workerd-safe, no Node `crypto`); the `secret` is deleted from the delivered body (`buildWebhookRequest` strips it), present iff a secret is threaded; the unit test verifies the signature validates against the exact sent body and that the secret is absent.
- **Correctness / self-consistency:** FK column names (`content_item_id`, `revision_id`, `approval_id`, `approved_revision_id`) are pinned by Task-1 `has_column` gates so codegen drift fails loudly before any dependent SQL runs; `policies_are(…)` pins the exact policy set so a surviving blanket `_rw` cannot silently OR-bypass the capability check; `plan(N)` is bumped 7 → 21 → 32 as blocks are inserted before the single `select * from finish();`; all fixture UUIDs are valid hex.
- **Safety / observability:** every trigger/guard/capability function is a hardened `SECURITY DEFINER` (`set search_path=''`, fully qualified, `execute` revoked from public/anon/authenticated — except `has_content_capability`, intentionally granted to authenticated for RLS); RPCs are `SECURITY INVOKER` so RLS is authoritative; append-only tables are immutable by guard trigger (raise `P0001` on UPDATE/DELETE) not merely by absent policies. Payloads leak no `data`/PII. `emit_event` is untouched. All definers pass `check-definer-audit.mjs`.
- **Reliability / efficiency / performance:** every DB task ends with `supabase db reset` + empty `supabase db diff`; `drop … if exists` + `create or replace` keep the migration re-runnable; `decide_approval` counts distinct voters in one server-side query and only writes on a real flip; `getPublished` is a two-key point read; the two content_item status triggers are scoped `OF status` so unrelated updates never invoke them.
- **Part A dependencies flagged (Step 0):** `content_item.published_at` (add via config if Part A omitted it), `content_type` NOT NULL columns for the seed, collections-config file location, and the domain client accessor — each has an explicit Step-0 verification rather than an unstated assumption.
- **Deferred (intentional):** `content.scheduled` (Part C); the frontend cache-purge subscriber (consumer side); no notify path added (CMS events are webhook-oriented). None are needed for this DB/workflow/worker deliverable.
- **Placeholder scan:** the only non-literal tokens are the Step-0-resolved `<collections-config-dir>` and the `…000002…` generated migration name (codegen-owned); every SQL/TS block is otherwise copy-paste-ready with an exact command + expected output.
