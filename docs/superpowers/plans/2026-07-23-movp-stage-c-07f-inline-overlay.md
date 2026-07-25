# C7.4 — Privileged Inline Overlay TDD Implementation Plan

> **Executor contract:** Execute tasks in order. Every capability-policy edit must be proven through the direct database boundary and through its public surface. Do not weaken member-denial tests to make fixtures pass.

**Goal:** Make content authoring owner/admin-only at the database boundary, expose one canonical rich-text field mutation, and mount the existing editor SDK as an accessible in-place overlay only after an authenticated capability probe.

**Depends on:** `2026-07-23-movp-stage-c-07e-delivery-core.md`

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md` §§7–9.

**Architecture:** A forward-only migration adds `edit` to `has_content_capability` and replaces every CMS write policy that presently treats membership as authorship. The domain reads/validates/merges one rich-text field and delegates to the existing hash-first `ContentService.update`; GraphQL owns the reusable mutation and resolver log. The existing Astro rich-text route keeps its authoritative GET region resolver and becomes a one-request GraphQL adapter for POST saves. Public bound markup carries no authorization state: a tiny standalone bootstrap waits for the first pointer, keyboard, or focus interaction, performs a credentialed no-store probe, and dynamically imports `@movp/editor-sdk/overlay` only when the server reports `canEdit:true`.

**No new external dependency:** The overlay reuses React, TipTap, `@movp/editor-sdk`, and existing frontend/runtime packages.

## Invariants

- Create only `supabase/migrations/20260723000002_content_edit_capability.sql`; never modify earlier migrations.
- `edit` means workspace role `owner` or `admin`. `member` and non-member are denied.
- Every content-originated edge (`src_type='content_item'`) requires `edit`, regardless of relation/destination.
- An inbound campaign `campaign_deliverable --produces--> content_item` edge remains governed by the existing campaign/member rule.
- `approve` and `publish` remain separate capabilities; `edit` alone cannot publish, unpublish, decide approval, or schedule publication.
- Approval votes require `approve`; workspace membership alone is never sufficient.
- Service-role writes check the caller’s capability with the caller-bound client before the privileged write.
- `updateRichTextField` validates the field schema, merges one field, and calls `ContentService.update`. It never inserts a revision or reimplements canonical hashing.
- One GraphQL resolver request emits one `content.richtext_save_resolver` operational log. A created revision emits one existing `content.revision_created` domain event. The Astro proxy retains its separate `content.richtext_save` request log.
- Logs contain identifiers/outcome/safe code/latency only; never content, schema, hashes, URLs, tokens, cookies, emails, or previews.
- The overlay subpath remains client-safe and is covered by the recursive editor SDK boundary test.
- The public bootstrap has no static import path to editor SDK, React editor code, or TipTap.
- An anonymous page with no pointer, keyboard, or focus interaction makes no capability request. The first interaction starts at most one probe sequence.
- `canEdit` is advisory. `resolveEditable` and `save` remain authoritative server calls.
- Capability/read/save endpoints are `no-store`; save remains POST and same-origin protected.
- On errors/conflicts the editor preserves the local draft.
- All workerd dependencies/env/token/request ids are resolved from the active request at call time; never `process.env` or module capture.

## File map

**Create**

- `supabase/migrations/20260723000002_content_edit_capability.sql`
- `supabase/tests/content_edit_capability_test.sql`
- `supabase/functions/content-assets/index.test.ts`
- `supabase/functions/content-assets/handler.ts`
- `packages/domain/test/content-richtext-field.test.ts`
- `packages/graphql/test/content-richtext-field.test.ts`
- `packages/graphql/test/content-richtext-observability.test.ts`
- `packages/editor-sdk/src/overlay.tsx`
- `packages/editor-sdk/src/overlay.css`
- `packages/editor-sdk/test/overlay.test.tsx`
- `templates/frontend-astro/src/components/delivery/overlay-bootstrap.ts`
- `templates/frontend-astro/src/lib/content-overlay.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/capability.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/capability.test.ts`
- `templates/frontend-astro/src/components/delivery/overlay-bootstrap.test.ts`
- `templates/frontend-astro/src/pages/[contentType]/delivery-headers.test.ts`
- `templates/frontend-astro/scripts/check-overlay-bundle.mjs`
- `templates/frontend-astro/tests/e2e/overlay.spec.ts`

**Modify**

- `packages/domain/src/types.ts`
- `packages/domain/src/content.ts`
- `packages/domain/src/domain.ts`
- `packages/domain/src/index.ts`
- `packages/graphql/src/types.ts`
- `packages/graphql/src/schema.ts`
- `packages/graphql/test/schema.test.ts`
- `packages/mcp/test/surface-wiring.test.ts`
- `supabase/functions/graphql/index.ts`
- `supabase/functions/content-assets/index.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.ts`
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts`
- `templates/frontend-astro/src/pages/[contentType]/[slug].astro`
- `templates/frontend-astro/tests/e2e/delivery.spec.ts`
- `packages/editor-sdk/package.json`
- `packages/editor-sdk/src/editor.tsx`
- `packages/editor-sdk/src/index.ts`
- `packages/editor-sdk/test/boundary.test.ts`
- `packages/editor-sdk/test/tiptap-jsdom-smoke.test.tsx`
- `scripts/check-package-artifacts.mjs`
- `scripts/slice-e2e.sh`
- `templates/frontend-astro/tests/mock/graphql-mock.mjs`
- affected pgTAP/slice/gallery fixtures identified in Task 1
- `.github/workflows/ci.yml`
- `scripts/check-ci-wiring.mjs`
- `scripts/test/check-ci-wiring.test.mjs`
- `CLAUDE.md`
- `docs/agents/task-cms-data-contract.md`

