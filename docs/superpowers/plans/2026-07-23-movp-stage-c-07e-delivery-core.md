# C7.6a — Published Delivery Core TDD Implementation Plan

> **Executor contract:** Execute one task at a time, in order. Preserve every red/green gate and commit boundary. Do not mark C7 complete: this is the first of five C7-tail plans (`07e`–`07i`).

> **Execution-order note:** Although this foundation is the first half of C7.6, it lands before C7.4 and C7.5 because both the overlay and Realtime work require a rendered delivery page. The filenames `07e`–`07i`, not the product sub-labels, govern execution order.

**Goal:** Ship the anonymous, published-only delivery foundation: deterministic typed URLs, bounded delivery RPCs, an allowlisted document renderer, bounded sitemap artifacts, and origin cache headers that cap shared freshness at 60 seconds. The end-to-end withdrawal guarantee additionally requires the deployment Cache Rule check in design §6 whenever Cloudflare caching is enabled.

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md`

**Architecture:** Anonymous routes call three narrow `SECURITY DEFINER` RPCs over Supabase REST with the public anon key. The item RPC exposes only the published revision; the list and shard RPCs expose route metadata only. `@movp/delivery` turns canonical rich-text JSON into escaped HTML and produces deterministic delivery artifacts. The Astro host resolves `readServerEnv()` inside each request, validates and bounds every remote response, and owns cache headers. No editor code is reachable from the anonymous bundle in this part.

**No new external dependency:** Reuse workspace TypeScript, Vitest, tsup, Astro, and `@movp/richtext`. Do not add a registry dependency.

## Invariants

- Migrations are forward-only. Create only:
  - `supabase/migrations/20260723000001_content_delivery_reads.sql`
- Public reads return the `published_revision` only. Draft/current revision identifiers and bodies are never returned.
- `(content_type.workspace_id, content_type.key)` is unique before typed routes land.
- Duplicate preflight fails with stable SQLSTATE/message code `content_type_key_duplicates`; diagnostics contain counts, never values.
- Content-type keys cannot equal the existing two-segment application namespaces `admin`, `api`, `auth`, `campaigns`, `content`, `notes`, `segments`, `settings`, `tasks`, or `workflows`. Existing-row preflight and future insert/update rejection use stable SQLSTATE `23514` and message code `content_type_key_reserved`; diagnostics never include the rejected key.
- All three public RPCs are `SECURITY DEFINER`, set `search_path = ''`, validate every identifier, and are executable only by `anon`, `authenticated`, and `service_role` after explicit grants.
- `list_published_delivery` uses opaque keyset cursors and clamps `limit` to `1..1000`.
- `list_published_delivery_shards` computes all child boundaries in one bounded database call and fails with `delivery_shards_timeout`; the index never scans the catalog page-by-page.
- Renderer output is built from the exact StarterKit allowlist shared by implementation and tests. It escapes text and attributes, never passes stored HTML through, and emits binding attributes only from validated identifiers.
- Renderer bounds are exactly 64 document levels, 20,000 nodes, and 1 MiB of UTF-8 text, checked while walking.
- A single sitemap child contains at most 4,000 URLs and 52,428,800 escaped UTF-8 bytes. The lower row cap leaves framing headroom and keeps each child within four clamped 1,000-row RPC calls.
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
pnpm --filter @movp/frontend-astro exec vitest --help
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
  6. `list_published_delivery` returns published route metadata only, never revision `data`, is deterministically ordered, clamps `limit`, and produces a resumable opaque cursor;
  7. `list_published_delivery_shards` returns non-overlapping ≤4,000-row boundaries in one call; `pg_proc.proconfig` pins its bounded `statement_timeout`; and a transaction-local replacement of the internal shard-scan helper raises SQLSTATE `57014`, proving the public wrapper deterministically remaps cancellation to catchable stable SQLSTATE `P5701` and message code `delivery_shards_timeout`;
  8. invalid UUID, type key, slug, cursor, reversed bound, and limit fail with stable sanitized codes;
  9. all three functions are `SECURITY DEFINER`, have empty configured search paths, revoke `PUBLIC`, and grant only `anon`, `authenticated`, and `service_role`;
  10. application roles cannot execute the duplicate/reserved-key preflight helpers or the internal shard-scan helper;
  11. after temporarily dropping the new unique constraint inside the test transaction, duplicate type keys make the helper fail with `content_type_key_duplicates`;
  12. after temporarily disabling the new reserved-key trigger inside the test transaction, an existing reserved key makes the migration preflight fail; after re-enabling it, direct insert/update of key `admin` fails with SQLSTATE `23514` and message code `content_type_key_reserved`.

Keep the test transactional (`begin`/`rollback`). Temporarily replace only the
new internal shard-scan helper inside that transaction, call the unchanged
public wrapper, and rely on rollback to restore it. Disable the reserved-key
trigger only long enough to seed the preflight fixture, re-enable it before the
direct-write assertions, and assert it is enabled in `pg_trigger` afterward.
The duplicate/reserved fixtures must be rolled back; never mutate a merged
migration.

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

Add private predicate
`movp_internal.is_reserved_content_type_key(p_key text)`, private preflight
`movp_internal.assert_no_reserved_content_type_keys()`, and trigger function
`movp_internal.reject_reserved_content_type_key()`. Attach the trigger function
as `content_type_reserved_key_tg BEFORE INSERT OR UPDATE OF key` on
`public.content_type`. The predicate is the single source for this exact
reserved first-segment set:

```sql
array[
  'admin', 'api', 'auth', 'campaigns', 'content',
  'notes', 'segments', 'settings', 'tasks', 'workflows'
]::text[]
```

Both paths raise:

```sql
raise exception using
  errcode = '23514',
  message = 'content_type_key_reserved';
