# MOVP App — Collaboration Phase 2, Part A: Data, Access & Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the five collaboration collections — `comment`, `reaction`, `saved_item`, `mention`, `share_link` — to the config-first schema so codegen emits their base tables + generated types, then hand-author migration `20260701000006_collaboration.sql` for the parts codegen cannot express: composite uniques + entity indexes, the `public.can_access_entity()` authorization gate, fine-grained RLS overrides on all five tables, and AFTER-INSERT lifecycle triggers that fan out through the existing `public.emit_event`.

**Architecture:** Collections are defined in `packages/core-schema/src/collections/`, wired into `defineSchema()` (`schema.ts`) and re-exported (`index.ts`). Running `pnpm codegen` regenerates BOTH `supabase/migrations/20260701000002_movp_generated.sql` (base tables, the blanket `<name>_rw` `is_workspace_member` RLS policy, grants, FTS for searchable fields, `<name>_delete_chunks` triggers, metadata registry rows) AND `packages/domain/src/generated/types.ts` (`<Name>Row`/`<Name>Create`/`<Name>Update` — **consumed by Part B**). User references are plain `f.uuid` columns (no FK to `auth.users`); only `comment.parent` and `mention.comment` are `f.relation('comment', …)`, so codegen emits `parent_id` (nullable self-FK) and `comment_id` (required FK). Everything codegen cannot emit lives in the hand-authored `20260701000006_collaboration.sql`, which sorts AFTER `20260701000005_async_rpcs.sql`: it drops each generated `<name>_rw` policy and replaces it with fine-grained per-verb policies gated on `public.can_access_entity()` (a hardened `SECURITY DEFINER` function whose per-`entity_type` dispatch is the extension seam for future `task`/`content` types), and it installs one `SECURITY DEFINER` AFTER-INSERT trigger per table that calls `public.emit_event(type, workspace_id, payload, gen_random_uuid()::text)`.

**Tech Stack:** TypeScript (`@movp/core-schema`, `@movp/codegen`), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres RLS + `SECURITY DEFINER`, the existing `public.emit_event` / `movp_internal.movp_events` async backbone.

**This is Part A of the Phase 2 (Collaboration) series.** It depends on Phase 1: bootstrap tenancy (`public.workspace`, `public.workspace_membership`, `public.is_workspace_member(uuid)` — `20260701000001`), the codegen pipeline + `public.note` (`20260701000002`), and the async RPCs (`public.emit_event`, `movp_internal.movp_events` — `20260701000005`). **Part B** (services/resolvers/UI) consumes the generated `Comment*/Reaction*/SavedItem*/Mention*/ShareLink*` types and the event names produced here — do not rename a field or event without updating Part B.

## Global Constraints

- **Config-first collections.** New tables are added by defining a collection and running `pnpm codegen` — never by hand-writing a `create table` in a migration. The generated `20260701000002_movp_generated.sql` is a build artifact; commit it, never edit it by hand.
- **`pnpm codegen` is reproducible and committed.** After changing collections, run `pnpm codegen`, commit the regenerated migration AND `packages/domain/src/generated/types.ts`. Re-running codegen must produce no diff (`git diff --exit-code` on both files is clean). CI's migration-drift job (`supabase db reset` → `supabase db diff` empty) fails if the committed migration is stale.
- **Every field needs a `label`.** `defineCollection` throws if any field omits `label` or if an enum has empty `values`; `pnpm codegen` imports the schema and therefore fails loudly on a malformed collection. User references are `f.uuid`, never `relation('user')`.
- **Collection order encodes FK dependencies.** `mention.comment_id references public.comment(id)`, so `comment` MUST precede `mention` in `defineSchema([...])`. `comment.parent_id` is a same-statement self-FK (legal in one `create table`).
- **Hand-authored migration for the rest.** `20260701000006_collaboration.sql` (sorts after `000005`) holds composite uniques, entity indexes, `can_access_entity`, RLS overrides, and lifecycle triggers — in that top-to-bottom order (policies reference the function defined above them; triggers reference `emit_event` from `000005`).
- **All `SECURITY DEFINER` functions hardened:** `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon` (and `authenticated` for trigger fns), granted only where needed. The definer-audit gate (`node scripts/check-definer-audit.mjs`) fails any `security definer` function missing a pinned `search_path`.
- **Authoritative authz at the data boundary.** RLS is the gate. The authoritative visibility check is `public.can_access_entity(entity_type, entity_id, workspace_id)`, resolved server-side; policies use `(select auth.uid())` for the owning-principal check.
- **`movp_internal` is not reachable by `authenticated`.** Lifecycle triggers write it only through the `SECURITY DEFINER` `public.emit_event`; pgTAP reads `movp_internal.movp_events` as the table owner (`reset role`), never as `authenticated`.
- **Observability discipline:** trigger payloads carry ids and entity refs (and `recipient_user_id` where a notify is intended), never free-text/PII values beyond what the row already is.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  packages/
    core-schema/src/
      collections/
        comment.ts       # NEW
        reaction.ts      # NEW
        saved_item.ts    # NEW
        mention.ts       # NEW
        share_link.ts    # NEW
      schema.ts          # EDIT: defineSchema([... , comment, reaction, savedItem, mention, shareLink])
      index.ts           # EDIT: re-export the five collections
    domain/src/generated/
      types.ts           # REGENERATED by `pnpm codegen` (commit)
  supabase/
    migrations/
      20260701000002_movp_generated.sql   # REGENERATED by `pnpm codegen` (commit)
      20260701000006_collaboration.sql     # NEW hand-authored (built up across Tasks 2–5)
    tests/
      collaboration_test.sql               # NEW pgTAP (built up across Tasks 2–5)
