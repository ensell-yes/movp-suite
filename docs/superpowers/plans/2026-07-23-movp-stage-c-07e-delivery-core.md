# C7.6a — Published Delivery Core TDD Implementation Plan

> **Executor contract:** Execute one task at a time, in order. Preserve every red/green gate and commit boundary. Do not mark C7 complete: this is the first of five C7-tail plans (`07e`–`07i`).

**Goal:** Ship the anonymous, published-only delivery foundation: deterministic typed URLs, bounded delivery RPCs, an allowlisted document renderer, bounded sitemap artifacts, and cache behavior with a hard 60-second withdrawal ceiling.

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md`

**Architecture:** Anonymous routes call two narrow `SECURITY DEFINER` RPCs over Supabase REST with the public anon key. Those RPCs expose only published revision data. `@movp/delivery` turns canonical rich-text JSON into escaped HTML and produces deterministic delivery artifacts. The Astro host resolves `readServerEnv()` inside each request, validates and bounds every remote response, and owns cache headers. No editor code is reachable from the anonymous bundle in this part.

**No new external dependency:** Reuse workspace TypeScript, Vitest, tsup, Astro, and `@movp/richtext`. Do not add a registry dependency.

## Invariants

- Migrations are forward-only. Create only:
  - `supabase/migrations/20260723000001_content_delivery_reads.sql`
- Public reads return the `published_revision` only. Draft/current revision identifiers and bodies are never returned.
- `(content_type.workspace_id, content_type.key)` is unique before typed routes land.
- Duplicate preflight fails with stable SQLSTATE/message code `content_type_key_duplicates`; diagnostics contain counts, never values.
- Both public RPCs are `SECURITY DEFINER`, set an explicit safe `search_path`, validate every identifier, and are executable by `anon` and `authenticated` only after explicit grants.
- `list_published_delivery` uses opaque keyset cursors and clamps `limit` to `1..1000`.
- Renderer output is built from an allowlisted AST. It escapes text and attribute values, rejects dangerous links, never passes stored HTML through, and emits binding attributes only from validated identifiers.
- A single sitemap child contains at most 4,000 URLs and 52,428,800 escaped UTF-8 bytes. The lower row cap leaves framing headroom and keeps each child within five clamped 1,000-row RPC calls.
- Public 200 responses use `public, s-maxage=60`; 404/error responses use `no-store`.
- `readServerEnv()` is called at request time. Never use `process.env` or capture request-bound state in module scope.
- New package file inventories use `lstat`, reject symlinks, and bound size before reading.

## File map

**Create**

- `supabase/migrations/20260723000001_content_delivery_reads.sql`
- `supabase/tests/content_delivery_test.sql`
- `packages/delivery/package.json`
- `packages/delivery/tsconfig.json`
- `packages/delivery/vitest.config.ts`
- `packages/delivery/src/types.ts`
- `packages/delivery/src/render.ts`
- `packages/delivery/src/artifacts.ts`
- `packages/delivery/src/meta.ts`
- `packages/delivery/src/index.ts`
- `packages/delivery/test/render.test.ts`
- `packages/delivery/test/artifacts.test.ts`
- `packages/delivery/test/meta.test.ts`
- `packages/delivery/test/boundary.test.ts`
- `packages/delivery/test/public-surface.test.ts`
- `templates/frontend-astro/src/lib/delivery.ts`
- `templates/frontend-astro/src/pages/[contentType]/[slug].astro`
- `templates/frontend-astro/src/pages/sitemap.xml.ts`
- `templates/frontend-astro/src/pages/sitemap-[boundary].xml.ts`
- `templates/frontend-astro/src/pages/robots.txt.ts`
- `templates/frontend-astro/src/pages/llms.txt.ts`
- `templates/frontend-astro/src/lib/delivery.test.ts`
- `templates/frontend-astro/tests/e2e/delivery.spec.ts`

**Modify**

- `scripts/check-package-artifacts.mjs`
- `scripts/check-publishable-versions.mjs`
- `fixtures/verdaccio-crm-lite/gate.sh`
- `fixtures/verdaccio-gallery/pack.sh`
- `.github/workflows/ci.yml`
- `scripts/check-ci-wiring.mjs`
- `pnpm-lock.yaml`
- `CLAUDE.md`

## Task 0: Preflight the repository and reconcile command/runtime facts

- [ ] Confirm the branch and working tree:

```sh
git status --short --branch
```

Expected: the intended feature branch and no unrelated changes. Stop rather than overwrite user work.

- [ ] Confirm local Supabase ownership before any reset:

```sh
supabase status
```

Expected: this repo's intentional ports begin at `64320`/`64321`; if another project is shown, stop and repair targeting.

- [ ] Verify the exact test and CLI commands before encoding them:

```sh
supabase test db --help
pnpm --filter @movp/frontend-astro run
pnpm exec vitest --help
```

Expected: `supabase test db` is available; frontend lists `e2e`; Vitest accepts `run`.

- [ ] Confirm the real server-env contract:

```sh
rg -n "export function readServerEnv|process\\.env" templates/frontend-astro/src/lib/env.ts
```

Expected: `readServerEnv()` has no argument and reads `cloudflare:workers`; no `process.env`.

If later prose and the checked-in helper disagree, reconcile the prose to the
verified zero-argument request-time helper. Do not change the working helper
merely to match stale prose.

**Gate:** all commands above exit `0`; record the exact output in the implementation PR.

## Task 1: Make typed routing unique and add published-only read RPCs

**Red first**

- [ ] Create `supabase/tests/content_delivery_test.sql` with pgTAP cases for:
  1. `anon` can resolve an existing published `(workspace_id, content_type_key, slug)`;
  2. returned body and revision id are exactly the published revision;
  3. an unpublished item and a draft-only item return zero rows;
  4. a newly saved draft after publish does not change public output;
  5. a foreign workspace cannot be reached by changing slug/type;
  6. `list_published_delivery` returns published rows only, is deterministically ordered, clamps `limit`, and produces a resumable opaque cursor;
  7. invalid UUID, type key, slug, cursor, and limit fail with stable sanitized codes;
  8. application roles cannot execute the duplicate-preflight helper;
  9. after temporarily dropping the new unique constraint inside the test transaction, duplicate type keys make the helper fail with `content_type_key_duplicates`.

Keep the test transactional (`begin`/`rollback`). The duplicate fixture must be rolled back; never mutate a merged migration.

- [ ] Run the focused red gate:

```sh
supabase test db supabase/tests/content_delivery_test.sql
```

Expected: **FAIL** because the RPCs/helper/constraint do not exist. A connection failure is not the expected red state.

**Green implementation**

- [ ] Create `20260723000001_content_delivery_reads.sql` with:

```sql
create or replace function movp_internal.assert_content_type_key_uniqueness()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, movp_internal
```

The helper computes duplicate groups as counts only and raises:

```sql
raise exception using
  errcode = '23505',
  message = 'content_type_key_duplicates';
