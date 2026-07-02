# MOVP App — CMS Phase 4, Part A: Content Model & Versioning Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Add the three CMS core collections — `content_type`, `content_item`, `content_revision` — to the config-first schema so codegen emits their base tables + generated types, then hand-author migration `20260701000011_cms_content.sql` for the parts codegen cannot express (the circular `content_item ↔ content_revision` pointer FKs, composite uniques, the hardened immutability guard on the tamper-evidence `content_revision` table, the `public.can_access_entity()` `'content_item'` arm, and the `public.search_fts()` `content_item` arm), then migration `20260701000012_cms_content_rpcs.sql` for the two SECURITY **INVOKER** write RPCs, and finally the `@movp/domain` `content` service that validates + canonicalizes + hashes content data client-side and drives those RPCs.

**Architecture:** Collections are defined in `packages/core-schema/src/collections/`, wired into `defineSchema()` (`schema.ts`) and re-exported (`index.ts`). Running `pnpm codegen` regenerates BOTH `supabase/migrations/20260701000002_movp_generated.sql` (base tables, the blanket `<name>_rw` `is_workspace_member` RLS policy, grants, FTS `search_vector` + trigger + GIN index for searchable fields, metadata registry rows) AND `packages/domain/src/generated/types.ts` (`ContentType*`, `ContentItem*`, `ContentRevision*` — `*Row/*Create/*Update`, **consumed by Parts B/C/D**). ALL three CMS collections are `internal: true` and `workspaceScoped: true`: they are reached **exclusively** through a hand-written `content` domain service (wired into `createDomain`), never through a generic CRUD surface — this avoids the "non-internal collection needs a wired generic service or the builder throws" footgun. User references are plain `f.uuid` columns (never `relation('user')`). Relations emit `<fieldkey>_id` FK columns: `content_item.content_type`→`content_type_id` (required → cascade); `content_revision.item`→`content_item_id` (required → cascade); `content_revision.parent`→`parent_id` (optional self-FK → set null). `content_item.current_revision_id` / `approved_revision_id` / `published_revision_id` are **plain `f.uuid`** (NOT relations) because `content_item → content_revision → content_item` is circular; their FKs are hand-added in `20260701000011`.

**`content_hash` is DOMAIN-computed, not DB-computed** (this differs from the Task RPCs, which hash `p_body` via `extensions.digest` inside the DB). The service Zod-validates `data` against the content type's `field_schema`, canonicalizes the validated payload (stable key ordering, dropped unknown keys, normalized number/string forms — over exactly what is stored, excluding volatile fields like author/timestamps), computes the SHA-256 hex via `crypto.subtle` (`sha256Hex`, copied from `collab.ts`), and passes the hash INTO the RPC as a parameter. The DB stores it verbatim and dedups on it.

**Immutability** of `content_revision` is enforced two ways: (1) RLS SELECT + INSERT policies only — the generated blanket `content_revision_rw` policy is dropped and no UPDATE/DELETE policy replaces it, so an UPDATE/DELETE by an ordinary member matches zero rows (silent no-op — the committed convention); PLUS (2) a hardened `SECURITY DEFINER` guard trigger that raises `sqlstate '2F004'` on UPDATE/DELETE, so even a privileged/service-role write is blocked HARD (justified because this is the audit / tamper-evidence table). `content_type` and `content_item` KEEP their generated blanket `<name>_rw` policies (they are mutable).

**Tech Stack:** TypeScript (`@movp/core-schema`, `@movp/codegen`, `@movp/domain`), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres RLS + `SECURITY DEFINER` / `SECURITY INVOKER`, `crypto.subtle` for content hashing, `zod` (added to `@movp/domain` in Task 4) for data-payload validation, the existing `public.workspace` / `public.workspace_membership` / `public.is_workspace_member(uuid)` tenancy backbone and `public.can_access_entity(text, uuid, uuid)` gate.