## Task 0: Verify exact commands and current write paths

- [ ] Run:

```sh
git status --short --branch
supabase status
supabase test db --help
supabase functions serve --help
deno check --help
pnpm --filter @movp/frontend-astro run
test -f scripts/check-integration-smoke.mjs
test -f scripts/integration-smoke-http.test.mjs
test -f scripts/slice-e2e.sh
```

Expected: intended branch, this repo’s `6432x` local stack, available pgTAP
and Deno check runners, the all-functions `--env-file` serve contract, frontend
`test`, `typecheck`, `build`, and `e2e` scripts, and all three named integration
gate files. There is no root `test:integration` script; do not invent one.

- [ ] Record the current seams:

```sh
rg -n "is_workspace_member|has_content_capability|create policy|alter policy" supabase/migrations supabase/functions packages/domain packages/graphql
rg -n "insert\\(|update\\(|delete\\(|\\.rpc\\(" packages/domain/src supabase/functions/content-assets
rg -n "content_item|content_revision|content_type|content_seo|content_collection|content_schedule|edges" scripts fixtures supabase/tests packages templates
```

Expected: the inventory includes `content_item_rw`, `edges_rw`, workflow/schedule policies, content assets, domain/GraphQL/MCP/CLI fixtures, `[content]`, `[campaigns]`, `[workflows]`, both Verdaccio gate families, demo seeds, and frontend identities.

Store the reviewed inventory in the implementation PR description. If a write seam is discovered that the policy matrix below does not cover, stop and extend the migration test before editing the migration.

The PR description is a human-readable record, not the completeness gate. Task
1 must also compare the live `pg_policies` CMS write-policy inventory to an
exact expected allowlist before migration work begins.

**Gate:** no implementation begins until the catalog inventory test is red for
the intended missing/replaced policies and `supabase status` points at this
repo.

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
| insert approval vote | allow via `approve` | deny |
| publish/unpublish | allow via `publish` | deny |
| schedule/cancel | allow via `publish` | deny |
| asset issue/finalize DB mutation | allow via `edit` | deny |
| collection/entry write | allow | deny |
| SEO write | allow | deny |
| content-originated edge | allow | deny |
| inbound campaign `produces` edge | existing member allow | non-member deny |
| content comments/collaboration | existing rules | existing rules |

Preserve and pin the caller-identity side of the write boundary:

- `content_revision.author_id = auth.uid()`;
- `content_approval_vote.voter_id = auth.uid()`;
- `content_publish_event.actor_id = auth.uid()`;
- `content_schedule.scheduled_by = auth.uid()`.

