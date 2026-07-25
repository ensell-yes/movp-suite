# C7.4–C7.7 — Inline Editing & Headless Delivery (design)

**Status:** approved (2026-07-23) after adversarial review and implementation-plan
cross-check.
**Depends on:** C7.1–C7.3 complete on `main`.
**Completes:** the C7 tail only when C7.4, C7.5, C7.6, and C7.7 and all gates in
this document pass.

## 1. Goal and outcome

Ship an honest headless-delivery boundary over the existing CMS revision model:

- anonymous visitors can resolve and render only a published revision through a
  deterministic `/<contentType>/<slug>` route;
- authorized owners/admins can edit bound rich-text regions in place without
  putting authorization or credentials in the browser bundle;
- a reusable, private Realtime primitive can report revision writes and
  presence to authenticated headless hosts;
- public pages expose bounded sitemap, robots, JSON-LD, and `llms.txt`
  artifacts; and
- the full edit → approve → publish → public fetch → artifact fetch → conflict
  path is pinned by the `[editor-delivery]` slice.

The public page and delivery artifacts are identical for authenticated and
anonymous requests. User-specific editor state is fetched separately through
`no-store` same-origin endpoints, so a shared cache can never replay one
editor's identity or controls to another visitor.

### Success gate

The C7 tail is complete only when all of the following are true:

1. a draft is invisible to `anon`, while its published revision resolves at
   exactly one typed route whose content-type key cannot collide with an
   existing static application namespace;
2. a member cannot create or mutate CMS authoring data through GraphQL, an
   INVOKER RPC, or direct PostgREST, while an owner/admin can;
3. a bound rich-text region can be edited with keyboard-only interaction, a
   concurrent save preserves the draft and returns the existing conflict UX,
   and authorization is enforced server-side;
4. two authenticated fixture sessions receive private revision Broadcast and
   Presence, while a non-member and a client-originated Broadcast insert are
   denied;
5. sitemap children are protocol-bounded, public delivery emits a tested
   60-second origin shared-cache freshness ceiling, the production Cache Rule
   is checked when Cloudflare caching is enabled, and 404/edit responses are
   never stored; and
6. the local gate set and authoritative CI gates in §14 are green, followed by
   an eight-dimension implementation review with mean ≥9.2 and no dimension
   below 9.2.

## 2. Scope and architecture

### 2.1 New units

| Unit | Kind | Responsibility |
|---|---|---|
| `@movp/delivery` | publishable client/server-safe leaf package | Allowlisted doc-JSON rendering; binding attributes; canonical/meta helpers; bounded sitemap, robots, JSON-LD, and `llms.txt` generators |
| `@movp/editor-sdk/overlay` | client-safe subpath | Discover bound regions, ask the host whether they are editable, mount `MovpEditor`, and route saves through injected callbacks |
| `@movp/realtime` | publishable client-safe leaf package | Transport-injected private content-channel subscription and bounded reconnect; no Supabase runtime dependency |
| `content.updateRichTextField` | domain method + GraphQL mutation | Read/validate/merge one rich-text field, then delegate to the existing canonical `ContentService.update` path |
| Frontend delivery PoC | Astro routes and same-origin edit proxy | Typed public route, artifacts, cache headers, overlay host callbacks, and SEO display |
| Three forward-only migrations | SQL | published reads + route uniqueness; edit-capability/RLS rewrite; Realtime trigger/channel authorization |

`@movp/delivery` may depend on the existing client-safe `@movp/richtext` leaf.
Neither new package may import `@movp/domain`, `@movp/auth`, `@movp/graphql`,
`@supabase/*`, service-role names, or frontend server modules. No new external
dependency is required: `@movp/realtime` consumes a host-injected structural
transport instead of adding `@supabase/realtime-js`.

Both packages must be registered in package-artifact, publishable-version,
Verdaccio pack/install, documentation-manifest, and CI-wiring inventories. The
editor package must add a real built/exported `./overlay` entry; a source file
without a package export does not satisfy C7.4.

### 2.2 Authoritative boundaries

| Boundary | Authority | Explicit non-authority |
|---|---|---|
| Public read | published-only SECURITY DEFINER RPC | caller RLS, client filtering, or a draft-capable GraphQL query |
| Edit | `has_content_capability(workspace_id, 'edit')` at RLS/RPC/Edge boundaries | overlay `canEdit`, decoded JWT claims, hidden controls |
| Conflict | existing hash-first `public.update_content` RPC | a parallel revision writer |
| Realtime | private channel + `realtime.messages` RLS | topic secrecy or a public channel |
| Public cache | origin `Cache-Control` plus an exact-route deployment rule if Cloudflare caching is enabled | cache tags, purge webhooks, or a plan-specific purge API |

## 3. Deterministic public identity and migration preflight

The URL is `/<contentType>/<slug>`, scoped to the deployment's configured
workspace. `content_item.slug` is already required and unique within
`(workspace_id, content_type_id)`, but `content_type.key` is not currently
unique within a workspace. The typed route is therefore ambiguous until the
first migration establishes:

```text
unique (content_type.workspace_id, content_type.key)
```

Use the forward-only migration
`supabase/migrations/20260723000001_content_delivery_reads.sql`. Do not edit the
frozen generated migration.

