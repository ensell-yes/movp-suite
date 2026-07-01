# Phase 7 — Domain Workflows & Webhooks Roadmap Plan

Plan `2026-06-30-movp-app-06-domain-workflows-webhooks.md` ; build order **Phase 7 (last)** ; depends on **ALL prior phases** (Core + app phases 2–6).

## Goal

Turn the events every prior domain already emits into a **first-class, config-driven
orchestration layer**: a typed catalog of all domain events, transition guards that make
emission trustworthy, a "WHEN event → THEN action" automation engine, a per-workspace
webhook-subscription management surface, and a queryable audit trail of what fired and how
it resolved. This is the "flows/webhooks" pillar from the suite brief made **domain-complete**.

Phase 7 **reuses Core (Plan 5) verbatim** — `public.emit_event`, `movp_internal.movp_events`,
`movp_internal.webhooks`, `movp_internal.movp_jobs` (retry/backoff/DLQ + crash-safe lease),
the queue RPCs, `register_webhook`, HMAC-signed delivery (`x-movp-signature`), and
`replay_jobs`. It **adds** four config-first collections, transition guards, one new job
kind (`automate`), and one additive `emit_event` line. **No new queue or delivery infra is
built here.**

## Collections

All config-first `defineCollection`s in `@movp/core-schema`; codegen produces tables, RLS,
GraphQL/MCP/CLI, and TS types. Three are `workspaceScoped: true`; `event_type` is a global
reference catalog (see RLS & tenancy).

| Collection | Scope | Key fields (cardinality · reporting/search) |
|---|---|---|
| `event_type` | **global** ref | `key` (verbatim registry name, unique · dimension), `domain` (enum: collaboration/task/cms/campaign/segmentation-lifecycle · dimension), `label`, `payload_schema` (jsonb JSON-Schema), `schema_version` (int), `active` (bool), `description` (searchable) |
| `automation_rule` | workspace | `name` (searchable), `trigger_event_type` (relation→`event_type` · dimension), `condition` (jsonb predicate DSL), `action_type` (enum: notify/deliver_webhook/create_task/advance_deliverable/recompute_segment/emit_event · dimension), `action_config` (jsonb), `enabled` (bool · dimension), `priority` (int, tie-break order) |
| `webhook_subscription` | workspace | `event_type` (relation · dimension), `url`, `filter` (jsonb, optional), `active` (bool · dimension), `secret_set` (bool), `secret_last_rotated_at` (ts) — **no secret value column** |
| `workflow_run` | workspace | `source_event_id` (uuid, soft ref to `movp_events`), `event_type` (dimension), `automation_rule` (relation · dimension), `matched` (bool), `action_type` (dimension), `outcome` (enum: succeeded/failed/skipped/enqueued · dimension), `job_id` (uuid, spawned `movp_jobs` row), `error_code`, `trace_id`, `created_at` (measure: time-series) — **unique `(source_event_id, automation_rule_id)`** |

The event catalog is **seeded from config, not hand-written**: each domain declares its
events (a `defineEvent({ key, domain, payloadSchema, version })` alongside its collection),
and codegen emits the `event_type` seed rows + a CI check that **every `emit_event(type,…)`
call-site type exists in the catalog** — so events stay discoverable and the catalog can
never silently drift from what domains actually emit.

## The domain event registry

The catalog enumerates **every** event from the roadmap's consolidated registry, verbatim,
each with a documented, versioned payload schema:

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
- **Segmentation / lifecycle:** `account.created`, `registration.completed`,
  `onboarding.completed`, `segment.membership_changed`, `segment.recomputed`

**Versionability:** a payload-shape change bumps `schema_version` and the catalog keeps the
old schema active until subscribers migrate; webhook subscriptions may pin a version. Each
`movp_events` row already carries `type`; Phase 7 stamps `payload.schema_version` at emit
time so consumers can dispatch on it.

## Transition guards

Guarantee: **a state change emits its event only if the transition is valid, and an invalid
transition neither mutates nor emits.** Guards are declared once, config-first, and live at
two layers (DB authoritative, service advisory):

