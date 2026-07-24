# C7.7 — Editor-to-Delivery Integration and Completion TDD Plan

> **Executor contract:** This is the final C7-tail plan. It may mark C7 complete only after all `07e`–`07i` gates, authoritative CI fixture jobs, and an eight-dimension review clear 9.2 with no dimension below 9.2.

**Goal:** Prove the real owner edit → conflict → approval → publish → anonymous delivery/artifacts → unpublish lifecycle across the shipped boundaries, then close C7 documentation and CI status honestly.

**Depends on, in order:**

1. `2026-07-23-movp-stage-c-07e-delivery-core.md`
2. `2026-07-23-movp-stage-c-07f-inline-overlay.md`
3. `2026-07-23-movp-stage-c-07g-realtime.md`
4. `2026-07-23-movp-stage-c-07h-delivery-seo.md`

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md`

**Architecture:** Extend the existing real-runtime `scripts/slice-e2e.sh` immediately after `[content]`. Reuse its local Supabase stack, owner/member/non-member sessions, GraphQL Edge function, and content fixtures. Start the built Astro Worker only for the delivery portion, using public local bindings. The slice validates public delivery over HTTP, not by calling implementation helpers. Unit/package/pgTAP/browser jobs remain independently required; the slice is the cross-boundary lifecycle gate.

**No new dependency, migration, API surface, or production subsystem.**

## Invariants

- `[editor-delivery]` appears once, after `[content]` and before `[campaigns]`.
- The slice uses owner/admin for authoring, member for bypass denials, non-member for isolation.
- Secrets/tokens are never placed in argv, printed, written to fixture files, or included in failure output.
- Public anon key/project URL/workspace id are public values and may be Worker vars.
- The frontend Worker is built first, then started from the adapter-generated config using only verified Wrangler flags.
- Process startup/probes/retries are bounded; final failure prints content-disciplined logs and exits nonzero.
- Cleanup uses explicit PIDs/temp paths and preserves other local Supabase projects.
- The test uses the real `updateRichTextField` GraphQL mutation, real hash-first database writer, real publish workflow, real public REST RPC through Astro, and real artifact routes.
- Conflict is negative and load-bearing: two writers share one expected revision, first saves, second returns sanitized `CONFLICT`, and the second body does not overwrite the first.
- Public delivery exposes the published revision, never the newer draft.
- Unpublished/missing are indistinguishable `404 no-store`.
- Artifact output is parsed/validated, not checked merely for HTTP 200.
- Observability assertions search only safe identifiers/codes and prove known content/token sentinel values are absent.
- C7 status remains “planned/unexecuted” until implementation and review actually pass.

## File map

**Create**

- `scripts/test/editor-delivery-slice-order.test.mjs`
- `docs/superpowers/reviews/2026-07-23-movp-stage-c-07-tail-review.md` (Task 6, only after review)

**Modify**

- `scripts/slice-e2e.sh`
- `.github/workflows/ci.yml`
- `scripts/check-ci-wiring.mjs`
- `scripts/check-docs-presence.mjs`
- `docs/superpowers/plans/README.md`
- `docs/agents/task-cms-interface-contract.md`
- `docs/agents/task-cms-scaffolding.md` if public delivery setup belongs in scaffolding
- `llms.txt`
- `CLAUDE.md`

## Task 0: Verify executable commands and establish baselines

- [ ] Confirm clean scope/local stack:

```sh
git status --short --branch
supabase status
```

Expected: intended branch; repo’s `6432x` local stack.

- [ ] Verify every encoded subcommand/flag:

```sh
pnpm exec wrangler dev --help
pnpm --filter @movp/frontend-astro run
supabase functions serve --help
```

Expected:

- Wrangler `dev` supports the exact `--port` and repeated `--var` syntax already used by frontend Playwright;
- frontend exposes `build` and `e2e`;
- local CLI serves all functions and supports `--env-file`, with no positional function list.

- [ ] Baseline:

```sh
bash -n scripts/slice-e2e.sh
bash scripts/slice-e2e.sh
pnpm check:ci-wiring
pnpm check:docs
```

Expected: shell syntax and all existing slices pass; CI/docs gates pass. Record existing `[content]` and `[campaigns]` marker positions.

## Task 1: Add a red structural gate for slice placement and mandatory checks

- [ ] Create `editor-delivery-slice-order.test.mjs`. It must guarded-read `scripts/slice-e2e.sh`:
  - `lstat`;
  - reject symlink/non-regular file;
  - verify size before read;
  - never print script content.

Pin:

1. exactly one `== [editor-delivery]` section;
2. its first marker is after the final `[content]` marker and before `[campaigns]`;
3. the section contains named failure gates for owner save, member denial, stale conflict, publish, public page, sitemap, llms, unpublish 404, event content discipline;
4. frontend process startup has bounded health probing;
5. an EXIT cleanup path owns only the spawned PID/temp log;
6. the slice never passes a bearer/session token in a command argument;
7. no fixed sleep above the approved small startup polling interval.

- [ ] Run:

```sh
node --test scripts/test/editor-delivery-slice-order.test.mjs
```

Expected: **FAIL** because `[editor-delivery]` is absent.

**Commit only after Task 3 green**, so the red test never lands alone.

## Task 2: Add bounded frontend-Worker lifecycle helpers

- [ ] Add targeted shell helpers near existing process helpers:

```text
start_delivery_frontend
wait_for_delivery_frontend
stop_delivery_frontend
```

Requirements:

- build via `pnpm --filter @movp/frontend-astro build`;
- start with `pnpm --filter @movp/frontend-astro exec wrangler dev --port <dedicated-port>`;
- pass only `GRAPHQL_ENDPOINT`, `WORKSPACE_ID`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY` as public `--var` bindings;
- rely on the built adapter config; do not point source config at generated entry files;
- write stdout/stderr to a unique `mktemp` log with mode `0600`;
- retain the spawned PID explicitly;
- probe a health/public-not-found URL with at most 30 attempts and a total ≤30 seconds;
- on terminal startup failure, print a bounded redacted tail that cannot include tokens/content;
- kill/wait only that PID and remove only that explicit temp file;
- compose with the script’s existing EXIT trap rather than overwrite cleanup.