```

---

### Task 1: Define the five collaboration collections + regenerate

**Files:**
- Create: `packages/core-schema/src/collections/comment.ts`, `reaction.ts`, `saved_item.ts`, `mention.ts`, `share_link.ts`
- Edit: `packages/core-schema/src/types.ts` (add `internal?: boolean` to `CollectionDef`), `packages/core-schema/src/schema.ts`, `packages/core-schema/src/index.ts`, `packages/codegen/test/emit-sql.test.ts` (assert `internal` is preserved AND SQL is still emitted)
- Regenerate (do NOT hand-edit): `supabase/migrations/20260701000002_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `f` + `defineCollection` (`packages/core-schema/src/builders.ts`, `define.ts`); the existing `note`/`tag` collections; `public.workspace`, `public.is_workspace_member` (from `000001`).
- Produces (Part B consumes): base tables `public.{comment,reaction,saved_item,mention,share_link}` with blanket `<name>_rw` RLS + grants, and generated types `Comment*`, `Reaction*`, `SavedItem*`, `Mention*`, `ShareLink*`.

This task is config + codegen; its gates are `pnpm codegen` succeeding, a clean `supabase db reset`/`db diff`, and greps proving the tables + types were emitted.

All five collab collections are marked `internal: true`. **Codegen is unaffected by this flag** — `emit-sql`/`emit-types` ignore `internal`, so the base tables, blanket `<name>_rw` RLS, grants, FTS, delete-chunk triggers, metadata rows, and the generated `*Row/*Create/*Update` types are produced exactly as without it (Part B relies on those generated types). The flag is metadata that the generic GraphQL/MCP/CLI surface builders read to SKIP a collection's automatic CRUD surfacing — collab tables have FK relations (`comment.parent`→`parent_id`, `mention.comment`→`comment_id` required) the generic builders assume are many-to-many→edges and can't handle, and generic `createComment` would bypass the atomic mention logic; they are reached ONLY through the custom domain ops added in **Part B**. Because `internal` changes no SQL, the `supabase db diff` drift gate below stays empty and the codegen-reproducibility `git diff --exit-code` is unaffected. The surface-builder skip itself is implemented in Part B; Part A's job is only to set the flag.

- [ ] **Step 1: Add the `internal` flag to `CollectionDef`**

Edit `packages/core-schema/src/types.ts` — add one optional field to the `CollectionDef` interface (additive; existing call sites and codegen are unchanged):
```ts
export interface CollectionDef {
  name: string
  label: string
  labelPlural: string
  workspaceScoped: boolean
  fields: Record<string, FieldDef>
  /**
   * internal — the DB table + generated `*Row/*Create/*Update` types ARE still
   * emitted (emit-sql/emit-types ignore this flag), but the generic GraphQL/MCP/CLI
   * CRUD surface builders SKIP the collection; it is reached only through custom
   * domain ops (see Part B). Use for collections whose FK relations the generic
   * surface cannot express or whose writes must go through bespoke atomic logic.
   */
  internal?: boolean
}
```
Gate:
```bash
grep -q 'internal?: boolean' packages/core-schema/src/types.ts && echo OK
```
Expected: prints `OK` (the field is present). It is optional, so `note`/`tag` (which omit it) still typecheck.

- [ ] **Step 2: Create the five collection files**

Each collab collection sets `internal: true` (the tables/types are still generated; only the generic CRUD surface is skipped, in Part B).

`packages/core-schema/src/collections/comment.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const comment = defineCollection({
  name: 'comment',
  label: 'Comment',
  labelPlural: 'Comments',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
    // Self-reference -> nullable `parent_id uuid references public.comment(id) on delete set null`.
    parent: f.relation('comment', { label: 'Parent Comment', cardinality: 'many-to-one' }),
  },
})
```

`packages/core-schema/src/collections/reaction.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const reaction = defineCollection({
  name: 'reaction',
  label: 'Reaction',
  labelPlural: 'Reactions',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    user_id: f.uuid({ label: 'User', required: true }),
    kind: f.enum(['like', 'dislike'], { label: 'Kind', required: true, reporting: { role: 'dimension' } }),
  },
})
```

`packages/core-schema/src/collections/saved_item.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const savedItem = defineCollection({
  name: 'saved_item',
  label: 'Saved Item',
  labelPlural: 'Saved Items',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    user_id: f.uuid({ label: 'User', required: true }),
  },
})
```

`packages/core-schema/src/collections/mention.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const mention = defineCollection({
  name: 'mention',
  label: 'Mention',
  labelPlural: 'Mentions',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    // Required relation -> `comment_id uuid not null references public.comment(id) on delete cascade`.
    comment: f.relation('comment', { label: 'Comment', cardinality: 'many-to-one', required: true }),
    mentioned_user_id: f.uuid({ label: 'Mentioned User', required: true }),
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
  },
})
```

`packages/core-schema/src/collections/share_link.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const shareLink = defineCollection({
  name: 'share_link',
  label: 'Share Link',
  labelPlural: 'Share Links',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (Part B)
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    token_hash: f.text({ label: 'Token Hash', required: true }),
    scope: f.enum(['view'], { label: 'Scope', default: 'view' }),
    created_by: f.uuid({ label: 'Created By', required: true }),
    expires_at: f.datetime({ label: 'Expires At' }),
  },
})
```

- [ ] **Step 3: Wire the collections into the schema**

Replace `packages/core-schema/src/schema.ts` entirely with:
```ts
import { comment } from './collections/comment.ts'
import { mention } from './collections/mention.ts'
import { note } from './collections/note.ts'
import { reaction } from './collections/reaction.ts'
import { savedItem } from './collections/saved_item.ts'
import { shareLink } from './collections/share_link.ts'
import { tag } from './collections/tag.ts'
import { defineSchema } from './define.ts'

