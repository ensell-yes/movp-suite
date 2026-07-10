# MOVP Suite - Stage C TDD Breakdown

> Roadmap-to-execution breakdown for `2026-07-07-movp-stage-c-oss-roadmap.md`.
> This is the reviewable task map for Stage C. It is not yet the copy-paste
> implementation plan for any single phase; before execution, expand the chosen phase into
> the existing Stage A/B plan format with exact file bodies, code samples, expected
> failures, and per-task commits.

## Goal

Turn the approved Stage C OSS roadmap into 56 bite-sized TDD work units with explicit order,
failure-first tests, implementation target, and gate per task.

## Global Constraints

- Keep Stage C phase order from the roadmap: C1 first; C2 and C3 can run in parallel after
  C1; C4 depends on C2; C5 depends on C3; C6 depends on C1 and is enriched by C4/C5/C7/C8;
  C7 depends on C1; C8 depends on C3.
- Do not execute from this file directly. Each task below must be expanded into a
  copy-paste-correct implementation plan before coding.
- Preserve Stage A/B invariants: forward-only migrations, config-first codegen, RLS via
  workspace membership, hardened SECURITY DEFINER RPCs, no values/PII/secrets in logs,
  and full CI including `slice-e2e`.
- Supabase local ports are intentionally 64xxx in this repo. C1 may study an outsider
  default-port story, but it must not normalize `supabase/config.toml` until the override
  mechanism is proven.
- Generated artifacts are changed only by codegen. Never hand-edit
  `20260701000002_movp_generated.sql` or generated TypeScript. The frozen generated
  baseline must remain byte-identical; post-freeze generated additions require the
  generated-delta strategy in C4.1 before any new emitter ships.

## Stage C Execution Ledger

