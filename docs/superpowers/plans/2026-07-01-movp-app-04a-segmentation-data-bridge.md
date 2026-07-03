# MOVP App — Segmentation Phase 6, Part A: Data Model, Indexes & Internal Event Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the seven Segmentation collections — `platform_event`, `segment`, `segment_rule`, `segment_membership`, `segment_snapshot`, `segment_snapshot_member`, `segment_recompute_run` — to the config-first schema so codegen emits their base tables, the blanket workspace-member RLS, FTS (for the searchable `segment` fields — `platform_event` is deliberately NOT searchable, F5, to keep FTS artifacts off the highest-volume append-only fact), the `movp_fields` reporting metadata, and generated types; then hand-author migration `20260701000019_segmentation.sql` for the four things codegen cannot express: the two **composite reporting indexes** on `platform_event`, the **append-only guards** — a 2-part RLS SELECT+INSERT swap on both `platform_event` and `segment_snapshot_member`, plus a `2F004` immutability trigger on `platform_event` ONLY (`segment_snapshot_member` stays RLS-only so a permitted parent cascade delete is never aborted, F3) — the `unique(segment_id, subject_ref)` on `segment_membership`, and the **internal event bridge** (a `movp_internal.segmentation_bridged_type` allow-list + a hardened, non-aborting `SECURITY DEFINER` `AFTER INSERT` trigger on `movp_internal.movp_events` that mirrors allow-listed internal events into `public.platform_event`).

**Architecture:** Collections are defined in `packages/core-schema/src/collections/`, wired into `defineSchema()` (`schema.ts`) and re-exported (`index.ts`). Running `pnpm codegen` regenerates BOTH `supabase/migrations/20260701000002_movp_generated.sql` (base tables, the blanket `<name>_rw` `is_workspace_member` RLS policy, grants, FTS for searchable fields, `movp_collections`/`movp_fields` registry rows) AND `packages/domain/src/generated/types.ts` (`PlatformEvent*`, `Segment*`, `SegmentRule*`, `SegmentMembership*`, `SegmentSnapshot*`, `SegmentSnapshotMember*`, `SegmentRecomputeRun*` — `*Row/*Create/*Update`, **consumed by Parts B/C/D**). Relations emit `<fieldkey>_id` FK columns: `segment_rule.segment`/`segment_snapshot.segment`/`segment_recompute_run.segment`/`segment_membership.segment`→`segment_id` (required → `not null … on delete cascade`); `segment_snapshot_member.snapshot`→`snapshot_id` (required → cascade); `segment_membership.matched_rule`/`segment_snapshot_member.matched_rule`→`matched_rule_id` (optional → `on delete set null`). `one-to-many`/`many-to-many` emit NO column (none used here). **Segmentation collections are config-first and NOT `internal`** — codegen emits the full generic GraphQL/MCP/CLI CRUD surface, `Page`, workspace-member RLS, FTS and reporting metadata for free. **Codegen emits NO composite indexes** — `platform_event`'s two reporting indexes are HAND-ADDED in `20260701000019_segmentation.sql` (precedent: the Task phase hand-adds `task_ws_status_idx` in `000008`). Everything else codegen cannot emit lives in that same hand-authored migration: the two append-only guards (a `2F004` immutability trigger on `platform_event`; RLS-only SELECT+INSERT on `segment_snapshot_member`, F3), the `segment_membership` uniqueness constraint, and the internal event bridge (allow-list table + a guarded `AFTER INSERT` trigger).

**Tech Stack:** TypeScript (`@movp/core-schema`, `@movp/codegen`), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres RLS + `SECURITY DEFINER`, the existing `public.workspace` / `public.workspace_membership` / `public.is_workspace_member(uuid)` tenancy backbone, and the existing internal events log `movp_internal.movp_events` (`(id, type, workspace_id, payload jsonb, trace_id, created_at)`).

**This is Part A of the Phase 6 (Segmentation) series.** **Functional dependency (F7):** Part A needs only the **Core backbone** — `movp_internal.movp_events`, `public.emit_event`, `public.is_workspace_member`, `public.movp_fields`, the `movp_internal.webhooks` internal-table template, and the codegen pipeline — all present by `000001`–`000007` (Core+Collaboration). It does **NOT** functionally depend on Task, CMS, or Campaigns objects. **Migration ORDER (a separate concern):** the hand-authored migration is numbered `20260701000019` purely so it sorts AFTER every already-numbered phase migration (`000008`–`000018`); this is a filename-sort convention, not a need for those phases' objects. **The bridge is DORMANT in production** until emitters for the three allow-listed types (`account.created`, `registration.completed`, `onboarding.completed`) ship — until then the allow-list matches no `movp_events.type` and no `platform_event` is mirrored. **Part B** (rule evaluation / recompute engine, membership diff, snapshot writer), **Part C** (reporting rollups, MCP/CLI surfaces), and **Part D** (segmentation surfaces/frontend) consume the generated `*Row` types, the FK column names (`segment_id`/`matched_rule_id`/`snapshot_id`), the reporting measures, and the bridge + `platform_event` INSERT contract — do not rename a collection, field, FK column, option label, index, or `platform_event`/`bridge` semantic without updating B/C/D.

## Global Constraints

- **Config-first collections.** New tables are added by defining a collection and running `pnpm codegen` — never by hand-writing a `create table` in a migration. The generated `20260701000002_movp_generated.sql` is a build artifact; commit it, never edit it by hand.
- **`pnpm codegen` is reproducible and committed.** After changing collections, run `pnpm codegen`, commit the regenerated migration AND `packages/domain/src/generated/types.ts`. Re-running codegen must produce no diff (`git diff --exit-code` on both files is clean). CI's migration-drift job (`supabase db reset` → `supabase db diff` empty) fails if the committed migration is stale.
- **Every field needs a `label`.** `defineCollection` throws if any field omits `label` or if an enum has empty `values`; `pnpm codegen` imports the schema and therefore fails loudly on a malformed collection.
- **`f.json`→jsonb already exists — NO Core change.** The field-builder set used here (`f.text`, `f.richText`, `f.enum`, `f.number`, `f.boolean`, `f.datetime`, `f.json`, `f.relation`) is already in `builders.ts`. Type mapping: `f.json`→`jsonb`, `f.datetime`→`timestamptz`, `f.enum`→`text` + `CHECK`, `f.number`→`numeric`, `f.boolean`→`boolean`, `f.text`→`text`, `f.richText`→`text`.
- **NOT `internal`.** None of the seven Segmentation collections sets `internal: true`. All set `workspaceScoped: true`. Codegen emits the generic CRUD surface, `Page`, RLS, FTS and metadata for them (Parts B/C/D build the engine, reporting and surfaces on top).
- **Collection order encodes FK dependencies.** Codegen inlines each relation's FK into the referencing table's `create table`, so a relation target MUST be defined before the collection that references it. Append the seven in exactly this relative order at the END of the existing `defineSchema([...])` list: `platformEvent`, `segment`, `segmentRule`, `segmentMembership`, `segmentSnapshot`, `segmentSnapshotMember`, `segmentRecomputeRun` — **segment before its children**; **segment_rule before segment_membership + segment_snapshot_member** (both carry `matched_rule_id`); **segment_snapshot before segment_snapshot_member** (`snapshot_id`). `platform_event` has no relation and is placed first. Segmentation collections reference only each other, so placing them after whatever Core/Collab/Task/CMS/Campaigns collections already exist is safe.
- **`platform_event` and `segment_snapshot_member` are append-only — a load-bearing invariant, enforced DIFFERENTLY per table (F3).** Both allow member INSERT and drop their blanket `<name>_rw` for SELECT+INSERT-only member policies. `platform_event` (a top-level fact with NO cascade parent) additionally carries a `2F004` `BEFORE UPDATE OR DELETE` immutability trigger (mirroring the committed CMS `content_revision_immutable`) — pinned by `throws_ok … '2F004'`; do not weaken it. `segment_snapshot_member` is **RLS-ONLY, deliberately WITHOUT the trigger**: its `snapshot_id` chain is `on delete cascade`, so a `2F004` trigger would abort a permitted parent segment/snapshot delete with a cryptic code. A direct user delete is instead blocked by having no DELETE policy (RLS no-op), while a cascade delete (a referential action that bypasses RLS) cleans it up. Do NOT add a mutation trigger to `segment_snapshot_member`.
- **`platform_event` is append-only + AT-LEAST-ONCE (F6).** It carries NO dedup / idempotency key, so a retried emitter (or an at-least-once delivery path) can double-insert the same logical event — this is tolerated by design in v1. Downstream, Part C's set-based membership evaluation groups by `subject_ref`, so duplicate facts are dedup-safe for MEMBERSHIP computation (a subject is in-or-out regardless of how many times its triggering event landed). No unique key is required or added in v1; stated here so Part C does NOT assume exactly-once semantics over the fact table (any count/rollup over raw `platform_event` rows must treat duplicates accordingly).
- **Codegen emits NO composite indexes.** `platform_event`'s two reporting indexes are hand-added in `000019` (precedent: Task hand-adds `task_ws_status_idx` in `000008`). Do not attempt to express them in the collection.
- **All `SECURITY DEFINER` functions hardened:** `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` (trigger fns are invoked by the trigger, not called directly). The definer-audit gate (`node scripts/check-definer-audit.mjs`) fails any `security definer` function missing a pinned `search_path`.
- **The internal events log is consumed, never re-declared.** The bridge is an `AFTER INSERT` trigger ON `movp_internal.movp_events`; do NOT create or alter that table here. The `segmentation_bridged_type` allow-list is a NEW internal table that mirrors the committed `movp_internal.webhooks` template (deny-all RLS + `revoke from anon, authenticated` + `grant all to service_role`).
- **Authoritative authz at the data boundary.** RLS is the gate. Membership uses `public.is_workspace_member(workspace_id)`. `platform_event` and `segment_snapshot_member` drop their blanket `<name>_rw` policy in favour of SELECT + INSERT-only member policies; the other five collections KEEP the generated blanket `<name>_rw` policy.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  packages/
    core-schema/src/
      collections/
        platform_event.ts            # NEW (append-only fact)
        segment.ts                   # NEW
        segment_rule.ts              # NEW
        segment_membership.ts        # NEW
        segment_snapshot.ts          # NEW
        segment_snapshot_member.ts   # NEW (append-only)
        segment_recompute_run.ts     # NEW (audit)
      schema.ts                      # EDIT: append the seven collections to defineSchema([...])
      index.ts                       # EDIT: re-export the seven collections
    domain/src/generated/
      types.ts                       # REGENERATED by `pnpm codegen` (commit)
  supabase/
    migrations/
      20260701000002_movp_generated.sql   # REGENERATED by `pnpm codegen` (commit)
      20260701000019_segmentation.sql      # NEW hand-authored (Task 2)
    tests/
      segmentation_test.sql                # NEW pgTAP (Task 2)
