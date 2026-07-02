# MOVP App — CMS Phase 4, Part C: Scheduling, Assets, Curation & SEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the scheduling, asset, curation, and SEO surface on top of the CMS core delivered in Parts A/B. Add five `internal:true`, `workspaceScoped:true` collections (`content_schedule`, `asset`, `content_collection`, `content_collection_entry`, `content_seo`), regenerate the codegen schema migration `20260701000002_*.sql`, then hand-author two migrations — `20260701000015_cms_schedule_assets.sql` (schedule/asset RLS + indexes + the `content.scheduled` trigger + the crash-safe scheduler RPCs) and `20260701000016_cms_curation_seo.sql` (curation/SEO uniques + RLS, including the **published-only** curation `with check`). Add a `content-scheduler` Deno edge worker that claims due schedule rows and runs each through `public.run_scheduled_publish`, a `content-assets` Deno edge fn that mints **presigned R2 PUT** URLs (bounded mime/size; the server never buffers the file), and extend the `@movp/domain` `ContentService` with `schedule` / `issueAssetUpload` / `finalizeAsset` / `createCollection` / `addToCollection` / `reorderCollection` / `runSeoAudit` plus three graph-edge link ops.

**Architecture:** Parts A/B generated the CMS core (`content_type`, `content_item` with `status`/`published_revision_id`/`current_revision_id`, immutable `content_revision`, `content_publish_event`) and the `content` domain service with `publish({itemId})`/`unpublish({itemId})` (append a `content_publish_event`, advance the item's pointers, emit `content.published`/`content.unpublished` + the signed webhook). This Part C is **additive**: it introduces no new event type except `content.scheduled` (verbatim) — a **scheduled** publish/unpublish reuses Part B's `content.published`/`content.unpublished` by going through the same publish path (`run_scheduled_publish`). The single load-bearing invariant is **revision pinning**: a `content_schedule` row stores `revision_id` captured *at schedule time*, and `run_scheduled_publish` publishes THAT revision, never `content_item.current_revision_id` — so an edit made after scheduling cannot change what goes live. Scheduling is **crash-safe and exactly-once**: `claim_due_schedules` flips `scheduled → fired` under `for update skip locked`, so a re-invoked worker cannot double-publish. Assets are **presigned**: the domain never touches R2 credentials and the server never buffers file bytes — `issueAssetUpload` validates mime + size, calls the `content-assets` edge fn which computes `r2_key = <workspace_id>/<assetId>`, presigns an S3 PUT with SigV4 (R2 creds from `Deno.env`/Vault), and returns `{ uploadUrl, r2Key, assetId }`; the client PUTs bytes directly to R2; `finalizeAsset` records the **server-verified** `size_bytes`/`checksum` (re-HEAD of the R2 object), never the client-declared values. Curation is **published-only at the RLS boundary** (not merely in the service): the `content_collection_entry` INSERT policy's `with check` requires the referenced item's `status = 'published'`. SEO is **advisory**: `runSeoAudit` runs a pure rule set over the item's current revision + `content_seo.meta`/`jsonld` and upserts a `score` + `checklist` — no gate, no event.

**ContentService additions (the verbatim contract for Tasks 3–5):**
```ts
// packages/domain/src/content.ts — extend the ContentService interface.
// Row types come from the regenerated @movp/domain generated types (Task 1).
export interface ContentService {
  // ...Part A/B methods (publish/unpublish/createItem/saveRevision/...) unchanged...
  schedule(i: { itemId: string; action: 'publish' | 'unpublish'; revisionId: string; runAt: string }): Promise<ContentScheduleRow>;
  issueAssetUpload(i: { workspaceId: string; filename: string; mime: string; sizeBytes: number }): Promise<{ uploadUrl: string; r2Key: string; assetId: string }>;
  finalizeAsset(i: { assetId: string; checksum: string; sizeBytes: number; width?: number; height?: number }): Promise<AssetRow>;
  createCollection(i: { workspaceId: string; key: string; label: string; description?: string }): Promise<ContentCollectionRow>;
  addToCollection(i: { collectionId: string; itemId: string; position?: number }): Promise<void>; // published-only (RLS enforces)
  reorderCollection(i: { collectionId: string; orderedItemIds: string[] }): Promise<void>;
  runSeoAudit(i: { itemId: string }): Promise<ContentSeoRow>; // advisory: score + checklist [{rule,pass}]
  linkAsset(i: { itemId: string; assetId: string }): Promise<void>;       // edge content_item —references→ asset
  linkItem(i: { itemId: string; targetItemId: string }): Promise<void>;   // edge content_item —references→ content_item
  linkEditorialTask(i: { itemId: string; taskId: string }): Promise<void>;// edge content_item —editorial_task→ task (loose, no FK)
}
```

**Tech Stack:** Config-first collection schema + `pnpm codegen` (regenerates `20260701000002_*.sql` and the generated TS row types), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` triggers/functions, the committed `public.emit_event` / `movp_internal.{movp_events,movp_jobs,webhooks}` async backbone, `public.is_workspace_member` / `public.can_access_entity('content_item')` / `public.has_content_capability`, Supabase Edge Functions (Deno.serve + service-role client, mirroring `supabase/functions/flows/index.ts`), R2 S3-compatible presign via `npm:aws4fetch`, the definer-audit gate (`node scripts/check-definer-audit.mjs`), Vitest (`@movp/domain`), and the Astro/Cloudflare frontend build (`pnpm --filter @movp/frontend-astro build`).

**This is Part C of the CMS Phase 4 series.** It depends on **Part A/B** (the CMS core tables + the `content` domain service incl. `publish`/`unpublish`, migrations `000001`–`000014`), on the async backbone (`emit_event`, `movp_events`/`movp_jobs`/`webhooks` + the signed-webhook worker), on the collaboration primitives (`is_workspace_member`), and on the graph service (`makeGraphService` + the `edges` table). Downstream consumers depend on the event name **`content.scheduled` verbatim** and on the reused `content.published`/`content.unpublished` — do not rename. FK column names are fixed by Parts A/B: **`content_item_id`**, **`revision_id`**, **`collection_id`**.

## Global Constraints

- **Codegen owns table DDL; this Part hand-authors the rest.** Task 1 adds five collections to `schema.ts` + `index.ts` and runs `pnpm codegen`, which regenerates `supabase/migrations/20260701000002_*.sql` with the five tables (columns, workspace_id, FK columns) and `enable row level security`. The **policies, uniques, indexes, triggers, and RPCs are hand-authored** in `000015`/`000016`. Do NOT hand-edit any generated migration.
- **Exact migration filenames, not `supabase migration new`.** Create `supabase/migrations/20260701000015_cms_schedule_assets.sql` and `supabase/migrations/20260701000016_cms_curation_seo.sql` (a wall-clock timestamp would sort wrong; `000015` must sort before `000016`, both after the codegen `000002`). `000015` is built across Tasks 2–3; `000016` in Task 2.
- **All `SECURITY DEFINER` functions hardened.** Every function: `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` for trigger + internal + RPC functions. The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits on `create ... function` and FAILS any `security definer` block missing `set search_path =`. Every function below sets it — do not drop the clause.
- **Curation is published-only at the RLS boundary — not just the service.** The `content_collection_entry` INSERT policy's `with check` requires `exists(... content_item ci where ci.id = content_item_id and ci.workspace_id = workspace_id and ci.status = 'published')`. Because RLS policies are permissive (OR'd), there must be **no other permissive INSERT policy** on that table — the pgTAP `throws_ok '42501'` on a draft item proves the gate actually bites.
- **Revision pinning.** `content_schedule.revision_id` is captured at schedule time; `run_scheduled_publish` publishes `s.revision_id`, NEVER `content_item.current_revision_id`. This is what makes a later edit safe.
- **Scheduler exactly-once.** `claim_due_schedules` flips `scheduled → fired` inside `update ... where id in (select id ... for update skip locked)`; a re-invoked worker cannot re-claim a `fired` row, so it cannot double-publish. On a run error the worker sets `state = 'failed'`.
- **`content.scheduled` payload is verbatim** (contract): `jsonb_build_object('id', new.content_item_id, 'schedule_id', new.id, 'action', new.action, 'run_at', new.run_at)`, trace `gen_random_uuid()::text`. It carries no `recipient_user_id`, so `emit_event`'s notify guard records + webhooks but enqueues no notify job.
- **Assets: presigned, bounded, creds never committed.** The server NEVER buffers the file — `issueAssetUpload` validates the DECLARED `mime` (allow-list) + `size_bytes` (bounded, the bound-before-buffer analog) and returns a presigned PUT; the client PUTs bytes straight to R2; `finalizeAsset` records the SERVER-verified size/checksum (re-HEAD), never the client's. R2 S3 creds live in `Deno.env` (Vault), documented as deploy-time env, never committed or read from a client-importable path.
- **Edge fns are Deno, not workerd; the domain is workerd.** Edge functions read `Deno.env`. The domain (`@movp/domain`, runs on the Astro/Cloudflare worker) resolves per-request deps from `ctx` at call time and reads env via the project helper — never `process.env`, never a constructor-captured client — and NEVER holds R2 credentials (presign lives only in the edge fn).
- **Deploy-time pg_cron is NOT committed.** `run_scheduled_publish`/`claim_due_schedules` are committed; the `cron.schedule(...)` (or Cron→Edge invocation) that drives the `content-scheduler` worker is applied out-of-band at deploy time (Vault key, never a literal) so `supabase db diff` stays empty. pgTAP/e2e call the RPCs / invoke the worker directly.
- **`movp_internal` is not reachable by `authenticated`.** Triggers/RPCs write it only through the `SECURITY DEFINER` `emit_event`; pgTAP reads `movp_internal.movp_events` as the table owner, never as `authenticated`.
- **Every task ends with a machine-checkable gate** (below).

## File Structure

```
supasuite/
  packages/
    <schema-pkg>/                 # wherever Parts A/B keep the config-first schema
      schema.ts                   # EDIT: append the 5 CMS collections (after Part B's)
      index.ts                    # EDIT: register the 5 collections
    domain/
      src/
        content.ts                # EDIT: extend ContentService (Tasks 3–5)
        asset-bounds.ts           # NEW: validateAssetRequest + verifyFinalizePayload (pure)
        seo-audit.ts              # NEW: auditSeo (pure rule set)
      test/
        asset-bounds.test.ts      # NEW vitest (bounds + finalize verification)
        seo-audit.test.ts         # NEW vitest (SEO rule set)
        content_cms.integration.test.ts   # NEW (clone the collab integration harness)
  supabase/
    migrations/
      20260701000002_*.sql        # REGEN by `pnpm codegen` (adds the 5 tables)
      20260701000015_cms_schedule_assets.sql   # NEW hand-authored (Tasks 2–3)
      20260701000016_cms_curation_seo.sql      # NEW hand-authored (Task 2)
    functions/
      content-scheduler/index.ts  # NEW Deno edge worker (claim + run)
      content-assets/index.ts     # NEW Deno edge fn (presign PUT + finalize HEAD)
    tests/
      cms_schedule_assets_test.sql # NEW pgTAP (built across Tasks 1–3)
```

**Per-task apply gate (SQL/schema tasks end with it):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: migrations apply, `cms_schedule_assets_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing. Domain tasks end with a Vitest gate (`pnpm --filter @movp/domain test`) and/or `pnpm --filter @movp/frontend-astro build`.

---

### Task 1: Five CMS collections + codegen (regenerate `000002`) + pgTAP table gate

**Files:**
- Edit: `packages/<schema-pkg>/schema.ts` (append the 5 collections after Part B's)
- Edit: `packages/<schema-pkg>/index.ts` (register the 5 collections)
- Create: `supabase/tests/cms_schedule_assets_test.sql`
- Regen (by codegen): `supabase/migrations/20260701000002_*.sql` + generated TS row types

**Interfaces:**
- Consumes: the config-first schema DSL (`collection`/`f.*` builders) + Parts A/B's `content_item`/`content_revision`/`content_type` collections.
- Produces: five `internal:true`, `workspaceScoped:true` collections whose codegen output adds tables `content_schedule`, `asset`, `content_collection`, `content_collection_entry`, `content_seo` with the exact FK columns `content_item_id`, `revision_id`, `collection_id`. Invariant: relation fields generate the FK column names Parts A/B use — verify, do not assume.

- [ ] **Step 1: Write the failing pgTAP (red)**

Create `supabase/tests/cms_schedule_assets_test.sql` with the shared seed + a table/column-existence block. `plan(11)` now; later tasks bump it.
```sql
begin;
select plan(11);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
-- Mirrors Part A's required columns: content_item.slug and
-- content_revision.revision_number/content_hash/author_id are NOT NULL.
-- IDs are hex so they parse as uuid.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.content_type (id, workspace_id, key, label) values
  ('0000000c-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','article','Article');
-- content_item.published_revision_id <-> content_revision.content_item_id is
-- circular, so insert items with NULL pointers first, then revisions, then set.
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('00000001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','0000000c-0000-0000-0000-000000000000','published-one','published'),
  ('00000002-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','0000000c-0000-0000-0000-000000000000','draft-two','draft');
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000a1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000',1,'{"title":"Hello World Article"}'::jsonb,'hash-a1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('000000a2-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',1,'{"title":"Draft Two"}'::jsonb,'hash-a2','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
update public.content_item set published_revision_id='000000a1-0000-0000-0000-000000000000',
  current_revision_id='000000a1-0000-0000-0000-000000000000' where id='00000001-0000-0000-0000-000000000000';
update public.content_item set current_revision_id='000000a2-0000-0000-0000-000000000000'
  where id='00000002-0000-0000-0000-000000000000';
-- auth.uid() reads request.jwt.claims regardless of DB role; A is a W1 member.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- ── Task 1: the 5 tables + their FK columns exist (from codegen) ─────────────
select has_table('public','content_schedule','content_schedule table exists');
select has_table('public','asset','asset table exists');
select has_table('public','content_collection','content_collection table exists');
select has_table('public','content_collection_entry','content_collection_entry table exists');
select has_table('public','content_seo','content_seo table exists');
select has_column('public','content_schedule','content_item_id','content_schedule.content_item_id FK column');
select has_column('public','content_schedule','revision_id','content_schedule.revision_id FK column (the pinned revision)');
select has_column('public','content_schedule','scheduled_by','content_schedule.scheduled_by column (NOT NULL; run_scheduled_publish reads it for the publish-event actor)');
select has_column('public','content_collection_entry','collection_id','content_collection_entry.collection_id FK column');
select has_column('public','content_collection_entry','content_item_id','content_collection_entry.content_item_id FK column');
select has_column('public','content_seo','content_item_id','content_seo.content_item_id FK column');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

```bash
supabase test db
```
Expected: FAIL — with only `000001`–`000014` applied, the five tables do not exist; all 10 assertions fail (or the file errors on the first `has_table`). This confirms the test targets the codegen output.

- [ ] **Step 3: Append the 5 collections to `schema.ts` (green)**

Append after Part B's collections, mirroring the EXACT `collection`/`f.*` wrapper Parts A/B use for `content_item`/`content_revision` (the field builders below are the contract's verbatim field list). All five are `internal:true`, `workspaceScoped:true`, so codegen emits internal (RLS-enabled) tables with `workspace_id` + the FK columns.
```ts
// GOTCHA: the relation field names produce the FK columns Parts A/B use —
// item -> content_item_id, revision -> revision_id, collection -> collection_id.
// Verify against the regenerated 000002; the migration SQL below hard-codes them.
content_schedule: collection({
  internal: true, workspaceScoped: true,
  fields: {
    item: f.relation('content_item', { cardinality: 'many-to-one', required: true }),      // -> content_item_id
    action: f.enum(['publish', 'unpublish'], { required: true }),
    revision: f.relation('content_revision', { cardinality: 'many-to-one', required: true }), // -> revision_id (PINNED)
    run_at: f.datetime({ required: true }),
    // captured at schedule time; run_scheduled_publish (SECURITY DEFINER, auth.uid() is null)
    // reads it for the required content_publish_event.actor_id.
    scheduled_by: f.uuid({ label: 'Scheduled By', required: true }),
    state: f.enum(['scheduled', 'fired', 'canceled', 'failed'], { default: 'scheduled', reporting: { role: 'dimension' } }),
  },
}),
asset: collection({
  internal: true, workspaceScoped: true,
  fields: {
    filename: f.text({ required: true }),
    mime: f.text({ required: true, reporting: { role: 'dimension' } }),
    r2_key: f.text({ required: true }),
    size_bytes: f.number({ reporting: { role: 'measure' } }),
    checksum: f.text(),
    width: f.number(),
    height: f.number(),
    alt_text: f.text({ searchable: true }),
    uploaded_by: f.uuid({ required: true }),
  },
}),
content_collection: collection({
  internal: true, workspaceScoped: true,
  fields: {
    key: f.text({ required: true }),
    label: f.text({ required: true }),
    description: f.text(),
  },
}),
content_collection_entry: collection({
  internal: true, workspaceScoped: true,
  fields: {
    collection: f.relation('content_collection', { cardinality: 'many-to-one', required: true }), // -> collection_id
    item: f.relation('content_item', { cardinality: 'many-to-one', required: true }),             // -> content_item_id
    position: f.number({ required: true }),
  },
}),
content_seo: collection({
  internal: true, workspaceScoped: true,
  fields: {
    item: f.relation('content_item', { cardinality: 'many-to-one', required: true }), // -> content_item_id
    meta: f.json(),
    jsonld: f.json(),
    score: f.number({ reporting: { role: 'measure' } }),
    checklist: f.json(),
  },
}),
```
Then register all five in `index.ts` alongside Part B's exports (mirror the existing registration lines).

- [ ] **Step 4: Regenerate + apply + test + drift**

```bash
pnpm codegen && supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `pnpm codegen` rewrites `20260701000002_*.sql` (now containing the 5 tables) + the generated TS row types (`ContentScheduleRow`, `AssetRow`, `ContentCollectionRow`, `ContentSeoRow`, `ContentCollectionEntryRow`); `cms_schedule_assets_test.sql .. ok` (11 assertions); definer-audit exits 0; `db diff` empty (schema matches the regenerated migration).

- [ ] **Step 5: Gate — FK column names match Parts A/B**

```bash
grep -cE 'has_column\(.public.,.(content_schedule|content_collection_entry|content_seo).,.(content_item_id|revision_id|collection_id).' \
  supabase/tests/cms_schedule_assets_test.sql
```
Expected: prints `5` (the three fixed FK column names are asserted; Step 4 already proved they exist in the regenerated schema).

- [ ] **Step 6: Commit**

```bash
git add packages supabase/migrations/20260701000002_*.sql supabase/tests/cms_schedule_assets_test.sql
git commit -m "feat(cms): scheduling/asset/curation/seo collections + codegen (Part C)"
```

---

### Task 2: `000015`/`000016` uniques, indexes, RLS (curation published-only) + `content.scheduled` trigger + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000015_cms_schedule_assets.sql`
- Create: `supabase/migrations/20260701000016_cms_curation_seo.sql`
- Edit: `supabase/tests/cms_schedule_assets_test.sql` (add the Task 2 block)

**Interfaces:**
- Consumes: the codegen tables (Task 1), `public.emit_event`, `public.is_workspace_member`, Parts A/B's `public.content_item`.
- Produces: member RLS on `content_schedule`/`asset`/`content_seo` (SELECT/INSERT/UPDATE); the `content_collection`/`content_collection_entry` policies incl. the **published-only** entry INSERT `with check`; uniques `content_collection(workspace_id,key)`, `content_collection_entry(collection_id,content_item_id)`, `content_seo(content_item_id)`; indexes `content_schedule(state,run_at)` + `asset(r2_key)`; the `content.scheduled` AFTER-INSERT trigger. Invariant: a draft item cannot be added to a collection (RLS `42501`); a `content_schedule` insert emits exactly one `content.scheduled` event.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/cms_schedule_assets_test.sql`: change `select plan(11);` to `select plan(17);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 2: content.scheduled trigger + curation published-only + uniques ─────
-- content.scheduled fires on a content_schedule insert (run as owner; the
-- DEFINER trigger writes movp_internal regardless of role). run_at future so
-- Task 3's due-scan won't claim this row. scheduled_by is NOT NULL -> set it (A).
insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000','publish','000000a1-0000-0000-0000-000000000000',
   now() + interval '1 hour','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.scheduled' and payload->>'schedule_id'='000000e1-0000-0000-0000-000000000000'),
          1, 'inserting a content_schedule row emits exactly one content.scheduled event');