The last three are intentional anti-impersonation tightenings over the previous
membership-only policies. Add direct denial cases proving an owner/admin cannot
submit another user's voter, publisher, or scheduler identity.

The edge regression must use direct PostgREST-equivalent SQL under `set local role authenticated` and JWT claims:

1. member insert `src_type='campaign_deliverable', rel='produces', dst_type='content_item'` succeeds;
2. same member insert `src_type='content_item', rel='references', dst_type='asset'` raises `42501`;
3. owner/admin content-originated insert succeeds;
4. an invented future relation with `src_type='content_item'` is also denied to member, proving relation-agnostic fail-closed behavior.

- [ ] Pin that `edit` does not authorize direct publication pointer/status changes or forged publish events.

- [ ] Build an exact catalog allowlist over `pg_policies` for the CMS authoring
  tables. Each row pins `{tablename, cmd, policyname, capability}` and asserts
  the required capability literal appears in the applicable `qual` and/or
  `with_check`. The expected mapping is:
  - `content_type`, `content_item`, `content_revision` INSERT,
    `content_approval` INSERT, `asset`, `content_collection`,
    `content_collection_entry`, and `content_seo` -> `edit`;
  - `content_approval` UPDATE and `content_approval_vote` INSERT -> `approve`;
  - `content_publish_event` INSERT and `content_schedule` writes -> `publish`;
  - content-originated `edges` writes -> the conditional `edit` predicate.

  The test must also fail if any INSERT/UPDATE/DELETE policy on that exact CMS
  table set is absent from or extra to the allowlist. SELECT policies and the
  explicitly unchanged collaboration tables are outside that comparison.
  Derive the complete set of capability literals in each policy and require it
  to equal the expected singleton. Sabotage proofs: replacing the
  `content_schedule` capability literal with `edit`, or OR-ing an additional
  `edit` check into its `publish` policy, must fail even though owner/admin
  behavior is otherwise identical.

  Policy names use `<table>_<capability>_<command>`, for example
  `content_item_edit_insert`, `content_approval_vote_approve_insert`, and
  `content_schedule_publish_update`. The conditional edge policies use
  `edges_content_edit_<command>`. Declare the full expected names in the red
  catalog fixture before writing the migration so test and implementation do
  not invent separate naming schemes.

- [ ] Pin `has_content_capability(uuid,text)` in the catalogs:
  - `prosecdef = true` (`SECURITY DEFINER`);
  - configured `search_path` is exactly empty;
  - `PUBLIC` and `anon` have no execute grant;
  - `authenticated` has execute;
  - an unknown capability returns false.

- [ ] Run:

```sh
supabase test db supabase/tests/content_edit_capability_test.sql
```

Expected: **FAIL** because `edit` and replacement policies do not exist.

## Task 2: Add `edit` and replace every CMS write policy

- [ ] Create `20260723000002_content_edit_capability.sql`.

Redefine `public.has_content_capability(uuid,text)` without changing its existing `SECURITY DEFINER`, `set search_path = ''`, or least-privilege grant posture:

```text
edit    -> owner, admin
approve -> owner, admin
publish -> owner, admin
unknown -> false
```

Do not remove the definer posture. The helper is called from content RLS and
must retain that audited boundary while deriving identity only from
`auth.uid()`. The Task 1 catalog assertions are the regression gate.

- [ ] Replace—not stack permissive alternatives on—the write sides for:
  - `content_type` -> `edit`;
  - `content_item` -> `edit`;
  - `content_revision` insert only -> `edit`;
  - approval submit -> `edit`;
  - approval decision and `content_approval_vote` insert -> `approve`;
  - publication workflow rows/events -> `publish`;
  - `content_schedule` -> `publish`;
  - `asset` -> `edit`;
  - `content_collection` and entries -> `edit`;
  - `content_seo` -> `edit`;
  - content-originated `edges` -> conditional `edit`.

Keep the identity columns caller-bound in the same policies:
`content_approval_vote.voter_id`, `content_publish_event.actor_id`, and
`content_schedule.scheduled_by` must equal `auth.uid()`; the existing
`content_revision.author_id = auth.uid()` check remains unchanged.