Before adding the constraint, the migration performs a counts-only duplicate
preflight. If any `(workspace_id, key)` group has more than one row, it aborts
the transaction with stable message/code `content_type_key_duplicates`.
Diagnostics may include the number of duplicate groups, but never keys, labels,
field schemas, or content. There is no automatic rename or winner selection:
that changes public URLs and requires an operator decision.

The constraint is named and tested. A pgTAP fixture with two `blog` types in one
workspace must prove the preflight failure; after the conflicting fixture is
resolved, two different workspaces may each use `blog`, while one workspace
cannot.

Astro static routes take precedence over `/[contentType]/[slug]`. The same
migration therefore rejects content-type keys equal to the current
two-segment application namespaces:

```text
admin, api, auth, campaigns, content, notes, segments, settings, tasks, workflows
```

Private predicate `movp_internal.is_reserved_content_type_key(text)` is the
single source for the set. Private preflight
`movp_internal.assert_no_reserved_content_type_keys()` rejects an existing
collision, and trigger
`content_type_reserved_key_tg BEFORE INSERT OR UPDATE OF key` calls
`movp_internal.reject_reserved_content_type_key()` to reject future
collisions. Both paths raise SQLSTATE `23514` with stable message code
`content_type_key_reserved`; neither emits the rejected key. A pgTAP fixture
must prove `admin` fails through both paths. Adding a new static two-segment
top-level namespace requires an additive migration that extends the predicate
and updates the pgTAP route inventory before the frontend route lands.

Route segments are decoded once and rejected before the RPC if they contain a
slash, backslash, NUL/control character, invalid UTF-8, or exceed 128 UTF-8
bytes for the type key or 256 UTF-8 bytes for the slug. The route does not
accept a public `workspaceId` query/body parameter; it resolves `WORKSPACE_ID`
and the canonical site origin via request-time `readServerEnv()`. It never uses
`process.env` or captures request-bound values in module scope.

## 4. Published-only read contract

### 4.1 RPCs

The first migration adds three SECURITY DEFINER functions:

```sql
public.get_published_by_slug(
  ws uuid,
  p_content_type_key text,
  p_slug text
) returns jsonb

public.list_published_delivery(
  ws uuid,
  p_after text default null,
  p_until text default null,
  p_limit integer default 1000
) returns jsonb

public.list_published_delivery_shards(
  ws uuid,
  p_urls_per_shard integer default 4000
) returns jsonb
```

All three use `set search_path = ''`, schema-qualify every object, revoke
`PUBLIC`, and grant execute only to `anon`, `authenticated`, and
`service_role`. They do not grant `anon` direct table access.

`get_published_by_slug` joins the workspace-scoped type and item, requires
`status = 'published'`, requires a non-null `published_revision_id`, and joins
data through that exact revision id. It returns only:

- item id, content-type key, slug, published revision id, and `published_at`;
- the published revision's `data`; and
- `richtext_field_keys`, a names-only projection of declared `richtext`
  fields used to decide which published values receive editor bindings; and
- `richtext_field_keys_supported`, a boolean fail-loud signal proving that no
  declared rich-text key was dropped from the projection; and
- the public SEO `meta`/`jsonld` values associated with the item.

The published revision `data` object is the atomic public content unit. V1 has
no field-level private/publish visibility: every scalar field in that object
may be rendered publicly. A field that must remain private must not be stored
in published revision data. The RPC does not return the complete field schema;
it derives `richtext_field_keys` in SQL, accepts only the same bounded field-key
shape as the renderer (`^[A-Za-z][A-Za-z0-9_-]{0,127}$`), and returns no labels,
enum values, or other schema metadata. CamelCase and hyphenated names therefore
remain valid. If any declared rich-text name falls outside that shape—or the
support proof is absent or not exactly `true` during a rolling deploy—the
adapter returns
`delivery_richtext_field_key_unsupported`; the page fails with a generic
`500 no-store` response instead of rendering stored doc JSON as prose. Otherwise
the page parses and binds doc-shaped JSON only when its key appears in the
projection, so an ordinary text field with a coincidentally doc-shaped value
remains inert text.

`content_seo` is item-scoped current state rather than revision-scoped. Its
writes require the owner/admin `edit` capability. In V1, an authorized SEO
metadata correction may therefore change public canonical/meta/JSON-LD after
the at-most-60-second cache window without republishing; the content body
remains pinned to `published_revision_id`. Revision-scoped SEO is explicitly
deferred to a separate schema/workflow design.

It never returns `current_revision_id`, `approved_revision_id`, another
revision, author id, content hash, search body, workflow state, or a count that
reveals drafts. Missing, unpublished, wrong-workspace, and broken published
pointers all return `null`; the route maps all four to the same 404.

`list_published_delivery` returns route metadata only—item id, content-type key,
slug, published revision id, and published timestamp—in immutable item-id
order. It never returns revision `data`. `p_limit` is clamped to `1..1000`;
`p_after` is an exclusive opaque, versioned item-id cursor and `p_until` is the
inclusive end cursor for one shard. Malformed or reversed bounds fail with
`delivery_cursor_invalid`. A supporting
`(workspace_id, status, id)` index keeps each child scan keyset-paginated.

`list_published_delivery_shards` returns non-overlapping opaque start/end
cursor pairs covering at most 4,000 rows each. Each child passes its exclusive
start and inclusive end to `list_published_delivery`, so it cannot read into
the next shard. A private internal helper owns the bounded scan; the public
wrapper sets `statement_timeout = '2s'`, calls the helper, and maps only
SQLSTATE `57014` / `query_canceled` to catchable stable SQLSTATE `P5701` and
message code `delivery_shards_timeout`. It never falls back to an unbounded
application scan. Child routes pass those bounds to the paginated read and
make at most four 1,000-row RPC calls.

