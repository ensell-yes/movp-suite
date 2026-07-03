# MOVP App — Campaigns Phase 5, Part A: Data Model, FK & Lifecycle Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the seven Campaigns collections — `marketing_plan`, `campaign`, `campaign_channel`, `campaign_deliverable`, `campaign_calendar_event`, `campaign_metric`, `campaign_segment` — to the config-first schema so codegen emits their base tables, the blanket workspace-member RLS, FTS, the `movp_fields` reporting metadata, and generated types; then hand-author migration `20260701000017_campaigns.sql` for the two parts codegen cannot express: the two **audit-only** AFTER-INSERT lifecycle triggers (`campaign.created`, `deliverable.created`) and the owner-restricted **edit-gating RLS overrides** on `campaign` and `marketing_plan`.

**Architecture:** Collections are defined in `packages/core-schema/src/collections/`, wired into `defineSchema()` (`schema.ts`) and re-exported (`index.ts`). Running `pnpm codegen` regenerates BOTH `supabase/migrations/20260701000002_movp_generated.sql` (base tables, the blanket `<name>_rw` `is_workspace_member` RLS policy, grants, FTS for searchable fields, `movp_collections`/`movp_fields` registry rows) AND `packages/domain/src/generated/types.ts` (`MarketingPlan*`, `Campaign*`, `CampaignChannel*`, `CampaignDeliverable*`, `CampaignCalendarEvent*`, `CampaignMetric*`, `CampaignSegment*` — `*Row/*Create/*Update`, **consumed by Parts B and C**). User references are plain `f.uuid` columns (never `relation('user')`). Relations emit `<fieldkey>_id` FK columns: `campaign.marketing_plan`→`marketing_plan_id` (optional → `on delete set null`); every child's `campaign`→`campaign_id` (required → `not null … on delete cascade`); `campaign_deliverable.channel`/`campaign_metric.channel`→`channel_id` (optional → set null); `campaign_metric.deliverable`→`deliverable_id` (optional → set null). **Unlike Task/CMS, Campaigns collections are config-first and NOT `internal`** — codegen emits the full generic GraphQL/MCP/CLI CRUD surface, `Page`, workspace-member RLS, FTS and reporting metadata for free. Everything codegen cannot emit lives in the hand-authored `20260701000017_campaigns.sql`, which sorts AFTER every Core/Collaboration/Task/CMS migration (`20260701000001` .. `000016`): the two hardened `SECURITY DEFINER` audit-only triggers, then the edit-gating RLS overrides (top-to-bottom order — triggers first, then policies).

**Tech Stack:** TypeScript (`@movp/core-schema`, `@movp/codegen`), Supabase CLI (local stack, migrations, pgTAP via `supabase test db`), Postgres RLS + `SECURITY DEFINER`, the existing `public.workspace` / `public.workspace_membership` / `public.is_workspace_member(uuid)` tenancy backbone, and the existing `public.emit_event(text,uuid,jsonb,text)` fan-out (`20260701000005`, hardened by Task phase `000009` — see below).

**This is Part A of the Phase 5 (Campaigns) series.** Build order: Phase 5 runs after Core+Collaboration (executed, `000001`–`000007`), Task (planned `000008`–`000010`), and CMS (planned `000011`–`000016`). This plan assumes **all of those are merged before Campaigns**, so `public.emit_event`, `movp_internal.movp_events`, `movp_internal.movp_jobs`, `public.is_workspace_member`, and the codegen pipeline are present. Campaigns hand-authored migrations start at `20260701000017`. **Part B** (Task-reuse edge `implemented_by`, the remaining lifecycle events, dependency/rollup services, notifiers) and **Part C** (surfaces/frontend) consume the generated `Campaign*` types, the FK column names, and the two event contracts — do not rename a collection, field, FK column, option label, or event type without updating B and C.

## Global Constraints

- **Config-first collections.** New tables are added by defining a collection and running `pnpm codegen` — never by hand-writing a `create table` in a migration. The generated `20260701000002_movp_generated.sql` is a build artifact; commit it, never edit it by hand.
- **`pnpm codegen` is reproducible and committed.** After changing collections, run `pnpm codegen`, commit the regenerated migration AND `packages/domain/src/generated/types.ts`. Re-running codegen must produce no diff (`git diff --exit-code` on both files is clean). CI's migration-drift job (`supabase db reset` → `supabase db diff` empty) fails if the committed migration is stale.
- **Every field needs a `label`.** `defineCollection` throws if any field omits `label` or if an enum has empty `values`; `pnpm codegen` imports the schema and therefore fails loudly on a malformed collection. User references are `f.uuid`, never `relation('user')`.
- **NOT `internal`.** None of the seven Campaigns collections sets `internal: true`. They are user-facing config-first tables; codegen emits the generic CRUD surface, `Page`, RLS, FTS and metadata for them (Parts B/C build reporting and Task-reuse on top).
- **Collection order encodes FK dependencies.** Codegen inlines each relation's FK into the referencing table's `create table`, so a relation target MUST be defined before the collection that references it. Append the seven in exactly this relative order at the END of the existing `defineSchema([...])` list: `marketingPlan`, `campaign`, `campaignChannel`, `campaignDeliverable`, `campaignCalendarEvent`, `campaignMetric`, `campaignSegment` — plan before campaign; campaign + campaign_channel before deliverable/metric. Campaigns reference only each other, so placing them after whatever Core/Collab/Task/CMS collections already exist is safe.
- **The `campaign_deliverable` table is column-THIN — a load-bearing invariant.** It carries NO `status`/`start_date`/`due_date`/`priority`/`assignee_user_id`/`description` columns. Those live on the linked task (Part B adds the `implemented_by` edge). A pgTAP no-duplication gate asserts their ABSENCE; do not add them.
- **`emit_event` is consumed, never re-declared.** The two triggers `perform public.emit_event(...)`. The Task phase (`000009`) hardened `public.emit_event` so it only enqueues a `notify` job when the payload carries `recipient_user_id` or `email`. Campaigns' two events are **audit-only** — their payloads carry ids/classifiers ONLY (no `recipient_user_id`/`email`) — so `emit_event` records the row in `movp_internal.movp_events` and fans out any registered webhook, but enqueues NO `notify` job. **Do NOT re-declare `emit_event` in `000017`.** (If the "no notify job" pgTAP assertions fail, the guarded `emit_event` from `000009` is not applied — a merge-order/dependency problem, not a Campaigns bug.)
- **All `SECURITY DEFINER` functions hardened:** `set search_path = ''`, every object fully schema-qualified, `execute` revoked from `public`/`anon`/`authenticated` (trigger fns are invoked by the trigger, not called directly). The definer-audit gate (`node scripts/check-definer-audit.mjs`) fails any `security definer` function missing a pinned `search_path`.
- **Authoritative authz at the data boundary.** RLS is the gate. Membership uses `public.is_workspace_member(workspace_id)`; owner gating uses the network-verified principal `(select auth.uid())`. Five of the seven tables keep the generated blanket `<name>_rw` policy; only `campaign` and `marketing_plan` get owner-restricted UPDATE/DELETE overrides.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  packages/
    core-schema/src/
      collections/
        marketing_plan.ts            # NEW
        campaign.ts                  # NEW
        campaign_channel.ts          # NEW
        campaign_deliverable.ts      # NEW (column-THIN)
        campaign_calendar_event.ts   # NEW
        campaign_metric.ts           # NEW (FACT table)
        campaign_segment.ts          # NEW (forward seam, inert)
      schema.ts                      # EDIT: append the seven collections to defineSchema([...])
      index.ts                       # EDIT: re-export the seven collections
    domain/src/generated/
      types.ts                       # REGENERATED by `pnpm codegen` (commit)
  supabase/
    migrations/
      20260701000002_movp_generated.sql   # REGENERATED by `pnpm codegen` (commit)
      20260701000017_campaigns.sql         # NEW hand-authored (built up across Tasks 2–3)
    tests/
      campaigns_test.sql                   # NEW pgTAP (built up across Tasks 2–3)