**This is Part A of the CMS Phase 4 series.** Build order: after Core + Collaboration (executed; migrations `20260701000001`–`20260701000007`) AND after the Task phase (planned; migrations `20260701000008`–`20260701000010`, applied before CMS). CMS hand-authored migrations therefore start at `20260701000011`. Part A depends on: the codegen pipeline + the `internal?: boolean` flag on `CollectionDef` (added in Collaboration); `public.can_access_entity(text, uuid, uuid)` (committed in `20260701000006_collaboration.sql`, with a `'task'` arm added by the Task phase's `20260701000008_task.sql`); `public.search_fts(uuid, text, text, int)` (committed in `20260701000003_search_fts.sql`, `note`/`tag` arms); the `crypto.subtle` `sha256Hex` helper in `packages/domain/src/collab.ts`; the collab integration-test harness in `packages/domain/test/collab.integration.test.ts`. **Parts B/C/D** (moderation/approval workflow, publishing + assets, GraphQL/MCP/CLI/frontend surfaces) consume the generated `ContentType*`/`ContentItem*`/`ContentRevision*` types, the exact FK column names, the two RPC signatures, and the `ContentService` interface — do NOT rename a field, constraint, column, RPC parameter, or method without updating Parts B/C/D.

## Global Constraints

- **Config-first collections.** New tables are added by defining a collection and running `pnpm codegen` — never by hand-writing a `create table` in a migration. The generated `20260701000002_movp_generated.sql` is a build artifact; commit it, never edit it by hand.
- **`pnpm codegen` is reproducible and committed.** After changing collections, run `pnpm codegen`, commit the regenerated migration AND `packages/domain/src/generated/types.ts`. Re-running codegen must produce no diff (`git diff --exit-code` on both files is clean). CI's migration-drift job (`supabase db reset` → `supabase db diff` empty) fails if the committed migration is stale.
- **Every field needs a `label`.** `defineCollection` throws if any field omits `label` or if an enum has empty `values`; `pnpm codegen` imports the schema and therefore fails loudly on a malformed collection. User references are `f.uuid`, never `relation('user')`. `f.json` maps to a `jsonb` column and a `Record<string, unknown>` TS type.
- **All three CMS collections are `internal: true`.** Part A wires them into `schema.ts` so codegen emits the base tables + types Parts B/C/D consume, but the generic GraphQL/MCP/CLI surface builders skip them (their FK relations and bespoke atomic writes cannot go through the generic surface). They are reached ONLY through the `content` domain service. The two option config tables do NOT exist in CMS — there is no generic-surfaced CMS table in Part A.
- **`content_hash` is DOMAIN-computed and passed as an RPC parameter.** The DB never computes it (no `extensions.digest` in the CMS RPCs). Canonicalization + hashing happen in `content.ts` over the Zod-validated, unknown-key-stripped `data`. The RPC dedups by comparing the passed `p_content_hash` against the current revision's stored `content_hash`.
- **`content_revision` is immutable (append-only).** RLS: drop the generated `content_revision_rw`, keep SELECT + INSERT only. PLUS a hardened `SECURITY DEFINER` guard trigger raising `sqlstate '2F004'` on UPDATE/DELETE. `content_type` and `content_item` keep their generated blanket `<name>_rw` policies unchanged.
- **Known content-addressing constraint (do NOT "fix" the dedup):** `unique(content_item_id, content_hash)` makes each distinct canonical payload appear at most once per item, across ALL revisions. `update_content` dedups only against the CURRENT revision. Therefore reverting an item to the EXACT canonical content of a NON-current earlier revision raises `23505` (not a silent dedup) — this is intended tamper-evident content-addressing, not a bug. The service surfaces it as a bounded `domain.content.update failed [23505]`.
- **Collection order encodes FK dependencies.** `content_type` MUST precede `content_item` (`content_item.content_type_id` → `content_type`). `content_item` MUST precede `content_revision` (`content_revision.content_item_id` → `content_item`). `content_item`'s `*_revision_id` pointer columns are PLAIN uuid, so `content_item` need NOT precede `content_revision` for those — the circular FKs are hand-added in `20260701000011`. `content_revision.parent_id` is a same-statement self-reference.
- **Hand-authored migrations for the rest.** `20260701000011_cms_content.sql` (sorts after the Task phase's `...000010`) holds the pointer FKs, uniques, hot-path indexes, the immutability RLS + guard, the `can_access_entity` `'content_item'` arm, and the `search_fts` `content_item` arm — in that top-to-bottom order (policies/triggers reference objects created above them). `20260701000012_cms_content_rpcs.sql` holds the two INVOKER RPCs. **Name both files literally — do NOT use `supabase migration new`** (it mints a wall-clock timestamp; these filenames must sort right after `...000010`).
- **All `SECURITY DEFINER` functions hardened:** `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon` (and `authenticated` for trigger fns). The re-declared `can_access_entity` stays `SECURITY DEFINER`. The two RPCs are `SECURITY INVOKER` (run under the caller's RLS) but STILL pin `set search_path = ''`, schema-qualify, and `revoke … from public, anon` / `grant … to authenticated`. `node scripts/check-definer-audit.mjs` must stay green.
- **Authoritative authz at the data boundary.** RLS is the gate. The authoritative visibility check is `public.can_access_entity('content_item', content_item_id, workspace_id)`; membership-gated policies use `public.is_workspace_member(workspace_id)`; author checks use `(select auth.uid())`.
- **Per-request dependencies resolved at call time.** `content.ts` reads `ctx.db` / `ctx.userId` from the `DomainCtx` passed into `makeContentService(ctx)` — never module scope.
- **Observability discipline.** The service throws `domain.content.<op> failed [<code>]` with the bounded PostgREST error code only — never a row value, slug, title, or `data` payload.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  packages/
    core-schema/src/
      collections/
        content_type.ts       # NEW (internal: true)
        content_item.ts       # NEW (internal: true)
        content_revision.ts   # NEW (internal: true, immutable)
      schema.ts               # EDIT: append contentType, contentItem, contentRevision
      index.ts                # EDIT: re-export the three collections
    domain/
      src/
        generated/types.ts    # REGENERATED by `pnpm codegen` (commit)
        content.ts            # NEW: makeContentService
        types.ts              # EDIT: ContentService + Domain.content
        domain.ts             # EDIT: wire content: makeContentService(ctx)
        index.ts              # EDIT: export makeContentService + content types
      package.json            # EDIT (Task 4): add zod dependency
      test/content.integration.test.ts   # NEW (clones collab harness)
  supabase/
    migrations/
      20260701000002_movp_generated.sql  # REGENERATED by `pnpm codegen` (commit)
      20260701000011_cms_content.sql      # NEW hand-authored (FKs/uniques/immutability/access/search)
      20260701000012_cms_content_rpcs.sql # NEW hand-authored (two INVOKER RPCs)
    tests/
      cms_content_test.sql                # NEW pgTAP (Task 2)
      cms_content_rpcs_test.sql           # NEW pgTAP (Task 3)
```

---

### Precondition check — Core + Collaboration + Task are merged

Run:
```bash
cd /Users/ensell/Code/supasuite
ls supabase/migrations/20260701000006_collaboration.sql \
   supabase/migrations/20260701000003_search_fts.sql \
   supabase/migrations/20260701000008_task.sql \
   supabase/migrations/20260701000010_task_rpcs.sql >/dev/null 2>&1 && echo MIG_OK || echo MIG_MISSING
grep -q "internal" packages/core-schema/src/types.ts && echo INTERNAL_FLAG_OK || echo INTERNAL_FLAG_MISSING
grep -q "async function sha256Hex" packages/domain/src/collab.ts && echo SHA_OK || echo SHA_MISSING
grep -q "when 'task' then" supabase/migrations/20260701000008_task.sql && echo CANACCESS_TASK_OK || echo CANACCESS_TASK_MISSING
test -f packages/domain/test/collab.integration.test.ts && echo HARNESS_OK || echo HARNESS_MISSING
```
Expected: `MIG_OK`, `INTERNAL_FLAG_OK`, `SHA_OK`, `CANACCESS_TASK_OK`, `HARNESS_OK`. If any check fails, STOP — a prerequisite phase is not merged and this plan cannot execute. (In particular, `CANACCESS_TASK_MISSING` means the Task phase's `'task'` arm is absent; Task 2 below copies the function body verbatim INCLUDING that arm, so it must already exist.)

---

### Task 1: Define the three CMS collections + regenerate

**Files:**
- Create: `packages/core-schema/src/collections/content_type.ts`, `content_item.ts`, `content_revision.ts`
- Edit: `packages/core-schema/src/schema.ts`, `packages/core-schema/src/index.ts`
- Regenerate (do NOT hand-edit): `supabase/migrations/20260701000002_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `f` + `defineCollection` (`packages/core-schema/src/builders.ts`, `define.ts`); the existing note/tag/collaboration/task collections; `CollectionDef.internal`.
- Produces (Parts B/C/D consume): base tables `public.{content_type,content_item,content_revision}` with blanket `<name>_rw` RLS + grants + FTS on `content_item`, and generated types `ContentType*`, `ContentItem*`, `ContentRevision*`.

This task is config + codegen; its gates are `pnpm codegen` succeeding, a clean `supabase db reset`/`db diff`, `pnpm typecheck`, and greps proving the three tables + 9 interfaces + FK columns were emitted (the `internal: true` flag suppresses no SQL).

- [ ] **Step 1: Create `content_type.ts` (internal)**

`packages/core-schema/src/collections/content_type.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentType = defineCollection({
  name: 'content_type',
  label: 'Content Type',
  labelPlural: 'Content Types',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (reached via the content service)
  fields: {
    key: f.text({ label: 'Key', required: true }),
    label: f.text({ label: 'Label', required: true }),
    // f.json -> `jsonb` column, `Record<string, unknown>` TS type. Structural validity
    // (array of {name,type,required?}) is enforced in the content service, NOT the DB.
    field_schema: f.json({ label: 'Field Schema', required: true }),
    moderation_policy: f.enum(['none', 'pre', 'post'], {
      label: 'Moderation Policy',
      default: 'none',
      reporting: { role: 'dimension' },
    }),
    approval_policy: f.enum(['none', 'single', 'multi'], {
      label: 'Approval Policy',
      default: 'none',
      reporting: { role: 'dimension' },
    }),
  },
})
```

- [ ] **Step 2: Create `content_item.ts` (internal)**

`packages/core-schema/src/collections/content_item.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentItem = defineCollection({
  name: 'content_item',
  label: 'Content Item',
  labelPlural: 'Content Items',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped (reached via the content service)
  fields: {
    // Required relation -> `content_type_id uuid not null references public.content_type(id) on delete cascade`.
    content_type: f.relation('content_type', { label: 'Content Type', cardinality: 'many-to-one', required: true }),
    slug: f.text({ label: 'Slug', required: true }),
    status: f.enum(['draft', 'in_review', 'approved', 'published', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
    // PLAIN uuid, NOT relations: content_item <-> content_revision is circular, so codegen
    // cannot inline these. The FKs current/approved/published_revision_fk are hand-added in
    // 20260701000011_cms_content.sql. Each emits `<name> uuid` (nullable, no FK here).
    current_revision_id: f.uuid({ label: 'Current Revision' }),
    approved_revision_id: f.uuid({ label: 'Approved Revision' }),
    published_revision_id: f.uuid({ label: 'Published Revision' }),
    published_at: f.datetime({ label: 'Published At' }),
    // Searchable fields -> generated `search_vector` tsvector + trigger + GIN index.
    search_text: f.text({ label: 'Search Text', searchable: true }),
    search_body: f.richText({ label: 'Search Body', searchable: true, embeddable: true }),
  },
})
```

- [ ] **Step 3: Create `content_revision.ts` (internal, immutable)**

`packages/core-schema/src/collections/content_revision.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentRevision = defineCollection({
  name: 'content_revision',
  label: 'Content Revision',
  labelPlural: 'Content Revisions',
  workspaceScoped: true,
  internal: true, // DB table + types still generated; generic CRUD surface skipped. Immutable (hand-added guard in 000011).
  fields: {
    // Required relation -> `content_item_id uuid not null references public.content_item(id) on delete cascade`.
    item: f.relation('content_item', { label: 'Item', cardinality: 'many-to-one', required: true }),
    revision_number: f.number({ label: 'Revision Number', required: true }),
    // f.json -> `jsonb` column, `Record<string, unknown>` TS type. Stores the canonical data.
    data: f.json({ label: 'Data', required: true }),
    // Domain-computed SHA-256 hex of the canonical data (NOT computed in the DB).
    content_hash: f.text({ label: 'Content Hash', required: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
    // Optional self-relation -> `parent_id uuid references public.content_revision(id) on delete set null`.
    parent: f.relation('content_revision', { label: 'Parent Revision', cardinality: 'many-to-one' }),
  },
})
```

- [ ] **Step 4: Wire the collections into the schema**

In `packages/core-schema/src/schema.ts`, add three imports (alphabetically, right after the `comment` import) and append the three collections to `defineSchema([...])` after the last task collection. The file after editing (the note/tag/collaboration/task collections are present from prior phases — reproduce them exactly as committed, then add the three CMS lines):
```ts
import { comment } from './collections/comment.ts'
import { contentItem } from './collections/content_item.ts'
import { contentRevision } from './collections/content_revision.ts'
import { contentType } from './collections/content_type.ts'
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

// Order encodes FK dependencies. CMS (Phase 4, Part A) appends last:
//  - content_type precedes content_item (content_item.content_type_id -> content_type).
//  - content_item precedes content_revision (content_revision.content_item_id -> content_item).
//  - content_item.*_revision_id are PLAIN uuid, so the circular FKs are hand-added in
//    20260701000011_cms_content.sql.
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
  contentType,
  contentItem,
  contentRevision,
])
```
> If the merged Task phase produced a different collection set/order, keep that exact prefix and only APPEND `contentType, contentItem, contentRevision` (in that order) — do not reorder existing entries.

In `packages/core-schema/src/index.ts`, add three re-exports (alphabetically, right after `export { comment } …`):
```ts
export { contentItem } from './collections/content_item.ts'
export { contentRevision } from './collections/content_revision.ts'
export { contentType } from './collections/content_type.ts'
```

- [ ] **Step 5: Regenerate**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints `wrote .../supabase/migrations/20260701000002_movp_generated.sql` and `wrote .../packages/domain/src/generated/types.ts`, exit 0. (A missing `label` or empty enum `values` makes `defineCollection` throw here — fix the collection and re-run.)

`packages/domain/src/generated/types.ts` will now contain the interfaces below (codegen output — **verify, do NOT hand-edit; Parts B/C/D import these**). Column ORDER is `id`, `workspace_id`, then data fields in definition order, then FK `_id` columns in definition order, then `created_at`, `updated_at`. Nullability is `required || default` → non-null, else nullable. Scalar TS types (e.g. whether `numeric` maps to `number` or `string`) are whatever `emit-types.ts` produces — the committed file is authoritative; the shapes below are load-bearing only for the FK `_id` column NAMES and their nullability (Parts B/C/D depend on `content_type_id`, `content_item_id`, `parent_id`, and the plain `current_revision_id`/`approved_revision_id`/`published_revision_id`):
```ts
export interface ContentTypeRow {
  id: string
  workspace_id: string
  key: string
  label: string
  field_schema: Record<string, unknown>
  moderation_policy: 'none' | 'pre' | 'post'
  approval_policy: 'none' | 'single' | 'multi'
  created_at: string
  updated_at: string
}

export interface ContentItemRow {
  id: string
  workspace_id: string
  slug: string
  status: 'draft' | 'in_review' | 'approved' | 'published' | 'archived'
  current_revision_id: string | null    // plain uuid; FK added in 000011
  approved_revision_id: string | null    // plain uuid; FK added in 000011
  published_revision_id: string | null   // plain uuid; FK added in 000011
  published_at: string | null
  search_text: string | null
  search_body: string | null
  content_type_id: string                // FK -> content_type (required)
  created_at: string
  updated_at: string
}

export interface ContentRevisionRow {
  id: string
  workspace_id: string
  revision_number: number
  data: Record<string, unknown>
  content_hash: string
  author_id: string
  content_item_id: string                // FK -> content_item (required)
  parent_id: string | null               // self-FK (optional)
  created_at: string
  updated_at: string
}
// Codegen also emits a *Create and *Update interface per collection (9 interfaces total).
```

- [ ] **Step 6: Apply + drift check + typecheck**

Run:
```bash
supabase db reset && supabase db diff && pnpm typecheck
```
Expected: `db reset` applies the regenerated migration cleanly (the three tables + blanket `<name>_rw` policies + `content_item` FTS are created); `supabase db diff` prints **nothing** (no drift); `pnpm typecheck` PASSES.

- [ ] **Step 7: Machine-checkable gate — tables + types + FK columns emitted, codegen reproducible**

Run:
```bash
cd /Users/ensell/Code/supasuite
grep -cE 'create table if not exists public\.(content_type|content_item|content_revision) \(' \
  supabase/migrations/20260701000002_movp_generated.sql
grep -cE 'interface (ContentType|ContentItem|ContentRevision)(Row|Create|Update)' \
  packages/domain/src/generated/types.ts
grep -cE '(content_type_id|content_item_id|parent_id|current_revision_id|approved_revision_id|published_revision_id)' \
  packages/domain/src/generated/types.ts
grep -c 'content_item_search_vector_update' supabase/migrations/20260701000002_movp_generated.sql
pnpm codegen && git diff --exit-code \
  supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
```
Expected: first grep prints `3` (all three tables emitted, INCLUDING the `internal: true` ones — the flag suppresses no SQL); second grep prints `9` (3 collections × Row/Create/Update); third grep is `>= 6` (the FK `_id` columns + the three plain `*_revision_id` columns are present); fourth grep is `>= 1` (`content_item` got a `search_vector` trigger because it has searchable fields); the `git diff --exit-code` exits `0` (re-running codegen changed nothing — reproducible).

- [ ] **Step 8: Commit**

```bash
git add packages/core-schema/src supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
git commit -m "feat(schema): add CMS content collections (content_type + content_item + content_revision)"
```

---

### Task 2: Migration `000011` — pointer FKs, uniques, immutability, `can_access_entity` + `search_fts` arms + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000011_cms_content.sql`
- Create: `supabase/tests/cms_content_test.sql`

**Interfaces:**
- Consumes: the three generated tables from Task 1; `public.content_revision(id)` (for the pointer FKs); `public.is_workspace_member(uuid)`; the committed `public.can_access_entity(text, uuid, uuid)` (note/comment/task arms) and `public.search_fts(uuid, text, text, int)` (note/tag arms); `content_item.search_vector` (generated).
- Produces: pointer FKs `content_item_current_revision_fk`, `content_item_approved_revision_fk`, `content_item_published_revision_fk`; uniques `content_item_type_slug_uniq`, `content_revision_number_uniq`, `content_revision_content_uniq`; indexes `content_item_type_idx`, `content_item_status_idx`, `content_revision_item_idx`; RLS `content_revision_select`/`content_revision_insert` (blanket `content_revision_rw` dropped); guard fn `public.content_revision_immutable()` + trigger `content_revision_no_mutate`; a re-declared `public.can_access_entity` with a `'content_item'` arm; a re-declared `public.search_fts` with a `content_item` arm. **Invariants:** (1) `content_type` and `content_item` keep their generated `<name>_rw` blanket policies (NOT dropped). (2) `content_revision` has NO UPDATE/DELETE policy → immutable. (3) The `can_access_entity` `'note'`/`'comment'`/`'task'` arms and the fail-closed `else` are preserved byte-for-byte; only the `'content_item'` arm is inserted before the `else`. (4) The `search_fts` `note`/`tag` arms are preserved byte-for-byte; only the `content_item` arm is inserted before the `else`. (5) Every `SECURITY DEFINER` function pins `set search_path = ''`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/cms_content_test.sql`. The base seed runs as the table owner (RLS bypassed): W1 with members A (owner) and C (member), B is NOT a member; a content_type CT1, a content_item CI1 (draft, `search_text = 'welcome home page'`), and revision #1 pointed at by `current_revision_id`:
```sql
begin;
select plan(20);

-- ── base seed (as table owner; RLS bypassed) ────────────────────────────────
-- W1 members: A (owner), C (member). B is NOT a member of W1.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

insert into public.content_type (id, workspace_id, key, label, field_schema, moderation_policy, approval_policy)
  values ('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
          'page', 'Page', '[{"name":"title","type":"text","required":true}]'::jsonb, 'none', 'none');

insert into public.content_item (id, workspace_id, content_type_id, slug, status, search_text)
  values ('c1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
          'c1000000-0000-0000-0000-000000000001', 'home', 'draft', 'welcome home page');

insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
  values ('c1000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111',
          'c1000000-0000-0000-0000-0000000000a1', 1, '{"title":"Home"}'::jsonb, 'hash-rev-1',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

update public.content_item set current_revision_id = 'c1000000-0000-0000-0000-0000000000b1'
  where id = 'c1000000-0000-0000-0000-0000000000a1';

-- ── tables ──────────────────────────────────────────────────────────────────
select has_table('public', 'content_type',     'content_type table exists');
select has_table('public', 'content_item',     'content_item table exists');
select has_table('public', 'content_revision', 'content_revision table exists');

-- ── pointer back-FKs (circular; codegen cannot inline) ──────────────────────
select is((select count(*)::int from pg_constraint where conname='content_item_current_revision_fk' and contype='f'),
          1, 'content_item.current_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='content_item_approved_revision_fk' and contype='f'),
          1, 'content_item.approved_revision_id back-FK exists');
select is((select count(*)::int from pg_constraint where conname='content_item_published_revision_fk' and contype='f'),
          1, 'content_item.published_revision_id back-FK exists');

-- ── composite uniques ────────────────────────────────────────────────────────
select is((select count(*)::int from pg_constraint where conname='content_item_type_slug_uniq' and contype='u'),
          1, 'content_item (workspace_id, content_type_id, slug) unique');
select is((select count(*)::int from pg_constraint where conname='content_revision_number_uniq' and contype='u'),
          1, 'content_revision (content_item_id, revision_number) unique');
select is((select count(*)::int from pg_constraint where conname='content_revision_content_uniq' and contype='u'),
          1, 'content_revision (content_item_id, content_hash) unique');

-- ── hot-path indexes ─────────────────────────────────────────────────────────
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_item_type_idx'),
          1, 'content_item (workspace_id, content_type_id) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_item_status_idx'),
          1, 'content_item (workspace_id, status) index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='content_revision_item_idx'),
          1, 'content_revision (content_item_id) index exists');

-- ── immutability: blanket rw dropped, no UPDATE/DELETE policy ────────────────
select is((select count(*)::int from pg_policies where schemaname='public'
             and tablename='content_revision' and policyname='content_revision_rw'),
          0, 'blanket content_revision_rw policy dropped');
select is((select count(*)::int from pg_policies where schemaname='public'
             and tablename='content_revision' and cmd in ('UPDATE','DELETE')),
          0, 'content_revision has no UPDATE/DELETE policy (immutable)');

-- ── immutability guard trigger raises 2F004 on UPDATE and DELETE ─────────────
-- (owner bypasses RLS, so the guard trigger — not the RLS omission — is the gate here.)
select throws_ok(
  $$update public.content_revision set content_hash='tampered'
     where id='c1000000-0000-0000-0000-0000000000b1'$$,
  '2F004', NULL, 'content_revision UPDATE is blocked by the immutability guard');
select throws_ok(
  $$delete from public.content_revision where id='c1000000-0000-0000-0000-0000000000b1'$$,
  '2F004', NULL, 'content_revision DELETE is blocked by the immutability guard');

-- ── can_access_entity('content_item', ...) (act as member A, then non-member B) ──
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'),
          true,  'member + item in ws -> true (content_item arm resolves against public.content_item)');
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000ff','11111111-1111-1111-1111-111111111111'),
          false, 'member + absent item -> false');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('content_item','c1000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false (base gate) even for an existing item');