```

The preflight and trigger functions are `SECURITY DEFINER`, use
`set search_path = ''`, schema-qualify their references, and—along with the
predicate—have execute revoked from `PUBLIC`, `anon`, and `authenticated`.
Execute the preflight before creating the trigger. Do not include the key in
the message, detail, hint, or logs. When the frontend gains a new static
two-segment top-level namespace, the same change must add a forward-only
migration extending this predicate and update the pgTAP inventory before that
route lands.

Use the real table/column names confirmed from the schema. Do not log duplicate
or reserved keys.

- [ ] Add exact public contracts:

```sql
public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text
) returns jsonb
```

This returns at most one row containing only delivery-safe identifiers, type key, slug, published revision id, published data, a names-only `richtext_field_keys` projection, the boolean `richtext_field_keys_supported`, title/meta inputs, and published timestamp. Binding keys use `^[A-Za-z][A-Za-z0-9_-]{0,127}$`; a false support flag maps to `delivery_richtext_field_key_unsupported` and a generic `500 no-store` response rather than exposing stored doc JSON as prose. The complete field schema is never returned; V1 treats the published revision data object as wholly public.

```sql
public.list_published_delivery(
  ws uuid,
  p_after text default null,
  p_until text default null,
  p_limit integer default 1000
) returns jsonb
```

This returns a stable keyset page plus `next_cursor`. Rows contain only item id, content-type key, slug, published revision id, and published timestamp—never revision `data`. Cursor contents are opaque to clients and structurally validated by SQL before use. `p_until` is the inclusive end cursor supplied by the shard RPC.

```sql
public.list_published_delivery_shards(
  ws uuid,
  p_urls_per_shard integer default 4000
) returns jsonb
```

This public wrapper returns non-overlapping opaque exclusive-start/inclusive-end
pairs covering at most 4,000 rows each. Put the bounded catalog scan in private
`movp_internal.list_published_delivery_shard_bounds(ws, p_urls_per_shard)`.
The public wrapper sets `statement_timeout = '2s'`, calls that helper, and maps
only `query_canceled` / SQLSTATE `57014` to:

```sql
raise exception using
  errcode = 'P5701',
  message = 'delivery_shards_timeout';