The timeout gate is deterministic rather than timing-dependent. pgTAP asserts
the public wrapper's `pg_proc.proconfig` contains `statement_timeout=2s`, then
transaction-locally replaces the internal scan helper with the same signature
and a body that raises SQLSTATE `57014`. The unchanged wrapper must re-raise
`P5701` with `delivery_shards_timeout`; rollback restores the real helper.
The outer code must differ because pgTAP cannot catch `query_canceled` through
`throws_ok`.

### 4.2 Definer audit and negative tests

The migration's pgTAP suite must prove:

- anon sees one published item and its published revision;
- anon cannot see the current draft after a newer draft revision is written;
- unpublish makes the RPC return `null`;
- a different workspace/type/slug cannot cross-resolve;
- `anon` has no direct grants on content tables;
- each function is SECURITY DEFINER with an empty search path and only the
  intended execute grants; and
- malformed cursor/limit input is bounded and produces the stable safe code.

## 5. `@movp/delivery`

### 5.1 Public API

The package exports typed, pure functions with no DOM or database dependency:

```ts
export interface DeliveryBinding {
  itemId: string
  fieldKey: string
}

export interface DeliveryRoute {
  itemId: string
  contentTypeKey: string
  slug: string
  publishedAt: string | null
}

export function renderDocToHtml(
  doc: unknown,
  options?: { bind?: DeliveryBinding },
): string

export function canonicalUrl(origin: string, route: DeliveryRoute): string
export function generateSitemapIndex(origin: string, shards: readonly string[]): string
export function generateSitemap(entries: readonly DeliveryRoute[], origin: string): string
export function generateRobots(origin: string): string
export function generateJsonLd(input: unknown): string
export function generateLlmsTxt(entries: readonly DeliveryRoute[], origin: string): string
```

Implementation-plan samples must keep these names/signatures synchronized with
the package export and tests.

### 5.2 Renderer allowlist and XSS contract

`renderDocToHtml` parses a structurally validated ProseMirror document and
renders only the nodes already produced by the StarterKit editor:

- nodes: `doc`, `paragraph`, `heading` levels 1–6, `bulletList`,
  `orderedList`, `listItem`, `blockquote`, `codeBlock`, `hardBreak`,
  `horizontalRule`, and `text`;
- marks: `bold`, `italic`, `strike`, and `code`; and
- attributes: only validated heading level, ordered-list start, and
  StarterKit's `codeBlock.language` (`null` or a bounded safe token).

Text and every attribute are HTML-escaped. Unknown nodes, marks, attributes,
invalid nesting, excess depth, excess node count, and malformed shapes fail
with a stable renderer code; they are not emitted, interpreted as HTML, or
silently dropped. Initial bounds are 64 document levels, 20,000 nodes, and
1 MiB of UTF-8 text. Bounds are checked while walking, before accumulating
more output. `codeBlock.language` is accepted because StarterKit serializes the
attribute even when its value is `null`; V1 emits no language-derived class,
style, or arbitrary HTML attribute.

When `bind` is present, the function wraps the rendered field in one element
with escaped `data-movp-item` and `data-movp-field` values. `itemId` must be a
UUID and `fieldKey` must match the bounded stored schema field. These
identifiers are public locators, never credentials; the save boundary still
enforces `edit`. No revision id, draft data, token, email, role, or capability
appears in binding attributes.

Golden security tests include text containing `<script>`, `</style>`, quotes,
ampersands, a crafted attribute payload, an unknown node, an excessive tree,
and the existing `<img onerror>` regression payload. There is no `set:html`
outside the one renderer-owned, tested insertion point.

### 5.3 Canonical/meta and artifact bounds

Canonical URLs use configured `PUBLIC_SITE_URL`, never an untrusted `Host`
header. The origin must be absolute HTTPS outside local test mode. Segments are
percent-encoded exactly once.

JSON-LD accepts only structurally validated JSON-compatible values. Its script
serialization escapes `<` as `\u003c` so a value cannot terminate the
`application/ld+json` script element. It never copies arbitrary HTML.

The Astro PoC exposes:

- `/sitemap.xml` as an index;
- `/sitemap-<opaque-boundary>.xml` as bounded children;
- `/robots.txt`;
- `/llms.txt`; and
- JSON-LD plus canonical/meta tags on each typed public page.

Every sitemap child is limited to 4,000 URLs, each `<loc>` is below the
protocol's 2,048-character limit, and the generator measures escaped UTF-8
bytes before append. It must remain below 52,428,800 uncompressed bytes. The
lower row cap makes the byte bound provable even under worst-case XML escaping
and leaves room for tags and optional `lastmod`.

`llms.txt` is capped at 1,000 entries and 1 MiB. When more published entries
exist, it ends with a stable pointer to `/sitemap.xml`; it never silently
buffers the full catalog. `robots.txt` is constant-sized and points to the
sitemap index.

Sitemap consistency is intentionally eventual. “Every URL exactly once”
applies to a fixed published snapshot, not across separately cached requests
during concurrent publish/unpublish. Shard ranges use immutable item-id
boundaries, so an old index remains valid and duplicate-free; a newly published
item outside its final boundary may wait for the next 60-second index
generation. A concurrency test publishes between index and child fetches,
asserts the old generation remains valid and duplicate-free, and asserts the
new URL appears after cache expiry.