```

---

### Task 1: Define the seven Segmentation collections + regenerate

**Files:**
- Create: `packages/core-schema/src/collections/platform_event.ts`, `segment.ts`, `segment_rule.ts`, `segment_membership.ts`, `segment_snapshot.ts`, `segment_snapshot_member.ts`, `segment_recompute_run.ts`
- Edit: `packages/core-schema/src/schema.ts`, `packages/core-schema/src/index.ts`
- Regenerate (do NOT hand-edit): `supabase/migrations/20260701000002_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `f` + `defineCollection` (`packages/core-schema/src/builders.ts`, `define.ts`); the existing Core/Collaboration/Task/CMS/Campaigns collections.
- Produces (Parts B/C/D consume): base tables `public.{platform_event,segment,segment_rule,segment_membership,segment_snapshot,segment_snapshot_member,segment_recompute_run}` with blanket `<name>_rw` RLS + grants + FTS + `movp_fields` reporting rows, and generated types `PlatformEvent*`, `Segment*`, `SegmentRule*`, `SegmentMembership*`, `SegmentSnapshot*`, `SegmentSnapshotMember*`, `SegmentRecomputeRun*`.

This task is config + codegen; its gates are `pnpm codegen` succeeding, a clean `supabase db reset`/`db diff`, `pnpm typecheck`, and greps proving the 7 tables + 21 interfaces + the FK `_id` columns were emitted.

- [ ] **Step 1: Create `platform_event` (append-only fact; no relation — placed first)**

`packages/core-schema/src/collections/platform_event.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Append-only FACT table. INSERT is allowed to workspace members; UPDATE/DELETE are blocked
// by a 2F004 immutability trigger added in 20260701000019_segmentation.sql. Codegen emits NO
// composite indexes — the two reporting indexes are hand-added in that migration too.
export const platformEvent = defineCollection({
  name: 'platform_event',
  label: 'Platform Event',
  labelPlural: 'Platform Events',
  workspaceScoped: true,
  fields: {
    // NOT searchable: FTS would emit a `search_vector` column + GIN index + a BEFORE INSERT/UPDATE
    // tsvector trigger on this highest-volume append-only fact (bridge + 500-row ingest batches).
    // Equality lookups are served by the two composite indexes hand-added in 000019 — keep only
    // the reporting dimension. (F5)
    event_type: f.text({ label: 'Event Type', required: true, reporting: { role: 'dimension' } }),
    subject_type: f.text({ label: 'Subject Type', required: true, reporting: { role: 'dimension' } }),
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    actor_ref: f.text({ label: 'Actor Ref' }),
    source: f.enum(['internal', 'external'], { label: 'Source', required: true, reporting: { role: 'dimension' } }),
    properties: f.json({ label: 'Properties' }),
    occurred_at: f.datetime({ label: 'Occurred At', required: true, reporting: { role: 'dimension' } }),
    ingested_at: f.datetime({ label: 'Ingested At', required: true }),
  },
})
```

- [ ] **Step 2: Create `segment`**

`packages/core-schema/src/collections/segment.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segment = defineCollection({
  name: 'segment',
  label: 'Segment',
  labelPlural: 'Segments',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    description: f.richText({ label: 'Description', searchable: true }),
    owner_ref: f.text({ label: 'Owner Ref' }),
    active: f.boolean({ label: 'Active', reporting: { role: 'dimension' } }),
    mode: f.enum(['dynamic', 'static'], { label: 'Mode', reporting: { role: 'dimension' } }),
  },
})
```

- [ ] **Step 3: Create `segment_rule` (segment before its children — FK ordering)**

`packages/core-schema/src/collections/segment_rule.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentRule = defineCollection({
  name: 'segment_rule',
  label: 'Segment Rule',
  labelPlural: 'Segment Rules',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    predicate: f.json({ label: 'Predicate' }),
    version: f.number({ label: 'Version' }),
    active: f.boolean({ label: 'Active', reporting: { role: 'dimension' } }),
    description: f.text({ label: 'Description' }),
  },
})
```

- [ ] **Step 4: Create `segment_membership`**

`packages/core-schema/src/collections/segment_membership.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// The 000019 migration adds `unique(segment_id, subject_ref)` (one live membership per
// subject per segment) — codegen cannot express a composite unique.
export const segmentMembership = defineCollection({
  name: 'segment_membership',
  label: 'Segment Membership',
  labelPlural: 'Segment Memberships',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    subject_type: f.text({ label: 'Subject Type', reporting: { role: 'dimension' } }),
    // REQUIRED (F8): a null subject cannot participate in `unique(segment_id, subject_ref)` — two
    // null-subject rows would both be allowed (NULLs are distinct under a unique), defeating the
    // one-membership-per-subject invariant. `required: true` -> `not null` in the generated table.
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    // Optional relation -> `matched_rule_id uuid references public.segment_rule(id) on delete set null`.
    matched_rule: f.relation('segment_rule', { label: 'Matched Rule', cardinality: 'many-to-one' }),
    first_matched_at: f.datetime({ label: 'First Matched At' }),
    evaluated_at: f.datetime({ label: 'Evaluated At' }),
    evidence: f.json({ label: 'Evidence' }),
  },
})
```

- [ ] **Step 5: Create `segment_snapshot`**

