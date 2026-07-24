# C7.6b — SEO and Delivery Operability TDD Implementation Plan

> **Executor contract:** This plan finishes C7.6; it does not add another renderer, public read path, cache purge system, or SEO authority gate.

**Goal:** Turn the existing persisted SEO audit into an accessible, draft-preserving editor panel; make public metadata use that same persisted record; and complete content-disciplined delivery observability and withdrawal tests.

**Depends on:** `07e` delivery core and `07f` inline overlay. `07g` may land before this plan but is not a runtime dependency.

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md` §§5.3, 6, 11, and 12.

**Architecture:** The current `auditSeo`/`runSeoAudit` remains the only scoring implementation and persists `content_seo`. A small client-safe panel calls a same-origin POST route so rerunning the audit does not reload or replace editor state. Public delivery consumes item-scoped current `meta`/`jsonld` from the published-only RPC while the page body remains pinned to `published_revision_id`, then passes both through `@movp/delivery`. Astro request handlers own structured delivery signals and cache headers.

**No new dependency or migration.**

## Invariants

- SEO is advisory. It never grants `edit`, `approve`, or `publish`, and a score cannot bypass workflow.
- `auditSeo` remains the single rule/score implementation.
- `content_seo` writes require the owner/admin `edit` capability through the 07f RLS matrix; member and non-member direct writes are denied.
- The persisted `content_seo` row is item-scoped current state and is the shared source for editor output and public canonical/meta/JSON-LD. In V1, an owner/admin metadata correction may change public SEO after the ≤60-second cache window without republishing; revision-scoped SEO is explicitly deferred.
- SEO current-state updates never change which content revision supplies the public body.
- Rerunning an audit never reloads the page or discards an unsaved rich-text draft.
- Score has visible text; checklist results are not color-only.
- Every failed rule maps through an allowlist to a corrective action. Unknown rules get a generic safe message; raw values are not rendered.
- Empty, loading, success, and error are distinct accessible states.
- Public JSON-LD is structurally validated and script-safe through `@movp/delivery`.
- Public success logs `delivery.public_read`; artifacts log `delivery.artifact`.
- Signals contain request id, route kind, workspace hash, outcome, safe code, latency, and bounded counts only. Never path/slug/URL/content/schema/token/cookie/email/preview.
- Expected public not-found is distinguishable from operational failure without revealing draft existence.
- Successful public delivery is `public, max-age=0, s-maxage=60`; absent/failure/API is `no-store`.
- No purge webhook, cache tags, stale directives, or Cloudflare API token.
- All workerd env/token/request state is read inside the active request via `readServerEnv()` and the request session helper.

## File map

**Create**

- `templates/frontend-astro/src/components/content/SeoAuditPanel.tsx`
- `templates/frontend-astro/src/components/content/SeoAuditPanel.test.tsx`
- `templates/frontend-astro/src/pages/api/content/[id]/seo.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/seo.test.ts`
- `templates/frontend-astro/src/lib/delivery-observability.ts`
- `templates/frontend-astro/src/lib/delivery-observability.test.ts`
- `templates/frontend-astro/tests/e2e/seo-delivery.spec.ts`

**Modify**

- `templates/frontend-astro/src/pages/content/[id].astro`
- `templates/frontend-astro/src/pages/[contentType]/[slug].astro`
- `templates/frontend-astro/src/pages/sitemap.xml.ts`
- `templates/frontend-astro/src/pages/sitemap-[boundary].xml.ts`
- `templates/frontend-astro/src/pages/robots.txt.ts`
- `templates/frontend-astro/src/pages/llms.txt.ts`
- `templates/frontend-astro/src/lib/content-queries.ts`
- `packages/delivery/src/meta.ts`
- `packages/delivery/test/meta.test.ts`
- `supabase/tests/content_delivery_test.sql`
- `.github/workflows/ci.yml`
- `CLAUDE.md`

## Task 0: Pin the existing SEO contract before changing presentation

- [ ] Run:

```sh
git status --short --branch
rg -n "auditSeo|runSeoAudit|content_seo|RUN_SEO_AUDIT_MUTATION" packages templates supabase
pnpm --filter @movp/frontend-astro run
```

Expected:

- `packages/domain/src/seo-audit.ts` is the only scoring implementation;
- `ContentService.runSeoAudit` persists score/checklist in `content_seo`;
- GraphQL returns score/checklist;
- frontend has exact `test`, `typecheck`, `build`, `e2e` scripts.

- [ ] Run the pre-change baselines:

```sh
pnpm --filter @movp/domain test -- seo
pnpm --filter @movp/graphql test -- content.test.ts
pnpm --filter @movp/frontend-astro test
```

Expected: green. Record test counts so later work cannot silently remove coverage.

## Task 1: Build the accessible, draft-preserving SEO panel

**Red first**

- [ ] Create `SeoAuditPanel.test.tsx` with:
  - initial empty state explains how to run an audit;
  - button has a descriptive accessible name and 44px target;
  - loading disables duplicate submission and uses a status announcement;
  - score renders as text (`SEO score 71 out of 100`), not color alone;
  - pass/fail labels are textual;
  - each known failed rule maps to a specific corrective action;
  - unknown rule renders a generic action without echoing the rule/value;
  - malformed checklist fails closed to a safe error state;
  - HTTP/timeout/malformed response renders `role=alert` and preserves the previous result;
  - successful rerun replaces only audit state;
  - no callback touches editor content or performs navigation/reload;
  - keyboard activation and reduced-motion behavior.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- SeoAuditPanel.test.tsx
```