| Phase | Depends on | Task count | Gate to call phase complete |
|---|---|---:|---|
| C1 OSS Packaging & Onboarding ✅ MERGED (PR #8) | none | 8 | ✅ done — `2026-07-07-movp-stage-c-01-oss-packaging-onboarding.md`; quickstart CI, login e2e, seed idempotence, full repo gates all green |
| C2 Admin Console & Operations | C1 | 7 | admin pgTAP, admin Playwright, boundary, full repo gates |
| C3 Agent Connectivity | C1 | 7 | PAT RLS proof, MCP HTTP+stdio smoke, CLI login integration |
| C4 Reporting & Dashboards | C2 | 7 | reporting codegen goldens, generated-delta freeze proof, pgTAP views/RPCs, dashboard e2e |
| C5 Integration Fabric | C3 | 6 | ingest idempotency, external-ref RPCs, exposure audit, recipe smoke |
| C6 Templates & Scaffolding | C1 | 7 | scaffold matrix, docs build, generic surface smoke per template |
| C7 Inline Editing & Delivery | C1 | 7 | editor spike, boundary, edit/publish/conflict e2e, delivery goldens |
| C8 Retrieval & RAG | C3 | 7 | provider swap, ingest bounds, RLS pgTAP, recall@k CI |

---

## C1 - OSS Packaging & Onboarding

**Outcome:** a stranger can clone, license-check, bootstrap, log in, seed data, and run the
suite locally.

### Task C1.1: Legal and contributor baseline

**Files:** `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CLAUDE.md`,
`AGENTS.md`

**Failing test:** add a docs-presence script or CI step that fails while any required
file is absent, and a symlink check that fails while `AGENTS.md` is not a relative symlink
to `CLAUDE.md`.

**Implementation:** add Apache-2.0 license, public README skeleton, contribution/security
docs, fold current `AGENTS.md` content into `CLAUDE.md`, replace `AGENTS.md` with the
relative symlink.

**Gate:** `test -f LICENSE README.md CONTRIBUTING.md SECURITY.md CLAUDE.md` plus the
symlink check, then `pnpm typecheck`.

### Task C1.2: Package build and publish metadata

**Files:** root `package.json`, package `package.json` files, `tsup.config.ts` or per-package
build config, `.npmignore`/`files` metadata, CI workflow.

**Failing test:** package smoke packs each publishable package into a temp directory using
`pnpm pack --pack-destination <tmp>` and fails because the tarball file list lacks `dist/`
artifacts or because `exports`/`types` still resolve to raw `src/*.ts`.

**Implementation:** add package build outputs, `exports` maps, type declarations, and a
release-auth preflight that first verifies current npm CLI usage with `npm org --help`,
then runs `npm whoami` plus `npm org ls movp`.

**Gate:** `pnpm -r build`, package-tarball assertion script, release preflight fails loudly
when auth/scope is unavailable.

### Task C1.3: Template login flow

**Files:** `templates/frontend-astro/src/pages/login.astro`,
`templates/frontend-astro/src/pages/auth/callback.astro`, session helpers, Playwright tests.

**Failing test:** unauthenticated visit to a protected page redirects to login; magic-link
or local test auth callback is absent and test fails.

**Implementation:** add Supabase Auth login/callback flow that sets the same httpOnly
session cookie existing pages read. Keep browser bundles free of service-role secrets.

**Gate:** frontend Playwright login e2e, `pnpm --filter frontend-astro typecheck`, boundary
grep.

### Task C1.4: Demo seed

**Files:** `scripts/seed-demo.ts`, root `package.json`, seed test fixture.

**Failing test:** `pnpm seed:demo && pnpm seed:demo` currently lacks idempotent counts.

**Implementation:** seed one workspace, members, tasks, content, campaign, segment,
workflow rule, webhook subscription placeholder, and enough records for every existing
page to render non-empty. Use stable external ids or deterministic keys.

**Gate:** seed idempotence test: run twice, assert row counts and stable ids are unchanged.

### Task C1.5: One-command bootstrap

**Files:** `scripts/bootstrap.mjs`, root `package.json`, quickstart CI workflow.

**Failing test:** clean-runner bootstrap job fails because no orchestrating command exists.

**Implementation:** orchestrate Supabase start, db reset, seed, functions serve, and
template dev/smoke. Verify the default-port-vs-64xxx assumption before touching
`supabase/config.toml`.

**Gate:** quickstart CI job: clone, install, bootstrap, login e2e, `slice-e2e` pass.

### Task C1.6: Public README quickstart

**Files:** `README.md`, `docs/quickstart.md` if needed.

**Failing test:** docs-link checker fails on missing commands, badges, or referenced files.

**Implementation:** document positioning, architecture diagram, config-first loop,
requirements, quickstart, common local-stack failure modes, and link to Stage C roadmap.

**Gate:** docs link check plus quickstart command snippets linted by CI.

### Task C1.7: Known debt burn-down

**Files:** plan README, plan docs with stale grep gates, GitHub Actions versions, deploy docs.

**Failing test:** grep-based doc-lint flags stale Segmentation wording and known gate
patterns that match comments instead of executable lines.

**Implementation:** update stale Stage B ledger references, fix plan-doc gate greps, bump
deprecated action versions, and document retention scheduling with pg_cron/Supabase Vault.

**Gate:** doc-lint pass, full CI green.

### Task C1.8: C1 final slice

**Files:** `.github/workflows/*`, `scripts/slice-e2e.sh`, quickstart artifacts.

**Failing test:** a clean C1 run cannot prove clone-to-login-to-data without manual steps.

**Implementation:** add a named `[quickstart]` or `[onboarding]` slice section covering
bootstrap, login, seeded page visibility, and basic GraphQL/MCP/CLI smoke.

**Gate:** full CI green including `slice-e2e`; C1 review score >= 9.2.

---

## C2 - Admin Console & Operations

**Outcome:** a workspace owner can administer workspace, members, keys, jobs, and generic
collections from the UI.

### Task C2.1: Owner/admin role enforcement seed

**Files:** new migration, pgTAP tests, domain/admin service skeleton.

**Failing test:** non-owner member can call a proposed admin RPC or no admin RPC exists.

**Implementation:** the `workspace_membership.role` column ALREADY EXISTS
(`owner`/`admin`/`member`, default `member`) — add an `is_workspace_admin(ws)` helper and
enforce it on admin-only RPCs; do NOT re-add the column. `is_workspace_member` stays the
gate for existing non-admin paths. No full RBAC matrix.

**Gate:** pgTAP owner/member/non-member matrix, definer-audit, db diff clean.

### Task C2.2: Workspace and invite administration

**Files:** migrations/RPCs, domain service, GraphQL mutations, admin Playwright tests.

**Failing test:** invite -> accept -> demote flow is missing.

**Implementation:** create workspace, invite, accept, remove, and demote/promote flows with
stable error codes and membership-bound RLS.

**Gate:** pgTAP plus Playwright invite lifecycle e2e.

### Task C2.3: Ingest API-key management

**Files:** RPCs over existing ingest key registry, domain/admin service, GraphQL, UI.

**Failing test:** operator cannot create/rotate/revoke a hashed ingest key or one-time
secret display leaks publicly.

**Implementation:** mirror webhook-secret discipline: raw secret returned once, only hash
persisted, logs/events contain key ids and error codes only.

**Gate:** pgTAP secret-not-persisted, UI one-time display e2e, redaction gate.

### Task C2.4: Jobs and DLQ operations

**Files:** scoped replay RPCs, admin service, GraphQL, `templates/frontend-astro/src/pages/admin/jobs.astro`.

**Failing test:** dead-job list and scoped replay are unavailable or globally scoped.

**Implementation:** add workspace-scoped job counts, dead-job list with payload keys only,
and replay for permitted job kinds through member-gated RPCs.

**Gate:** pgTAP cross-workspace replay denial, Playwright replay e2e, jobs test.

### Task C2.5: Generic collection browser

**Files:** metadata service over `movp_collections`/`movp_fields`, GraphQL query wrappers,
admin pages and islands.

**Failing test:** metadata-driven grid cannot list/create/edit a non-internal collection,
or internal collections appear.

**Implementation:** render grids/forms from metadata and route operations through existing
generic GraphQL surfaces. Suppress internal collections and unsupported fields clearly.

**Gate:** Playwright: browse note/task/campaign, create/edit one generic record, verify
internal collection absent.

### Task C2.6: Settings and retention status

**Files:** settings page, retention-status RPC if needed, deploy docs link.

**Failing test:** operator cannot see retention schedule status or deployment caveat.

**Implementation:** show workspace profile, event catalog links, retention schedule status,
and actionable "not scheduled" warning.

**Gate:** settings Playwright with scheduled/unscheduled fixtures.

### Task C2.7: C2 final admin slice

**Files:** `scripts/slice-e2e.sh`, admin tests.

**Failing test:** no end-to-end operator path covers workspace admin + jobs + generic grid.

**Implementation:** add `[admin]` slice over login, invite, key create/revoke, DLQ replay,
and generic collection browse.

**Gate:** full CI including `[admin]` slice; C2 review score >= 9.2.

---

## C3 - Agent Connectivity

**Outcome:** named agent clients can connect over MCP/CLI with headless auth.

### Task C3.1: PAT-to-RLS feasibility spike

**Files:** spike migration/tests, auth/domain prototype, docs note.

**Failing test:** PAT-authenticated request cannot prove workspace-scoped RLS.

**Implementation:** prove one mechanism end-to-end. Preferred path may use Supabase/GoTrue
admin session issuance if it gives a true RLS-bound principal. Fallback is service-role
only through SECURITY DEFINER RPCs that take PAT-resolved `user_id`/`workspace_id`, never
raw table access.

**Gate:** positive and negative pgTAP/integration: a PAT resolves to exactly the
owning user's access (user-scoped — see the C3 design spec's F1 resolution; PATs are
NOT workspace-confined, since the GoTrue exchange yields an ordinary user session and
RLS is reused unchanged); a different user / revoked / expired PAT is denied;
auth-rejection emits a keys-only event. `default_workspace_id` is a CLI home-workspace
hint, not an access boundary.