```

Revoke it from `public`, `anon`, and `authenticated`. Execute it before adding:

```sql
alter table public.content_type
  add constraint content_type_workspace_key_unique
  unique (workspace_id, key);
```

Use the real table/column names confirmed from the schema. Do not log duplicate keys.

- [ ] Add exact public contracts:

```sql
public.get_published_by_slug(
  p_workspace_id uuid,
  p_content_type_key text,
  p_slug text
)
```

This returns at most one row containing only delivery-safe identifiers, type key, slug, published revision id, published data, title/meta inputs, and published timestamp.

```sql
public.list_published_delivery(
  p_workspace_id uuid,
  p_content_type_key text default null,
  p_after text default null,
  p_limit integer default 1000,
  p_until text default null
)
```

This returns a stable keyset page plus `next_cursor`. Cursor contents are opaque to clients and structurally validated by SQL before use. `p_until` pins the snapshot upper boundary chosen by the sitemap index so child pages cannot drift beyond it.

Both functions:

- are `SECURITY DEFINER`;
- set `search_path = pg_catalog, public`;
- fully qualify every relation/function;
- select through `content_item.published_revision_id`;
- never consult `current_revision_id` for returned data;
- validate `workspace_id`, bounded key/slug/cursor text, and limit;
- explicitly revoke `public` execute before granting `anon, authenticated`;
- never grant table access to `anon`.

- [ ] Apply from a clean local database:

```sh
supabase db reset
supabase test db supabase/tests/content_delivery_test.sql
pnpm test:forward-only-migrations
```

Expected: reset succeeds; focused pgTAP passes; forward-only guard reports no historical migration change.

**Commit**

```sh
git add supabase/migrations/20260723000001_content_delivery_reads.sql supabase/tests/content_delivery_test.sql
git commit -m "feat(delivery): add published-only read RPCs"
```

## Task 2: Build the client/server-safe `@movp/delivery` renderer

**Scaffold**

- [ ] Create the package at version `0.1.1`, mirroring `@movp/richtext` build conventions. Its only workspace dependency may be:

```json
"@movp/richtext": "workspace:*"
```

Exports are source-first in the workspace and redirect to `dist/index.js`/`dist/index.d.ts` in `publishConfig`. Scripts: `test`, `typecheck`, and `build`. Do not add an external library.

- [ ] Run `pnpm install` only to register the new workspace package:

```sh
pnpm install --lockfile-only
```

Expected: lockfile updates only for the new workspace importer; no new registry package appears.

**Red first**

- [ ] Write `render.test.ts` before implementation. Pin:
  - paragraphs, headings, ordered/unordered lists, list items, blockquotes, hard breaks, links, bold, italic, strike, and code;
  - unknown nodes/marks are omitted or rendered as escaped text according to one documented fail-closed rule;
  - `<script>`, `<img onerror>`, quotes, ampersands, and stored HTML remain inert;
  - `javascript:`, `data:`, control-character, and malformed link URLs never become `href`;
  - allowed `http`, `https`, `mailto`, relative, fragment links are normalized safely;
  - binding attributes appear only when `bind.itemId` and `bind.fieldKey` pass strict validators;
  - no rendered node permits arbitrary attributes/classes/styles;
  - input is never mutated.

- [ ] Run:

```sh
pnpm --filter @movp/delivery test -- render.test.ts
```

Expected: **FAIL** with missing `renderDocToHtml`; not “No projects matched.”

**Green implementation**

- [ ] Implement these public types:

```ts
export type DeliveryBinding = Readonly<{
  itemId: string
  fieldKey: string
}>