```

Other failures retain their safe, explicit error path. Revoke the internal
helper from `PUBLIC`, `anon`, and `authenticated`. The pgTAP suite asserts
`pg_proc.proconfig` contains `statement_timeout=2s`, then temporarily replaces
the internal helper with the same signature and a body that raises SQLSTATE
`57014`. Calling the unmodified public wrapper must raise catchable SQLSTATE
`P5701` with `delivery_shards_timeout`; rollback restores the real scanner.
Do not assert `57014` through pgTAP: PL/pgSQL deliberately excludes
`query_canceled` from `WHEN OTHERS`, so `throws_ok` cannot catch it. Do not
induce a wall-clock timeout in tests. The wrapper never falls back to
application-side catalog pagination.

All three functions:

- are `SECURITY DEFINER`;
- set `search_path = ''`;
- fully qualify every relation/function;
- select through `content_item.published_revision_id`;
- never consult `current_revision_id` for returned data;
- validate `workspace_id`, bounded key/slug/cursor text, and limit;
- explicitly revoke `PUBLIC` execute before granting only `anon`, `authenticated`, and `service_role`;
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
  - the shared node allowlist is exactly `doc`, `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `blockquote`, `codeBlock`, `hardBreak`, `horizontalRule`, and `text`;
  - the shared mark allowlist is exactly `bold`, `italic`, `strike`, and `code`;
  - `link` and `href` are absent because the shipped editor uses StarterKit without a Link extension;
  - unknown nodes/marks/attributes and invalid nesting fail with a stable renderer code;
  - `<script>`, `<img onerror>`, quotes, ampersands, and stored HTML remain inert;
  - `codeBlock` escapes its text and `horizontalRule` emits one fixed `<hr>`;
  - heading level, ordered-list start, and StarterKit's `codeBlock.language`
    (`null` or a bounded safe token) are the only node attributes;
  - `codeBlock.language` is accepted for editor-shape compatibility but emits
    no class, style, or arbitrary attribute;
  - depth 65 fails while 64 passes, node 20,001 fails while 20,000 passes, and UTF-8 text above 1 MiB fails before further output accumulation;
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

Define one implementation/test contract:

```ts
export const DELIVERY_NODE_TYPES = [
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'text',
] as const

export const DELIVERY_MARK_TYPES = ['bold', 'italic', 'strike', 'code'] as const

export const DELIVERY_MAX_DEPTH = 64
export const DELIVERY_MAX_NODES = 20_000
export const DELIVERY_MAX_TEXT_BYTES = 1024 * 1024
```

The renderer and its golden tests import these same constants. Do not maintain a second test-only allowlist.

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
generateSitemap(...)
generateRobots(...)
generateJsonLd(...)
generateLlmsTxt(...)
canonicalUrl(...)
```

The index accepts the opaque shard descriptors returned by `list_published_delivery_shards`; it does not derive them by scanning route pages. A child passes the shard's exclusive start and inclusive end to `list_published_delivery` and never reads beyond it. Set `MAX_SITEMAP_URLS = 4_000` and `MAX_SITEMAP_BYTES = 52_428_800`; measure each escaped entry before append.

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
  - calls `/rest/v1/rpc/get_published_by_slug`, `/rest/v1/rpc/list_published_delivery`, and `/rest/v1/rpc/list_published_delivery_shards`;
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
  - render through `renderDocToHtml` only when a field key appears in the RPC's declared `richtext_field_keys` projection;
  - fail the entire public read with `delivery_richtext_field_key_unsupported` when `richtext_field_keys_supported` is false;
  - use the one documented `set:html` boundary only for renderer output;
  - output canonical/meta/JSON-LD;
  - set `Referrer-Policy`, a restrictive CSP compatible with later bootstrap, and cache headers;
  - respond 404/no-store for absent/unpublished content.

Static Astro routes retain precedence over the fallback typed route. Do not create a catch-all.

- [ ] Implement artifact routes. The index calls `list_published_delivery_shards` exactly once and never calls the row-list RPC. Each child passes one shard's bounds to `list_published_delivery`, performs at most four 1,000-row RPC calls, and fails loudly if the database returns a cursor beyond the inclusive end. Map `delivery_shards_timeout` to a safe non-2xx `no-store` artifact failure; never fall back to an application-side scan.

There is intentionally no purge webhook, cache tag, Cloudflare API token, or
new binding. The origin emits `s-maxage=60`; when Cloudflare caching is enabled,
the end-to-end withdrawal ceiling also depends on the exact-route Cache Rule
deployment check in design §6.

**Gate**

```sh
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro typecheck
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro exec playwright test --grep "published delivery"
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

- [ ] Update `CLAUDE.md` with the durable delivery rules: published-only RPC boundary, reserved first-segment inventory, renderer-owned HTML sink, anonymous no-editor bundle, 60-second origin shared-freshness ceiling plus the conditional deployment Cache Rule check, and bounded sitemap set.

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