// Order matters: `comment` must precede `mention` (mention.comment_id -> comment).
export const schema = defineSchema([note, tag, comment, reaction, savedItem, mention, shareLink])
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
export { note } from './collections/note.ts'
export { tag } from './collections/tag.ts'
export { comment } from './collections/comment.ts'
export { reaction } from './collections/reaction.ts'
export { savedItem } from './collections/saved_item.ts'
export { mention } from './collections/mention.ts'
export { shareLink } from './collections/share_link.ts'
export { schema } from './schema.ts'
```

- [ ] **Step 4: Regenerate**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints `wrote .../supabase/migrations/20260701000002_movp_generated.sql` and `wrote .../packages/domain/src/generated/types.ts`, exit 0. (A missing `label` or empty enum `values` makes `defineCollection` throw here — fix the collection and re-run.)

`packages/domain/src/generated/types.ts` will now contain (codegen output — verify, do NOT hand-edit; **Part B imports these**):
```ts
export interface CommentRow {
  id: string
  workspace_id: string
  entity_type: string
  entity_id: string
  body: string
  author_id: string
  parent_id: string | null
  created_at: string
  updated_at: string
}
// CommentCreate: { workspace_id; entity_type; entity_id; body; author_id; parent_id? }
// CommentUpdate: { entity_type?; entity_id?; body?; author_id?; parent_id? }

export interface ReactionRow {
  id: string
  workspace_id: string
  entity_type: string
  entity_id: string
  user_id: string
  kind: 'like' | 'dislike'
  created_at: string
  updated_at: string
}

export interface SavedItemRow {
  id: string
  workspace_id: string
  entity_type: string
  entity_id: string
  user_id: string
  created_at: string
  updated_at: string
}

export interface MentionRow {
  id: string
  workspace_id: string
  mentioned_user_id: string
  entity_type: string
  entity_id: string
  comment_id: string
  created_at: string
  updated_at: string
}

export interface ShareLinkRow {
  id: string
  workspace_id: string
  entity_type: string
  entity_id: string
  token_hash: string
  scope: 'view'
  created_by: string
  expires_at: string | null
  created_at: string
  updated_at: string
}
```

- [ ] **Step 5: Apply + drift check + typecheck**

Run:
```bash
supabase db reset && supabase db diff && pnpm typecheck
```
Expected: `db reset` applies the regenerated migration cleanly (the five tables + blanket `<name>_rw` policies are created); `supabase db diff` prints **nothing** (no drift); `pnpm typecheck` PASSES.

- [ ] **Step 6: Machine-checkable gate — tables + types emitted, codegen reproducible**

First, pin that `internal: true` does NOT suppress SQL. In `packages/codegen/test/emit-sql.test.ts`, add `comment` to the existing `@movp/core-schema` import and append one describe block:
```ts
// change: import { note, schema } from '@movp/core-schema'
import { comment, note, schema } from '@movp/core-schema'

// append after the existing describe blocks:
describe('internal collections are still emitted (flag is codegen-transparent)', () => {
  it('preserves internal on the def but still emits the SQL table', () => {
    expect(comment.internal).toBe(true)
    expect(emitCollectionSql(comment)).toContain('create table if not exists public.comment')
  })
})
```
Then run:
```bash
pnpm --filter @movp/codegen exec vitest run emit-sql
grep -cE 'create table if not exists public\.(comment|reaction|saved_item|mention|share_link) \(' \
  supabase/migrations/20260701000002_movp_generated.sql
grep -cE 'interface (Comment|Reaction|SavedItem|Mention|ShareLink)(Row|Create|Update)' \
  packages/domain/src/generated/types.ts
pnpm codegen && git diff --exit-code \
  supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
