# Phase 5 — Marketing Planning & Campaigns Roadmap Plan

Plan `movp-app-03-marketing-planning-campaigns`; build order Phase 5; depends on Core, Task, CMS (reuses Collaboration; forward-compatible with Segmentation, Phase 6).

## Goal

Model the **marketing-orchestration layer** on top of the MOVP Core substrate: annual/period
**marketing plans** that group **campaigns**, campaigns that own **deliverables**, and the
**channels / calendar / metrics** that surround them. This is the "campaign planning and
management" use case from the original CMS brief.

The design discipline for this phase is **reuse, not reinvention**:

- **Scheduling, assignment, status, description, and discussion of a deliverable ARE a MOVP
  Task.** A `campaign_deliverable` is a thin marketing wrapper that **links to a `task`** — it
  never re-implements dates, priority, status, or comments. Task already emits
  `task.assigned` / `task.completed` / `task.due_soon`; Phase 5 bridges those to
  deliverable events.
- **Content produced by a deliverable IS a MOVP CMS `content_item` / `content_revision`.**
  Deliverables link to content via edges; they do not store body/revision state.
- **Stakeholder threads reuse Collaboration.** Owner/observer discussion on a campaign or
  deliverable is the same polymorphic `comment` primitive (`entity_type='campaign'`, etc.).

This is also where **reporting/ML pays off**: `campaign.goal_metrics` (targets) plus
`campaign_metric` (measured actuals, `reporting.role='measure'`) plus dimensions (channel,
status, priority, segment, date) give BI a **star-schema-friendly** fact/dimension model with
zero extra plumbing — the metadata registry already exposes each field's dimension/measure role.

## Collections

All collections are config-first `defineCollection` entries in `@movp/core-schema` with
`workspaceScoped: true`; codegen produces the table, workspace-member RLS, FTS, GraphQL/MCP/CLI,
and TS types. Field constructors are the Core DSL (`f.text/richText/number/enum/datetime/date/
relation`). Reporting roles are stated per field so the metadata registry drives BI/ML.

### `marketing_plan`
Annual/period container grouping campaigns; the strategic layer.
- `name` (`text`, required, searchable), `description` (`richText`, searchable).
- `period_start` / `period_end` (`date`, `reporting.role='dimension'`) — the planning window.
- `goals` (`jsonb`) — free-form strategic goals (target statements, north-star metrics).
- `owner_id` (`f.uuid`; workspace member, validated in RLS — not `relation('user')`) — accountable owner.
- `status` (`enum ['draft','active','archived']`, default `'draft'`, dimension).

### `campaign`
The unit of marketing execution. Reuses **Task's owner/observer assignment pattern**.
- `marketing_plan_id` (`relation('marketing_plan')`, cardinality `many-to-one` → FK; nullable so
  a campaign can exist outside a plan).
- `name` (`text`, required, searchable), `brief` (`richText`, searchable, embeddable).
- `start_date` / `end_date` (`date`, dimension) — the campaign window that drives
  `campaign.started` / `campaign.ended`.
- `owner_id` (`f.uuid`, member-validated in RLS) — accountable owner; **observers** attach via the shared
  assignment/observer edges (`rel='observer'`), exactly as Task models them (no bespoke table).
- `goal_metrics` (`jsonb`) — target definitions `[{ metric_key, target_value, unit }]`; the
  **target** side that `campaign_metric` rows are measured against for variance.
- `priority` (`enum ['low','medium','high','urgent']`, default `'medium'`, dimension) and
  `rank` (`number`, dimension) — prioritization for ordered list/timeline views.
- `status` (`enum ['draft','scheduled','active','completed','cancelled']`, default `'draft'`,
  dimension) — lifecycle state; transitions emit events.

```ts
// packages/core-schema/src/collections/campaign.ts  (design-altitude excerpt)
export const campaign = defineCollection({
  name: 'campaign', label: 'Campaign', workspaceScoped: true,
  fields: {
    marketingPlan: f.relation('marketing_plan', { cardinality: 'many-to-one' }), // FK
    name:      f.text({ label: 'Name', required: true, searchable: true }),
    brief:     f.richText({ label: 'Brief', searchable: true, embeddable: true }),
    startDate: f.date({ label: 'Start', reporting: { role: 'dimension' } }),
    endDate:   f.date({ label: 'End',   reporting: { role: 'dimension' } }),
    owner_id:  f.uuid({ label: 'Owner' }),   // workspace member; validated in RLS (never relation('user'))
    goalMetrics: f.json({ label: 'Goal metrics' }),   // targets, not measures
    priority:  f.enum(['low','medium','high','urgent'], { default: 'medium', reporting: { role: 'dimension' } }),
    rank:      f.number({ label: 'Rank', reporting: { role: 'dimension' } }),
    status:    f.enum(['draft','scheduled','active','completed','cancelled'],
                 { default: 'draft', reporting: { role: 'dimension' } }),
  },
})
```