-- ── search_fts content_item arm (act as member A) ───────────────────────────
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.search_fts(
             '11111111-1111-1111-1111-111111111111', 'content_item', 'welcome', 10)),
          1, 'search_fts content_item arm returns the matching item');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `cms_content_test.sql` fails the pointer-FK, unique, index, policy, and guard assertions (none exist yet); both `throws_ok` fail (the UPDATE/DELETE succeed instead of raising); `can_access_entity('content_item', …)` returns `false` for the member (the current function hits the fail-closed `else`) but the assertion expects `true`; `search_fts(…, 'content_item', …)` raises `unsupported search table`. The `has_table` assertions pass (Task 1 created the tables). All other test files still pass. **The seed itself must apply cleanly** — if it errors, a table/column name is wrong; fix before proceeding.

- [ ] **Step 3: Create the migration**

Create `supabase/migrations/20260701000011_cms_content.sql` (exact path — do NOT use `supabase migration new`; this filename must sort right after `20260701000010_task_rpcs.sql`):
```sql
-- CMS Phase 4 — Part A. Sorts AFTER 20260701000010_task_rpcs.sql.
-- Hand-authored: the circular content_item<->content_revision pointer FKs, uniques + hot-path
-- indexes codegen cannot emit, the content_revision immutability RLS + hardened guard trigger,
-- the can_access_entity 'content_item' arm, and the search_fts 'content_item' arm.

-- ── circular pointer FKs codegen cannot inline ───────────────────────────────
alter table public.content_item
  add constraint content_item_current_revision_fk
  foreign key (current_revision_id) references public.content_revision(id) on delete set null;
alter table public.content_item
  add constraint content_item_approved_revision_fk
  foreign key (approved_revision_id) references public.content_revision(id) on delete set null;
alter table public.content_item
  add constraint content_item_published_revision_fk
  foreign key (published_revision_id) references public.content_revision(id) on delete set null;

-- ── composite uniques codegen cannot emit ────────────────────────────────────
alter table public.content_item
  add constraint content_item_type_slug_uniq unique (workspace_id, content_type_id, slug);
alter table public.content_revision
  add constraint content_revision_number_uniq unique (content_item_id, revision_number);
-- Content-addressing: each distinct canonical payload appears at most once per item.
alter table public.content_revision
  add constraint content_revision_content_uniq unique (content_item_id, content_hash);

-- ── hot-path indexes ─────────────────────────────────────────────────────────
create index content_item_type_idx     on public.content_item     (workspace_id, content_type_id);
create index content_item_status_idx   on public.content_item     (workspace_id, status);
create index content_revision_item_idx on public.content_revision (content_item_id);

-- ── content_revision immutability: RLS (SELECT+INSERT only) + hardened guard ──
-- Drop the generated blanket rw policy. No UPDATE/DELETE policy -> an ordinary member's
-- UPDATE/DELETE matches zero rows (silent no-op). content_type / content_item keep their
-- generated <name>_rw policies unchanged (they are mutable).
drop policy if exists content_revision_rw on public.content_revision;
create policy content_revision_select on public.content_revision for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_revision_insert on public.content_revision for insert to authenticated
  with check (public.is_workspace_member(workspace_id)
             and author_id = (select auth.uid()));

-- Hardened guard: even a privileged / service-role write (which bypasses RLS) is blocked
-- HARD on UPDATE/DELETE, because this is the audit / tamper-evidence table. SECURITY DEFINER
-- + empty search_path; execute revoked from everyone (trigger fns need no caller grant).
create or replace function public.content_revision_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'content_revision is append-only and immutable (tamper-evidence)'
    using errcode = '2F004';
end;
$$;
revoke all on function public.content_revision_immutable() from public, anon, authenticated;

create trigger content_revision_no_mutate
  before update or delete on public.content_revision
  for each row execute function public.content_revision_immutable();

-- ── can_access_entity: add the 'content_item' arm (re-declares the full function) ──
-- Verbatim copy of the body as it stands after 20260701000008_task.sql (note/comment/task
-- arms) with a single 'content_item' branch added before the else. SECURITY DEFINER so the
-- existence probe bypasses RLS; empty search_path; params qualified with the function name.
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
    when 'content_item' then
      select exists (
        select 1 from public.content_item ci
        where ci.id = can_access_entity.entity_id
          and ci.workspace_id = can_access_entity.ws
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

-- ── search_fts: add the 'content_item' arm (re-declares the full function) ───
-- Verbatim copy of the 20260701000003 body (note/tag arms) with a 'content_item' branch added
-- before the else. content_item has no dedicated title column, so search_text is the title and
-- the snippet is headlined over search_body (falling back to search_text). SECURITY INVOKER
-- (default): the query runs under the caller's RLS. Empty search_path.
create or replace function public.search_fts(ws uuid, src_table text, q text, lim int default 10)
returns table(id uuid, title text, snippet text, score real)
language plpgsql
set search_path = ''
as $$
begin
  if src_table = 'note' then
    return query
    select n.id,
           n.title,
           ts_headline('english', coalesce(n.body, n.title), plainto_tsquery('english', q)) as snippet,
           ts_rank(n.search_vector, plainto_tsquery('english', q))::real as score
      from public.note n
     where n.workspace_id = ws
       and n.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  elsif src_table = 'tag' then
    return query
    select t.id,
           t.name as title,
           t.name as snippet,
           ts_rank(t.search_vector, plainto_tsquery('english', q))::real as score
      from public.tag t
     where t.workspace_id = ws
       and t.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  elsif src_table = 'content_item' then
    return query
    select ci.id,
           ci.search_text as title,
           ts_headline('english', coalesce(ci.search_body, ci.search_text, ''), plainto_tsquery('english', q)) as snippet,
           ts_rank(ci.search_vector, plainto_tsquery('english', q))::real as score
      from public.content_item ci
     where ci.workspace_id = ws
       and ci.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  else
    raise exception 'unsupported search table';
  end if;
end;
$$;
revoke all on function public.search_fts(uuid,text,text,int) from public, anon;
grant execute on function public.search_fts(uuid,text,text,int) to authenticated;
```

