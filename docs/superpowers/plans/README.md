# MOVP Suite — Implementation Plans (Codex execution entry point)

Read this first. It tells a fresh executor (Codex, or any agent without the design
conversation) **what to build, in what order, and how**. The plans are authored to be
copy-paste-correct: transcribe the code samples verbatim and follow the gates.

## Prerequisites (verify before Task 1)

- **Docker** running (the local Supabase stack needs it).
- **Node ≥ 20**, **pnpm ≥ 9**, **Supabase CLI**, **Deno** (bundled with the Supabase CLI for
  edge functions), and **wrangler** (frontend, Phase-1 Plan 6 only).
- Repo root: `/Users/ensell/Code/supasuite` — currently empty. **Core Plan 1, Task 1**
  runs `git init` + scaffolds the monorepo + `supabase init`. Do not pre-create files.
- Env: the local stack provides `SUPABASE_URL` / anon / service-role via `supabase status`.
  `RESEND_API_KEY` (test mode) is needed only for the notify path (Core Plan 5). **No secrets
  are committed** — the cron wiring uses Supabase Vault (Core Plan 5, deploy-time doc).

## Build order (authoritative)

**Stage A — MOVP Core, Phase 1 (bite-sized TDD; execute task-by-task, in this order):**
1. `2026-06-30-movp-core-foundation.md` — scaffold, tenancy, `@movp/auth`
2. `2026-06-30-movp-core-02-schema-codegen.md` — DSL + codegen → first migration
3. `2026-06-30-movp-core-03-domain.md` — `@movp/domain` (CRUD/search/graph)
4. `2026-06-30-movp-core-04-api-surfaces.md` — GraphQL, MCP, CLI, obs
5. `2026-06-30-movp-core-05-search-async.md` — embeddings, jobs, flows, notifications
6. `2026-06-30-movp-core-06-frontend-ci.md` — Astro template + all CI gates

> **Stage A status:** executed and committed (`main` up to `2e6327d`). The DSL/codegen
> contract is app-ready (`f.json`/`f.date`, `many-to-one` FK emission, `movp_job_kind`
> registry, `CollectionDef.internal`).

**Stage B — Application phases** (see `2026-06-30-movp-app-roadmap.md` for sequence &
dependencies). Build order: Collaboration (`app-05`) → Task (`app-01`) → CMS (`app-02`) →
Campaigns (`app-03`) → Segmentation (`app-04`) → Domain Workflows (`app-06`).

**Phase 2 — Collaboration is EXPANDED and EXECUTABLE** (bite-sized TDD, committed
`31cceed`/`09a75a5`; passed adversarial review at 9.31). Execute **in order**:
1. `2026-07-01-movp-app-05a-collaboration-data.md` — the 5 collab collections (config-first,
   `internal: true`), `can_access_entity` (fail-closed), fine-grained RLS + lifecycle triggers
   (migration `…000006`). Adds `CollectionDef.internal` to `@movp/core-schema`.
2. `2026-07-01-movp-app-05b-collaboration-services.md` — `makeCollabService`, `inbox_feed` /
   `resolve_share_link` + atomic `create_comment_with_mentions` RPCs (migration `…000007`),
   single-recipient notify fan-out, and GraphQL/MCP/CLI custom surfaces (generic CRUD for the
   `internal` collab collections is suppressed). **Precondition: 05a merged first.**

**Phase 3 — Task (`app-01`) is EXPANDED and EXECUTABLE** (bite-sized TDD, three parts; hardened
across five adversarial-review rounds — child-row schema consistency, RLS delete/tenant policies,
`task_revision` workspace-scoping, and detail-page scoping). **Precondition: Collaboration (05a + 05b)
merged first** — Task reuses the `collab` service for discussion and extends `can_access_entity` +
`inbox_feed`. Execute **in order**:
1. `2026-07-01-movp-app-01a-task-data.md` — 9 config-first collections (`task` + per-workspace
   `task_status_option`/`task_priority_option` + `task_revision` + assignment/observer/dependency/
   status_history/attachment), FK relations (`status_id`/`priority_id`/`parent_id`), the
   `can_access_entity('task')` arm, fine-grained RLS (immutable revisions, append-only history,
   membership- + same-workspace-gated child rows, no-DELETE option tables), and a default-option
   seeding trigger (migration `…000008`).
2. `2026-07-01-movp-app-01b-task-lifecycle.md` — category-keyed status transitions
   (`completed`/`reopened`/`status_changed` + history), `task.*` event triggers, `dependency_blocked`
   recompute, `emit_due_soon()`, an `emit_event` notify-guard, per-recipient notify fan-out, and the
   `inbox_feed` `assigned` tab (migration `…000009`). **Precondition: 01a merged.**
3. `2026-07-01-movp-app-01c-task-services.md` — `create_task_with_revision` /
   `update_task_description` INVOKER RPCs (migration `…000010`), `makeTaskService` + the two generic
   option-table services wired into `createDomain`, a `comments` read query, GraphQL/MCP/CLI custom
   task surfaces, the Astro board/list/detail + inbox Assigned tab, and the e2e slice. **Precondition:
   01a + 01b merged.**