### Task C3.2: PAT table and lifecycle

**Files:** migration, pgTAP, domain service, GraphQL/CLI endpoints.

**Failing test:** valid/expired/revoked/wrong-workspace PAT cases missing.

**Implementation:** hashed token table with expiry, revoke, last-used metadata, workspace
scope, one-time secret display.

**Gate:** pgTAP matrix and redaction test.

### Task C3.3: `movp login`, `movp init`, and CLI parity

**Files:** `packages/cli/src/program.ts`, keychain integration or documented secure store,
CLI tests.

**Failing test:** `movp login`, `movp init`, and authenticated CLI calls fail without
browser session cookie; `movp search --mode hybrid` cannot reach semantic/hybrid search.

**Implementation:** device-style or copy-token flow storing PAT securely; `movp init`
points the CLI at a remote instance; route semantic/hybrid search through GraphQL/MCP path
where needed.

**Gate:** CLI integration: init, login, list tasks, `movp search --mode hybrid` against
seeded data returns at least one hit, revoke token, command fails with auth code.

### Task C3.4: MCP HTTP client matrix

**Files:** docs/config samples for Claude Code, Codex, Cursor, Gemini CLI, Copilot; lint
script; MCP smoke tests.

**Failing test:** config samples are missing or unverified against current schemas.