- [ ] **Step 4: Apply + test + definer audit + drift check**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: migration applies; `cms_content_test.sql .. ok` (all 20 assertions pass); every other test file still `ok`; definer-audit prints `all definers pinned` (exit 0) — `content_revision_immutable` and the re-declared `can_access_entity` both have pinned `search_path`; `supabase db diff` prints nothing (no drift).

- [ ] **Step 5: Gate — the note/comment/task arms survived the re-declarations**

Run:
```bash
grep -cE "when '(note|comment|task|content_item)' then" supabase/migrations/20260701000011_cms_content.sql
grep -cE "src_table = '(note|tag|content_item)'" supabase/migrations/20260701000011_cms_content.sql
```
Expected: first grep prints `4` (the `can_access_entity` re-declaration kept note/comment/task and added content_item); second grep prints `3` (the `search_fts` re-declaration kept note/tag and added content_item).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000011_cms_content.sql supabase/tests/cms_content_test.sql
git commit -m "feat(db): CMS content pointer FKs, uniques, immutability guard, can_access_entity + search_fts content_item arms"
```

---

### Task 3: Migration `000012` — the two INVOKER content RPCs + pgTAP

Two `public` SECURITY **INVOKER** write RPCs granted to `authenticated`, mirroring the committed Task RPCs' structure but with `content_hash` passed as a PARAMETER (no `extensions.digest` in the DB). `create_content_with_revision` inserts a content_item, inserts its first immutable `content_revision` (revision_number 1), and points `current_revision_id` at it — all in one transaction. `update_content` compares the passed `p_content_hash` to the current revision's `content_hash`; if equal it updates only `search_text`/`search_body` and returns the item unchanged (dedupe); otherwise it inserts a new immutable revision (revision_number = max+1, `parent_id` = the prior current revision) and advances `current_revision_id`. Both run under the caller's RLS.

**Files:**
- Create: `supabase/migrations/20260701000012_cms_content_rpcs.sql`
- Create: `supabase/tests/cms_content_rpcs_test.sql`

**Interfaces produced:**
- `public.create_content_with_revision(ws uuid, p_content_type_id uuid, p_slug text, p_data jsonb, p_content_hash text, p_search_text text, p_search_body text) returns jsonb` (INVOKER, `search_path=''`, `authenticated`).
- `public.update_content(p_item_id uuid, p_data jsonb, p_content_hash text, p_search_text text, p_search_body text) returns jsonb` (INVOKER, `search_path=''`, `authenticated`).

- [ ] **Step 1: Write the failing pgTAP test**

`supabase/tests/cms_content_rpcs_test.sql`:
```sql
begin;
select plan(16);