PostgreSQL combines permissive policies with OR. Therefore, drop/replace the old member-write policy before adding an `edit` policy; leaving the old policy in place is a bypass.

For ordinary CMS UPDATE policies, keep member visibility in
`using (public.is_workspace_member(workspace_id))` and put the required
capability in `with check`. This makes a direct member update fail loudly with
`42501` instead of succeeding as a zero-row no-op. DELETE has no `with check`,
so its unauthorized zero-row behavior is structural and must be documented.

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
  4. return stable `403 {error:'content_edit_forbidden'}` only on an explicit
     false result;
  5. map an operational capability-check failure to
     `500 {error:'content_edit_check_failed'}` and a bounded timeout to `503`
     with the same safe code, emitting exactly one content-disciplined event
     with `workspace_id_hash` and bounded
     `reason:'transport'|'timeout'`;
  6. only then create/use the service-role client for a privileged write.

Do not parse a client-supplied workspace for `finalize`; derive it from the caller-visible asset row. Add Edge unit/integration coverage proving the admin client is never invoked on denial.
The admin client must also never be constructed on a capability transport
error or timeout. Tests must distinguish denial, operational failure, timeout,
and success by status/code.

**Green gates**

```sh
supabase db reset
supabase test db supabase/tests/content_edit_capability_test.sql
supabase test db
pnpm test:forward-only-migrations
deno test --no-lock supabase/functions/content-assets/index.test.ts
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
pnpm test
node --test scripts/integration-smoke-http.test.mjs
pnpm check:task-cms-contracts
pnpm build
pnpm check:packages
```

Expected: all workspace unit, self-contained HTTP, contract, build, and package
stages pass. `pnpm build` immediately precedes the package gate so every packed
`dist/` is current.

- [ ] Run the served-stack integration smoke with the same environment-file
  contract as the required `integration-smoke` CI job. Run this before
  `slice-e2e.sh`; each command owns one function server at a time.

```sh
(
  set -euo pipefail
  if pgrep -f 'supabase.*functions serve|edge-runtime' >/dev/null; then
    echo 'integration smoke: an existing local edge runtime is active; stop and identify it before continuing'
    exit 1
  fi
  eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
  FN_ENV_FILE="$(mktemp)"
  FN_LOG_FILE="$(mktemp)"
  printf 'MOVP_JWT_ISSUER=%s/auth/v1\n' "$API_URL" >"$FN_ENV_FILE"
  supabase functions serve --env-file "$FN_ENV_FILE" >"$FN_LOG_FILE" 2>&1 &
  FN_PID=$!
  cleanup() {
    kill "$FN_PID" 2>/dev/null || true
    rm -f "$FN_ENV_FILE" "$FN_LOG_FILE"
  }
  trap cleanup EXIT
  ready=0
  for _ in $(seq 1 20); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/auth-exchange" \
      -H "apikey: $ANON_KEY" -H 'Authorization: Bearer invalid' \
      -H 'content-type: application/json' -d '{}' || true)"
    if [ "$status" = '401' ]; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    tail -n 100 "$FN_LOG_FILE"
    exit 1
  fi
  node scripts/check-integration-smoke.mjs || {
    tail -n 100 "$FN_LOG_FILE"
    exit 1
  }
) && bash scripts/slice-e2e.sh
```

Expected: `integration-smoke: PASS`. The temporary env and log files are
removed when the subshell returns, the executor's interactive shell remains
active on failure, and no credential is placed in argv. Then all slice stages
pass, including `[content]`, `[campaigns]`, and `[workflows]`. The current
slice already authors as the owner at its primary content seam and keeps USER2
as a member and USER3 as a non-member; re-seed only a fixture that the Task 0
inventory proves is different.

Keep `MOVP_CLEAN_EDGE_RUNTIME` unset by default. If the preflight finds a
process, identify its owning project rather than killing it; rerun with
`MOVP_CLEAN_EDGE_RUNTIME=1` only after explicit operator approval. The
subshell completes before `slice-e2e.sh` starts its own function server.

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
  - `updateRichTextField(input: UpdateRichTextFieldInput!): RichTextFieldUpdateResult!`;
  - `CONFLICT` maps only from the domain conflict;
  - safe operational codes are allowlisted;
  - no content body appears in an error extension.