```
Expected: the codegen test PASSES (`comment.internal === true` AND the `comment` table SQL is still emitted — the flag changes no SQL); first grep prints `5`; second grep prints `15` (5 collections × Row/Create/Update); the `git diff --exit-code` exits `0` (re-running codegen changed nothing — reproducible).

- [ ] **Step 7: Commit**

```bash
git add packages/core-schema/src packages/codegen/test/emit-sql.test.ts supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
git commit -m "feat(schema): add collaboration collections (comment/reaction/saved_item/mention/share_link)"
```

---

### Task 2: Migration `000006` part 1 — composite uniques + entity indexes

**Files:**
- Create: `supabase/migrations/20260701000006_collaboration.sql`
- Create: `supabase/tests/collaboration_test.sql`

**Interfaces:**
- Consumes: the five generated tables from Task 1.
- Produces: `reaction_uniq`, `saved_item_uniq`, `share_link_token_uniq` unique constraints; `comment_entity_idx`, `reaction_entity_idx`, `saved_item_entity_idx`, `mention_entity_idx` indexes.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/collaboration_test.sql` (this file grows in Tasks 3–5; `plan(N)` is bumped each time):
```sql
begin;
select plan(12);

-- ── shared seed (as table owner; RLS bypassed) ──────────────────────────────
-- W1 members: A (owner), C (member). B is NOT a member of W1. W2 has no seeded members.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');
insert into public.note (id, workspace_id, title, body) values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'N1', 'body one'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'N2', 'body two');

-- ── Task 2: structural — tables, composite uniques, entity indexes ──────────
select has_table('public', 'comment',    'comment table exists');
select has_table('public', 'reaction',   'reaction table exists');
select has_table('public', 'saved_item', 'saved_item table exists');
select has_table('public', 'mention',    'mention table exists');
select has_table('public', 'share_link', 'share_link table exists');

select is((select count(*)::int from pg_constraint where conname = 'reaction_uniq' and contype = 'u'),
          1, 'reaction has its composite unique constraint');
select is((select count(*)::int from pg_constraint where conname = 'saved_item_uniq' and contype = 'u'),
          1, 'saved_item has its composite unique constraint');
select is((select count(*)::int from pg_constraint where conname = 'share_link_token_uniq' and contype = 'u'),
          1, 'share_link has its token unique constraint');

select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='comment_entity_idx'),
          1, 'comment entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='reaction_entity_idx'),
          1, 'reaction entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='saved_item_entity_idx'),
          1, 'saved_item entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='mention_entity_idx'),
          1, 'mention entity index exists');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `collaboration_test.sql` fails the three constraint assertions and four index assertions (constraints/indexes don't exist yet); the `has_table` assertions pass (Task 1 created the tables).

- [ ] **Step 3: Create the migration with part 1**

Create `supabase/migrations/20260701000006_collaboration.sql` (exact path — do NOT use `supabase migration new`, which mints a wall-clock timestamp; this filename must sort right after `20260701000005`):
```sql
-- Collaboration Phase 2 — Part A. Sorts AFTER 20260701000005_async_rpcs.sql.
-- Hand-authored: composite uniques + entity indexes codegen cannot emit,
-- can_access_entity(), fine-grained RLS overrides, and lifecycle triggers.

-- ── composite uniques + entity indexes (codegen cannot emit these) ───────────
alter table public.reaction
  add constraint reaction_uniq unique (workspace_id, user_id, entity_type, entity_id, kind);
alter table public.saved_item
  add constraint saved_item_uniq unique (workspace_id, user_id, entity_type, entity_id);
alter table public.share_link
  add constraint share_link_token_uniq unique (workspace_id, token_hash);

create index comment_entity_idx    on public.comment    (entity_type, entity_id);
create index reaction_entity_idx   on public.reaction   (entity_type, entity_id);
create index saved_item_entity_idx on public.saved_item (entity_type, entity_id);
create index mention_entity_idx    on public.mention    (entity_type, entity_id);
```

- [ ] **Step 4: Apply + test + drift check**

Run:
```bash
supabase db reset && supabase test db && supabase db diff
```
Expected: migration applies; `collaboration_test.sql .. ok` (all 12 assertions pass); `supabase db diff` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000006_collaboration.sql supabase/tests/collaboration_test.sql
git commit -m "feat(db): collaboration uniques + entity indexes"
```

---

### Task 3: `public.can_access_entity` authorization gate + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000006_collaboration.sql` (append part 2)
- Edit: `supabase/tests/collaboration_test.sql` (add can_access assertions)

**Interfaces:**
- Consumes: `public.is_workspace_member(uuid)` (from `000001`), `public.note`, `public.comment`.
- Produces: `public.can_access_entity(entity_type text, entity_id uuid, ws uuid) returns boolean` — `SECURITY DEFINER`, `set search_path=''`, `execute` granted to `authenticated` only. Consumed by the Task 4 RLS policies.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/collaboration_test.sql`: change `select plan(12);` to `select plan(17);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 3: can_access_entity (act as member A of W1) ───────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('note','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111'),
          true,  'member + entity in ws -> true');
select is(public.can_access_entity('note','44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111'),
          false, 'entity not in the passed workspace -> false');
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed) even for a member');
-- act as non-member B (not in W1)
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('note','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false');
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed), non-member');
```

Run: `supabase test db`
Expected: FAIL — `function public.can_access_entity(unknown, uuid, uuid) does not exist` (the earlier 12 assertions still pass; the whole file errors on the first `can_access_entity` call).

- [ ] **Step 2: Append the function to the migration (green)**

Append to `supabase/migrations/20260701000006_collaboration.sql`:
```sql
-- ── can_access_entity: authoritative entity-visibility gate ──────────────────
-- SECURITY DEFINER so the existence probe bypasses RLS; hardened with an empty
-- search_path and fully schema-qualified names. Parameters are qualified with the
-- function name (e.g. can_access_entity.entity_id) to avoid collisions with the
-- same-named columns on public.comment.
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

  -- Per-entity_type dispatch. EXTENSION SEAM: the Task phase adds a 'task' branch,
  -- the CMS phase adds a 'content' branch, etc. — one arm per commentable type.
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
    else
      -- Unknown entity_type: FAIL CLOSED. A future phase adds an explicit arm
      -- (e.g. `when 'task' then ...`, `when 'content' then ...`) before its collab
      -- surfaces go live; until then, unknown types are denied.
      return false;
  end case;

  return v_exists;