Expected: **FAIL** because the component is absent.

**Green implementation**

- [ ] Implement a closed state union:

```ts
type SeoPanelState =
  | { status: 'empty' }
  | { status: 'loading'; previous: SeoAuditResult | null }
  | { status: 'success'; result: SeoAuditResult }
  | { status: 'error'; code: string; previous: SeoAuditResult | null }
```

Do not use booleans/sentinels or `any`. Parse response/checklist from `unknown` and bound the entry count and text lengths.

- [ ] Use an allowlist keyed by the existing rule names:
  - `title_length`;
  - `meta_description_length`;
  - `canonical_present`;
  - `alt_text_coverage`;
  - `jsonld_valid`;
  - `aeo_answer_present`;
  - `faq_complete`.

Known actions should tell the author what to change. Unknown names use one generic message and are never rendered verbatim.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test -- SeoAuditPanel.test.tsx
pnpm --filter @movp/frontend-astro typecheck
```

Expected: component suite and typecheck pass.

**Commit**

```sh
git add templates/frontend-astro/src/components/content/SeoAuditPanel.tsx templates/frontend-astro/src/components/content/SeoAuditPanel.test.tsx
git commit -m "feat(frontend): add accessible SEO audit panel"
```

## Task 2: Add a no-store SEO proxy and remove the reload form

**Red first**

- [ ] Create `seo.test.ts` to pin:
  - POST only;
  - same-origin protection is retained by Astro;
  - request item id is validated/bounded;
  - session and `readServerEnv()` resolve during each request;
  - GraphQL `runSeoAudit` is called once;
  - score/checklist response is structurally validated and bounded;
  - auth/forbidden/upstream/malformed paths use safe status/codes;
  - response always has `Cache-Control: no-store`;
  - no token/body/checklist content appears in logs.

- [ ] Extend the content-page test to require `SeoAuditPanel` and forbid the old `intent=seo` reload form.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- 'src/pages/api/content/[id]/seo.test.ts' SeoAuditPanel.test.tsx
```

Expected: **FAIL** because the route is absent/page still posts the reload form.

**Green implementation**

- [ ] Add the same-origin POST proxy. Generate/pass a valid request id for correlation and emit one content-disciplined `content.seo_audit_proxy` operational event with item id, outcome, safe code, and latency.

- [ ] Mount the panel on `/content/[id]` and delete only the old SEO form/render block. Do not restructure the rest of the page or editor island.