Protocol references:

- <https://www.sitemaps.org/protocol.html>
- <https://developers.cloudflare.com/cache/concepts/cache-control/>

## 6. Cache and withdrawal contract

Successful public pages and artifacts return:

```http
Cache-Control: public, max-age=0, s-maxage=60
```

Unpublished/not-found pages, renderer failures, edit/capability endpoints,
GraphQL proxy responses, and all authenticated operational responses return:

```http
Cache-Control: no-store
```

There is no cache purge webhook, cache-tag dependency, Cloudflare API token, or
retry subsystem. The origin emits a 60-second shared-freshness ceiling; without
a shared cache, unpublish withdrawal is immediate. End-to-end withdrawal within
60 seconds additionally depends on every enabled shared cache respecting that
origin header and, for Cloudflare caching, the deployment check below.
`s-maxage` supplies the origin freshness bound and implies proxy revalidation.
Do not add `stale-while-revalidate` or `stale-if-error`, because either could
weaken the withdrawal ceiling.

Cloudflare does not need to cache these routes for correctness. If production
enables an exact-route Cache Rule, the deployment check must prove that the
rule does not override the 60-second origin TTL and excludes `/api/*`,
GraphQL, authenticated admin paths, and any response with `no-store`.

The public render does not inspect a session, set a cookie, vary on a cookie,
or include overlay authorization state. A fake-clock shared-cache test proves:
publish → 200; unpublish → a previously cached 200 may remain only before
second 60; after second 60 the route revalidates to `404 no-store`.

## 7. Privileged edit capability and complete write matrix

Use
`supabase/migrations/20260723000002_content_edit_capability.sql`.
`has_content_capability(ws, cap)` gains:

```text
edit -> workspace role in ('owner', 'admin')
```

The existing `approve` and `publish` arms remain owner/admin. No per-user
editor-grant table is added. A future editor-grant model can extend the helper
without weakening the RLS boundary.

### 7.1 Policy matrix

The migration inventories and rewrites every CMS authoring seam, not only
`content_item_rw`:

| Object/path | Read | Write |
|---|---|---|
| `content_type` | workspace member | `edit` for insert/update/delete |
| `content_item` draft/content fields | workspace member | `edit` for insert/update/delete |
| `content_revision` | workspace member | `edit` for insert; update/delete remain denied/immutable |
| approval request | workspace member | `edit` to submit |
| approval decision/vote | workspace member | `approve`; immutable rows stay immutable |
| publish/unpublish event | workspace member | `publish`; immutable rows stay immutable |
| `content_schedule` | workspace member | `publish` for insert/update/cancel |
| `asset` and `content-assets` issue/finalize | workspace member | `edit`, checked before any service-role write |
| `content_collection` and entries | workspace member | `edit` |
| `content_seo` | workspace member | `edit` |
| `edges` with `src_type = 'content_item'` (currently `references` and `editorial_task`) | existing read rules | `edit` for insert/update/delete; inbound edges with only `dst_type = 'content_item'`, including campaign `produces`, keep their existing policy |
| comments/collaboration on a content item | existing collaboration rules | unchanged; commenting is not authoring |

CMS INVOKER RPCs continue to rely on caller-bound RLS and therefore inherit the
matrix. SECURITY DEFINER/server-role paths must perform an explicit
caller-bound capability check before their privileged write. In particular,
`content-assets` authenticates the user and checks
`has_content_capability(workspaceId, 'edit')` with the user's client before its
admin insert/update.

The `edges` predicate is directional and fail-closed: every current or future
content-originated edge (`src_type = 'content_item'`) requires `edit`,
regardless of relation or destination. The current authoring relations are
`references` (asset/content targets) and `editorial_task`. Merely targeting a
content item does not make an edge a CMS authoring write, so a member may keep
creating the established campaign edge
`campaign_deliverable --produces--> content_item`. The migration splits or
replaces the blanket `edges_rw` policy so its INSERT/UPDATE `with check` and
UPDATE/DELETE `using` clauses preserve that exact direction.

Direct changes to publication pointers/status remain behind the existing
publish workflow. The policy/trigger audit must ensure a caller with `edit`
alone cannot set `published_revision_id`, forge a publish event, or schedule a
publish if future capability roles diverge.

### 7.2 Blast radius and landing gate

This intentionally removes content-authoring rights from `member`. Before the
migration lands, inventory every repository path that creates or mutates CMS
rows:

- `[content]`, `[campaigns]`, `[workflows]`, and the new
  `[editor-delivery]` slices;
- domain/GraphQL/MCP/CLI CMS integration fixtures;
- demo seed and frontend mock identities;
- `fixtures/verdaccio-crm-lite/gate.sh`; and
- all four `fixtures/verdaccio-gallery/gate.sh` templates:
  crm-lite, marketing-site, support-desk, and knowledge-base.

Re-seed the author as owner/admin (or explicitly grant the fixture role that
maps to `edit`). Do not weaken a denial assertion or restore member writes for
test convenience.

pgTAP and HTTP integration tests pin owner/admin allow and member/non-member
deny through GraphQL, the authoring RPC, direct PostgREST, the content-assets
service-role seam, and content-originated edge inserts. A direct PostgREST
interaction test additionally pins the directional exception: a member's
`campaign_deliverable --produces--> content_item` insert succeeds; that member's
`content_item --references--> asset` insert fails; the latter succeeds for an
owner/admin. The full slice and template gates are listed in §14.

