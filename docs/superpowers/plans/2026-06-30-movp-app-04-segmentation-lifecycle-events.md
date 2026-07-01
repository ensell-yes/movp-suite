# Phase 6 — Segmentation & Lifecycle Events Roadmap Plan

Plan `2026-06-30-movp-app-04-segmentation-lifecycle-events`; build order Phase 6; depends on Core, Campaigns.

## Goal

Give MOVP a **lifecycle-driven audience segmentation** layer — the piece the roadmap
review flagged as absent. Product/account lifecycle events (`account.created`,
`registration.completed`, `onboarding.completed`, plus arbitrary product events) are
ingested into a normalized `platform_event` stream; `segment`s define audiences by a
typed predicate over that stream and over entity attributes; membership is **recomputed
idempotently on the shared `movp_jobs` engine** and is **explainable** (every member row
records which rule matched and the evidence that matched it). Segments and snapshots
become the targeting primitive Campaigns consume, and the `platform_event` +
membership + metadata-registry triple makes this phase the suite's **primary BI/ML
consumer**: a typed, auditable event + audience model with no extra plumbing.

Non-goals (v1): predictive/propensity scoring (this phase produces the *features*, not
the model); a real-time streaming engine (recompute is job-driven, near-real-time); a
visual query language beyond the typed predicate DSL.

## Collections

All are `defineCollection` in `@movp/core-schema`, `workspaceScoped: true` (codegen →
table + workspace-member RLS + FTS + GraphQL/MCP/CLI + TS types + metadata-registry
rows). `properties`, `predicate`, and `evidence` need a **jsonb column**; the Core DSL
`FieldType` includes `json` (Core-owned), so these use Core's `f.json` (→ `jsonb` column,
non-searchable/non-embeddable by default).
See Dependencies — it is a small Core change, not a bespoke table.

- **`platform_event`** — the normalized, append-only lifecycle/product event fact table.
  ```ts
  export const platformEvent = defineCollection({
    name: 'platform_event', label: 'Platform Event', labelPlural: 'Platform Events',
    workspaceScoped: true,
    fields: {
      event_type:   f.text({ label: 'Event Type', required: true, searchable: true,
                             reporting: { role: 'dimension' } }),   // e.g. 'registration.completed'
      subject_type: f.text({ label: 'Subject Type', required: true,
                             reporting: { role: 'dimension' } }),   // 'user' | 'account' | external
      subject_ref:  f.text({ label: 'Subject', required: true }),   // the entity the event is ABOUT
      actor_ref:    f.text({ label: 'Actor' }),                     // who caused it (may == subject)
      source:       f.enum(['internal','external'], { label: 'Source', required: true,
                             reporting: { role: 'dimension' } }),
      properties:   f.json({ label: 'Properties' }),                // f.json = additive Core type → jsonb
      occurred_at:  f.datetime({ label: 'Occurred At', required: true,
                             reporting: { role: 'dimension' } }),   // time dimension (BI/ML)
      ingested_at:  f.datetime({ label: 'Ingested At', required: true }),
    },
  })
  ```
  High-volume, immutable (insert-only; never updated). `subject_ref` is a text ref so
  events can be about subjects that don't exist in `auth.users` (external apps' users).
  Indexed on `(workspace_id, subject_ref, event_type, occurred_at)` and
  `(workspace_id, event_type, occurred_at)` for set-based rule evaluation.

- **`segment`** — a named audience definition. Fields: `name` (text, required,
  searchable), `description` (richText, searchable), `owner_ref` (text — owning user),
  `active` (boolean, `reporting: dimension`), `mode` (enum `dynamic`|`static`,
  `reporting: dimension`; `dynamic` recomputes on new events, `static` only on demand).

- **`segment_rule`** — a versioned predicate belonging to a segment. Fields: `segment`
  (relation → `segment`, one-to-many), `predicate` (`f.json` — the typed DSL, below),
  `version` (number), `active` (boolean, `reporting: dimension`), `description` (text).
  Multiple active rules on a segment are OR'd; a member records *which* rule matched.
  Editing a predicate mints a **new** `version` (append-only rule history) so a snapshot
  or membership row can always be traced to the exact predicate that produced it.

- **`segment_membership`** — who is *currently* in a segment, **explainable**. Fields:
  `segment` (relation), `subject_type` (`reporting: dimension`), `subject_ref` (text),
  `matched_rule` (relation → `segment_rule` — the version that put them in),
  `first_matched_at` (datetime), `evaluated_at` (datetime), `evidence` (`f.json` — the
  `platform_event` ids and/or attribute values that satisfied the predicate). Presence of
  a row = current membership; `unique(segment_id, subject_ref)`. This row is the answer to
  "why is this subject in this segment."