### `campaign_deliverable`
Child of a campaign; the **bridge to MOVP Task**. Deliberately **thin** — it stores marketing
context, NOT schedule/assignment/status (those live on the linked `task`).
- `campaign_id` (`relation('campaign')`, `many-to-one` → FK, required).
- `channel_id` (`relation('campaign_channel')`, `many-to-one` → FK, nullable) — which channel
  this deliverable targets.
- `name` (`text`, required, searchable), `deliverable_type` (`enum`, e.g.
  `['asset','post','email','landing_page','ad','event']`, dimension).
- **No** `start`/`due`/`priority`/`status`/`description`/`assignee` columns — see the invariant
  below. Those are read through the `deliverable↔task` edge.
- Links (edges, not columns): `deliverable↔task` (`rel='implemented_by'`, one backing task),
  `deliverable↔content_item` / `deliverable↔content_revision` (`rel='produces'`).

> **Invariant (no duplication):** a `campaign_deliverable` carries **no** scheduling, assignment,
> status, or description field. Its schedule = the linked task's `start_date`/`due_date`; its
> assignee/observers = the task's; its status = the task's; its discussion = the task's comments.
> A schema gate asserts the deliverable table has none of those columns (see Verification).

### `campaign_channel`
A channel used within a campaign (email / social / web / paid / event / …). A **shared
dimension** referenced by deliverables and metrics.
- `campaign_id` (`relation('campaign')`, `many-to-one` → FK, required).
- `channel_type` (`enum ['email','social','web','paid','event','sms','other']`, dimension).
- `name` (`text`) — human label (e.g. "LinkedIn — organic").

### `campaign_segment`
Audience-targeting link between a campaign and an audience **`segment`** (Phase 6). Carries
targeting attributes (rich enough to justify a collection over a bare edge), and writes a
`campaign↔segment` edge for cross-domain traversal.
- `campaign_id` (`relation('campaign')`, `many-to-one` → FK, required).
- `targeting_role` (`enum ['primary','lookalike','exclusion']`, default `'primary'`, dimension).
- `weight` (`number`, nullable) — optional targeting weight.
- Edge: `campaign↔segment` (`rel='targets'`, `dst_type='segment'`).

> **Forward-compatibility (Segmentation, Phase 6):** the `segment` collection does not exist
> when Phase 5 is built. Because `edges` are polymorphic `(dst_type, dst_id)`, the
> `campaign↔segment` edge is **writable and RLS-safe now** but resolves to no rows until Phase 6
> lands the `segment` table. Phase 5 stores **targeting intent**; audience **resolution/traversal
> activates in Phase 6** — no resolution logic is built here (YAGNI).

### `campaign_calendar_event`
Dated timeline/milestone entries feeding the marketing calendar and Gantt.
- `campaign_id` (`relation('campaign')`, `many-to-one` → FK, required).
- `title` (`text`, required, searchable), `event_date` (`date`, dimension, required),
  `event_type` (`enum ['milestone','launch','review','deadline']`, dimension).

### `campaign_metric`
The **fact table**: a measured outcome per campaign / deliverable / channel / date.
`reporting.role='measure'` on the value; every other field is a dimension.
- `campaign_id` (`relation('campaign')`, `many-to-one` → FK, required) — grain root.
- `deliverable_id` (`relation('campaign_deliverable')`, nullable) and
  `channel_id` (`relation('campaign_channel')`, nullable) — finer grain / dimensions.
- `metric_key` (`text`, dimension — e.g. `impressions`, `clicks`, `conversions`, `spend`).
- `value` (`number`, **`reporting.role='measure'`**), `unit` (`text`, dimension).
- `measured_at` (`date`, dimension) — the date dimension for time-series/BI.
- Segment dimension (optional) via a `metric↔segment` edge, aligning with `campaign_segment`.