`packages/core-schema/src/collections/segment_snapshot.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentSnapshot = defineCollection({
  name: 'segment_snapshot',
  label: 'Segment Snapshot',
  labelPlural: 'Segment Snapshots',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    taken_at: f.datetime({ label: 'Taken At' }),
    reason: f.enum(['on_demand', 'scheduled', 'campaign_launch'], { label: 'Reason', reporting: { role: 'dimension' } }),
    rule_version_set: f.json({ label: 'Rule Version Set' }),
    member_count: f.number({ label: 'Member Count', reporting: { role: 'measure' } }),
  },
})
```

- [ ] **Step 6: Create `segment_snapshot_member` (append-only; snapshot + rule already defined)**

`packages/core-schema/src/collections/segment_snapshot_member.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Append-only, but RLS-ONLY (F3): 000019 replaces the blanket `_rw` with SELECT + INSERT member
// policies and DOES NOT add a BEFORE UPDATE/DELETE 2F004 trigger. A direct user DELETE is blocked
// (no DELETE policy → RLS no-op), while a CASCADE delete from a parent segment/segment_snapshot
// (a referential action that bypasses RLS) still cleans up — a 2F004 trigger would abort that
// permitted parent delete with a cryptic code, so this child is guarded by RLS only.
export const segmentSnapshotMember = defineCollection({
  name: 'segment_snapshot_member',
  label: 'Segment Snapshot Member',
  labelPlural: 'Segment Snapshot Members',
  workspaceScoped: true,
  fields: {
    // Required relation -> `snapshot_id uuid not null references public.segment_snapshot(id) on delete cascade`.
    snapshot: f.relation('segment_snapshot', { label: 'Snapshot', cardinality: 'many-to-one', required: true }),
    // REQUIRED (F8): a snapshot member with no subject_ref is meaningless; `required: true` -> `not null`.
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    // Optional relation -> `matched_rule_id uuid references public.segment_rule(id) on delete set null`.
    matched_rule: f.relation('segment_rule', { label: 'Matched Rule', cardinality: 'many-to-one' }),
    evidence: f.json({ label: 'Evidence' }),
  },
})
```

- [ ] **Step 7: Create `segment_recompute_run` (audit)**

`packages/core-schema/src/collections/segment_recompute_run.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentRecomputeRun = defineCollection({
  name: 'segment_recompute_run',
  label: 'Segment Recompute Run',
  labelPlural: 'Segment Recompute Runs',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    mode: f.text({ label: 'Mode', reporting: { role: 'dimension' } }),
    started_at: f.datetime({ label: 'Started At' }),
    finished_at: f.datetime({ label: 'Finished At' }),
    added_count: f.number({ label: 'Added Count', reporting: { role: 'measure' } }),
    removed_count: f.number({ label: 'Removed Count', reporting: { role: 'measure' } }),
    evaluated_count: f.number({ label: 'Evaluated Count', reporting: { role: 'measure' } }),
    idempotency_key: f.text({ label: 'Idempotency Key' }),
    outcome_code: f.text({ label: 'Outcome Code' }),
  },
})
```

- [ ] **Step 8: Wire the collections into the schema (APPEND, do not rewrite)**