-- ── structure + grants ───────────────────────────────────────────────────────
select has_function('public', 'create_content_with_revision',
  array['uuid','uuid','text','jsonb','text','text','text'], 'create_content_with_revision exists');
select has_function('public', 'update_content',
  array['uuid','jsonb','text','text','text'], 'update_content exists');
select is(has_function_privilege('authenticated',
  'public.create_content_with_revision(uuid,uuid,text,jsonb,text,text,text)', 'execute'),
  true, 'authenticated can execute create_content_with_revision');
select is(has_function_privilege('anon',
  'public.create_content_with_revision(uuid,uuid,text,jsonb,text,text,text)', 'execute'),
  false, 'anon cannot execute create_content_with_revision');
select is(has_function_privilege('authenticated',
  'public.update_content(uuid,jsonb,text,text,text)', 'execute'),
  true, 'authenticated can execute update_content');
select is(has_function_privilege('anon',
  'public.update_content(uuid,jsonb,text,text,text)', 'execute'),
  false, 'anon cannot execute update_content');

-- ── seed as superuser (reset role bypasses RLS) ─────────────────────────────
reset role;
insert into public.workspace (id, name)
  values ('77777777-7777-7777-7777-777777777777', 'CmsWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('77777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
insert into public.content_type (id, workspace_id, key, label, field_schema)
  values ('c7000000-0000-0000-0000-000000000001', '77777777-7777-7777-7777-777777777777',
          'page', 'Page', '[{"name":"title","type":"text"}]'::jsonb)
  on conflict (id) do nothing;

-- ── act as the member ────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- create returns an item with an id (hash is a PARAM, not DB-computed)
select ok(
  (public.create_content_with_revision(
     '77777777-7777-7777-7777-777777777777', 'c7000000-0000-0000-0000-000000000001', 'about',
     '{"title":"About"}'::jsonb, 'hash-A', 'About', ''
   ) ->> 'id') is not null,
  'create_content_with_revision returns an item with an id');

-- exactly one revision at creation
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id
    where ci.workspace_id = '77777777-7777-7777-7777-777777777777' and ci.slug = 'about'),
  1, 'create writes exactly one revision');

-- current_revision_id points at revision #1 (revision_number = 1)
select is(
  (select case when ci.current_revision_id = r.id and r.revision_number = 1 then 1 else 0 end
     from public.content_item ci join public.content_revision r on r.content_item_id = ci.id
    where ci.slug = 'about'),
  1, 'current_revision_id points at revision #1 (revision_number = 1)');

-- update with the SAME hash -> dedupe: still one revision, but search_text IS updated
select public.update_content(
  (select id from public.content_item where slug = 'about'),
  '{"title":"About"}'::jsonb, 'hash-A', 'About v2', '');
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id where ci.slug = 'about'),
  1, 'identical hash does not add a revision (dedupe)');
select is(
  (select ci.search_text from public.content_item ci where ci.slug = 'about'),
  'About v2', 'dedupe path still updates search_text');

-- update with a NEW hash -> two revisions, current advanced, parent_id = revision #1
select public.update_content(
  (select id from public.content_item where slug = 'about'),
  '{"title":"About Us"}'::jsonb, 'hash-B', 'About Us', '');
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id where ci.slug = 'about'),
  2, 'a changed hash adds a second revision');
select is(
  (select r.revision_number from public.content_item ci
     join public.content_revision r on r.id = ci.current_revision_id where ci.slug = 'about'),
  2, 'current advanced to revision_number 2');
select is(
  (select r2.parent_id from public.content_item ci
     join public.content_revision r2 on r2.id = ci.current_revision_id where ci.slug = 'about'),
  (select r1.id from public.content_revision r1 join public.content_item ci on ci.id = r1.content_item_id
    where ci.slug = 'about' and r1.revision_number = 1),
  'revision #2 parent_id points at revision #1');
select is(
  (select r.content_hash from public.content_item ci
     join public.content_revision r on r.id = ci.current_revision_id where ci.slug = 'about'),
  'hash-B', 'current revision carries the passed hash');

-- every revision is workspace-scoped (workspace_id NOT NULL, inherited from the item)
select is(
  (select count(*)::int from public.content_revision r
     join public.content_item ci on ci.id = r.content_item_id
    where ci.slug = 'about' and r.workspace_id = ci.workspace_id),
  2, 'every revision inherits the item workspace_id (workspace-scoped)');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
supabase db reset && supabase test db
```
Expected: FAIL — `function public.create_content_with_revision(uuid, uuid, text, jsonb, text, text, text) does not exist`. (`db reset` applies Tasks 1–2 first; the pgTAP references their tables.)

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260701000012_cms_content_rpcs.sql`:
```sql
-- CMS content RPCs: two SECURITY INVOKER writes. content_item + content_revision are internal
-- (custom-op-only). A content_item and its first immutable revision must commit together and
-- current_revision_id must point at the newly-inserted revision — a single transactional
-- INVOKER RPC does this under the CALLER's RLS. content_hash is DOMAIN-computed (canonical
-- JSON SHA-256 in the content service) and passed IN as p_content_hash — the DB never hashes.
-- Both functions pin search_path=''.

create or replace function public.create_content_with_revision(
  ws uuid,
  p_content_type_id uuid,
  p_slug text,
  p_data jsonb,
  p_content_hash text,
  p_search_text text,
  p_search_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_item_id uuid;
  new_rev_id uuid;
  result jsonb;
begin
  insert into public.content_item (workspace_id, content_type_id, slug, status, search_text, search_body)
    values (ws, p_content_type_id, p_slug, 'draft', p_search_text, p_search_body)
    returning id into new_item_id;

  -- author_id resolved at call time from the JWT; NEVER trust a client-passed author.
  -- content_revision is workspace-scoped (workspace_id NOT NULL) — use the item's ws.
  insert into public.content_revision (workspace_id, content_item_id, revision_number, data, content_hash, author_id)
    values (ws, new_item_id, 1, p_data, p_content_hash, (select auth.uid()))
    returning id into new_rev_id;

  update public.content_item set current_revision_id = new_rev_id where id = new_item_id;

  select to_jsonb(ci) into result from public.content_item ci where ci.id = new_item_id;
  return result;
end;
$$;

create or replace function public.update_content(
  p_item_id uuid,
  p_data jsonb,
  p_content_hash text,
  p_search_text text,
  p_search_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_parent uuid;
  current_hash text;
  next_number int;
  new_rev_id uuid;
  result jsonb;
begin
  -- Resolve the item's workspace, current-revision id, and current-revision hash under the
  -- caller's RLS. LEFT join so an item with no current revision still yields its workspace_id;
  -- an item the caller cannot read yields no row (v_ws stays null).
  select ci.workspace_id, ci.current_revision_id, r.content_hash
    into v_ws, v_parent, current_hash
    from public.content_item ci
    left join public.content_revision r on r.id = ci.current_revision_id
   where ci.id = p_item_id;

  -- Not found / inaccessible under RLS -> stable error (content_revision.workspace_id is
  -- NOT NULL, so we must have the ws before inserting).
  if v_ws is null then
    raise exception 'content item not found or inaccessible' using errcode = 'no_data_found';
  end if;

  -- Dedupe against the CURRENT revision only: identical canonical content -> no new revision.
  -- Still refresh the search projection (search_text/search_body may have changed derivation).
  if current_hash is not null and current_hash = p_content_hash then
    update public.content_item
       set search_text = p_search_text, search_body = p_search_body
     where id = p_item_id;
    select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
    return result;
  end if;

  -- New content -> append an immutable revision (revision_number = max+1, parent = prior current).
  -- NOTE: unique(content_item_id, content_hash) means reverting to a NON-current earlier
  -- revision's exact canonical content raises 23505 by design (content-addressed history).
  select coalesce(max(revision_number), 0) + 1 into next_number
    from public.content_revision where content_item_id = p_item_id;

  insert into public.content_revision (workspace_id, content_item_id, revision_number, data, content_hash, author_id, parent_id)
    values (v_ws, p_item_id, next_number, p_data, p_content_hash, (select auth.uid()), v_parent)
    returning id into new_rev_id;

  update public.content_item
     set current_revision_id = new_rev_id, search_text = p_search_text, search_body = p_search_body
   where id = p_item_id;

  select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
  return result;
end;
$$;

-- INVOKER write RPCs: revoke from public/anon, grant to authenticated only.
revoke all on function public.create_content_with_revision(uuid, uuid, text, jsonb, text, text, text) from public, anon;
revoke all on function public.update_content(uuid, jsonb, text, text, text) from public, anon;
grant execute on function public.create_content_with_revision(uuid, uuid, text, jsonb, text, text, text) to authenticated;
grant execute on function public.update_content(uuid, jsonb, text, text, text) to authenticated;
```