-- a collection + unique(workspace_id, key)
insert into public.content_collection (id, workspace_id, key, label) values
  ('000000c1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','featured','Featured');
select throws_ok($$
  insert into public.content_collection (workspace_id, key, label)
  values ('11111111-1111-1111-1111-111111111111','featured','Dupe')
$$, '23505', null, 'content_collection(workspace_id, key) is unique');

-- published-only curation, enforced by RLS with check (act as member A)
set local role authenticated;
select lives_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000001-0000-0000-0000-000000000000',0)
$$, 'a member may add a PUBLISHED item to a collection');
select throws_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000002-0000-0000-0000-000000000000',1)
$$, '42501', null, 'adding a DRAFT item is rejected by RLS (curation is published-only)');
reset role;

-- unique(collection_id, content_item_id) — run as owner (RLS bypassed) so the
-- duplicate reaches the unique index rather than a with-check rejection.
select throws_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000001-0000-0000-0000-000000000000',2)
$$, '23505', null, 'content_collection_entry(collection_id, content_item_id) is unique');

-- unique(content_item_id) on content_seo
insert into public.content_seo (workspace_id, content_item_id) values
  ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000');
select throws_ok($$
  insert into public.content_seo (workspace_id, content_item_id)
  values ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000')
$$, '23505', null, 'content_seo(content_item_id) is unique (one SEO row per item)');
```

Run: `supabase test db`
Expected: FAIL — the migrations `000015`/`000016` do not exist yet, so: no `content.scheduled` event (0 ≠ 1); no uniques (the `23505` `throws_ok`s fail — the dupes succeed); and with no published-only policy the draft `throws_ok '42501'` fails (either the insert succeeds, or RLS is enabled with no policy and BOTH curation inserts fail). Multiple failing assertions; the first 11 pass.

- [ ] **Step 2: Create `000015` — schedule/asset RLS + indexes + `content.scheduled` trigger (green)**

Create `supabase/migrations/20260701000015_cms_schedule_assets.sql` (exact path — do NOT use `supabase migration new`). Task 3 appends the scheduler RPCs to this same file.
```sql
-- CMS Phase 4 — Part C (schedule + assets). Sorts AFTER the codegen 000002.
-- Hand-authored: member RLS + indexes for content_schedule/asset, the
-- content.scheduled trigger, and (appended in Task 3) the crash-safe scheduler
-- RPCs. Tables + RLS-enable come from codegen; policies are authored here.

