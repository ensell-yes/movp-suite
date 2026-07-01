# Phase 2 — Collaboration & Social Core Roadmap Plan

Plan `app-05` of the MOVP application roadmap; build order **Phase 2**; depends on **Core** (Phase 1).

## Goal

Deliver the **shared, polymorphic social layer** that Task (Phase 3), CMS (Phase 4), and
Campaigns (Phase 5) all reuse — so those domains attach discussion, reactions, saves,
shares, and tags to any entity **without per-entity tables**. Everything binds to a target
by a polymorphic `(entity_type, entity_id)` pair (mirroring Core's
`search_chunk.(source_table, source_id)`) plus the typed `edges` graph, so a `comment` on a
task, a content revision, and a campaign is the *same* row shape. The layer also ships the
per-user, cross-domain **Inbox** (All Updates / Mentions / Saved Items / Assigned Items)
computed over `movp_events` + `mention` + `saved_item` (+ Task's assignments, Phase 3).
This is Phase 2 — *before* Task — precisely so the social primitives are built once and
every later domain consumes them instead of reinventing them.

Leverage: five `defineCollection` definitions give us tables, RLS, FTS, GraphQL/MCP/CLI, and
types for free. The net-new work is (a) polymorphic **entity-access RLS**, (b) per-transition
**lifecycle triggers** onto Core's `emit_event` spine, (c) two member-safe **SECURITY DEFINER
read RPCs** (Inbox feed over the internal event log; share-token resolution), and (d)
generalizing the flows worker's recipient resolution. Each is called out as a Core seam below.

## Collections

All collections are `workspaceScoped: true` (codegen adds `id`, `workspace_id` + the
`<coll>_rw` member RLS policy, `created_at`, `updated_at`). Entity pointers use `f.uuid`
because they are **polymorphic** (`(entity_type, entity_id)` — no single target collection),
not because relations lack FKs: Core emits a real FK column for concrete `many-to-one`/
`one-to-one` relations, but a polymorphic pointer has no one table to reference; see
Relationships for the FK-vs-edges
realization. Polymorphic target pointers are `entity_type f.text` + `entity_id f.uuid` (no
FK — the target lives in another collection resolved at query time).

### `comment` — entity-agnostic threaded discussion

Attaches to any entity via `(entity_type, entity_id)`; `parent_id` makes it threaded
(root = `NULL`); `body` is searchable + embeddable; `@handle`s are extracted into `mention`.

| field | type (`f.*`) | label | cardinality / relation | reporting | searchable / embeddable |
|---|---|---|---|---|---|
| `entity_type` | `f.text` | Entity type | polymorphic pointer (no FK) | dimension | — |
| `entity_id` | `f.uuid` | Entity | polymorphic pointer (no FK) | — | — |
| `parent_id` | `f.uuid` | Parent comment | self-ref → `comment.id`, nullable | — | — |
| `body` | `f.richText` | Comment | — | — | **searchable + embeddable** |
| `actor_id` | `f.uuid` | Author | → `auth.users.id` | dimension | — |
| `status` | `f.enum(['visible','hidden','deleted'])` | Status | — | dimension | — |

`status` gives moderation/soft-delete while preserving thread shape (a `deleted` parent keeps
its replies). Index `(entity_type, entity_id, created_at)` and `(parent_id)`.

### `mention` — a user @-mentioned in a comment/entity

Materialized so the Inbox → Mentions tab and `user.mentioned` notifications never re-parse
bodies. One row per resolved mention.

| field | type (`f.*`) | label | cardinality / relation | reporting | searchable / embeddable |
|---|---|---|---|---|---|
| `entity_type` | `f.text` | Source type | polymorphic pointer | dimension | — |
| `entity_id` | `f.uuid` | Source | polymorphic pointer | — | — |
| `comment_id` | `f.uuid` | In comment | → `comment.id`, nullable | — | — |
| `mentioned_user_id` | `f.uuid` | Mentioned user | → `auth.users.id` | dimension | — |
| `actor_id` | `f.uuid` | Mentioned by | → `auth.users.id` | dimension | — |
| `status` | `f.enum(['unread','read'])` | State | — | dimension | — |

Unique `(workspace_id, comment_id, mentioned_user_id)` dedupes a handle repeated in one comment.

### `reaction` — like / dislike (extensible) on any entity or comment

| field | type (`f.*`) | label | cardinality / relation | reporting | searchable / embeddable |
|---|---|---|---|---|---|
| `entity_type` | `f.text` | Entity type | polymorphic pointer | dimension | — |
| `entity_id` | `f.uuid` | Entity | polymorphic pointer | — | — |
| `reaction_type` | `f.enum(['like','dislike','celebrate','insightful'])` | Reaction | — | dimension | — |
| `actor_id` | `f.uuid` | Reactor | → `auth.users.id` | dimension | — |

Unique `(workspace_id, entity_type, entity_id, actor_id, reaction_type)` — one of each type
per user per target; **un-reacting is a DELETE** (no un-like event exists in the registry).
The enum is extensible; only `like`/`dislike` map to registry events today (see Lifecycle).

### `saved_item` — a user's bookmark of any entity

Drives Inbox → Saved Items. Strictly per-user (RLS scopes reads to `actor_id = auth.uid()`).

| field | type (`f.*`) | label | cardinality / relation | reporting | searchable / embeddable |
|---|---|---|---|---|---|
| `entity_type` | `f.text` | Entity type | polymorphic pointer | dimension | — |
| `entity_id` | `f.uuid` | Entity | polymorphic pointer | — | — |
| `actor_id` | `f.uuid` | Saved by | → `auth.users.id` | dimension | — |
| `note` | `f.text` | Note | — | — | searchable |

Unique `(workspace_id, actor_id, entity_type, entity_id)`.

### `share_link` — tokenized, scoped shareable link to an entity

| field | type (`f.*`) | label | cardinality / relation | reporting | searchable / embeddable |
|---|---|---|---|---|---|
| `entity_type` | `f.text` | Entity type | polymorphic pointer | dimension | — |
| `entity_id` | `f.uuid` | Entity | polymorphic pointer | — | — |
| `token_hash` | `f.text` | Token digest | — | — | — (never exposed/searchable) |
| `scope` | `f.enum(['view','view_comment'])` | Access scope | — | dimension | — |
| `expires_at` | `f.datetime` | Expires | — | — | — |
| `revoked` | `f.boolean` | Revoked | — | dimension | — |

The **raw token is high-entropy, returned exactly once at creation, and never persisted** —
only its `sha256` digest is stored (`token_hash`), so a DB read cannot mint a working link.
Unique `(workspace_id, token_hash)`. (`scope` is a bounded **enum** by choice — even though
Core provides `f.json` — so the share surface stays auditable/validated; richer per-link
grants, if ever needed, go in `edges.metadata`.)

### `tag` (Core collection) — extended to any entity

**Not redefined here.** Core already ships `tag` (used by `note.tags` many-to-many). We make
tagging *cross-domain* without a new table: any entity attaches a tag as an **edges** row
`(entity_type, entity_id) —[rel='tagged']→ ('tag', tag_id)`. Listing an entity's tags (and a
tag's entities) uses **Core's `public.traverse_edges(...)`** recursive-CTE helper (added in
Phase 1 Plan 3 alongside `edges`; this phase only consumes it; see
Dependencies).

## Relationships

- **Plain FK / uuid columns (one-to-one / one-to-many):** `actor_id`, `mentioned_user_id` →
  `auth.users.id`; `comment.parent_id` → `comment.id` (self-ref thread); `mention.comment_id`
  → `comment.id`. Modeled with `f.uuid` because **Core v1 `f.relation` emits no FK** — this
  phase's migration adds the actual `references` constraints (self-FK on `parent_id`) on top
  of the codegen'd columns.
- **Polymorphic pointer (no FK):** `(entity_type, entity_id)` on `comment`, `mention`,
  `reaction`, `saved_item`, `share_link`. The target is any collection row across any domain,
  so no FK is possible (same trade-off as `search_chunk`). Integrity is by convention +
  `can_access_entity` (below), not referential constraint; indexed `(entity_type, entity_id)`.
- **`edges` graph (many-to-many / cross-collection):** tag attach (`rel='tagged'`), and any
  future cross-collection social link (e.g. `comment —[references]→ deliverable`). Threads use
  the cheaper `parent_id` column, not edges, but the same `traverse_edges` helper can walk a
  reply tree if a graph view is wanted later.

## Lifecycle events

Each transition fires **exactly one** `public.emit_event(ev_type, ws, payload, trace)` from a
per-collection `movp_internal.on_<coll>_*()` `AFTER` trigger (`SECURITY DEFINER`,
`set search_path = ''`) — reusing Core's spine (writes one `movp_events` row + enqueues one
`notify` job + one `webhook` job per matching active subscription; no new queue infra, no new
`movp_jobs.kind`). **Payload must include `id`** — `emit_event` derives the notify/webhook
idempotency key from `payload->>'id'`.

