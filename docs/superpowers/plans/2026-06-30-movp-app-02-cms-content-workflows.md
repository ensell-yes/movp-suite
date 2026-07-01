# Phase 4 — CMS & Content Workflows Roadmap Plan

Plan `2026-06-30-movp-app-02-cms-content-workflows.md` ; build order Phase 4 ; depends on Core, Collaboration, Task.

## Goal

Model a Payload/Directus-style content system on the MOVP Core substrate to power
campaign content — **content types → items → immutable revisions**, with editorial,
moderation, approval, curation, and SEO/AEO workflows. This plan **defines the canonical
versioning pattern** (immutable `*_revision` + current/approved/published pointers +
`content_hash`) that the roadmap references and that later domains (task-description
versioning, campaign briefs) reuse. Everything is config-first `defineCollection` +
lifecycle triggers + frontend templates over Core's codegen, events, jobs, webhooks,
notifications, search, and R2 — **no new infrastructure**.

**Two v1 decisions stated up front.**

1. **Content models are DATA, not code.** In a headless CMS, workspace authors define
   content models at runtime (Directus/Payload), but Core is migration-driven code-first
   `defineCollection`. The pragmatic reconciliation: the *envelope* collections
   (`content_type`, `content_item`, `content_revision`, …) are code-defined
   `defineCollection`s that receive all Core codegen (RLS, FTS, edges, metadata registry).
   A `content_type` **row** carries a JSON **field-schema**; a `content_item` stores its
   typed field values in a validated `data jsonb` column, Zod-validated **at the domain
   boundary** against its type's schema. This gives workspace-authored content models with
   **no migration per type**, at the cost of per-item typed columns (deferred — see
   Simplicity). CMS uses Core's `f.json` primitive for the `field_schema` / `data`
   columns — no new Core-schema extension.
