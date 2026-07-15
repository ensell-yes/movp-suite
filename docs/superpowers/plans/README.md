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

> **Stage B EXECUTION STATUS (authoritative — update this table when a part lands; a phase is
> DONE only when every part in its list below is executed):**
>
> | Phase | Parts executed | Status |
> |---|---|---|
> | Collaboration (`app-05`) | 05a–05b | ✅ EXECUTED (reviewed ≥9.2) |
> | Task (`app-01`) | 01a–01c | ✅ EXECUTED (reviewed ≥9.2) |
> | CMS (`app-02`) | 02a–02d | ✅ EXECUTED (reviewed 9.2; `ca10b09`) |
> | Campaigns (`app-03`) | 03a–03c | ✅ EXECUTED (reviewed 9.2; merged `7d4883f`, PR #1) |
> | Segmentation (`app-04`) | 04a–04d | ✅ EXECUTED (04a hardened; 04b ingestion; 04c recompute+injection-safe compiler 28/28; 04d surfaces/frontend/BI/e2e — all gates green, `slice-e2e: PASS`; merged PR #2, `f5f3a36`) |
> | Domain Workflows (`app-06`) | 06a–06d | ✅ EXECUTED (06a catalog/event spine merged PR #3 `c96282a`; 06b automation engine merged PR #4 `0316279`; 06c webhook management merged PR #5 `ab34575`; 06d admin surfaces + `[workflows]` slice merged PR #6 `72ae592`) |

**Stage C — OSS Release & Capability Expansion (post-app-06 epoch).** Roadmap
`2026-07-07-movp-stage-c-oss-roadmap.md` (8 phases C1–C8; reviewed 9.25) + TDD breakdown
`2026-07-07-movp-stage-c-tdd-breakdown.md` (56 tasks; reviewed 9.24). Build order: C1 first;
C2 & C3 in parallel after C1; C4←C2; C5←C3; C6←C1; C7←C1; C8←C3. Expand each phase into a
bite-sized TDD plan (as C1 was) before building.

> **Stage C EXECUTION STATUS (authoritative — update when a phase lands):**
>
> | Phase | Plan | Status |
> |---|---|---|
> | C1 OSS Packaging & Onboarding | `2026-07-07-movp-stage-c-01-oss-packaging-onboarding.md` | ✅ MERGED (PR #8 `7f65eff`, reviewed 9.2) |
> | C2 Admin Console & Operations | `2026-07-08-movp-stage-c-02-admin-console.md` | ✅ MERGED (PR #9 `004326b` + follow-up `7b51e28`, reviewed 9.26) |
> | C3 Agent Connectivity (PATs/MCP/CLI) | `2026-07-09-movp-stage-c-03{a,b,c,d}-*.md` (+ design spec) | ✅ EXECUTED (C3a PAT foundation; C3b CLI parity; C3c MCP matrix + `@movp/mcp-bridge` + docs; C3d `[agents]` slice; local full gate + PR #11 CI green incl. `slice-e2e: PASS`) |
> | C4 Reporting Views & Dashboards | `2026-07-11-movp-stage-c-04{a,b,c}-*.md` | ✅ EXECUTED (`169757e`…`14b27b8`; 666 pgTAP assertions / 33 files; local `slice-e2e: PASS`; reviewed 9.30) |
> | C5 Integration Fabric | `2026-07-11-movp-stage-c-05{a,b,c}-*.md` (+ design spec) | ✅ EXECUTED (C5a delta-owned external records + idempotent ingest; C5b PostgREST RLS audit/docs; C5c CRM worker/templates/integration slice; 719 pgTAP assertions, direct HTTP/edge integration checks) |
> | C6 Templates & Scaffolding | `2026-07-12-movp-stage-c-06{a,b,c,d,e,f}-*.md` (+ design/interfaces) | ✅ C6a–C6f EXECUTED (platform/composition + schema injection/runtime guard + immutable project codegen/manifest/live consistency + safe `create-movp` scaffolder + CRM-lite/marketing/support/knowledge-base gallery + four-way Verdaccio real-runtime matrix + Starlight docs and generated DSL reference) |
> | C7 Inline Editing & Delivery | breakdown only | ⬜ expand before build (needs C1) |
> | C8 Retrieval & RAG | breakdown only | ⬜ expand before build (needs C3) |

**Phase C2 — Admin Console is EXPANDED and EXECUTABLE** (bite-sized TDD; precondition: C1
merged ✅). Execute `2026-07-08-movp-stage-c-02-admin-console.md` **in order** C2.1→C2.7:
one commit per task, TDD (failing test first), all repo gates + the `[admin]` slice green,
review ≥9.2 per part. Key correction vs the breakdown prose: `workspace_membership.role`
(`owner`/`admin`/`member`) already exists — C2.1 adds an `is_workspace_admin()` helper +
enforcement, not the column.

**Phase C3 — Agent Connectivity is EXPANDED and EXECUTABLE** (bite-sized TDD, four parts;
precondition: C1 merged ✅). Design spec:
`docs/superpowers/specs/2026-07-09-movp-stage-c-03-agent-connectivity-design.md` (reviewed 9.26).
Execute **in order** C3a→C3b→C3c→C3d: **C3a** PAT foundation — spike-first RLS proof, the
`movp_internal.personal_access_token` table + lifecycle RPCs, the `packages/auth` GoTrue
`generateLink`→`verifyOtp({type:'email'})` exchange, the `resolvePrincipal` `movp_pat_` branch,
the `auth-exchange` edge fn, GraphQL PAT surfaces, and the self-service web `/settings/tokens`
page → **C3b** CLI `init`/`login`/`logout` + PAT credential mode + keychain/`0600` secure store
(`MOVP_SECURE_STORE=file` override) + `--mode hybrid` via the GraphQL edge → **C3c** MCP HTTP
client matrix (Claude Code/Codex/Cursor/Gemini CLI/Copilot) + config-lint + `mcp-remote@0.1.38`
stdio bridge + agent docs → **C3d** the `[agents]` end-to-end slice + CI. One commit per task,
TDD (failing test first), all repo gates + the new `[agents]` slice green, review ≥9.2 per part.
**Key design decision (vs the breakdown prose): PATs are USER-SCOPED** — a PAT resolves to an
ordinary GoTrue user session so every RLS policy/RPC is reused unchanged; `default_workspace_id`
is a CLI home hint, **not** an access boundary. The C3.1 gate was amended accordingly (see the
spec's F1 resolution), and C3.1 stays a real fail-first spike that proves the exchange
end-to-end before C3b–C3d rely on it.

**Phase C4 — Reporting Views & Dashboards is EXECUTED** (bite-sized TDD, three parts;
commits `169757e`…`14b27b8`; local full gate and `slice-e2e: PASS`). Implemented in order
C4a→C4b→C4c:
**C4a** (`2026-07-11-movp-stage-c-04a-reporting-codegen.md`) the generated-delta codegen
strategy — a frozen-baseline drift guard + `GENERATED_DELTAS` registry in `generate.ts` —
then the reporting view emitter (26 `reporting.v_<collection>` security-invoker views,
FK join keys always included), the `20260711000001_movp_generated_reporting.sql` delta,
and pgTAP (structural totality over all 26 generated views + W1-leak checks across every
workspace-scoped reporting view) →
**C4b** (`…04b-reporting-analytics.md`) the hand-authored `reporting.v_task_cycle`, six
member-gated INVOKER dashboard RPCs, two SECURITY DEFINER `movp_internal` daily-count
RPCs (counts + bounded classifiers only, redaction pinned by value), `makeReportingService`
in `@movp/domain`, and eight typed GraphQL reads wired into the `graphql-shape` gate →
**C4c** (`…04c-reporting-dashboards-bi.md`) the `/admin/reports` page (zero-dependency
SVG/table charts, `auth|error|empty|ok` states, Playwright + axe) and the external BI
seam (`reporting.setup_bi_mirror()` inert operator mirror + grants-audit pgTAP +
`docs/reporting.md`). One commit per task, TDD (failing test first), all repo gates
green, implementation review 9.30. **Key design decisions (vs the breakdown prose):** dashboard
reads are RPCs, never PostgREST view reads (the `reporting` schema is not API-exposed);
`task` carries no reporting metadata by design — adding it would rewrite the frozen
generated baseline, so its dashboard reads a hand-authored view; an external BI role
cannot use security-invoker views (no grants, no JWT claims), so the BI seam is an
operator-invoked `reporting_bi` mirror that deliberately bypasses RLS, granted to no app
role, and pinned by a pgTAP grants audit. The target stack disproved the initial nested-view
owner assumption, so the final mirror copies each reporting view's resolved, explicitly
projected SQL into an owner view; the unchanged cross-workspace assertion proves the fallback.

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

**Phase 5 — Marketing Planning & Campaigns (`app-03`) is EXPANDED and EXECUTABLE** (bite-sized TDD, three
parts; a REUSE-heavy marketing layer, hardened across three parallel adversarial-review rounds + a graph-write
boundary pass). A `campaign_deliverable` is a THIN wrapper that links to a MOVP **Task** via an `implemented_by`
edge (no schedule/status/assignee columns of its own — a no-duplication schema gate enforces this), its content
is a CMS `content_item` via a `produces` edge, and stakeholder threads reuse Collaboration. **Precondition:
Task (01a–01c) + CMS (02a–02d) merged first** (Campaigns bridges Task's `task.*` events, reuses the Task board,
and links CMS content). Its hand-authored migrations start at `…000017` (after CMS's `…000016`). Execute **in order**:
1. `2026-07-01-movp-app-03a-campaigns-data.md` — seven config-first (generically-surfaced) collections
   (`marketing_plan`, `campaign`, `campaign_channel`, `campaign_deliverable`, `campaign_calendar_event`,
   `campaign_metric` [the `value`=measure fact table], `campaign_segment` [dormant Phase-6 targeting seam]),
   the `campaign.created`/`deliverable.created` audit triggers, owner-restricted edit-gating RLS, and the
   no-duplication gate (migration `…000017`).
2. `2026-07-01-movp-app-03b-campaigns-bridge-scans.md` — the `deliverable↔task` event **bridge** (DB triggers
   on Task's own tables + a reverse `edges` lookup, since no event-subscription engine exists and `traverse_edges`
   is forward-only), the `scan_campaigns()` date-scan (campaign started/ended + `deliverable.due_soon`), and the
   `campaign` domain service (edge links with a validated graph-write boundary + batched `deliverableSchedules`)
   (migration `…000018`). **Precondition: 03a merged.**
3. `2026-07-01-movp-app-03c-campaigns-surfaces-frontend.md` — codegen-generic surfaces + the custom
   `campaignDetail`/`deliverableSchedules` reads, five Astro templates (the deliverable board **reuses the Task
   board**), reporting star-schema verification, and the `[campaigns]` e2e slice. **No new migration.**
   **Precondition: 03a + 03b merged.**

**Phase 6 — Segmentation & Lifecycle Events (`app-04`) is EXPANDED and EXECUTABLE** (bite-sized TDD, four parts;
the suite's BI/ML consumer, hardened across three parallel adversarial-review rounds — including a
SQL-injection audit of the predicate compiler and a full write-path/schema-fixture reconciliation). A typed
`platform_event` stream feeds audience `segment`s defined by a **parameterized predicate-DSL** (compiled to
set-based SQL via `format('%L'/%I')`, never string-concatenation), with idempotent recompute on the shared
`movp_jobs` engine and explainable membership. **Precondition: Campaigns (03a–03c) merged first** (+ the whole
Core→Collaboration→Task→CMS→Campaigns chain); its hand-authored migrations start at `…000019`. Execute **in order**:
1. `2026-07-01-movp-app-04a-segmentation-data-bridge.md` — seven config-first (generically-surfaced) collections
   (`platform_event` [append-only fact], `segment`, `segment_rule`, `segment_membership`, `segment_snapshot`,
   `segment_snapshot_member`, `segment_recompute_run`), `platform_event` composite indexes + immutability guard,
   and the **internal event bridge** (`AFTER INSERT` on `movp_events` → `platform_event`, guarded so a bad payload
   can't abort the emitting business write) (migration `…000019`).
2. `2026-07-01-movp-app-04b-segmentation-ingestion.md` — **external ingestion** (`functions/ingest`: JWT + hashed
   API-key paths, the `ingest_key` registry, the workspace-resolving `ingest_platform_event` RPC, bounded/dropped
   untrusted input) (migration `…000020`). **Precondition: 04a merged.**
3. `2026-07-01-movp-app-04c-segmentation-recompute.md` — the **evaluation/recompute engine**: the injection-safe
   predicate compiler + `segment_match_subjects`, the `segment_recompute` job kind + incremental-enqueue trigger,
   the atomic `recompute_segment` RPC (diff → deterministic events → audit run, advisory-locked) + worker, and
   snapshots (migration `…000021`). **Precondition: 04a + 04b merged.**
4. `2026-07-01-movp-app-04d-segmentation-surfaces-frontend.md` — codegen-generic surfaces + custom reads
   (`previewMatchingCount` reusing the safe compiler, `segmentMembershipExplained`, `snapshotDiff`), four Astro
   templates (island→`/api` pattern), BI/ML metadata verification, and the `[segmentation]` e2e slice.
   **No codegen migration** — adds one tiny read RPC (`preview_segment_predicate`) only if Part C didn't
   already expose it. **Precondition: 04a–04c merged.** (The `campaign→segment` audience seam is DEFERRED to a
   future campaign-targeting flow.)

**Phase 7 - Domain Workflows & Webhooks (`app-06`) is EXPANDED and EXECUTABLE** (bite-sized TDD,
four parts; the orchestration layer over every prior phase's emitted events). It consumes Core's
`emit_event`/`movp_events`/`movp_jobs`/`webhooks` backbone, Task/CMS/Campaign/Segmentation event
names, and Segmentation's `platform_event` stream as automation triggers. **Precondition:
Collaboration (05a-05b), Task (01a-01c), CMS (02a-02d), Campaigns (03a-03c), and Segmentation
(04a-04d) merged first.** Its hand-authored migrations start at `...000022` (after Segmentation's
`...000019-000021`). Execute **in order**:
1. `2026-07-03-movp-app-06a-workflows-catalog-guards.md` - codegen support for the global
   `event_type` catalog (`workspaceScoped:false` without member-RLS drift), `defineEvent` catalog
   seeding + `check-event-catalog`, the four workflow collections
   (`event_type`, `automation_rule`, `webhook_subscription`, `workflow_run`), the `automate` job kind,
   and the additive `emit_event` automate enqueue (migration `...000022`).
2. `2026-07-03-movp-app-06b-workflows-automation-engine.md` - the `automate` branch in the flows
   worker, the bounded in-worker condition evaluator, ledger-first exactly-once `workflow_run` action
   dispatch, loop guard, default rules, and the scoped `get_event(id, ws)` audit RPC (migration
   `...000023`). **Precondition: 06a merged.**
3. `2026-07-03-movp-app-06c-workflows-webhook-management.md` - hardened webhook-subscription RPCs
   (register/rotate/activate/deactivate/filter), public/internal 1:1 pairing reconciliation, direct
   write denial, secret discipline, and filter-before-fetch webhook delivery (migration `...000024`).
   **Precondition: 06a merged; 06b preferred for evaluator reuse.**
4. `2026-07-03-movp-app-06d-workflows-surfaces-frontend.md` - domain service wrappers,
   GraphQL/MCP/CLI custom workflow operations, Astro rule/webhook/audit admin pages, dead-job replay,
   and the `[workflows]` e2e slice. **No new migration.** **Precondition: 06a-06c merged.**

## Per-task execution protocol

For every `### Task N` (Stage A **and** every expanded application-series plan):
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

- **Tenancy:** every tenant-owned collection is `workspaceScoped`; RLS authorizes via
  `is_workspace_member`. The app-06 `event_type` catalog is the explicit global read-only exception.
- **Config-first single source of truth:** DB/GraphQL/MCP/CLI/types are codegen'd from
  `@movp/core-schema` — never hand-edit generated artifacts.
- **DSL/relation contract (amended):** `many-to-one`/`one-to-one` relations → `<field>_id` FK;
  `many-to-many` → `edges`; user refs → `f.uuid` (not `relation('user')`); `f.json`→`jsonb`,
  `f.date`→`date`; new job kinds → a row in `movp_internal.movp_job_kind` (no CHECK edits).
- **Durable jobs:** idempotent (`content_hash` / unique keys), crash-safe lease + reclaim, DLQ,
  replay. **Observability:** field names/codes, never values or PII.
- **Forward-only migrations:** every migration listed in `supabase/.forward-only-migration-baseline`
  is frozen. Add new timestamped migrations for production changes; do not edit merged migrations or
  regenerate `20260701000002_movp_generated.sql`.
- **Internal retention:** prune terminal `movp_jobs` and old `movp_events` through
  `public.prune_internal_retention(...)` on a deploy-time schedule. Failed/pending/running jobs are
  not pruned.
- **Full slice gate:** `bash scripts/slice-e2e.sh` is a CI gate and must stay green before a phase is
  called complete.

## Source-of-truth context (read for "why", not required to execute)

- North-star architecture + Phase-1 design & decisions:
  `/Users/ensell/.claude/plans/i-want-to-create-synchronous-dream.md`
- Application roadmap (phase sequence, conventions, domain-event registry):
  `2026-06-30-movp-app-roadmap.md`

## Status

Core Phase 1 has passed adversarial review at ≥ 9.2 across all eight dimensions; the DSL/codegen
contract was extended (json/date field types, `many-to-one` FK emission, extensible job-kind
registry, user-ref convention) so the Stage-B application phases build cleanly on it.