The Worker receives no user session; authenticated mutation calls continue through the existing Edge GraphQL helper. Public delivery uses anon/public bindings.

- [ ] Run:

```sh
bash -n scripts/slice-e2e.sh
node --test scripts/test/editor-delivery-slice-order.test.mjs
```

Expected: shell syntax passes; structural test still **FAILS** only because lifecycle assertions are not all in the absent section.

## Task 3: Implement the real `[editor-delivery]` lifecycle

Insert immediately after the existing `[content]` observability block and before `[campaigns]`.

### 3.1 Fixture and capability boundary

- [ ] Create a unique rich-text content type key/slug under the existing workspace using the owner token. Field schema contains one richtext field.

- [ ] As member `TOKEN2`, attempt:
  - GraphQL content create/update;
  - direct PostgREST content item/revision write;
  - content-originated edge insert.

Expected: each returns `403`/GraphQL error with the stable denial contract and creates no row/revision/edge.

- [ ] As member, create the established inbound campaign `produces` edge against an appropriate fixture. Expected: success. This pins the directional exception in the real HTTP slice.

- [ ] As non-member `TOKEN3`, public authoring/read attempts remain denied/empty.

### 3.2 Canonical save and conflict

- [ ] Owner creates an item containing an inert rich-text XSS sentinel and reads revision `R0`.

- [ ] Call real `updateRichTextField(itemId, fieldKey, bodyA, expectedRevisionId:R0)`. Expected: `saved`, revision `R1`.

- [ ] Call it again with semantically identical canonical body and `R0`. Expected: existing idempotent no-op behavior; revision count does not grow.

- [ ] Simulate two editors from `R1`:
  1. save body B with `R1` → `saved`, `R2`;
  2. save different body C with `R1` → GraphQL `extensions.code='CONFLICT'`.

Read current revision and assert body B won; body C is absent. Do not print either body in failure logs—compare hashes/boolean predicates and name only the failing invariant.