-- ── content_schedule: member RLS (SELECT/INSERT/UPDATE; cancelable) ──────────
alter table public.content_schedule enable row level security;
drop policy if exists content_schedule_select on public.content_schedule;
create policy content_schedule_select on public.content_schedule for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists content_schedule_insert on public.content_schedule;
create policy content_schedule_insert on public.content_schedule for insert
  with check (public.is_workspace_member(workspace_id));
drop policy if exists content_schedule_update on public.content_schedule;
create policy content_schedule_update on public.content_schedule for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
-- scheduler scan predicate: state='scheduled' and run_at <= now()
create index if not exists content_schedule_state_run_at_idx
  on public.content_schedule (state, run_at);

-- ── asset: member RLS (SELECT/INSERT/UPDATE; mutable) ────────────────────────
alter table public.asset enable row level security;
drop policy if exists asset_select on public.asset;
create policy asset_select on public.asset for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists asset_insert on public.asset;
create policy asset_insert on public.asset for insert
  with check (public.is_workspace_member(workspace_id));
drop policy if exists asset_update on public.asset;
create policy asset_update on public.asset for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create index if not exists asset_r2_key_idx on public.asset (r2_key);

-- ── content.scheduled trigger: AFTER INSERT on content_schedule ──────────────
-- GOTCHA: keep `set search_path = ''` (definer-audit gate). Payload is the
-- contract's verbatim shape; it carries no recipient_user_id, so emit_event's
-- notify guard records + webhooks but enqueues no notify job.
create or replace function public.content_schedule_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('content.scheduled', new.workspace_id,
    jsonb_build_object('id', new.content_item_id, 'schedule_id', new.id,
                       'action', new.action, 'run_at', new.run_at),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.content_schedule_emit_event() from public, anon, authenticated;
drop trigger if exists content_schedule_emit_event_tg on public.content_schedule;
create trigger content_schedule_emit_event_tg after insert on public.content_schedule
  for each row execute function public.content_schedule_emit_event();
```

- [ ] **Step 3: Create `000016` — curation/SEO uniques + RLS (published-only entries) (green)**

Create `supabase/migrations/20260701000016_cms_curation_seo.sql`:
```sql
-- CMS Phase 4 — Part C (curation + SEO). Sorts AFTER 000015.

-- ── content_collection: unique(workspace_id, key) + member RLS ───────────────
alter table public.content_collection
  add constraint content_collection_ws_key_uk unique (workspace_id, key);
alter table public.content_collection enable row level security;
drop policy if exists content_collection_select on public.content_collection;
create policy content_collection_select on public.content_collection for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists content_collection_insert on public.content_collection;
create policy content_collection_insert on public.content_collection for insert
  with check (public.is_workspace_member(workspace_id));
drop policy if exists content_collection_update on public.content_collection;
create policy content_collection_update on public.content_collection for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ── content_collection_entry: unique + member SELECT/UPDATE + PUBLISHED-ONLY INSERT
alter table public.content_collection_entry
  add constraint content_collection_entry_col_item_uk unique (collection_id, content_item_id);
alter table public.content_collection_entry enable row level security;
drop policy if exists content_collection_entry_select on public.content_collection_entry;
create policy content_collection_entry_select on public.content_collection_entry for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists content_collection_entry_update on public.content_collection_entry;
create policy content_collection_entry_update on public.content_collection_entry for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
-- CURATION IS PUBLISHED-ONLY: only a PUBLISHED item may enter a collection. This
-- is the authoritative gate (RLS with check), not a service-layer courtesy.
-- Do NOT add any other permissive INSERT policy here — permissive policies OR
-- together, so a second one would let drafts slip through.
drop policy if exists content_collection_entry_insert on public.content_collection_entry;
create policy content_collection_entry_insert on public.content_collection_entry for insert
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.content_item ci
       where ci.id = content_collection_entry.content_item_id
         and ci.workspace_id = content_collection_entry.workspace_id
         and ci.status = 'published'
    )
  );

-- ── content_seo: unique(content_item_id) + member RLS ────────────────────────
alter table public.content_seo
  add constraint content_seo_item_uk unique (content_item_id);
alter table public.content_seo enable row level security;
drop policy if exists content_seo_select on public.content_seo;
create policy content_seo_select on public.content_seo for select
  using (public.is_workspace_member(workspace_id));
drop policy if exists content_seo_insert on public.content_seo;
create policy content_seo_insert on public.content_seo for insert
  with check (public.is_workspace_member(workspace_id));