```

---

### Task 1: Define the seven Campaigns collections + regenerate

**Files:**
- Create: `packages/core-schema/src/collections/marketing_plan.ts`, `campaign.ts`, `campaign_channel.ts`, `campaign_deliverable.ts`, `campaign_calendar_event.ts`, `campaign_metric.ts`, `campaign_segment.ts`
- Edit: `packages/core-schema/src/schema.ts`, `packages/core-schema/src/index.ts`
- Regenerate (do NOT hand-edit): `supabase/migrations/20260701000002_movp_generated.sql`, `packages/domain/src/generated/types.ts`

**Interfaces:**
- Consumes: `f` + `defineCollection` (`packages/core-schema/src/builders.ts`, `define.ts`); the existing Core/Collaboration (and, in merge order, Task/CMS) collections.
- Produces (Parts B/C consume): base tables `public.{marketing_plan,campaign,campaign_channel,campaign_deliverable,campaign_calendar_event,campaign_metric,campaign_segment}` with blanket `<name>_rw` RLS + grants + FTS + `movp_fields` reporting rows, and generated types `MarketingPlan*`, `Campaign*`, `CampaignChannel*`, `CampaignDeliverable*`, `CampaignCalendarEvent*`, `CampaignMetric*`, `CampaignSegment*`.

This task is config + codegen; its gates are `pnpm codegen` succeeding, a clean `supabase db reset`/`db diff`, `pnpm typecheck`, and greps proving the 7 tables + 21 interfaces + the FK `_id` columns were emitted.

- [ ] **Step 1: Create `marketing_plan` (plan before campaign — FK ordering)**

`packages/core-schema/src/collections/marketing_plan.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const marketingPlan = defineCollection({
  name: 'marketing_plan',
  label: 'Marketing Plan',
  labelPlural: 'Marketing Plans',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    description: f.richText({ label: 'Description', searchable: true }),
    period_start: f.date({ label: 'Period Start', reporting: { role: 'dimension' } }),
    period_end: f.date({ label: 'Period End', reporting: { role: 'dimension' } }),
    goals: f.json({ label: 'Goals' }),
    // User reference is a plain uuid (no FK to auth.users).
    owner_id: f.uuid({ label: 'Owner' }),
    status: f.enum(['draft', 'active', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})
```

- [ ] **Step 2: Create `campaign`**

`packages/core-schema/src/collections/campaign.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaign = defineCollection({
  name: 'campaign',
  label: 'Campaign',
  labelPlural: 'Campaigns',
  workspaceScoped: true,
  fields: {
    // Optional relation -> `marketing_plan_id uuid references public.marketing_plan(id) on delete set null`.
    marketing_plan: f.relation('marketing_plan', { label: 'Marketing Plan', cardinality: 'many-to-one' }),
    name: f.text({ label: 'Name', required: true, searchable: true }),
    brief: f.richText({ label: 'Brief', searchable: true, embeddable: true }),
    start_date: f.date({ label: 'Start Date', reporting: { role: 'dimension' } }),
    end_date: f.date({ label: 'End Date', reporting: { role: 'dimension' } }),
    owner_id: f.uuid({ label: 'Owner' }),
    goal_metrics: f.json({ label: 'Goal Metrics' }),
    priority: f.enum(['low', 'medium', 'high', 'urgent'], {
      label: 'Priority',
      default: 'medium',
      reporting: { role: 'dimension' },
    }),
    rank: f.number({ label: 'Rank', reporting: { role: 'dimension' } }),
    status: f.enum(['draft', 'scheduled', 'active', 'completed', 'cancelled'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})
```

- [ ] **Step 3: Create `campaign_channel`**

`packages/core-schema/src/collections/campaign_channel.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignChannel = defineCollection({
  name: 'campaign_channel',
  label: 'Campaign Channel',
  labelPlural: 'Campaign Channels',
  workspaceScoped: true,
  fields: {
    // Required relation -> `campaign_id uuid not null references public.campaign(id) on delete cascade`.
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    channel_type: f.enum(['email', 'social', 'web', 'paid', 'event', 'sms', 'other'], {
      label: 'Channel Type',
      reporting: { role: 'dimension' },
    }),
    name: f.text({ label: 'Name' }),
  },
})
```

- [ ] **Step 4: Create `campaign_deliverable` (column-THIN)**

`packages/core-schema/src/collections/campaign_deliverable.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// THIN by design: no status/start_date/due_date/priority/assignee/description columns —
// those live on the linked task (Part B adds the `implemented_by` edge). A pgTAP
// no-duplication gate asserts their ABSENCE; do not add them here.
export const campaignDeliverable = defineCollection({
  name: 'campaign_deliverable',
  label: 'Campaign Deliverable',
  labelPlural: 'Campaign Deliverables',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    // Optional relation -> `channel_id uuid references public.campaign_channel(id) on delete set null`.
    channel: f.relation('campaign_channel', { label: 'Channel', cardinality: 'many-to-one' }),
    name: f.text({ label: 'Name', required: true, searchable: true }),
    deliverable_type: f.enum(['asset', 'post', 'email', 'landing_page', 'ad', 'event'], {
      label: 'Deliverable Type',
      reporting: { role: 'dimension' },
    }),
  },
})
```

- [ ] **Step 5: Create `campaign_calendar_event`**

`packages/core-schema/src/collections/campaign_calendar_event.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignCalendarEvent = defineCollection({
  name: 'campaign_calendar_event',
  label: 'Campaign Calendar Event',
  labelPlural: 'Campaign Calendar Events',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    title: f.text({ label: 'Title', required: true, searchable: true }),
    event_date: f.date({ label: 'Event Date', required: true, reporting: { role: 'dimension' } }),
    event_type: f.enum(['milestone', 'launch', 'review', 'deadline'], {
      label: 'Event Type',
      reporting: { role: 'dimension' },
    }),
  },
})
```

- [ ] **Step 6: Create `campaign_metric` (FACT table)**

`packages/core-schema/src/collections/campaign_metric.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignMetric = defineCollection({
  name: 'campaign_metric',
  label: 'Campaign Metric',
  labelPlural: 'Campaign Metrics',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    // Optional relations -> `deliverable_id`/`channel_id uuid references ... on delete set null`.
    deliverable: f.relation('campaign_deliverable', { label: 'Deliverable', cardinality: 'many-to-one' }),
    channel: f.relation('campaign_channel', { label: 'Channel', cardinality: 'many-to-one' }),
    metric_key: f.text({ label: 'Metric Key', reporting: { role: 'dimension' } }),
    value: f.number({ label: 'Value', reporting: { role: 'measure' } }),
    unit: f.text({ label: 'Unit', reporting: { role: 'dimension' } }),
    measured_at: f.date({ label: 'Measured At', reporting: { role: 'dimension' } }),
  },
})
```

- [ ] **Step 7: Create `campaign_segment` (forward seam — inert in Part A)**

`packages/core-schema/src/collections/campaign_segment.ts`:
```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Writable now — stores targeting INTENT (a user can record primary/lookalike/exclusion
// targeting immediately). The campaign→segment edge resolves to zero rows until Phase 6's
// `segment` collection lands, per the roadmap's forward-compatible-seam design. Segment
// RESOLUTION activates in Phase 6; do NOT defer this collection.
export const campaignSegment = defineCollection({
  name: 'campaign_segment',
  label: 'Campaign Segment',
  labelPlural: 'Campaign Segments',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    targeting_role: f.enum(['primary', 'lookalike', 'exclusion'], {
      label: 'Targeting Role',
      default: 'primary',
      reporting: { role: 'dimension' },
    }),
    weight: f.number({ label: 'Weight' }),
  },
})
```

- [ ] **Step 8: Wire the collections into the schema (APPEND, do not rewrite)**

In `packages/core-schema/src/schema.ts`, add these imports alongside the existing collection imports (keep the file's existing import style/ordering; the exact prior import set depends on which Task/CMS collections are merged):
```ts
import { campaign } from './collections/campaign.ts'
import { campaignCalendarEvent } from './collections/campaign_calendar_event.ts'
import { campaignChannel } from './collections/campaign_channel.ts'
import { campaignDeliverable } from './collections/campaign_deliverable.ts'
import { campaignMetric } from './collections/campaign_metric.ts'
import { campaignSegment } from './collections/campaign_segment.ts'
import { marketingPlan } from './collections/marketing_plan.ts'
```
Then append these seven entries to the END of the `defineSchema([...])` array — immediately before its closing `])`, preserving this EXACT relative order (FK targets precede referrers). Add the comment too:
```ts
  // Campaigns (Phase 5, Part A). Order encodes inline-FK deps:
  //  - marketing_plan precedes campaign (campaign.marketing_plan_id -> it).
  //  - campaign precedes every campaign_* child (child.campaign_id -> campaign).
  //  - campaign + campaign_channel precede deliverable/metric (channel_id/deliverable_id).
  marketingPlan,
  campaign,
  campaignChannel,
  campaignDeliverable,
  campaignCalendarEvent,
  campaignMetric,
  campaignSegment,