- [ ] Assert:
  - exactly one `content.richtext_save_resolver` operational event per GraphQL attempt;
  - exactly one `content.revision_created` domain event for each new revision;
  - idempotent/conflict attempts created no domain revision event;
  - no event/log row contains the sentinel/body/token.

### 3.3 Approval/publish and anonymous delivery

- [ ] Submit, approve, and publish `R2` through the real workflow as owner/admin.

- [ ] Create a newer draft `R3` after publish.

- [ ] Start the built frontend Worker and fetch:

```text
/<content-type-key>/<slug>
```

without cookies or Authorization.

Expected:

- `200`;
- exact `Cache-Control: public, max-age=0, s-maxage=60`;
- rendered published body B is present;
- draft R3 and raw XSS sentinel are absent/inert;
- canonical/meta/JSON-LD are escaped and derive from configured site origin;
- no `Set-Cookie`, no session variance, and no editor/TipTap script request.

Use a response file in a unique `0600` temp directory only after `lstat`/regular-file/size checks, or stream through a bounded parser. Never print its content.

### 3.4 Artifact and withdrawal checks

- [ ] Fetch `/sitemap.xml`; parse XML and assert it is an index that references the item’s bounded child.

- [ ] Fetch the referenced same-origin child after validating/normalizing the path. Assert the published typed URL occurs exactly once, count ≤4,000, `<loc>` length <2,048, and UTF-8 bytes <52,428,800.

- [ ] Fetch `/robots.txt` and `/llms.txt`. Assert sitemap pointer, bounded sizes, and the expected public URL/pointer contract.

- [ ] Unpublish through GraphQL; fetch the typed page again. Local Worker has no shared cache, so expected result is immediate `404` with `Cache-Control:no-store`. The separate fake-clock test remains authority for the worst-case 60-second shared-cache ceiling.

- [ ] Fetch artifacts after unpublish and assert the URL is absent after origin regeneration. Do not sleep 60 seconds.

### 3.5 Hard-failure behavior

Every curl uses `--fail-with-body` only when the body is safe to retain; otherwise capture status separately and bound the body. Retry only gateway `502/503/504`, at most three attempts, following the existing integration helper. Auth/403/conflict/validation failures are terminal and never retried.

End with:

```text
== [editor-delivery] PASS ==
```

only after every assertion has run.

**Green gates**

```sh
bash -n scripts/slice-e2e.sh
node --test scripts/test/editor-delivery-slice-order.test.mjs
bash scripts/slice-e2e.sh
```

Expected:

- structural test passes;
- output order includes `[content]`, `[editor-delivery] PASS`, `[campaigns]`;
- final `slice-e2e: PASS`;
- no credentials/content printed.

**Commit**

```sh
git add scripts/slice-e2e.sh scripts/test/editor-delivery-slice-order.test.mjs
git commit -m "test(c7): add editor delivery lifecycle slice"
```

## Task 4: Make CI require every independent and integrated gate

**Red first**

- [ ] Extend `scripts/check-ci-wiring.mjs` and its tests to require:
  - `c7-delivery`;
  - `c7-inline-overlay`;
  - `c7-realtime`;
  - `c7-editor-delivery`;
  - complete `07e`–`07i` package/pgTAP/frontend/slice commands;
  - existing C6 jobs remain required.

- [ ] Run:

```sh
pnpm check:ci-wiring
```

Expected: **FAIL** naming missing final C7 job/commands.

**Green implementation**

- [ ] Add `c7-editor-delivery` after its dependencies. It starts the isolated stack, serves all Edge Functions using the checked-in env-file pattern, and runs:

```sh
node --test scripts/test/editor-delivery-slice-order.test.mjs
bash scripts/slice-e2e.sh
```

Keep `supabase/setup-cli` pinned to `2.109.1`. Public refs/anon keys remain literals/unmasked variables; only real credentials are secrets.

- [ ] Require all C7 package/frontend/pgTAP jobs before a merge. Do not make the final slice a substitute for unit/boundary/Playwright/Realtime browser gates.

**Gate**

```sh
pnpm check:supabase-cli-pins
pnpm check:ci-wiring
```

Expected: both pass and prior required jobs remain present.

**Commit**