drop policy if exists content_seo_update on public.content_seo;
create policy content_seo_update on public.content_seo for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
```

- [ ] **Step 4: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `cms_schedule_assets_test.sql .. ok` (17 assertions); definer-audit exits 0 (`content_schedule_emit_event` pins `search_path`); `db diff` empty.

- [ ] **Step 5: Gate — published-only gate is the only entry INSERT policy**

```bash
grep -q "ci.status = 'published'" supabase/migrations/20260701000016_cms_curation_seo.sql && echo PUBLISHED_ONLY_OK
grep -c "create policy content_collection_entry_insert" supabase/migrations/20260701000016_cms_curation_seo.sql
```
Expected: prints `PUBLISHED_ONLY_OK`; the second grep prints `1` (exactly one INSERT policy on entries — no permissive sibling that would OR-in drafts).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000015_cms_schedule_assets.sql supabase/migrations/20260701000016_cms_curation_seo.sql supabase/tests/cms_schedule_assets_test.sql
git commit -m "feat(cms): schedule/asset/curation/seo RLS, uniques, indexes + content.scheduled trigger"
```

---

### Task 3: `content-scheduler` edge worker + `claim_due_schedules`/`run_scheduled_publish` + `schedule()` + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000015_cms_schedule_assets.sql` (append the scheduler RPCs)
- Create: `supabase/functions/content-scheduler/index.ts`
- Edit: `packages/domain/src/content.ts` (add `schedule()`)
- Edit: `supabase/tests/cms_schedule_assets_test.sql` (add the Task 3 block)

**Interfaces:**
- Consumes: `public.content_schedule`, Parts A/B's `public.content_item`/`public.content_publish_event`/`public.emit_event`.
- Produces: `public.claim_due_schedules(int)` (crash-safe claim, `scheduled → fired`) + `public.run_scheduled_publish(uuid)` (publish/unpublish the PINNED revision), the `content-scheduler` Deno worker (claim → run → mark `failed` on error), and `ContentService.schedule(...)`. Invariant: a due row publishes exactly once — a second claim after `fired` claims nothing, so no second `content_publish_event`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/cms_schedule_assets_test.sql`: change `select plan(17);` to `select plan(24);`, and insert this block immediately BEFORE the final `select * from finish();`. It publishes the DRAFT item D1 pinned to its revision R2 (a real draft→published transition), then a scheduled unpublish (→ archived):
```sql
-- ── Task 3: crash-safe claim + run_scheduled_publish (exactly-once) ──────────
-- a DUE schedule to publish D1 at the PINNED revision R2 (scheduled_by = A)
insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e2-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000002-0000-0000-0000-000000000000','publish','000000a2-0000-0000-0000-000000000000',
   now() - interval '1 minute','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
-- claim (flips scheduled->fired; the future row 000000e1 is NOT claimed) then run.
-- `select count(*) from f()` is valid TOP-LEVEL SQL and fully consumes the
-- setof-returning claim (a bare `perform` is PL/pgSQL-only and errors here).
select count(*) from public.claim_due_schedules(50);
select public.run_scheduled_publish('000000e2-0000-0000-0000-000000000000');
select is((select count(*)::int from public.content_publish_event
           where content_item_id='00000002-0000-0000-0000-000000000000'
             and revision_id='000000a2-0000-0000-0000-000000000000' and action='publish'),
          1, 'a due schedule appends exactly one content_publish_event for the PINNED revision');
select is((select status from public.content_item where id='00000002-0000-0000-0000-000000000000'),
          'published', 'the scheduled publish advances content_item.status to published');
-- second pass: nothing left to claim (row is fired) -> no second publish event
select is((select count(*)::int from public.claim_due_schedules(50)), 0,
          'a second claim finds nothing due (the row is already fired)');
select is((select count(*)::int from public.content_publish_event
           where content_item_id='00000002-0000-0000-0000-000000000000'
             and revision_id='000000a2-0000-0000-0000-000000000000' and action='publish'),
          1, 'a re-run claims nothing (fired) so the publish is exactly-once');