```

In `packages/core-schema/src/index.ts`, add these re-exports alongside the existing collection exports:
```ts
export { campaign } from './collections/campaign.ts'
export { campaignCalendarEvent } from './collections/campaign_calendar_event.ts'
export { campaignChannel } from './collections/campaign_channel.ts'
export { campaignDeliverable } from './collections/campaign_deliverable.ts'
export { campaignMetric } from './collections/campaign_metric.ts'
export { campaignSegment } from './collections/campaign_segment.ts'
export { marketingPlan } from './collections/marketing_plan.ts'
```

- [ ] **Step 9: Regenerate**

Run:
```bash
cd /Users/ensell/Code/supasuite && pnpm codegen
```
Expected: prints `wrote .../supabase/migrations/20260701000002_movp_generated.sql` and `wrote .../packages/domain/src/generated/types.ts`, exit 0. (A missing `label` or empty enum `values` makes `defineCollection` throw here — fix the collection and re-run.)

`packages/domain/src/generated/types.ts` will now contain the interfaces below (codegen output — **verify, do NOT hand-edit; Parts B/C import these**). Column ORDER is `id`, `workspace_id`, then data fields in definition order, then FK `_id` columns in definition order, then `created_at`, `updated_at`. Nullability is `required || default` → non-null, else nullable. Scalar TS types (e.g. how `numeric`/`jsonb`/`date` map) are whatever `emit-types.ts` produces — the committed file is authoritative; the shapes below are load-bearing only for the **FK `_id` column NAMES**, their nullability, and `campaign_metric.value` being present:
```ts
export interface MarketingPlanRow {
  id: string
  workspace_id: string
  name: string
  description: string | null
  period_start: string | null
  period_end: string | null
  goals: Record<string, unknown> | null
  owner_id: string | null
  status: 'draft' | 'active' | 'archived'
  created_at: string
  updated_at: string
}