**Phase 4 — CMS & Content Workflows (`app-02`) is EXPANDED and EXECUTABLE** (bite-sized TDD, four parts;
hardened across six adversarial-review rounds — surface↔service contract reconciliation, scheduler/publish
unification, factory-style stable errors, asset auth-before-read + presigned R2, and MCP/CLI asset-ctx
wiring). **Precondition: Collaboration (05a + 05b) + Task (01a–01c) merged first** — CMS reuses the `collab`
comment ops on `content_item`, extends `can_access_entity` + `search_fts`, and links editorial tasks via
`edges`. Its hand-authored migrations start at `…000011` (after Task's `…000008–000010`). Execute **in order**:
1. `2026-07-01-movp-app-02a-cms-model-versioning.md` — `content_type` (+ JSON field-schema), `content_item`,
   immutable `content_revision` + the three revision pointers, and the **domain-computed canonical
   `content_hash`** create/update INVOKER RPCs (migrations `…000011/000012`); adds `can_access_entity('content_item')`
   + the `content_item` `search_fts` arm. ALL CMS collections are `internal: true`.
2. `2026-07-01-movp-app-02b-cms-approval-publish.md` — `content_approval`/`_vote`/`content_publish_event`
   state machine (single/multi), `has_content_capability` RLS gate, the 8 `content.*` lifecycle triggers +
   demote-on-edit, and **HMAC-signed publish webhooks** (adds signing to the flows worker) (migrations
   `…000013/000014`). **Precondition: 02a merged.**
3. `2026-07-01-movp-app-02c-cms-scheduling-assets.md` — `content_schedule` + pg_cron scheduler worker
   (publishes the PINNED revision), presigned-R2 `asset` upload (auth-before-read, checked writes,
   `DomainCtx.accessToken`/`assetsFnUrl`), published-only curation, and the advisory SEO audit (migrations
   `…000015/000016`). **Precondition: 02a + 02b merged.**
4. `2026-07-01-movp-app-02d-cms-surfaces-frontend.md` — the GraphQL/MCP/CLI custom content ops (including the
   concrete asset-ctx wiring across all three surfaces), the field-schema-driven Astro editor, revision diff,
   approval queue, editorial calendar, and the `[content]` e2e slice. **No new migration.** **Precondition:
   02a–02c merged.**

> **The remaining app phases** (`app-03` Campaigns, `app-04` Segmentation, `app-06` Domain Workflows) are
> still ROADMAP/design altitude — each must be **expanded into a bite-sized TDD series** (as Core Phase 1,
> Collaboration, Task, and CMS were) before code is written.

## Per-task execution protocol

For every `### Task N` (Stage A **and** the Collaboration `05a`/`05b` series):
1. Read **Files** and **Interfaces** (the exact signatures neighboring tasks rely on).
2. Follow the `- [ ]` steps in order — the TDD cycle is deliberate:
   write the failing test → run it, confirm the **stated expected failure** → paste the
   implementation exactly → run, confirm PASS → run the task's **gate** → **commit**.
3. **Copy code samples verbatim.** They compile/typecheck as written.
4. **Obey the inline gotchas** (comments inside samples). The load-bearing ones:
   - `@movp/*` packages use **bare specifiers** and **explicit `.ts` extensions** on relative
     imports (`moduleResolution: bundler`, `allowImportingTsExtensions`).
   - Deno **edge functions** read env via `Deno.env.get`, map deps in `deno.json`, use
     `WebStandardStreamableHTTPServerTransport` for MCP, and construct `GteSmallProvider` there.
   - Per-request deps (RLS-bound client, principal, embedder) are resolved **at call time**,
     never module scope.
   - `SECURITY DEFINER` functions are `set search_path = ''` + schema-qualified + least-priv.
   - `movp_internal` is reached **only** through `public` SECURITY DEFINER RPCs (service-role).
5. **Never skip a gate.** `supabase db diff` must be empty; `pnpm --filter … test` green; the
   CI gates (`boundary`, `definer-audit`, `redaction`, `vector-scale`, `jobs`,
   `internal-access`, `graphql-shape`, `frontend-ux`, `slice-e2e`) fail loudly on violations.

## Invariants to preserve (do not "improve" these away)

- **Tenancy:** every collection is `workspaceScoped`; RLS authorizes via `is_workspace_member`.
- **Config-first single source of truth:** DB/GraphQL/MCP/CLI/types are codegen'd from
  `@movp/core-schema` — never hand-edit generated artifacts.
- **DSL/relation contract (amended):** `many-to-one`/`one-to-one` relations → `<field>_id` FK;
  `many-to-many` → `edges`; user refs → `f.uuid` (not `relation('user')`); `f.json`→`jsonb`,
  `f.date`→`date`; new job kinds → a row in `movp_internal.movp_job_kind` (no CHECK edits).
- **Durable jobs:** idempotent (`content_hash` / unique keys), crash-safe lease + reclaim, DLQ,
  replay. **Observability:** field names/codes, never values or PII.

## Source-of-truth context (read for "why", not required to execute)

- North-star architecture + Phase-1 design & decisions:
  `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`
- Application roadmap (phase sequence, conventions, domain-event registry):
  `2026-06-30-movp-app-roadmap.md`

## Status

Core Phase 1 has passed adversarial review at ≥ 9.2 across all eight dimensions; the DSL/codegen
contract was extended (json/date field types, `many-to-one` FK emission, extensible job-kind
registry, user-ref convention) so the Stage-B application phases build cleanly on it.
