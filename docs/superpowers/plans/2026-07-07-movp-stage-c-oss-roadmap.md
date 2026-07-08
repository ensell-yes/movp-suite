# MOVP Suite — Stage C Roadmap: Open-Source Release & Capability Expansion

> Roadmap-altitude plan (like `2026-06-30-movp-app-roadmap.md`), authored 2026-07-07 against
> the fully-executed Stage A + Stage B codebase (Core → Collaboration → Task → CMS →
> Campaigns → Segmentation → Workflows; all merged, reviewed ≥9.2, CI green, pgTAP 533/23).
> Each phase below MUST be expanded into a bite-sized TDD series (as Stages A/B were) before
> execution; nothing here is an implementation spec. All Stage A/B invariants carry forward:
> config-first codegen, workspace RLS everywhere, forward-only migrations from the freeze
> baseline, one durable `movp_jobs` queue, events spine via `emit_event`, adversarial review
> ≥9.2 per part.
>
> TDD task breakdown: `2026-07-07-movp-stage-c-tdd-breakdown.md`.

## Verified current state (what Stage C builds on — not aspiration)

| Capability | State (verified in code 2026-07-07) |
|---|---|
| Config-first DSL + codegen | `@movp/core-schema` (~50 collections) → SQL/RLS/FTS/embed-triggers/metadata + TS types; generic GraphQL/MCP/CLI surfaces per non-internal collection |
| MCP server | Streamable-HTTP edge function, JWT auth, generated `<collection>.create/get/list/search/link` + ~30 hand-written domain tools |
| CLI | `movp` (commander): generic CRUD + task/content/workflows/search/codegen/migrate; FTS-only search |
| Search / RAG substrate | pgvector 384-dim `search_chunk` (HNSW), gte-small embed worker, FTS, `fts\|semantic\|hybrid` in domain + GraphQL + MCP |
| Automation & webhooks | `automation_rule` engine (ledger-first, loop-guarded), HMAC-signed webhook delivery, event catalog, DLQ replay |
| Inbound integration | `ingest` edge fn: hashed-API-key or JWT `platform_event` ingestion, bounded + SQLSTATE-branched |
| SEO/AEO | `content_seo` + `auditSeo` heuristic (title/meta/canonical/alt/JSON-LD/AEO-answer/FAQ → 0–100 score) via MCP/CLI/domain |
| Frontend | One Astro/CF template: tasks board, CMS editor+approvals+calendar, campaigns, segments rule-builder, workflows admin, inbox, search |
| Reporting | Metadata only: `reporting.role` (dimension/measure) in `movp_fields`; `campaign_metric` fact table. **No views, no dashboards** |
| OSS packaging | **Absent**: no README, no LICENSE, no CONTRIBUTING, no login flow in template, no npm publishing, no public docs |

## Positioning (single authoritative statement)

MOVP Suite is an **agent-native, multi-tenant backend platform on Supabase**: define a
collection once and get the table, RLS, GraphQL, MCP tools, CLI commands, full-text +
semantic search, lifecycle events, and automation — for content (CMS), work (tasks),
marketing (campaigns/segments), and integrations (webhooks/ingest). The agent surface
(MCP/CLI generated from schema) is the differentiator vs Payload/Webflow/Framer/Drupal;
CMS feature parity is a supporting goal, not the headline.

## Phase overview (build order; filenames TBD at expansion)

| Order | Phase | Depends on | Size | Outcome |
|---|---|---|---|---|
| **C1** | OSS Packaging & Onboarding | — | M | A stranger can clone, license-check, bootstrap, log in, and run the suite locally |
| **C2** | Admin Console & Operations | C1 (login) | M | Workspace/member/API-key/jobs administration in the UI, backed by RLS-safe RPCs |
| **C3** | Agent Connectivity (MCP/CLI everywhere) | C1 (docs) | M | Claude Code, Codex, Cursor, Gemini CLI, Copilot each connect via documented, tested config; headless auth via PATs |
| **C4** | Reporting Views & Dashboards | C2 | M | Codegen-emitted reporting views from `reporting.role` metadata + prebuilt admin dashboards |
| **C5** | Integration Fabric (CRM/external apps) | C3 | S–M | Idempotent ingest, external-id upserts, PostgREST-as-REST docs, CRM/Zapier/n8n recipes |
| **C6** | Use-Case Templates & Scaffolding | C1 (C4/C5/C7/C8 enrich) | M | `create-movp` scaffolder + 4-template gallery, each agent-connected out of the box |
| **C7** | Inline Editing & Content Delivery | C1 | L | Embeddable Notion-style editor SDK, visual in-place editing, sitemap/JSON-LD/llms.txt delivery |
| **C8** | Retrieval & RAG Platform | C3 | M–L | Pluggable embedders, document→chunk ingestion, `rag.query` with citations, retrieval evals |