export type RenderOptions = Readonly<{
  bind?: DeliveryBinding
}>

export function renderDocToHtml(doc: unknown, options?: RenderOptions): string
```

Parse `unknown` with explicit runtime guards. Never assert parsed input with `as SomeDoc`. Use a small recursive renderer with a maximum depth, node count, and UTF-8 output budget. Failure must be deterministic and carry an allowlisted code, never include payload content.

The only binding attributes are:

```html
data-movp-item="validated-uuid"
data-movp-field="validated_field_key"
```

- [ ] Add a guarded `boundary.test.ts` that recursively scans `src/`. For each path: `lstat`, reject symlinks, verify a regular file, reject files above a small declared byte cap before reading, then assert there is no import/reference to:
  - `@movp/domain`, `@movp/auth`, `@movp/graphql`;
  - `@supabase/*`;
  - `cloudflare:workers`, `node:*`, server env, service-role text;
  - React, TipTap, or editor SDK.

- [ ] Export only the intended surface from `src/index.ts` and pin it with `public-surface.test.ts`.

**Gate**

```sh
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/delivery build
```

Expected: all tests pass, typecheck exits `0`, and `dist/index.js` plus `dist/index.d.ts` exist.

**Commit**

```sh
git add packages/delivery pnpm-lock.yaml
git commit -m "feat(delivery): add safe document renderer"
```

## Task 3: Add bounded canonical metadata and artifact generators

**Red first**

- [ ] Add `artifacts.test.ts` and `meta.test.ts`. Pin:
  - canonical URL construction rejects cross-origin bases and encodes path segments;
  - robots output is deterministic;
  - JSON-LD serializes through a script-safe serializer (`<`, U+2028, U+2029 cannot terminate/inject a script);
  - llms.txt escapes/control-filters titles and URLs and enforces byte/entry limits;
  - an empty site has a valid sitemap response;
  - `50_001` synthetic URLs produce an index and at least thirteen child descriptors;
  - no child exceeds `4_000` URLs or `52_428_800` escaped UTF-8 bytes;
  - cursor/snapshot boundaries are stable when an entry is published between index and child requests;
  - every URL in the pinned snapshot appears exactly once.

- [ ] Run:

```sh
pnpm --filter @movp/delivery test -- artifacts.test.ts meta.test.ts
```

Expected: **FAIL** because generators are not exported.

**Green implementation**

- [ ] Implement pure generators:

```ts
generateSitemapIndex(...)
generateSitemapChild(...)
generateRobots(...)
generateJsonLd(...)
generateLlmsTxt(...)
canonicalUrl(...)
```

The index stores opaque child start/end cursors and one snapshot upper cursor. A child scans from its inclusive start to the exclusive next boundary and never reads past the snapshot upper cursor. Set `MAX_SITEMAP_URLS = 4_000` and `MAX_SITEMAP_BYTES = 52_428_800`; measure each escaped entry before append.

Generators accept already-bounded iterables/pages. They do not fetch, import Astro, or own caches.

**Gate**

```sh
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/delivery build
```

Expected: green with the >50k and concurrent-publish cases included in the reported test count.

**Commit**

```sh
git add packages/delivery
git commit -m "feat(delivery): add bounded delivery artifacts"
```

## Task 4: Wire anonymous Astro routes without leaking drafts or editor code

**Red first**

- [ ] Add `templates/frontend-astro/src/lib/delivery.test.ts` that statically and behaviorally pins:
  - `readServerEnv()` is called inside each request handler;
  - no delivery module uses `process.env`;
  - public Supabase calls use only URL + anon key, never service-role credentials;
  - remote JSON is content-type checked, byte bounded before full buffering (stream cap), and structurally validated;
  - 200 headers include `public, s-maxage=60`;
  - 404 and all upstream/validation failures include `no-store`;
  - the page has exactly one renderer-owned `set:html` insertion and no stored value reaches another raw HTML sink;
  - public routes have no static or dynamic editor/TipTap imports in this part.

- [ ] Add Playwright cases for published 200, unpublished 404, typed-slug isolation, escaped XSS payload, cache headers, sitemap index/child, robots, and llms.txt.

- [ ] Run:

```sh
pnpm --filter @movp/frontend-astro test -- delivery.test.ts
```

Expected: **FAIL** because routes/client do not exist.

**Green implementation**

- [ ] Implement `src/lib/delivery.ts` as a narrow fetch adapter:
  - accepts an explicit `ServerEnv` resolved by the caller during the request;
  - calls `/rest/v1/rpc/get_published_by_slug` and `/rest/v1/rpc/list_published_delivery`;
  - sends `apikey` and `Authorization: Bearer <anon key>`;
  - uses an abort timeout;
  - caps response bytes while streaming, before JSON parse;
  - validates every object/array element from `unknown`;
  - returns discriminated `found | not_found | error` outcomes with safe codes;
  - emits no body/token values.

Do not instantiate/capture a client at module load.

- [ ] Implement `/[contentType]/[slug]`:
  - resolve workspace id from request-time public env/config;
  - call the published-only RPC;
  - render rich-text fields through `renderDocToHtml`;
  - use the one documented `set:html` boundary only for renderer output;
  - output canonical/meta/JSON-LD;
  - set `Referrer-Policy`, a restrictive CSP compatible with later bootstrap, and cache headers;
  - respond 404/no-store for absent/unpublished content.

Static Astro routes retain precedence over the fallback typed route. Do not create a catch-all.

- [ ] Implement artifact routes. The index calls enough bounded list pages to calculate cursor boundaries; each child performs at most five RPC calls and fails loudly with a stable error if that budget would be exceeded. Artifact failures use `no-store` and a non-2xx status.

There is intentionally no purge webhook, cache tag, Cloudflare API token, or new binding. Withdrawal is bounded by `s-maxage=60`.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro e2e -- --grep "published delivery"
```

Expected: unit/type/build green; focused Playwright proves the published/unpublished and artifact paths. If Playwright needs fixtures not available until `07i`, keep the test checked in and mark only those exact integration cases pending—never report them passing.

**Commit**

```sh
git add templates/frontend-astro
git commit -m "feat(frontend): add published delivery routes"
```

## Task 5: Register, package, and continuously gate the new unit

**Red first**

- [ ] Extend the artifact/version/CI tests before their inventories:

```sh
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
```

Expected: at least one **FAIL** naming missing `@movp/delivery` coverage.

**Green implementation**

- [ ] Add `@movp/delivery` to:
  - `scripts/check-package-artifacts.mjs`;
  - `scripts/check-publishable-versions.mjs`;
  - `fixtures/verdaccio-crm-lite/gate.sh`;
  - `fixtures/verdaccio-gallery/pack.sh`.

Update exact package counts and expected file names. Preserve guarded reads: `lstat`, symlink rejection, size check before read.

- [ ] Add required CI job `c7-delivery` that runs package test/typecheck/build plus frontend delivery unit/build gates. Pin its presence in `scripts/check-ci-wiring.mjs`.

- [ ] Update `CLAUDE.md` with the durable delivery rules: published-only RPC boundary, renderer-owned HTML sink, anonymous no-editor bundle, 60-second withdrawal ceiling, bounded sitemap set.

**Gate**

```sh
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
pnpm --filter @movp/delivery test
pnpm --filter @movp/delivery typecheck
pnpm --filter @movp/delivery build
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm test:forward-only-migrations
git diff --check
```

Expected: every command exits `0`; package artifact inspection sees the new built files; no whitespace errors.

**Commit**

```sh
git add scripts/check-package-artifacts.mjs scripts/check-publishable-versions.mjs fixtures/verdaccio-crm-lite/gate.sh fixtures/verdaccio-gallery/pack.sh .github/workflows/ci.yml scripts/check-ci-wiring.mjs CLAUDE.md
git commit -m "ci(delivery): gate published delivery core"
```

## Completion gate

This plan is complete only when:

- the migration is forward-only and pgTAP proves anon cannot see drafts;
- type-key duplicates fail before the uniqueness constraint is added;
- renderer XSS, boundary, and output-budget tests pass;
- >50k sitemap tests produce a bounded index/child set;
- anonymous page/build analysis finds no editor or TipTap reachability;
- public 404/error responses are `no-store`, while successful delivery is bounded to 60 seconds;
- package/release/CI inventories include `@movp/delivery`;
- all Task 5 commands pass.

Then proceed to `2026-07-23-movp-stage-c-07f-inline-overlay.md`. Do not mark C7.4–C7.7 or the C7 tail complete.