## 8. `updateRichTextField`: one canonical write path

The public name is rich-text-specific:

```ts
export type RichTextFieldUpdateResult =
  | { status: 'saved'; revisionId: string }
  | { status: 'conflict' }
  | { status: 'error'; code: string }

updateRichTextField(input: {
  itemId: string
  fieldKey: string
  body: string
  expectedRevisionId: string
}): Promise<RichTextFieldUpdateResult>
```

The domain method performs one caller-bound item/current-revision/type read,
validates that `fieldKey` exists and is `richtext`, merges only that field into
the latest data, and calls the existing `ContentService.update`. That path
normalizes all rich text, computes the effective canonical hash/search values,
and delegates to the existing hash-first `public.update_content` RPC from
`20260716120000_update_content_hash_first.sql`.

It must not insert `content_revision` directly, duplicate `prepare()`, or create
a second write RPC. Thus an identical effective merge with a stale expected
revision receives the existing idempotent no-op success, while a different
merge on a stale revision returns `conflict`.

GraphQL exposes mutation `updateRichTextField` only; MCP/CLI parity is deferred.
The sanitized error contract remains `extensions.code = 'CONFLICT'`. Other
operational failures map to stable safe codes and never return a database
message.

### 8.1 Save observability ownership

Three signals have distinct owners:

1. the GraphQL resolver emits exactly one structured operational log
   `content.richtext_save_resolver` for every direct or proxied request;
2. the existing Astro proxy keeps its pinned
   `content.richtext_save` request log; and
3. a newly inserted revision continues to emit exactly one database domain
   event `content.revision_created`.

The resolver log contains only a server-minted `request_id` and `trace_id`,
optional validated `client_request_id`, `workspace_id_hash`, validated
`actor_id`, validated `item_id`, validated `field_key`, outcome, safe error
code, and `latency_ms`. Success uses `error_code='ok'`; conflict uses
`content_update_conflict`; failures use a bounded safe code. It never contains
the body, content hash, token, cookie, email, schema, URL, or value preview.
The proxy forwards its request id as client correlation, but the internet-facing
GraphQL edge never trusts that value as its own audit identity.

A direct GraphQL test with no Astro proxy proves the resolver log exists
exactly once. Separate tests prove a new save creates one domain event, an
idempotent no-op creates no second revision event, and a conflict creates no
revision event.

## 9. In-place overlay and reference host

### 9.1 Client-safe API

`@movp/editor-sdk/overlay` exports:

```ts
export interface OverlayRegion {
  itemId: string
  fieldKey: string
  body: string
  revisionId: string
}

export interface OverlayOptions {
  root?: ParentNode
  canEdit(region: Pick<OverlayRegion, 'itemId' | 'fieldKey'>): Promise<boolean>
  resolveEditable(
    region: Pick<OverlayRegion, 'itemId' | 'fieldKey'>,
  ): Promise<OverlayRegion | null>
  save(
    region: OverlayRegion,
    body: string,
  ): Promise<
    | { status: 'saved'; revisionId: string }
    | { status: 'conflict' }
    | { status: 'error'; code: string }
  >
}

export function mountOverlay(options: OverlayOptions): { destroy(): void }
```

The overlay scans only elements containing both binding attributes, validates
them structurally, deduplicates regions, and asks `canEdit` before adding
chrome. The reference bootstrap permits multiple bound fields only when every
region has the same validated item id; zero, invalid, or mixed item ids fail
closed before the capability probe. `canEdit` controls presentation only.
`resolveEditable` and `save` remain authoritative server calls, and `save`
ultimately reaches the RLS-gated GraphQL mutation.

The overlay reuses `MovpEditor` and its non-destructive conflict surface. It
does not fork editor state, canonicalization, or conflict classification.
`destroy()` removes listeners, mounted roots, timers, and chrome, and is safe
to call twice.

The overlay carries the primitive's safe error code unchanged. Its UI maps a
small allowlist of stable codes to actionable messages (for example,
`auth_error` asks the user to sign in again and `save_failed` asks them to
retry). An unknown code uses the generic safe fallback and is never rendered
verbatim. The error path keeps the draft and remains available to assistive
technology through `role="alert"`.

### 9.2 Cached-page/session split

The typed page always emits the same public bound HTML and a tiny bootstrap
entry that has **no static import path** to `@movp/editor-sdk`,
`@movp/editor-sdk/overlay`, TipTap, React editor code, or their transitive
chunks. The built-graph gate walks every statically reachable chunk, rejects
TipTap/ProseMirror runtime signatures or overlay markers, and enforces a
bounded aggregate byte budget; synthetic graph tests prove both rejection
paths with non-tree-shakeable fixtures. The bootstrap reads the one validated
bound item id and makes a
same-origin, credentialed, `no-store` capability probe. A missing/invalid
session returns `{canEdit:false}`. Only `{canEdit:true}` triggers:

```ts
const { mountOverlay } = await import('@movp/editor-sdk/overlay')
```

The dynamic import is the code-split boundary: anonymous visitors download the
small bootstrap and probe response, but no overlay/editor/TipTap chunk. Probe
failure is fail-closed (no import/chrome) and emits the server-side safe
operational signal. There is no browser-readable authentication hint cookie;
the HttpOnly session remains the only credential. For an authorized session,
the probe returns only the advisory boolean needed to load the chunk, after
which `resolveEditable` obtains the region data. The browser never receives the
raw GoTrue JWT.