export interface CampaignRow {
  id: string
  workspace_id: string
  name: string
  brief: string | null
  start_date: string | null
  end_date: string | null
  owner_id: string | null
  goal_metrics: Record<string, unknown> | null
  priority: 'low' | 'medium' | 'high' | 'urgent'
  rank: number | null
  status: 'draft' | 'scheduled' | 'active' | 'completed' | 'cancelled'
  marketing_plan_id: string | null      // FK -> marketing_plan (optional, set null)
  created_at: string
  updated_at: string
}

export interface CampaignChannelRow {
  id: string
  workspace_id: string
  channel_type: 'email' | 'social' | 'web' | 'paid' | 'event' | 'sms' | 'other' | null
  name: string | null
  campaign_id: string                   // FK -> campaign (required, cascade)
  created_at: string
  updated_at: string
}

export interface CampaignDeliverableRow {
  id: string
  workspace_id: string
  name: string
  deliverable_type: 'asset' | 'post' | 'email' | 'landing_page' | 'ad' | 'event' | null
  campaign_id: string                   // FK -> campaign (required, cascade)
  channel_id: string | null             // FK -> campaign_channel (optional, set null)
  created_at: string
  updated_at: string
  // NOTE: intentionally NO status/start_date/due_date/priority/assignee_user_id/description.
}

export interface CampaignCalendarEventRow {
  id: string
  workspace_id: string
  title: string
  event_date: string
  event_type: 'milestone' | 'launch' | 'review' | 'deadline' | null
  campaign_id: string                   // FK -> campaign (required, cascade)
  created_at: string
  updated_at: string
}

export interface CampaignMetricRow {
  id: string
  workspace_id: string
  metric_key: string | null
  value: number | null                  // reporting measure
  unit: string | null
  measured_at: string | null
  campaign_id: string                   // FK -> campaign (required, cascade)
  deliverable_id: string | null         // FK -> campaign_deliverable (optional, set null)
  channel_id: string | null             // FK -> campaign_channel (optional, set null)
  created_at: string
  updated_at: string
}

export interface CampaignSegmentRow {
  id: string
  workspace_id: string
  targeting_role: 'primary' | 'lookalike' | 'exclusion'
  weight: number | null
  campaign_id: string                   // FK -> campaign (required, cascade)
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
grep -cE 'create table if not exists public\.(marketing_plan|campaign|campaign_channel|campaign_deliverable|campaign_calendar_event|campaign_metric|campaign_segment) \(' \
  supabase/migrations/20260701000002_movp_generated.sql
grep -cE 'interface (MarketingPlan|Campaign|CampaignChannel|CampaignDeliverable|CampaignCalendarEvent|CampaignMetric|CampaignSegment)(Row|Create|Update)' \
  packages/domain/src/generated/types.ts
grep -cE '(marketing_plan_id|campaign_id|channel_id|deliverable_id)' packages/domain/src/generated/types.ts
pnpm codegen && git diff --exit-code \
  supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
```
Expected: first grep prints `7` (all seven tables emitted); second prints `21` (7 collections × Row/Create/Update); third is `>= 4` (the FK `_id` columns are present); the `git diff --exit-code` exits `0` (re-running codegen changed nothing — reproducible).

- [ ] **Step 12: Commit**

```bash
git add packages/core-schema/src supabase/migrations/20260701000002_movp_generated.sql packages/domain/src/generated/types.ts
git commit -m "feat(schema): add campaigns collections (marketing_plan + campaign + channel/deliverable/calendar/metric/segment)"
```

---

### Task 2: Migration `000017` part 1 — audit-only lifecycle triggers + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000017_campaigns.sql`
- Create: `supabase/tests/campaigns_test.sql`

**Interfaces:**
- Consumes: the seven generated tables from Task 1; `public.emit_event(text,uuid,jsonb,text)` (existing, hardened by `000009`); `movp_internal.movp_events`, `movp_internal.movp_jobs`; `public.movp_fields`.
- Produces: `public.campaign_created_emit_event()` + trigger `campaign_created_emit_event_tg`; `public.campaign_deliverable_created_emit_event()` + trigger `campaign_deliverable_created_emit_event_tg`. **Invariants:** both are hardened `SECURITY DEFINER` (`set search_path = ''`), live in `public` (mirroring `note_created_emit_event`), and emit **audit-only** payloads (ids/classifiers only, NO `recipient_user_id`/`email`) so `emit_event` enqueues NO `notify` job. `campaign.created` payload = `{id, entity_type:'campaign', entity_id, status, marketing_plan_id}`; `deliverable.created` payload = `{id, entity_type:'campaign_deliverable', entity_id, campaign_id, deliverable_type}` (`entity_type`/`entity_id` are the cross-part contract keyed on by Part C's e2e and the inbox — do NOT drop them).

- [ ] **Step 0: Guard — is the guarded `emit_event` (Task 000009) merged?**

Part A's "audit-only → no notify job" assertions only hold once Task's `20260701000009` guarded `emit_event` is merged (the committed `emit_event` in `000005` enqueues a notify job unconditionally). Confirm the guard is present before writing the migration:
```bash
grep -qE "recipient_user_id|email" supabase/migrations/20260701000009_*.sql 2>/dev/null \
  || { echo "DEPENDENCY MISSING: guarded emit_event (Task 000009) not merged — the 'no notify job' assertions require it. STOP."; exit 1; }
```
Expected: prints nothing / passes (exit 0) when Task is merged; STOPs loudly (exit 1) otherwise. If it STOPs, this is a merge-order/dependency problem (Task/CMS `000008`–`000016` must land before `000017`), not a Campaigns bug — resolve the merge order, do not work around it.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/campaigns_test.sql` (this file grows in Task 3; `plan(N)` is bumped then). The base seed runs as the table owner (RLS bypassed): W1 with members A (owner) and C (member); B is NOT a member. It seeds MP1 (owned by A), CAMP1 (owned by A, under MP1), CAMP2 (owned by C, under MP1 — exercises the plan-owner branch in Task 3), one channel, and one deliverable:
```sql
begin;
select plan(26);

-- ── base seed (as table owner; RLS bypassed) ────────────────────────────────
-- W1 members: A (owner), C (member). B is NOT a member of W1.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- Marketing plan MP1 (owned by A).
insert into public.marketing_plan (id, workspace_id, name, owner_id, status) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'MP1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'active');
-- CAMP1: owned by A, under MP1.
insert into public.campaign (id, workspace_id, marketing_plan_id, name, owner_id, status) values
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'a0000000-0000-0000-0000-000000000001', 'CAMP1',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'draft');
-- CAMP2: owned by C, but under MP1 (owned by A) — exercises the plan-owner branch (Task 3).
insert into public.campaign (id, workspace_id, marketing_plan_id, name, owner_id, status) values
  ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'a0000000-0000-0000-0000-000000000001', 'CAMP2',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'draft');