-- Part B's content_publish_event AFTER INSERT trigger owns emission; run_scheduled_publish
-- does NOT emit, so there is EXACTLY ONE content.published event (no double-emit).
select is((select count(*)::int from movp_internal.movp_events
           where type='content.published' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'exactly one content.published event (Part B''s trigger emits it; run_scheduled_publish does not)');
-- scheduled UNPUBLISH of the now-published D1 -> status archived (the item status enum has NO
-- 'unpublished' value) + exactly one content.unpublished event (again via Part B's trigger).
insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e3-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000002-0000-0000-0000-000000000000','unpublish','000000a2-0000-0000-0000-000000000000',
   now() - interval '1 minute','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
select count(*) from public.claim_due_schedules(50);
select public.run_scheduled_publish('000000e3-0000-0000-0000-000000000000');
select is((select status from public.content_item where id='00000002-0000-0000-0000-000000000000'),
          'archived', 'a scheduled unpublish sets content_item.status to archived (not "unpublished")');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.unpublished' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'a scheduled unpublish emits exactly one content.unpublished event');
```
NOTE: `select count(*) from public.claim_due_schedules(50)` runs the claim's UPDATE and consumes the result at top level (a bare `perform` is PL/pgSQL-only). The second-claim assertion (`= 0`) makes the "claims nothing" step an explicit assertion rather than a side effect, so `plan(24)` counts it (Task 3 adds 7 assertions: 17 → 24 — the four exactly-once checks plus the one-`content.published`, the scheduled-unpublish `archived`, and the one-`content.unpublished` checks).

Run: `supabase test db`
Expected: FAIL — `function public.claim_due_schedules(int) does not exist`, so the file errors at the first claim. (The first 17 assertions would otherwise pass.)

- [ ] **Step 2: Append the scheduler RPCs to `000015` (green)**

Append to `supabase/migrations/20260701000015_cms_schedule_assets.sql`:
```sql
-- ── claim_due_schedules: crash-safe claim of due rows (scheduled -> fired) ────
-- The committed claim pattern: SKIP LOCKED so concurrent workers never claim the
-- same row; flipping to 'fired' inside the claim makes re-runs exactly-once.
create or replace function public.claim_due_schedules(lim int default 50)
returns setof public.content_schedule
language sql security definer set search_path = '' as $$
  update public.content_schedule
     set state = 'fired'
   where id in (
     select id from public.content_schedule
      where state = 'scheduled' and run_at <= now()
      order by run_at
      for update skip locked
      limit lim
   )
  returning *;
$$;
revoke all on function public.claim_due_schedules(int) from public, anon, authenticated;

-- ── run_scheduled_publish: publish/unpublish the PINNED revision ─────────────
-- Unified with Part B's publish model: it does NOT re-emit or re-implement the
-- event. It only (1) inserts a content_publish_event using Part B's EXACT column
-- set — (workspace_id, content_item_id, action, revision_id, content_hash,
-- actor_id) — for the PINNED s.revision_id (never content_item.current_revision_id),
-- and (2) advances the item pointers/status. Part B's AFTER INSERT trigger on
-- content_publish_event fires content.published / content.unpublished + the signed
-- webhook, so emitting here would DOUBLE-emit — we intentionally do not.
--   content_hash: the pinned revision's hash (content_publish_event.content_hash is NOT NULL).
--   actor_id:     s.scheduled_by, captured at schedule time (this fn is SECURITY DEFINER,
--                 so auth.uid() is null; the definer also bypasses the publish-capability
--                 RLS — a system action publishing on behalf of the scheduler).
--   unpublish status is 'archived' (the item status enum has NO 'unpublished' value).
create or replace function public.run_scheduled_publish(schedule_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.content_schedule;
  v_hash text;
begin
  select * into s from public.content_schedule where id = schedule_id for update;
  if not found or s.state <> 'fired' then return; end if;  -- only run a claimed row

  select cr.content_hash into v_hash from public.content_revision cr where cr.id = s.revision_id;
  if v_hash is null then raise exception 'content_revision_not_found' using errcode = 'P0002'; end if;

  insert into public.content_publish_event
    (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (s.workspace_id, s.content_item_id, s.action, s.revision_id, v_hash, s.scheduled_by);

  if s.action = 'publish' then
    update public.content_item
       set status = 'published', published_revision_id = s.revision_id
     where id = s.content_item_id;
  else
    update public.content_item
       set status = 'archived', published_revision_id = null
     where id = s.content_item_id;
  end if;
  -- NO emit_event here — Part B's content_publish_event AFTER INSERT trigger owns emission.
end; $$;
revoke all on function public.run_scheduled_publish(uuid) from public, anon, authenticated;
```

- [ ] **Step 3: Create the `content-scheduler` edge worker**

Create `supabase/functions/content-scheduler/index.ts` (mirror `supabase/functions/flows/index.ts`: `Deno.serve` + service-role client):
```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async () => {
  // GOTCHA: Deno.env (Vault-backed), never a committed literal, never process.env.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Claim due rows crash-safely (scheduled -> fired under SKIP LOCKED).
  const { data: claimed, error } = await supabase.rpc('claim_due_schedules', { lim: 50 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let published = 0, failed = 0;
  for (const row of (claimed ?? []) as Array<{ id: string }>) {
    const { error: runErr } = await supabase.rpc('run_scheduled_publish', { schedule_id: row.id });
    if (runErr) {
      // On error, park the row as failed so it is not silently lost.
      await supabase.from('content_schedule').update({ state: 'failed' }).eq('id', row.id);
      failed++;
    } else {
      published++;
    }
  }
  return new Response(JSON.stringify({ claimed: claimed?.length ?? 0, published, failed }), {
    headers: { 'content-type': 'application/json' },
  });
});

// ── DEPLOY-TIME DRIVER (documentation only — NOT committed) ──────────────────
// A pg_cron job or Cloudflare Cron invokes this worker on an interval, with the
// invocation secret sourced from Vault (never a literal), e.g.:
//   select cron.schedule('content-scheduler', '*/5 * * * *',
//     $cron$ select net.http_post(
//       url := '<project>/functions/v1/content-scheduler',
//       headers := jsonb_build_object('Authorization','Bearer '||vault_secret)) $cron$);
// Applied out-of-band so `supabase db diff` stays empty; the e2e invokes the
// worker directly.
```

- [ ] **Step 4: Add `ContentService.schedule()`**

In `packages/domain/src/content.ts`, add the method (mirror the existing method style; resolve `ctx.db` at call time — never a captured client / `process.env`):
```ts
async schedule(i: { itemId: string; action: 'publish' | 'unpublish'; revisionId: string; runAt: string }): Promise<ContentScheduleRow> {
  // workspace_id is required by RLS; derive it from the item.
  const { data: item, error: e1 } = await ctx.db
    .from('content_item').select('workspace_id').eq('id', i.itemId).single();
  if (e1) fail('schedule', e1.code);
  if (!item) throw new Error('domain.content.schedule: item_not_found');
  const { data, error } = await ctx.db.from('content_schedule').insert({
    workspace_id: item.workspace_id,
    content_item_id: i.itemId,
    action: i.action,
    revision_id: i.revisionId,   // PINNED at schedule time — a later edit cannot change it
    run_at: i.runAt,
    scheduled_by: ctx.userId,    // the caller who scheduled it -> run_scheduled_publish reads it for content_publish_event.actor_id
  }).select().single();
  if (error) fail('schedule', error.code);
  return data as ContentScheduleRow;   // the content.scheduled trigger has fired
}
```

- [ ] **Step 5: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `cms_schedule_assets_test.sql .. ok` (24 assertions); definer-audit exits 0 (`claim_due_schedules` + `run_scheduled_publish` both pin `search_path`); `db diff` empty (the deploy-time driver is not committed).

- [ ] **Step 6: Gate — pinned-revision publish, crash-safe claim, driver not committed**

```bash
grep -q "for update skip locked" supabase/migrations/20260701000015_cms_schedule_assets.sql && echo SKIP_LOCKED_OK
grep -q "published_revision_id = s.revision_id" supabase/migrations/20260701000015_cms_schedule_assets.sql && echo PINNED_OK
grep -c "^select cron.schedule" supabase/migrations/20260701000015_cms_schedule_assets.sql
```
Expected: prints `SKIP_LOCKED_OK` and `PINNED_OK` (publish advances to the PINNED `s.revision_id`, not `current_revision_id`); the third grep prints `0` (no committed cron statement).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260701000015_cms_schedule_assets.sql supabase/functions/content-scheduler/index.ts packages/domain/src/content.ts supabase/tests/cms_schedule_assets_test.sql
git commit -m "feat(cms): content-scheduler worker + crash-safe claim/run + schedule()"
```

---

### Task 4: `content-assets` presigned edge fn + `issueAssetUpload`/`finalizeAsset` + bounds Vitest

**Files:**
- Create: `packages/domain/src/asset-bounds.ts` (pure `validateAssetRequest` + `verifyFinalizePayload`)
- Create: `packages/domain/test/asset-bounds.test.ts` (Vitest)
- Create: `supabase/functions/content-assets/index.ts` (Deno edge fn: presign + finalize)
- Edit: `packages/domain/src/content.ts` (add `issueAssetUpload`/`finalizeAsset`)

**Interfaces:**
- Consumes: `npm:aws4fetch` (SigV4), R2 S3 creds from `Deno.env` (Vault), the `content-assets` edge fn from the domain.
- Produces: bounded (`ASSET_ALLOWED_MIME`, `ASSET_MAX_BYTES`) presigned R2 PUT; `finalizeAsset` records SERVER-verified size/checksum. Invariant: the server NEVER buffers the file (it only validates the declared mime/size and returns a presigned URL); an oversized or disallowed-mime request is rejected; the recorded `size_bytes`/`checksum` come from the R2 HEAD, not the client.

- [ ] **Step 1: Write the failing Vitest (red)**

Create `packages/domain/test/asset-bounds.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateAssetRequest, verifyFinalizePayload, ASSET_MAX_BYTES } from '../src/asset-bounds';

describe('validateAssetRequest (bound-before-buffer: reject before any presign)', () => {
  it('accepts an allowed mime within the size bound', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 1024 })).toEqual({ ok: true });
  });
  it('rejects a disallowed mime', () => {
    expect(validateAssetRequest({ mime: 'application/x-msdownload', sizeBytes: 1024 }))
      .toEqual({ ok: false, error: 'disallowed_mime' });
  });
  it('rejects an oversized upload', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: ASSET_MAX_BYTES + 1 }))
      .toEqual({ ok: false, error: 'size_out_of_bounds' });
  });
  it('rejects non-positive / non-integer sizes', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 0 }).ok).toBe(false);
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 1.5 }).ok).toBe(false);
  });
});

describe('verifyFinalizePayload (server-authoritative, ignores client claims)', () => {
  it('returns the R2-HEAD size/checksum, not the client-declared values', () => {
    const out = verifyFinalizePayload({
      headContentLength: 2048, headEtag: '"abc123"',
      declaredSizeBytes: 999999, declaredChecksum: 'client-lie',
    });
    expect(out).toEqual({ sizeBytes: 2048, checksum: 'abc123' });
  });
});
```

Run: `pnpm --filter @movp/domain test asset-bounds`
Expected: FAIL — `Cannot find module '../src/asset-bounds'` (the module does not exist yet).

- [ ] **Step 2: Create the pure bounds module (green)**

Create `packages/domain/src/asset-bounds.ts`:
```ts
// The size/mime bounds are the "bound-before-buffer" gate: the server validates
// the DECLARED mime+size and only then presigns — it never reads file bytes.
export const ASSET_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB
export const ASSET_ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
]);
export type AssetBoundError = 'disallowed_mime' | 'size_out_of_bounds';

export function validateAssetRequest(i: { mime: string; sizeBytes: number }):
  { ok: true } | { ok: false; error: AssetBoundError } {
  if (!ASSET_ALLOWED_MIME.has(i.mime)) return { ok: false, error: 'disallowed_mime' };
  if (!Number.isInteger(i.sizeBytes) || i.sizeBytes <= 0 || i.sizeBytes > ASSET_MAX_BYTES) {
    return { ok: false, error: 'size_out_of_bounds' };
  }
  return { ok: true };
}

// finalize trusts ONLY the R2 HEAD: Content-Length is authoritative size; the
// ETag (quotes stripped) is the checksum. Client-declared values are discarded.
export function verifyFinalizePayload(i: {
  headContentLength: number; headEtag: string;
  declaredSizeBytes: number; declaredChecksum: string; // accepted for logging/parity, NOT trusted
}): { sizeBytes: number; checksum: string } {
  return { sizeBytes: i.headContentLength, checksum: i.headEtag.replace(/"/g, '') };
}
```

- [ ] **Step 3: Create the `content-assets` edge fn (presign + finalize)**

Create `supabase/functions/content-assets/index.ts`. It is the AUTHORITATIVE bound (a member could call it directly), so it re-validates. R2 creds live only here (`Deno.env`/Vault), never in the domain (workerd) bundle.
```ts
import { AwsClient } from 'npm:aws4fetch';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Duplicated from packages/domain/src/asset-bounds.ts on purpose: this edge fn
// and the domain are different runtimes/bundles. Keep the two in lock-step.
const ASSET_MAX_BYTES = 25 * 1024 * 1024;
const ASSET_ALLOWED_MIME = new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf']);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  // member auth (mirror flows' resolvePrincipal); reject non-members up front.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { error: 'unauthorized' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } });
  const r2 = new AwsClient({
    accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,        // Vault — never committed
    secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
    service: 's3', region: 'auto',
  });
  const account = Deno.env.get('R2_ACCOUNT_ID')!;
  const bucket = Deno.env.get('R2_BUCKET')!;
  const body = await req.json();

  if (body.action === 'issue') {
    const { workspaceId, filename, mime, sizeBytes } = body;
    // membership + bounds (authoritative). Use the USER-BOUND client: is_workspace_member
    // reads (select auth.uid()), which is the caller under `supabase` but NULL under the
    // service-role `admin` client — so `admin.rpc('is_workspace_member')` would always deny.
    const { data: member } = await supabase.rpc('is_workspace_member', { ws: workspaceId });
    if (!member) return json(403, { error: 'not_a_member' });
    if (!ASSET_ALLOWED_MIME.has(mime)) return json(400, { error: 'disallowed_mime' });
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > ASSET_MAX_BYTES)
      return json(400, { error: 'size_out_of_bounds' });

    const assetId = crypto.randomUUID();
    const r2Key = `${workspaceId}/${assetId}`;
    // persist a pending asset row (declared size; finalize overwrites with verified).
    // CHECK the write — else we would presign an upload URL for a row that never landed.
    const { error: insErr } = await admin.from('asset').insert({
      id: assetId, workspace_id: workspaceId, filename, mime, r2_key: r2Key,
      size_bytes: sizeBytes, uploaded_by: user.id,
    });
    if (insErr) return json(500, { error: 'asset_persist_failed' });
    // presign an S3 PUT — the client PUTs bytes directly to R2; server buffers nothing.
    const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${r2Key}`);
    url.searchParams.set('X-Amz-Expires', '600');
    const signed = await r2.sign(url.toString(),
      { method: 'PUT', headers: { 'content-type': mime }, aws: { signQuery: true } });
    return json(200, { uploadUrl: signed.url, r2Key, assetId });
  }

  if (body.action === 'finalize') {
    const { assetId, width, height } = body;
    // AUTHZ-BEFORE-READ: read the asset through the USER-BOUND client so RLS decides
    // visibility. A non-member (or a foreign-workspace asset) returns NO row → the SAME
    // bounded 404 as a non-existent asset: no existence oracle, and no R2 HEAD is performed.
    const { data: asset, error: readErr } = await supabase
      .from('asset').select('workspace_id, r2_key').eq('id', assetId).maybeSingle();
    if (readErr) return json(500, { error: 'asset_read_failed' });
    if (!asset) return json(404, { error: 'asset_not_found' });
    // re-HEAD R2 for SERVER-verified size/checksum (client values are ignored)
    const head = await r2.fetch(`https://${account}.r2.cloudflarestorage.com/${bucket}/${asset.r2_key}`, { method: 'HEAD' });
    if (!head.ok) return json(409, { error: 'object_not_uploaded' });
    const sizeBytes = Number(head.headers.get('content-length') ?? '0');
    const checksum = (head.headers.get('etag') ?? '').replace(/"/g, '');
    // update through the user-bound client (RLS) and CHECK the write — else finalize could
    // return 200 with a null/failed row.
    const { data: row, error: updErr } = await supabase.from('asset')
      .update({ size_bytes: sizeBytes, checksum, width: width ?? null, height: height ?? null })
      .eq('id', assetId).select().single();
    if (updErr || !row) return json(500, { error: 'asset_finalize_failed' });
    return json(200, row);
  }

  return json(400, { error: 'unknown_action' });
});
```
GOTCHA: never log `body` or R2 response bodies — they can carry filenames/paths; log the action + reason only.

- [ ] **Step 4a: Extend `DomainCtx` with the asset-upload dependencies**

The asset methods forward the caller's JWT to the `content-assets` edge fn and need its URL, but the committed `DomainCtx` is only `{ db, userId }`. In `packages/domain/src/types.ts`, extend it (both OPTIONAL so no existing `createDomain` caller breaks; the asset methods fail loudly when they are absent — the workerd call-time-resolution rule):
```ts
export interface DomainCtx {
  db: SupabaseClient
  userId: string
  accessToken?: string   // the caller's JWT, forwarded to the content-assets edge fn (asset upload only)
  assetsFnUrl?: string   // the content-assets edge fn URL (from readServerEnv; asset upload only)
}
```
Then the surfaces that build the ctx (GraphQL/MCP/CLI `domainFrom(ctx)` in Part D) MUST supply them for the asset ops: `accessToken` from the request `Authorization` header, `assetsFnUrl` from `readServerEnv()` — never `process.env`, resolved per request. Every surface + domain test that exercises `issueAssetUpload`/`finalizeAsset` passes stub values (`accessToken: 'test'`, `assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets'`). Gate: `pnpm --filter @movp/domain typecheck` is clean.

- [ ] **Step 4b: Add `issueAssetUpload`/`finalizeAsset` to the domain**

In `packages/domain/src/content.ts` (fast-fail bounds locally, then delegate to the edge fn; resolve the edge-fn URL + caller token from `ctx` at call time — never `process.env`, never hold R2 creds here):
```ts
import { validateAssetRequest } from './asset-bounds';

async issueAssetUpload(i: { workspaceId: string; filename: string; mime: string; sizeBytes: number }) {
  if (!ctx.assetsFnUrl || !ctx.accessToken) fail('issueAssetUpload', 'asset_upload_not_configured'); // ctx must carry both
  const v = validateAssetRequest({ mime: i.mime, sizeBytes: i.sizeBytes }); // advisory fast-fail; edge fn is authoritative
  if (!v.ok) fail('issueAssetUpload', v.error);   // stable `domain.content.issueAssetUpload failed [<code>]`
  const res = await fetch(`${ctx.assetsFnUrl}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'issue', ...i }),
  });
  // Route the edge fn's bounded error code (e.g. 'disallowed_mime'/'not_a_member') through
  // the same fail() contract; never surface filename/body/R2 data.
  if (!res.ok) { const b = (await res.json().catch(() => ({}))) as { error?: string }; fail('issueAssetUpload', b.error ?? String(res.status)); }
  return await res.json() as { uploadUrl: string; r2Key: string; assetId: string };
}

