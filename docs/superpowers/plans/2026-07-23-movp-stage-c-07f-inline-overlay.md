# C7.4 — Privileged Inline Overlay TDD Implementation Plan

> **Executor contract:** Execute tasks in order. Every capability-policy edit must be proven through the direct database boundary and through its public surface. Do not weaken member-denial tests to make fixtures pass.

**Goal:** Make content authoring owner/admin-only at the database boundary, expose one canonical rich-text field mutation, and mount the existing editor SDK as an accessible in-place overlay only after an authenticated capability probe.

**Depends on:** `2026-07-23-movp-stage-c-07e-delivery-core.md`

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md` §§7–9.

**Architecture:** A forward-only migration adds `edit` to `has_content_capability` and replaces every CMS write policy that presently treats membership as authorship. The domain reads/validates/merges one rich-text field and delegates to the existing hash-first `ContentService.update`; GraphQL owns the reusable mutation and resolver log. The existing Astro rich-text proxy becomes a thin request-bound GraphQL adapter. Public bound markup carries no authorization state: a tiny standalone bootstrap performs a credentialed no-store probe and dynamically imports `@movp/editor-sdk/overlay` only when the server reports `canEdit:true`.

**No new external dependency:** The overlay reuses React, TipTap, `@movp/editor-sdk`, and existing frontend/runtime packages.

## Invariants

- Create only `supabase/migrations/20260723000002_content_edit_capability.sql`; never modify earlier migrations.
- `edit` means workspace role `owner` or `admin`. `member` and non-member are denied.
- Every content-originated edge (`src_type='content_item'`) requires `edit`, regardless of relation/destination.
- An inbound campaign `campaign_deliverable --produces--> content_item` edge remains governed by the existing campaign/member rule.
- `approve` and `publish` remain separate capabilities; `edit` alone cannot publish, unpublish, decide approval, or schedule publication.
- Service-role writes check the caller’s capability with the caller-bound client before the privileged write.
- `updateRichTextField` validates the field schema, merges one field, and calls `ContentService.update`. It never inserts a revision or reimplements canonical hashing.
- One GraphQL resolver request emits one `content.richtext_save_resolver` operational log. A created revision emits one existing `content.revision_created` domain event. The Astro proxy retains its separate `content.richtext_save` request log.
- Logs contain identifiers/outcome/safe code/latency only; never content, schema, hashes, URLs, tokens, cookies, emails, or previews.
- The overlay subpath remains client-safe and is covered by the recursive editor SDK boundary test.
- The public bootstrap has no static import path to editor SDK, React editor code, or TipTap.
- `canEdit` is advisory. `resolveEditable` and `save` remain authoritative server calls.
- Capability/read/save endpoints are `no-store`; save remains POST and same-origin protected.
- On errors/conflicts the editor preserves the local draft.
- All workerd dependencies/env/token/request ids are resolved from the active request at call time; never `process.env` or module capture.

## File map

**Create**

- `supabase/migrations/20260723000002_content_edit_capability.sql`
- `supabase/tests/content_edit_capability_test.sql`
- `packages/domain/test/content-richtext-field.test.ts`
- `packages/graphql/test/content-richtext-field.test.ts`
- `packages/graphql/test/content-richtext-observability.test.ts`
- `packages/editor-sdk/src/overlay.tsx`
- `packages/editor-sdk/src/overlay.css`
- `packages/editor-sdk/test/overlay.test.tsx`
- `templates/frontend-astro/src/components/delivery/overlay-bootstrap.ts`
- `templates/frontend-astro/src/lib/content-overlay.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/capability.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/editable.ts`
- `templates/frontend-astro/src/components/delivery/overlay-bootstrap.test.ts`
- `templates/frontend-astro/tests/e2e/overlay.spec.ts`

**Modify**

- `packages/domain/src/types.ts`
- `packages/domain/src/content.ts`
- `packages/domain/src/domain.ts`
- `packages/domain/src/index.ts`
- `packages/graphql/src/types.ts`
- `packages/graphql/src/schema.ts`
- `supabase/functions/graphql/index.ts`
- `supabase/functions/content-assets/index.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts`
- `templates/frontend-astro/src/pages/[contentType]/[slug].astro`
- `packages/editor-sdk/package.json`
- `packages/editor-sdk/src/index.ts`
- `packages/editor-sdk/test/boundary.test.ts`
- affected pgTAP/slice/gallery fixtures identified in Task 1
- `.github/workflows/ci.yml`
- `scripts/check-ci-wiring.mjs`
- `CLAUDE.md`

## Task 0: Verify exact commands and current write paths

- [ ] Run:

```sh
git status --short --branch
supabase status
supabase test db --help
deno check --help
pnpm --filter @movp/frontend-astro run
```

Expected: intended branch, this repo’s `6432x` local stack, available pgTAP
and Deno check runners, and frontend `test`, `typecheck`, `build`, `e2e`
scripts.

- [ ] Record the current seams:

```sh
rg -n "is_workspace_member|has_content_capability|create policy|alter policy" supabase/migrations supabase/functions packages/domain packages/graphql
rg -n "insert\\(|update\\(|delete\\(|\\.rpc\\(" packages/domain/src supabase/functions/content-assets
rg -n "content_item|content_revision|content_type|content_seo|content_collection|content_schedule|edges" scripts fixtures supabase/tests packages templates
```

Expected: the inventory includes `content_item_rw`, `edges_rw`, workflow/schedule policies, content assets, domain/GraphQL/MCP/CLI fixtures, `[content]`, `[campaigns]`, `[workflows]`, both Verdaccio gate families, demo seeds, and frontend identities.

Store the reviewed inventory in the implementation PR description. If a write seam is discovered that the policy matrix below does not cover, stop and extend the migration test before editing the migration.

**Gate:** no implementation begins until the inventory is complete and `supabase status` points at this repo.

## Task 1: Write the capability-matrix and directional-edge tests

**Red first**

- [ ] Create `content_edit_capability_test.sql` as a transaction with owner, admin, member, and non-member fixtures. Cover this matrix:

| Seam | owner/admin | member/non-member |
|---|---|---|
| content type insert/update/delete | allow | deny |
| content item insert/update/delete | allow | deny |
| revision insert | allow | deny |
| revision update/delete | deny | deny |
| submit approval | allow via `edit` | deny |
| decide approval | allow via `approve` | deny |
| publish/unpublish | allow via `publish` | deny |
| schedule/cancel | allow via `publish` | deny |
| asset issue/finalize DB mutation | allow via `edit` | deny |
| collection/entry write | allow | deny |
| SEO write | allow | deny |
| content-originated edge | allow | deny |
| inbound campaign `produces` edge | existing member allow | non-member deny |
| content comments/collaboration | existing rules | existing rules |

The edge regression must use direct PostgREST-equivalent SQL under `set local role authenticated` and JWT claims:

1. member insert `src_type='campaign_deliverable', rel='produces', dst_type='content_item'` succeeds;
2. same member insert `src_type='content_item', rel='references', dst_type='asset'` raises `42501`;
3. owner/admin content-originated insert succeeds;
4. an invented future relation with `src_type='content_item'` is also denied to member, proving relation-agnostic fail-closed behavior.

- [ ] Pin that `edit` does not authorize direct publication pointer/status changes or forged publish events.

- [ ] Run:

```sh
supabase test db supabase/tests/content_edit_capability_test.sql
```

Expected: **FAIL** because `edit` and replacement policies do not exist.

## Task 2: Add `edit` and replace every CMS write policy

- [ ] Create `20260723000002_content_edit_capability.sql`.

Redefine `public.has_content_capability(uuid,text)` without changing its `SECURITY INVOKER`/search-path/grant posture:

```text
edit    -> owner, admin
approve -> owner, admin
publish -> owner, admin
unknown -> false
```

- [ ] Replace—not stack permissive alternatives on—the write sides for:
  - `content_type`;
  - `content_item`;
  - `content_revision` insert only;
  - approval submit/decision;
  - publication workflow rows/events;
  - `content_schedule`;
  - `asset`;
  - `content_collection` and entries;
  - `content_seo`;
  - content-originated `edges`.

PostgreSQL combines permissive policies with OR. Therefore, drop/replace the old member-write policy before adding an `edit` policy; leaving the old policy in place is a bypass.

For `edges`, preserve the exact directional predicate in both `using` and `with check`:

```sql
src_type <> 'content_item'
or public.has_content_capability(workspace_id, 'edit')
```

Adapt column lookup to the real schema if `workspace_id` is reached through an existing helper. Never gate solely on `dst_type='content_item'`. UPDATE must authorize both the old row (`using`) and new row (`with check`) so a member cannot rewrite an inbound permitted edge into a content-originated edge.

- [ ] Keep reads and comments/collaboration unchanged.

- [ ] Update `content-assets` so both `issue` and `finalize`:
  1. authenticate the caller;
  2. resolve the target workspace with the caller-bound client;
  3. call `has_content_capability(...,'edit')` with that same caller-bound client;
  4. return stable `403 {error:'content_edit_forbidden'}` on false/error;
  5. only then create/use the service-role client for a privileged write.

Do not parse a client-supplied workspace for `finalize`; derive it from the caller-visible asset row. Add Edge unit/integration coverage proving the admin client is never invoked on denial.

**Green gates**

```sh
supabase db reset
supabase test db supabase/tests/content_edit_capability_test.sql
supabase test db
pnpm test:forward-only-migrations
deno check --no-lock supabase/functions/content-assets/index.ts
```

Expected: all pgTAP tests pass, historical migrations are unchanged, and the
Edge function typechecks. `content-assets` has no checked-in `deno.json`; do
not point it at an unrelated function's import map.

**Commit**

```sh
git add supabase/migrations/20260723000002_content_edit_capability.sql supabase/tests supabase/functions/content-assets
git commit -m "feat(content): enforce privileged edit capability"
```

## Task 3: Re-seed every affected authoring fixture

- [ ] Update each Task 0 fixture so the actor that authors CMS rows is owner/admin. Preserve member identities for negative coverage. Do not grant member broad write access.

- [ ] Update existing policy-name/count assertions after replacement.

- [ ] Run locally authoritative gates:

```sh
pnpm test:integration
pnpm check:task-cms-contracts
pnpm check:packages
bash scripts/slice-e2e.sh
```

Expected: all normal unit/integration/slice stages pass, including `[content]`, `[campaigns]`, and `[workflows]`.

- [ ] Run the non-flaky local Verdaccio stages named by the actual gate scripts (publish/install/codegen/db-reset). Do not invent flags. Read each `gate.sh --help` or its option parser first.

- [ ] Push and require CI to run the complete:
  - `fixtures/verdaccio-crm-lite/gate.sh`;
  - four `fixtures/verdaccio-gallery/gate.sh` templates.

Local Deno edge-serve BOOT_ERROR/timeouts are not authoritative for these gates. CI is authoritative for the full runtime. A publish/install/codegen/db-reset failure is still terminal locally.

**Gate:** the migration cannot land until full CI Verdaccio gates are green. Record the CI run URL in the PR.

**Commit**

```sh
git add scripts fixtures supabase/tests packages templates
git commit -m "test(content): update privileged author fixtures"
```

## Task 4: Add the one canonical `updateRichTextField` domain operation

**Red first**

- [ ] Create `packages/domain/test/content-richtext-field.test.ts`. Pin:
  - unknown/missing item and field return stable codes;
  - non-richtext field is rejected;
  - only the named field changes;
  - all other data keys remain byte/structurally equal;
  - normalized body flows through existing `prepare()`/hash-first update;
  - a new effective value saves and returns the revision id;
  - identical effective content with stale expected revision keeps the existing idempotent no-op success;
  - different content with stale expected revision returns `conflict`;
  - operational/database messages never appear in returned codes;
  - `ContentService.update` is called once; direct revision insert is never called.

- [ ] Run:

```sh
pnpm --filter @movp/domain test -- content-richtext-field.test.ts
```

Expected: **FAIL** because `updateRichTextField` is absent.

**Green implementation**

- [ ] Add:

```ts
export type RichTextFieldUpdateResult =
  | { status: 'saved'; revisionId: string }
  | { status: 'conflict' }
  | { status: 'error'; code: string }