| Registry event | Fires on | Transition |
|---|---|---|
| `comment.added` | `AFTER INSERT ON comment` where `parent_id IS NULL` | new root comment |
| `comment.replied` | `AFTER INSERT ON comment` where `parent_id IS NOT NULL` | reply added |
| `user.mentioned` | `AFTER INSERT ON mention` | a member is @-mentioned |
| `item.liked` | `AFTER INSERT ON reaction` where `reaction_type='like'` | like added |
| `item.disliked` | `AFTER INSERT ON reaction` where `reaction_type='dislike'` | dislike added |
| `item.saved` | `AFTER INSERT ON saved_item` | entity bookmarked |
| `item.shared` | `AFTER INSERT ON share_link` | share link minted |

A single trigger per table branches on the row (event names are the registry strings verbatim):

```sql
-- movp_internal.on_comment_created — SECURITY DEFINER, search_path='' (Core trigger convention)
begin
  perform public.emit_event(
    case when new.parent_id is null then 'comment.added' else 'comment.replied' end,
    new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type', new.entity_type,
      'entity_id', new.entity_id, 'parent_id', new.parent_id, 'actor_id', new.actor_id),
    gen_random_uuid()::text);
  return new;
end;
```

Payloads carry `id` + `entity_type`/`entity_id` + `actor_id` (and `mentioned_user_id` for
`user.mentioned`, `reaction_type` for reactions) so recipient resolution and the Inbox render
without a follow-up read. **Not emitted (by design):** un-react/un-save (DELETE), `read`/`hidden`
status transitions, and extensible reaction types beyond like/dislike — no registry event
exists, and inventing one is deferred to Phase 7's typed registry.