- [ ] Ensure audit reruns do not submit/reload the parent Astro page. The editor island remains mounted with its in-flight draft.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
```

Expected: all frontend tests/type/build pass.

**Commit**

```sh
git add templates/frontend-astro/src/pages/api/content/[id]/seo.ts templates/frontend-astro/src/pages/api/content/[id]/seo.test.ts templates/frontend-astro/src/pages/content/[id].astro templates/frontend-astro/src/lib/content-queries.ts
git commit -m "feat(frontend): rerun SEO audit without editor reload"
```

## Task 3: Prove persisted SEO/public metadata parity

**Red first**

- [ ] Extend `content_delivery_test.sql`:
  1. an unpublished item with a `content_seo` row returns no public row or SEO values;
  2. after publish, the RPC returns the exact persisted `meta`/`jsonld` associated with that item;
  3. saving a new draft does not change the returned published revision body;
  4. an owner/admin post-publish `content_seo.meta`/`jsonld` correction changes public metadata after origin revalidation without changing the returned published revision body;
  5. member and non-member direct `content_seo` writes fail through RLS;
  6. rerunning the audit changes only score/checklist and cannot replace `meta`/`jsonld`;
  7. another workspace cannot retrieve the revision or SEO record.

`content_seo` is currently item-scoped rather than revision-scoped. Do not
claim historical SEO snapshot semantics or introduce a versioning migration in
this part. The intentional V1 contract is: public SEO exists only for an item
that has a published revision; public metadata is the item's current
owner/admin-controlled SEO state; the public body is always the published
revision; and audit execution does not mutate the persisted delivery metadata.
Revision-scoped SEO is deferred as a separate schema/workflow design.

- [ ] Extend delivery metadata tests for:
  - configured `PUBLIC_SITE_URL` only;
  - absolute HTTPS outside local test;
  - once-only path encoding;
  - meta title/description bounds and escaping;
  - JSON-LD `<`, U+2028, U+2029 script safety;
  - malformed persisted meta/JSON-LD fail closed with a safe code.

- [ ] Run:

```sh
supabase test db supabase/tests/content_delivery_test.sql
pnpm --filter @movp/delivery test -- meta.test.ts
```

Expected: **FAIL** on any missing published-SEO parity or metadata case.

**Green implementation**

- [ ] Reuse the `07e` RPC and `@movp/delivery` meta helpers. Do not create a second public SQL read or serializer.

- [ ] Public Astro page renders canonical/meta/JSON-LD only from the validated published delivery response and configured site origin, never `Host` or draft GraphQL data.

**Gate**

```sh
supabase test db supabase/tests/content_delivery_test.sql
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro build
```

Expected: parity/security tests green with the existing three C7-tail
migrations only. Do not add a migration in this part.

**Commit**

```sh
git add supabase/tests packages/delivery templates/frontend-astro/src/pages/[contentType]/[slug].astro
git commit -m "test(delivery): pin published SEO metadata parity"
```

## Task 4: Complete delivery observability and cache-withdrawal behavior

The 07e post-review follow-up already landed the server-only observation
helper, workspace-hash known vector, exactly-one-event route wiring, safe
failure codes, and recorder-failure hook. Preserve and extend those tests here;
do not create a second event owner. The remaining 07h work in this task is the
fake-clock/cache-withdrawal coverage and its focused browser gate.

**Red first**

- [ ] Create `delivery-observability.test.ts` with an injected recorder/clock. Pin exactly one event per request:

| Path | Event | Required outcome |
|---|---|---|
| published page 200 | `delivery.public_read` | `found` |
| missing/unpublished 404 | `delivery.public_read` | `not_found` |
| RPC timeout | `delivery.public_read` | `error`, safe timeout code |
| renderer failure | `delivery.public_read` | `error`, safe render code |
| each artifact | `delivery.artifact` | `generated` or safe error |
| artifact bound breach | `delivery.artifact` | error, bound code |

Assert exact allowed keys and absence of slug/path/URL/content/schema/token/cookie/email/payload values.

- [ ] Add fake-clock cache cases:
  - publish → 200 with exact `public, max-age=0, s-maxage=60`;
  - unpublish may leave an already cached 200 before second 60;
  - after second 60, revalidation gives `404 no-store`;
  - no `stale-while-revalidate`/`stale-if-error`;
  - API/authenticated responses are never public-cacheable.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- delivery-observability.test.ts
```

Expected: **FAIL** because the shared event owner/fake-clock behavior is absent.

**Green implementation**

- [ ] Implement one server-only reporting helper whose input type is a closed, content-disciplined union. Callers pass already validated route kind/ids/outcomes. Define `hashWorkspaceId(workspaceId)` in `templates/frontend-astro/src/lib/delivery-observability.ts` using Web Crypto SHA-256, matching `sha256Hex` in `supabase/functions/graphql/index.ts`; pin a shared known-vector test. Do not invent another hash format or salt contract.

- [ ] Each request handler resolves request id/clock/reporter per request. A reporting failure must not change a successful public response, but must surface hard through the platform’s own logging/error hook rather than silently swallowing.

- [ ] Do not add a retry or cache purge subsystem.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro e2e -- --grep "SEO|delivery cache"
```

Expected: component/route/build/browser gates pass; unsaved editor content survives audit rerun; cache and event assertions pass.

**Commit**

```sh
git add templates/frontend-astro packages/delivery supabase/tests
git commit -m "feat(delivery): finish SEO and delivery observability"
```

## Task 5: CI and durable documentation

- [ ] Extend the `c7-delivery` job from `07e` with SEO panel/proxy, persisted parity, observability, cache fake-clock, and focused Playwright gates.

- [ ] Update `CLAUDE.md` with the durable single-audit-source, no-reload panel, published metadata, signal allowlist, and no-stale/no-purge cache rules.

**Final gates**

```sh
pnpm check:ci-wiring
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
supabase test db supabase/tests/content_delivery_test.sql
pnpm test:forward-only-migrations
git diff --check
```

Expected: every command exits `0`.

**Commit**

```sh
git add .github/workflows/ci.yml CLAUDE.md
git commit -m "ci(delivery): gate SEO and cache contracts"
```

## Completion gate

C7.6 is complete only when:

- the editor panel is accessible and reruns without a page reload/draft loss;
- audit rules are actionable and unknown/malformed results fail safely;
- public canonical/meta/JSON-LD come from the persisted published contract;
- delivery/artifact signals are correlated and content-disciplined;
- the 60-second withdrawal/no-stale contract is machine-tested;
- no purge system or second audit/renderer/read path was introduced.

Then proceed to `2026-07-23-movp-stage-c-07i-editor-delivery-slice.md`.