- [ ] Update `packages/graphql/test/schema.test.ts` as the numeric/signature
  secondary check. The checked-in pre-change schema has 86 query fields and 74
  mutation fields; after one query and one mutation it must pin exactly 87
  queries and 75 mutations, plus the two exact field names/signatures above.

- [ ] Update the authoritative exact-set inventory in
  `packages/mcp/test/surface-wiring.test.ts`: add `contentCanEdit` to
  `customGraphqlQueries` and `updateRichTextField` to
  `customGraphqlMutations`. Do not add an editable-region query; the existing
  authenticated rich-text GET route already owns that read.

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
  - mutation calls the domain method once;
  - conflict uses sanitized `extensions.code='CONFLICT'`;
  - all responses are structurally stable.

- [ ] Now that the mutation exists, extend the existing `[content]` HTTP slice
  with a real member-token `updateRichTextField` denial. The GraphQL request
  must fail with the stable safe authorization contract while Task 1's direct
  SQL assertion proves the underlying RLS boundary. This is the real-stack
  forced-chrome/save bypass gate; mock-backed Playwright must not claim to test
  RLS.

- [ ] Prove event ownership:
  - new save: one resolver operational event + one DB `content.revision_created`;
  - idempotent no-op: one resolver event + no new DB revision event;
  - conflict: one resolver event + no DB revision event.

**Gate**

```sh
pnpm --filter @movp/graphql test
pnpm test:graphql-shape
pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts
pnpm --filter @movp/graphql typecheck
pnpm --filter @movp/domain test
deno check --no-lock --config supabase/functions/graphql/deno.json supabase/functions/graphql/index.ts
bash scripts/slice-e2e.sh
```

Expected: all commands exit `0`; the schema reports 87 query and 75 mutation
fields, the exact-set surface diff is `{missing:[], unexpected:[]}`, and the direct GraphQL observability test reports
exactly one safe record per request.

**Commit**

```sh
git add packages/graphql packages/mcp/test/surface-wiring.test.ts supabase/functions/graphql packages/domain scripts/slice-e2e.sh
git commit -m "feat(graphql): expose rich text field editing"
```

## Task 6: Convert the Astro route to a thin request-bound proxy

**Red first**

- [ ] Extend `richtext.test.ts` to pin:
  - POST replaces the current `CONTENT_ITEM_QUERY` plus `updateContent`
    read/merge/write sequence with exactly one upstream GraphQL request whose
    operation is `updateRichTextField`;
  - GET retains the current validated region read contract;
  - it generates one UUID at handler entry and forwards that exact value as the
    correlation header;
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

- [ ] Refactor only the POST server call. Delete POST-only schema parsing,
  current-data merge logic, `CONTENT_ITEM_QUERY`, and `updateContent` usage;
  preserve the GET read path, request/body bounds, session handling, response
  shape, and pinned proxy event name.

- [ ] Generate one `requestId` at handler entry. Pass that same value into
  `emit(...)` and the forwarded request-id header. The test must compare the
  logged `request_id` to the outbound header for the same request; checking
  that each is merely UUID-shaped is insufficient.

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

- [ ] Extend `boundary.test.ts` with a guarded recursive source assertion for
  the strict-CSP coupling: every `StarterKit` construction under
  `packages/editor-sdk/src/` must configure `dropcursor: false`. The existing
  walk must keep its lstat/symlink rejection and size-before-read bounds, and
  a newly added source file must be covered automatically. Align
  `tiptap-jsdom-smoke.test.tsx` with the same configured StarterKit posture so
  test and production editors do not model different extension sets.
  Sabotage proof: replacing the production configuration with bare
  `StarterKit` makes the SDK unit suite fail without a browser.

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

- [ ] Disable StarterKit's optional inline-style Dropcursor in the shared
  editor configuration:

```ts
StarterKit.configure({ dropcursor: false })
```

Gapcursor and overlay chrome remain class/stylesheet-based. Do not weaken the
public CSP for an optional decoration plugin. Existing editor behavior and the
overlay browser suite are the regression gates.

