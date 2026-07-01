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

> **The remaining app phases** (`app-01` Task, `app-02` CMS, `app-03` Campaigns, `app-04`
> Segmentation, `app-06` Domain Workflows) are still ROADMAP/design altitude — each must be
> **expanded into a bite-sized TDD series** (as Core Phase 1 and Collaboration were) before
> code is written.

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