The Astro callbacks use request-bound `Astro.locals`, `readServerEnv`, and the
session cookie at call time. They never capture a Supabase client, token, env,
or request id in a constructor/module closure, and never use `process.env`.
POST save retains Astro's same-origin check. Capability/read/save responses are
`no-store`.

### 9.3 Accessibility and UX

Only authorized regions receive a visible edit affordance. The overlay has:

- keyboard activation with Enter/Space;
- 44px minimum controls and visible focus;
- descriptive accessible names including the field;
- focus moves into the dialog on open; Escape closes and returns focus to the
  originating affordance;
- `aria-live` saved/conflict/error feedback;
- no hover-only action;
- reduced-motion behavior; and
- no draft replacement except the existing explicit “Load latest field” path.

Playwright uses role/name assertions, a keyboard-only flow, focus-return
assertion, reduced-motion fixture, and axe. Save/resolve failures retain the
draft and leave an actionable inline error.

## 10. `@movp/realtime`: headless primitive, private fixture

C7.5 is deliberately scoped to a reusable primitive plus a dedicated
authenticated browser fixture. The reference Astro delivery editor keeps its
GoTrue token HttpOnly and does **not** claim live Presence or revision updates
in this phase. Adding Realtime to that editor requires a separately designed
scoped-token or server-relay boundary.

`@movp/realtime` accepts a host-provided transport with subscribe, set/refresh
auth, track Presence, and unsubscribe operations. It joins
`content:<item-id>` with `private: true`, validates every inbound payload, and
exposes callbacks for revision and presence. It imports no Supabase package;
the fixture adapts the repository's existing Supabase client.

Reconnect is bounded to three attempts with capped exponential backoff, then
emits `content.realtime_subscribe` with safe outcome/attempt/latency and
surfaces the error to the host. Editing continues without Realtime. Unsubscribe
and page teardown cancel reconnects.

### 10.1 Database Broadcast and channel authorization

Use
`supabase/migrations/20260723000003_content_realtime.sql`.
An `AFTER INSERT` trigger on `content_revision` calls
`realtime.send(payload, 'revision_written', 'content:<item-id>', true)`.
The application payload is exactly:

```text
item_id, revision_id, actor_id, created_at
```

The installed Supabase `realtime.send` adds one UUID `id` transport field when
the application payload omits it. `@movp/realtime` permits only that optional
transport field in addition to the four application fields, validates it, and
discards it before invoking `onRevision`. No wire payload includes revision
data, content hash, slug, field values, token, or email.

The trigger function is owner/SECURITY DEFINER and the database send is a
server-originated Broadcast; it does not depend on the client INSERT policy.
Because the installed `realtime.send` internally catches some insert failures,
the trigger verifies that the revision-specific message row was inserted. An
exception or missing row emits one app-owned, content-disciplined warning with
item/revision ids and a safe SQLSTATE/error code, then returns the new row. It
never includes `SQLERRM` and has no retry loop.

`realtime.messages` policies permit authenticated workspace members:

- SELECT for `extension in ('broadcast', 'presence')`; and
- INSERT for `extension = 'presence'` only.

Client-originated Broadcast INSERT remains denied. The policy validates that
the topic starts with `content:` and that the suffix is a UUID before casting,
then resolves the item's workspace and caller membership. A malformed topic
returns false rather than throwing.

The hosted project must keep Realtime Authorization enabled, and the fixture
must create its channel with `private: true`. The host refreshes Realtime auth
when its browser-readable fixture session refreshes; authorization is
re-evaluated on subscription/token update, matching Supabase's documented
policy cache.

Platform references:

- <https://supabase.com/docs/guides/realtime/authorization>
- <https://supabase.com/docs/guides/realtime/broadcast>

The two-session browser integration test proves Presence join/leave and the
trigger Broadcast. Negative tests prove non-member subscribe denial, malformed
topic denial, client Broadcast INSERT denial, and successful trigger delivery.

## 11. SEO completion

The CMS editor already calls `runSeoAudit` and renders score/checklist data.
C7.6 makes that output a first-class, accessible editor panel:

- score has a textual label, not color alone;
- every failed checklist item names the corrective action;
- empty/error/success states are distinct;
- rerunning the audit refreshes the panel without discarding editor state; and
- the public page's canonical/meta/JSON-LD generation uses the same persisted
  SEO record that the audit evaluated.

The audit remains advisory. It neither grants publication nor overrides
approve/publish capability. Playwright pins the score, checklist, failure
state, and keyboard access. The item-scoped current-state behavior in §4.1 is
intentional V1 scope: `edit` gates metadata changes, while a future
revision-scoped SEO model remains deferred.

## 12. Error handling and observability

