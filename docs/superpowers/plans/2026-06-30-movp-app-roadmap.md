# MOVP Suite — Application Roadmap (Phases 2–7, on top of Core)

> Integrating roadmap for the **application domains** that sit on the MOVP Core substrate
> (Phase 1). Each domain gets its own roadmap plan (linked below); this document pins the
> phase sequence, cross-domain dependencies, shared conventions, and the consolidated
> domain-event registry so the six plans cohere. These are **roadmap/design plans**, not
> bite-sized TDD — each becomes its own bite-sized implementation plan (like the Phase 1
> series) when we build it.

## Context

MOVP Core (Phase 1) delivers the platform substrate: workspace tenancy + RLS, the
config-first data-model + codegen (→ DB/GraphQL/MCP/CLI/types), FTS + graph + pgvector
search, durable jobs, events, notifications, and webhooks — proven with one example
collection (`note`/`tag`). It does **not** yet model the application domains needed for a
marketing-orchestration platform: task management, CMS content workflows, campaign
planning, audience segmentation, the collaboration/social layer, or domain-specific
workflow automation. This roadmap sequences those as Phases 2–7.

**Key leverage:** because Core is config-first, most application work is **adding
`defineCollection` definitions + domain services + lifecycle triggers + frontend
templates** — the DB tables, RLS, GraphQL/MCP/CLI surfaces, FTS, and TS types are
codegen'd automatically. Each phase is mostly *domain modeling*, not new infrastructure.

## Recommended build order (filenames ≠ build order)

| Order | Phase | Plan file | Depends on |
|---|---|---|---|
| **2** | Collaboration & Social core | `2026-06-30-movp-app-05-collaboration-social-layer.md` | Core |
| **3** | Task Management | `2026-06-30-movp-app-01-task-management.md` | Core, Collaboration |
| **4** | CMS & Content Workflows | `2026-06-30-movp-app-02-cms-content-workflows.md` | Core, Collaboration, Task |
| **5** | Marketing Planning & Campaigns | `2026-06-30-movp-app-03-marketing-planning-campaigns.md` | Core, Task, CMS |
| **6** | Segmentation & Lifecycle Events | `2026-06-30-movp-app-04-segmentation-lifecycle-events.md` | Core, Campaigns |
| **7** | Domain Workflows & Webhooks | `2026-06-30-movp-app-06-domain-workflows-webhooks.md` | ALL of the above |

**Why Collaboration is Phase 2, not 5:** Task comments/mentions/reactions, CMS editorial
discussion, and campaign stakeholder threads are the *same* polymorphic social primitives.
Building them once, entity-agnostic, before Task means every later domain reuses them
instead of reinventing per-entity comments. **Why Domain Workflows is last:** it is the
registry + automation layer over the events every prior phase emits.

## Shared application-layer conventions (every app plan follows these)

1. **Collections are config-first.** Every domain object is a `defineCollection` in
   `@movp/core-schema` with `workspaceScoped: true`. Codegen produces the table, RLS
   (workspace-member), FTS, GraphQL/MCP/CLI, and TS types. Add reporting metadata
   (`reporting: { role: 'dimension' | 'measure' }`) and `searchable`/`embeddable` flags so
   BI/ML and search work out of the box.
2. **Relationships (per the amended Core contract).** A `relation` with cardinality
   `many-to-one`/`one-to-one` → a real FK column `<field>_id` (types: `<field>_id: string`);
   `one-to-many` → the inverse side (no column); `many-to-many` and cross-collection/polymorphic
   links (campaign↔content, deliverable↔task, comment↔any-entity) → the typed **`edges`** graph
   (`graph: true`), traversed via `traverse_edges`. **User references use `f.uuid`** (no FK to
   `auth.users`; membership validated in RLS), never `relation('user')`. Field types include
   `f.json` (→ `jsonb`) and `f.date` (→ `date`); new async job kinds register a row in
   `movp_internal.movp_job_kind` (no `movp_jobs` constraint change). No bespoke join tables
   unless a link carries rich attributes.
3. **Versioning (immutable revisions).** Content/description history uses an append-only
   `*_revision` table + a pointer to the current/approved revision, each revision carrying a
   `content_hash`. Editing after approval invalidates approval. This pattern is defined once
   in CMS and reused (e.g., task description versioning).
4. **Lifecycle events (one spine).** State transitions emit exactly one event via a DB
   `AFTER` trigger (or app-level `emitEvent`) calling Core's `public.emit_event(type, ws,
   payload, trace)` — which writes `movp_internal.movp_events` and enqueues `notify` +
   `webhook` jobs (idempotent, retried, DLQ'd). App phases **register their event types**
   (see registry below) and add per-transition triggers; they do **not** build new queue
   infra.
5. **Notifications** reuse `@movp/notifications` (Resend default). Recipients are resolved
   from assignees/observers/mentions/subscribers, not hardcoded.
6. **Collaboration is polymorphic and shared.** `comment`, `mention`, `reaction`,
   `saved_item`, `share_link` attach to any entity via `(entity_type, entity_id)` + edges;
   the **Inbox** aggregates All Updates / Mentions / Saved / Assigned across all domains.
7. **Authoritative authz at the data boundary** (RLS + verified principal), never the UI —
   per Core invariants. Assignment/observer/mention visibility is enforced in RLS policies,
   not just filtered in resolvers.
8. **Each app collection ships a frontend template** (Astro on CF+R2) consuming the
   generated GraphQL — list/detail plus domain views (task board, editorial calendar,
   campaign timeline).

## Consolidated domain-event registry

Formalized as a typed registry in Phase 7; individual events are emitted by their owning
phase from Phase 2 onward. Each fires exactly once per transition → `emit_event` →
`movp_events` + jobs.

- **Collaboration:** `comment.added`, `comment.replied`, `user.mentioned`, `item.liked`,
  `item.disliked`, `item.saved`, `item.shared`
- **Task:** `task.created`, `task.assigned`, `task.observer_added`, `task.status_changed`,
  `task.completed`, `task.reopened`, `task.due_soon`, `task.dependency_blocked`
- **CMS:** `content.created`, `content.revision_created`, `content.submitted_for_approval`,
  `content.approved`, `content.rejected`, `content.published`, `content.unpublished`,
  `content.scheduled`
- **Campaigns:** `campaign.created`, `campaign.started`, `campaign.ended`,
  `deliverable.created`, `deliverable.assigned`, `deliverable.due_soon`,
  `deliverable.completed`
- **Segmentation / platform lifecycle:** `account.created`, `registration.completed`,
  `onboarding.completed`, `segment.membership_changed`, `segment.recomputed`

## Cross-cutting: reporting & ML readiness

Every collection's field metadata (label, cardinality, dimension/measure) lands in the
metadata registry, and lifecycle events land in `movp_events` — together these give
BI/segmentation/ML a typed, auditable event + entity model without extra plumbing.
Segmentation (Phase 6) consumes the `*.completed`/lifecycle events directly.

## Per-phase plans

Each linked plan states, for its domain: the goal; the config-first collections (with key
fields, cardinality, reporting/search flags); relationships (FK vs edges); versioning where
relevant; the lifecycle events it emits; the workflows/automations; RLS/tenancy specifics;
the auto-generated surfaces + frontend templates; dependencies on Core and prior phases;
and a verification sketch. When we build a phase, that plan is expanded into a bite-sized
TDD implementation series (as Phase 1 was).