end;
$$;

revoke all on function public.can_access_entity(text, uuid, uuid) from public, anon;
grant execute on function public.can_access_entity(text, uuid, uuid) to authenticated;
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `collaboration_test.sql .. ok` (17 assertions); definer-audit prints `all definers pinned` (exit 0); `db diff` empty.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260701000006_collaboration.sql supabase/tests/collaboration_test.sql
git commit -m "feat(db): can_access_entity authorization gate"
```

---

### Task 4: Fine-grained RLS overrides + pgTAP matrix

**Files:**
- Edit: `supabase/migrations/20260701000006_collaboration.sql` (append part 3)
- Edit: `supabase/tests/collaboration_test.sql` (add RLS matrix)

**Interfaces:**
- Consumes: the generated `<name>_rw` policies (from `000002`), `public.can_access_entity` (Task 3), `(select auth.uid())`.
- Produces: per-verb RLS policies on all five tables. Invariant: the generated blanket `<name>_rw` policy is DROPPED and replaced; no table keeps both.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/collaboration_test.sql`: change `select plan(17);` to `select plan(29);`, and insert this block immediately BEFORE the final `select * from finish();` (it continues in the `authenticated` role set by Task 3):
```sql
-- ── Task 4: RLS matrix (still role=authenticated) ───────────────────────────
-- member A authors a comment on the accessible note
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id)
  values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111',
          'note','33333333-3333-3333-3333-333333333333','hello','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          1, 'author (member) sees own comment');
-- non-member B sees nothing
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          0, 'non-member sees no comment');
-- member C (non-author) sees the comment on the accessible entity
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          1, 'member (non-author) sees comment on accessible entity');
-- author A edits own comment
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
update public.comment set body='edited' where id='55555555-5555-5555-5555-555555555555';
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'author can edit own comment');
-- member C cannot edit A's comment (UPDATE filtered by RLS -> no-op)
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.comment set body='hacked' where id='55555555-5555-5555-5555-555555555555';
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'non-author member cannot edit the comment');
-- saved_item is owner-only
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.saved_item (workspace_id, entity_type, entity_id, user_id)
  values ('11111111-1111-1111-1111-111111111111','note','33333333-3333-3333-3333-333333333333',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.saved_item), 1, 'owner sees own saved_item');
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.saved_item), 0, 'saved_item is private to its owner');
-- mention: a mention may only TARGET a workspace MEMBER, and visibility REQUIRES
-- membership (matches Part B's inbox_feed gate, which returns [] for non-members).
-- Author A (member) mints a mention for member C (succeeds); C sees it. Minting one
-- for NON-member B is DENIED by mention_insert's membership check.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
  values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
          'cccccccc-cccc-cccc-cccc-cccccccccccc','note','33333333-3333-3333-3333-333333333333');
-- a mention TARGETING non-member B is denied: mention_insert WITH CHECK requires
-- mentioned_user_id to be a workspace member. throws_ok savepoints the failed insert
-- so the test transaction continues (and B's row never persists). NULL errmsg =
-- check the SQLSTATE only (42501 = insufficient_privilege / RLS violation).
select throws_ok(
  $$insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
    values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','note','33333333-3333-3333-3333-333333333333')$$,
  '42501', NULL,
  'a mention targeting a non-member is denied (mentions target workspace members only)');
-- mentioned MEMBER C sees their own mention
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.mention where mentioned_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'mentioned member sees their own mention');

-- ── Task 4 (cont.): negative assertions proving the write tightening ─────────
-- (i) a non-member (B) cannot insert a saved_item into a workspace they don't
--     belong to: saved_item_all WITH CHECK requires can_access_entity(...), which
--     fails the membership base gate. pgTAP's throws_ok savepoints the failed
--     insert, so the enclosing test transaction continues. NULL errmsg = check
--     only the SQLSTATE (42501 = insufficient_privilege / RLS violation).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$insert into public.saved_item (workspace_id, entity_type, entity_id, user_id)
    values ('11111111-1111-1111-1111-111111111111','note','33333333-3333-3333-3333-333333333333',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL,
  'non-member cannot save into a workspace they do not belong to');

-- (ii) member C (who did NOT author comment 55555555, authored by A) cannot insert
--      a mention for it: mention_insert WITH CHECK requires the referenced comment
--      to be authored by the caller.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select throws_ok(
  $$insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
    values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','note','33333333-3333-3333-3333-333333333333')$$,
  '42501', NULL,
  'a member who did not author the comment cannot mention on it');

-- (iii) a removed member cannot edit OR delete their old comment. Remove A from W1
--       (as the table owner), then as A the tightened comment_update/comment_delete
--       (now requiring can_access_entity) filter the row out -> the update is a
--       no-op and the delete removes nothing. Read back as the owner (RLS bypassed):
--       the row still exists with its pre-removal body ('edited' from earlier),
--       proving BOTH writes were denied. Re-add A afterward so the Task 5 seed
--       state (A is a member of W1) is restored.
reset role;
delete from public.workspace_membership
  where workspace_id='11111111-1111-1111-1111-111111111111'
    and user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
update public.comment set body='edited-after-removal' where id='55555555-5555-5555-5555-555555555555';
delete from public.comment where id='55555555-5555-5555-5555-555555555555';
reset role;
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'removed author cannot update or delete their old comment');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');
set local role authenticated;
```