**Implementation:** add per-client config files/docs and a CI smoke that initializes,
lists tools, and calls one safe tool over streamable HTTP.

**Gate:** config lint plus MCP HTTP smoke.

### Task C3.5: Stdio bridge decision and smoke

**Files:** docs, optional `packages/mcp-bridge` only if `mcp-remote` fails.

**Failing test:** stdio client smoke fails or has no path.

**Implementation:** first test community `mcp-remote`; if it passes, document it. Build
`@movp/mcp-bridge` only as fallback with a narrow scope.

**Gate:** stdio smoke initialize/tools-list/tool-call.

### Task C3.6: Agent-facing docs and plugin artifacts

**Files:** `llms.txt`, consumer `AGENTS.md` template, Claude Code/Codex skill or plugin docs.

**Failing test:** docs-config lint cannot find agent conventions and example tool calls.

**Implementation:** document tool naming, workspace id convention, stable error codes, and
recommended agent prompts.

**Gate:** docs lint plus a smoke that follows the documented sequence.

### Task C3.7: C3 final agent slice

**Files:** `scripts/slice-e2e.sh`, CI workflow.

**Failing test:** no single slice proves PAT -> MCP/CLI -> tool action.

**Implementation:** add `[agents]` slice using PAT login, MCP HTTP, stdio bridge, and CLI.

**Gate:** full CI including `[agents]`; C3 review score >= 9.2.

---

## C4 - Reporting Views & Dashboards

**Outcome:** `reporting.role` metadata becomes queryable views and visible dashboards.

### Task C4.1: Generated-delta migration strategy

**Files:** `packages/codegen/src/generate.ts`, codegen tests, docs for migration freeze.

**Failing test:** running codegen for any new emitter rewrites frozen
`supabase/migrations/20260701000002_movp_generated.sql` or deletes another generated
delta file.

**Implementation:** add a generated-delta strategy for post-freeze emitters. The baseline
generated migration stays byte-identical; new generated additions write to a timestamped
delta file using an explicit migration name/path, and cleanup logic must not delete
approved delta files. Make this a prerequisite for reporting views and any future
codegen-emitted objects.

**Gate:** codegen unit test: run generate with a schema/emitter delta, assert frozen file
hash unchanged, assert new delta migration exists, then `pnpm test:forward-only-migrations`
passes.

### Task C4.2: Reporting codegen emitter

**Files:** `packages/codegen/src/*`, tests, generated migration via codegen.

**Failing test:** golden SQL for `reporting.v_<collection>` views missing.

**Implementation:** emit security-invoker views for collections with reporting metadata.
Views select dimensions/measures/timestamps and rely on table RLS.

**Gate:** codegen golden tests, `pnpm codegen`, frozen baseline unchanged, generated delta
present, db diff clean.

### Task C4.3: Reporting RLS pgTAP