This intentionally removes the drag-and-drop position indicator from the
existing CMS editor as well as the overlay; ordinary editing, dragging, save,
and conflict behavior remain supported. The shared change keeps one editor
configuration and one CSP invariant instead of introducing an overlay-only
editor fork. The SDK suite and existing CMS editor browser tests must remain
green.

- [ ] Change editor SDK build/export configuration to two entries:
  - `.`;
  - `./overlay`.

`overlay.tsx` imports `overlay.css`, and the Vite/Astro lazy chunk loads that
CSS as a same-origin stylesheet. The source manifest keeps source exports for
workspace development while `publishConfig.exports['./overlay']` points to
`dist/overlay.js`/`dist/overlay.d.ts`; the root build uses both
`src/index.ts` and `src/overlay.tsx` as explicit tsup entries. The overlay may
import the package’s internal editor files, but no server
package/Supabase/env.

- [ ] Extend `scripts/check-package-artifacts.mjs` so the packed
  `@movp/editor-sdk` tarball must contain `package/dist/overlay.js`,
  `package/dist/overlay.d.ts`, and `package/dist/overlay.css`, and both packed
  exports must point at `/dist/`, never `/src/`.

**Gate**

```sh
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm --filter @movp/editor-sdk build
pnpm build
pnpm check:packages
```

Expected: full editor SDK green; root and overlay declaration/JS entrypoints
plus `dist/overlay.css` exist in the freshly built packed artifact.

**Commit**

```sh
git add packages/editor-sdk scripts/check-package-artifacts.mjs
git commit -m "feat(editor-sdk): add accessible overlay subpath"
```

## Task 8: Add the probe-first dynamic-import host

**Red first**

- [ ] Add route tests for:
  - capability without/invalid session returns `200 {canEdit:false}` and `no-store`;
  - member returns false; owner/admin returns true;
  - the existing rich-text GET remains authenticated and returns only
    `{body,revisionId}` for the approved region;
  - save is POST-only/same-origin and uses that same thin rich-text route;
  - upstream failure fails closed and emits one safe server event.

- [ ] Add `overlay-bootstrap.test.ts` as a source-only test. It must not read
  `dist/`, an Astro/Vite manifest, or any build output. Parse/import-analyze
  only the bootstrap and its source graph, and pin:
  - no static import/re-export/reference to editor SDK/TipTap/React editor code;
  - no probe occurs before the first pointer, keyboard, or focus interaction;
  - dynamic import occurs only after an exact `{canEdit:true}` response;
  - missing/false/malformed/error response never imports;
  - capability request is same-origin, credentialed, and `cache:'no-store'`;
  - an explicit false is cached in `sessionStorage` for 60 seconds across
    delivery-page navigations, while true/malformed/operational results are
    never negative-cached;
  - `resolveEditable` calls the existing
    `/api/content/[id]/richtext?fieldKey=...` GET; no duplicate editable route
    exists.

- [ ] Add `scripts/check-overlay-bundle.mjs` as the explicitly
  build-dependent gate. It guarded-reads the built manifest/chunk graph only
  after `astro build`, with lstat/symlink rejection and size bounds before
  every read. Pin that the bootstrap chunk has no static path to
  editor/React/TipTap chunks, that the overlay is a separate lazy chunk, and
  that its stylesheet is emitted. Do not name this file `*.test.*`: the
  existing `c7-delivery` job intentionally runs the default frontend Vitest
  suite before build, so default discovery must never collect a
  build-dependent assertion.

- [ ] Extend `tests/mock/graphql-mock.mjs` only for the new capability query and
  rich-text mutation. The mock is transport/UX scaffolding, not evidence of
  RLS.

- [ ] Add Playwright `overlay.spec.ts` with the exact outer title
  `test.describe('inline overlay', ...)` so the focused gate cannot select zero
  tests. Cover authorized keyboard
  edit/save/conflict/error/focus/reduced-motion/axe and anonymous no-chrome.
  Register a console/CSP-violation listener, assert the owner/admin probe
  response is 200, and fail on any CSP violation. The first interaction is a
  deliberate priming interaction, not an edit request: perform it, await the
  chrome, then use a second click/keypress to open the editor.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- overlay-bootstrap.test.ts