```sh
git add .github/workflows/ci.yml scripts/check-ci-wiring.mjs scripts/test
git commit -m "ci(c7): require editor delivery completion gates"
```

## Task 5: Update durable docs without claiming unreviewed completion

**Red first**

- [ ] Extend `scripts/check-docs-presence.mjs`/contract tests to require:
  - approved C7-tail design;
  - all five `07e`–`07i` implementation plans;
  - public typed URL and published-only boundary;
  - owner/admin editing and member denial;
  - hash-first optimistic save/conflict;
  - sitemap/robots/llms/JSON-LD bounds;
  - Realtime is a headless primitive/fixture, not a reference-editor claim;
  - 60-second withdrawal ceiling/no purge subsystem.

- [ ] Run:

```sh
pnpm check:docs
```

Expected: **FAIL** until docs/index are updated.

**Green implementation**

- [ ] Update task/CMS interface/scaffolding docs and `llms.txt` links. Keep user-facing examples free of real tokens and make HTTP/GraphQL examples copy-paste-correct.

- [ ] Update `CLAUDE.md` with final durable rules from all four preceding plans.

- [ ] Update Stage C README plan column to list `07e`–`07i`. Before Task 6 review, status must say:

```text
C7.1–C7.3 executed; C7.4–C7.7 implementation complete, final review pending
```

Do not say merged/approved/≥9.2 yet.

**Gate**

```sh
pnpm check:task-cms-contracts
pnpm check:docs
pnpm check:docs-freshness
git diff --check
```

Expected: all pass.

**Commit**

```sh
git add docs llms.txt CLAUDE.md scripts/check-docs-presence.mjs scripts/check-task-cms-contracts*
git commit -m "docs(c7): document inline editing and delivery"
```

## Task 6: Run the complete release gate and eight-dimension review

### 6.1 Local mandatory gate

Run exactly:

```sh
node scripts/check-forward-only-migrations.mjs
supabase test db
bash scripts/slice-e2e.sh
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/delivery build
pnpm --filter @movp/realtime test
pnpm --filter @movp/realtime typecheck
pnpm --filter @movp/realtime build
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro e2e
pnpm test:content-realtime-browser
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
pnpm check:docs
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits `0`; slice prints `[editor-delivery] PASS` and final PASS. Do not summarize a failed/skipped command as green.

### 6.2 Authoritative CI

Push the implementation branch and require all checks, including full Verdaccio CRM/gallery, template smokes, Realtime browser, frontend Playwright, and final slice. Local Verdaccio Deno edge-serve flakiness does not waive CI.

Record commit SHA and CI run URL in the review file.

### 6.3 Eight-dimension review

- [ ] Create `docs/superpowers/reviews/2026-07-23-movp-stage-c-07-tail-review.md`.

Review with evidence for:

1. Correctness
2. Safety
3. Reliability
4. Observability
5. Efficiency
6. Performance
7. Simplicity
8. Usability

Every finding includes Behavior, Evidence, Fix, Test. Severity sets the score band. Arithmetic mean must be shown, and completion requires mean ≥9.2 **and** every dimension ≥9.2.

If below threshold, leave README at “review pending/findings open,” fix via TDD, rerun affected plus full gates, and re-review. Never adjust weights or scores to pass.

- [ ] Only after the gate clears, change Stage C status to:

```text
✅ C7.1–C7.7 EXECUTED (reviewed <actual score>; <commit/PR evidence>)
```

**Final commit**

```sh
git add docs/superpowers/reviews/2026-07-23-movp-stage-c-07-tail-review.md docs/superpowers/plans/README.md
git commit -m "docs(c7): record inline delivery completion review"
```

## Completion gate

C7 is complete only if:

- `07e`–`07i` all satisfy their completion gates;
- migrations `...00001`, `...00002`, `...00003` are forward-only and ordered;
- anonymous delivery, privileged edit, conflict, Realtime fixture, SEO, artifacts, withdrawal, and content-discipline tests pass;
- full local commands and authoritative CI are green;
- the final eight-dimension mean is ≥9.2 and no dimension is below 9.2;
- README records actual evidence, not a planned claim.

Otherwise report the exact remaining part/finding and keep C7 pending.