**Files:** Supabase tests.

**Failing test:** member positive/negative view access absent.

**Implementation:** pgTAP every emitted view with two workspaces and explicit measure/dim
assertions.

**Gate:** `supabase test db`.

### Task C4.4: Event analytics RPCs

**Files:** new migration, pgTAP, domain service.

**Failing test:** no member-gated, redacted counts over internal events/jobs.

**Implementation:** add SECURITY DEFINER RPCs for event/job daily counts and workflow
health. Return counts/classifiers only, never payload values.

**Gate:** positive/negative pgTAP on every RPC, definer-audit, redaction gate.

### Task C4.5: Dashboard query layer

**Files:** domain/admin service, GraphQL custom reads if needed, tests.

**Failing test:** dashboard queries cannot retrieve task throughput, content funnel,
campaign metrics, segment growth, workflow health, ingest volume.

**Implementation:** typed query functions over reporting views/RPCs with bounded date
ranges and workspace scoping.

**Gate:** package tests and GraphQL shape gate.

### Task C4.6: Dashboard frontend

**Files:** admin dashboard pages/islands, Playwright tests.

**Failing test:** seeded dashboards render empty or inaccessible states only.

**Implementation:** charts/tables for the six dashboard families. Use existing Astro
server-side GraphQL pattern and full state components.

**Gate:** Playwright non-empty charts, a11y smoke, boundary.

### Task C4.7: External BI seam

**Files:** docs, optional SQL role recipe test.

**Failing test:** BI docs absent or grant recipe exposes internal schema.

**Implementation:** document read-only Postgres role scoped to `reporting` schema plus
Metabase/Cube quickstart. No BI tool bundled.

**Gate:** grants audit proving reporting-only access; C4 review score >= 9.2.

---

## C5 - Integration Fabric

**Outcome:** external CRMs/apps can sync through idempotent ingest, external refs, and
documented PostgREST without bespoke source reads.

### Task C5.1: Idempotent ingest

**Files:** ingestion migration/RPC/function tests, `supabase/functions/ingest`.

**Failing test:** same idempotency key creates duplicate events; different payload with
same key has no conflict code.

**Implementation:** optional `idempotency_key` unique per workspace with payload hash
comparison and stable conflict code. Emit keys-only conflict obs event.

**Gate:** pgTAP plus ingest slice.

### Task C5.2: External reference convention

**Files:** core-schema helpers if needed, migration, pgTAP, docs.

**Failing test:** no generic way to map external source/id to MOVP entities.

**Implementation:** `external_ref` convention (`source`, `external_id`) and generic
`upsert_by_external_ref` RPC with workspace and collection allowlist.

**Gate:** positive/negative pgTAP, injection/allowlist tests.

### Task C5.3: PostgREST exposure audit

**Files:** audit script, CI, docs.

**Failing test:** no proof that `internal:true` and `movp_internal` stay unreachable.

**Implementation:** add grants/exposure audit using anon/member roles before documenting
PostgREST as REST facade.

**Gate:** exposure audit in CI.

### Task C5.4: CRM sync recipe

**Files:** recipe docs/example, mock CRM endpoint test.

**Failing test:** no outbound/inbound recipe smoke.

**Implementation:** add HubSpot/Salesforce/Attio pattern docs and one mock sync worker
using webhook subscription outbound and ingest inbound.

**Gate:** recipe smoke script against mock CRM endpoint.

### Task C5.5: Zapier/n8n templates

**Files:** recipe JSON/docs, validation script.

**Failing test:** template files missing or invalid JSON.

**Implementation:** provide importable n8n/Zapier-style flows with placeholders and
security notes.

**Gate:** template lint.

### Task C5.6: C5 final integration slice

**Files:** `scripts/slice-e2e.sh`, docs.

**Failing test:** no end-to-end CRM round trip.

**Implementation:** `[integration]` slice: external event idempotent ingest -> automation
or webhook -> external-ref upsert -> PostgREST read audit.

**Gate:** full CI including integration slice; C5 review score >= 9.2.

---