Run: `supabase test db`
Expected: FAIL — the blanket `<name>_rw` policies still govern (each verb gated only on `is_workspace_member`), so the tightening assertions mismatch: a non-author member can still edit the comment, `saved_item` is not owner-private (member C sees A's saved_item), member C's non-authored `mention` insert does not throw, and author A's `mention` targeting non-member B is NOT denied (the blanket policy lets any member insert, so the members-only `throws_ok` fails). The first 17 assertions still pass. (The `mentioned member sees their own mention` assertion happens to hold under the blanket policy too — a member is allowed — but it pins the intended behaviour once the override lands.)

- [ ] **Step 2: Append the RLS overrides (green)**

Append to `supabase/migrations/20260701000006_collaboration.sql`:
```sql
-- ── fine-grained RLS: replace the generated <name>_rw blanket policies ───────
-- comment: readable by anyone who can access the entity; writable only by its author.
drop policy if exists comment_rw on public.comment;
create policy comment_select on public.comment for select to authenticated
  using (public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_insert on public.comment for insert to authenticated
  with check (author_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_update on public.comment for update to authenticated
  using (author_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id))
  with check (author_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_delete on public.comment for delete to authenticated
  using (author_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id));

-- reaction: readable by anyone who can access the entity; each user owns theirs.
drop policy if exists reaction_rw on public.reaction;
create policy reaction_select on public.reaction for select to authenticated
  using (public.can_access_entity(entity_type, entity_id, workspace_id));
create policy reaction_insert on public.reaction for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy reaction_delete on public.reaction for delete to authenticated
  using (user_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id));

-- saved_item: strictly owner-only (private bookmarks).
drop policy if exists saved_item_rw on public.saved_item;
create policy saved_item_all on public.saved_item for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));

-- mention: visible to anyone who can access the entity, or to a mentioned MEMBER.
-- Visibility REQUIRES workspace membership so it matches Part B's inbox_feed gate
-- (inbox_feed returns [] for non-members); a mentioned non-member cannot read the row.
drop policy if exists mention_rw on public.mention;
create policy mention_select on public.mention for select to authenticated
  using (
    public.can_access_entity(entity_type, entity_id, workspace_id)
    or (mentioned_user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  );
-- mention_insert: three ANDed guards. (1) the author can access the entity; (2)
-- the referenced comment is authored by the caller (only a comment's author mints
-- its mentions); (3) mentioned_user_id is a workspace MEMBER, so a mention can never
-- target a random/cross-tenant uuid and its user.mentioned notify never fans out to
-- a non-member (consistent with mention_select/inbox_feed's membership gate).
create policy mention_insert on public.mention for insert to authenticated
  with check (
    public.can_access_entity(mention.entity_type, mention.entity_id, mention.workspace_id)
    and exists (
      select 1 from public.comment c
      where c.id = mention.comment_id
        and c.workspace_id = mention.workspace_id
        and c.entity_type  = mention.entity_type
        and c.entity_id    = mention.entity_id
        and c.author_id    = (select auth.uid())
    )
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = mention.workspace_id
        and m.user_id      = mention.mentioned_user_id
    )
  );

-- share_link: managed only by its creator, who must be able to access the entity.
drop policy if exists share_link_rw on public.share_link;
create policy share_link_all on public.share_link for all to authenticated
  using (created_by = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id))
  with check (created_by = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
```

- [ ] **Step 3: Apply + test + drift**

Run:
```bash
supabase db reset && supabase test db && supabase db diff
```
Expected: `collaboration_test.sql .. ok` (29 assertions); `db diff` empty.

- [ ] **Step 4: Gate — no blanket policy survives on the five tables**

Run:
```bash
grep -cE '^drop policy if exists (comment|reaction|saved_item|mention|share_link)_rw' \
  supabase/migrations/20260701000006_collaboration.sql
```
Expected: `5` (each generated blanket policy is explicitly dropped).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000006_collaboration.sql supabase/tests/collaboration_test.sql
git commit -m "feat(db): fine-grained collaboration RLS over can_access_entity"
```

---

### Task 5: Lifecycle triggers (`emit_event` fan-out) + pgTAP

**Files:**
- Edit: `supabase/migrations/20260701000006_collaboration.sql` (append part 4)
- Edit: `supabase/tests/collaboration_test.sql` (add trigger assertions)

**Interfaces:**
- Consumes: `public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)` (from `000005`), `movp_internal.movp_events`.
- Produces: AFTER-INSERT triggers on all five tables. Event names (exact, Part B consumes): `comment.added` / `comment.replied`, `user.mentioned`, `item.liked` / `item.disliked`, `item.saved`, `item.shared`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/collaboration_test.sql`: change `select plan(29);` to `select plan(33);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 5: lifecycle triggers (still role=authenticated as member A) ────────
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id)
  values ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111',
          'note','33333333-3333-3333-3333-333333333333','trigger me','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id, parent_id)
  values ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
          'note','33333333-3333-3333-3333-333333333333','a reply','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '66666666-6666-6666-6666-666666666666');
insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
  values ('11111111-1111-1111-1111-111111111111','66666666-6666-6666-6666-666666666666',
          'cccccccc-cccc-cccc-cccc-cccccccccccc','note','33333333-3333-3333-3333-333333333333');
insert into public.reaction (workspace_id, entity_type, entity_id, user_id, kind)
  values ('11111111-1111-1111-1111-111111111111','note','33333333-3333-3333-3333-333333333333',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','like');
-- movp_internal is denied to authenticated; read the event log as the table owner
reset role;
select is((select count(*)::int from movp_internal.movp_events
           where type='comment.added' and payload->>'id'='66666666-6666-6666-6666-666666666666'),
          1, 'comment insert emits comment.added');
select is((select count(*)::int from movp_internal.movp_events
           where type='comment.replied' and payload->>'parent_id'='66666666-6666-6666-6666-666666666666'),
          1, 'reply comment emits comment.replied');
select is((select count(*)::int from movp_internal.movp_events
           where type='user.mentioned'
             and payload->>'comment_id'='66666666-6666-6666-6666-666666666666'
             and payload->>'recipient_user_id'='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'mention insert emits user.mentioned carrying recipient_user_id');
select is((select count(*)::int from movp_internal.movp_events
           where type='item.liked'
             and payload->>'user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
             and payload->>'entity_id'='33333333-3333-3333-3333-333333333333'),
          1, 'like reaction emits item.liked');
```