```

Expected: **FAIL** because bootstrap/routes do not exist.

**Green implementation**

- [ ] Implement request-time server adapters in `src/lib/content-overlay.ts`. Keep tokens server-side; browser calls same-origin routes only.

- [ ] Add the tiny bundled-module bootstrap to the typed public page; it must
  not be `is:inline`. It reads one validated bound item id but waits for the
  first `pointerdown`, `keydown`, or `focusin` before probing capability.
  Remove the three listeners once a probe sequence starts. Only the true
  branch executes:

```ts
const { mountOverlay } = await import('@movp/editor-sdk/overlay')
```

Do not add a browser-readable auth hint cookie.

- [ ] Set all operational endpoint responses `Cache-Control: no-store`. The public page remains cacheable and invariant across sessions.

- [ ] Create
  `src/pages/[contentType]/delivery-headers.test.ts` using the established
  guarded-source-read pattern: `lstat`, reject symlinks/non-files, enforce a
  512 KiB size bound before `readFileSync`, and compare the entire CSP source
  literal byte-for-byte. Also extend `tests/e2e/delivery.spec.ts` to compare
  the actual response header byte-for-byte. These independently pin source
  intent and the header sent by the Worker.

- [ ] Extend the delivery-page CSP to this exact strict value:

```text
default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src https: data:; script-src 'self'; connect-src 'self'; style-src 'self'
```

`connect-src 'self'` permits only the same-origin capability/read/save calls.
`style-src 'self'` permits the emitted overlay stylesheet. No
`style-src-attr` exception is allowed: Task 7 disables Dropcursor, and the
Playwright CSP listener must fail if another component introduces an inline
style. Add an exception only through a later reviewed design/test that names
the exact unavoidable component.

- [ ] Retry the capability probe exactly once only after a thrown transport
  failure or 502/503/504. Explicit false, 4xx, or malformed responses are
  terminal and fail closed. After retry exhaustion, emit only
  `console.warn('content_overlay_capability_probe_failed')` and render no
  chrome; do not show a misleading authorization message or include response
  content. An owner/admin can retry by reloading or interacting in a new page.

- [ ] After an exact `{canEdit:false}` response, store only a boolean-negative
  marker and expiry in same-origin `sessionStorage`, with a hard 60-second TTL.
  A valid unexpired marker skips the probe and import on later delivery pages
  in that tab. Store no item/user/workspace identifier, token, or response
  body. Never cache malformed responses, 4xx shapes other than the endpoint's
  exact false contract, 5xx, timeouts, or thrown failures. The bound limits an
  anonymous interacting tab to one successful negative probe per 60 seconds
  while allowing a newly signed-in editor to recover within the same bound.
  This identifier-free marker is valid only because the reference frontend is
  configured for one `WORKSPACE_ID` and `edit` is role-scoped to that single
  workspace. A future host serving multiple workspaces from one origin must
  key the marker by a validated workspace identifier or remove this cache
  before enabling that topology.

**Bundle/performance gate**

```sh
pnpm --filter @movp/frontend-astro test -- overlay-bootstrap.test.ts
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro exec node scripts/check-overlay-bundle.mjs
pnpm --filter @movp/frontend-astro exec playwright test --grep "inline overlay"
```

Expected:

- the source-only bootstrap test passes before a build on a clean checkout;
- the bundle gate runs only after build and proves the lazy chunk graph;
- anonymous, non-interacting navigation makes zero capability requests;
- the first interaction starts exactly one probe sequence (at most two HTTP
  attempts only for the bounded transient retry);
- that priming interaction never opens the editor; chrome appears
  asynchronously and the next explicit activation opens it;
- an interacting anonymous trace has the bootstrap/probe but no
  overlay/editor/TipTap chunk;
- a second delivery-page interaction in the same tab within 60 seconds uses
  the negative marker and makes no probe;
- owner/admin trace loads the lazy chunk after a true probe;
- keyboard and axe cases pass.

The member GraphQL/RLS denial is owned by Task 1 pgTAP and Task 5's real-stack
HTTP slice. Playwright proves only browser behavior against its GraphQL mock.

**Commit**

```sh
git add templates/frontend-astro
git commit -m "feat(frontend): mount privileged inline editor overlay"
```

## Task 9: Wire CI and document the durable boundary

- [ ] Add a required `c7-inline-overlay` job for:
  - editor SDK full suite/build/package boundary;
  - domain/GraphQL rich-text tests;
  - frontend source-only bootstrap unit test, build, bundle gate, and Playwright;
  - capability pgTAP.

- [ ] Update `scripts/check-ci-wiring.mjs` and its tests first so the missing
  job fails with `ci_wiring_job_missing`, then add the workflow. Append this
  exact `REQUIRED_JOBS['c7-inline-overlay'].runs` contract and use the same
  exact one-line `run:` commands in `.github/workflows/ci.yml`, in this order:

```text
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm --filter @movp/editor-sdk build
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts
pnpm --filter @movp/frontend-astro exec vitest run src/components/delivery/overlay-bootstrap.test.ts
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro exec node scripts/check-overlay-bundle.mjs
pnpm --filter @movp/frontend-astro exec playwright install --with-deps chromium
pnpm --filter @movp/frontend-astro exec playwright test --grep "inline overlay"
supabase start
supabase db reset
supabase test db supabase/tests/content_edit_capability_test.sql
```

The source-only test deliberately precedes the build; the bundle gate
deliberately follows it. `playwright install --with-deps chromium` is part of
the contract because the existing `frontend-ux` job proves the browser suite
needs it; a job that runs `e2e` without that step fails on a missing browser.

`runs` asserts commands only. The job still needs the same boilerplate as its
sibling jobs: `actions/checkout@v5`, `pnpm/action-setup@v6` with `9.12.0`,
`actions/setup-node@v6` with node 22 and the pnpm cache,
`pnpm install --frozen-lockfile`, and `supabase/setup-cli@v2` pinned to
`2.109.1`. `pnpm check:supabase-cli-pins` is the step-scoped pin gate for that
new setup step, so run it in the final gates.

The wiring unit test is `scripts/test/check-ci-wiring.test.mjs`, executed by
`pnpm test:version-gate` (`node --test`); use that command for the red step and
keep it in the final gates so the edited test actually runs. It must prove that
a missing job and each missing exact command fail with the stable `ci_wiring_*`
code; a similarly named command or a command in `c7-delivery` does not satisfy
the contract.

- [ ] Update `CLAUDE.md` with:
  - owner/admin `edit` matrix and directional edge rule;
  - canonical hash-first writer;
  - three distinct signal owners;
  - probe-first/no-anon-editor-chunk rule;
  - request-time workerd dependency rule at the overlay host.

Amend the existing anonymous-delivery instruction in place: public delivery
must never **statically** import editor/TipTap code, while the interaction-
deferred, capability-true branch is the sole allowed dynamic import. Do not
leave the old “not statically or dynamically” sentence beside the new rule.

- [ ] Update `docs/agents/task-cms-data-contract.md` so the shared access
  convention says membership grants reads while CMS authoring additionally
  requires the owner/admin `edit` capability.

**Final gates**

```sh
pnpm check:ci-wiring
pnpm test:version-gate
pnpm check:supabase-cli-pins
pnpm --filter @movp/domain test
pnpm --filter @movp/domain typecheck
pnpm --filter @movp/graphql test
pnpm --filter @movp/graphql typecheck
pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm --filter @movp/editor-sdk build
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro exec node scripts/check-overlay-bundle.mjs
supabase test db supabase/tests/content_edit_capability_test.sql
pnpm test:forward-only-migrations
pnpm build
pnpm check:packages
pnpm check:task-cms-contracts
git diff --check
```

Expected: every command exits `0`. Full Verdaccio and full overlay browser gates are required green in CI as described above.

**Commit**

```sh
git add .github/workflows/ci.yml scripts/check-ci-wiring.mjs scripts/test/check-ci-wiring.test.mjs CLAUDE.md docs/agents/task-cms-data-contract.md
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