async finalizeAsset(i: { assetId: string; checksum: string; sizeBytes: number; width?: number; height?: number }): Promise<AssetRow> {
  if (!ctx.assetsFnUrl || !ctx.accessToken) fail('finalizeAsset', 'asset_upload_not_configured'); // ctx must carry both
  // The edge fn re-HEADs R2 and writes SERVER-verified size/checksum; the
  // client-declared checksum/sizeBytes are sent only for parity, not trusted.
  const res = await fetch(`${ctx.assetsFnUrl}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'finalize', ...i }),
  });
  if (!res.ok) { const b = (await res.json().catch(() => ({}))) as { error?: string }; fail('finalizeAsset', b.error ?? String(res.status)); }
  return await res.json() as AssetRow;
}
```

- [ ] **Step 5: Vitest + build gate**

```bash
pnpm --filter @movp/domain test asset-bounds && pnpm --filter @movp/frontend-astro build
```
Expected: `asset-bounds.test.ts` passes (6 assertions across the two describes); the frontend build succeeds (the new domain methods typecheck against the generated `AssetRow`).

- [ ] **Step 6: Gate — presign is query-signed and creds never leave the edge fn**

```bash
grep -q "signQuery: true" supabase/functions/content-assets/index.ts && echo PRESIGN_OK
grep -rE "R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY" packages/ | grep -v node_modules || echo NO_R2_CREDS_IN_DOMAIN
```
Expected: prints `PRESIGN_OK` (a presigned URL, so the server never receives the bytes); the grep prints `NO_R2_CREDS_IN_DOMAIN` (R2 creds appear only under `supabase/functions/`, never in the workerd-bundled `packages/`).

- [ ] **Step 7: Negative asset-authorization check (no R2 needed — denials happen BEFORE any R2 call)**

Serve the edge fn (`supabase functions serve content-assets`), seed workspace W1 with owner A + a pending asset (owner issue), and a second member B who is NOT in W1. Then, as B's JWT, assert the authorization boundary — both denials fire before the presign / R2 HEAD, so no R2 access or DB write occurs:
```bash
# B is not a member of W1 → issue for W1 is denied (403), before any presign
ISSUE="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTIONS_URL/content-assets" \
  -H "Authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -d "{\"action\":\"issue\",\"workspaceId\":\"$W1\",\"filename\":\"x.png\",\"mime\":\"image/png\",\"sizeBytes\":10}")"
[ "$ISSUE" = "403" ] || { echo "non-member issue not denied (got $ISSUE)"; exit 1; }
# B finalizing W1's asset returns the SAME bounded 404 as a non-existent asset (RLS read → null;
# no existence oracle, no R2 HEAD, no DB update — the row's size_bytes stays the declared value)
BEFORE="$(psql "$DB_URL" -tAc "select size_bytes from public.asset where id='$OWNER_ASSET_ID';" | tr -d '[:space:]')"
FIN="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTIONS_URL/content-assets" \
  -H "Authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -d "{\"action\":\"finalize\",\"assetId\":\"$OWNER_ASSET_ID\"}")"
[ "$FIN" = "404" ] || { echo "non-member finalize not bounded-denied (got $FIN)"; exit 1; }
AFTER="$(psql "$DB_URL" -tAc "select size_bytes from public.asset where id='$OWNER_ASSET_ID';" | tr -d '[:space:]')"
[ "$BEFORE" = "$AFTER" ] || { echo "unauthorized finalize mutated the asset row"; exit 1; }
echo "ASSET_AUTHZ_OK"
```
Expected: `ASSET_AUTHZ_OK` — a non-member cannot issue for another workspace or finalize its assets, and the unauthorized finalize performs no update. (This may also be folded into the Part D `[content]` slice; either location is acceptable as long as it runs.)

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/asset-bounds.ts packages/domain/test/asset-bounds.test.ts supabase/functions/content-assets/index.ts packages/domain/src/content.ts
git commit -m "feat(cms): presigned R2 asset upload (bounded mime/size) + finalize (server-verified)"
```

---

### Task 5: Curation ops + `runSeoAudit` (+ pure `auditSeo`) + graph-edge link ops + integration test

**Files:**
- Create: `packages/domain/src/seo-audit.ts` (pure `auditSeo`)
- Create: `packages/domain/test/seo-audit.test.ts` (Vitest)
- Edit: `packages/domain/src/content.ts` (`createCollection`/`addToCollection`/`reorderCollection`/`runSeoAudit`/`linkAsset`/`linkItem`/`linkEditorialTask`)
- Create: `packages/domain/test/content_cms.integration.test.ts` (clone the collab harness)

**Interfaces:**
- Consumes: `content_collection`/`content_collection_entry`/`content_seo` (+ RLS), `content_item`/`content_revision`, `makeGraphService` + the `edges` table.
- Produces: the curation/SEO/edge domain ops. Invariant: `addToCollection` succeeds only for a PUBLISHED item (RLS `42501` otherwise); `runSeoAudit` upserts one `content_seo` row (score + `[{rule,pass}]`), emits nothing; edge links mirror `makeGraphService.link` (`content_item —references→ asset|content_item`, `content_item —editorial_task→ task`).

- [ ] **Step 1: Write the failing SEO Vitest (red)**

Create `packages/domain/test/seo-audit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { auditSeo } from '../src/seo-audit';

describe('auditSeo (advisory rule set -> score + checklist)', () => {
  it('passes every rule for a well-formed item', () => {
    const r = auditSeo({
      data: { title: 'A Perfectly Reasonable Title', answer: 'Yes, here is the direct answer.',
              faqs: [{ q: 'Q?', a: 'A.' }] },
      meta: { description: 'x'.repeat(120), canonical: 'https://example.com/a' },
      jsonld: { '@context': 'https://schema.org', '@type': 'Article' },
      referencedAssets: [{ alt_text: 'a chart' }],
    });
    expect(r.score).toBe(100);
    expect(r.checklist.every((c) => c.pass)).toBe(true);
  });
  it('fails checks and lowers the score for a bare item', () => {
    const r = auditSeo({ data: {}, meta: null, jsonld: null, referencedAssets: [{ alt_text: null }] });
    expect(r.score).toBeLessThan(100);
    expect(r.checklist.find((c) => c.rule === 'canonical_present')?.pass).toBe(false);
    expect(r.checklist.find((c) => c.rule === 'alt_text_coverage')?.pass).toBe(false);
  });
});
```

Run: `pnpm --filter @movp/domain test seo-audit`
Expected: FAIL — `Cannot find module '../src/seo-audit'`.

- [ ] **Step 2: Create the pure `auditSeo` (green)**

Create `packages/domain/src/seo-audit.ts`:
```ts
export interface SeoInput {
  data: Record<string, unknown>;              // the item's current revision data
  meta: Record<string, unknown> | null;       // content_seo.meta
  jsonld: unknown | null;                      // content_seo.jsonld
  referencedAssets: { alt_text: string | null }[]; // assets linked via edges
}
export interface SeoCheck { rule: string; pass: boolean; }
export interface SeoResult { score: number; checklist: SeoCheck[]; }

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isJsonLd = (j: unknown): boolean =>
  !!j && typeof j === 'object' && '@context' in (j as object) && '@type' in (j as object);

export function auditSeo(i: SeoInput): SeoResult {
  const title = str(i.data?.['title']) || str(i.meta?.['title']);
  const desc = str(i.meta?.['description']);
  const faqs = Array.isArray(i.data?.['faqs']) ? (i.data['faqs'] as unknown[]) : [];
  const checklist: SeoCheck[] = [
    { rule: 'title_length', pass: title.length >= 10 && title.length <= 60 },
    { rule: 'meta_description_length', pass: desc.length >= 50 && desc.length <= 160 },
    { rule: 'canonical_present', pass: str(i.meta?.['canonical']).length > 0 },
    { rule: 'alt_text_coverage', pass: i.referencedAssets.every((a) => !!a.alt_text && a.alt_text.trim().length > 0) },
    { rule: 'jsonld_valid', pass: isJsonLd(i.jsonld) },
    { rule: 'aeo_answer_present', pass: str(i.data?.['answer']).trim().length > 0 },
    { rule: 'faq_complete', pass: faqs.length > 0 && faqs.every((f: any) => str(f?.q) && str(f?.a)) },
  ];
  const passed = checklist.filter((c) => c.pass).length;
  return { score: Math.round((passed / checklist.length) * 100), checklist };
}
```

- [ ] **Step 3: Add the curation / SEO / edge domain ops**

In `packages/domain/src/content.ts` (mirror the existing method style; resolve `ctx.db` at call time; reuse `makeGraphService.link` for edges):
```ts
import { auditSeo } from './seo-audit';

async createCollection(i: { workspaceId: string; key: string; label: string; description?: string }): Promise<ContentCollectionRow> {
  const { data, error } = await ctx.db.from('content_collection')
    .insert({ workspace_id: i.workspaceId, key: i.key, label: i.label, description: i.description ?? null })
    .select().single();
  if (error) fail('createCollection', error.code);
  return data as ContentCollectionRow;
}

async addToCollection(i: { collectionId: string; itemId: string; position?: number }): Promise<void> {
  const { data: col, error: e1 } = await ctx.db.from('content_collection')
    .select('workspace_id').eq('id', i.collectionId).single();
  if (e1) fail('addToCollection', e1.code);
  if (!col) throw new Error('domain.content.addToCollection: collection_not_found');
  // RLS with check enforces published-only — a draft insert raises 42501 here.
  const { error } = await ctx.db.from('content_collection_entry').insert({
    workspace_id: col.workspace_id, collection_id: i.collectionId,
    content_item_id: i.itemId, position: i.position ?? 0,
  });
  if (error) fail('addToCollection', error.code); // 42501 => not published
}

async reorderCollection(i: { collectionId: string; orderedItemIds: string[] }): Promise<void> {
  // position = index in the supplied order; UPDATE only (member RLS on update). Run
  // sequentially and CHECK each result — an unchecked Promise.all swallows a per-row
  // RLS/constraint failure and leaves the collection half-reordered while resolving.
  // (For full atomicity a `reorder_collection` SQL RPC is the follow-up; this at least
  // rejects on the first failure so the caller learns the reorder did not fully apply.)
  for (let position = 0; position < i.orderedItemIds.length; position++) {
    const { error } = await ctx.db.from('content_collection_entry').update({ position })
      .eq('collection_id', i.collectionId).eq('content_item_id', i.orderedItemIds[position]);
    if (error) fail('reorderCollection', error.code);
  }
}

async runSeoAudit(i: { itemId: string }): Promise<ContentSeoRow> {
  const { data: item } = await ctx.db.from('content_item')
    .select('workspace_id, current_revision_id').eq('id', i.itemId).single();
  if (!item) throw new Error('domain.content.runSeoAudit: item_not_found');
  const { data: rev } = await ctx.db.from('content_revision')
    .select('data').eq('id', item.current_revision_id).single();
  const { data: seoRow } = await ctx.db.from('content_seo')
    .select('meta, jsonld').eq('content_item_id', i.itemId).maybeSingle();
  // referenced assets = edges content_item -references-> asset, joined to alt_text
  const { data: assetEdges } = await ctx.db.from('edges')
    .select('dst_id').eq('src_type', 'content_item').eq('src_id', i.itemId)
    .eq('rel', 'references').eq('dst_type', 'asset');
  const assetIds = (assetEdges ?? []).map((e) => e.dst_id);
  const { data: assets } = assetIds.length
    ? await ctx.db.from('asset').select('alt_text').in('id', assetIds)
    : { data: [] as { alt_text: string | null }[] };
  const result = auditSeo({
    data: (rev?.data ?? {}) as Record<string, unknown>,
    meta: (seoRow?.meta ?? null) as Record<string, unknown> | null,
    jsonld: seoRow?.jsonld ?? null,
    referencedAssets: assets ?? [],
  });
  const { data, error } = await ctx.db.from('content_seo').upsert(
    { workspace_id: item.workspace_id, content_item_id: i.itemId, score: result.score, checklist: result.checklist },
    { onConflict: 'content_item_id' }).select().single();   // advisory — no event
  if (error) fail('runSeoAudit', error.code);
  return data as ContentSeoRow;
}

// ── graph edges ──────────────────────────────────────────────────────────────
// `content` and `graph` are SIBLINGS in the domain factory — there is NO `this.graph`.
// Instantiate a local graph service (add `import { makeGraphService } from './graph.ts'`
// at the top of content.ts and `const graph = makeGraphService(ctx)` near the other
// helpers). `graph.link` takes CAMELCASE args and needs the workspace, so resolve the
// item's workspace via the `itemWorkspace(itemId)` helper (add it alongside 02a's
// `itemTypeId`: `select workspace_id from content_item where id = itemId` under RLS).
async linkAsset(i: { itemId: string; assetId: string }): Promise<void> {
  const ws = await itemWorkspace(i.itemId);
  await graph.link({ workspaceId: ws, srcType: 'content_item', srcId: i.itemId, rel: 'references', dstType: 'asset', dstId: i.assetId });
},
async linkItem(i: { itemId: string; targetItemId: string }): Promise<void> {
  const ws = await itemWorkspace(i.itemId);
  await graph.link({ workspaceId: ws, srcType: 'content_item', srcId: i.itemId, rel: 'references', dstType: 'content_item', dstId: i.targetItemId });
},
async linkEditorialTask(i: { itemId: string; taskId: string }): Promise<void> {
  // loose coupling to Task — an edge, no FK.
  const ws = await itemWorkspace(i.itemId);
  await graph.link({ workspaceId: ws, srcType: 'content_item', srcId: i.itemId, rel: 'editorial_task', dstType: 'task', dstId: i.taskId });
},
```
`graph.link` internally does `ctx.db.from('edges').upsert({ workspace_id, src_type, src_id, rel, dst_type, dst_id })` (camelCase→snake mapping) — do NOT re-implement the edges write here.

- [ ] **Step 4: Write the domain integration test (clone the collab harness)**

Create `packages/domain/test/content_cms.integration.test.ts` by cloning the Part A/B collaboration integration harness (workspace + member + authed `ctx.db` setup against the local stack). Add these scenarios:
```ts
// (harness boilerplate cloned from the collab integration test)
it('schedule() inserts a pinned row and emits content.scheduled', async () => {
  const row = await content.schedule({ itemId: publishedItemId, action: 'publish', revisionId: pinnedRevisionId, runAt: future });
  expect(row.revision_id).toBe(pinnedRevisionId);
  const ev = await admin.from('movp_events').select('*').eq('type', 'content.scheduled').eq('payload->>schedule_id', row.id);
  expect(ev.data?.length).toBe(1);
});
it('addToCollection is published-only (draft rejected by RLS)', async () => {
  const col = await content.createCollection({ workspaceId, key: 'featured', label: 'Featured' });
  await expect(content.addToCollection({ collectionId: col.id, itemId: publishedItemId })).resolves.toBeUndefined();
  await expect(content.addToCollection({ collectionId: col.id, itemId: draftItemId })).rejects.toThrow(); // 42501
});
it('runSeoAudit upserts one advisory content_seo row', async () => {
  const seo = await content.runSeoAudit({ itemId: publishedItemId });
  expect(typeof seo.score).toBe('number');
  expect(Array.isArray(seo.checklist)).toBe(true);
});
it('link ops write graph edges', async () => {
  await content.linkAsset({ itemId: publishedItemId, assetId });
  await content.linkEditorialTask({ itemId: publishedItemId, taskId });
  const edges = await admin.from('edges').select('rel, dst_type').eq('src_id', publishedItemId);
  expect(edges.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ rel: 'references', dst_type: 'asset' }),
    expect.objectContaining({ rel: 'editorial_task', dst_type: 'task' }),
  ]));
});
```

- [ ] **Step 5: Vitest + build gate**

```bash
supabase db reset && pnpm --filter @movp/domain test && pnpm --filter @movp/frontend-astro build
```
Expected: `seo-audit.test.ts` passes; `content_cms.integration.test.ts` passes against the freshly-reset local stack (schedule/curation/seo/edges); the frontend build succeeds.

- [ ] **Step 6: Gate — published-only surfaced, SEO advisory (no event)**

```bash
grep -q "rel: 'editorial_task'" packages/domain/src/content.ts && echo EDGE_OK
grep -c "emit_event\|emitEvent" packages/domain/src/seo-audit.ts
```
Expected: prints `EDGE_OK`; the second grep prints `0` (SEO is advisory — the audit emits no event).

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/seo-audit.ts packages/domain/test/seo-audit.test.ts packages/domain/src/content.ts packages/domain/test/content_cms.integration.test.ts
git commit -m "feat(cms): curation ops + advisory SEO audit + graph-edge links"
```