In `packages/core-schema/src/schema.ts`, add these imports alongside the existing collection imports (keep the file's existing import style/ordering; the exact prior import set depends on which Task/CMS/Campaigns collections are merged):
```ts
import { platformEvent } from './collections/platform_event.ts'
import { segment } from './collections/segment.ts'
import { segmentMembership } from './collections/segment_membership.ts'
import { segmentRecomputeRun } from './collections/segment_recompute_run.ts'
import { segmentRule } from './collections/segment_rule.ts'
import { segmentSnapshot } from './collections/segment_snapshot.ts'
import { segmentSnapshotMember } from './collections/segment_snapshot_member.ts'
```
Then append these seven entries to the END of the `defineSchema([...])` array — immediately before its closing `])`, preserving this EXACT relative order (FK targets precede referrers). Add the comment too:
```ts
  // Segmentation (Phase 6, Part A). Order encodes inline-FK deps:
  //  - platform_event has no relation (placed first among segmentation collections).
  //  - segment precedes every child (segment_rule/membership/snapshot/recompute_run -> segment_id).
  //  - segment_rule precedes segment_membership + segment_snapshot_member (matched_rule_id -> it).
  //  - segment_snapshot precedes segment_snapshot_member (snapshot_id -> it).
  platformEvent,
  segment,
  segmentRule,
  segmentMembership,
  segmentSnapshot,
  segmentSnapshotMember,
  segmentRecomputeRun,
```

In `packages/core-schema/src/index.ts`, add these re-exports alongside the existing collection exports:
```ts
export { platformEvent } from './collections/platform_event.ts'
export { segment } from './collections/segment.ts'
export { segmentMembership } from './collections/segment_membership.ts'
export { segmentRecomputeRun } from './collections/segment_recompute_run.ts'
export { segmentRule } from './collections/segment_rule.ts'
export { segmentSnapshot } from './collections/segment_snapshot.ts'
export { segmentSnapshotMember } from './collections/segment_snapshot_member.ts'
```

- [ ] **Step 9: Regenerate**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints `wrote .../supabase/migrations/20260701000002_movp_generated.sql` and `wrote .../packages/domain/src/generated/types.ts`, exit 0. (A missing `label` or empty enum `values` makes `defineCollection` throw here — fix the collection and re-run.)

`packages/domain/src/generated/types.ts` will now contain the interfaces below (codegen output — **verify, do NOT hand-edit; Parts B/C/D import these**). Column ORDER is `id`, `workspace_id`, then data fields in definition order, then FK `_id` columns in definition order, then `created_at`, `updated_at`. Nullability is `required || default` → non-null, else nullable. Scalar TS types (how `numeric`/`jsonb`/`timestamptz` map) are whatever `emit-types.ts` produces — the committed file is authoritative; the shapes below are load-bearing only for the **FK `_id` column NAMES**, their nullability, and the reporting measures being present:
```ts
export interface PlatformEventRow {
  id: string
  workspace_id: string
  event_type: string
  subject_type: string
  subject_ref: string
  actor_ref: string | null
  source: 'internal' | 'external'
  properties: Record<string, unknown> | null
  occurred_at: string
  ingested_at: string
  created_at: string
  updated_at: string
}

export interface SegmentRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  owner_ref: string | null
  active: boolean | null
  mode: 'dynamic' | 'static' | null
  created_at: string
  updated_at: string
}

export interface SegmentRuleRow {
  id: string
  workspace_id: string
  predicate: Record<string, unknown> | null
  version: number | null
  active: boolean | null
  description: string | null
  segment_id: string                    // FK -> segment (required, cascade)
  created_at: string
  updated_at: string
}

export interface SegmentMembershipRow {
  id: string
  workspace_id: string
  subject_type: string | null
  subject_ref: string                   // required (F8): not null (dedup key half)
  first_matched_at: string | null
  evaluated_at: string | null
  evidence: Record<string, unknown> | null
  segment_id: string                    // FK -> segment (required, cascade)
  matched_rule_id: string | null        // FK -> segment_rule (optional, set null)
  created_at: string
  updated_at: string
}

export interface SegmentSnapshotRow {
  id: string
  workspace_id: string
  taken_at: string | null
  reason: 'on_demand' | 'scheduled' | 'campaign_launch' | null
  rule_version_set: Record<string, unknown> | null
  member_count: number | null           // reporting measure
  segment_id: string                    // FK -> segment (required, cascade)
  created_at: string
  updated_at: string
}

export interface SegmentSnapshotMemberRow {
  id: string
  workspace_id: string
  subject_ref: string                   // required (F8): not null
  evidence: Record<string, unknown> | null
  snapshot_id: string                   // FK -> segment_snapshot (required, cascade)
  matched_rule_id: string | null        // FK -> segment_rule (optional, set null)
  created_at: string
  updated_at: string
}

export interface SegmentRecomputeRunRow {
  id: string
  workspace_id: string
  mode: string | null
  started_at: string | null
  finished_at: string | null
  added_count: number | null            // reporting measure
  removed_count: number | null          // reporting measure
  evaluated_count: number | null        // reporting measure
  idempotency_key: string | null
  outcome_code: string | null
  segment_id: string                    // FK -> segment (required, cascade)
  created_at: string
  updated_at: string
}
// Codegen also emits a *Create and *Update interface per collection (21 interfaces total).
```

- [ ] **Step 10: Apply + drift check + typecheck**

Run:
```bash
supabase db reset && supabase db diff && pnpm typecheck
```
Expected: `db reset` applies the regenerated migration cleanly (the seven tables + blanket `<name>_rw` policies are created); `supabase db diff` prints **nothing** (no drift); `pnpm typecheck` PASSES.

- [ ] **Step 11: Machine-checkable gate — tables + types + FK columns emitted, codegen reproducible**

Run:
```bash
cd /Users/ensell/Code/supasuite
grep -cE 'create table if not exists public\.(platform_event|segment|segment_rule|segment_membership|segment_snapshot|segment_snapshot_member|segment_recompute_run) \(' \
  supabase/migrations/20260701000002_movp_generated.sql
grep -cE 'interface (PlatformEvent|SegmentRecomputeRun|SegmentSnapshotMember|SegmentSnapshot|SegmentMembership|SegmentRule|Segment)(Row|Create|Update)' \
  packages/domain/src/generated/types.ts
grep -q 'segment_id' packages/domain/src/generated/types.ts \
  && grep -q 'matched_rule_id' packages/domain/src/generated/types.ts \
  && grep -q 'snapshot_id' packages/domain/src/generated/types.ts \
  && echo "FK names present"
# F5: platform_event.event_type is NOT searchable → codegen must emit NO FTS GIN index for it
# (segment stays searchable, so a segment_search_idx is expected — only platform_event's is banned).
grep -c 'platform_event_search_idx' supabase/migrations/20260701000002_movp_generated.sql
pnpm codegen && git diff --exit-code \
  supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
```
Expected: first grep prints `7` (all seven tables emitted); second prints `21` (7 collections × Row/Create/Update — the alternation is ordered longest-prefix-first so each interface line counts once); the third block prints `FK names present` (all three FK column names are in the generated types); the fourth grep prints `0` (no `platform_event_search_idx` — the high-volume append-only fact carries no FTS GIN index or tsvector trigger, per F5); the `git diff --exit-code` exits `0` (re-running codegen changed nothing — reproducible).

- [ ] **Step 12: Commit**

```bash
git add packages/core-schema/src supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
git commit -m "feat(schema): add segmentation collections (platform_event + segment + rule/membership/snapshot/snapshot_member/recompute_run)"
```

---

### Task 2: Migration `000019` — indexes + immutability guards + unique + internal bridge, with pgTAP

**Files:**
- Create: `supabase/migrations/20260701000019_segmentation.sql`
- Create: `supabase/tests/segmentation_test.sql`

**Interfaces:**
- Consumes: the seven generated tables from Task 1 (with their blanket `<name>_rw` policies from `000002`); `public.is_workspace_member(uuid)`; the existing internal events log `movp_internal.movp_events` (`(id, type, workspace_id, payload jsonb, trace_id, created_at)`); the `movp_internal.webhooks` internal-table template; `public.movp_fields`.
- Produces:
  - Two composite indexes on `public.platform_event`: `platform_event_subject_idx (workspace_id, subject_ref, event_type, occurred_at)` and `platform_event_type_time_idx (workspace_id, event_type, occurred_at)`.
  - Append-only guards on `public.platform_event` and `public.segment_snapshot_member`: BOTH drop their blanket `<name>_rw` policy for SELECT + INSERT member policies. They differ in the mutation guard (F3): `platform_event` (a top-level fact with no cascade parent) ALSO gets a hardened `SECURITY DEFINER` `BEFORE UPDATE OR DELETE` trigger raising `2F004`; `segment_snapshot_member` is **RLS-ONLY** — NO trigger — because its `snapshot_id`/parent chain is `on delete cascade`, and a `2F004` trigger would abort a permitted parent segment/snapshot delete. With no DELETE policy, a direct user delete is an RLS no-op while a cascade (referential action, bypasses RLS) cleans it up. **Invariant:** ONLY these two tables lose their blanket policy; the other five KEEP the generated `<name>_rw`.
  - `unique(segment_id, subject_ref)` on `public.segment_membership` (constraint `segment_membership_segment_subject_key`); `subject_ref` is `not null` (F8) so the dedup key never admits two distinct-NULL rows.
  - `movp_internal.segmentation_bridged_type(event_type text primary key)` allow-list (deny-all RLS + `revoke from anon, authenticated` + `grant all to service_role`, mirroring `movp_internal.webhooks`), seeded with `('account.created'),('registration.completed'),('onboarding.completed')`; and a hardened `SECURITY DEFINER` (`set search_path=''`) `AFTER INSERT` trigger `movp_internal.bridge_event_to_platform()` on `movp_internal.movp_events` that, for an allow-listed `new.type` **AND** a non-null `new.workspace_id` **AND** a resolvable `subject_ref` (else it skips silently — F1, so a bad bridged payload never aborts the caller's business transaction), inserts one `public.platform_event` with `source='internal'`, `occurred_at = new.created_at`, `subject_ref = coalesce(new.payload->>'subject_ref', new.payload->>'id')`, `subject_type = coalesce(new.payload->>'subject_type', new.payload->>'entity_type', 'user')` (F2 — committed emitters carry the entity kind in `entity_type`).
  - **platform_event INSERT contract (F4 — Parts B/C/D MUST honor this on EVERY insert into `public.platform_event`):** set `workspace_id` (NOT NULL), `source` ∈ {`internal`,`external`} (the codegen enum — NOT `'web'` or any other literal), `occurred_at`, and `ingested_at` (required, **no column default** — set `now()` at insert time). The bridge above sets all four; EVERY other `platform_event` emitter across Parts B/C/D (external-source ingestion, the recompute/snapshot writers, any manual insert) must too, or the insert fails the NOT NULL / enum check. This is the load-bearing cross-part contract; do not weaken `ingested_at` to a defaulted column.

- [ ] **Step 0: Guard — is the internal events log (`movp_internal.movp_events`) merged?**

The bridge trigger targets `movp_internal.movp_events`, created by Core (`000005`). That is the ONLY functional prerequisite (F7) — NOT Campaigns. Confirm it exists in a prior migration before writing `000019`:
```bash
grep -rqE 'movp_internal\.?"?movp_events' supabase/migrations \
  || { echo "DEPENDENCY MISSING: movp_internal.movp_events not created by any prior migration — the bridge AFTER INSERT trigger targets it. STOP (merge Core 000005 first)."; exit 1; }
```
Expected: prints nothing / passes (exit 0) when the log is present; STOPs loudly (exit 1) otherwise. If it STOPs, this is a merge-order/dependency problem (Core `000005` must land before `000019`), not a Segmentation bug — resolve the merge order, do not work around it. The `000019` NUMBER only needs to sort after `000018` (filename convention); the sole functional need is Core's `movp_events` + `emit_event`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/segmentation_test.sql`. The base seed runs as the table owner (RLS bypassed): W1 with member A (owner); B is NOT a member. It seeds ONE row into every one of the seven tables BEFORE the role switch, so the non-member 0-count assertions are REAL RLS filters (a member would also see 0 rows in an empty table):
```sql
begin;
select plan(52);

-- ── base seed (as table owner; RLS bypassed) ────────────────────────────────
-- W1 member: A (owner). B is NOT a member of W1. Every one of the seven tables is seeded
-- with at least one W1 row BEFORE the role switch, so the non-member 0-count assertions are
-- REAL RLS filters, not vacuous empty-table reads.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

-- platform_event (INSERT allowed; only UPDATE/DELETE are blocked by the immutability trigger).
insert into public.platform_event
  (id, workspace_id, event_type, subject_type, subject_ref, source, occurred_at, ingested_at) values
  ('91000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'seed.event', 'user', 'subject-seed', 'external', now(), now());

-- segment SEG1 + one row in each child table.
insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'SEG1', true, 'dynamic');
insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values
  ('53000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', '{"op":"eq"}'::jsonb, 1, true);
insert into public.segment_membership
  (id, workspace_id, segment_id, subject_type, subject_ref, matched_rule_id) values
  ('54000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', 'user', 'subject-1',
   '53000000-0000-0000-0000-000000000001');
insert into public.segment_snapshot
  (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('55000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', now(), 'on_demand', 1);
insert into public.segment_snapshot_member
  (id, workspace_id, snapshot_id, subject_ref, matched_rule_id) values
  ('56000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '55000000-0000-0000-0000-000000000001', 'subject-1',
   '53000000-0000-0000-0000-000000000001');
insert into public.segment_recompute_run
  (id, workspace_id, segment_id, mode, added_count, removed_count, evaluated_count,
   idempotency_key, outcome_code) values
  ('57000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000001', 'dynamic', 1, 0, 1, 'idem-1', 'ok');

-- ── structural — tables exist ───────────────────────────────────────────────
select has_table('public', 'platform_event',          'platform_event table exists');
select has_table('public', 'segment',                 'segment table exists');
select has_table('public', 'segment_rule',            'segment_rule table exists');
select has_table('public', 'segment_membership',      'segment_membership table exists');
select has_table('public', 'segment_snapshot',        'segment_snapshot table exists');
select has_table('public', 'segment_snapshot_member', 'segment_snapshot_member table exists');
select has_table('public', 'segment_recompute_run',   'segment_recompute_run table exists');

-- ── FK column names (Parts B/C/D depend on these EXACT names) ────────────────
select has_column('public', 'segment_rule',            'segment_id',      'segment_rule has segment_id FK column');
select has_column('public', 'segment_membership',      'segment_id',      'segment_membership has segment_id FK column');
select has_column('public', 'segment_membership',      'matched_rule_id', 'segment_membership has matched_rule_id FK column');
select has_column('public', 'segment_snapshot',        'segment_id',      'segment_snapshot has segment_id FK column');
select has_column('public', 'segment_snapshot_member', 'snapshot_id',     'segment_snapshot_member has snapshot_id FK column');
select has_column('public', 'segment_snapshot_member', 'matched_rule_id', 'segment_snapshot_member has matched_rule_id FK column');
select has_column('public', 'segment_recompute_run',   'segment_id',      'segment_recompute_run has segment_id FK column');

-- FK resolution: segment_rule.segment_id actually references public.segment.
select is((select count(*)::int from pg_constraint
           where conrelid = 'public.segment_rule'::regclass
             and confrelid = 'public.segment'::regclass
             and contype = 'f'),
          1, 'segment_rule.segment_id FK resolves to public.segment');

-- ── hand-added composite indexes (RED until 000019 exists) ──────────────────
select has_index('public', 'platform_event', 'platform_event_subject_idx',   'platform_event_subject_idx exists');
select has_index('public', 'platform_event', 'platform_event_type_time_idx', 'platform_event_type_time_idx exists');

-- ── segment_membership uniqueness (RED until 000019 exists) ──────────────────
select col_is_unique('public', 'segment_membership', ARRAY['segment_id','subject_ref'],
  'segment_membership is unique on (segment_id, subject_ref)');

-- ── reporting roles — measures (codegen writes movp_fields.reporting_role) ───
select is((select reporting_role from public.movp_fields
           where collection_name='segment_snapshot' and name='member_count'),
          'measure', 'segment_snapshot.member_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='added_count'),
          'measure', 'segment_recompute_run.added_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='removed_count'),
          'measure', 'segment_recompute_run.removed_count is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='segment_recompute_run' and name='evaluated_count'),
          'measure', 'segment_recompute_run.evaluated_count is a reporting measure');

-- ── reporting roles — dimensions ────────────────────────────────────────────
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='event_type'),
          'dimension', 'platform_event.event_type is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='subject_type'),
          'dimension', 'platform_event.subject_type is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='source'),
          'dimension', 'platform_event.source is a reporting dimension');
select is((select reporting_role from public.movp_fields
           where collection_name='platform_event' and name='occurred_at'),
          'dimension', 'platform_event.occurred_at is a reporting dimension');

-- ── internal allow-list denies authenticated (RED until 000019 exists) ──────
select table_privs_are(
  'movp_internal', 'segmentation_bridged_type', 'authenticated', array[]::text[],
  'authenticated has no privileges on segmentation_bridged_type');

-- ── platform_event append-only via 2F004 trigger (RED until 000019 exists) ──
-- platform_event is a top-level fact (no cascade parent) → guarded by a BEFORE UPDATE/DELETE
-- 2F004 trigger; a direct UPDATE/DELETE (even as owner, triggers ignore RLS bypass) raises.
select throws_ok(
  $$update public.platform_event set subject_ref='x'
    where id='91000000-0000-0000-0000-000000000001'$$,
  '2F004', NULL, 'platform_event rejects UPDATE (append-only, 2F004)');
select throws_ok(
  $$delete from public.platform_event
    where id='91000000-0000-0000-0000-000000000001'$$,
  '2F004', NULL, 'platform_event rejects DELETE (append-only, 2F004)');

-- ── segment_snapshot_member is RLS-only append-only: a CASCADE delete from its parent SUCCEEDS
--    (F3 — RED against the OLD design where a 2F004 trigger would abort the cascade). ──────────
-- Dedicated SEG2 + snapshot + member (as owner) so SEG1's seeded rows stay intact for the RLS
-- matrix below. Deleting SEG2 cascades segment -> segment_snapshot -> segment_snapshot_member.
insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'SEG2', true, 'dynamic');
insert into public.segment_snapshot (id, workspace_id, segment_id, taken_at, reason, member_count) values
  ('55000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '52000000-0000-0000-0000-000000000002', now(), 'on_demand', 1);
insert into public.segment_snapshot_member (id, workspace_id, snapshot_id, subject_ref) values
  ('56000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '55000000-0000-0000-0000-000000000002', 'subject-cascade');
select lives_ok(
  $$delete from public.segment where id='52000000-0000-0000-0000-000000000002'$$,
  'parent segment delete with snapshot members SUCCEEDS (cascade, no 2F004 abort)');
select is((select count(*)::int from public.segment_snapshot_member
           where id='56000000-0000-0000-0000-000000000002'),
          0, 'cascade delete cleaned up the append-only snapshot member');

-- ── bridge must NOT abort the caller's business transaction (F1, RED until 000019 guards it) ─
-- emit_event(ev_type, ws, payload, trace) inserts movp_events INSIDE the business txn; the bridge
-- fires there. A workspace-less event, or a payload with neither id nor subject_ref, must be
-- SKIPPED silently — never a NOT NULL violation that rolls the caller back. Without the guard,
-- these two emits raise (platform_event.workspace_id / .subject_ref are NOT NULL) and lives_ok fails.
select lives_ok(
  $$select public.emit_event('account.created', NULL, '{}'::jsonb, 't')$$,
  'bridge skips (no raise) when the event has no workspace_id');
select lives_ok(
  $$select public.emit_event('account.created',
      '11111111-1111-1111-1111-111111111111', '{}'::jsonb, 't')$$,
  'bridge skips (no raise) when the payload resolves no subject_ref');
select is((select count(*)::int from public.platform_event where event_type='account.created'),
          0, 'guarded/skipped bridge cases insert no platform_event');
-- A companion business write in the SAME transaction survives (would have rolled back if the
-- bridge had thrown above).
insert into public.segment (id, workspace_id, name, active, mode) values
  ('52000000-0000-0000-0000-0000000000ff', '11111111-1111-1111-1111-111111111111',
   'SEG-companion', true, 'dynamic');
select is((select count(*)::int from public.segment
           where id='52000000-0000-0000-0000-0000000000ff'),
          1, 'a companion business insert survives the guarded (non-aborting) bridge');

-- ── internal event bridge (RED until 000019 exists) ─────────────────────────
-- A well-formed bridged movp_events type fans out to exactly one platform_event (source='internal'),
-- mapping subject_ref/subject_type via coalesce and occurred_at from movp_events.created_at. The
-- payload follows the committed emitter convention: `id` + `entity_type` (NO `subject_type`) — so
-- subject_type must resolve from entity_type, not a hardcoded 'user' (F2).
insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('e1000000-0000-0000-0000-000000000001', 'account.created',
   '11111111-1111-1111-1111-111111111111',
   jsonb_build_object('id', 'user-777', 'entity_type', 'account', 'actor_ref', 'admin-1'),
   gen_random_uuid()::text, '2026-07-01T12:00:00+00'::timestamptz);
select is((select count(*)::int from public.platform_event where event_type='account.created'),
          1, 'bridged event_type fans out to exactly one platform_event');
select is((select source from public.platform_event where event_type='account.created'),
          'internal', 'bridged platform_event has source=internal');
select is((select subject_ref from public.platform_event where event_type='account.created'),
          'user-777', 'bridged subject_ref falls back to payload id via coalesce');
select is((select subject_type from public.platform_event where event_type='account.created'),
          'account', 'bridged subject_type maps from payload entity_type (F2, not hardcoded user)');
select is((select occurred_at from public.platform_event where event_type='account.created'),
          '2026-07-01T12:00:00+00'::timestamptz,
          'bridged occurred_at maps from movp_events.created_at');
-- A NON-bridged type fans out NO platform_event.
insert into movp_internal.movp_events (id, type, workspace_id, payload, trace_id, created_at) values
  ('e1000000-0000-0000-0000-000000000002', 'note.created',
   '11111111-1111-1111-1111-111111111111',
   jsonb_build_object('id', 'note-1'), gen_random_uuid()::text, now());
select is((select count(*)::int from public.platform_event where properties->>'id'='note-1'),
          0, 'non-bridged event_type fans out no platform_event');

-- ── RLS matrix (role=authenticated) ─────────────────────────────────────────
set local role authenticated;

-- positive membership read: member A sees the seeded rows (SELECT policy is is_workspace_member).
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.platform_event
           where id='91000000-0000-0000-0000-000000000001'),
          1, 'a workspace member CAN SELECT platform_event');
select is((select count(*)::int from public.segment
           where id='52000000-0000-0000-0000-000000000001'),
          1, 'a workspace member CAN SELECT segment');

-- segment_snapshot_member is RLS-only append-only (F3): a member's DIRECT delete is a no-op —
-- there is NO DELETE policy, so RLS filters every row out of the delete. It does not error; the
-- row survives. (The parent-cascade path above is the ONLY way an append-only member row is removed.)
select lives_ok(
  $$delete from public.segment_snapshot_member where id='56000000-0000-0000-0000-000000000001'$$,
  'segment_snapshot_member direct DELETE is an RLS no-op (no error, no DELETE policy)');
select is((select count(*)::int from public.segment_snapshot_member
           where id='56000000-0000-0000-0000-000000000001'),
          1, 'segment_snapshot_member row survives a member direct DELETE (append-only via RLS)');

-- non-member B sees zero rows in every segmentation table (each was seeded above, so the
-- 0-count is a REAL RLS filter, not an empty-table read).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.platform_event),          0, 'non-member sees zero platform_event');
select is((select count(*)::int from public.segment),                 0, 'non-member sees zero segment');
select is((select count(*)::int from public.segment_rule),            0, 'non-member sees zero segment_rule');
select is((select count(*)::int from public.segment_membership),      0, 'non-member sees zero segment_membership');
select is((select count(*)::int from public.segment_snapshot),        0, 'non-member sees zero segment_snapshot');
select is((select count(*)::int from public.segment_snapshot_member), 0, 'non-member sees zero segment_snapshot_member');
select is((select count(*)::int from public.segment_recompute_run),   0, 'non-member sees zero segment_recompute_run');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `segmentation_test.sql` fails the assertions that depend on `000019`: the two `has_index`, the `col_is_unique`, the `table_privs_are` on `segmentation_bridged_type` (the table does not exist yet), the two `platform_event` `throws_ok … 2F004` (no immutability trigger → the UPDATE/DELETE succeed instead of throwing), the F3 `segment_snapshot_member` **direct-delete-survives** assertion (before `000019` the blanket `_rw` still PERMITS the member's delete → the row is gone → the `count=1` survival check reads `0`), and the five bridged-event assertions (no bridge trigger → the `account.created` insert produces no `platform_event`, so the count is `0` and the mapping reads are NULL). Assertions that PASS even before `000019`: the structural, FK, FK-resolution, reporting-role, non-bridged, non-member, and member-positive reads (Task 1 created the tables + metadata); the **F1 guard** block (no bridge yet → `emit_event` cannot abort anything, so the two `lives_ok` and the skip/companion checks are green); and the **F3 cascade-succeeds** block (no immutability trigger yet → the parent delete cascades cleanly). These last two are regression guards: they only turn RED if `000019` were mis-implemented (an unguarded bridge, or a 2F004 trigger on the cascade child). The base seed itself must apply cleanly — if it errors, a table/column/FK name is wrong; fix before proceeding. All other test files still pass.

- [ ] **Step 3: Create the migration `000019`**

Create `supabase/migrations/20260701000019_segmentation.sql` (exact path — do NOT use `supabase migration new`, which mints a wall-clock timestamp; this filename must sort after every `000001`–`000018` migration):
```sql
-- Segmentation Phase 6 — Part A. Numbered to sort AFTER all prior phase migrations
-- (20260701000001 .. 000018); the only FUNCTIONAL prerequisite is Core's movp_events + emit_event
-- (F7). Hand-authored: the two platform_event reporting indexes, the append-only guards (a 2F004
-- immutability trigger on platform_event; RLS-only SELECT+INSERT on segment_snapshot_member — no
-- trigger, so a parent cascade delete is not aborted, F3), the segment_membership uniqueness
-- constraint, and the guarded internal event bridge that mirrors allow-listed
-- movp_internal.movp_events rows into public.platform_event without aborting the caller (F1).

-- ── 1. platform_event reporting indexes (codegen emits none) ─────────────────
create index if not exists platform_event_subject_idx
  on public.platform_event (workspace_id, subject_ref, event_type, occurred_at);
create index if not exists platform_event_type_time_idx
  on public.platform_event (workspace_id, event_type, occurred_at);

-- ── 2a. platform_event: append-only (insert-only) ────────────────────────────
-- Mirrors the committed public.content_revision_immutable pattern: replace the generated
-- blanket <name>_rw policy with SELECT + INSERT member policies, then a hardened
-- SECURITY DEFINER BEFORE UPDATE OR DELETE guard raising 2F004.
drop policy if exists platform_event_rw on public.platform_event;
create policy platform_event_select on public.platform_event
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy platform_event_insert on public.platform_event
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

create or replace function public.platform_event_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'platform_event is append-only and immutable' using errcode = '2F004';
end;
$$;
revoke all on function public.platform_event_immutable() from public, anon, authenticated;
drop trigger if exists platform_event_no_mutate on public.platform_event;
create trigger platform_event_no_mutate
  before update or delete on public.platform_event
  for each row execute function public.platform_event_immutable();

-- ── 2b. segment_snapshot_member: append-only, RLS-ONLY (F3 — NO 2F004 trigger) ─
-- Replace the blanket _rw with SELECT + INSERT member policies and add NO immutability trigger.
-- Rationale: snapshot_id is `on delete cascade` from segment_snapshot (itself cascaded from
-- segment). A BEFORE UPDATE/DELETE 2F004 trigger would ALSO fire on that cascade DELETE and abort
-- an otherwise-permitted parent segment/snapshot delete with a cryptic 2F004. With RLS only, a
-- DIRECT user DELETE is blocked (no DELETE policy → the delete is an RLS no-op, 0 rows), while a
-- cascade delete (a referential action that bypasses RLS) still cleans the child up. platform_event
-- (a top-level fact with no cascade parent) KEEPS its 2F004 trigger in 2a.
drop policy if exists segment_snapshot_member_rw on public.segment_snapshot_member;
create policy segment_snapshot_member_select on public.segment_snapshot_member
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy segment_snapshot_member_insert on public.segment_snapshot_member
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

-- ── 3. segment_membership uniqueness (one membership per subject per segment) ─
alter table public.segment_membership
  drop constraint if exists segment_membership_segment_subject_key;
alter table public.segment_membership
  add constraint segment_membership_segment_subject_key unique (segment_id, subject_ref);

-- ── 4. internal event bridge ─────────────────────────────────────────────────
-- Allow-list of movp_events.type values that fan out to public.platform_event. Mirrors the
-- movp_internal.webhooks internal-table template: RLS enabled, no privileges to
-- anon/authenticated, all privileges to service_role.
create table if not exists movp_internal.segmentation_bridged_type (
  event_type text primary key
);
alter table movp_internal.segmentation_bridged_type enable row level security;
revoke all on movp_internal.segmentation_bridged_type from anon, authenticated;
grant all on movp_internal.segmentation_bridged_type to service_role;
insert into movp_internal.segmentation_bridged_type (event_type) values
  ('account.created'), ('registration.completed'), ('onboarding.completed')
  on conflict (event_type) do nothing;

-- Hardened SECURITY DEFINER trigger. NOTE: a trigger WHEN clause cannot contain a subquery,
-- so the allow-list membership test lives in the function body as IF EXISTS(...). search_path=''
-- and every object is fully schema-qualified (check-definer-audit gate).
--
-- BRIDGE-MUST-NOT-ABORT-THE-CALLER GUARD (F1): this AFTER INSERT trigger runs INSIDE the caller's
-- business transaction (emit_event inserts movp_events there). public.platform_event.workspace_id
-- AND .subject_ref are NOT NULL — if either were unresolved, the NOT NULL violation raised here
-- would roll back the caller's UNRELATED business write. movp_events.workspace_id is nullable and
-- the payload may carry neither id nor subject_ref, so we SKIP SILENTLY unless workspace_id is
-- present AND a subject_ref resolves. A bad bridged payload must never abort a business transaction.
--
-- PAYLOAD CONTRACT every bridged emitter must satisfy: the payload MUST carry `id` OR `subject_ref`
-- (else the event is skipped, not bridged); it SHOULD carry `subject_type` OR `entity_type` (else
-- subject_type defaults to 'user'). Mapping: source='internal', occurred_at=movp_events.created_at,
-- subject_ref=coalesce(payload subject_ref, payload id), subject_type=coalesce(payload subject_type,
-- payload entity_type, 'user') — committed emitters put the entity kind in `entity_type`, not
-- `subject_type` (F2).
create or replace function movp_internal.bridge_event_to_platform()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_subject_ref text := coalesce(new.payload->>'subject_ref', new.payload->>'id');
begin
  if new.workspace_id is not null
     and v_subject_ref is not null
     and exists (
       select 1 from movp_internal.segmentation_bridged_type t
       where t.event_type = new.type
     )
  then
    insert into public.platform_event (
      workspace_id, event_type, subject_type, subject_ref, actor_ref,
      source, properties, occurred_at, ingested_at
    ) values (
      new.workspace_id,
      new.type,
      coalesce(new.payload->>'subject_type', new.payload->>'entity_type', 'user'),
      v_subject_ref,
      new.payload->>'actor_ref',
      'internal',
      new.payload,
      new.created_at,
      now()
    );
  end if;
  return new;
end;
$$;
revoke all on function movp_internal.bridge_event_to_platform() from public, anon, authenticated;
drop trigger if exists bridge_event_to_platform_tg on movp_internal.movp_events;
create trigger bridge_event_to_platform_tg
  after insert on movp_internal.movp_events
  for each row execute function movp_internal.bridge_event_to_platform();
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_test.sql .. ok` (all 52 assertions pass — the two indexes now exist, the unique is present, `segmentation_bridged_type` denies authenticated, the two `platform_event` `2F004` immutability throws fire, the `segment_snapshot_member` direct delete is an RLS no-op while a parent-segment cascade delete succeeds (F3), the two `emit_event` guard cases do not raise and insert no `platform_event` (F1), and the bridge maps `account.created` to exactly one `platform_event` — `subject_type` from `entity_type` (F2) — while `note.created` fans out none); every other test file still `ok`; definer-audit prints its pass line (exit 0) with both new definers (`platform_event_immutable`, `bridge_event_to_platform`) pinned; `supabase db diff` prints nothing.

- [ ] **Step 5: Gate — indexes, immutability, and exactly two blanket policies dropped**

Run:
```bash
grep -cE 'create index if not exists (platform_event_subject_idx|platform_event_type_time_idx)' \
  supabase/migrations/20260701000019_segmentation.sql
grep -cF "errcode = '2F004'" supabase/migrations/20260701000019_segmentation.sql
grep -c 'security definer' supabase/migrations/20260701000019_segmentation.sql
grep -cE '^drop policy if exists (platform_event|segment_snapshot_member)_rw ' \
  supabase/migrations/20260701000019_segmentation.sql
grep -cE '^drop policy if exists (segment|segment_rule|segment_membership|segment_snapshot|segment_recompute_run)_rw ' \
  supabase/migrations/20260701000019_segmentation.sql
node scripts/check-definer-audit.mjs
```
Expected: first grep prints `2` (both composite indexes created); second prints `1` (the fixed-string grep matches the single `errcode = '2F004'` RAISE — only `platform_event_immutable`; `segment_snapshot_member` is RLS-only per F3, no immutability trigger — so this counts raises, not the prose comments that mention `2F004`); third prints `2` (the one immutability function + the bridge function are `security definer`); fourth prints `2` (BOTH `platform_event_rw` and `segment_snapshot_member_rw` are dropped and replaced with append-only SELECT+INSERT policies — segment_snapshot_member still drops its blanket policy, it just adds no trigger); fifth prints `0` (the other five collections keep their generated blanket `is_workspace_member` policy — the trailing space in each pattern pins the bare `<name>_rw ` token so `segment_snapshot_member_rw` never matches the `segment_snapshot_rw ` pattern); definer-audit exits `0`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000019_segmentation.sql supabase/tests/segmentation_test.sql
git commit -m "feat(db): segmentation indexes, append-only guards, membership unique + internal event bridge"
```

---

## Self-Review

- **Spec coverage (Part A scope):** Seven Segmentation collections defined config-first (NOT `internal`) — the append-only fact `platform_event`, `segment`, `segment_rule`, `segment_membership`, the snapshot pair `segment_snapshot`/`segment_snapshot_member` (the member append-only), and the audit `segment_recompute_run` — wired into `defineSchema`/`index.ts` in FK-safe order, regenerated + committed (Task 1); then migration `000019` (Task 2) hand-adds the two composite `platform_event` indexes, the append-only guards (a 2F004 immutability trigger on `platform_event`; RLS-only SELECT+INSERT on `segment_snapshot_member`, F3), the `segment_membership` `unique(segment_id, subject_ref)` (with `subject_ref not null`, F8), and the internal event bridge (allow-list table + a guarded, non-aborting `AFTER INSERT` trigger, F1). Each task ends with a machine-checkable gate (`pnpm codegen`+`git diff --exit-code`, `supabase db reset`/`test db`/`db diff`, `check-definer-audit.mjs`, greps).
- **Contract fidelity (Parts B/C/D depend on these):**
  - **Collection field lists** are exactly as specified in the shared contract. `platform_event`: event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at. `segment`: name, description, owner_ref, active, mode. `segment_rule`: segment, predicate, version, active, description. `segment_membership`: segment, subject_type, subject_ref, matched_rule, first_matched_at, evaluated_at, evidence. `segment_snapshot`: segment, taken_at, reason, rule_version_set, member_count. `segment_snapshot_member`: snapshot, subject_ref, matched_rule, evidence. `segment_recompute_run`: segment, mode, started_at, finished_at, added_count, removed_count, evaluated_count, idempotency_key, outcome_code.
  - **FK column names:** `segment_rule.segment`/`segment_membership.segment`/`segment_snapshot.segment`/`segment_recompute_run.segment`→`segment_id` (required, cascade); `segment_snapshot_member.snapshot`→`snapshot_id` (required, cascade); `segment_membership.matched_rule`/`segment_snapshot_member.matched_rule`→`matched_rule_id` (optional, set null). Pinned by seven `has_column` + a `pg_constraint` resolution assertion + the `git`-committed generated types.
  - **Reporting measures:** `segment_snapshot.member_count`, `segment_recompute_run.added_count`, `segment_recompute_run.removed_count`, `segment_recompute_run.evaluated_count` (four `measure` reads). **Dimensions:** `platform_event.event_type`/`subject_type`/`source`/`occurred_at` (four `dimension` reads), plus `segment.active`/`mode`, `segment_rule.active`, `segment_membership.subject_type`, `segment_snapshot.reason`, `segment_recompute_run.mode`.
  - **Bridge contract:** for an allow-listed `movp_events.type` **with a non-null `workspace_id` and a resolvable `subject_ref`**, exactly one `public.platform_event` with `source='internal'`, `occurred_at=new.created_at`, `subject_ref=coalesce(payload subject_ref, payload id)`, `subject_type=coalesce(payload subject_type, payload entity_type, 'user')` (F2 — committed emitters carry the entity kind in `entity_type`), `properties=payload`; a non-allow-listed type — OR an allow-listed one that lacks a workspace_id or a resolvable subject_ref — produces none, and crucially does NOT raise (F1: the AFTER INSERT bridge runs inside the caller's business transaction and must never abort it). Allow-list seed: `account.created`, `registration.completed`, `onboarding.completed`. Pinned by count + source + subject_ref + subject_type(=entity_type) + occurred_at reads + the non-bridged 0-count + two `emit_event` `lives_ok` guard cases (null ws / empty payload) with a surviving companion insert.
- **Correctness / self-consistency:** collection order (`platform_event` first; `segment` before its children; `segment_rule` before `segment_membership`/`segment_snapshot_member`; `segment_snapshot` before `segment_snapshot_member`) satisfies every codegen-inlined FK. The generated `<Name>Row` shapes follow `id, workspace_id, dataFields(defn order), fkFields(defn order), created_at, updated_at` ordering and `required || default` nullability (only the FK names/nullability and the measures are load-bearing; scalar TS types defer to the committed file). The bridge's allow-list test (and the F1 guard's `workspace_id`/`subject_ref` non-null checks) live inside the function body rather than a trigger WHEN clause because Postgres forbids subqueries in WHEN — noted at the trigger site. `segment_membership.subject_ref` and `segment_snapshot_member.subject_ref` are `not null` (F8) so a null subject can never occupy the dedup key. Every 000019-dependent RED assertion is genuinely red under the prior state (no indexes/unique/allow-list table; no `platform_event` 2F004 trigger; the blanket `segment_snapshot_member_rw` still PERMITS a member's direct delete so the survival check reads 0; no bridge so the five mapping reads are empty/NULL). The F1 guard block and the F3 cascade-succeeds block are green in BOTH states by design — they are regression guards that turn RED only against a mis-implementation (an unguarded bridge, or a 2F004 trigger on the cascade child), not against the pre-`000019` baseline.
- **Safety:** the base gate is `is_workspace_member` (non-member sees 0 rows in all seven tables — pinned, and REAL: every table carries a W1 row seeded before the role switch, so the 0-count reflects the RLS filter, not an empty table). A workspace member CAN SELECT `platform_event`/`segment` (positive read, pinned). Both `platform_event` and `segment_snapshot_member` are append-only at the data boundary (members INSERT; blanket `_rw` replaced with SELECT+INSERT), but the mutation guard differs (F3): `platform_event` UPDATE/DELETE raise `2F004` via a hardened `SECURITY DEFINER` trigger (`search_path=''`, schema-qualified, `execute` revoked); `segment_snapshot_member` has NO trigger — a direct member delete is an RLS no-op (no DELETE policy), while a parent cascade cleans it up, so a permitted parent delete is never aborted by a cryptic 2F004. The `segmentation_bridged_type` allow-list is an internal table (RLS enabled, revoked from anon/authenticated, granted only to service_role — `table_privs_are` pins that authenticated has no privileges), so a tenant cannot widen the set of internal events that reach `platform_event`. The bridge function is a hardened definer too, and is GUARDED (F1) so a workspace-less or subject-less bridged event skips silently rather than raising a NOT NULL violation that would roll back the caller's business transaction. `check-definer-audit.mjs` runs after `000019` and covers both new definers (`platform_event_immutable`, `bridge_event_to_platform`).
- **Reliability / drift:** every implementation task ends with `supabase db reset` + `supabase db diff` empty; codegen reproducibility pinned by `git diff --exit-code`. `create index if not exists`, `create or replace function`, `drop trigger if exists`, `drop policy if exists`, `create table if not exists`, `insert … on conflict do nothing`, and `alter table … drop constraint if exists` before add keep `000019` re-runnable on a fresh reset. Crucially, the bridge is fault-isolated from its caller (F1): because it runs as an AFTER INSERT trigger INSIDE the business transaction, a malformed bridged event (no workspace_id, or no resolvable subject_ref) is SKIPPED silently rather than raising a NOT NULL violation that would roll back the caller's unrelated write — pinned by two `emit_event` `lives_ok` guard cases + a surviving companion insert. The full `supabase test db` (all test files) is the regression net. Step 0's hard guard (grep for `movp_internal.movp_events`) stops loudly if the internal events log dependency is unmet — a merge-order problem, not a Segmentation defect.
- **Observability:** `platform_event` IS the Part A observability surface — the bridge records a structured, ids/classifiers-only fact (with `properties` = the source payload) for every allow-listed internal event, carrying `subject_ref`/`event_type`/`occurred_at` for correlation, diagnosable from the row alone. Emitting from the bridge is `source='internal'`; external ingestion (`source='external'`) and the recompute-run audit log (`segment_recompute_run` rows) are Part B — stated N/A here, not skipped.
- **Efficiency / Performance:** no new hot-path work in Part A; the generic surface, FTS and reporting metadata are codegen artifacts. `platform_event.event_type` is deliberately NOT searchable (F5) — codegen therefore emits NO `search_vector` column, GIN index, or BEFORE INSERT/UPDATE tsvector trigger on the highest-volume append-only fact, so neither a bridge insert nor a 500-row ingest batch pays tsvector maintenance; equality lookups are served by the composite indexes and the enum/dimension columns instead. The two composite `platform_event` indexes exist so Part B/C reporting queries (`workspace_id, subject_ref, event_type, occurred_at` and `workspace_id, event_type, occurred_at`) are index-covered rather than sequential scans on the fact table; codegen deliberately emits no composite index, so these are hand-added (Task precedent). The bridge's allow-list check is a single-row PK/`EXISTS` lookup per inserted event.
- **Simplicity / Usability:** no speculative columns beyond the contract; the allow-list is a deliberate control surface (three seeded types), not speculative generality — it is the minimal mechanism to keep the internal→`platform_event` fan-out explicit and revocable. Part A ships no user-facing UI (Part D) and no rule-evaluation/recompute engine (Part B) — both stated N/A. The append-only invariant is enforced structurally, per table: `platform_event` by RLS + a `2F004` trigger, `segment_snapshot_member` by RLS alone (F3 — no trigger, so a permitted parent cascade delete is not aborted) — not by convention.
- **Dependency assumption (stated, F7):** Part A's FUNCTIONAL prerequisites are only the Core backbone (`movp_internal.movp_events`, `public.emit_event`, `movp_internal.webhooks` template, `public.is_workspace_member`, `public.movp_fields`, the codegen pipeline) — all present by `000001`–`000007`; it does NOT functionally depend on Task/CMS/Campaigns. The `000019` NUMBER is a separate, filename-sort concern (it must sort after `000018`). The bridge is DORMANT in production until emitters for the three allow-listed types ship. Step 0's grep guard stops loudly if the events log is absent; the trigger-site comment and the Global Constraint call this out.
- **Deferred to Parts B/C/D (intentional):** the rule-evaluation/recompute engine, membership diffing, snapshot writers, external-source ingestion, reporting rollups/queries over the fact + measures, MCP/CLI surfaces, and all frontend — none are needed for the data/index/immutability/uniqueness/bridge deliverable and none are touched here.
- **Placeholder scan:** none — every SQL/TS block is complete and copy-paste-ready; every step has an exact command + expected output. The only intentionally-illustrative content is the regenerated `types.ts` scalar mapping (labeled "codegen output — verify, do NOT hand-edit"; the committed file is authoritative and the greps + `git diff --exit-code` pin it).