-- Channel + deliverable under CAMP1.
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name) values
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'email', 'Email');
insert into public.campaign_deliverable (id, workspace_id, campaign_id, channel_id, name, deliverable_type) values
  ('e0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'Launch Email', 'email');
-- Calendar event, metric, and segment under CAMP1 — seeded so the Task 3 non-member
-- 0-count assertions on these three tables are REAL RLS filters, not vacuous empty-table
-- reads (a member would also see 0 rows in an empty table).
insert into public.campaign_calendar_event (id, workspace_id, campaign_id, title, event_date, event_type) values
  ('f0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'Launch Day', '2026-08-01', 'launch');
insert into public.campaign_metric (id, workspace_id, campaign_id, metric_key, value, measured_at) values
  ('b0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'impressions', 1000, '2026-08-02');
insert into public.campaign_segment (id, workspace_id, campaign_id, targeting_role) values
  ('a5000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-000000000001', 'primary');

-- ── Task 2: structural — tables exist ───────────────────────────────────────
select has_table('public', 'marketing_plan',         'marketing_plan table exists');
select has_table('public', 'campaign',               'campaign table exists');
select has_table('public', 'campaign_channel',       'campaign_channel table exists');
select has_table('public', 'campaign_deliverable',   'campaign_deliverable table exists');
select has_table('public', 'campaign_calendar_event','campaign_calendar_event table exists');
select has_table('public', 'campaign_metric',        'campaign_metric table exists');
select has_table('public', 'campaign_segment',       'campaign_segment table exists');

-- ── FK column names (Parts B/C depend on these EXACT names) ──────────────────
select has_column('public', 'campaign',             'marketing_plan_id', 'campaign has marketing_plan_id FK column');
select has_column('public', 'campaign_channel',     'campaign_id',       'campaign_channel has campaign_id FK column');
select has_column('public', 'campaign_deliverable', 'campaign_id',       'campaign_deliverable has campaign_id FK column');
select has_column('public', 'campaign_deliverable', 'channel_id',        'campaign_deliverable has channel_id FK column');
select has_column('public', 'campaign_metric',      'deliverable_id',    'campaign_metric has deliverable_id FK column');
select has_column('public', 'campaign_metric',      'channel_id',        'campaign_metric has channel_id FK column');

-- FK resolution: campaign.marketing_plan_id actually references public.marketing_plan.
select is((select count(*)::int from pg_constraint
           where conrelid = 'public.campaign'::regclass
             and confrelid = 'public.marketing_plan'::regclass
             and contype = 'f'),
          1, 'campaign.marketing_plan_id FK resolves to public.marketing_plan');
-- Behavioral: a dangling marketing_plan_id is rejected (proves the FK, not just a plain uuid).
select throws_ok(
  $$insert into public.campaign (workspace_id, marketing_plan_id, name)
    values ('11111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-0000000000ff', 'Dangling')$$,
  '23503', NULL, 'campaign.marketing_plan_id enforces its FK to marketing_plan');

-- ── no-duplication gate (LOAD-BEARING invariant) ────────────────────────────
select is((select count(*)::int from information_schema.columns
           where table_schema='public' and table_name='campaign_deliverable'
             and column_name in ('status','start_date','due_date','priority','assignee_user_id','description')),
          0, 'campaign_deliverable duplicates no task/scheduling state');

-- ── reporting roles (codegen writes movp_fields.reporting_role) ──────────────
select is((select reporting_role from public.movp_fields
           where collection_name='campaign_metric' and name='value'),
          'measure', 'campaign_metric.value is a reporting measure');
select is((select reporting_role from public.movp_fields
           where collection_name='campaign_metric' and name='metric_key'),
          'dimension', 'campaign_metric.metric_key is a reporting dimension');

-- ── audit-only lifecycle triggers (RED until part 1 exists) ─────────────────
-- The seed inserted CAMP1 and one deliverable; each AFTER INSERT trigger must record
-- exactly one event with an ids/classifiers-only payload.
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          1, 'campaign.created recorded exactly one event for CAMP1');
select is((select payload->>'status' from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          'draft', 'campaign.created payload carries the status classifier');
-- entity_id is the cross-part contract key (Part C's e2e + the inbox key on it).
select is((select payload->>'entity_id' from movp_internal.movp_events
           where type='campaign.created'
             and payload->>'id'='c0000000-0000-0000-0000-000000000001'),
          'c0000000-0000-0000-0000-000000000001',
          'campaign.created payload carries entity_id = the campaign row id');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          1, 'deliverable.created recorded exactly one event');
select is((select payload->>'deliverable_type' from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          'email', 'deliverable.created payload carries the deliverable_type classifier');
-- entity_id is the cross-part contract key (Part C's e2e + the inbox key on it).
select is((select payload->>'entity_id' from movp_internal.movp_events
           where type='deliverable.created'
             and payload->>'id'='e0000000-0000-0000-0000-000000000001'),
          'e0000000-0000-0000-0000-000000000001',
          'deliverable.created payload carries entity_id = the deliverable row id');
-- Audit-only: the guarded emit_event (000009) enqueues NO notify job for either event.
-- (These pass trivially before the triggers exist — no event -> no notify job — and remain
--  true after: the payloads carry no recipient_user_id/email. A FAILURE here means the
--  guarded emit_event from 000009 is not applied.)
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'campaign.created:%'),
          0, 'campaign.created is audit-only (no notify job enqueued)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify' and idempotency_key like 'deliverable.created:%'),
          0, 'deliverable.created is audit-only (no notify job enqueued)');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
supabase test db
```
Expected: FAIL — `campaigns_test.sql` fails the six trigger-event assertions (`campaign.created`/`deliverable.created` counts return `0`, and the classifier + `entity_id` reads return NULL) because no triggers exist yet. The structural, FK, no-duplication, reporting, and the two "no notify job" assertions PASS (Task 1 created the tables/metadata; with no events there are no notify jobs). The seed itself must apply cleanly — if it errors, a table/column/FK name is wrong; fix before proceeding. All other test files still pass.

- [ ] **Step 3: Create the migration with part 1 (triggers)**

Create `supabase/migrations/20260701000017_campaigns.sql` (exact path — do NOT use `supabase migration new`, which mints a wall-clock timestamp; this filename must sort after every `000001`–`000016` migration):
```sql
-- Campaigns Phase 5 — Part A. Sorts AFTER all Core/Collaboration/Task/CMS migrations
-- (20260701000001 .. 000016). Hand-authored: the two audit-only lifecycle triggers, then
-- the owner-restricted edit-gating RLS overrides on campaign/marketing_plan.

-- ── audit-only lifecycle events ──────────────────────────────────────────────
-- Mirrors public.note_created_emit_event (20260701000005): hardened SECURITY DEFINER,
-- pinned empty search_path, fully schema-qualified. Payload carries IDS/CLASSIFIERS ONLY
-- and NO recipient_user_id/email, so the guarded public.emit_event (Task phase, 000009)
-- records the row in movp_internal.movp_events and fans out any webhook, but enqueues NO
-- 'notify' job. Do NOT re-declare emit_event here.
create or replace function public.campaign_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'campaign.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type', 'campaign', 'entity_id', new.id, 'status', new.status, 'marketing_plan_id', new.marketing_plan_id),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
drop trigger if exists campaign_created_emit_event_tg on public.campaign;
create trigger campaign_created_emit_event_tg
  after insert on public.campaign
  for each row execute function public.campaign_created_emit_event();
revoke all on function public.campaign_created_emit_event() from public, anon, authenticated;

create or replace function public.campaign_deliverable_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'deliverable.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type', 'campaign_deliverable', 'entity_id', new.id, 'campaign_id', new.campaign_id, 'deliverable_type', new.deliverable_type),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
drop trigger if exists campaign_deliverable_created_emit_event_tg on public.campaign_deliverable;
create trigger campaign_deliverable_created_emit_event_tg
  after insert on public.campaign_deliverable
  for each row execute function public.campaign_deliverable_created_emit_event();