2. **Public delivery is cache-at-publish, not anonymous RLS.** Core RLS is member-only.
   Rather than punch an anon read policy into the data tier (drafts and published rows live
   in the same table — column ≠ row visibility risk), **publish pushes the published
   revision to the frontend via a signed webhook** (Core's HMAC delivery). The authenticated
   GraphQL/MCP surfaces stay member-gated; only content that has been explicitly published
   ever leaves the boundary.

## Collections

All are `workspaceScoped: true` (Core adds `workspace_id` + `is_workspace_member` RLS, FTS,
edges, metadata). `reporting`/`searchable`/`embeddable` flags noted where they matter.

- **`content_type`** — a config-first *definition of a content model*. Key fields:
  `key` (text, slug, required — stable id used by items), `label`, `field_schema`
  (`f.json` — ordered list of field descriptors `{name,type,required,localized,
  ref_content_type?,ref_asset?}` where `type ∈ text|richtext|number|bool|date|enum|
  asset|reference`), `moderation_policy`/`approval_policy` (`enum`, `reporting: dimension`).
  Composes with Core's `defineCollection`: the envelope is code-defined; the *model* is a
  row. Domain validates `field_schema` shape structurally on write (quarantine malformed —
  a parseable JSON is not a valid schema).
- **`content_item`** — an *instance* of a `content_type`. Fields: `content_type_key`
  (`relation('content_type')`, `reporting: dimension`), `slug` (text, unique-per-ws-per-type),
  `status` (`enum ['draft','in_review','approved','published','archived']`, default `draft`,
  `reporting: dimension`), pointers **`current_revision_id` / `approved_revision_id` /
  `published_revision_id`** (`relation('content_revision')`, nullable), `published_at`,
  denormalized **`search_text`** (text, `searchable`) and **`search_body`** (richText,
  `embeddable`) maintained by the domain on each write so Core's FTS + chunked embeddings
  index item content **unchanged** (jsonb is not directly FTS/vector-indexable). The `data`
  itself is snapshotted onto revisions, not stored mutably here.
- **`content_revision`** — **IMMUTABLE** snapshot, one row per accepted edit. Fields:
  `content_item_id` (`relation`), `revision_number` (int, monotonic per item),
  `data` (`f.json` — full field-value snapshot, not a diff), **`content_hash`** (text),
  `author_id`, `parent_revision_id` (`relation('content_revision')`, nullable — lineage for
  diff), `created_at`. Append-only: `UPDATE`/`DELETE` revoked; a trigger raises on `UPDATE`.
- **`content_approval`** — approval **state machine** per item. Fields: `content_item_id`,
  `state` (`enum ['pending','approved','rejected','superseded']`, `reporting: dimension`),
  `policy` (`enum ['single','multi','moderation']`), `approvals_required` (int, default 1),
  **`approved_revision_id`** (`relation('content_revision')`, nullable — the specific
  immutable revision captured at approve time), **`approved_content_hash`** (text, copied
  from that revision — tamper-evidence), `decided_at`, `decided_by`. Multi-approver votes
  are child **`content_approval_vote`** rows (`approval_id`, `voter_id`, `vote`,
  `unique(approval_id, voter_id)` — no double-vote; immutable).
- **`content_publish_event`** — **IMMUTABLE** publish/unpublish audit. Fields:
  `content_item_id`, `action` (`enum ['publish','unpublish']`, `reporting: dimension`),
  `revision_id` (`relation` — the revision made live on publish; the previously-live one on
  unpublish), `content_hash`, `actor_id`, `created_at`. Append-only (as revisions).
- **`asset`** — R2-backed media. Fields: `filename`, `mime` (text, `reporting: dimension`),
  `r2_key` (text — `${workspace_id}/${id}`), `size_bytes` (int, `reporting: measure`),
  `checksum` (text, sha256), `width`/`height` (int, nullable), `alt_text` (text,
  `searchable`), `uploaded_by`. Upload = domain issues a **presigned R2 PUT** (size + mime
  bounded in the policy — the bound-before-buffer analog; the server never buffers the file),
  client uploads direct to R2, `asset` row finalized with server-verified `checksum`/`size`.
- **`content_collection`** + **`content_collection_entry`** — curation. The collection holds
  `key`/`label`/`description`; the entry is a **join collection** (`collection_id`,
  `content_item_id`, `position` int) — a bespoke join is justified here because the link
  carries a rich attribute (`position`) per convention. Curation targets **published** items
  only (domain + RLS enforced).
- **`content_seo`** — 1:1 SEO/AEO sidecar. Fields: `content_item_id` (unique), `meta`
  (`f.json` — title/description/canonical/robots/og-image asset ref), `jsonld` (`f.json` —
  schema.org type + AEO structured answers: FAQ Q&A pairs, answer summary, entity mentions),
  `score` (int, `reporting: measure`), `checklist` (`f.json` — `[{rule,pass}]`). Advisory,
  computed by a domain audit op; surfaced in the editor.

## Relationships

- **FK (`relation`, one-to-many):** item → type (`content_type_key`); revision → item;
  approval → item; publish_event → item; the three pointer FKs item → revision;
  collection_entry → collection/item; seo → item. Pointers are FKs so an exact-version read
  is a single indexed join.
- **`edges` graph (many-to-many / cross-collection, `graph: true`, `traverse_edges`):**
  - `content_item —references→ asset` (an item's `data` may cite N assets; edges make the
    reference graph queryable for orphan-asset GC and "where used").
  - `content_item —references→ content_item` (a `reference`-typed field linking items).
  - **`content_item —editorial_task→ task`** — REUSE **Task**: editorial to-dos link to the
    item via edges (no FK into Task's domain; loose coupling).
  - Campaigns (Phase 5) later add `deliverable —content→ content_item` edges over the same
    graph — this plan does not build them.
- **Collaboration (polymorphic, REUSE):** editorial discussion is `comment`/`mention`/
  `reaction` attached to `('content_item', id)` via Collaboration's `(entity_type,
  entity_id)` + edges; the **Inbox** surfaces content mentions/assignments. CMS defines **no**
  per-item comment table.

## Versioning

**This is the core of the plan — the canonical immutable-revision pattern.**

**Every accepted edit appends a `content_revision`; nothing mutates a revision.** The item
row holds only *pointers* into that append-only history:

- `current_revision_id` — the latest working revision.
- `approved_revision_id` — the revision frozen at the last approval (nullable).
- `published_revision_id` — the revision currently live (nullable).

**`content_hash` derivation (obey the idempotency rule — hash the EFFECTIVE payload).** The
hash is `sha256(canonical_json(validated_data))`, computed **in the domain layer AFTER Zod
validation and canonicalization** (stable key ordering, normalized whitespace/number forms,
dropped unknown keys) — i.e. over exactly what is stored, never the raw request body, and
excluding volatile fields (author, timestamps). Consequences:

- **No-op edits are deduped:** if a save canonicalizes to `current_revision.content_hash`,
  **no new revision is created** (Efficiency — history stays meaningful, storage bounded).
- **The equivalence relation is ours and exact:** because the same canonicalization defines
  both what we store and what we hash, there is no superset/subset gap. A *downstream*
  consumer that hashes rendered HTML computes a different hash — state that seam explicitly
  where it matters (cache keys), do not claim the hashes are interchangeable.
- The DB never recomputes the hash (avoids canonicalization drift between languages); it is
  written once by the domain and thereafter read-only.

**Editing after approval invalidates approval.** Creating a new revision advances
`current_revision_id` past `approved_revision_id`. An `AFTER INSERT` trigger on
`content_revision` detects `approved_revision_id IS NOT NULL AND approved_revision_id <>
current_revision_id` and **demotes**: `content_approval.state → 'superseded'`, `content_item.
status → 'in_review'` (or `'draft'` if no open approval). The approved snapshot
(`approved_revision_id` + `approved_content_hash`) is preserved for audit — approval always
names a *specific frozen revision*, never "whatever is current".

**Exact-version reads are content-addressed.** The published read path fetches by
`published_revision_id` (an immutable snapshot), so a reader sees a stable version while
editors work on newer drafts; a new publish is a new revision id → a new cache key → natural
cache-busting.

```
content_item
  current_revision_id  ─┐
  approved_revision_id ─┼─▶ content_revision (append-only, content_hash, author, created_at)
  published_revision_id ┘        ▲ parent_revision_id (lineage → diff)
```

## Lifecycle events

State transitions emit **exactly one** event via a DB `AFTER` trigger →
`public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)` (Core's signature),
which writes `movp_internal.movp_events` and enqueues `notify` + `webhook` jobs
(idempotent, retried, DLQ'd). **Payloads carry field names/ids only** — `content_item_id`,
`content_type_key`, `revision_id`, `content_hash`, `actor_id`, `status` — **never content
bodies or PII** (Core observability discipline). Event names are used **verbatim** from the
roadmap registry:

| Event | Emitted from | Trigger site |
|---|---|---|
| `content.created` | new `content_item` | `AFTER INSERT` on `content_item` |
| `content.revision_created` | new `content_revision` | `AFTER INSERT` on `content_revision` |
| `content.submitted_for_approval` | item → `in_review` | `AFTER UPDATE OF status` on `content_item` |
| `content.approved` | approval → `approved` | `AFTER UPDATE OF state` on `content_approval` |
| `content.rejected` | approval → `rejected` | `AFTER UPDATE OF state` on `content_approval` |
| `content.published` | new publish event, `action='publish'` | `AFTER INSERT` on `content_publish_event` |
| `content.unpublished` | new publish event, `action='unpublish'` | `AFTER INSERT` on `content_publish_event` |
| `content.scheduled` | new `content_schedule` | `AFTER INSERT` on `content_schedule` |

**Publish/unpublish emit SIGNED webhooks for free:** `emit_event` fans out to
`movp_internal.webhooks` subscribers for the type, and the flows worker signs each delivery
with HMAC-SHA256 in the `x-movp-signature` header (Core). The frontend subscribes to
`content.published`/`content.unpublished` to **purge its cache** (the slug→revision mapping
in R2/CDN) — the invalidation signal. Trigger functions are hardened `SECURITY DEFINER`
(`set search_path = ''`, fully-qualified) like every Core definer.

```sql
-- lifecycle trigger, mirrors Core's on_note_created (hardened definer)
create or replace function movp_internal.on_content_published()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.action = 'publish' then
    perform public.emit_event('content.published', new.workspace_id,
      jsonb_build_object('content_item_id', new.content_item_id,
        'revision_id', new.revision_id, 'content_hash', new.content_hash), gen_random_uuid()::text);
  end if;
  return new;