---

## Self-Review

- **Spec coverage (Part C scope):** five `internal:true`/`workspaceScoped:true` collections + codegen regen of `000002` (Task 1); `000015`/`000016` uniques/indexes/RLS with **published-only** curation + the `content.scheduled` trigger (Task 2); the `content-scheduler` worker + crash-safe `claim_due_schedules`/`run_scheduled_publish` + `schedule()` (Task 3); presigned `content-assets` edge fn + bounded `issueAssetUpload`/server-verified `finalizeAsset` (Task 4); curation ops + advisory `runSeoAudit` + graph-edge links + the cloned integration test (Task 5). Every task is TDD (red → green) and ends with a machine-checkable gate: SQL/schema tasks run `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` plus a targeted grep; domain tasks run Vitest + the frontend build.
- **Collection field lists (verbatim):**
  - `content_schedule` — `item`→`content_item_id` (rel, req), `action` enum[`publish`,`unpublish`] (req), `revision`→`revision_id` (rel, req; **PINNED**), `run_at` datetime (req), `scheduled_by` uuid (req; the scheduler actor, read by `run_scheduled_publish` for `content_publish_event.actor_id`), `state` enum[`scheduled`,`fired`,`canceled`,`failed`] (default `scheduled`, dimension).
  - `asset` — `filename` text (req), `mime` text (req, dimension), `r2_key` text (req), `size_bytes` number (measure), `checksum` text, `width` number, `height` number, `alt_text` text (searchable), `uploaded_by` uuid (req).
  - `content_collection` — `key` text (req), `label` text (req), `description` text.
  - `content_collection_entry` — `collection`→`collection_id` (rel, req), `item`→`content_item_id` (rel, req), `position` number (req).
  - `content_seo` — `item`→`content_item_id` (rel, req), `meta` json, `jsonld` json, `score` number (measure), `checklist` json.