Run: `supabase test db`
Expected: FAIL — the four `movp_events` assertions return `0` (no triggers exist yet); the first 29 assertions still pass.

- [ ] **Step 2: Append the trigger functions (green)**

Append to `supabase/migrations/20260701000006_collaboration.sql` (each function mirrors the `public.note_created_emit_event` pattern from `000005`: hardened `SECURITY DEFINER`, `perform public.emit_event(...)`, `execute` revoked from `public,anon,authenticated`):
```sql
-- ── lifecycle triggers: fan out through public.emit_event (from 000005) ──────
create or replace function public.comment_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    case when new.parent_id is not null then 'comment.replied' else 'comment.added' end,
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'author_id', new.author_id,
      'parent_id', new.parent_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.comment_emit_event() from public, anon, authenticated;

drop trigger if exists comment_emit_event_tg on public.comment;
create trigger comment_emit_event_tg
  after insert on public.comment
  for each row execute function public.comment_emit_event();

create or replace function public.mention_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'user.mentioned',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'comment_id', new.comment_id,
      'mentioned_user_id', new.mentioned_user_id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'recipient_user_id', new.mentioned_user_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.mention_emit_event() from public, anon, authenticated;

drop trigger if exists mention_emit_event_tg on public.mention;
create trigger mention_emit_event_tg
  after insert on public.mention
  for each row execute function public.mention_emit_event();

create or replace function public.reaction_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    case when new.kind = 'like' then 'item.liked' else 'item.disliked' end,
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'user_id', new.user_id,
      'kind', new.kind
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.reaction_emit_event() from public, anon, authenticated;

drop trigger if exists reaction_emit_event_tg on public.reaction;
create trigger reaction_emit_event_tg
  after insert on public.reaction
  for each row execute function public.reaction_emit_event();

create or replace function public.saved_item_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'item.saved',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'user_id', new.user_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.saved_item_emit_event() from public, anon, authenticated;

drop trigger if exists saved_item_emit_event_tg on public.saved_item;
create trigger saved_item_emit_event_tg
  after insert on public.saved_item
  for each row execute function public.saved_item_emit_event();

create or replace function public.share_link_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'item.shared',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'created_by', new.created_by,
      'scope', new.scope
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.share_link_emit_event() from public, anon, authenticated;

drop trigger if exists share_link_emit_event_tg on public.share_link;
create trigger share_link_emit_event_tg
  after insert on public.share_link
  for each row execute function public.share_link_emit_event();
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `collaboration_test.sql .. ok` (33 assertions); definer-audit prints `all definers pinned` (exit 0); `db diff` empty.

- [ ] **Step 4: Gate — every collab trigger function is a pinned definer**

Run:
```bash
grep -cE 'create trigger (comment|mention|reaction|saved_item|share_link)_emit_event_tg' \
  supabase/migrations/20260701000006_collaboration.sql
node scripts/check-definer-audit.mjs
```
Expected: grep prints `5`; definer-audit exits `0` with `all definers pinned`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000006_collaboration.sql supabase/tests/collaboration_test.sql
git commit -m "feat(db): collaboration lifecycle triggers over emit_event"
```

---

## Self-Review