end; $$;
```

## Workflows / automation

- **Editorial** — the `content_item.status` spine `draft → in_review → approved → published
  → archived`. Transitions are domain ops gated in RLS (below). Editorial **tasks** REUSE
  Task (linked via `editorial_task` edges); editorial **discussion** REUSEs Collaboration
  comments/mentions on the item. Notifications go via `@movp/notifications` to
  authors/approvers/subscribers resolved from assignment + mentions, never hardcoded.
- **Approval (single / multi)** — `content_approval.policy`. `single`: first authorized
  approve decides. `multi`: `content_approval_vote` rows accumulate; the approval flips to
  `approved` when distinct approving votes reach `approvals_required`; any reject flips to
  `rejected`. Self-approval allowed only if a type flag permits. Approve **captures an
  immutable `approved_revision_id` + hash** at decision time.
- **Moderation** — `policy='moderation'`: the same approval machine over user-generated /
  campaign-inbound content, fed by a **moderation queue** surface (items in `in_review` with
  a moderation policy). No new event types — reuses `submitted_for_approval` / `approved` /
  `rejected`.
- **Curation** — `content_collection` + ordered `content_collection_entry` (`position`).
  Reordering rewrites `position`; membership restricted to `published` items. A published
  curated collection is itself delivered via the publish webhook.
- **SEO/AEO** — `content_seo` sidecar. A domain **audit op** runs a rule set (title/meta
  length, canonical presence, alt-text coverage, JSON-LD validity, AEO answer/FAQ
  completeness), writing `score` + `checklist`. Advisory (no gate, no new event); the editor
  shows the score and unmet rules. AEO = answer-engine-optimization structured fields
  (schema.org JSON-LD, FAQ Q&A, answer summary, entity mentions) authored into `jsonld`.
- **Scheduling** — a **`content_schedule`** row (`content_item_id`, `action` ∈
  `publish|unpublish`, `revision_id` **pinned at schedule time** so a later edit can't
  silently change what goes live, `run_at`, `state` ∈ `scheduled|fired|canceled|failed`).
  Insert emits `content.scheduled`. **`pg_cron`** (per-minute, as Core) invokes a
  `content-scheduler` edge worker that claims due rows with `for update skip locked` (Core's
  crash-safe lease pattern) and performs the publish/unpublish through the domain op — which
  appends a `content_publish_event` → emits `content.published`/`content.unpublished` + the
  signed webhook. (We keep the shared `movp_jobs.kind` enum unchanged; a `publish`/`unpublish`
  job kind is a deferred option if the publish action itself needs DLQ/retry.)

## RLS & tenancy

- **Workspace isolation** is Core's `is_workspace_member(workspace_id)` on every collection —
  free from codegen. Non-members see zero rows on all CMS surfaces.
- **Capability gate (authoritative, at the data boundary).** A hardened `SECURITY DEFINER`
  helper `public.has_content_capability(ws uuid, cap text)` reads the verified `auth.uid()`
  membership role (`set search_path = ''`, least-priv grants — like `is_workspace_member`).
  State transitions are enforced as **RLS `with check` on the state-changing insert/update**,
  not in the UI: inserting a `content_approval` decision or a `content_publish_event` requires
  the principal to hold `approve` / `publish` — a client cannot reach these by calling the API
  directly. UI affordances (hide the Publish button) are advisory only.
- **Immutability is enforced in the data tier:** `content_revision`, `content_publish_event`,
  and `content_approval_vote` grant `INSERT` to members but **revoke `UPDATE`/`DELETE`**; a
  guard trigger raises on `UPDATE`. History cannot be rewritten.
- **Multi-approver integrity:** `unique(approval_id, voter_id)` blocks double-voting; the
  count that flips state is computed server-side over distinct voters, never trusted from the
  client.
- **Draft confidentiality:** because public delivery is cache-at-publish (Decision 2), draft
  and in-review revisions **never** leave the member boundary. No anon RLS policy is added;
  the published webhook payload references only the published revision.
- **Assets:** workspace-scoped rows + RLS; R2 objects keyed by `workspace_id/asset_id`,
  served to editors via short-lived signed URLs. Published-content assets are copied/exposed
  through the publish path, not by loosening asset RLS.

## Surfaces & frontend

Generated GraphQL/MCP/CLI come free from codegen (list/get/create/update/search per
collection). Domain adds business ops (`submitForApproval`, `decideApproval`, `publish`,
`unpublish`, `schedule`, `runSeoAudit`, `issueAssetUpload`) — each resolving the per-request
`{ db, userId }` from `ctx` at call time (Core invariant; never module scope). Astro-on-CF+R2
templates:

- **Content list** — filter by type/status; FTS + semantic search over `search_text`/
  `search_body`.
- **Editor** — a dynamic form rendered from the item's `content_type.field_schema`; asset
  fields use presigned R2 upload; SEO/AEO panel shows score + checklist.
- **Revision history + diff** — timeline of `content_revision` rows; diff two `data`
  snapshots (parent lineage) with the frozen approved/published revisions marked.
- **Approval queue** — pending approvals the current user can decide (capability-scoped);
  multi-approver progress.
- **Editorial calendar** — scheduled publish/unpublish (`content_schedule`) + editorial-task
  due dates (via Task edges); reuse the Inbox for content mentions.

Boundary rule (Core): templates import only the generated client/types — never
`@movp/auth`/`@movp/domain`/service-role — enforced by the boundary test.

## Dependencies

- **Core (Phase 1):** `defineCollection` + codegen (SQL/RLS/FTS/edges/GraphQL/MCP/CLI/
  types/metadata); `emit_event` + `movp_events` + `movp_jobs`; `webhooks` registry + HMAC
  `x-movp-signature` delivery; `@movp/notifications` (Resend); `search_chunk`/`match_chunks`
  + chunked embeddings; `traverse_edges`; `pg_cron`; R2; `is_workspace_member` + hardened
  `SECURITY DEFINER` conventions; **`f.json`** is consumed from Core (no Core-schema extension).
- **Collaboration (Phase 2):** polymorphic `comment`/`mention`/`reaction` on `content_item`;
  the Inbox aggregation. CMS ships no bespoke comment tables.
- **Task (Phase 3):** editorial tasks linked via `editorial_task` edges.
- **Provides to Campaigns (Phase 5):** `content_item` as the target of `deliverable —content→`
  edges (built there, not here).

## Verification sketch

1. **Model + item:** create a `content_type` (validate `field_schema` shape; malformed →
   rejected/quarantined); create a `content_item` → `content.created` + `content.revision_created`
   (revision 1, hash set). Re-save byte-different-but-canonically-identical `data` → **no new
   revision** (dedup); a real edit → revision 2 with a new hash and `parent_revision_id`.
2. **Approval:** `submitForApproval` → status `in_review` + `content.submitted_for_approval`;
   `decideApproval(approve)` (single) → `content.approved`, `approved_revision_id`/hash frozen
   to the exact revision. Multi: N distinct votes flip to approved; a duplicate vote is
   rejected by `unique`.
3. **Invalidation-on-edit:** edit an approved item → new revision → approval `superseded`,
   status back to `in_review`; the frozen `approved_revision_id` is unchanged (audit intact).
4. **Publish / exact-version read:** `publish` → `content_publish_event`, `published_revision_id`
   set, status `published`, `content.published` + a **signed** webhook (verify the
   `x-movp-signature` HMAC against the raw body); read by `published_revision_id` returns the
   frozen snapshot while a newer draft exists.
5. **Unpublish / cache:** `unpublish` → `content.unpublished` + webhook → frontend purge; the
   member GraphQL surface still shows the item, anon delivery no longer serves it.
6. **Schedule:** create `content_schedule` → `content.scheduled`; advance clock, `pg_cron`
   scheduler fires the due row exactly once (lease-safe) → publish path runs.
7. **Immutability & authz:** `UPDATE`/`DELETE` on `content_revision`/`content_publish_event`
   denied; a member **without** the `approve`/`publish` capability cannot insert a decision or
   publish event even calling the API directly (RLS `with check`, not UI); a non-member sees 0
   rows; no draft revision is reachable through any anon path.
8. **Curation / SEO / assets:** reorder a `content_collection` (published-only); `runSeoAudit`
   writes `score` + `checklist`; presigned asset upload finalizes with a server-verified
   checksum and a bounded size/mime.
9. **Observability:** each transition emits exactly one `trace_id`-correlated event whose
   payload contains ids/hashes only — no content body, no PII (redaction gate).

## When built

**Phase 4**, after Collaboration (Phase 2) and Task (Phase 3) exist — it reuses their
polymorphic social primitives and editorial-task edges — and **before** Marketing Planning
& Campaigns (Phase 5), which graph-links `deliverable → content_item` and depends on this
plan's versioning/publish spine. Expanded into a bite-sized TDD implementation series (as
Phase 1 was) when built.