- **`segment_snapshot`** — an immutable point-in-time membership capture, for reproducible
  campaign audiences and trend reporting. Fields: `segment` (relation), `taken_at`
  (datetime), `reason` (enum `on_demand`|`scheduled`|`campaign_launch`,
  `reporting: dimension`), `rule_version_set` (`f.json` — the rule versions frozen),
  `member_count` (number, `reporting: measure`). The frozen member list lives in an
  append-only child `segment_snapshot_member(snapshot_id, subject_ref, matched_rule_id,
  evidence)` — never mutated after `taken_at`, so a campaign that targeted a snapshot
  always resolves the same audience.

- **`segment_recompute_job`** — *not a new table and not a new queue.* A recompute unit is
  a row on the shared `movp_internal.movp_jobs` engine with a **new `kind='segment_recompute'`**
  (idempotent via `unique(kind, idempotency_key)`, lease/reclaim, bounded backoff, DLQ —
  all inherited). On completion the worker writes an auditable `segment_recompute_run`
  record (workspaceScoped: `segment`, `mode` dimension, `started_at`/`finished_at`,
  `added_count`/`removed_count`/`evaluated_count` measures, `idempotency_key`,
  `outcome_code`) so BI and operators can see recompute history and drift. The
  `'segment_recompute'` job kind is registered with one row —
  `insert into movp_internal.movp_job_kind (kind) values ('segment_recompute')` — no
  `movp_jobs` constraint change (see Dependencies).

## Relationships

- One-to-many via `relation` FKs: `segment_rule → segment`, `segment_membership → segment`,
  `segment_membership → segment_rule` (matched), `segment_snapshot → segment`,
  `segment_snapshot_member → segment_snapshot`, `segment_recompute_run → segment`.
- **Campaign seam (many-to-many, edges).** A campaign targets an audience via the typed
  `edges` graph (`graph: true`), traversed with `traverse_edges` — no bespoke join table.
  Two edge relations, so a campaign can target either a live or a frozen audience:
  - `campaign --targets_segment--> segment` (dynamic: the audience is whatever the segment
    currently resolves to at send time), and
  - `campaign --targets_snapshot--> segment_snapshot` (reproducible: the frozen member set).
  Campaigns owns the `campaign_segment` linking convention; this phase owns `segment` /
  `segment_snapshot` and guarantees a snapshot is immutable so the frozen link is stable.
- `platform_event` is intentionally **not** FK-linked to `auth.users` (`subject_ref` is a
  free text ref) so external subjects are representable; joins for BI happen through the
  metadata registry's typed dimensions, not a hard FK.

## Lifecycle event ingestion

Two paths land normalized rows in `platform_event`; both are workspace-scoped and both
converge on the same table so evaluation has one source of truth.

**(1) Internal — bridge MOVP's own `movp_events` spine.** MOVP already emits lifecycle
events (`account.created`, `registration.completed`, `onboarding.completed`, and every
domain `*.completed` from prior phases) through `public.emit_event(...)`, which writes
`movp_internal.movp_events`. A hardened `SECURITY DEFINER` `AFTER INSERT` trigger on
`movp_internal.movp_events` bridges a **configured allow-list** of event types into
`platform_event` (source `internal`). No new emit path — segmentation *subscribes* to the
existing spine.

```sql
-- movp_internal: bridge selected movp_events into the segmentation fact table.
-- SECURITY DEFINER + set search_path='' (Core hardening); writes public.platform_event
-- (RLS bypassed as definer — the row is scoped to new.workspace_id, never client input).
create or replace function movp_internal.bridge_event_to_platform()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.type = any (movp_internal.segmentation_bridged_types()) then   -- config allow-list
    insert into public.platform_event
      (workspace_id, event_type, subject_type, subject_ref, actor_ref, source,
       properties, occurred_at, ingested_at)
    values (new.workspace_id, new.type,
            coalesce(new.payload->>'subject_type','user'),
            coalesce(new.payload->>'subject_ref', new.payload->>'id'),
            new.payload->>'actor_ref', 'internal',
            new.payload, new.created_at, now());
  end if;
  return new;
end; $$;
```

**(2) External — a public authenticated ingestion endpoint so *other apps* emit events.**
A Supabase Edge Function `functions/ingest` (Deno) accepts `POST /ingest` with a batch of
events. Two auth modes, both resolving the **workspace server-side** (never trusting a
client-supplied `workspace_id`):
- a **user JWT** (verified in-function via `@movp/auth`, fail-closed) for first-party
  callers — insert runs under RLS (`with check is_workspace_member`); or