revoke all on function public.campaign_deliverable_created_emit_event() from public, anon, authenticated;
```

- [ ] **Step 4: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `campaigns_test.sql .. ok` (all 26 assertions pass — the six trigger-event assertions now green; assumes Task `000008`–`000009` merged (precondition), per Step 0); every other test file still `ok`; definer-audit prints `all definers pinned` (exit 0); `supabase db diff` prints nothing.

- [ ] **Step 5: Gate — both triggers are hardened definers with ids-only payloads**

Run:
```bash
grep -cE 'create trigger (campaign_created_emit_event_tg|campaign_deliverable_created_emit_event_tg)' \
  supabase/migrations/20260701000017_campaigns.sql
grep -c 'recipient_user_id' supabase/migrations/20260701000017_campaigns.sql
node scripts/check-definer-audit.mjs
```
Expected: first grep prints `2` (both triggers created); second prints `0` (neither event payload carries `recipient_user_id` — they are audit-only); definer-audit exits `0` with `all definers pinned`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000017_campaigns.sql supabase/tests/campaigns_test.sql
git commit -m "feat(db): audit-only campaign.created + deliverable.created lifecycle triggers"
```

---

### Task 3: Edit-gating RLS overrides + pgTAP matrix

**Files:**
- Edit: `supabase/migrations/20260701000017_campaigns.sql` (append part 2)
- Edit: `supabase/tests/campaigns_test.sql` (add the RLS matrix)

**Interfaces:**
- Consumes: the generated blanket `campaign_rw`/`marketing_plan_rw` policies (from `000002`), `public.is_workspace_member(uuid)`, `public.marketing_plan`.
- Produces: per-verb RLS policies on `public.campaign` (`campaign_select`/`campaign_insert`/`campaign_update`/`campaign_delete`) and `public.marketing_plan` (`marketing_plan_select`/`insert`/`update`/`delete`). **Invariants:** (1) ONLY `campaign` and `marketing_plan` have their blanket `<name>_rw` policy dropped; the other five collections KEEP the generated blanket policy. (2) All members SELECT/INSERT both tables. (3) `campaign` UPDATE/DELETE is allowed only to the campaign owner OR the owner of its `marketing_plan`; a member who is neither cannot UPDATE/DELETE. (4) `marketing_plan` UPDATE/DELETE is allowed only to its own `owner_id`.

- [ ] **Step 1: Extend the pgTAP (red)**