export type RichTextFieldUpdateInput = Readonly<{
  itemId: string
  fieldKey: string
  body: string
  expectedRevisionId: string
}>
```

Add the method to the domain service interface and implementation. It performs one caller-bound item/current-revision/type read, validates `fieldKey` as richtext, merges one field, then delegates once to the existing `ContentService.update`.

Do not:

- insert into `content_revision`;
- call `update_content` separately;
- duplicate `prepare()` or canonical hashing;
- accept optional optimistic concurrency;
- use `any`.

**Gate**

```sh
pnpm --filter @movp/domain test
pnpm --filter @movp/domain typecheck
```

Expected: all domain tests pass; the new idempotency/conflict cases are present.

**Commit**

```sh
git add packages/domain
git commit -m "feat(domain): add rich text field update"
```

## Task 5: Expose GraphQL capability/read/save with canonical observability

**Red first**

- [ ] Create GraphQL shape tests for:
  - `contentCanEdit(itemId: ID!): Boolean!`;
  - `contentEditableRegion(itemId: ID!, fieldKey: String!): EditableRegion`;
  - `updateRichTextField(input: UpdateRichTextFieldInput!): RichTextFieldUpdateResult!`;
  - `CONFLICT` maps only from the domain conflict;
  - safe operational codes are allowlisted;
  - no content body appears in an error extension.

- [ ] Add `content-richtext-observability.test.ts`. A direct GraphQL request, with no Astro proxy, must emit exactly one resolver record for saved/conflict/error. It must assert the record’s exact allowlist and prove the submitted body/token are absent.

- [ ] Run:

```sh
pnpm --filter @movp/graphql test -- content-richtext-field.test.ts content-richtext-observability.test.ts
```

Expected: **FAIL** because schema/context fields are absent.

**Green implementation**

- [ ] Extend `GraphQLContext` with explicit fields:

```ts
export type ContentSaveOperationalEvent = Readonly<{
  requestId: string
  actorId: string
  itemId: string
  fieldKey: string
  outcome: 'saved' | 'conflict' | 'error'
  code?: string
  latencyMs: number
}>
```

and a `reportContentSave(event)` callback. Do not log inside a reusable package with ambient globals; invoke the injected reporter exactly once in a `finally`-owned resolver outcome path.

- [ ] In `supabase/functions/graphql/index.ts`, resolve `requestId` per request. Accept an incoming correlation header only if it is a valid UUID; otherwise generate `crypto.randomUUID()`. Pass it and a content-disciplined reporter into Yoga context at request time. Never capture the request id in module scope.

- [ ] Implement resolver behavior:
  - `contentCanEdit` resolves the item/workspace caller-bound, then checks `has_content_capability('edit')`; failure returns false and is separately reported at the Edge;
  - `contentEditableRegion` returns only validated `itemId`, `fieldKey`, canonical body, and current revision id after caller-bound access;
  - mutation calls the domain method once;
  - conflict uses sanitized `extensions.code='CONFLICT'`;
  - all responses are structurally stable.

- [ ] Prove event ownership:
  - new save: one resolver operational event + one DB `content.revision_created`;
  - idempotent no-op: one resolver event + no new DB revision event;
  - conflict: one resolver event + no DB revision event.

**Gate**

```sh
pnpm --filter @movp/graphql test
pnpm --filter @movp/graphql typecheck
pnpm --filter @movp/domain test
deno check --no-lock --config supabase/functions/graphql/deno.json supabase/functions/graphql/index.ts
```

Expected: all commands exit `0`; direct GraphQL observability test reports exactly one safe record per request.

**Commit**

```sh
git add packages/graphql supabase/functions/graphql packages/domain
git commit -m "feat(graphql): expose rich text field editing"
```

## Task 6: Convert the Astro route to a thin request-bound proxy

**Red first**

- [ ] Extend `richtext.test.ts` to pin:
  - proxy calls GraphQL `updateRichTextField`, not domain/Supabase directly;
  - it forwards a generated UUID correlation header;
  - it resolves `readServerEnv()` and HttpOnly token during each request;
  - it retains Astro origin checking and bounded request parsing;
  - conflict and safe error mappings match the existing client contract;
  - response is `no-store`;
  - exactly one `content.richtext_save` proxy log remains;
  - the proxy log and resolver log correlate but are not duplicate domain events.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- 'src/pages/api/content/[id]/richtext.test.ts'
```