C2 and C3 can run in parallel after C1. C4/C5 after their dependencies; C6 can run after
C1 but its templates get richer when C4/C5/C7/C8 land. C7 and C8 are independent of each
other. Each phase = one plan doc → one bite-sized TDD series → review ≥9.2 → merge,
exactly as Stage B.

---

## C1 — OSS Packaging & Onboarding

**Goal:** the repo is legally and practically adoptable by an outsider.

**Why first:** every other phase's audience (external adopters) cannot exist until this one
lands. The template currently assumes an externally-set `sb-access-token` cookie — an
adopter literally cannot log in.

In scope (each load-bearing for "adoptable"):
1. **LICENSE** — recommend **Apache-2.0** (patent grant matters for a backend platform
   others build businesses on). ✅ DECIDED: Apache-2.0.
2. **Root README** — positioning, architecture diagram, the config-first loop (define →
   codegen → migrate → surfaces appear), quickstart, status badges. Root `CLAUDE.md`
   (fold in the existing `AGENTS.md` content, currently a regular file, then replace
   `AGENTS.md` with a relative symlink per the global convention).
3. **CONTRIBUTING.md + SECURITY.md** — the Stage A/B invariants (forward-only migrations,
   review gate, port isolation) restated for outsiders; vulnerability disclosure channel.
4. **Login flow in the Astro template** — Supabase Auth (email magic link + OAuth
   providers), sets the session cookie the template already reads. Removes the
   biggest onboarding cliff.
5. **Demo seed** — `pnpm seed:demo`: one workspace, members, sample tasks/content/campaign/
   segment/automation rule, so every page renders non-empty on first run.
6. **One-command bootstrap** — `pnpm bootstrap`: supabase start → db reset → seed → serve
   functions → template dev, with the port-isolation caveats handled (or documented) for
   non-64xxx machines. The default-port-vs-64xxx story is an explicit assumption below;
   do not "normalize" ports until C1 proves the override mechanism.
7. **Publishing decision** — packages currently ship raw `.ts` (`main: ./src/index.ts`).
   Add a build step (tsup/dual ESM) before npm publishing; do not publish source-only
   packages as v0. ✅ DECIDED: publish under `@movp` (maintainer already controls the
   npm org/scope; expansion should verify current npm CLI usage with `npm org --help`, then
   run `npm whoami` + `npm org ls movp` before the first publish and fail loudly if
   auth/scope access is wrong).
8. **Debt burn-down (small, known):** schedule `prune_internal_retention` (deploy doc +
   pg_cron snippet), fix the stale Segmentation row in plans README, fix plan-doc gate grep
   bugs, bump deprecated `checkout@v4`/`setup-cli@v1` Node-20 warnings.

Acceptance gates (mechanical): a new **quickstart CI job** on a clean runner: clone →
bootstrap → login e2e (Playwright) → slice-e2e PASS. `test -f LICENSE README.md
CONTRIBUTING.md SECURITY.md` in CI. Seed idempotence: run seed twice → row counts equal.

Deferred from C1: hosted demo instance, docs *site* (C1 ships README + in-repo docs;
Starlight site moves to C6 alongside templates), Discord/community infra.

## C2 — Admin Console & Operations

**Goal:** a workspace owner can administer the platform from the UI, not psql.

In scope:
1. **Workspace & membership admin** — create workspace, invite (email → pending membership),
   remove member, role management. Requires an **owner/admin role semantic** in RLS
   (today `is_workspace_member` is flat) — this is the RBAC seed: add `role` enforcement to
   admin-only RPCs, not a full permission matrix.
2. **Ingest API key management** — UI + member-gated RPCs to create/rotate/revoke hashed
   ingest keys (one-time secret display, same pattern as webhook secret rotation in 06c).
3. **Jobs & DLQ operations page** — movp_jobs status counts, dead-job list (redacted
   payload keys only, per obs discipline), replay button (extends the 06d
   `replay_workflow_jobs` pattern to other kinds via member-gated, workspace-scoped RPCs).
4. **Schema/collection browser** — read `movp_collections`/`movp_fields` and render a
   generic data grid + record editor for ANY non-internal collection (list/create/edit via
   the existing generic GraphQL). This is the Payload/Directus-parity move, and it is cheap
   because the metadata registry already exists.