1. **DB — authoritative.** The status field's allowed transitions are declared in the
   collection (`f.enum([...], { transitions: { in_progress: ['done','blocked'], … } })`).
   Codegen emits **two triggers**:
   - a `BEFORE UPDATE` trigger that **raises** (aborts the write) when
     `OLD.status IS DISTINCT FROM NEW.status` and the pair is not in the allowed set — so an
     invalid transition rolls back the row change *and* never reaches the emit trigger;
   - an `AFTER UPDATE` trigger that calls `emit_event` **exactly once** on the now-guaranteed
     valid transition, keyed to the committed row.

   ```sql
   -- generated AFTER-UPDATE emit predicate (illustrative; one emit per committed transition)
   ... when (old.status is distinct from new.status)   -- BEFORE trigger already rejected invalid pairs
   perform public.emit_event('task.completed', new.workspace_id,
     jsonb_build_object('id', new.id, 'from', old.status, 'to', new.status,
                        'schema_version', 1, 'trace_id', gen_random_uuid()::text), null);
   ```

2. **Service — advisory + authz.** `@movp/domain` checks the transition is permitted *for the
   verified principal* (e.g., only an approver may `content.approved`) before issuing the
   update; the DB guard is the backstop that a direct RPC/SQL path cannot bypass.

Worked examples: `task.completed` fires only from an in-flight status (a re-complete of an
already-`done` task is a no-op — no mutation, no event); `content.published` fires only from
`approved` (per the CMS versioning convention, editing after approval invalidates approval,
so publish requires re-approval first).

**Exactly-once emission** follows from the single AFTER trigger per committed transition (one
`movp_events` row); **idempotent downstream side effects** follow from `movp_jobs`'
`unique(kind, idempotency_key)` and the `workflow_run` action ledger below.

## Automation rules (event → action)

`automation_rule` is a typed, per-workspace config row: **WHEN `trigger_event_type` [IF
`condition`] THEN `action_type`(`action_config`)**, ordered by `priority`.

- `condition` is a **bounded JSON predicate DSL** over the event payload (`{ field, op,
  value }` composed with `and`/`or`) — evaluated, never `eval`'d; an unparseable condition
  disables the rule with a validation error, it does not fail open.
- `action_type` is a closed enum; `action_config` is validated per type at write time.

Cross-domain actions the engine dispatches:

| Action | Effect | Requires |
|---|---|---|
| `notify` | resolve recipients (assignee/observer/role/mentions/subscribers) → enqueue Core `notify` jobs | Collab/Task |
| `deliver_webhook` | target a specific `webhook_subscription` (beyond the default fanout) | — |
| `create_task` | call Task domain service (e.g. a reminder task) | Phase 3 |
| `advance_deliverable` | call Campaign domain service on the linked deliverable | Phase 5 |
| `recompute_segment` | enqueue a segment refresh | Phase 6 |
| `emit_event` | chained emission (**loop-guarded**, see below) | — |

Canonical cross-domain rules (seeded as workspace defaults, editable):
`deliverable.due_soon` → notify owner **+** create reminder task; `content.approved` →
advance the linked campaign deliverable; `segment.membership_changed` → enqueue a campaign
audience refresh.

**Engine wiring (one additive change to Core).** `emit_event` gains a single enqueue of one
`automate` job per event (idempotency key = event id); everything else in `emit_event`
(events insert, `notify`/`webhook` fanout) is untouched:

```sql
-- ADDITIVE (create or replace) — the only edit to Core's emit_event
insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values ('automate', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
          payload || jsonb_build_object('event', ev_type), ws)
  on conflict (kind, idempotency_key) do nothing;
```