## C6 - Use-Case Templates & Scaffolding

**Outcome:** `create-movp` scaffolds working, agent-connected projects and a docs site
explains them.

### Task C6.1: Scaffolder package

**Files:** new `packages/create-movp` or `tools/create-movp`, tests.

**Failing test:** CLI cannot scaffold a named template into a temp dir.

**Implementation:** prompts/project-name/template selection, copies template, installs
workspace files, prints bootstrap steps.

**Gate:** temp-dir scaffold test.

### Task C6.2: Template matrix harness

**Files:** CI script, test fixtures.

**Failing test:** no matrix proves generated projects run codegen/db reset/generic smoke.

**Implementation:** reusable harness: scaffold -> codegen -> db reset -> CLI create/list.

**Gate:** one minimal fixture passes before adding gallery templates.

### Task C6.3: Marketing site + blog template

**Files:** template collection defs, seed, Astro pages, README.

**Failing test:** scaffolded marketing template has no CMS/SEO/publish smoke.

**Implementation:** content types, seeded articles/pages, SEO/AEO audit example, publish
scheduling today; C7 delivery artifacts are documented as enrichment.

**Gate:** matrix row green.

### Task C6.4: CRM-lite template

**Files:** template defs/seed/pages.

**Failing test:** contacts/companies/deals generic surfaces missing.

**Implementation:** CRM collections using external_ref convention if C5 landed, or a
forward-compatible field shape if C5 is absent.

**Gate:** matrix row green.

### Task C6.5: Support desk template

**Files:** template defs/seed/pages.

**Failing test:** tickets-as-tasks and SLA automation smoke missing.

**Implementation:** ticket schema over tasks, SLA due-soon automation, inbox seed.

**Gate:** matrix row green.

### Task C6.6: Knowledge base template

**Files:** template defs/seed/pages.

**Failing test:** hybrid-search KB smoke missing.

**Implementation:** content + hybrid search today; RAG/citations documented as C8
enrichment.

**Gate:** matrix row green.

### Task C6.7: Docs site

**Files:** docs site package/config, generated DSL reference.

**Failing test:** docs build absent or DSL reference stale.

**Implementation:** Starlight or equivalent docs site, generated field-builder reference,
template guides, agent connectivity matrix.

**Gate:** docs build in CI; C6 review score >= 9.2.

---

## C7 - Inline Editing & Content Delivery

**Outcome:** external apps can embed a Notion-style MOVP editor and published content ships
delivery artifacts.

### Task C7.1: Editor dependency spike

**Files:** spike package/page/test, dependency/license report.

**Failing test:** no proof BlockNote can round-trip MOVP content data within boundary and
license constraints.

**Implementation:** install candidate, build minimal editor island, round-trip create/edit
/publish, document MPL-2.0 compliance or fallback to TipTap MIT.

**Gate:** bundle/boundary/a11y checks and license report.

### Task C7.2: `@movp/editor-sdk` package

**Files:** new package, exports, tests.

**Failing test:** package cannot render with provided content item/revision props.

**Implementation:** React editor component, data adapter, save callback, conflict error
surface. No server-only imports in client bundle.

**Gate:** package tests, typecheck, boundary grep.

### Task C7.3: Content binding and conflict flow

**Files:** domain/GraphQL if needed, frontend integration tests.

**Failing test:** two-editor conflict does not return 409+refresh path.

**Implementation:** bind editor save to existing revision/content_hash mechanics and show
humane conflict UX.

**Gate:** e2e two editors, second save gets refresh path without data loss.

### Task C7.4: In-place visual editing overlay

**Files:** overlay script/component, host-page fixture.

**Failing test:** host page cannot mark published regions editable.

**Implementation:** field-to-element binding, edit affordance, server-side mutation path,
strict bundle boundary.

**Gate:** Playwright host overlay edit smoke and boundary.

### Task C7.5: Realtime presence and revision updates

**Files:** Realtime channel helpers, tests.

**Failing test:** editor does not observe revision writes or presence state.

**Implementation:** Supabase Realtime broadcast on revision writes; presence indicators.
CRDT text editing remains deferred.