- a **workspace-scoped ingestion API key** for service-to-service callers: the raw key is
  hashed and matched against a `movp_internal.ingest_key(workspace_id, key_hash, active)`
  registry; the resolved `workspace_id` — not any request field — scopes the write, via a
  hardened `SECURITY DEFINER public.ingest_platform_event(events jsonb)` RPC
  (`service_role`, validates each event's shape, drops malformed/oversized entries, stamps
  `source='external'`, `ingested_at=now()`). Keys are stored hashed, least-priv, revocable.

Both paths land the same normalized row; an `AFTER INSERT` trigger on `platform_event`
then enqueues incremental recompute (next section). Ingestion is **bounded**: batch size
capped, per-event `properties` size capped, unknown/extra fields dropped (untrusted input)
— an oversized or malformed event is rejected/dropped, not buffered.

## Segment evaluation & recompute

**Predicate model (design-level typed DSL, stored as jsonb).** A rule's `predicate` is a
small typed tree the worker compiles to **one set-based SQL query** over `platform_event`
(+ entity attributes), scoped to the segment's workspace — never a per-subject loop:

```jsonc
// "registered in the last 30d AND has NOT completed onboarding since registering"
{ "all": [
  { "event": "registration.completed", "within": { "days": 30 } },
  { "not": { "event": "onboarding.completed", "after_event": "registration.completed" } }
] }
```

Nodes: `all`/`any`/`not` (boolean), `event` (existence + recency/count/property filters),
`attribute` (predicate over an entity field). The compiler lowers this to a parameterized
`EXISTS`/`NOT EXISTS` query returning the matching `subject_ref` set with the evidence
(matching `platform_event` ids) — so evaluation cost is proportionate to the event
volume, with the workspace index carrying the filter.

**Recompute is enqueued on `movp_jobs` (`kind='segment_recompute'`), never a new queue.**

- **Incremental** (dynamic segments): the `platform_event` `AFTER INSERT` trigger enqueues
  a recompute for each segment whose rules reference that `event_type`. The idempotency key
  is derived over the **effective inputs** — `segment_id` + `rule_version_set` + a coalescing
  window (e.g. `date_trunc('minute', now())`) — so a burst of events collapses to one job,
  and a replay of the same window re-attaches to the same job (no duplicate side effects).
- **Full / scheduled / on-demand**: `pg_cron` (or an operator/API call) enqueues a full
  recompute with key `segment_id + rule_version_set + as_of` — deterministic, so the same
  inputs always mean the same job and the same membership.

```sql
-- enqueue a recompute (reuses the Core queue RPC; 'segment_recompute' registered in movp_internal.movp_job_kind).
-- Idempotency key is a PURE function of the EFFECTIVE inputs (segment + rule versions +
-- window) — identical inputs → same key → no duplicate recompute / no duplicate events.
select public.enqueue_job(
  'segment_recompute',
  seg_id::text || ':' || rule_version_set_hash || ':' || to_char(date_trunc('minute', now()),'YYYYMMDDHH24MI'),
  jsonb_build_object('segment_id', seg_id, 'mode', 'incremental', 'trace_id', trace),
  ws);
```

**Worker** (`functions/segment-recompute`, drained by `pg_cron`, same `claim_jobs` /
`complete_job` / lease / backoff / DLQ machinery, `service_role`):
1. Load the segment's active rules (pinned versions).
2. Compile predicates → the matching `(subject_ref, matched_rule_id, evidence)` set.
3. **Diff** against current `segment_membership`: compute adds and removes only.
4. Apply adds/removes (`service_role`, out-of-band): upsert new rows with `evidence` +
   `matched_rule`, delete departed rows.
5. Emit `segment.membership_changed` per **net change** and one `segment.recomputed` at
   the end (see Lifecycle events); write the `segment_recompute_run` audit row.

**Idempotency guarantee:** same inputs → same membership set → the diff is empty on a
replay → no rows change and no duplicate events fire. Side effects are keyed
(`unique(segment_id, subject_ref)`; deterministic event `id`s), so a retry after an
indeterminate failure never double-writes or double-notifies.

## Explainability

"Why is this subject in this segment?" is answered by data, not by re-running logic:

- `segment_membership.matched_rule` names the exact **rule version** that admitted them and
  `evidence` holds the concrete `platform_event` ids / attribute values that satisfied the
  predicate; `first_matched_at` / `evaluated_at` bound the window.
- Because `segment_rule` versions are append-only, the matched predicate is always
  recoverable even after the rule is later edited.
- A `segment_snapshot_member` carries the same `matched_rule_id` + `evidence`, so a
  historical campaign audience is explainable long after the live membership moved on.