A Phase-7 migration registers the `'automate'` job kind with one row —
`insert into movp_internal.movp_job_kind (kind) values ('automate')` (no constraint change;
Core's `movp_jobs.kind` is an extensible registry). The
**automate branch of the `flows` worker** claims `automate` jobs, loads that workspace's
enabled rules for the event ordered by `priority`, evaluates each `condition`, and for a
match dispatches the action. **Loop guard:** `emit_event`-type actions carry a `depth` in
payload; the worker refuses to dispatch past a small max depth, so a rule cycle cannot fan
out unbounded.

## Webhook subscription management

`webhook_subscription` is the **RLS-guarded management handle** over Core's
`movp_internal.webhooks`; the secret never lives in the public collection.

- **register** → domain service calls SECURITY DEFINER `register_webhook(ws, event_type,
  url, secret)` (Core RPC), writing the paired `movp_internal.webhooks` row; the public
  subscription row records `url`/`event_type`/`filter`/`active`/`secret_set=true`.
- **rotate secret** → a new SECURITY DEFINER `rotate_webhook_secret(subscription_id, ws,
  secret)` updates only the internal `secret`, bumps `secret_last_rotated_at`; the secret is
  **returned once** to the operator and never stored/logged in `public`.
- **activate / deactivate** → `set_webhook_active(subscription_id, ws, active)` toggles
  `active` on both rows; a deactivated subscription is skipped by Core's fanout `WHERE active`.
- **filter** → an optional jsonb payload predicate; carried into the webhook job payload and
  evaluated by the delivery worker pre-`fetch` (a filtered-out job completes `done` and is
  recorded `skipped` in `workflow_run`).

**Pairing invariant (drift risk, pinned):** the public subscription and the internal
`webhooks` row are 1:1; the RPCs are the **only** writers of the internal row, and a
reconciliation test asserts every active subscription has exactly one active internal row and
vice-versa. **Authz on the definer path:** each RPC runs as definer to reach `movp_internal`
but **first checks `public.is_workspace_member(ws)` on the calling `auth.uid()`** — a member
of workspace A can never register or rotate a webhook for workspace B.

## Delivery, retries, DLQ, audit

**All delivery mechanics are Core's, reused unchanged:** durable `movp_jobs`, dedupe via
`unique(kind, idempotency_key)`, exponential backoff (`next_run_at = now() + 2^attempts s`),
DLQ at `attempts ≥ max_attempts → status='dead'`, crash-safe lease + reclaim of expired
`running`, `pg_cron`-driven drain, HMAC `x-movp-signature` over the JSON body, and
`movp jobs replay --dead`. **At-least-once** webhook delivery + **signed** payloads + idempotent
receivers are therefore inherited, not re-solved.

Phase 7 adds the **audit trail** on top:

- `movp_events` — the append-only **spine**: every emitted event (one row per transition).
- `workflow_run` — the **rule-firing ledger**: one row per (event × rule) with `matched`,
  `action_type`, `outcome`, `job_id`, `error_code`, `trace_id`. Its
  `unique(source_event_id, automation_rule_id)` **doubles as the action idempotency key** —
  the worker upserts the run row and performs the action only on first insert, so an
  `automate` job retry (at-least-once) yields **exactly-once rule actions**.
- `movp_jobs` — per-attempt delivery state with a bounded `last_error_code`.

`trace_id` threads from `emit_event`'s payload into every spawned job and every
`workflow_run`, so an operator can correlate a transition → rules fired → deliveries →
outcome. **Content discipline:** `workflow_run`/logs record field *names*, `error_code`s, and
`job_id`s — never payload values, recipient emails, or the webhook secret.

## RLS & tenancy

- `automation_rule`, `webhook_subscription`, `workflow_run` are `workspaceScoped` — codegen
  RLS via `public.is_workspace_member(workspace_id)`; a non-member sees zero rows on every
  surface.
- `workflow_run` is **read-only to members** (audit) and written only by the service-role
  automation worker; `automation_rule`/`webhook_subscription` are writable by members (or a
  workspace-admin role) per policy.
- `event_type` is a **global reference catalog** — a deliberate exception to the
  workspace-scoped default: `SELECT` granted to all `authenticated`, writes only via the
  codegen seed path (service-role). No workspace column.
- **Secrets stay in `movp_internal.webhooks`** (deny-all RLS, service-role only); the public
  `webhook_subscription` carries `secret_set`/`secret_last_rotated_at` but never the value.
- The management RPCs are hardened SECURITY DEFINER (`set search_path = ''`, fully qualified)
  and gate on the **verified principal's** membership before touching internal rows.
- `workflow_run.source_event_id` is a **soft reference** (no cross-schema FK to the internal
  `movp_events`); the audit viewer reads a run's event payload through a workspace-scoped
  SECURITY DEFINER `get_event(id, ws)` RPC rather than joining an internal table.

## Surfaces & frontend

Codegen yields GraphQL/MCP/CLI CRUD for `automation_rule`, `webhook_subscription`, and
`workflow_run` (read) out of the box. Three Astro admin surfaces (CF Workers + R2,
generated GraphQL, Core's six-mode a11y system):

- **Automation-rule builder** — a WHEN/IF/THEN form: pick `event_type`, compose the
  `condition` predicate, choose an `action_type` + typed `action_config`, set `priority`,
  toggle `enabled`. Unavailable actions (a phase not yet built) are disabled with a reason.
- **Webhook-subscription manager** — register / rotate (secret shown **once**) / activate /
  deactivate / set filter, showing `secret_last_rotated_at` and last-delivery status.
- **Workflow-run / audit log viewer** — filter by event type, rule, outcome, and date;
  drill from a run into its event payload (via the scoped RPC) and its delivery attempts
  (`movp_jobs` state + `last_error_code`), with a one-click `replay` for dead jobs.

## Dependencies

- **Core (Plan 5):** `emit_event`, `movp_events`, `webhooks`, `movp_jobs` (+ queue RPCs,
  `register_webhook`, `replay_jobs`), the `flows` worker, HMAC signing, retry/backoff/DLQ,
  crash-safe lease. Phase 7 makes exactly one additive `emit_event` edit and registers the
  `automate` job kind (one `insert into movp_internal.movp_job_kind`).
- **App phases 2–6:** each owns its transition guards and emits its registry events; Phase 7
  catalogs them and layers rules + management + audit on top. Cross-domain actions bind to:
  Task (Phase 3, `create_task`), Campaigns (Phase 5, `advance_deliverable`), Segmentation
  (Phase 6, `recompute_segment`). A rule referencing an action whose phase is absent is
  validation-rejected / disabled, not silently dropped.
- **Convention reuse:** config-first collections, edges for cross-entity links, notifications
  (`@movp/notifications`/Resend), authoritative RLS.

## Verification sketch

1. **Guards:** an invalid transition (`task` `done→done`; `content` `draft→published`) is
   rejected — the row is unchanged **and** no `movp_events` row is written; a valid transition
   writes **exactly one** event.
2. **Exactly-once actions:** one committed transition → one event → one `automate` job; force
   a job retry → the `workflow_run` unique key blocks a second action (no duplicate reminder
   task, no double advance).
3. **Automation:** seed `content.approved → advance_deliverable`; approving content advances
   the linked deliverable and writes a `succeeded` run. `deliverable.due_soon → notify + create
   reminder task` produces both; `segment.membership_changed → recompute_segment` enqueues a
   refresh.
4. **Webhook management:** register → paired internal row exists; rotate → old signature
   fails, new verifies; deactivate → no delivery; a non-matching `filter` records `skipped`.
5. **Delivery/DLQ (Core, reused):** a 5xx target retries on backoff then dead-letters;
   `movp jobs replay --dead` recovers it; `x-movp-signature` verifies against the body.
6. **Authz:** a workspace-A member cannot register/rotate a workspace-B webhook (RPC
   membership gate); a non-member sees zero rules/subscriptions/runs.
7. **Loop guard:** a rule whose action emits an event halts at max depth — no unbounded fanout.
8. **Audit correlation:** every event is in `movp_events`; every rule firing is in
   `workflow_run` with `outcome` + `job_id` + a `trace_id` that threads back to the transition;
   no payload value, email, or secret appears in any run row or log.

## When built

**Phase 7 — last.** It is the registry + guard + automation + management + audit layer over
the events **every** prior phase emits, so it can only be built once Collaboration (2), Task
(3), CMS (4), Campaigns (5), and Segmentation/Lifecycle (6) exist and emit their registry
events on Core's spine. Building it last means the catalog, the cross-domain rules, and the
audit viewer are populated by real domains from day one rather than stubs.