```ts
// campaign_metric — the measure/fact row (excerpt)
value:     f.number({ label: 'Value', reporting: { role: 'measure' } }),
metricKey: f.text({   label: 'Metric', reporting: { role: 'dimension' } }),
measuredAt:f.date({   label: 'Measured at', reporting: { role: 'dimension' } }),
```

## Relationships

FK for owned one-to-many; the typed **`edges`** graph for every cross-collection / cross-domain
link (traversed via `public.traverse_edges`, RLS-gated by `is_workspace_member`).

**FK (one-to-many, owned):**
- `marketing_plan → campaign` (campaign.`marketing_plan_id`).
- `campaign → campaign_deliverable` / `campaign_channel` / `campaign_calendar_event` /
  `campaign_metric` (each child holds `campaign_id`).
- `campaign_deliverable → campaign_channel` (deliverable.`channel_id`).

**Edges (`graph: true`, cross-collection / cross-domain — the heart of this phase):**
- `deliverable ↔ task` (`rel='implemented_by'`) — **the Task reuse seam.** One deliverable is
  backed by one MOVP Task; scheduling/assignment/status/discussion are read through this edge.
- `deliverable ↔ content_item` and `deliverable ↔ content_revision` (`rel='produces'`) — **the
  CMS reuse seam.** A deliverable's output is a versioned CMS content revision.
- `campaign ↔ segment` (`rel='targets'`, `dst_type='segment'`) — **audience targeting**, forward
  to Phase 6 (inert until then, see `campaign_segment`).
- `campaign ↔ user` / `deliverable-backing-task ↔ user` (`rel='observer'`) — the shared
  assignment/observer edges reused verbatim from Task (owner is the FK `owner_id`).
- `campaign_metric ↔ segment` (`rel='measured_for'`) — optional segment dimension on a fact row.

Why edges and not join tables: campaign↔content and deliverable↔task are polymorphic,
many-to-many-capable, and cross **package** boundaries; the `edges` graph already carries
`workspace_id` + RLS + `traverse_edges`, so no bespoke join table is warranted (convention #2).

## Lifecycle events

Every transition fires **exactly one** event via `public.emit_event(type, ws, payload, trace)`
(Core), which writes `movp_internal.movp_events` and enqueues idempotent `notify` + `webhook`
jobs. Event **names are used verbatim** from the roadmap registry. Payloads carry **ids and
bounded classifiers only** (no PII; names-not-values) — e.g. `{ id, campaign_id, status,
channel_type }`.

| Event | Emitted by | Mechanism |
|---|---|---|
| `campaign.created` | `campaign` | DB `AFTER INSERT` trigger → `emit_event`. |
| `campaign.started` | `campaign` | `pg_cron` daily date scan: `start_date <= today AND status='scheduled'` → set `status='active'`, emit once. |
| `campaign.ended`   | `campaign` | `pg_cron` daily date scan: `end_date < today AND status='active'` → set `status='completed'`, emit once. |
| `deliverable.created`   | `campaign_deliverable` | DB `AFTER INSERT` trigger → `emit_event`. |
| `deliverable.assigned`  | bridge | Flows rule maps Task's `task.assigned` → `deliverable.assigned` when the task backs a deliverable (via the `implemented_by` edge). |
| `deliverable.completed` | bridge | Flows rule maps Task's `task.completed` → `deliverable.completed` for a backing task. |
| `deliverable.due_soon`  | bridge | `pg_cron` daily scan joins deliverable → `implemented_by` edge → `task.due_date`; emits for open deliverables due within the window. |

**Idempotency of scans (correctness):** each `pg_cron`-driven event only fires on a genuine
**transition** — `campaign.started`/`ended` are guarded by the status predicate they set (a
re-run finds no matching rows), and `deliverable.due_soon`'s `notify` job idempotency key
includes the target date (`deliverable:<id>:due:<yyyy-mm-dd>`), so re-scanning the same day never
double-notifies. This mirrors Core's `unique(kind, idempotency_key)` on `movp_jobs`.

**Why `assigned`/`completed` are bridged, not triggered:** the deliverable has no status/assignee
column (the no-duplication invariant), so the authoritative signal is the **backing task's** event.
Emitting from a Phase 5 flows subscription over `task.*` keeps a single source of truth.

```sql
-- campaign.created — AFTER INSERT trigger, mirrors Core's on_note_created()
create or replace function movp_internal.on_campaign_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('campaign.created', new.workspace_id,
    jsonb_build_object('id', new.id, 'status', new.status,
                       'marketing_plan_id', new.marketing_plan_id), gen_random_uuid()::text);
  return new;
end; $$;
create trigger campaign_created_after_insert
  after insert on public.campaign for each row
  execute function movp_internal.on_campaign_created();
```

## Workflows / automation

- **Deliverable↔Task bridge (flows subscription).** Subscribes to `task.assigned`,
  `task.completed`, `task.due_soon`; for a task reachable from a deliverable via the
  `implemented_by` edge, re-emits `deliverable.assigned` / `deliverable.completed` /
  `deliverable.due_soon`. This is the mechanism that makes deliverables reuse Task without
  duplicating its state.
- **Date-scan jobs (`pg_cron`, daily).** One scheduled function transitions campaigns
  (`scheduled→active`, `active→completed`) on their dates and enqueues `deliverable.due_soon` —
  registered exactly like Core's `movp-embed-worker` / `movp-flows-worker` (`net.http_post` to an
  edge worker; service-role key from Vault, never in git). Local CI invokes the worker directly.