5. **Settings page** — retention schedule status, webhook/event catalog links, workspace
   profile.

Acceptance gates: pgTAP positive+negative for every new admin RPC (member vs non-member vs
non-admin); Playwright admin e2e (invite→accept→demote); boundary grep (admin pages import
no server-only modules into islands).

Deferred: fine-grained field-level permissions (future RBAC phase), SSO org-mapping UI,
audit-log browsing UI (surface exists in events; a viewer is C4's event analytics).

## C3 — Agent Connectivity

**Goal:** Claude Code, Codex CLI, Cursor, Gemini CLI, and GitHub Copilot each connect to a
MOVP instance through a documented, CI-verified path; headless agents authenticate without
a browser.

In scope:
1. **Personal Access Tokens (PATs)** — hashed token table (reuse the ingest-key hashing
   pattern), workspace-scoped, expiring, revocable (C2 UI); `resolvePrincipal` extended to
   accept `movp_pat_…` bearer tokens through a C3 Task-1 spike that proves an RLS-bound
   principal end-to-end. Do not assume an edge function can mint a Supabase-verifiable JWT:
   the mechanism is an explicit external assumption below. This is the load-bearing item:
   JWT-only auth today means every agent needs a fresh browser session.
2. **Client setup matrix (docs + verified configs)** — one page per client with the exact
   registration command/file, kept honest by CI:
   - Claude Code: `claude mcp add --transport http movp <url>` + `.mcp.json` sample
   - Cursor: `.cursor/mcp.json`; Codex: `~/.codex/config.toml` `mcp_servers`
   - Gemini CLI: `settings.json` `mcpServers`; VS Code Copilot: `.vscode/mcp.json`
   ⚠ External assumption: client config schemas drift. Check: CI smoke exercises the MCP
   protocol (initialize / tools-list / tool-call) over HTTP and over the stdio bridge;
   per-client config files are linted against their current documented schema at expansion
   time, and the docs page carries a "verified against client version X" line.
3. **stdio bridge** — thin `@movp/mcp-bridge` (or documented `mcp-remote` usage — prefer
   the existing community bridge over new code if it passes the smoke; ✅ DECIDED:
   reuse community `mcp-remote` first, fallback to `@movp/mcp-bridge` only if the
   smoke fails) for clients that don't speak streamable HTTP with Bearer headers.
4. **CLI parity + login** — `movp login` (device-style flow storing PAT via OS keychain),
   semantic/hybrid search in the CLI (route through GraphQL like MCP does), `movp init`
   pointing at a remote instance.
5. **Agent-facing docs** — `llms.txt` + a consumer-side `AGENTS.md` template ("how to drive
   MOVP from an agent": tool naming scheme, workspace_id convention, error codes), and a
   Claude Code plugin/skill packaging the CLI+MCP usage patterns.

Acceptance gates: MCP protocol smoke in CI (HTTP + bridge); PAT pgTAP
(valid/expired/revoked/wrong-workspace, positive+negative); PAT auth-rejection paths emit
structured, keys-only observability events; `movp login` + authenticated `movp task list`
integration test; docs-config lint job.

Deferred: full OAuth 2.1 authorization-server metadata for the MCP spec's dynamic-client
flow (PATs cover the five named clients; revisit when a hosted multi-user MCP registry
matters); marketplace listings.

## C4 — Reporting Views & Dashboards

**Goal:** the `reporting.role` metadata that every collection already carries becomes
queryable views and visible dashboards.

In scope:
1. **Codegen: emit reporting views** — for each collection with reporting metadata, emit a
   `reporting.v_<collection>` **security-invoker** view (RLS still binds) selecting
   dimensions + measures + timestamps. Event analytics are different because
   `movp_events` lives in `movp_internal`: expose workspace-scoped counts by type/day via
   member-gated, redacted RPCs only, not security-invoker views over internal tables. New
   migration(s), additive only.
2. **Admin dashboards** (in the C2 console shell): task throughput & cycle time; content
   pipeline funnel (draft→approved→published); campaign metrics (`campaign_metric` fact);
   segment growth (snapshots over time); workflow run health (success/fail/dead + replay
   link); ingestion volume. Charts as Astro/React islands over the new views.
3. **External BI seam** — documented read-only Postgres role recipe scoped to the
   `reporting` schema + a Metabase/Cube quickstart doc. No BI tool is bundled.

Acceptance gates: codegen view-emission unit tests (golden SQL); pgTAP on every view and
every event-analytics RPC (member sees own workspace only - positive+negative); dashboard
Playwright with seeded data asserting non-empty charts.

Deferred: custom dashboard builder, scheduled email reports (an `automation_rule` action
later), materialized-view refresh infra (start with plain views; add matviews only when a
measured query is slow — performance evidence first).

## C5 — Integration Fabric (CRM & external apps)

**Goal:** a pre-existing CRM or custom app can sync bidirectionally without reading source.

In scope:
1. **Idempotent ingest** — optional `idempotency_key` on `platform_event` ingestion
   (unique per workspace, dedupe window); derived over the effective submitted payload per
   the idempotency rule.
2. **External identity convention** — `external_ref` (`source` + `external_id`) field
   pattern + a generic `upsert_by_external_ref` RPC so CRM records map stably onto MOVP
   entities; documented as the DSL convention for integration collections.
3. **REST story = PostgREST** — Supabase already exposes PostgREST over the same
   RLS-guarded tables; document it as the REST facade (with the caveat that custom ops
   remain GraphQL/RPC) instead of building a new REST layer. ⚠ Check at expansion: confirm
   PostgREST surface respects the same policies for internal:true tables (they must stay
   unexposed — likely needs the schema/grants audit as a gate).
4. **Recipes** — HubSpot/Salesforce/Attio patterns (outbound: webhook_subscription →
   transformer worker → CRM API; inbound: CRM webhook → `ingest`), Zapier/n8n templates,
   plus a generic "sync worker" example repo/dir using PATs + the CLI.

Acceptance gates: pgTAP idempotency (same key twice → one event, different payload+same
key → conflict); upsert-by-external-ref positive+negative; a grants/exposure audit test
proving `internal:true` and `movp_internal` are not reachable via PostgREST anon/member
roles; idempotency-conflict paths emit structured, keys-only observability events; one
recipe smoke script in CI (mock CRM endpoint).

Deferred: bundled connector runtime/marketplace, field-mapping UI, CDC/logical-replication
streaming (document as future; ingest + webhooks suffice for v1 sync).

## C6 — Use-Case Templates & Scaffolding

**Goal:** `pnpm create movp` (or `npx create-movp`) scaffolds a working, agent-connected
product in minutes; a gallery proves breadth.

In scope:
1. **`create-movp` scaffolder** — prompts for template + project name; emits a project with
   its own `core-schema` collection files, runs codegen, prints the bootstrap steps.
2. **Template gallery v1 (4):**
   - **Marketing site + blog** — CMS + SEO/AEO + publish scheduling today; C7 adds
     delivery artifacts (sitemap/JSON-LD/llms.txt) when it lands
   - **CRM-lite** — contacts/companies/deals collections + segments + automation (showcases C5)
   - **Support desk** — tickets-as-tasks + SLA `due_soon` automations + inbox
   - **Knowledge base / product docs** — embeddable content + hybrid search today; C8 adds
     RAG/citation flows when it lands
   Each = collection defs + seed + a few Astro pages + a README; each automatically gets
   GraphQL/MCP/CLI via codegen — the demo IS the differentiator.
3. **Docs site** (Starlight) — quickstart, DSL reference (generated from the field-builder
   types + `movp_fields` metadata), per-template guides, agent-connectivity matrix (C3).

Acceptance gates: template CI matrix — scaffold each into a temp dir → codegen → db reset
→ generic-surface smoke (create/list via CLI) green per template; docs site builds in CI.

Deferred: community template submission process, template versioning/upgrade tooling.

## C7 — Inline Editing & Content Delivery Parity

**Goal:** any client app can embed Notion-style editing against MOVP content, and published
content ships with first-class SEO/AEO delivery artifacts.

In scope:
1. **`@movp/editor-sdk`** — embeddable React block editor bound to `content_item.data` +
   the existing revision pointers (draft/approved/published) and `content_hash` conflict
   detection (409 → refresh path already defined in CMS). ✅ DECIDED: new editor
   dependency approved. Recommendation: **BlockNote-first**, with a dependency/license
   gate before implementation:
   - Use BlockNote for v1 because the product target is explicitly Notion-style block
     editing, BlockNote ships a ready-made React UI, block document JSON, custom schema
     extension points, and Yjs collaboration hooks while still sitting on TipTap/
     ProseMirror underneath.
   - Do **not** adopt BlockNote blindly: `@blocknote/react` is currently MPL-2.0, not
     MIT. Apache-2.0 apps can usually depend on MPL libraries without relicensing the
     whole app, but C7 expansion must add a license-compliance check and preserve MPL
     notices. If that policy is unacceptable, fallback to **TipTap MIT** and budget
     more implementation for block UX, menus, drag handles, schemas, and import/export.
   - C7 Task 1 should be a spike/gate: install the candidate, build a minimal editor
     island, round-trip MOVP `data` through create/edit/publish, run bundle/boundary/
     a11y checks, and record the dependency/license result before implementing the SDK.
2. **In-place visual editing overlay** — a script/component a host site includes to make
   published regions editable in context (Framer/Webflow-style), using field↔element
   binding; strict client/server bundle boundary (per the cms-editor precedent rule) with
   a boundary-grep test from day one.
3. **Realtime** — presence + live revision updates via Supabase Realtime (broadcast on
   revision writes); collaborative cursors deferred (see below).
4. **Delivery artifacts** — sitemap.xml, robots.txt, per-type JSON-LD emitters, `llms.txt`
   (AEO), canonical/meta rendering helpers in the template; wire `auditSeo` results into
   the editor UI (score + checklist inline).
5. **Published read API hardening** — cache headers + CDN guidance for `getPublished`.

Acceptance gates: editor pkg boundary grep test; e2e edit→approve→publish→public read;
conflict e2e (two editors, second gets 409+refresh); golden-file tests for
sitemap/JSON-LD/llms.txt; a11y pass on editor chrome (keyboard + focus), per the usability
dimension.

Deferred: CRDT/multiplayer text editing (OT/Yjs is a project of its own — revision-pointer
conflicts are the v1 model), content localization/i18n (needs its own data-model plan:
locale dimension on revisions), block-level comments (Collaboration already gives
entity-level comments).

## C8 — Retrieval & RAG Platform

**Goal:** MOVP is a credible unified store for RAG: bring-your-own embedder, ingest
documents, retrieve with citations.

In scope:
1. **Pluggable embedding providers** — provider registry (gte-small default; OpenAI/Voyage
   adapters) with **per-model chunk storage** (dimension varies: new
   `search_chunk_<dim>`-style strategy or a `model`+`vector` column plan — decide at
   expansion; must be additive, never a rewrite of the frozen 384-dim table). External
   keys held as function secrets, never client-side.
2. **Document ingestion pipeline** — asset (R2) → text-extraction job kind → chunker →
   embed jobs; bounded (size-before-read per the untrusted-I/O rule), quarantine on parse
   failure.
3. **`rag.query` surface (GraphQL + MCP)** — hybrid retrieve → optional rerank → return
   chunks WITH entity backlinks (citations). Answer synthesis stays in the calling
   agent/app: the platform returns grounded context and never holds LLM completion keys —
   this keeps MOVP model-agnostic and is the design stance, not a gap.
4. **Retrieval eval harness** — golden query set per template corpus; recall@k threshold as
   a CI gate so provider/chunker changes are measurable.

Acceptance gates: eval harness ≥ baseline recall@k; pgTAP RLS on all new chunk paths
(positive+negative); ingestion bounds tests (oversized file skipped, not buffered);
provider-swap integration test (same corpus, two providers, both retrievable).

Deferred: bundled reranker model hosting, knowledge-graph auto-extraction (edges graph
exists for explicit links), agentic multi-hop retrieval.

---

## Additional feature candidates (beyond the user's list)

Worth planning (assigned above): admin RBAC seed (C2), PATs + `movp login` (C3),
reporting-view codegen (C4), idempotent ingest + external refs (C5), scaffolder (C6),
visual editing overlay (C7), retrieval evals (C8).

Deferred with reasons (visible, not silent):
- **Realtime GraphQL subscriptions** — Supabase Realtime covers the near-term; yoga
  subscriptions on edge need infra evidence first.
- **Full RBAC / field-level permissions** — big data-model change; seed lands in C2, full
  matrix needs its own phase with real consumer requirements.
- **Import/export (CSV/JSON) + backup guide** — small; slot into C2 or C6 expansion if an
  adopter asks; not load-bearing for launch.
- **Rate limiting / persisted GraphQL queries** — needed for hosted multi-tenant SaaS, not
  for self-hosted OSS v1; document Supabase-level controls meanwhile.
- **Multi-env promotion tooling (dev→staging→prod)** — document the Supabase CLI flow in C1
  docs; bespoke tooling only when the documented flow demonstrably fails adopters.
- **Telemetry/analytics opt-in** — community-sensitive; decide post-launch with the
  community, opt-in only.
- **i18n/localization** — real demand signal first; it touches every revision-pointer
  invariant (noted in C7 deferred).

## External assumptions (each with check or fallback)

1. **Supabase.ai `gte-small` remains available on self-hosted/local edge runtime** — check
   at C8 expansion; fallback: the provider registry makes gte-small just one adapter.
2. **MCP client config schemas (Claude/Cursor/Codex/Gemini/Copilot) drift** — CI
   protocol-smoke + per-client config lint + "verified against version X" doc lines (C3).
3. **`@movp` npm scope is decided, but release-environment auth/access is unverified** —
   verify `npm org --help`, then check `npm whoami` + `npm org ls movp` before the first
   C1 publish task; fail loudly on mismatch rather than silently publishing under a renamed
   scope.
4. **PostgREST exposure of generated tables is policy-safe** — gated by an explicit
   grants/exposure audit test in C5 before documenting it as the REST facade.
5. **`mcp-remote`-style community bridge is adequate** — smoke-test before writing
   `@movp/mcp-bridge`; build our own only on failure.
6. **A PAT can be exchanged for an RLS-bound principal** — C3 Task 1 must spike and prove
   one mechanism end-to-end before building the rest of agent auth. Check: PAT-authenticated
   requests see only their workspace under RLS (positive+negative pgTAP/integration).
   Fallback: service-role access only through SECURITY DEFINER RPCs that take the
   PAT-resolved `user_id`/`workspace_id`, never raw table access.
7. **Supabase local config can support outsider defaults without breaking this machine's
   64xxx port isolation** — C1 expansion must verify the CLI override mechanism before
   changing `supabase/config.toml`. Fallback chain: use documented env/config substitution
   if supported; else keep committed 64xxx ports and document why; only consider standard
   committed ports with a gitignored local patch after reconciling AGENTS.md's
   "do not normalize ports" rule.

## Maintainer decisions

| Decision | Phase | Status |
|---|---|---|
| License | C1 | ✅ Apache-2.0 |
| npm publish strategy + scope | C1 | ✅ Build with tsup/dual ESM and publish under maintainer-controlled `@movp`; verify npm auth/scope before publish |
| Editor base dependency | C7 | ✅ New dependency approved; recommendation is BlockNote-first, with MPL-2.0 compliance gate and TipTap MIT fallback |
| Bridge: reuse `mcp-remote` vs own | C3 | ✅ Reuse community bridge first if smoke passes; build `@movp/mcp-bridge` only as fallback |

## Eight-dimension self-review (roadmap altitude)

- **Correctness** — grounded in a verified code inventory (table above), not plan intent;
  phase dependencies stated; expansion-before-execution rule pins spec↔code agreement.
- **Safety** — PAT/API-key items reuse the proven hashed-secret pattern, with PAT→RLS
  binding explicitly spike-gated before implementation; PostgREST exposure gated by an
  audit test; editor SDK carries the boundary-grep from day one; license/legal is C1
  item 1; LLM completion keys kept out of the platform (C8 stance).
- **Reliability** — every phase inherits the jobs/DLQ + forward-only-migration discipline;
  idempotent ingest and seed idempotence are explicit gates.
- **Observability** — dashboards (C4) surface the already-structured events/jobs; PAT
  rejection and ingest idempotency-conflict paths are explicit evented gates; new admin and
  reporting paths keep the keys-not-values redaction discipline.
- **Efficiency** — leverage-first ordering: metadata→views (C4), schema→admin grid (C2),
  codegen→templates (C6) all reuse existing registries instead of new infra; reuse-over-build
  decisions (PostgREST, mcp-remote, Supabase Realtime) are explicit.
- **Performance** — plain views before matviews (evidence-first); CDN/cache guidance for
  published reads; HNSW/bounded retrieval already in place; eval harness makes retrieval
  changes measurable.
- **Simplicity** — every phase names deferred speculative items (connector runtime, CRDT,
  OAuth AS, dashboard builder) with the first-real-consumer rule.
- **Usability** — C1 login + seed + bootstrap targets the first-run experience; C2 gives
  operators a console; C7 states a11y gates for the editor; failure UX inherits the
  template's `auth|error|empty|ok` state pattern.

Overall: this document is a roadmap (work to be done), not a report; no phase claims an
unverified state as accomplished. Expansion of each phase into its TDD series is the point
at which per-task invariants, code samples, and machine-checkable gates are authored under
`plans-for-context-poor-executors`.