| Path | Stable behavior | Signal |
|---|---|---|
| public missing/unpublished | `404`, `no-store`, no draft distinction | `delivery.public_read`, route kind + workspace hash + `not_found` + latency |
| public RPC/renderer failure | `500` or bounded-timeout `503`, `no-store`, generic page | same event with safe code/request id/latency |
| unsupported published rich-text key | `500`, `no-store`, never render stored doc JSON as prose | `delivery.public_read`, `delivery_richtext_field_key_unsupported` |
| overlay capability denied | no chrome; save endpoint `403` | server operational event, validated ids only |
| rich-text conflict | GraphQL `CONFLICT`; existing draft-preserving UI | resolver + proxy logs; no new revision event |
| Realtime subscribe exhausted | editor continues; presence absent; host receives error | `content.realtime_subscribe`, attempt `3`, safe code/latency |
| database Broadcast send failure | revision remains committed | one app-owned warning with item/revision ids and safe SQLSTATE/error code |
| artifact bound exceeded | fail hard; never emit invalid/truncated XML | `delivery.artifact`, kind + safe bound code + latency |
| retired/unknown sitemap child | `404`, `no-store` | `delivery.artifact`, `not_found`, no error code |
| artifact operational failure | `500` or bounded-timeout `503`, `no-store` | `delivery.artifact`, `error`, runtime-allowlisted safe code |

Public logs use route kinds (`page`, `sitemap_index`, `sitemap_child`,
`robots`, `llms`) rather than paths/slugs. No signal includes content, a URL,
schema, payload preview, token, cookie, email, or unvalidated field/topic.
Every record uses the registered `delivery` surface and imports the canonical
`@movp/obs` redaction version. Error classifiers are checked against an exact
runtime allowlist before emission.
Expected 404s remain distinguishable from operational failures without
revealing whether a draft exists.

## 13. Testing matrix

| Invariant | Test/gate |
|---|---|
| type key uniqueness preflight is counts-only and transactional | new pgTAP migration test; `content_type_key_duplicates` pinned |
| reserved top-level namespaces cannot shadow typed delivery | pgTAP existing-row preflight + direct insert/update; `content_type_key_reserved` pinned |
| anon sees only the exact published revision | pgTAP public-delivery positive/negative suite |
| only supported, declared rich-text fields receive bindings | RPC projection/support-flag pgTAP + guarded two-literal SQL↔renderer pattern drift gate + camelCase/hyphen renderer tests + doc-shaped ordinary-text frontend regression |
| definer/grants/search-path audit | pgTAP catalog assertions |
| shard timeout is bounded and maps cancellation deterministically | `pg_proc.proconfig` assertion + transaction-local inner SQLSTATE `57014` scan-helper replacement; outer `P5701`/`delivery_shards_timeout` assertion |
| renderer allowlist, escaping, depth/node/text bounds | `pnpm --filter @movp/delivery test` |
| JSON-LD cannot close its script; canonical origin is configured | delivery unit/golden |
| sitemap index/children stay ≤4,000 URLs and <52,428,800 bytes | >50k synthetic golden set plus byte-edge cases |
| publish-between-index/child follows documented eventual model | fake-clock concurrency test |
| `llms.txt` caps rows/bytes and points to sitemap | delivery golden |
| public 200 is `s-maxage=60`; 404/API are `no-store` | frontend route/cache unit |
| owner/admin allow; member/non-member deny every matrix seam | pgTAP + GraphQL/RPC/PostgREST/Edge integration |
| existing slices/gallery authors use privileged fixture identity | local slice plus authoritative CI jobs |
| inbound campaign `produces` remains member-writable; every content-originated edge requires `edit` | direct PostgREST member/owner interaction test |
| rich-text primitive delegates to hash-first update | domain unit/integration; idempotent/conflict parity |
| direct GraphQL save has one safe resolver log | GraphQL resolver test without proxy |
| one new revision = one domain event; no-op/conflict = none | database/domain integration |
| overlay package export and strict client boundary | editor-sdk public-surface + recursive guarded boundary test |
| anon public entry has no static editor dependency and fetches no overlay/TipTap chunk; authorized probe loads it | built-manifest reachability gate + Playwright network assertion |
| safe overlay error code maps to an actionable message; unknown code is generic | editor-sdk overlay mounted test |
| keyboard/Escape/focus/live region/reduced motion/axe | frontend Playwright |
| private revision Broadcast and Presence | two-session Realtime browser fixture |
| four application Broadcast fields plus optional validated/discarded transport `id` | Realtime unit + trigger integration |
| malformed/non-member/client-Broadcast paths deny | Realtime pgTAP/integration |
| item-scoped current SEO requires `edit`; metadata can change without changing published body revision | capability pgTAP + public-delivery integration |
| SEO score/checklist/error UI | frontend component + Playwright |
| full lifecycle and conflict | `[editor-delivery]` slice after `[content]` |

Boundary scanners recursively walk package source with `lstat`, reject symlinks,
check size before reading, and then scan regular TypeScript/TSX files. The
package tests must prove a helper extracted into a subdirectory cannot escape
the inventory.

## 14. Build sequence and landing gates

Implement in this dependency order:

The first half of C7.6 intentionally lands before C7.4 and C7.5 because the
overlay and Realtime work both need a rendered delivery page. The plan filename
sequence `07e`–`07i`, rather than the product sub-labels, is authoritative.

1. **Delivery core:** `20260723000001_content_delivery_reads.sql` (duplicate and
   reserved-key preflights, uniqueness, reserved-key trigger, published reads,
   shard RPC/index), `@movp/delivery`, typed public route, bounded artifacts,
   and cache headers.
2. **Authorization rewrite:**
   `20260723000002_content_edit_capability.sql`, full policy/privileged-path
   inventory, fixture-identity updates, and bypass tests.
3. **Canonical field mutation:** domain `updateRichTextField`, GraphQL mutation,
   resolver observability, and thin Astro proxy adaptation.