In `supabase/tests/campaigns_test.sql`: change `select plan(26);` to `select plan(41);`, and insert this block immediately BEFORE the final `select * from finish();`:
```sql
-- ── Task 3: RLS matrix (role=authenticated) ─────────────────────────────────
set local role authenticated;

-- non-member B sees zero rows in every campaign table (SELECT is is_workspace_member
-- under both the blanket and the overridden policies — a contract pin).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.marketing_plan),         0, 'non-member sees zero marketing_plan');
select is((select count(*)::int from public.campaign),               0, 'non-member sees zero campaign');
select is((select count(*)::int from public.campaign_channel),       0, 'non-member sees zero campaign_channel');
select is((select count(*)::int from public.campaign_deliverable),   0, 'non-member sees zero campaign_deliverable');
select is((select count(*)::int from public.campaign_calendar_event),0, 'non-member sees zero campaign_calendar_event');
select is((select count(*)::int from public.campaign_metric),        0, 'non-member sees zero campaign_metric');
select is((select count(*)::int from public.campaign_segment),       0, 'non-member sees zero campaign_segment');

-- positive membership read: plain member C (a member of W1, owner of NEITHER CAMP1 nor MP1)
-- CAN SELECT campaign and marketing_plan rows — membership grants read (the SELECT policy is
-- is_workspace_member, unaffected by the owner-restricted UPDATE/DELETE overrides).
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          1, 'a plain member (non-owner) CAN SELECT a campaign');
select is((select count(*)::int from public.marketing_plan where id='a0000000-0000-0000-0000-000000000001'),
          1, 'a plain member (non-owner) CAN SELECT a marketing_plan');

-- edit-gating (RED before the override): member C is a workspace member but is NEITHER
-- CAMP1's owner (A) nor MP1's owner (A). Under the owner-restricted UPDATE policy the row
-- fails the USING clause, so C's UPDATE matches zero rows (silent no-op) — name unchanged.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.campaign set name='HIJACKED' where id='c0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          'CAMP1', 'a non-owner member cannot UPDATE a campaign (owner-restricted RLS is a no-op)');

-- positive: the campaign owner (A) CAN update CAMP1.
update public.campaign set name='CAMP1-EDITED' where id='c0000000-0000-0000-0000-000000000001';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          'CAMP1-EDITED', 'the campaign owner can UPDATE their campaign');

-- plan-owner branch: A owns MP1 but NOT CAMP2 (owned by C); A can still UPDATE CAMP2
-- because it belongs to A's marketing_plan (the OR arm of the policy).
update public.campaign set name='CAMP2-BY-PLAN-OWNER' where id='c0000000-0000-0000-0000-000000000002';
select is((select name from public.campaign where id='c0000000-0000-0000-0000-000000000002'),
          'CAMP2-BY-PLAN-OWNER', 'the marketing_plan owner can UPDATE a campaign under their plan');

-- marketing_plan is owner-gated too (RED before the override): member C (not MP1's owner)
-- cannot UPDATE MP1.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.marketing_plan set name='MP-HIJACK' where id='a0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select name from public.marketing_plan where id='a0000000-0000-0000-0000-000000000001'),
          'MP1', 'a non-owner member cannot UPDATE a marketing_plan (owner-restricted RLS is a no-op)');

-- DELETE edit-gating (RED before the override): member C (neither CAMP1's owner nor MP1's
-- owner) DELETE on CAMP1 is filtered out by the owner-restricted DELETE USING clause — a
-- silent no-op, so the row is still present afterward. (CAMP1 was renamed CAMP1-EDITED above.)
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
delete from public.campaign where id='c0000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          1, 'a non-owner member cannot DELETE a campaign (owner-restricted RLS is a no-op)');

-- positive: the campaign owner (A) CAN DELETE their campaign (cascades to its channel/deliverable).
delete from public.campaign where id='c0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.campaign where id='c0000000-0000-0000-0000-000000000001'),
          0, 'the campaign owner can DELETE their campaign');
```

Run: `supabase test db`
Expected: FAIL — under the still-active generated blanket `campaign_rw`/`marketing_plan_rw` policies (every verb gated only on `is_workspace_member`), member C's UPDATE and DELETE SUCCEED: the campaign UPDATE read-back returns `HIJACKED` (assertion expects `CAMP1`), the marketing_plan UPDATE read-back returns `MP-HIJACK` (assertion expects `MP1`), and C's DELETE removes CAMP1 so the non-owner-DELETE-no-op assertion returns `0` (expects `1`). The seven non-member-count assertions, the two member-positive SELECTs, and the two owner/plan-owner UPDATE positives already pass. The earlier 26 hold.

- [ ] **Step 2: Append the RLS overrides (green)**

Append to `supabase/migrations/20260701000017_campaigns.sql`:
```sql
-- ── edit-gating RLS overrides (owner-restricted writes) ──────────────────────
-- The five other campaign tables KEEP their generated blanket <name>_rw
-- (is_workspace_member) policy — only campaign and marketing_plan are owner-gated.
-- All members SELECT/INSERT; UPDATE/DELETE restricted to the row's owner. Uses the
-- network-verified principal via (select auth.uid()); is_workspace_member is the base gate.
-- Policy predicates qualify columns with the table name to avoid ambiguity with the
-- correlated marketing_plan subquery.

drop policy if exists campaign_rw on public.campaign;
create policy campaign_select on public.campaign for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy campaign_insert on public.campaign for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy campaign_update on public.campaign for update to authenticated
  using (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  )
  with check (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  );
create policy campaign_delete on public.campaign for delete to authenticated
  using (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  );

drop policy if exists marketing_plan_rw on public.marketing_plan;
create policy marketing_plan_select on public.marketing_plan for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy marketing_plan_insert on public.marketing_plan for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy marketing_plan_update on public.marketing_plan for update to authenticated
  using (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  )
  with check (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  );
create policy marketing_plan_delete on public.marketing_plan for delete to authenticated
  using (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  );
```