> **Why `SECURITY INVOKER` (not `DEFINER`).** Both functions must run under the caller's RLS so the workspace-membership + author-scoping policies on `content_item` and `content_revision` are enforced on the inserts. Because the first revision is inserted in the SAME transaction as the item, an item the caller cannot write rolls the whole thing back — no orphan item persists. They carry `set search_path = ''` and full schema-qualification like the DEFINER functions, but `check-definer-audit.mjs` does not flag them (they are not definers).

- [ ] **Step 4: Apply, run the test, drift + definer gates**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: migration applies; `cms_content_rpcs_test.sql .. ok` (16 assertions pass); every other test file still `ok`; definer-audit prints `all definers pinned`; `db diff` reports no schema changes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000012_cms_content_rpcs.sql supabase/tests/cms_content_rpcs_test.sql
git commit -m "feat(db): create_content_with_revision + update_content RPCs (invoker, authenticated, hash-as-param)"
```

---

### Task 4: Domain `content` service + `createDomain` wiring + integration test

Add `zod` to `@movp/domain`; implement `makeContentService(ctx)` in `packages/domain/src/content.ts` (structural field_schema type-guard, Zod data validation, canonicalization, `crypto.subtle` hashing, search derivation, RPC drive); add `ContentService` to `types.ts` and extend `Domain`; wire `content` into `createDomain`; export from `index.ts`. The three CMS collections are `internal` and reached ONLY through this custom service. The test is the domain integration test (requires the local stack + Tasks 1–3).

**Files:**
- Edit: `packages/domain/package.json` (add `zod`)
- Create: `packages/domain/src/content.ts`
- Edit: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/content.integration.test.ts`

**Interfaces produced:** `makeContentService(ctx: DomainCtx): ContentService`; `Domain.content`; the `ContentService` type.

- [ ] **Step 1: Add the `zod` dependency**

The content service validates a data payload against the type's `field_schema` with Zod; `zod` is not yet a `@movp/domain` dependency. In `packages/domain/package.json`, add to `"dependencies"` (alongside `@supabase/supabase-js`):
```json
    "zod": "^3.23.8"
```
Then install:
```bash
cd /Users/ensell/Code/supasuite && pnpm install
```
Expected: `pnpm install` resolves and writes `pnpm-lock.yaml` with `zod@3.23.x`, exit 0.

- [ ] **Step 2: Write the failing integration test**