- **Spec coverage (Part A scope):** Five collaboration collections defined config-first (all marked `internal: true`), wired into `defineSchema`/`index.ts`, regenerated + committed (Task 1); composite uniques + entity indexes codegen cannot emit (Task 2); `can_access_entity` gate with member/other-ws/unknown-type semantics (Task 3); fine-grained RLS matrix replacing the blanket `<name>_rw` policies (Task 4); AFTER-INSERT lifecycle triggers fanning out through `emit_event` (Task 5). Each task ends with a machine-checkable gate (`pnpm codegen`+`git diff --exit-code`, `supabase db reset`/`test db`/`db diff`, `check-definer-audit.mjs`, greps).
- **`internal` collections (surfacing decision):** all five collab collections set `internal: true` on their `defineCollection`. The flag is codegen-transparent — `emit-sql`/`emit-types` ignore it, so the base tables, blanket `<name>_rw` RLS, grants, FTS, delete-chunk triggers, metadata rows, and the `*Row/*Create/*Update` types Part B consumes are all still emitted (the added codegen test asserts `comment.internal === true` AND that `emitCollectionSql(comment)` still emits `create table … public.comment`; the `supabase db diff` drift gate stays empty because no SQL changed). Its only effect is that the generic GraphQL/MCP/CLI CRUD surface builders SKIP these collections — the generic surface assumes relations are many-to-many→edges and can't express collab's FK relations (`comment.parent`→`parent_id`, `mention.comment`→`comment_id` required), and generic `createComment` would bypass the atomic mention logic. The collections are reached only through the custom domain ops in **Part B**; the surface-builder skip is implemented there, not in Part A.
- **Contract fidelity (Part B depends on these):**
  - Field defs match the shared contract exactly (labels added per `defineCollection`'s requirement; user refs are `f.uuid`; `comment.parent`/`mention.comment` are relations → `parent_id` nullable self-FK, `comment_id` required FK).
  - `can_access_entity(entity_type text, entity_id uuid, ws uuid) returns boolean` — `SECURITY DEFINER`, `set search_path=''`, member-gate + per-`entity_type` dispatch (`note`, `comment`, else **fail-closed / deny**), `execute` to `authenticated` only. The dispatch `case` is the documented extension seam; because the `else` arm denies, v1 collaboration only attaches to `note`/`comment` entities until a future phase adds `task`/`content` arms.
  - Event names verbatim: `comment.added`/`comment.replied` (parent_id branch), `user.mentioned` (payload `recipient_user_id = mentioned_user_id`), `item.liked`/`item.disliked`, `item.saved`, `item.shared`.
- **`can_access_entity` gate with member/other-ws/unknown-type semantics (Task 3):** unknown `entity_type` now **fails closed** (returns `false`), not member-only. All plan examples/e2e inserts use `entity_type = 'note'` (with `'comment'` reserved for future comment-on-comment); the only `'task'` references are the two fail-closed assertions expecting `false`.
- **Correctness / self-consistency:** collection order (`comment` before `mention`) satisfies the FK; the generated `<Name>Row` shapes shown in Task 1 are exactly what `emit-types.ts` produces for these field defs (verified against `dataFields`-then-`fkFields` ordering and `required || default` nullability rules); the pgTAP `plan(N)` is bumped 12 → 17 → 29 → 33 as blocks are inserted before the single `select * from finish();`.
- **Safety:** the authoritative check is `can_access_entity` (server-side, `SECURITY DEFINER`, RLS-bypassing existence probe against the verified principal via `is_workspace_member((select auth.uid()))`), and its `else` arm **fails closed** so an unknown `entity_type` can never grant access. Writes are gated, not just reads: `comment_update`/`comment_delete` require *current* entity access (a removed member cannot edit/delete their old comment); `saved_item_all` requires workspace membership on `using` and entity access on `with check` (no cross-workspace saves); `mention_insert` requires the referenced comment to exist in the same workspace/entity and be authored by the caller (only a comment's author mints its mentions), AND requires `mentioned_user_id` to be a workspace member — mentions target members only, so the `mention` AFTER-INSERT trigger's `user.mentioned` notify can never fan out to a random or cross-tenant user, consistent with `mention_select`/`inbox_feed`'s membership gate. (Part B's `create_comment_with_mentions` RPC MAY additionally `raise` a `mention_recipient_not_member`-style message for a friendlier error, but this RLS check is the authoritative gate and rolls the whole transaction back regardless.) saved_item stays owner-only; a mention is visible to a mentioned MEMBER or anyone who can access the entity (visibility requires workspace membership — matching Part B's `inbox_feed`, which returns `[]` for non-members); `movp_internal` is read in tests only as the owner (`reset role`), never as `authenticated`. Negative pgTAP assertions (mention targeting a non-member denied, non-member save denied, non-author mention denied, removed-author update/delete no-op) pin each tightening. All new definers pinned (`search_path=''`, schema-qualified) — passes `check-definer-audit.mjs`.
- **Reliability / drift:** every task ends with `supabase db reset` + `supabase db diff` empty; codegen reproducibility pinned by `git diff --exit-code`. The `drop policy if exists` + `drop trigger if exists` guards keep the migration re-runnable in a fresh reset.
- **Observability:** trigger payloads carry ids + entity refs + `recipient_user_id` where a notify is intended; `emit_event` (unchanged) records into `movp_internal.movp_events` and enqueues `notify`/`webhook` jobs with `on conflict do nothing` idempotency.
- **Efficiency / Performance:** entity lookups on `(entity_type, entity_id)` are indexed on all four commentable tables; composite uniques prevent duplicate reactions/saves and enforce token uniqueness. `can_access_entity` is `stable` and does one existence probe per call.
- **Simplicity / Usability:** no speculative types beyond the contract; the `else` arm in `can_access_entity` is the single, documented seam for future entity types — it fails closed (denies), and Task/CMS phases add one `when` arm each before their surfaces go live. No user-facing UI in Part A (deferred to Part B — N/A here).
- **Deferred to Part B (intentional):** domain services, GraphQL/MCP resolvers, notification templates, and any UI — none are needed for the data/access/trigger deliverable and none are touched here.
- **Placeholder scan:** none — every SQL/TS block is complete and copy-paste-ready; every step has an exact command + expected output.