## Workflows / automation

- **@-mention extraction.** `@movp/domain` `comment.create` (call-time principal) is the only
  writer that parses `body` for `@handle` tokens, resolves them against `workspace_membership`
  (unknown/non-member handles dropped — no cross-workspace leak), and inserts `mention` rows in
  the *same* transaction as the comment. Extraction lives in the service, not a DB trigger,
  because handle→user resolution is fuzzy app logic; the `mention` INSERT then fires
  `user.mentioned` via its trigger. Idempotent on re-edit via the `mention` unique key.
- **Recipient resolution (Core seam — generalize the flows worker).** Core's `runFlowsWorker`
  currently resolves the *workspace owner* for every `notify` job (a placeholder). This phase
  replaces it with an event-keyed resolver: `user.mentioned` → `payload.mentioned_user_id`;
  `comment.added`/`comment.replied` → thread participants + entity subscribers/observers/
  assignees (**assignees are a Task Phase-3 seam** — empty until then); `item.saved` → no
  notify (self-action). All user text passes `escapeHtml` before entering notification HTML.
- **Share-link lifecycle.** Minting returns the raw token once + stores only `token_hash`.
  Resolution is lazy (checks `revoked`/`expires_at` at read); an optional `pg_cron` sweep flips
  long-expired links `revoked=true` for hygiene. Revoke = `UPDATE ... SET revoked=true`.
- **Moderation.** `comment.status` → `hidden`/`deleted` is an UPDATE (no new event); the Inbox
  and thread views filter `status='visible'` for non-authors while keeping the row for audit.
- **Digest (optional).** A `pg_cron` flow can batch a user's unseen `All Updates` into a daily
  `notify` job — reuses the existing queue, adds no new kind.

## RLS & tenancy

Every collection is `workspaceScoped`, so codegen emits the baseline `<coll>_rw`
member policy. **Workspace membership is necessary but not sufficient** — the roadmap invariant
is "a user sees collaboration only on entities they can access." Because `defineCollection` has
no RLS hook, this phase ships a migration that **tightens** the generated policies:

- **Entity-access gate (authoritative).** A `public.can_access_entity(p_entity_type text,
  p_entity_id uuid) returns boolean` — `SECURITY DEFINER`, `search_path=''`, `stable`, granted
  to `authenticated` — dispatches per `entity_type` to the owning domain's visibility predicate,
  defaulting to `is_workspace_member` in Phase 2. `comment`/`reaction`/`mention` read policies
  become `is_workspace_member(workspace_id) AND public.can_access_entity(entity_type, entity_id)`.
  **Seam:** Task (Phase 3) registers its assignee/observer predicate here so comments on a
  restricted task stay hidden from non-participants — enforced in RLS, never a resolver filter.
- **Author-scoped writes.** `WITH CHECK` on all five requires `actor_id = (select auth.uid())`
  — a member cannot post/react/save/share *as* someone else.
- **Recipient-scoped reads.** `saved_item` and `mention` reads add `actor_id = auth.uid()` /
  `mentioned_user_id = auth.uid()` — a user sees only their own saves and mentions.
- **Inbox RPC (member-safe read over the internal log).** `movp_events` lives in
  service-role-only `movp_internal` (not PostgREST-exposed) and there is no member-readable
  view — so the feed is a **new `public.inbox_feed(ws uuid, tab text, cursor timestamptz,
  page int)`** `SECURITY DEFINER` RPC. Because DEFINER **bypasses RLS, the RPC re-applies every
  check itself**: fail closed unless `is_workspace_member(ws)`; then per tab —
  `all` = `movp_events` filtered by `can_access_entity`; `mentions` = `mention` where
  `mentioned_user_id = auth.uid()`; `saved` = `saved_item` where `actor_id = auth.uid()`;
  `assigned` = Task assignments where assignee = `auth.uid()` (**Phase-3 seam — returns empty,
  not an error, until Task ships**). Returns JSON, never `movp_internal` composites; keyset
  paginated on `created_at`.

```sql
create or replace function public.inbox_feed(ws uuid, tab text, cursor timestamptz, page int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_workspace_member(ws) then          -- DEFINER bypasses RLS: re-check here
    return jsonb_build_object('items', '[]'::jsonb);   -- fail closed, no leak
  end if;
  -- dispatch per tab; every branch re-filters by auth.uid()/can_access_entity + keyset cursor
  ...
end; $$;
```

- **Share-token access path.** `public.resolve_share_link(raw_token text)` — `SECURITY DEFINER`
  — hashes the input, looks up an `active` (`revoked=false AND expires_at > now()`) row, and
  returns **only the single scoped entity** (`view` vs `view_comment`). It bypasses membership
  by design (link recipients are not members) but is strictly bounded to that one entity + scope,
  never returns `token_hash`/other rows, and logs a bounded `error_code` (`share_expired`,
  `share_revoked`, `share_not_found`) — never the token. `view_comment` links may create a
  `comment` attributed to a system/anon actor within that entity only.

All new `SECURITY DEFINER` functions follow Core hardening: `search_path=''`, fully
schema-qualified, `execute` revoked from `public`/`anon`, granted only where intended
(`authenticated` for member RPCs; `service_role` for worker paths) — covered by Core's
`definer-audit` CI gate.

## Surfaces & frontend

- **Auto-generated (codegen).** `comment`, `mention`, `reaction`, `saved_item`, `share_link`
  each get GraphQL types + queries/mutations, MCP tools, CLI commands (`movp comment create …`),
  TS types/Zod, FTS (`comment.body`, `saved_item.note`), and semantic chunks
  (`comment.body` embeddable → `search_chunk`). Agents can post/react/save and read the Inbox
  over MCP out of the box.
- **Hand-added RPCs surfaced via GraphQL/MCP:** `inbox_feed`, `resolve_share_link`,
  `can_access_entity` (internal), plus `share_link.create` returning the one-time raw token.