- **Scheduler claim SQL (crash-safe, exactly-once):**
  ```sql
  update public.content_schedule set state = 'fired'
   where id in (select id from public.content_schedule
                 where state = 'scheduled' and run_at <= now()
                 order by run_at for update skip locked limit lim)
  returning *;
  ```
  `run_scheduled_publish` then publishes the PINNED `s.revision_id` (never `current_revision_id`); a re-claim after `fired` returns nothing, so no second `content_publish_event`.
- **Asset presign + finalize contract:** `issueAssetUpload({workspaceId,filename,mime,sizeBytes})` → fast-fail `validateAssetRequest` (mime allow-list = png/jpeg/webp/gif/pdf; `0 < sizeBytes ≤ 25 MiB`, integer) → edge fn re-validates (authoritative) → inserts a pending `asset` row → presigns an S3 PUT (`aws4fetch`, `signQuery:true`) to `https://<account>.r2.cloudflarestorage.com/<bucket>/<workspace_id>/<assetId>` → returns `{uploadUrl,r2Key,assetId}`. Client PUTs bytes directly to R2 (server buffers nothing). `finalizeAsset({assetId,checksum,sizeBytes,width?,height?})` → edge fn re-HEADs the R2 object and writes the SERVER-verified `size_bytes` (Content-Length) + `checksum` (ETag), discarding the client's claims. R2 creds live only in `Deno.env`/Vault under `supabase/functions/`, never in the workerd `packages/` bundle.
- **ContentService additions:** `schedule` / `issueAssetUpload` / `finalizeAsset` / `createCollection` / `addToCollection` (published-only) / `reorderCollection` / `runSeoAudit` (advisory) / `linkAsset` / `linkItem` / `linkEditorialTask` (see the interface block up top). Row types (`ContentScheduleRow`, `AssetRow`, `ContentCollectionRow`, `ContentSeoRow`) come from the regenerated generated types.
- **Correctness / self-consistency:** `content.scheduled` payload is the contract's verbatim shape; FK columns `content_item_id`/`revision_id`/`collection_id` are asserted by `has_column` in Task 1 (plus `scheduled_by`) and used consistently in every migration + query; `plan(N)` bumps 11 → 17 → 24 as blocks insert before the single `finish()`; all fixture UUIDs are hex. The `run_scheduled_publish` publish/unpublish-emit question (Part B trigger vs domain op) is called out inline with the default (three explicit steps) + the escape hatch, so the executor has one path; the pgTAP asserts `content_publish_event` (mechanism-independent), not the emit.
- **Safety / observability:** every new function is a hardened `SECURITY DEFINER` — `set search_path = ''`, fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` (trigger + RPCs); all pass `check-definer-audit.mjs`. Curation published-only is enforced at the RLS `with check` (not just the service), with a grep gate proving exactly one entry INSERT policy (no permissive OR-in). R2 creds are edge-fn-only (grep gate `NO_R2_CREDS_IN_DOMAIN`). `movp_internal` is read in tests only as the owner. Payloads carry ids + entity refs; the edge fn logs action + reason, never `body`/filenames/R2 response bodies.
- **Reliability / efficiency / performance:** the scheduler is exactly-once via `scheduled→fired` under SKIP LOCKED; on run error the row parks as `failed` (not silently lost). `content_schedule(state,run_at)` indexes the scan; `asset(r2_key)` indexes lookups. The server never buffers file bytes (presigned PUT). SEO is advisory and pure (`auditSeo` unit-tested; no event). The domain-side `validateAssetRequest` is an intentional fast-fail duplicate of the authoritative edge-fn bound (defense in depth), noted as such.
- **Deploy-time boundary:** the pg_cron / Cron→Edge driver is documented-only (never committed) so `supabase db diff` stays empty; e2e invokes the `content-scheduler` worker directly.
- **Deferred (intentional):** no new event types beyond `content.scheduled` (scheduled publish reuses `content.published`/`content.unpublished`); no `content.unscheduled` (a cancel just sets `state='canceled'`, filtered out of the claim); no UI. None are needed for the DB/edge/domain deliverable.
- **Executor reconciliation flags (stated, not hidden):** (1) the pgTAP seed must match Parts A/B's actual NOT NULL columns for `content_type`/`content_item`/`content_revision` — reconcile against the regenerated `000002` or reuse Part B's seed helper. (Resolved after review: `run_scheduled_publish` now uses Part B's exact `content_publish_event` columns + `scheduled_by` actor + `archived` status and does NOT emit — Part B's trigger owns emission; the graph links call a local `const graph = makeGraphService(ctx)` with `graph.link({ workspaceId, srcType, … })` camelCase — there is NO `this.graph`; and the `content-assets` membership/finalize checks use the USER-BOUND client so `is_workspace_member` sees `auth.uid()`.)
- **Placeholder scan:** none — every SQL/TS block is complete and copy-paste-ready; every step has an exact command + expected output. `<schema-pkg>` is the one "mirror the existing Part A/B location" pointer; the graph link + membership APIs are now concrete (local `graph` service, user-bound `supabase.rpc`), not invented.