- The membership explorer (Surfaces) renders this per member; the evidence view shows the
  event trail. Evidence stores **ids and typed values**, not raw PII payloads (see RLS).

## Lifecycle events

Emitted by this phase, via `public.emit_event(...)` → `movp_events` + `notify`/`webhook`
jobs (verbatim from the consolidated registry):

- **`segment.membership_changed`** — fired per net add/remove during recompute. Payload:
  `{ id, segment_id, subject_ref, change: 'added'|'removed', matched_rule_id }`. The `id`
  is a **deterministic** composite (`segment_id:subject_ref:evaluated_batch`) so a replayed
  recompute reuses the same `emit_event` notify/webhook idempotency key
  (`emit_event` keys on `payload->>'id'`) and never double-notifies.
- **`segment.recomputed`** — fired once per recompute run. Payload:
  `{ id: run_id, segment_id, mode, added_count, removed_count, evaluated_count }`.

Ingested (owned upstream, consumed here — the roadmap groups them under
"Segmentation / platform lifecycle"): `account.created`, `registration.completed`,
`onboarding.completed`. These arrive via the bridge (internal) or the ingestion endpoint
(external) and are not re-emitted by this phase.

**Notification-storm guard (performance):** a full/initial build can produce a huge delta.
Above a configurable threshold, per-member `segment.membership_changed` events are
suppressed in favor of the single `segment.recomputed` summary (which carries counts +
the `run_id` to page the delta), so a first build of a large segment can't trigger a
webhook/notify thundering herd. `segment.recomputed` always fires.

## Workflows / automation

- New event → (dynamic) enqueue incremental recompute; coalesced by the minute-window
  idempotency key.
- `pg_cron` schedules periodic full recompute (drift correction for time-relative
  predicates like "within 7d", which change membership even with no new events) and
  scheduled snapshots.