**Gate:** realtime integration smoke.

### Task C7.6: Delivery artifacts and published-read hardening

**Files:** sitemap/robots/JSON-LD/llms generators, golden tests.

**Failing test:** delivery artifacts missing or stale for published content; published read
path lacks tested cache-control/CDN headers.

**Implementation:** per-type generators, canonical/meta helpers, cache-control/CDN guidance
for `getPublished`, and `auditSeo` score wired into editor UI.

**Gate:** golden-file tests for sitemap/robots/JSON-LD/llms.txt, cache-header test on the
published read path, Playwright score/checklist assertion.

### Task C7.7: C7 final delivery slice

**Files:** `scripts/slice-e2e.sh`, package docs.

**Failing test:** no full edit -> approve -> publish -> public delivery path.

**Implementation:** `[editor-delivery]` slice over SDK edit, publish, artifact fetch,
conflict handling.

**Gate:** full CI including slice; C7 review score >= 9.2.

---

## C8 - Retrieval & RAG Platform

**Outcome:** MOVP can ingest documents, store chunks with provider-aware embeddings, and
return grounded retrieval results with citations.

### Task C8.1: Embedding provider strategy

**Files:** `packages/search`, provider tests, design record.

**Failing test:** provider swap cannot return embeddings with known dimensions.

**Implementation:** provider registry for gte-small default plus OpenAI/Voyage adapters
behind server secrets. Decide additive dimension storage strategy before migration.

**Gate:** provider contract tests; no client-side key exposure.

### Task C8.2: Chunk storage migration

**Files:** new migration, pgTAP, search package tests.

**Failing test:** multiple embedding dimensions/models cannot coexist without rewriting
frozen 384-dim table.

**Implementation:** additive per-dimension/per-model chunk storage and indexes with RLS.

**Gate:** pgTAP positive/negative RLS and vector query shape.

### Task C8.3: Document ingestion bounds

**Files:** ingestion worker/function, asset pipeline tests.

**Failing test:** oversized document can be buffered or parse failure is silent.

**Implementation:** R2 asset -> text extraction job -> quarantine or chunk job, with
size-before-read bounds and stable error codes.

**Gate:** oversized/skipped/quarantined tests.

### Task C8.4: Chunker and embed jobs

**Files:** flows/search packages, tests.

**Failing test:** document chunks do not enqueue/embed idempotently.

**Implementation:** chunker, embed jobs keyed by content hash/provider/model, retry/DLQ
integration.

**Gate:** jobs tests, no redundant embed on unchanged content.

### Task C8.5: `rag.query` surfaces

**Files:** domain, GraphQL, MCP, tests.

**Failing test:** query cannot return chunks with entity backlinks/citations.

**Implementation:** hybrid retrieve, optional rerank hook, citations/backlinks. No answer
synthesis or LLM completion keys inside MOVP.

**Gate:** GraphQL/MCP query tests with citation assertions.

### Task C8.6: Retrieval eval harness

**Files:** eval fixtures/scripts, CI.

**Failing test:** provider/chunker changes have no recall@k gate.

**Implementation:** golden query sets per template corpus with baseline recall threshold.

**Gate:** recall@k >= baseline in CI.

### Task C8.7: C8 final RAG slice

**Files:** `scripts/slice-e2e.sh`, docs.

**Failing test:** no full document -> chunk -> retrieve-with-citation path.

**Implementation:** `[rag]` slice: ingest document, wait for jobs, query, assert citation
points to source entity and cross-workspace RLS denies.

**Gate:** full CI including RAG slice; C8 review score >= 9.2.

---

## Expansion Checklist For Each Phase

Before executing a phase, turn that phase's tasks into a dedicated implementation plan with:

1. Exact file paths and interfaces.
2. Failing test code and the expected failure text.
3. Pasteable implementation code or SQL where the executor cannot infer it safely.
4. Per-task gate commands.
5. A final slice-e2e section.
6. Eight-dimension self-review.

Do not start implementation from this breakdown alone.