4. **Overlay:** built `@movp/editor-sdk/overlay` subpath, public bindings,
   probe-first dynamic-import bootstrap, request-time host callbacks,
   accessibility, anonymous bundle/network gate, and Playwright.
5. **Headless Realtime:** `@movp/realtime`,
   `20260723000003_content_realtime.sql`, private-channel RLS, and the dedicated
   browser-session fixture. Do not claim reference-template Realtime.
6. **SEO finish:** editor score/checklist/error presentation and public
   canonical/meta/JSON-LD parity.
7. **C7.7:** add `[editor-delivery]` after `[content]`, package/docs updates,
   Stage C execution-status update, and final review.

Each implementation plan must use TDD, name the exact fail-first expectation,
and end every task with a machine-checkable gate. Migrations are forward-only
and land in the order above.

### 14.1 Mandatory local gates

After the capability migration and all C7-tail work:

```sh
node scripts/check-forward-only-migrations.mjs
supabase test db
bash scripts/slice-e2e.sh
pnpm --filter @movp/delivery test
pnpm --filter @movp/realtime test
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/frontend-astro test
pnpm --filter @movp/frontend-astro e2e
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
pnpm typecheck
pnpm build
```

Expected: every command exits 0; the slice prints all existing slice PASS
markers plus `[editor-delivery] PASS`.

The frontend command is intentionally
`pnpm --filter @movp/frontend-astro e2e`:
`templates/frontend-astro/package.json` defines
`"e2e": "playwright test"`. There is no `test:e2e` script.

### 14.2 Authoritative Verdaccio/template gate

The aliases `pnpm check:verdaccio-crm` and
`pnpm check:verdaccio-gallery` exist, but their local Deno edge-serve stage is
known to be intermittently flaky. Local publish/install/codegen/db-reset stages
remain useful evidence, but a local Edge BOOT_ERROR/timeout is not the
capability migration's landing authority.

Authoritative evidence is green GitHub CI after the migration:

- `c6-productization` (including CRM-lite real publish/install/runtime gate);
- `template-smoke (crm-lite)`;
- `template-smoke (marketing-site)`;
- `template-smoke (support-desk)`; and
- `template-smoke (knowledge-base)`.

A failure before or after Edge startup is still investigated; only the
documented local-only runtime flake is not misreported as a product defect.

## 15. Deferred

- per-user editor grants beyond owner/admin;
- CRDT/co-editing;
- Realtime inside the reference Astro editor (requires scoped browser token or
  server relay);
- MCP/CLI parity for `updateRichTextField`;
- arbitrary typed-block/page-layout composition and visual style controls;
- legacy HTML parsing into rich-text marks;
- cache purge automation; and
- multi-workspace custom-domain routing.

These are explicit seams, not partially rendered controls. The implementation
must not imply that a deferred capability is enforced.

## 16. Eight-dimension self-review

Severity was classified before scoring. The v1–v4 review findings are resolved
in the load-bearing sections above: route uniqueness is explicit and
transactional; resolver observability covers direct headless callers;
Verdaccio authority is correctly split between local evidence and CI; sitemap
consistency and byte/row bounds are stated; the rich-text primitive name and
canonical RPC reuse are exact; purge machinery is removed; Realtime scope is
honest; the edge policy is directional and fail-closed without breaking inbound
campaign links; anonymous delivery cannot reach an editor/TipTap chunk; safe
overlay error codes remain actionable; and the full capability blast radius is
gated.

| Dimension | Score | Reconciliation |
|---|---:|---|
| Correctness | 9.3 | Deterministic typed routes, published-pointer reads, one hash-first write path, explicit sitemap consistency, and positive/negative contracts |
| Safety | 9.3 | Published-only definer, directional content-originated edge gate, complete `edit` matrix, service-role prechecks, private Realtime RLS, strict renderer, and no browser credential exposure |
| Reliability | 9.2 | Transactional duplicate/reserved-key stop, deterministic timeout mapping, fail-loud bounds, 60-second origin cache ceiling with a conditional deployment-rule check, bounded reconnect, graceful Broadcast failure, and authoritative CI gates |
| Observability | 9.3 | Direct resolver, proxy, database, public delivery, artifact, and Realtime signals have distinct owners and content-disciplined correlation |
| Efficiency | 9.2 | No purge subsystem or new external dependency; keyset pagination, ≤4 child RPCs, one canonical writer, and bounded artifact work |
| Performance | 9.2 | Anonymous pages cannot reach editor/TipTap chunks; public cache bound, indexed cursor reads, capped renderer/catalog memory, no polling, and no unbounded artifact response |
| Simplicity | 9.2 | Three focused client-safe units with first consumers; existing editor/hash/SEO paths are reused; deferred scope stays unimplemented |
| Usability | 9.3 | Deterministic URLs, honest Realtime scope, draft-preserving keyboard/a11y overlay, safe-code-specific errors, actionable SEO, and explicit operator gates |

**Mean:** `(9.3 + 9.3 + 9.2 + 9.3 + 9.2 + 9.2 + 9.2 + 9.3) / 8 =
74.0 / 8 = 9.25`.

**Verdict:** design-ready at **9.25**. The mean clears 9.2 and no dimension is
below 9.2. This does not mark C7 implemented; C7.4–C7.7 remain pending until
the ordered work and every local/CI gate above pass.