- Membership change → `segment.membership_changed` → the Core notify/webhook fan-out lets
  Campaigns/Domain-Workflows (Phase 7) react (e.g. "entered `registered-not-onboarded` →
  start nurture campaign"). This phase only emits; Phase 7 owns the automation registry.
- Snapshot-on-launch: when a campaign targets a segment, Campaigns may request a
  `segment_snapshot` (reason `campaign_launch`) so the audience is frozen and reproducible.
- Operator recovery reuses Core: `movp jobs replay --kind segment_recompute [--dead]` and
  an on-demand full recompute re-derive membership from the event history — recompute is a
  pure function of `platform_event` + rules, so it is always safely replayable.

## RLS & tenancy

- Every collection is `workspaceScoped` → member-only RLS via `is_workspace_member` (Core
  codegen). Non-members see zero `platform_event` / `segment` / membership / snapshot rows.
- **Ingestion is the trust boundary.** Neither ingestion path trusts a client-supplied
  `workspace_id`: the JWT path scopes via RLS `with check`; the API-key path resolves the
  workspace from the hashed key server-side inside a hardened `SECURITY DEFINER` RPC. A key
  for workspace A can never write a `platform_event` for workspace B.
- Recompute writes membership with `service_role` **only** in the out-of-band worker (Core
  invariant 3); user request paths never use `service_role`. Membership/snapshot rows a
  user reads are still RLS-filtered to their workspace.
- Internal tables (`ingest_key`, `segmentation_bridged_types`) live in the unexposed
  `movp_internal` schema, deny-all RLS, `service_role`-only — like `movp_jobs`/`webhooks`.
- **Content discipline / cross-tenant evidence:** `evidence` and event `properties` may
  hold PII, so they are never logged and never cross a workspace boundary; observability
  events use field **names not values** + salted `actor_email_hash` (Core observability
  contract). Ingestion API keys are stored hashed with least-priv file/row access.

## Surfaces & frontend

Auto-generated per Core codegen: tables + RLS + FTS + GraphQL/MCP/CLI + TS types +
metadata-registry rows for all collections. Astro templates on CF Workers + R2 over the
generated GraphQL:

- **Segment list** — segments with live member counts, owner, active/mode, last recompute.
- **Rule builder** — a visual editor over the typed predicate DSL (all/any/not + event &
  attribute conditions), with a "preview matching count" (a bounded, read-only evaluation)
  before saving a new rule version.
- **Membership explorer** — paginated members with a **per-member explanation** panel
  (matched rule version + evidence event trail); search/filter by subject.
- **Snapshot history** — snapshots over time (member-count trend), each opening its frozen
  member set; the diff between two snapshots.

UX/a11y per Core's frontend gate: empty/loading/error+retry/auth-failure states, keyboard
focus order, axe smoke over list / rule-builder / explorer / snapshot views.

**BI/ML readiness (primary consumer).** Field metadata already lands typed
dimensions/measures in the registry: `platform_event.event_type`/`subject_type`/`source`
+ `occurred_at` (time) are dimensions; `segment` is a dimension; `member_count`,
`added_count`/`removed_count`, `evaluated_count` are measures. Together with the
`platform_event` fact stream and `segment_membership` (subject × segment × time), an ML
feature pipeline gets a typed, auditable event + audience model — segments become labels
and membership transitions become features — **without extra plumbing**, exactly the
"reporting metadata + events feed BI/ML" convention.

## Dependencies

- **Core (Phase 1):** `workspaceScoped` codegen (tables/RLS/FTS/GraphQL/MCP/CLI/types),
  the metadata registry, the `edges` graph (`traverse_edges`), `public.emit_event` +
  `movp_events`, the `movp_internal.movp_jobs` engine + `enqueue_job`/`claim_jobs`/
  `complete_job`/`replay_jobs` RPCs, `@movp/auth` (in-function JWT verify, fail-closed),
  `@movp/flows`, `@movp/notifications`, Astro frontend template, CI gates.
- **Campaigns (Phase 5):** the `campaign` collection and the `campaign_segment` targeting
  convention this phase's `edges` seam plugs into.
- **Core contract this phase consumes** (no Core changes; stated so an executor doesn't invent
  alternatives):
  1. **Core's `f.json` field type** (`jsonb` column, non-searchable/non-embeddable by default)
     for `platform_event.properties`, `segment_rule.predicate`, `segment_membership.evidence`,
     `segment_snapshot.rule_version_set`.
  2. **Core's extensible job-kind registry** — this phase registers only `'segment_recompute'`
     (one `insert into movp_internal.movp_job_kind`, no constraint change) and *reuses* the
     queue — it does not fork a new one.
- New edge functions: `functions/ingest` (external ingestion) and
  `functions/segment-recompute` (queue worker) — both follow Core function conventions
  (per-request principal resolved at call time; env via `Deno.env.get`; user-bound client
  never module-scoped).

## Verification sketch

Run against a local stack (`supabase start`) with a workspace + membership + JWT.

1. **Internal bridge:** emit `registration.completed` via `emit_event` → a `platform_event`
   row (source `internal`) appears with the mapped `subject_ref`/`occurred_at`; a non-bridged
   type produces no row.
2. **External ingest (JWT):** `POST /ingest` with a valid member JWT → row under RLS.
   **External ingest (API key):** a workspace-A key writes A's events; the same key cannot
   write a workspace-B `platform_event` (server-resolved workspace); a malformed/oversized
   event is dropped, batch cap enforced.
3. **Evaluation + idempotency:** a "registered-not-onboarded within 7d" segment recomputes
   to the expected member set; re-running the **same** inputs changes zero rows and emits
   zero new events (diff empty); a coalescing-window burst enqueues **one** job.
4. **Explainability:** each `segment_membership` has `matched_rule` (a specific version) +
   `evidence` naming the matching `platform_event` ids; editing the rule mints a new version
   and the old membership still resolves its original predicate.
5. **Snapshots:** take a snapshot, then change events; the snapshot's member set is
   unchanged; a campaign targeting the snapshot resolves the identical audience.
6. **Events:** recompute emits `segment.membership_changed` per net change (deterministic
   `id` → replay does not double-notify) and one `segment.recomputed`; above the storm
   threshold per-member events are suppressed but `segment.recomputed` still fires; each
   event carries a `trace_id` and no PII.
7. **Durability:** kill a recompute worker mid-job → the lease expires → another worker
   reclaims and completes exactly once; force the worker to fail → backoff → DLQ after
   `max_attempts`; `movp jobs replay --kind segment_recompute --dead` recovers it.
8. **RLS/tenancy:** a non-member JWT returns 0 rows on every collection; internal tables
   (`ingest_key`) reject anon/authenticated direct access; observability events emit
   field names not values (redaction gate).
9. **BI/ML:** the metadata registry lists the segmentation dimensions/measures above; a
   membership-over-time query returns subject × segment × `evaluated_at` for feature export.

## When built

**Phase 6**, after Marketing Planning & Campaigns (Phase 5) — segments are only useful once
there is a campaign to target with them, and the seam is a `campaign → segment/snapshot`
edge. Depends on Core + Campaigns. Its emitted events (`segment.membership_changed`,
`segment.recomputed`) and the `platform_event` stream become inputs to the Phase 7 Domain
Workflows & Webhooks registry.