- **Deliverable↔Content readiness (reuse CMS).** Optionally subscribes to CMS `content.published`;
  when a deliverable's linked `content_item` is published, notifies the campaign owner/observers
  that the deliverable's asset is live. No new content state is modeled here.
- **Notification recipient resolution** (via `@movp/notifications`, Resend default): campaign
  events → owner + observers (+ plan owner); deliverable events → the **backing task's**
  assignee/observers. Recipients are resolved from assignment/observer edges, never hardcoded.
- **Prioritization** is data, not automation: `campaign.rank` / `campaign.priority` order the
  list and timeline views; no scheduled job required.

## RLS & tenancy

- Every collection is `workspaceScoped` → codegen emits `is_workspace_member(workspace_id)` RLS
  for read and write. This is the **authoritative** boundary (Core invariant): a non-member sees
  **zero** campaigns, deliverables, channels, calendar events, or metrics.
- **Owner/observer do not narrow row visibility** (all workspace members can see the workspace's
  campaigns — consistent with Core's member-read model). They drive **notification recipient
  resolution** and optional **edit-gating** (a policy that restricts `UPDATE`/`DELETE` to
  `owner_id` or the plan owner), enforced in RLS on the verified principal — never in the UI.
- **Cross-domain edges** (`deliverable↔task`, `deliverable↔content`, `campaign↔segment`) live in
  `public.edges`, carry `workspace_id`, and are RLS-gated by `is_workspace_member`; traversal
  cannot cross a tenant boundary. The `campaign↔segment` edge is inert (resolves to nothing)
  until Phase 6 without erroring.
- **`campaign_metric` ingestion:** measured actuals are typically written by an out-of-band
  ingestion path (analytics import). Writes go through the domain core with a workspace-scoped
  principal (or the service-role system path for bulk import, like Core's job workers) — never an
  anonymous request. Member-read RLS still applies to reads.

## Surfaces & frontend

Config-first means the **DB table, workspace-member RLS, FTS, GraphQL/MCP/CLI, and TS types are
codegen'd** for all seven collections — no hand-written surface code.

Frontend templates (Astro on CF Workers + R2, consuming the generated GraphQL):

- **Campaign list** — sortable by `rank`/`priority`/`status`/dates; the prioritization view.
- **Campaign detail** — brief, goal_metrics vs. measured `campaign_metric` (target-vs-actual),
  stakeholders (owner + observer edges), deliverables, channels, and the Collaboration thread.
- **Campaign timeline / Gantt** — deliverables plotted by their **backing task's**
  `start_date`/`due_date` (read via the `implemented_by` edge) + `campaign_calendar_event`
  milestones.
- **Marketing calendar** — `campaign_calendar_event` + deliverable due dates across all campaigns
  in the period.
- **Deliverable board** — **reuses the MOVP Task board** filtered to a campaign's backing tasks
  (since a deliverable IS a task, the board is Task's board, not a re-implementation).

**Reporting / ML readiness (where this phase pays off).** `campaign_metric` is a clean
**fact table** (`value` = measure) surrounded by conformed **dimensions**: channel (`channel_type`),
status, priority, segment, and `measured_at` (date). Paired with `campaign.goal_metrics` (targets)
this yields target-vs-actual variance out of the box. Because each field's `reporting.role`
(dimension/measure) already lands in the Core metadata registry (`movp_collections`/`movp_fields`),
a BI tool can auto-derive a star schema, and Segmentation/ML (Phase 6) can consume both the
`movp_events` spine (`campaign.*` / `deliverable.*`) and the metric facts without extra plumbing.

## Dependencies

- **Core (Phase 1):** `defineCollection`/codegen, `edges` + `traverse_edges`, `emit_event` +
  `movp_events` + `movp_jobs`, `@movp/notifications`, `is_workspace_member` RLS, `pg_cron` workers,
  the Astro frontend template, and the metadata registry.
- **Task (build Phase 3):** the `task` collection, the owner/observer assignment pattern
  (reused for campaigns), Task's `task.assigned`/`task.completed`/`task.due_soon` events (bridged),
  and the Task board (reused for the deliverable board).
- **CMS (build Phase 4):** `content_item` / `content_revision` (deliverables link to them) and
  `content.published` (optional readiness automation).
- **Collaboration (Phase 2):** the polymorphic `comment`/`mention` primitives, reused for campaign
  and deliverable stakeholder discussion (no new comment model).
- **Forward — Segmentation (Phase 6):** the `segment` collection. `campaign_segment` and the
  `campaign↔segment` edge are **forward-compatible seams**, dormant until Phase 6 (no reverse
  dependency: Phase 5 builds and passes without Phase 6).

## Verification sketch

1. **Plan → campaign FK + event:** create a `marketing_plan`, then a `campaign` under it → one
   `campaign.created` row in `movp_events` + a `notify` job; the campaign's `marketing_plan_id`
   FK resolves.
2. **Deliverable ↔ Task reuse:** create a `campaign_deliverable`, link it to a `task`
   (`implemented_by` edge). Assign the task → the bridge emits `deliverable.assigned`; complete
   the task → `deliverable.completed`. Assert the deliverable table has **no** status/date/assignee
   columns (no-duplication schema gate).
3. **Date-scan transitions (idempotent):** set a campaign `start_date=today`, `status='scheduled'`;
   run the scan → `status='active'` + one `campaign.started`. Re-run the scan → **no** new event.
   Set `end_date` in the past on an active campaign → `campaign.ended` once.
4. **`deliverable.due_soon`:** a backing task due within the window → scan emits `deliverable.due_soon`;
   re-run same day → no duplicate `notify` (idempotency key includes the date).
5. **CMS link:** link a deliverable to a `content_item`; publish it in CMS → `content.published`
   bridges to a notify to the campaign owner (readiness automation).
6. **Segment forward seam:** write a `campaign_segment` + `campaign↔segment` edge; `traverse_edges`
   returns no resolvable segment (Phase 6 absent) **without error** — proves the seam is dormant,
   not broken.
7. **RLS:** a non-member JWT returns **0** rows on `campaign`, `campaign_deliverable`,
   `campaign_channel`, `campaign_calendar_event`, and `campaign_metric`; edit-gating denies a
   non-owner `UPDATE`.
8. **Reporting star schema:** insert `campaign_metric` rows across two channels/statuses; a
   `sum(value)` grouped by `channel_type` + `status` returns the fact rollup; the metadata registry
   reports `value` as `measure` and channel/status/priority/date as `dimension`.
9. **Notifications:** campaign/deliverable events resolve recipients from owner + observer edges
   (not hardcoded) and enqueue Resend `notify` jobs; each failure path emits one redacted,
   `trace_id`-correlated observability event (Core contract).

## When built

This roadmap plan expands into a **bite-sized TDD implementation series** (as Phase 1 was): the
seven `defineCollection` definitions + codegen, the `campaign.created` / `deliverable.created`
AFTER triggers, the deliverable↔task/content edges, the deliverable↔Task event bridge, the
`pg_cron` date-scan worker (started/ended/due_soon), notification wiring, and the five frontend
templates (with the deliverable board reusing Task's). Build order is **Phase 5** — after Task
(Phase 3) and CMS (Phase 4) so the reuse seams exist, and **before** Segmentation (Phase 6), whose
`segment` collection lights up the dormant `campaign↔segment` targeting seam.