Expected: **FAIL** on the new GraphQL/correlation assertions.

**Green implementation**

- [ ] Refactor only the server call. Preserve request/body bounds, session handling, response shape, and pinned proxy event name.

The handler body must call `readServerEnv()` and read the session cookie inside the request. It may pass those values down explicit call parameters for that request; it must not install them in a singleton or module closure.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test -- 'src/pages/api/content/[id]/richtext.test.ts'
pnpm --filter @movp/frontend-astro typecheck
```

Expected: focused route suite and typecheck pass.

**Commit**

```sh
git add templates/frontend-astro/src/pages/api/content
git commit -m "refactor(frontend): proxy rich text saves through graphql"
```

## Task 7: Add the client-safe overlay subpath

**Red first**

- [ ] Add `overlay.test.tsx` with jsdom cases for:
  - scans only nodes with both valid binding attributes;
  - deduplicates identical regions;
  - invalid ids/keys produce no call/chrome;
  - advisory `canEdit:false` produces no chrome;
  - Enter and Space open; Escape closes and restores focus;
  - controls are named by field, keyboard reachable, and at least 44px;
  - reduced motion disables animated transitions;
  - save reuses `MovpEditor` and advances revision id;
  - conflict keeps the draft and exposes existing non-destructive actions;
  - known safe error code maps to an actionable allowlisted `role=alert` message;
  - unknown code renders generic text, never the raw code;
  - resolve/save failure preserves draft;
  - `destroy()` removes roots/listeners/timers and is idempotent.

- [ ] Extend the existing recursive boundary and public-surface tests to include the `./overlay` export.

- [ ] Run:

```sh
pnpm --filter @movp/editor-sdk test -- overlay.test.tsx boundary.test.ts public-surface.test.ts
```

Expected: **FAIL** because the subpath is absent.

**Green implementation**

- [ ] Implement the approved interfaces exactly as specified in §9.1, including:

```ts
{ status: 'error'; code: string }
```

Validate DOM values at the boundary. Keep the error-message mapping internal and allowlisted. Do not render codes verbatim.

- [ ] Change editor SDK build/export configuration to two entries:
  - `.`;
  - `./overlay`.

Published `package.json` mappings must point at `dist/index` and `dist/overlay`. The overlay may import the package’s internal editor files, but no server package/Supabase/env.

**Gate**

```sh
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm --filter @movp/editor-sdk build
pnpm check:packages
```

Expected: full editor SDK green; both declaration/JS entrypoints exist in the packed artifact.

**Commit**

```sh
git add packages/editor-sdk
git commit -m "feat(editor-sdk): add accessible overlay subpath"
```

## Task 8: Add the probe-first dynamic-import host

**Red first**

- [ ] Add route tests for:
  - capability without/invalid session returns `200 {canEdit:false}` and `no-store`;
  - member returns false; owner/admin returns true;
  - editable resolution is authenticated and returns only the approved region fields;
  - save is POST-only/same-origin and uses the existing thin rich-text route;
  - upstream failure fails closed and emits one safe server event.

- [ ] Add `overlay-bootstrap.test.ts` that parses/import-analyzes the bootstrap source and built manifest. Pin:
  - no static import/re-export/reference to editor SDK/TipTap/React editor code;
  - dynamic import occurs only after an exact `{canEdit:true}` response;
  - missing/false/malformed/error response never imports;
  - capability request is same-origin, credentialed, and `cache:'no-store'`.

- [ ] Add Playwright `overlay.spec.ts` for authorized keyboard edit/save/conflict/error/focus/reduced-motion/axe and anonymous no-chrome.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- overlay-bootstrap.test.ts
```