- [ ] **Step 3: Apply + test + definer audit + drift**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `campaigns_test.sql .. ok` (all 41 assertions pass — C's UPDATE and DELETE now no-op, so the read-backs return `CAMP1`/`MP1` and CAMP1 survives C's DELETE, while owner A's DELETE succeeds; assumes Task `000008`–`000009` merged (precondition), per Task 2 Step 0); every other test file still `ok`; definer-audit prints `all definers pinned` (exit 0); `supabase db diff` prints nothing.

- [ ] **Step 4: Gate — exactly campaign + marketing_plan blanket policies dropped; the other five keep theirs**

Run:
```bash
grep -cE '^drop policy if exists (campaign|marketing_plan)_rw ' \
  supabase/migrations/20260701000017_campaigns.sql
grep -cE '^drop policy if exists (campaign_channel|campaign_deliverable|campaign_calendar_event|campaign_metric|campaign_segment)_rw ' \
  supabase/migrations/20260701000017_campaigns.sql
```
Expected: first grep prints `2` (only `campaign_rw` and `marketing_plan_rw` are replaced with per-verb owner-gated policies); second prints `0` (the other five collections keep their generated blanket `is_workspace_member` policy). The trailing space in each pattern pins the bare `<name>_rw ` token so `campaign_channel_rw` etc. never match the `campaign_rw ` pattern.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260701000017_campaigns.sql supabase/tests/campaigns_test.sql
git commit -m "feat(db): owner-restricted edit-gating RLS on campaign + marketing_plan"
```

---

## Self-Review

- **Spec coverage (Part A scope):** Seven Campaigns collections defined config-first (NOT `internal`) — `marketing_plan`, `campaign`, `campaign_channel`, the column-thin `campaign_deliverable`, `campaign_calendar_event`, the fact table `campaign_metric`, and the inert forward-seam `campaign_segment` — wired into `defineSchema`/`index.ts` in FK-safe order, regenerated + committed (Task 1); the two audit-only lifecycle triggers (`campaign.created`, `deliverable.created`) mirroring `note_created_emit_event` (Task 2); the owner-restricted edit-gating RLS overrides on `campaign` and `marketing_plan` (Task 3). Each task ends with a machine-checkable gate (`pnpm codegen`+`git diff --exit-code`, `supabase db reset`/`test db`/`db diff`, `check-definer-audit.mjs`, greps).
- **Contract fidelity (Parts B/C depend on these):**
  - **Collection field lists** are exactly as specified in the shared contract; `campaign_deliverable` is deliberately column-thin (campaign, channel, name, deliverable_type — nothing else).
  - **FK column names:** `campaign.marketing_plan`→`marketing_plan_id` (optional, set null); every child `campaign`→`campaign_id` (required, cascade); `campaign_deliverable.channel`/`campaign_metric.channel`→`channel_id` (optional, set null); `campaign_metric.deliverable`→`deliverable_id` (optional, set null). Pinned by `has_column` + a `pg_constraint` resolution assertion + a `23503` dangling-FK behavioral throw.
  - **Two event payloads:** `campaign.created` = `{id, entity_type:'campaign', entity_id, status, marketing_plan_id}`; `deliverable.created` = `{id, entity_type:'campaign_deliverable', entity_id, deliverable_type, campaign_id}` — ids/classifiers only, audit-only, no `notify` job. `entity_type`/`entity_id` are the cross-part contract (Part C's e2e + the inbox key on `entity_id`) — pinned by count + classifier reads + two `entity_id`-equals-row-id reads + `no notify job` counts + a `grep -c recipient_user_id` = 0 gate.
  - **Reporting roles:** `campaign_metric.value`→`measure`; every date/enum/`metric_key`/`unit` dimension→`dimension` (pinned by two `movp_fields.reporting_role` reads).
- **Correctness / self-consistency:** collection order (`marketingPlan` before `campaign`; `campaign`/`campaignChannel` before `campaignDeliverable`/`campaignMetric`) satisfies every codegen-inlined FK; appending at the end of `defineSchema([...])` is safe because Campaigns reference only each other. The generated `<Name>Row` shapes follow the `dataFields`-then-`fkFields` ordering and `required || default` nullability (only the FK names/nullability and `campaign_metric.value` are load-bearing; scalar TS types defer to the committed file). `plan(N)` goes 26 (Task 2) → 41 as the Task 3 block is inserted before the single `select * from finish();`. Every red step is genuinely red under the prior state (no triggers → 0 events, so the count/classifier/`entity_id` reads are NULL in Task 2; blanket `campaign_rw`/`marketing_plan_rw` → C's UPDATE succeeds and C's DELETE removes CAMP1 in Task 3).
- **Safety:** the base gate is `is_workspace_member` (non-member sees 0 rows in all seven tables — pinned, and REAL: all seven tables carry an owner-seeded row before the role switch, so the 0-count reflects the RLS filter, not an empty table). A plain member (non-owner) CAN SELECT `campaign`/`marketing_plan` (positive membership read, pinned). `campaign`/`marketing_plan` UPDATE/DELETE are owner-restricted at the RLS boundary using the network-verified `(select auth.uid())`, so a member who is neither the campaign owner nor its plan owner cannot UPDATE or DELETE it (pinned by a read-back-unchanged / row-still-present, which is the accurate RLS USING-filter no-op — not a `42501`, because a USING-filtered UPDATE/DELETE silently affects zero rows); owner A's UPDATE and DELETE succeed. The plan-owner OR branch is exercised by CAMP2. The two triggers are hardened `SECURITY DEFINER` (`search_path=''`, schema-qualified, `execute` revoked) — `check-definer-audit.mjs` runs in Tasks 2 and 3. The audit-only payloads carry no PII (`grep recipient_user_id` = 0), and `emit_event` is consumed, never re-declared.
- **Reliability / drift:** every implementation task ends with `supabase db reset` + `supabase db diff` empty; codegen reproducibility pinned by `git diff --exit-code`. `create or replace function`, `drop trigger if exists`, and `drop policy if exists` keep `000017` re-runnable on a fresh reset. The full `supabase test db` (all test files) is the regression net.
- **Observability:** the two audit events ARE the Part A observability surface — every campaign/deliverable creation records a structured, ids-only event in `movp_internal.movp_events` with a `trace_id`, diagnosable from logs without leaking content. The remaining lifecycle events (status transitions, metric ingest) are Part B — stated N/A here, not skipped.
- **Efficiency / Performance:** no new hot-path work in Part A; the generic surface, FTS and reporting metadata are codegen artifacts. Per-workspace indexes/rollups for the fact table are Part B. `is_workspace_member` is the existing `stable` gate; the owner-gate `exists` subquery on `marketing_plan` is a single indexed PK lookup per row.
- **Simplicity / Usability:** no speculative columns beyond the contract; `campaign_segment` is NOT speculative generality — it is a deliberate writable Phase-6 seam that stores targeting INTENT now (a user can record primary/lookalike/exclusion targeting immediately), while segment RESOLUTION (the campaign→segment edge, zero rows until Phase 6's `segment` collection lands) is the only deferred part, per the roadmap's forward-compatible-seam design. It carries no resolution logic in Part A but is a full CRUD table. No user-facing UI in Part A (Part C) — stated N/A.
- **Dependency assumption (stated):** this plan assumes Task/CMS migrations (`000008`–`000016`) are merged before `000017`, so the guarded `emit_event` (`000009`) is present. If the "no notify job" assertions fail, that dependency is unmet (a merge-order problem), not a Campaigns defect — Task 2 Step 0's hard guard (grep `20260701000009_*.sql` for `recipient_user_id|email`, STOP if absent), the trigger-site comment, and the Global Constraint all call this out.
- **Deferred to Parts B/C (intentional):** the Task-reuse `implemented_by` edge, the remaining lifecycle events, metric rollups/reporting queries, calendar/segment activation, notifiers, and all surfaces/frontend — none are needed for the data/FK/trigger/edit-gating deliverable and none are touched here.
- **Placeholder scan:** none — every SQL/TS block is complete and copy-paste-ready; every step has an exact command + expected output. The only intentionally-illustrative content is the regenerated `types.ts` scalar mapping (labeled "codegen output — verify, do NOT hand-edit"; the committed file is authoritative and the greps + `git diff --exit-code` pin it).