`packages/domain/test/content.integration.test.ts` (clones `packages/domain/test/collab.integration.test.ts`'s `serviceClient`/`userClient`/`assertOk`/`makeUser`/`makeWorkspace`/`addMember` helpers verbatim — copy them, then add the test below):
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
  const email = `content-${crypto.randomUUID()}@example.test`
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

describe('content integration', () => {
  it('createType (+ malformed rejected), create rev1+hash, dedupe, real edit rev2+parent, Zod rejection, cross-ws', async () => {
    const ws1 = await makeWorkspace('Content WS')
    const ws2 = await makeWorkspace('Other WS')
    const owner = await makeUser()
    await addMember(ws1, owner.id)
    const ownerDomain = createDomain({ db: userClient(owner.token), userId: owner.id })
    const adminDb = serviceClient()

    // createType with a VALID field_schema
    const ct = await ownerDomain.content.createType({
      workspaceId: ws1, key: 'article', label: 'Article',
      fieldSchema: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richtext' },
        { name: 'rank', type: 'number' },
      ],
    })
    expect(ct.key).toBe('article')

    // MALFORMED field_schema is rejected (a parseable JSON is NOT a valid schema)
    await expect(ownerDomain.content.createType({
      workspaceId: ws1, key: 'bad', label: 'Bad',
      fieldSchema: { title: 'text' }, // not an array of {name,type}
    })).rejects.toThrow(/invalid field_schema/)

    // create an item -> revision 1, content_hash set, current_revision_id set
    const item = await ownerDomain.content.create({
      workspaceId: ws1, contentTypeId: ct.id, slug: 'hello',
      data: { title: 'Hello', body: '<p>Hi</p>', rank: 1 },
    })
    expect(item.slug).toBe('hello')
    expect(item.current_revision_id).toBeTruthy()
    const rev1 = await adminDb.from('content_revision').select('*').eq('content_item_id', item.id)
    const rev1Rows = (rev1.data ?? []) as Array<{ content_hash: string; revision_number: number }>
    expect(rev1Rows.length).toBe(1)
    expect(rev1Rows[0].content_hash).toBeTruthy()
    expect(rev1Rows[0].revision_number).toBe(1)

    // update with CANONICALLY-IDENTICAL data (reordered keys) -> dedupe, no revision 2
    const deduped = await ownerDomain.content.update({
      itemId: item.id, data: { rank: 1, title: 'Hello', body: '<p>Hi</p>' },
    })
    expect(deduped.id).toBe(item.id)
    const afterDedupe = await adminDb.from('content_revision').select('id').eq('content_item_id', item.id)
    expect((afterDedupe.data ?? []).length).toBe(1)

    // a REAL edit -> revision 2 with parent_id = revision 1
    await ownerDomain.content.update({ itemId: item.id, data: { title: 'Hello 2', body: '<p>Hi</p>', rank: 2 } })
    const revs = await adminDb.from('content_revision').select('*')
      .eq('content_item_id', item.id).order('revision_number', { ascending: true })
    const rows = (revs.data ?? []) as Array<{ id: string; revision_number: number; parent_id: string | null }>
    expect(rows.length).toBe(2)
    expect(rows[1].revision_number).toBe(2)
    expect(rows[1].parent_id).toBe(rows[0].id)

    // listRevisions returns both, ascending
    const listed = await ownerDomain.content.listRevisions({ itemId: item.id })
    expect(listed.items.length).toBe(2)

    // Zod rejection: data not matching field_schema (required title missing + wrong type on rank)
    await expect(ownerDomain.content.create({
      workspaceId: ws1, contentTypeId: ct.id, slug: 'bad-data',
      data: { body: '<p>x</p>', rank: 'not-a-number' },
    })).rejects.toThrow()

    // cross-workspace isolation: an item in ws2 (owner is NOT a member) is invisible.
    const fType = await adminDb.from('content_type').insert({
      workspace_id: ws2, key: 'page', label: 'Page', field_schema: [{ name: 'title', type: 'text' }],
    }).select('id').single()
    const foreign = await adminDb.from('content_item').insert({
      workspace_id: ws2, content_type_id: (fType.data as { id: string }).id, slug: 'secret', status: 'draft',
    }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    expect(await ownerDomain.content.get(foreignId)).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run (with the local stack up — `supabase start` beforehand):
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run content
```
Expected: FAIL — `createDomain(...).content` is undefined (`Cannot read properties of undefined (reading 'createType')`).

- [ ] **Step 4: Implement `content.ts`**

`packages/domain/src/content.ts`:
```ts
import { z } from 'zod'
import type { ContentItemRow, ContentRevisionRow, ContentTypeRow } from './generated/types.ts'
import type { ContentService, DomainCtx, Page } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (v: string) => btoa(v)
const decodeCursor = (cursor: string) => atob(cursor)

// crypto.subtle SHA-256 hex — copied from collab.ts. Available on workerd AND Node 18+, so
// content_hash is DOMAIN-computed and passed into the RPC (the DB never hashes CMS content).
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The field types a content_type field_schema may declare.
const FIELD_TYPES = ['text', 'richtext', 'number', 'bool', 'date', 'enum', 'asset', 'reference'] as const
type FieldType = (typeof FIELD_TYPES)[number]

interface FieldDefShape {
  name: string
  type: FieldType
  required?: boolean
  values?: string[] // for enum
}

// Structural runtime type-guard for a field_schema. A parseable JSON is NOT a valid schema:
// reject anything that is not an array of {name, type in FIELD_TYPES, required?:boolean}
// (enum fields must also carry a non-empty string values[]). Guards against a malformed
// schema reaching validation/canonicalization.
function isValidFieldSchema(schema: unknown): schema is FieldDefShape[] {
  if (!Array.isArray(schema)) return false
  const seen = new Set<string>()
  for (const f of schema) {
    if (typeof f !== 'object' || f === null) return false
    const r = f as Record<string, unknown>
    if (typeof r.name !== 'string' || r.name.length === 0) return false
    if (seen.has(r.name)) return false
    seen.add(r.name)
    if (typeof r.type !== 'string' || !FIELD_TYPES.includes(r.type as FieldType)) return false
    if ('required' in r && typeof r.required !== 'boolean') return false
    if (r.type === 'enum') {
      if (!Array.isArray(r.values) || r.values.length === 0 || !r.values.every((v) => typeof v === 'string')) {
        return false
      }
    }
  }
  return true
}

// Compile a field_schema into a Zod object for validating a data payload. Default (strip)
// object behaviour DROPS unknown keys — so the stored/canonicalized data is exactly the
// declared fields — while type mismatches / missing required fields THROW.
function fieldSchemaToZod(fields: FieldDefShape[]): z.ZodType<Record<string, unknown>> {
  const shape: z.ZodRawShape = {}
  for (const f of fields) {
    let base: z.ZodTypeAny
    switch (f.type) {
      case 'text':
      case 'richtext':
      case 'asset':
      case 'date':
        base = z.string()
        break
      case 'reference':
        base = z.string().uuid()
        break
      case 'number':
        base = z.number()
        break
      case 'bool':
        base = z.boolean()
        break
      case 'enum':
        base = z.enum((f.values ?? ['']) as [string, ...string[]])
        break
    }
    shape[f.name] = f.required ? base : base.optional()
  }
  return z.object(shape) as z.ZodType<Record<string, unknown>>
}

// Canonical JSON over the VALIDATED data: keys sorted recursively, JSON.stringify normalizes
// whitespace/number forms. Unknown keys were already dropped by Zod strip. Volatile fields
// (author/timestamps) live OUTSIDE `data`, so they are excluded by construction.
function canonicalize(data: Record<string, unknown>): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  return JSON.stringify(sortValue(data))
}

export function makeContentService(ctx: DomainCtx): ContentService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.content.${op} failed [${code ?? 'unknown'}]`)
  }

  // Load a content_type's field_schema under the caller's RLS; structurally validate it.
  async function loadType(contentTypeId: string): Promise<FieldDefShape[]> {
    const { data, error } = await ctx.db
      .from('content_type').select('field_schema').eq('id', contentTypeId).maybeSingle()
    if (error) fail('loadType', error.code)
    const raw = (data as { field_schema?: unknown } | null)?.field_schema
    if (raw == null) throw new Error('domain.content: content_type not found or inaccessible')
    if (!isValidFieldSchema(raw)) throw new Error('domain.content: stored field_schema is malformed')
    return raw
  }

  // Resolve a content_item's content_type_id under the caller's RLS (doubles as an access check).
  async function itemTypeId(itemId: string): Promise<string> {
    const { data, error } = await ctx.db
      .from('content_item').select('content_type_id').eq('id', itemId).maybeSingle()
    if (error) fail('resolveItem', error.code)
    const id = (data as { content_type_id?: string } | null)?.content_type_id
    if (!id) throw new Error('domain.content: content item not found or inaccessible')
    return id
  }

  // Validate + canonicalize a data payload against a field_schema; derive hash + search text.
  async function prepare(
    fields: FieldDefShape[],
    data: Record<string, unknown>,
  ): Promise<{ canonical: Record<string, unknown>; hash: string; searchText: string; searchBody: string }> {
    const parsed = fieldSchemaToZod(fields).parse(data) // throws on type/required mismatch
    const canonicalJson = canonicalize(parsed)
    const hash = await sha256Hex(canonicalJson)
    const textParts: string[] = []
    const bodyParts: string[] = []
    for (const f of fields) {
      const v = parsed[f.name]
      if (v == null) continue
      if (f.type === 'richtext') bodyParts.push(String(v))
      else if (f.type === 'text' || f.type === 'enum') textParts.push(String(v))
    }
    return { canonical: parsed, hash, searchText: textParts.join(' '), searchBody: bodyParts.join(' ') }
  }

  return {
    async createType(i) {
      // A parseable JSON is NOT a valid schema — reject a malformed shape with a hard throw.
      if (!isValidFieldSchema(i.fieldSchema)) {
        throw new Error('domain.content.createType: invalid field_schema (expected array of {name,type,required?})')
      }
      const { data, error } = await ctx.db.from('content_type').insert({
        workspace_id: i.workspaceId,
        key: i.key,
        label: i.label,
        field_schema: i.fieldSchema,
        moderation_policy: i.moderationPolicy ?? 'none',
        approval_policy: i.approvalPolicy ?? 'none',
      }).select('*').single()
      if (error) fail('createType', error.code)
      return data as ContentTypeRow
    },

    async listTypes(a) {
      const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db.from('content_type').select('*').eq('workspace_id', a.workspaceId)
        .order('id', { ascending: true }).limit(first + 1)
      if (a.after) q = q.gt('id', decodeCursor(a.after))
      const { data, error } = await q
      if (error) fail('listTypes', error.code)
      const rows = (data ?? []) as ContentTypeRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async create(i) {
      const fields = await loadType(i.contentTypeId)
      const p = await prepare(fields, i.data)
      // Single transactional INVOKER RPC: item + first immutable revision commit atomically
      // under the caller's RLS; current_revision_id is set to it. Hash is DOMAIN-computed.
      const { data, error } = await ctx.db.rpc('create_content_with_revision', {
        ws: i.workspaceId,
        p_content_type_id: i.contentTypeId,
        p_slug: i.slug,
        p_data: p.canonical,
        p_content_hash: p.hash,
        p_search_text: p.searchText,
        p_search_body: p.searchBody,
      })
      if (error) fail('create', error.code)
      return data as ContentItemRow
    },

    async update(i) {
      const typeId = await itemTypeId(i.itemId)
      const fields = await loadType(typeId)
      const p = await prepare(fields, i.data)
      const { data, error } = await ctx.db.rpc('update_content', {
        p_item_id: i.itemId,
        p_data: p.canonical,
        p_content_hash: p.hash,
        p_search_text: p.searchText,
        p_search_body: p.searchBody,
      })
      if (error) fail('update', error.code)
      return data as ContentItemRow
    },

    async get(id) {
      const { data, error } = await ctx.db.from('content_item').select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as ContentItemRow | null) ?? null
    },

    async list(a) {
      const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db.from('content_item').select('*').eq('workspace_id', a.workspaceId)
      if (a.contentTypeId) q = q.eq('content_type_id', a.contentTypeId)
      if (a.status) q = q.eq('status', a.status)
      q = q.order('id', { ascending: true }).limit(first + 1)
      if (a.after) q = q.gt('id', decodeCursor(a.after))
      const { data, error } = await q
      if (error) fail('list', error.code)
      const rows = (data ?? []) as ContentItemRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async listRevisions(a) {
      const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      // Keyset on revision_number (monotonic per item). Cursor carries the last number.
      let q = ctx.db.from('content_revision').select('*').eq('content_item_id', a.itemId)
        .order('revision_number', { ascending: true }).limit(first + 1)
      if (a.after) q = q.gt('revision_number', Number(decodeCursor(a.after)))
      const { data, error } = await q
      if (error) fail('listRevisions', error.code)
      const rows = (data ?? []) as ContentRevisionRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return {
        items,
        nextCursor: rows.length > first && last ? encodeCursor(String(last.revision_number)) : null,
      }
    },
  }
}
```

- [ ] **Step 5: Extend `types.ts`**

In `packages/domain/src/types.ts`, extend the generated-types import to add the content rows, then add the `ContentService` interface and the `Domain.content` member. Add to the `from './generated/types.ts'` import block:
```ts
  ContentItemRow,
  ContentRevisionRow,
  ContentTypeRow,
```
Add the interface (place before `export interface Domain`):
```ts
export interface ContentService {
  createType(i: { workspaceId: string; key: string; label: string; fieldSchema: unknown; moderationPolicy?: string; approvalPolicy?: string }): Promise<ContentTypeRow>
  listTypes(a: { workspaceId: string; first?: number; after?: string | null }): Promise<Page<ContentTypeRow>>
  create(i: { workspaceId: string; contentTypeId: string; slug: string; data: Record<string, unknown> }): Promise<ContentItemRow>
  update(i: { itemId: string; data: Record<string, unknown> }): Promise<ContentItemRow>
  get(id: string): Promise<ContentItemRow | null>
  list(a: { workspaceId: string; contentTypeId?: string; status?: string; first?: number; after?: string | null }): Promise<Page<ContentItemRow>>
  listRevisions(a: { itemId: string; first?: number; after?: string | null }): Promise<Page<ContentRevisionRow>>
}
```
Add `content: ContentService` to the existing `Domain` interface (alongside `note`/`tag`/`search`/`graph`/`collab`/task members):
```ts
  content: ContentService
```

- [ ] **Step 6: Wire `domain.ts`**

In `packages/domain/src/domain.ts`, add the import (next to the other `make*` imports):
```ts
import { makeContentService } from './content.ts'
```
and add this line to `createDomain`'s returned object (alongside `collab: makeCollabService(ctx)`). All three CMS collections are `internal`, so the schema-driven builders `if (c.internal) continue` past them — they are reached ONLY through this custom service:
```ts
    // CMS collections are internal — reached ONLY through this custom service
    // (ctx.db.from('content_item'/'content_type'/'content_revision') + the two RPCs).
    content: makeContentService(ctx),
```

- [ ] **Step 7: Export from `index.ts`**

In `packages/domain/src/index.ts`, add after the existing `export { makeCollabService, resolveShareLink } from './collab.ts'` line:
```ts
export { makeContentService } from './content.ts'
```
Add `ContentService` to the type export block from `./types.ts` (alphabetical, alongside `CollabService`, `Domain`, etc.):
```ts
  ContentService,
```
Extend the generated-types re-export block from `./generated/types.ts` to include the content rows the surfaces (Parts B/C/D) will need:
```ts
  ContentItemRow,
  ContentRevisionRow,
  ContentTypeRow,
```

- [ ] **Step 8: Run the test + typecheck**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run content && pnpm --filter @movp/domain typecheck
```
Expected: PASS — `content.integration.test.ts` (1 test) green; `tsc --noEmit` clean.

- [ ] **Step 9: Machine-checkable gate — service wired, internal-only, no `process.env`**

Run:
```bash
cd /Users/ensell/Code/supasuite
grep -c "content: makeContentService(ctx)" packages/domain/src/domain.ts
grep -Ec "rpc\('(create_content_with_revision|update_content)'" packages/domain/src/content.ts
grep -c "process.env" packages/domain/src/content.ts
grep -Ec "from\('(content_type|content_item|content_revision)'\)" packages/domain/src/content.ts
```
Expected: first grep prints `1` (the service is wired into `createDomain`); second grep prints `2` (both RPCs are driven from the service); third grep prints `0` (per-request deps come from `ctx`, never `process.env`); fourth grep is `>= 3` (the internal tables are reached by literal name).

- [ ] **Step 10: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): content service (createType/create/update/get/list/listRevisions) with zod validation + canonical hashing + wiring"
```

---

## Self-Review

- **Correctness.** Collection field defs and FK column names match the shared CMS contract exactly (`content_type_id`, `content_item_id`, `parent_id`, plain `current_revision_id`/`approved_revision_id`/`published_revision_id`). Schema order (`content_type` → `content_item` → `content_revision`) satisfies every non-circular FK; the three circular pointer FKs are hand-added in `000011`. The two RPC signatures and the `ContentService` interface are reproduced verbatim from the contract. `content_hash` is domain-computed (`sha256Hex` over canonical JSON) and passed as a parameter — the DB never hashes CMS content (unlike the mirrored Task RPCs, whose difference is explicitly annotated). Each SQL/TS block was cross-checked against the pasted precedent: the `can_access_entity` body preserves the note/comment/task arms byte-for-byte and adds only `content_item`; `search_fts` preserves note/tag and adds only `content_item`; the Task `update_task_description` structure is mirrored with hash-as-param and no `extensions.digest`.
- **Safety.** Immutability is enforced at the data boundary two ways (RLS SELECT+INSERT-only, dropping `content_revision_rw`, PLUS a hardened `SECURITY DEFINER` guard trigger raising `2F004` on UPDATE/DELETE — belt-and-suspenders because ordinary members hit the silent RLS no-op while privileged/service-role writes hit the hard raise). RPCs are `SECURITY INVOKER` so `content_item`/`content_revision` RLS gates the writes; `author_id` is `(select auth.uid())`, never client-supplied. All definers pin `search_path=''` and revoke public/anon. `field_schema` is structurally validated before use (a parseable JSON is not a valid schema; malformed → hard throw), and the data payload is Zod-validated (unknown keys stripped, type/required mismatches thrown).
- **Reliability.** `create` is one transaction (item + rev + pointer) — a caller who cannot write rolls back with no orphan. `update` LEFT-joins so a revision-less item still resolves its ws; a `null` ws → stable `no_data_found`. The `unique(content_item_id, content_hash)` revert-to-non-current edge (raises `23505` by design) is called out in Global Constraints AND commented in the RPC so an executor does not "fix" the dedup. Cross-workspace isolation is asserted in the integration test.
- **Observability.** The service throws `domain.content.<op> failed [<code>]` with only the bounded PostgREST code — no slug, title, or `data` value logged. Each task ends with a machine-checkable gate (grep counts, `git diff --exit-code`, `supabase test db`, `db diff`, `check-definer-audit.mjs`, vitest, typecheck) with exact expected output.
- **Efficiency / Performance.** `create`/`update` are single RPC round-trips; the dedup path avoids a needless revision insert. Hot-path indexes (`content_item_type_idx`, `content_item_status_idx`, `content_revision_item_idx`) back `list`, status filtering, and `listRevisions`/`max(revision_number)`. Keyset pagination (id / revision_number) is bounded by `MAX_PAGE = 100`. These indexes are additive beyond the contract's explicit `000011` list but do not touch any name Parts B/C/D depend on.
- **Simplicity.** No speculative surface: no generic CRUD service for any CMS table (all internal), no moderation/approval/publishing logic (deferred to Parts B–D — `status`/`*_revision_id`/policy columns exist as fixed inputs but Part A only writes `draft` + `current_revision_id`). `zod` is the one new dependency, justified by the contract's explicit "Zod-validate data against field_schema"; `createType`'s schema check is a hand-rolled type-guard (no dependency needed for the small shape).
- **Usability.** This is backend/service scope (no UI in Part A — Parts C/D own frontend); marked N/A for a11y. Operator-facing errors are stable and greppable; the precondition check fails loudly if a prerequisite phase is unmerged.

### Contract summary returned to the caller

- **`content_type` fields:** `key` text(req), `label` text(req), `field_schema` json(req), `moderation_policy` enum(none|pre|post, default none, dimension), `approval_policy` enum(none|single|multi, default none, dimension).
- **`content_item` fields:** `content_type` relation→`content_type_id`(req, cascade), `slug` text(req), `status` enum(draft|in_review|approved|published|archived, default draft, dimension), `current_revision_id` uuid(plain), `approved_revision_id` uuid(plain), `published_revision_id` uuid(plain), `published_at` datetime, `search_text` text(searchable), `search_body` richText(searchable, embeddable).
- **`content_revision` fields (immutable):** `item` relation→`content_item_id`(req, cascade), `revision_number` number(req), `data` json(req), `content_hash` text(req), `author_id` uuid(req), `parent` relation(self)→`parent_id`(optional, set null).
- **FK / pointer column names (B/C/D depend on these):** `content_type_id`, `content_item_id`, `parent_id`, `current_revision_id`, `approved_revision_id`, `published_revision_id`.
- **RPC signatures:**
  - `public.create_content_with_revision(ws uuid, p_content_type_id uuid, p_slug text, p_data jsonb, p_content_hash text, p_search_text text, p_search_body text) returns jsonb`
  - `public.update_content(p_item_id uuid, p_data jsonb, p_content_hash text, p_search_text text, p_search_body text) returns jsonb`
- **`ContentService` interface:** `createType`, `listTypes`, `create`, `update`, `get`, `list`, `listRevisions` (as declared in `types.ts`, Step 5).
- **`can_access_entity` `'content_item'` arm:**
  ```sql
  when 'content_item' then
    select exists (
      select 1 from public.content_item ci
      where ci.id = can_access_entity.entity_id
        and ci.workspace_id = can_access_entity.ws
    ) into v_exists;
  ```