Expected: **FAIL** because bootstrap/routes do not exist.

**Green implementation**

- [ ] Implement request-time server adapters in `src/lib/content-overlay.ts`. Keep tokens server-side; browser calls same-origin routes only.

- [ ] Add the tiny bootstrap to the typed public page. It reads one validated bound item id and probes capability. Only the true branch executes:

```ts
const { mountOverlay } = await import('@movp/editor-sdk/overlay')
```

Do not add a browser-readable auth hint cookie.

- [ ] Set all operational endpoint responses `Cache-Control: no-store`. The public page remains cacheable and invariant across sessions.

**Bundle/performance gate**

```sh
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro test -- overlay-bootstrap.test.ts
pnpm --filter @movp/frontend-astro e2e -- --grep "inline overlay"
```

Expected:

- anonymous network trace has the bootstrap/probe but no overlay/editor/TipTap chunk;
- owner/admin trace loads the lazy chunk after a true probe;
- forced client-side import/chrome cannot save as member because GraphQL/RLS denies it;
- keyboard and axe cases pass.

**Commit**

```sh
git add templates/frontend-astro
git commit -m "feat(frontend): mount privileged inline editor overlay"
```

## Task 9: Wire CI and document the durable boundary

- [ ] Extend `c7-editor-sdk` and/or add a required `c7-inline-overlay` job for:
  - editor SDK full suite/build/package boundary;
  - domain/GraphQL rich-text tests;
  - frontend bootstrap unit/build/Playwright;
  - capability pgTAP.