- **Frontend (Astro on CF + R2, generated GraphQL client only — Core boundary rule: no
  `@movp/auth`/`@movp/domain`/service-role imports in the template).** Reusable islands:
  `<CommentThread entityType entityId>` (compose, reply, react, resolve mentions), a reaction
  bar, a save toggle, a share dialog (shows the raw token once), and the **Inbox** view with
  tabs All Updates / Mentions / Saved Items / Assigned Items over `inbox_feed`. a11y: composer
  and reaction buttons keyboard-operable, tabs use `role="tablist"` + arrow-key roving focus,
  live-region announces new items; empty/loading/error+retry states required (Assigned Items
  shows an explicit "available when Task ships" empty state, not an error).

## Dependencies

- **Core (Phase 1), consumed:** `defineCollection` + codegen (DB/RLS/FTS/GraphQL/MCP/CLI/types);
  the `edges` graph; `public.emit_event` → `movp_events` + `movp_jobs` (`notify`/`webhook`) +
  webhooks registry; `@movp/notifications` (Resend) + `runFlowsWorker`; `is_workspace_member`
  RLS + `resolvePrincipal` auth; the Astro template + boundary/`definer-audit`/`redaction` CI.
- **Core extensions this phase adds (seams, not new infra):** (1) generalized event-keyed
  recipient resolution in `runFlowsWorker` (replaces owner-only placeholder); (2)
  `can_access_entity` dispatcher + per-domain registration seam; (3) member-safe DEFINER read
  RPCs `inbox_feed` + `resolve_share_link` over the internal log/token store; (4) tightened RLS
  migration (author-scoped writes, recipient/entity-scoped reads) on the five collections.
  (`public.traverse_edges` is **consumed** from Core Phase 1, not added here.)
- **Task (Phase 3), forward seam:** the `assigned` Inbox tab + `comment`/entity assignee &
  observer recipient resolution + Task's `can_access_entity` predicate land with Task. Phase 2
  ships the seams inert (empty Assigned tab; workspace-member default visibility).
- **Downstream:** Task, CMS, and Campaigns all attach comments/reactions/saves/tags via these
  polymorphic collections — no per-domain social tables.

## Verification sketch

1. **Codegen/migration.** Five collections + tightened-RLS migration + trigger/RPC migration
   apply clean; `supabase db diff` empty; `movp_fields` rows present (polymorphic dims,
   `comment.body` searchable+embeddable).
2. **Polymorphic attach.** Create a Core `note`; post a `comment` with
   `entity_type='note', entity_id=<note>`; reply → second comment; `@mention` a member in the
   body → one `mention` row (unknown handle dropped).
3. **Events.** Assert exactly one `movp_events` row + one `notify` job per action for
   `comment.added`, `comment.replied`, `user.mentioned`, `item.liked`, `item.disliked`,
   `item.saved`, `item.shared`; idempotency key uses `payload->>'id'`; a registered webhook for
   `comment.added` gets one `webhook` job.
4. **RLS.** A non-member sees 0 comments/reactions; with `can_access_entity` stubbed false for
   an entity, a member sees 0 comments on it (entity-gate proof); a user sees only their own
   `saved_item`/`mention` rows; a member cannot INSERT a comment with a foreign `actor_id`.
5. **Share link.** `resolve_share_link(valid)` returns the scoped entity; expired/revoked/wrong
   token → bounded `error_code`, no entity; grep proves the **raw token is never stored or
   logged** (only `token_hash`).
6. **Inbox.** `inbox_feed(ws,'mentions')` returns the caller's mentions only;
   `('saved')` the caller's saves; `('all')` excludes cross-tenant and inaccessible-entity
   events; `('assigned')` returns an **empty** list (Task seam) — asserted empty, not error;
   a non-member call fails closed with an empty feed.
7. **Notifications.** `user.mentioned` emails the *mentioned* user (not the workspace owner),
   `escapeHtml` applied; recipient resolution is event-keyed.
8. **Observability.** Each seeded failure (RLS denial, share-expired, mention-resolve failure)
   emits exactly one `trace_id`-correlated event with bounded `error_code`, no body/PII.

## When built

**Phase 2**, immediately after Core and **before Task (Phase 3)** — so the polymorphic social
primitives exist before any domain needs them. It blocks the social features of Task, CMS, and
Campaigns. The forward seams (Assigned Items tab, Task/CMS/Campaign `can_access_entity`
predicates, assignee/observer recipient resolution) are completed as each of those phases
lands; Phase 2 ships them inert with a workspace-member default so nothing is half-wired.