- [ ] Update `scripts/check-ci-wiring.mjs` first so the missing job fails, then add the workflow.

- [ ] Update `CLAUDE.md` with:
  - owner/admin `edit` matrix and directional edge rule;
  - canonical hash-first writer;
  - three distinct signal owners;
  - probe-first/no-anon-editor-chunk rule;
  - request-time workerd dependency rule at the overlay host.

**Final gates**

```sh
pnpm check:ci-wiring
pnpm --filter @movp/domain test
pnpm --filter @movp/domain typecheck
pnpm --filter @movp/graphql test
pnpm --filter @movp/graphql typecheck
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm --filter @movp/editor-sdk build
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
supabase test db supabase/tests/content_edit_capability_test.sql
pnpm test:forward-only-migrations
git diff --check
```

Expected: every command exits `0`. Full Verdaccio and full overlay browser gates are required green in CI as described above.

**Commit**

```sh
git add .github/workflows/ci.yml scripts/check-ci-wiring.mjs CLAUDE.md
git commit -m "ci(editor): gate privileged inline overlay"
```

## Completion gate

This part is complete only when:

- every authoring seam is inventoried and owner/admin-gated;
- direct member PostgREST/RPC bypass attempts fail;
- inbound campaign `produces` remains member-writable;
- service-role asset writes precheck caller-bound `edit`;
- the mutation delegates to the existing hash-first writer;
- resolver/proxy/domain-event ownership tests are exact;
- anonymous pages cannot reach the editor chunk;
- forced client chrome still cannot bypass GraphQL/RLS;
- overlay keyboard, focus, reduced-motion, error, conflict, draft-retention, and axe gates pass;
- full CI fixture gates are green.

Then proceed to `2026-07-23-movp-stage-c-07g-realtime.md`. Do not claim the reference editor has Realtime; C7.5 remains a separate headless primitive/fixture.
