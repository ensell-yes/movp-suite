# MOVP App — CMS Phase 4, Part D: Surfaces, Frontend & End-to-End

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Surface the CMS behaviour that **Parts A/B/C** already built. Parts A–C delivered every CMS collection (all `internal: true`), their RLS, the lifecycle/approval/publish/schedule triggers, the signed publish webhook, and the entire `content` domain service (`ContentService`, wired into `createDomain`). Part D adds **no new collection and no new migration** — it only adds the GraphQL, MCP, and CLI surfaces for the internal `content_item`/`content_type`/`content_revision` collections (custom ops only), the Astro CMS frontend (list, field-schema-driven editor, revision diff, approval queue, editorial calendar), and an end-to-end CMS slice in `scripts/slice-e2e.sh`.

**Architecture:** Every CMS collection is `internal: true`, so the schema-driven builders (GraphQL `packages/graphql/src/schema.ts`, MCP `packages/mcp/src/server.ts`, CLI `packages/cli/src/program.ts`) **skip** their generic CRUD via the existing `if (c.internal) continue` guards (added in the collab phase). CMS is therefore reached **exclusively** through custom ops added here, each resolving `domainFrom(ctx).content.*` — mirroring the collab `if (refs.has('comment'))` block and the Task `if (refs.has('task'))` block. Editorial **discussion** reuses Collaboration's `collab.comment.*` on `entity_type='content_item'` (Part A added the `can_access_entity('content_item')` arm) via the existing `comments` GraphQL query (added by Task 01c) + `addComment` (05b) + `inbox`. Content **search** reuses `content_item.search_text`/`search_body` (FTS + chunked embeddings) via the existing generic `search` query + the `search_fts('content_item')` arm Part A added. No new domain code: `createDomain(ctx).content` is a fixed input.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest. `.ts` relative imports with explicit extensions; bare `@movp/*` workspace specifiers. Pothos (`@pothos/core`) for GraphQL; `@modelcontextprotocol/sdk` + `zod` for MCP; `commander` for the CLI. Astro + GraphQL-over-HTTP (no `@movp/{auth,domain}`) for the frontend; Playwright + `@axe-core/playwright` for the a11y smoke. `openssl` for the webhook HMAC check in the e2e slice.

**This is Part D of the Phase-4 CMS series.** It depends on **Parts A, B & C** (the CMS collection config in `@movp/core-schema`; the CMS migrations; the generated content types in `packages/domain/src/generated/types.ts`; and the committed `content` `ContentService` wired into `createDomain`) being merged first. **Part D adds NO migration and NO new collection.** It edits only `packages/{graphql,mcp,cli}` + `templates/frontend-astro` + `scripts/slice-e2e.sh`.

## Global Constraints

- **Consume Parts A/B/C; do not rebuild them.** The CMS tables, their RLS, the approval/publish/schedule/webhook triggers, the generated content types, AND the committed `content` `ContentService` are fixed inputs. Do not add a migration, a collection, or a domain method. If a surface needs behaviour the service does not expose, STOP and reconcile — do not add it here.
- **`ContentService` is a fixed contract** (see "Inputs consumed → ContentService methods"). Surfaces call it verbatim; they never rename or add methods.
- **Per-request dependencies resolved at call time.** Every resolver/tool/command builds a fresh `createDomain({ db: ctx.db, userId: ctx.userId })` per request via the existing `domainFrom(ctx)` pattern — never module scope. The ONE place a surface touches the DB directly (the detail-only `content_type` nested resolver) reads `ctx.db` (the caller's RLS-bound client) at call time.
- **CMS is internal — no generic CRUD.** The `if (c.internal) continue` guards (collab phase) already skip every CMS collection in all three builders. Do NOT re-add them; do NOT remove the internal flag. The only CMS read/write paths are the custom `content.*` ops added here.
- **Observability discipline (inherited).** The `content` service and Part B/C triggers own event emission with ids-only, trace-correlated payloads. Surfaces add no logging of row values; the e2e asserts the redaction (Task 5, step 13).
- **Boundary gate.** `templates/` must stay free of `@movp/{auth,domain}` and service-role references — the frontend reaches the backend via GraphQL-over-HTTP only. `bash scripts/check-boundary.sh` must stay green.
- **No migration applier runs in Part D.** There is no SQL in this part.

## Inputs consumed from Parts A/B/C (verify BEFORE Task 1)

Parts A/B/C's deliverables. Part D references them by exact name; a mismatch here is a reconciliation defect, not something to work around.

**Naming invariant (load-bearing):** each CMS collection's `name` in `schema.collections` equals its snake_case DB table name. Part D references, by literal name: `content_item`, `content_type`, `content_revision` (surfaced as object types + custom ops); and, for the create/finalize mutation return shapes, `content_collection` and `content_asset`. Generated TypeScript types are Pascal-singular: `ContentItemRow`, `ContentTypeRow`, `ContentRevisionRow`. The generic GraphQL loop builds an objectRef named `ContentItem`/`ContentType`/`ContentRevision`/… for EVERY collection (including internal ones) — so `refs.get('content_item')`/`refs.get('content_type')`/`refs.get('content_revision')` all resolve; the guards only skip *implementing* them, which is what this part does in the guarded block. If Part A named a collection or table differently, STOP and reconcile.

**`internal` flags (load-bearing):** every CMS collection is `internal: true`. The GraphQL/MCP/CLI builders' existing `if (c.internal) continue` guards already skip them (no generic object type, `Page`, `create*` op, `.create` tool, or `movp <collection>` command). If those guards are absent, STOP — this plan's surface tasks depend on them.

**`ContentService` methods Part D surfaces (fixed contract — `createDomain(ctx).content`):**
- Part A: `createType`, `listTypes`, `create`, `update`, `get`, `list`, `listRevisions`
- Part B: `submitForApproval`, `decideApproval`, `publish`, `unpublish`, `getPublished`
- Part C: `schedule`, `issueAssetUpload`, `finalizeAsset`, `createCollection`, `addToCollection`, `reorderCollection`, `runSeoAudit`, `linkAsset`, `linkItem`, `linkEditorialTask`

> **Signature reconciliation (load-bearing) — reconciled, not guessed.** This plan's resolver/tool/command/e2e argument objects have been reconciled to the authoritative `ContentService` in `packages/domain/src/content.ts` (Parts A/B/C). The load-bearing corrections: `decideApproval({ approvalId, vote }) → ContentApprovalRow` (NOT `{ itemId, decision, comment }` → item); `schedule({ itemId, action, revisionId, runAt }) → ContentScheduleRow` (NOT `{ publishAt, unpublishAt }` on the item — Part C stores schedules in a separate `content_schedule` table); `issueAssetUpload({ workspaceId, filename, mime, sizeBytes })` (NOT `contentType`/`bytes`); `finalizeAsset({ assetId, checksum, sizeBytes, width?, height? })` (NOT `r2Key`/`bytes`; `checksum`/`sizeBytes` are parity-only — the edge fn re-HEADs R2). Both remaining names are now reconciled against Part A: `content.create` takes `{ workspaceId, contentTypeId, slug, data }` — there is NO `content_item.title` column; in a headless CMS the display title is a FIELD inside the content model's `data` jsonb (or the denormalized `search_text`), so the list/detail display label is `slug`/`search_text`. And `createType` uses `label` — Part A's `content_type` has a `label` column, not `name`. The mocked surface tests (Tasks 1–3) prove routing; the **`[content]` e2e (Task 5)** is the running-service check.

**Reuse — already surfaced, do NOT re-add:**
- The `comments` query (Task 01c) resolves `collab.comment.listByEntity` — the editor's discussion source, with `entityType: "content_item"`. `addComment` (05b) posts to it.
- The generic `search` query + the `search_fts('content_item')` arm (Part A) — the content list's FTS + semantic search source.
- The `inbox` query (Part B) — the editorial calendar's content-mentions/events source.

- [ ] **Precondition check** — confirm Parts A/B/C are merged and discover the names Part D must match. Run:
```bash
cd /Users/ensell/Code/supasuite
grep -q 'ContentItemRow' packages/domain/src/generated/types.ts && echo GEN_ITEM_OK || echo GEN_ITEM_MISSING
grep -q 'ContentTypeRow' packages/domain/src/generated/types.ts && echo GEN_TYPE_OK || echo GEN_TYPE_MISSING
grep -q 'ContentRevisionRow' packages/domain/src/generated/types.ts && echo GEN_REV_OK || echo GEN_REV_MISSING
grep -Rnq "content:" packages/domain/src/domain.ts && echo DOMAIN_CONTENT_OK || echo DOMAIN_CONTENT_MISSING
for m in createType listTypes create update get list listRevisions submitForApproval decideApproval publish unpublish getPublished schedule issueAssetUpload finalizeAsset runSeoAudit createCollection addToCollection; do
  grep -Rnq "$m" packages/domain/src/content.ts && echo "SVC_$m=ok" || echo "SVC_$m=MISSING"
done
grep -Rnq "if (c.internal) continue" packages/graphql/src/schema.ts packages/mcp/src/server.ts packages/cli/src/program.ts && echo GUARDS_OK || echo GUARDS_MISSING
grep -Enq "comments\(|comments:" packages/graphql/src/schema.ts && echo COMMENTS_QUERY_OK || echo COMMENTS_QUERY_CHECK
grep -q "content_item" packages/domain/src/search.ts && echo SEARCH_CONTENT_OK || echo SEARCH_CONTENT_CHECK
# webhook infra the e2e (Task 5, step 7) needs — confirm the committed RPC + signed flows edge function
grep -RnE "webhook|x-movp-signature|movp-signature" supabase/migrations packages/flows/src 2>/dev/null | head -n 20
grep -RnE "hmac|createHmac|x-movp-signature" packages/flows/src 2>/dev/null | head -n 20
test -f supabase/functions/flows/index.ts && grep -n "runFlowsWorker" supabase/functions/flows/index.ts
```
Expected: `GEN_ITEM_OK`, `GEN_TYPE_OK`, `GEN_REV_OK`, `DOMAIN_CONTENT_OK`, every `SVC_*=ok`, `GUARDS_OK`. `COMMENTS_QUERY_OK` and `SEARCH_CONTENT_OK` confirm the reuse surfaces exist (if either prints `_CHECK`, open the file and confirm before Task 4/Task 5). The last three greps must reveal (a) the committed `public.register_webhook(...)` RPC + `movp_internal.webhooks` (the webhook registration path — there is NO `webhook_subscription` table), (b) where the signed `x-movp-signature` HMAC is computed, and (c) `supabase/functions/flows/index.ts` invoking `runFlowsWorker`. If any `GEN_*`/`DOMAIN_*`/`SVC_*`/`GUARDS` check fails, STOP — the prerequisite phase is not merged; this plan cannot execute.

## File Structure

```
supasuite/
  packages/
    graphql/
      src/schema.ts                              # EDIT: content_item block (refs.has('content_item'))
      test/content.test.ts                       # NEW
    mcp/
      src/server.ts                              # EDIT: 12 custom content tools
      test/server.test.ts                        # EDIT: mock content + content-tool assertions
    cli/
      src/program.ts                             # EDIT: movp content group
      test/program.test.ts                       # EDIT: mock content + content-command assertions
  templates/
    frontend-astro/
      src/lib/content-queries.ts                 # NEW: GraphQL documents (list/editor/revisions/mutations)
      src/pages/content/index.astro              # NEW: content list + search
      src/pages/content/[id].astro               # NEW: field-schema editor + SEO + discussion + revision diff
      src/pages/content/approvals.astro          # NEW: approval queue
      src/pages/content/calendar.astro           # NEW: editorial calendar
      tests/content.spec.ts                      # NEW: Playwright + axe smoke
  scripts/
    slice-e2e.sh                                 # EDIT: [content] slice
```

---

### Task 1: GraphQL surface — `content_item` block + `content.test.ts`

Add a `content_item` object type, the `content_type`/`content_revision` object types, the CMS queries, and the CMS mutations to `packages/graphql/src/schema.ts`, mirroring the collab `if (refs.has('comment'))` and Task `if (refs.has('task'))` blocks. Gate the whole block behind `refs.has('content_item')`. The `if (c.internal) continue` guards already skip every CMS collection; `refs` is still built for all collections, so `refs.get('content_item')`/`refs.get('content_type')`/`refs.get('content_revision')` resolve.

**Files:**
- Edit: `packages/graphql/src/schema.ts`
- Test: `packages/graphql/test/content.test.ts`

**Queries produced:** `contentTypes`, `content`, `contentItem`, `contentRevisions`, `publishedContent`.
**Mutations produced:** `createContentType`, `createContent`, `updateContent`, `submitForApproval`, `decideApproval`, `publishContent`, `unpublishContent`, `scheduleContent`, `createContentCollection`, `addToCollection`, `runSeoAudit`, `issueAssetUpload`, `finalizeAsset`.

> **Asset-op ctx wiring (load-bearing — a REAL edit, not just a note).** `issueAssetUpload`/`finalizeAsset` read `ctx.accessToken` + `ctx.assetsFnUrl` (optional fields added to `DomainCtx` in Part C Step 4a). The committed GraphQL path does NOT forward them, so the asset ops would fail `[asset_upload_not_configured]` at runtime. Task 1 Step 3 MUST make these three concrete edits (mirrors the existing `db`/`userId`/`embedder` threading):
> 1. **`packages/graphql/src/types.ts`** — add to `GraphQLContext`: `accessToken?: string` and `assetsFnUrl?: string`.
> 2. **`packages/graphql/src/schema.ts`** — extend `domainFrom(ctx)` to forward them:
>    ```ts
>    function domainFrom(ctx: GraphQLContext): Domain {
>      return createDomain({ db: ctx.db, userId: ctx.userId, accessToken: ctx.accessToken, assetsFnUrl: ctx.assetsFnUrl }, { embedder: ctx.embedder })
>    }
>    ```
> 3. **`supabase/functions/graphql/index.ts`** — populate them where the context object is built (the `yoga.handleRequest(..., { db, userId, embedder })` call): add `accessToken: req.headers.get('Authorization')?.replace('Bearer ', '')` and `assetsFnUrl: \`${env.SUPABASE_URL}/functions/v1/content-assets\`` (resolved per request from the request-bound `env`, never `process.env`).
>
> Add a GraphQL unit assertion that `issueAssetUpload` reaches the mocked service (proves the resolver→service arg wiring) and rely on the Task-5 `[content]` e2e (real edge fn) to prove the token/url actually reach `content-assets`.
>
> **MCP and CLI need the SAME concrete wiring** (their `content.issue_asset_upload` / `movp content asset-upload` surfaces call the guarded asset ops, so a note is not enough — make these real edits):
> - **MCP** — `packages/mcp/src/server.ts`: add `accessToken?: string` + `assetsFnUrl?: string` to the MCP context interface (the one holding `db`/`userId`/`embedder`), and change the `createDomain({ db: ctx.db, userId: ctx.userId }, { embedder: ctx.embedder })` call to forward them: `createDomain({ db: ctx.db, userId: ctx.userId, accessToken: ctx.accessToken, assetsFnUrl: ctx.assetsFnUrl }, { embedder: ctx.embedder })`. In `supabase/functions/mcp/index.ts`, populate the context with `accessToken` from the request `Authorization` Bearer and `assetsFnUrl = \`${env.SUPABASE_URL}/functions/v1/content-assets\`` (per-request `env`).
> - **CLI** — `packages/cli/src/program.ts`: add `accessToken?: string` + `assetsFnUrl?: string` to `CliCtx`, and populate them in `resolveCliCtx()` (`accessToken` = the local session access token; `assetsFnUrl = \`${SUPABASE_URL}/functions/v1/content-assets\``). Since every CLI command does `createDomain(resolveCtx())` — passing the whole ctx object — the new fields flow through automatically once `CliCtx`/`resolveCliCtx` carry them; no per-command change is needed.
> - **Tests:** the MCP + CLI asset-tool unit tests pass a ctx WITH stub `accessToken: 'test'` / `assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets'` and assert `issueAssetUpload` is invoked (i.e. the guard does NOT fire `[asset_upload_not_configured]`) — mirroring the GraphQL assertion.

> **`data`/`field_schema` JSON representation (load-bearing).** The contract keeps `data`/`field_schema` as JSON scalars. This schema has **no registered `JSON` scalar** (precedent: collab `InboxItem.payload` is a JSON `String` — see 05b). To avoid a builder-wide `Scalars` change, expose every JSON field (`data`, `field_schema`, SEO `checklist`) as a `String` carrying JSON: **`JSON.stringify` on output, `JSON.parse` on input.** If the precondition grep found a `JSON` scalar already registered on the builder, switch those fields to `type: 'JSON'` and drop the stringify/parse. Do NOT introduce a new scalar in this part.

- [ ] **Step 1: Write the failing test**

`packages/graphql/test/content.test.ts`:
```ts
import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'ci1', workspace_id: 'w', content_type_id: 'ct1', slug: 'hello',
    status: 'draft', data: { headline: 'Hi' }, current_revision_id: 'r2',
    approved_revision_id: null, published_revision_id: null,
    scheduled_publish_at: null, scheduled_unpublish_at: null, created_at: 't', updated_at: 't', ...over,
  })
  return {
    item,
    createType: vi.fn(async () => ({ id: 'ct1', workspace_id: 'w', key: 'article', field_schema: { fields: [] }, created_at: 't', updated_at: 't' })),
    listTypes: vi.fn(async () => ({ items: [{ id: 'ct1', workspace_id: 'w', key: 'article', label: 'Article', field_schema: { fields: [{ key: 'headline', type: 'text' }] }, created_at: 't', updated_at: 't' }], nextCursor: null })),
    create: vi.fn(async (i: any) => item({ content_type_id: i.contentTypeId })),
    update: vi.fn(async (i: any) => item({ id: i.id })),
    get: vi.fn(async () => item()),
    list: vi.fn(async () => ({ items: [item()], nextCursor: null })),
    listRevisions: vi.fn(async () => [{ id: 'r2', content_item_id: 'ci1', parent_id: 'r1', data: { headline: 'Hi' }, author_id: 'u', created_at: 't' }]),
    submitForApproval: vi.fn(async () => item({ status: 'in_review' })),
    // decideApproval returns the APPROVAL row (content_approval is internal — no generated type).
    decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
    publish: vi.fn(async () => item({ status: 'published', published_revision_id: 'r2' })),
    unpublish: vi.fn(async () => item({ status: 'draft' })),
    // getPublished (Part B) returns { item, revision } — the item plus the FROZEN published-revision snapshot.
    getPublished: vi.fn(async () => ({ item: item({ status: 'published', published_revision_id: 'r2' }), revision: { id: 'r2', content_item_id: 'ci1', parent_id: 'r1', data: { headline: 'Hi' }, content_hash: 'h2', author_id: 'u', created_at: 't' } })),
    // listApprovals (Part B) returns a Page<ContentApprovalRow> — the approval-queue read.
    listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1', content_item_id: 'ci1', state: 'pending' }], nextCursor: null })),
    // schedule returns a ContentScheduleRow (Part C), NOT a content_item.
    schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', action: 'publish', revision_id: 'r2', run_at: '2026-07-02T00:00:00Z', state: 'scheduled' })),
    runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [{ id: 'title', label: 'Has title', passed: true }] })),
    issueAssetUpload: vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' })),
    finalizeAsset: vi.fn(async () => ({ id: 'a1', workspace_id: 'w', r2_key: 'w/a1', filename: 'x.png', mime: 'image/png', size_bytes: 10, created_at: 't' })),
    createCollection: vi.fn(async () => ({ id: 'col1', workspace_id: 'w', created_at: 't' })),
    addToCollection: vi.fn(async () => undefined),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    content: {
      createType: mocks.createType, listTypes: mocks.listTypes, create: mocks.create, update: mocks.update,
      get: mocks.get, list: mocks.list, listRevisions: mocks.listRevisions,
      submitForApproval: mocks.submitForApproval, decideApproval: mocks.decideApproval,
      publish: mocks.publish, unpublish: mocks.unpublish, getPublished: mocks.getPublished,
      listApprovals: mocks.listApprovals,
      schedule: mocks.schedule, runSeoAudit: mocks.runSeoAudit,
      issueAssetUpload: mocks.issueAssetUpload, finalizeAsset: mocks.finalizeAsset,
      createCollection: mocks.createCollection, addToCollection: mocks.addToCollection,
      reorderCollection: vi.fn(), linkAsset: vi.fn(), linkItem: vi.fn(), linkEditorialTask: vi.fn(),
    },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }
const run = (source: string) => graphql({ schema: buildSchema(movpSchema), source, contextValue: ctx })

describe('content GraphQL surface', () => {
  it('createContent routes to content.create (JSON data parsed)', async () => {
    const res = await run('mutation { createContent(workspaceId: "w", contentTypeId: "ct1", data: "{\\"headline\\":\\"Hi\\"}") { id slug status } }')
    expect(res.errors).toBeUndefined()
    expect(mocks.create).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: undefined, data: { headline: 'Hi' } })
    expect((res.data as { createContent: { id: string } }).createContent.id).toBe('ci1')
  })

  it('content list returns a page; contentTypes exposes field_schema as JSON string', async () => {
    const p = await run('query { content(workspaceId: "w") { items { id slug status } nextCursor } }')
    expect(p.errors).toBeUndefined()
    expect((p.data as { content: { items: Array<{ id: string }> } }).content.items[0].id).toBe('ci1')
    const t = await run('query { contentTypes(workspaceId: "w") { id key field_schema } }')
    expect(t.errors).toBeUndefined()
    const ct = (t.data as { contentTypes: Array<{ field_schema: string }> }).contentTypes[0]
    expect(JSON.parse(ct.field_schema).fields[0].key).toBe('headline')
  })

  it('contentItem exposes data as JSON string; contentRevisions lists lineage', async () => {
    const r = await run('query { contentItem(id: "ci1") { id status data current_revision_id approved_revision_id } }')
    expect(r.errors).toBeUndefined()
    const item = (r.data as { contentItem: { data: string } }).contentItem
    expect(JSON.parse(item.data).headline).toBe('Hi')
    const revs = await run('query { contentRevisions(itemId: "ci1") { id parent_id data } }')
    expect(revs.errors).toBeUndefined()
    expect((revs.data as { contentRevisions: Array<{ id: string; parent_id: string }> }).contentRevisions[0].parent_id).toBe('r1')
  })

  it('approval + publish + schedule mutations route correctly', async () => {
    await run('mutation { submitForApproval(itemId: "ci1") { id status } }')
    expect(mocks.submitForApproval).toHaveBeenCalledWith({ itemId: 'ci1' })
    await run('mutation { decideApproval(approvalId: "ap1", vote: "approve") { id state approved_revision_id } }')
    expect(mocks.decideApproval).toHaveBeenCalledWith({ approvalId: 'ap1', vote: 'approve' })
    const pub = await run('mutation { publishContent(itemId: "ci1") { id status published_revision_id } }')
    expect(mocks.publish).toHaveBeenCalledWith({ itemId: 'ci1' })
    expect((pub.data as { publishContent: { status: string } }).publishContent.status).toBe('published')
    await run('mutation { scheduleContent(itemId: "ci1", action: "publish", revisionId: "r2", runAt: "2026-07-02T00:00:00Z") { id state } }')
    expect(mocks.schedule).toHaveBeenCalledWith({ itemId: 'ci1', action: 'publish', revisionId: 'r2', runAt: '2026-07-02T00:00:00Z' })
  })

  it('publishedContent reads the frozen { item, revision } snapshot via getPublished', async () => {
    const res = await run('query { publishedContent(id: "ci1") { item { id slug status } revision { id data content_hash } } }')
    expect(res.errors).toBeUndefined()
    expect(mocks.getPublished).toHaveBeenCalledWith('ci1')
    expect((res.data as { publishedContent: { item: { status: string } } }).publishedContent.item.status).toBe('published')
  })

  it('contentApprovals lists pending approvals (for the queue + decideApproval)', async () => {
    const res = await run('query { contentApprovals(workspaceId: "w", state: "pending") { id content_item_id state } }')
    expect(res.errors).toBeUndefined()
    expect(mocks.listApprovals).toHaveBeenCalledWith({ workspaceId: 'w', itemId: undefined, state: 'pending' })
    expect((res.data as { contentApprovals: Array<{ id: string }> }).contentApprovals[0].id).toBe('ap1')
  })

  it('runSeoAudit returns score + checklist(JSON); issueAssetUpload returns the presigned url', async () => {
    const seo = await run('mutation { runSeoAudit(itemId: "ci1") { score checklist } }')
    expect(seo.errors).toBeUndefined()
    const a = (seo.data as { runSeoAudit: { score: number; checklist: string } }).runSeoAudit
    expect(a.score).toBe(88)
    expect(JSON.parse(a.checklist)[0].passed).toBe(true)
    const up = await run('mutation { issueAssetUpload(workspaceId: "w", filename: "x.png", mime: "image/png", sizeBytes: 10) { uploadUrl assetId r2Key } }')
    expect((up.data as { issueAssetUpload: { assetId: string } }).issueAssetUpload.assetId).toBe('a1')
  })

  it('surfaces custom content ops but NO generic CRUD for the internal CMS collections', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/type ContentItem\b/)
    expect(sdl).toMatch(/type ContentType\b/)
    expect(sdl).toMatch(/type ContentRevision\b/)
    expect(sdl).toMatch(/\bcreateContent\(/)
    expect(sdl).toMatch(/\bpublishContent\(/)
    expect(sdl).toMatch(/\bcontentTypes\(/)
    // internal collections get NO generic CRUD from the loop
    expect(sdl).not.toMatch(/\bcreateContentItem\(/)
    expect(sdl).not.toMatch(/\bcreateContentRevision\(/)
    // note/tag stay fully surfaced
    expect(sdl).toContain('createNote(')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run content
```
Expected: FAIL — `Cannot query field "createContent" on type "Mutation"` (the custom content ops don't exist yet); the SDL test also fails (`createContent` / `type ContentItem` absent from the printed schema).

- [ ] **Step 3: Implement — edit `schema.ts`**

Extend the `@movp/domain` import to add the `Page` type (append to whatever the collab/task surface already imports — do NOT duplicate an existing import):
```ts
import { createDomain, type CollectionService, type Domain, type Page, type SearchHit } from '@movp/domain'
```
The `if (c.internal) continue` guards already skip the CMS collections in both generic loops (collab phase — do NOT re-add). Add the guarded block after the collab/task blocks, still inside `buildSchema`, before `return builder.toSchema()`. `Row`, `GraphQLContext`, `clampPageSize`, and `domainFrom` are already in scope (used by prior phases):
```ts
  // CMS surface — only when the CMS collections are present (Parts A/B/C).
  // The object-building loop SKIPPED every CMS collection (all internal: true), so
  // their objectRefs were created (refs is built for all collections) but never
  // implemented. This block owns and implements content_type / content_item /
  // content_revision. (Pothos: a referenced-but-unimplemented ref throws at build;
  // create-then-implement-later is fine.)
  if (refs.has('content_item')) {
    const contentTypeRef = refs.get('content_type')
    const contentItemRef = refs.get('content_item')
    const contentRevisionRef = refs.get('content_revision')

    // content_type — field_schema is JSON exposed as a JSON string (no JSON scalar
    // in this schema; see the header note). `key` is the type identifier; expose the
    // columns present on ContentTypeRow (extra/absent cols return null — nullable).
    contentTypeRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        key: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.key == null ? null : String(r.key)) }),
        label: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.label == null ? null : String(r.label)) }),
        field_schema: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.field_schema == null ? null : JSON.stringify(r.field_schema)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.updated_at == null ? null : String(r.updated_at)) }),
      }),
    })

    contentItemRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        content_type_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.content_type_id == null ? null : String(r.content_type_id)) }),
        // NOTE: no `title` field — content_item has no title column; the display title is a field inside `data` (or `search_text`).
        slug: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.slug == null ? null : String(r.slug)) }),
        status: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.status == null ? null : String(r.status)) }),
        // JSON body as a JSON string (stringify out).
        data: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.data == null ? null : JSON.stringify(r.data)) }),
        current_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.current_revision_id == null ? null : String(r.current_revision_id)) }),
        approved_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.approved_revision_id == null ? null : String(r.approved_revision_id)) }),
        published_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.published_revision_id == null ? null : String(r.published_revision_id)) }),
        // Scheduled times feed the editorial calendar when denormalized onto the item.
        // Part C stores canonical schedules in content_schedule, so these normally return
        // null and the calendar falls back to the inbox/feed path — see Task 4.
        scheduled_publish_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.scheduled_publish_at == null ? null : String(r.scheduled_publish_at)) }),
        scheduled_unpublish_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.scheduled_unpublish_at == null ? null : String(r.scheduled_unpublish_at)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.updated_at == null ? null : String(r.updated_at)) }),
        // DETAIL-ONLY nested type. The editor renders its form from field_schema; this
        // resolves the item's content_type under the CALLER's RLS. GOTCHA: this reads an
        // internal table via ctx.db at call time — keep it OFF list/board selections to
        // avoid an N+1 (the frontend selects `content_type` only on the single-item query).
        content_type: t.field({
          type: contentTypeRef, nullable: true, complexity: 5,
          resolve: async (r: Row, _a: unknown, ctx: GraphQLContext) => {
            if (r.content_type_id == null) return null
            const { data } = await ctx.db.from('content_type').select('*').eq('id', String(r.content_type_id)).maybeSingle()
            return (data as Row | null) ?? null
          },
        }),
      }),
    })

    contentRevisionRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        content_item_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        data: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.data == null ? null : JSON.stringify(r.data)) }),
        author_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.author_id == null ? null : String(r.author_id)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
      }),
    })

    // Aux (non-collection) result types — created fresh (not from refs).
    const contentPage = builder.objectRef<Page<Row>>('ContentPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [contentItemRef], resolve: (p: Page<Row>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<Row>) => p.nextCursor ?? null }),
      }),
    })
    const seoAudit = builder.objectRef<{ score: number; checklist: unknown }>('ContentSeoAudit').implement({
      fields: (t: any) => ({
        score: t.float({ resolve: (a: { score: number }) => a.score }),
        // checklist is an array of {id,label,passed,...} — JSON string (frontend parses).
        checklist: t.string({ nullable: true, resolve: (a: { checklist: unknown }) => (a.checklist == null ? null : JSON.stringify(a.checklist)) }),
      }),
    })
    const assetUpload = builder.objectRef<{ uploadUrl: string; assetId: string; r2Key: string }>('ContentAssetUpload').implement({
      fields: (t: any) => ({
        uploadUrl: t.exposeString('uploadUrl'),
        assetId: t.exposeID('assetId'),
        r2Key: t.exposeString('r2Key'),
      }),
    })
    const contentAsset = builder.objectRef<Row>('ContentAsset').implement({
      fields: (t: any) => ({
        id: t.exposeID('id'),
        workspace_id: t.string({ nullable: true, resolve: (r: Row) => (r.workspace_id == null ? null : String(r.workspace_id)) }),
        r2_key: t.string({ nullable: true, resolve: (r: Row) => (r.r2_key == null ? null : String(r.r2_key)) }),
        filename: t.string({ nullable: true, resolve: (r: Row) => (r.filename == null ? null : String(r.filename)) }),
        mime: t.string({ nullable: true, resolve: (r: Row) => (r.mime == null ? null : String(r.mime)) }),
        size_bytes: t.int({ nullable: true, resolve: (r: Row) => (r.size_bytes == null ? null : Number(r.size_bytes)) }),
        created_at: t.string({ nullable: true, resolve: (r: Row) => (r.created_at == null ? null : String(r.created_at)) }),
      }),
    })
    const contentCollection = builder.objectRef<Row>('ContentCollection').implement({
      fields: (t: any) => ({
        id: t.exposeID('id'),
        key: t.string({ nullable: true, resolve: (r: Row) => (r.key == null ? null : String(r.key)) }),
        label: t.string({ nullable: true, resolve: (r: Row) => (r.label == null ? null : String(r.label)) }),
        description: t.string({ nullable: true, resolve: (r: Row) => (r.description == null ? null : String(r.description)) }),
        workspace_id: t.string({ nullable: true, resolve: (r: Row) => (r.workspace_id == null ? null : String(r.workspace_id)) }),
        created_at: t.string({ nullable: true, resolve: (r: Row) => (r.created_at == null ? null : String(r.created_at)) }),
      }),
    })
    // content_approval is INTERNAL — no generated objectRef in `refs`. decideApproval returns
    // it, so build a minimal ref here (mirrors how the collab block re-implements `comment`).
    const contentApproval = builder.objectRef<Row>('ContentApproval').implement({
      fields: (t: any) => ({
        id: t.exposeID('id'),
        content_item_id: t.string({ nullable: true, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        state: t.string({ nullable: true, resolve: (r: Row) => (r.state == null ? null : String(r.state)) }),
        approved_revision_id: t.string({ nullable: true, resolve: (r: Row) => (r.approved_revision_id == null ? null : String(r.approved_revision_id)) }),
      }),
    })
    // content_schedule is INTERNAL — schedule() returns a ContentScheduleRow (NOT a content_item).
    const contentSchedule = builder.objectRef<Row>('ContentSchedule').implement({
      fields: (t: any) => ({
        id: t.exposeID('id'),
        content_item_id: t.string({ nullable: true, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        action: t.string({ nullable: true, resolve: (r: Row) => (r.action == null ? null : String(r.action)) }),
        revision_id: t.string({ nullable: true, resolve: (r: Row) => (r.revision_id == null ? null : String(r.revision_id)) }),
        run_at: t.string({ nullable: true, resolve: (r: Row) => (r.run_at == null ? null : String(r.run_at)) }),
        state: t.string({ nullable: true, resolve: (r: Row) => (r.state == null ? null : String(r.state)) }),
      }),
    })
    // getPublished (Part B) returns { item, revision } — the item plus the FROZEN published-revision
    // snapshot. Mirror the ContentApproval ref: a small object type wrapping the two collection refs.
    const publishedContentRef = builder.objectRef<{ item: Row; revision: Row }>('PublishedContent').implement({
      fields: (t: any) => ({
        item: t.field({ type: contentItemRef, resolve: (p: { item: Row }) => p.item }),
        revision: t.field({ type: contentRevisionRef, resolve: (p: { revision: Row }) => p.revision }),
      }),
    })

    // ---- Queries ----
    builder.queryField('contentTypes', (t: any) =>
      t.field({
        type: [contentTypeRef], complexity: 5,
        args: { workspaceId: t.arg.id({ required: true }) },
        // A's listTypes takes { workspaceId, … } and returns a Page — unwrap .items for the array field.
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => (await domainFrom(ctx).content.listTypes({ workspaceId: String(a.workspaceId) })).items,
      }),
    )
    builder.queryField('content', (t: any) =>
      t.field({
        type: contentPage,
        complexity: (a: any) => ({ field: 1, multiplier: clampPageSize(a.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          contentTypeId: t.arg.id({ required: false }),
          status: t.arg.string({ required: false }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.list({
            workspaceId: String(a.workspaceId),
            contentTypeId: a.contentTypeId ? String(a.contentTypeId) : undefined,
            status: a.status ? String(a.status) : undefined,
            first: clampPageSize(a.first),
            after: a.after ?? undefined,
          }),
      }),
    )
    builder.queryField('contentItem', (t: any) =>
      t.field({
        type: contentItemRef, nullable: true, complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.get(String(a.id)),
      }),
    )
    builder.queryField('contentRevisions', (t: any) =>
      t.field({
        type: [contentRevisionRef], complexity: 10,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.listRevisions(String(a.itemId)),
      }),
    )
    builder.queryField('publishedContent', (t: any) =>
      t.field({
        // Exact-version read: getPublished returns { item, revision } — the item plus its
        // FROZEN published-revision snapshot (Part B). Null when nothing is published.
        type: publishedContentRef, nullable: true, complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.getPublished(String(a.id)),
      }),
    )
    // contentApprovals: list pending/decided approvals so the approval queue + a clean e2e can
    // obtain an approvalId for decideApproval (Part B listApprovals → Page<ContentApprovalRow>).
    builder.queryField('contentApprovals', (t: any) =>
      t.field({
        type: [contentApproval], complexity: 5,
        args: { workspaceId: t.arg.id({ required: true }), itemId: t.arg.id({ required: false }), state: t.arg.string({ required: false }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) =>
          (await domainFrom(ctx).content.listApprovals({ workspaceId: String(a.workspaceId), itemId: a.itemId ? String(a.itemId) : undefined, state: a.state ? (String(a.state) as 'pending' | 'approved' | 'rejected' | 'superseded') : undefined })).items,
      }),
    )

    // ---- Mutations ---- (arg→service objects reconciled to content.ts: create takes slug+data — the display title lives in the data jsonb, there is NO content_item.title column; createType uses label, not name)
    builder.mutationField('createContentType', (t: any) =>
      t.field({
        type: contentTypeRef, complexity: 10,
        // createType uses `label` (the human name) — Part A's content_type has a `label` column, not `name`.
        args: { workspaceId: t.arg.id({ required: true }), key: t.arg.string({ required: true }), label: t.arg.string({ required: false }), fieldSchema: t.arg.string({ required: true }) },
        // JSON.parse throws on malformed field_schema -> a GraphQL error (e2e step 1 relies on this).
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.createType({ workspaceId: String(a.workspaceId), key: String(a.key), label: a.label ?? undefined, fieldSchema: JSON.parse(String(a.fieldSchema)) }),
      }),
    )
    builder.mutationField('createContent', (t: any) =>
      t.field({
        type: contentItemRef, complexity: 10,
        // No `title` arg — content_item has no title column; the display title lives inside `data`.
        args: { workspaceId: t.arg.id({ required: true }), contentTypeId: t.arg.id({ required: true }), slug: t.arg.string({ required: false }), data: t.arg.string({ required: false }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.create({ workspaceId: String(a.workspaceId), contentTypeId: String(a.contentTypeId), slug: a.slug ?? undefined, data: a.data == null ? undefined : JSON.parse(String(a.data)) }),
      }),
    )
    builder.mutationField('updateContent', (t: any) =>
      t.field({
        type: contentItemRef, complexity: 10,
        // A's `update` signature is { itemId, data } only — content_item has no title column; slug is not updated here.
        args: { id: t.arg.id({ required: true }), data: t.arg.string({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.update({ itemId: String(a.id), data: JSON.parse(String(a.data)) }),
      }),
    )
    builder.mutationField('submitForApproval', (t: any) =>
      t.field({ type: contentItemRef, complexity: 5, args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.submitForApproval({ itemId: String(a.itemId) }) }))
    // decideApproval takes { approvalId, vote } and returns the APPROVAL (content_approval), not the item.
    builder.mutationField('decideApproval', (t: any) =>
      t.field({ type: contentApproval, complexity: 5, args: { approvalId: t.arg.id({ required: true }), vote: t.arg.string({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.decideApproval({ approvalId: String(a.approvalId), vote: String(a.vote) as 'approve' | 'reject' }) }))
    builder.mutationField('publishContent', (t: any) =>
      t.field({ type: contentItemRef, complexity: 10, args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.publish({ itemId: String(a.itemId) }) }))
    builder.mutationField('unpublishContent', (t: any) =>
      t.field({ type: contentItemRef, complexity: 10, args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.unpublish({ itemId: String(a.itemId) }) }))
    // schedule takes { itemId, action, revisionId, runAt } (revision PINNED) and returns a ContentScheduleRow.
    builder.mutationField('scheduleContent', (t: any) =>
      t.field({ type: contentSchedule, complexity: 5, args: { itemId: t.arg.id({ required: true }), action: t.arg.string({ required: true }), revisionId: t.arg.id({ required: true }), runAt: t.arg.string({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.schedule({ itemId: String(a.itemId), action: String(a.action) as 'publish' | 'unpublish', revisionId: String(a.revisionId), runAt: String(a.runAt) }) }))
    builder.mutationField('createContentCollection', (t: any) =>
      // Part C's createCollection is { workspaceId, key, label, description? } — content_collection has `label` (no `name`).
      t.field({ type: contentCollection, complexity: 5, args: { workspaceId: t.arg.id({ required: true }), key: t.arg.string({ required: true }), label: t.arg.string({ required: true }), description: t.arg.string({ required: false }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.createCollection({ workspaceId: String(a.workspaceId), key: String(a.key), label: String(a.label), description: a.description ?? undefined }) }))
    builder.mutationField('addToCollection', (t: any) =>
      t.field({ type: 'Boolean', complexity: 5, args: { collectionId: t.arg.id({ required: true }), itemId: t.arg.id({ required: true }), position: t.arg.int({ required: false }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => { await domainFrom(ctx).content.addToCollection({ collectionId: String(a.collectionId), itemId: String(a.itemId), position: a.position ?? undefined }); return true } }))
    builder.mutationField('runSeoAudit', (t: any) =>
      t.field({ type: seoAudit, complexity: 10, args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.runSeoAudit({ itemId: String(a.itemId) }) }))
    // issueAssetUpload takes { workspaceId, filename, mime, sizeBytes } (Part C bounds validation).
    builder.mutationField('issueAssetUpload', (t: any) =>
      t.field({ type: assetUpload, complexity: 5, args: { workspaceId: t.arg.id({ required: true }), filename: t.arg.string({ required: true }), mime: t.arg.string({ required: true }), sizeBytes: t.arg.int({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.issueAssetUpload({ workspaceId: String(a.workspaceId), filename: String(a.filename), mime: String(a.mime), sizeBytes: Number(a.sizeBytes) }) }))
    // finalizeAsset takes { assetId, checksum, sizeBytes, width?, height? } — checksum/sizeBytes are
    // sent for parity only; the edge fn re-HEADs R2 for the authoritative values (Part C).
    builder.mutationField('finalizeAsset', (t: any) =>
      t.field({ type: contentAsset, complexity: 5, args: { assetId: t.arg.id({ required: true }), checksum: t.arg.string({ required: true }), sizeBytes: t.arg.int({ required: true }), width: t.arg.int({ required: false }), height: t.arg.int({ required: false }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.finalizeAsset({ assetId: String(a.assetId), checksum: String(a.checksum), sizeBytes: Number(a.sizeBytes), width: a.width ?? undefined, height: a.height ?? undefined }) }))
  }
```

> **Gotcha — `content_type` reads an internal table directly.** The `content_type` nested resolver is the ONE place a surface reads an internal CMS table (`content_type`) directly, via `ctx.db` under the caller's RLS. This is intentional (the editor's field_schema source). Keep it OFF list selections; the frontend selects `content_type` only on the single-item `contentItem` query.

- [ ] **Step 4: Run the test + typecheck + the existing schema gate**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `content.test.ts` (8) AND the existing `schema.test.ts` + `relations.test.ts` + collab/task tests still green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/graphql/src/schema.ts packages/graphql/test/content.test.ts
git commit -m "feat(graphql): content_item surface (types/queries/mutations for CMS)"
```

---

### Task 2: MCP surface — custom content tools

Add `content.create_type`, `content.create`, `content.update`, `content.get`, `content.list`, `content.submit_for_approval`, `content.decide_approval`, `content.publish`, `content.unpublish`, `content.schedule`, `content.run_seo_audit`, `content.issue_asset_upload`, `content.list_approvals` to `packages/mcp/src/server.ts` via `registerTool`, after the generated-tool loop. The existing `if (c.internal) continue` guard already skips every CMS collection (no generic `content_item.create` etc.), so `buildMcpServer` never resolves a service for them — the test mock only needs the existing non-internal services (unchanged) plus a `content` stub for the custom tools.

**Files:**
- Edit: `packages/mcp/src/server.ts`
- Edit: `packages/mcp/test/server.test.ts`

- [ ] **Step 1: Extend the test (red)**

In `packages/mcp/test/server.test.ts`, add content fakes at the top (next to the existing consts):
```ts
const contentCreate = vi.fn(async () => ({ id: 'ci1', status: 'draft' }))
const contentPublish = vi.fn(async () => ({ id: 'ci1', status: 'published' }))
```
Add a `content` object to the existing mocked `createDomain` return (alongside `note`, `tag`, `search`, `graph`, `collab`, `task`, … — leave those intact):
```ts
    // CMS collections are internal — no generic tool; the custom content tools use `content`.
    content: {
      createType: vi.fn(async () => ({ id: 'ct1', key: 'article' })),
      create: contentCreate,
      update: vi.fn(async () => ({ id: 'ci1' })),
      get: vi.fn(async () => ({ id: 'ci1' })),
      list: vi.fn(async () => ({ items: [{ id: 'ci1' }], nextCursor: null })),
      submitForApproval: vi.fn(async () => ({ id: 'ci1', status: 'in_review' })),
      decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
      publish: contentPublish,
      unpublish: vi.fn(async () => ({ id: 'ci1', status: 'draft' })),
      schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', revision_id: 'r2', action: 'publish', state: 'scheduled' })),
      runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [{ id: 'title', passed: true }] })),
      issueAssetUpload: vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' })),
      // remaining methods for typecheck completeness
      listTypes: vi.fn(async () => ({ items: [{ id: 'ct1' }], nextCursor: null })), listRevisions: vi.fn(async () => [{ id: 'r1' }]),
      listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1' }], nextCursor: null })),
      getPublished: vi.fn(async () => ({ item: { id: 'ci1' }, revision: { id: 'r2', data: { headline: 'v2' }, content_hash: 'h2' } })), finalizeAsset: vi.fn(async () => ({ id: 'a1', r2_key: 'w/a1', mime: 'image/png', size_bytes: 10 })),
      createCollection: vi.fn(), addToCollection: vi.fn(), reorderCollection: vi.fn(),
      linkAsset: vi.fn(), linkItem: vi.fn(), linkEditorialTask: vi.fn(),
    },
```
Add a content-tools test case inside `describe('buildMcpServer', …)`:
```ts
  it('registers and calls the custom content tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u', accessToken: 'test', assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'content.create_type', 'content.create', 'content.update', 'content.get', 'content.list',
      'content.submit_for_approval', 'content.decide_approval', 'content.publish', 'content.unpublish',
      'content.schedule', 'content.run_seo_audit', 'content.issue_asset_upload', 'content.list_approvals',
    ]))
    // internal CMS collections get NO generic CRUD tool
    expect(names).not.toContain('content_item.create')
    expect(names).not.toContain('content_revision.create')

    const createRes = await client.callTool({ name: 'content.create', arguments: { workspaceId: 'w', contentTypeId: 'ct1', data: '{"headline":"Hi"}' } })
    expect(contentCreate).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: undefined, data: { headline: 'Hi' } })
    expect(JSON.stringify(createRes.content)).toContain('ci1')

    const pubRes = await client.callTool({ name: 'content.publish', arguments: { itemId: 'ci1' } })
    expect(contentPublish).toHaveBeenCalledWith({ itemId: 'ci1' })
    expect(JSON.stringify(pubRes.content)).toContain('published')

    // ASSET CTX WIRING — regression gate. Pins BOTH: (a) content.issue_asset_upload routes to the
    // service (returns the presigned url), and (b) buildMcpServer threaded accessToken/assetsFnUrl
    // into createDomain. (b) is the load-bearing one: a mocked-domain routing check alone passes
    // even if the ctx fields are dropped, so we assert the factory received them — a missed field
    // fails HERE. Requires the mocked `createDomain` to be a `vi.fn` (so its call args are recorded)
    // and `import { createDomain } from '@movp/domain'` at the top of the test.
    const assetRes = await client.callTool({ name: 'content.issue_asset_upload', arguments: { workspaceId: 'w', filename: 'x.png', mime: 'image/png', sizeBytes: 10 } })
    expect(JSON.stringify(assetRes.content)).toContain('r2/put')
    expect(vi.mocked(createDomain)).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'test', assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets' }),
      expect.anything(),
    )
  })
```
> **Make the mock spyable.** For assertion (b) to work, the existing `vi.mock('@movp/domain', …)` must return `createDomain` as a `vi.fn((ctx) => ({ … }))` (not a bare `() => ({ … })`), and the test must `import { createDomain } from '@movp/domain'` so `vi.mocked(createDomain)` sees the recorded calls. `buildMcpServer` builds the domain ONCE from its ctx (mirroring `server.ts`'s `createDomain({ db, userId, accessToken, assetsFnUrl }, { embedder })`), so a single call-args assertion pins the whole surface's asset-ctx threading.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run server
```
Expected: FAIL — `content.create` (etc.) absent from `tools/list`, so the `arrayContaining([...])` assertion fails and `callTool({ name: 'content.create' })` rejects with `Tool content.create not found`.

- [ ] **Step 3: Implement — edit `server.ts`**

The `if (c.internal) continue` guard already exists at the top of the generated-tool loop — do NOT re-add. After that loop and before `return server`, add (`z` and the `text(...)` helper are already imported/defined for the collab/task tools):
```ts
  // Custom content (CMS) tools. The CMS collections are internal; domain.content is
  // provided by createDomain. `data`/`fieldSchema` are JSON strings on the wire —
  // parse them here (mirrors the GraphQL surface's stringify/parse).
  server.registerTool(
    'content.create_type',
    { title: 'Create content type', description: 'Define a content type with a field schema (JSON string)', inputSchema: { workspaceId: z.string(), key: z.string(), label: z.string().optional(), fieldSchema: z.string() } },
    async ({ workspaceId, key, label, fieldSchema }) => text(await domain.content.createType({ workspaceId, key, label, fieldSchema: JSON.parse(fieldSchema) })),
  )
  server.registerTool(
    'content.create',
    { title: 'Create content', description: 'Create a content item (data is a JSON string; the display title is a field inside data, not a column)', inputSchema: { workspaceId: z.string(), contentTypeId: z.string(), slug: z.string().optional(), data: z.string().optional() } },
    async ({ workspaceId, contentTypeId, slug, data }) => text(await domain.content.create({ workspaceId, contentTypeId, slug, data: data == null ? undefined : JSON.parse(data) })),
  )
  server.registerTool(
    'content.update',
    { title: 'Update content', description: 'Update a content item (data is a JSON string; identical data dedupes)', inputSchema: { id: z.string(), data: z.string() } },
    async ({ id, data }) => text(await domain.content.update({ itemId: id, data: JSON.parse(data) })),
  )
  server.registerTool(
    'content.get',
    { title: 'Get content', description: 'Fetch a content item by id', inputSchema: { id: z.string() } },
    async ({ id }) => text(await domain.content.get(id)),
  )
  server.registerTool(
    'content.list',
    { title: 'List content', description: 'List content items, optionally filtered by type or status', inputSchema: { workspaceId: z.string(), contentTypeId: z.string().optional(), status: z.string().optional(), first: z.number().optional() } },
    async ({ workspaceId, contentTypeId, status, first }) => text(await domain.content.list({ workspaceId, contentTypeId, status, first })),
  )
  server.registerTool(
    'content.submit_for_approval',
    { title: 'Submit for approval', description: 'Submit a content item for approval', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.submitForApproval({ itemId })),
  )
  server.registerTool(
    'content.decide_approval',
    { title: 'Decide approval', description: 'Approve or reject a pending approval (by approval id)', inputSchema: { approvalId: z.string(), vote: z.enum(['approve', 'reject']) } },
    async ({ approvalId, vote }) => text(await domain.content.decideApproval({ approvalId, vote })),
  )
  server.registerTool(
    'content.publish',
    { title: 'Publish content', description: 'Publish the approved revision of a content item', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.publish({ itemId })),
  )
  server.registerTool(
    'content.unpublish',
    { title: 'Unpublish content', description: 'Unpublish a content item', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.unpublish({ itemId })),
  )
  server.registerTool(
    'content.schedule',
    { title: 'Schedule content', description: 'Schedule a publish/unpublish of a PINNED revision at runAt (ISO)', inputSchema: { itemId: z.string(), action: z.enum(['publish', 'unpublish']), revisionId: z.string(), runAt: z.string() } },
    async ({ itemId, action, revisionId, runAt }) => text(await domain.content.schedule({ itemId, action, revisionId, runAt })),
  )
  server.registerTool(
    'content.run_seo_audit',
    { title: 'Run SEO audit', description: 'Run the SEO/AEO audit for a content item (returns score + checklist)', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.runSeoAudit({ itemId })),
  )
  server.registerTool(
    'content.issue_asset_upload',
    { title: 'Issue asset upload', description: 'Issue a presigned upload URL for a content asset (bounded mime/size)', inputSchema: { workspaceId: z.string(), filename: z.string(), mime: z.string(), sizeBytes: z.number() } },
    async ({ workspaceId, filename, mime, sizeBytes }) => text(await domain.content.issueAssetUpload({ workspaceId, filename, mime, sizeBytes })),
  )
  server.registerTool(
    'content.list_approvals',
    { title: 'List approvals', description: 'List content approvals (optionally by item/state) — the source of an approvalId for decide', inputSchema: { workspaceId: z.string(), itemId: z.string().optional(), state: z.enum(['pending', 'approved', 'rejected', 'superseded']).optional() } },
    async ({ workspaceId, itemId, state }) => text(await domain.content.listApprovals({ workspaceId, itemId, state })),
  )
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run && pnpm --filter @movp/mcp typecheck
```
Expected: PASS — the new content `it` block plus the existing note/search + collab + task blocks green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/mcp/src/server.ts packages/mcp/test/server.test.ts
git commit -m "feat(mcp): custom content tools (create_type/create/update/get/list/approval/publish/schedule/seo/asset)"
```

---

### Task 3: CLI surface — `movp content` command group

Add a `content` command group (`create-type`, `create`, `update`, `list`, `approvals`, `get`, `submit`, `decide`, `publish`, `unpublish`, `schedule`, `seo-audit`, `asset-upload`) to `packages/cli/src/program.ts`, using `createDomain(resolveCtx()).content`. The existing `if (c.internal) continue` guard already skips the internal CMS collections, so no generic `movp content_item` group collides.

**Files:**
- Edit: `packages/cli/src/program.ts`
- Edit: `packages/cli/test/program.test.ts`

- [ ] **Step 1: Extend the test (red)**

In `packages/cli/test/program.test.ts`, add content fakes at the top (next to the existing consts):
```ts
const contentCreate = vi.fn(async () => ({ id: 'ci1', slug: 'hello' }))
const contentList = vi.fn(async () => ({ items: [{ id: 'ci1' }], nextCursor: null }))
const contentPublish = vi.fn(async () => ({ id: 'ci1', status: 'published' }))
const contentIssueAsset = vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' }))
```
Add a `content` object to the existing mocked `createDomain` return (alongside `note`, `tag`, `search`, `graph`, `collab`, `task`):
```ts
    content: {
      createType: vi.fn(async () => ({ id: 'ct1' })), create: contentCreate, update: vi.fn(async () => ({ id: 'ci1' })),
      get: vi.fn(async () => ({ id: 'ci1' })), list: contentList, listTypes: vi.fn(async () => ({ items: [{ id: 'ct1' }], nextCursor: null })), listRevisions: vi.fn(async () => [{ id: 'r1' }]),
      listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1' }], nextCursor: null })),
      submitForApproval: vi.fn(async () => ({ id: 'ci1', status: 'in_review' })), decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
      publish: contentPublish, unpublish: vi.fn(async () => ({ id: 'ci1', status: 'archived' })), getPublished: vi.fn(async () => ({ item: { id: 'ci1' }, revision: { id: 'r2', data: { headline: 'v2' }, content_hash: 'h2' } })),
      schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', revision_id: 'r2', action: 'publish', state: 'scheduled' })), runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [] })),
      issueAssetUpload: contentIssueAsset, finalizeAsset: vi.fn(async () => ({ id: 'a1', r2_key: 'w/a1', mime: 'image/png', size_bytes: 10 })),
      createCollection: vi.fn(), addToCollection: vi.fn(), reorderCollection: vi.fn(), linkAsset: vi.fn(), linkItem: vi.fn(), linkEditorialTask: vi.fn(),
    },
```
Add test cases inside `describe('movp CLI', …)`:
```ts
  it('content create routes to content.create (data JSON parsed)', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'content', 'create', '--workspace', 'w', '--type', 'ct1', '--data', '{"headline":"Hi"}'])
    expect(contentCreate).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: undefined, data: { headline: 'Hi' } })
    expect(out[0]).toContain('ci1')
  })

  it('content list and content publish print results', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'content', 'list', '--workspace', 'w'])
    expect(contentList).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: undefined, status: undefined })
    expect(out[0]).toContain('ci1')
    const p2 = program()
    await p2.cmd.parseAsync(['node', 'movp', 'content', 'publish', '--item', 'ci1'])
    expect(contentPublish).toHaveBeenCalledWith({ itemId: 'ci1' })
    expect(p2.out[0]).toContain('published')
  })

  it('content asset-upload routes to issueAssetUpload AND forwards the asset ctx into createDomain', async () => {
    // Every CLI command does createDomain(resolveCtx()), so whatever resolveCtx returns reaches
    // the domain factory. A routing-only check would pass even if resolveCtx dropped the asset
    // fields, so we ALSO assert the factory's call args — a missed field fails HERE.
    const ctx = { db: {} as never, userId: 'u', accessToken: 'test', assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets' }
    const { cmd } = program({ resolveCtx: () => ctx })   // program() forwards opts to buildProgram({ resolveCtx })
    await cmd.parseAsync(['node', 'movp', 'content', 'asset-upload', '--workspace', 'w', '--filename', 'x.png', '--mime', 'image/png', '--size-bytes', '10'])
    expect(contentIssueAsset).toHaveBeenCalledWith({ workspaceId: 'w', filename: 'x.png', mime: 'image/png', sizeBytes: 10 })
    expect(vi.mocked(createDomain)).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'test', assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets' }))
  })

  it('surfaces the custom content group but NO generic CRUD group for internal CMS collections', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    expect(top).not.toContain('content_item')
    expect(top).not.toContain('content_revision')
    expect(top).toContain('content')
    const content = cmd.commands.find((c) => c.name() === 'content')
    expect(content?.commands.map((s) => s.name())).toEqual([
      'create-type', 'create', 'update', 'list', 'approvals', 'get', 'submit', 'decide', 'publish', 'unpublish', 'schedule', 'seo-audit', 'asset-upload',
    ])
  })
```
> **Two setup requirements for the asset-upload test.** (1) The `program()` test helper must forward an optional `{ resolveCtx }` to `buildProgram` (the real `buildProgram(opts)` already accepts `opts.resolveCtx`) so the test can inject a ctx carrying `accessToken`/`assetsFnUrl`; if the committed helper hard-codes `resolveCtx`, add the passthrough. (2) The mocked `createDomain` must be a `vi.fn` and the test must `import { createDomain } from '@movp/domain'`, so `vi.mocked(createDomain)` sees the recorded call — that assertion is what makes a dropped `CliCtx`/`resolveCliCtx` field fail the gate rather than pass silently.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/cli exec vitest run program
```
Expected: FAIL — commander errors on the unknown `content create` subcommand (`error: unknown command 'content create'`), and the custom-group assertion fails (no `content` group with those subcommands yet).

- [ ] **Step 3: Implement — edit `program.ts`**

The `if (c.internal) continue` guard already exists at the top of the generated-command loop — do NOT re-add. After that loop and before `program.command('search <query>')`, add (`createDomain`, `resolveCtx`, and `out` are already in scope from prior phases):
```ts
  const contentCmd = program.command('content').description('Manage CMS content')
  contentCmd
    .command('create-type')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <key>', 'content type key')
    .option('--label <label>', 'display label')
    .requiredOption('--field-schema <json>', 'field schema (JSON string)')
    .action(async (o: { workspace: string; key: string; label?: string; fieldSchema: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.createType({ workspaceId: o.workspace, key: o.key, label: o.label, fieldSchema: JSON.parse(o.fieldSchema) })))
    })
  contentCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--type <id>', 'content type id')
    .option('--slug <slug>', 'slug')
    .option('--data <json>', 'content data (JSON string; the display title is a field inside data)')
    .action(async (o: { workspace: string; type: string; slug?: string; data?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.create({ workspaceId: o.workspace, contentTypeId: o.type, slug: o.slug, data: o.data == null ? undefined : JSON.parse(o.data) })))
    })
  contentCmd
    .command('update')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--data <json>', 'content data (JSON string)')
    .action(async (o: { item: string; data: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.update({ itemId: o.item, data: JSON.parse(o.data) })))
    })
  contentCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--type <id>', 'filter by content type id')
    .option('--status <status>', 'filter by status')
    .action(async (o: { workspace: string; type?: string; status?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.list({ workspaceId: o.workspace, contentTypeId: o.type, status: o.status })))
    })
  contentCmd
    .command('approvals')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--item <id>', 'filter by content item id')
    .option('--state <state>', 'filter by approval state (pending|approved|rejected|superseded)')
    .action(async (o: { workspace: string; item?: string; state?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.listApprovals({ workspaceId: o.workspace, itemId: o.item, state: o.state as 'pending' | 'approved' | 'rejected' | 'superseded' | undefined })))
    })
  contentCmd
    .command('get')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.get(o.item))) })
  contentCmd
    .command('submit')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.submitForApproval({ itemId: o.item }))) })
  contentCmd
    .command('decide')
    .requiredOption('--approval <id>', 'content approval id')
    .requiredOption('--vote <approve|reject>', 'vote')
    .action(async (o: { approval: string; vote: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.decideApproval({ approvalId: o.approval, vote: o.vote as 'approve' | 'reject' }))) })
  contentCmd
    .command('publish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.publish({ itemId: o.item }))) })
  contentCmd
    .command('unpublish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.unpublish({ itemId: o.item }))) })
  contentCmd
    .command('schedule')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--action <publish|unpublish>', 'schedule action')
    .requiredOption('--revision <id>', 'PINNED revision id to publish/unpublish')
    .requiredOption('--run-at <iso>', 'run time (ISO)')
    .action(async (o: { item: string; action: string; revision: string; runAt: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.schedule({ itemId: o.item, action: o.action as 'publish' | 'unpublish', revisionId: o.revision, runAt: o.runAt }))) })
  contentCmd
    .command('seo-audit')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.runSeoAudit({ itemId: o.item }))) })
  contentCmd
    .command('asset-upload')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--filename <name>', 'file name')
    .requiredOption('--mime <mime>', 'MIME type (allow-listed)')
    .requiredOption('--size-bytes <n>', 'declared byte size', (v) => parseInt(v, 10))
    .action(async (o: { workspace: string; filename: string; mime: string; sizeBytes: number }) => { const domain = createDomain(resolveCtx()); out(JSON.stringify(await domain.content.issueAssetUpload({ workspaceId: o.workspace, filename: o.filename, mime: o.mime, sizeBytes: o.sizeBytes }))) })
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/cli exec vitest run && pnpm --filter @movp/cli typecheck
```
Expected: PASS — the three new content cases plus the existing note/search + collab + task cases green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/cli/src/program.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp content group (create-type/create/update/list/get/submit/decide/publish/unpublish/schedule/seo-audit/asset-upload)"
```

---

### Task 4: Frontend — content list, field-schema editor, revision diff, approval queue, editorial calendar

**Files:**
- Create: `templates/frontend-astro/src/lib/content-queries.ts`
- Create: `templates/frontend-astro/src/pages/content/index.astro`, `.../content/[id].astro`, `.../content/approvals.astro`, `.../content/calendar.astro`
- Test: `templates/frontend-astro/tests/content.spec.ts`

**Interfaces:**
- Consumes (all already in the template — mirror `src/pages/index.astro` and Task 01c's pages): `gqlRequest<T>({ endpoint, token, query, variables })` from `src/lib/graphql.ts`; `getSessionToken(cookies)` from `src/lib/session.ts`; `readServerEnv() -> { graphqlEndpoint, workspaceId }` from `src/lib/env.ts`; `Base.astro`; the state components `src/components/states/{AuthFailure,LoadingState,EmptyState,ErrorRetry}.astro`. GraphQL ops from Task 1 (`content`, `contentTypes`, `contentItem`, `contentRevisions`, `contentApprovals`, `runSeoAudit`, `updateContent`, `submitForApproval`, `decideApproval`, `publishContent`, `unpublishContent`, `scheduleContent`, `issueAssetUpload`, `finalizeAsset`) + the reuse ops (`search`, `comments`, `addComment`, `inbox`).
- **Boundary (load-bearing):** no `@movp/auth`/`@movp/domain`/service-role imports — GraphQL over HTTP only. `bash scripts/check-boundary.sh` stays green.
- **Writes go through server-side POST form actions, never client JS holding the token.** The session token lives in an httpOnly cookie (`getSessionToken(Astro.cookies)`), readable only server-side. Each page handles `Astro.request.method === 'POST'` by reading `Astro.request.formData()`, dispatching on a hidden `intent` field, and calling `gqlRequest` with the server-read token. This keeps GET safe (no mutation on render) and keeps the token off the client. The asset flow is the one exception (below).

- [ ] **Step 1: GraphQL documents** — `src/lib/content-queries.ts` exporting the query/mutation strings the pages use (mirror `src/lib/task-queries.ts`). GOTCHA: `data`/`field_schema`/`checklist` are JSON strings — pages `JSON.parse` them after fetch and `JSON.stringify` them into mutation variables.
```ts
export const CONTENT_LIST_QUERY = /* GraphQL */ `
  query Content($workspaceId: ID!, $contentTypeId: ID, $status: String, $first: Int) {
    content(workspaceId: $workspaceId, contentTypeId: $contentTypeId, status: $status, first: $first) {
      items { id slug status content_type_id updated_at } nextCursor
    }
  }`
export const CONTENT_TYPES_QUERY = /* GraphQL */ `
  query ContentTypes($workspaceId: ID!) { contentTypes(workspaceId: $workspaceId) { id key label field_schema } }`
export const CONTENT_SEARCH_QUERY = /* GraphQL */ `
  query Search($workspaceId: ID!, $query: String!) { search(workspaceId: $workspaceId, query: $query) { collection id title snippet score } }`
export const CONTENT_ITEM_QUERY = /* GraphQL */ `
  query ContentItem($id: ID!) {
    contentItem(id: $id) {
      id slug status data content_type_id current_revision_id approved_revision_id published_revision_id
      content_type { id key field_schema }
    }
  }`
export const CONTENT_REVISIONS_QUERY = /* GraphQL */ `
  query ContentRevisions($itemId: ID!) { contentRevisions(itemId: $itemId) { id parent_id data author_id created_at } }`
export const CONTENT_COMMENTS_QUERY = /* GraphQL */ `
  query Comments($workspaceId: ID!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: "content_item", entityId: $entityId) { id body author_id created_at }
  }`
export const APPROVALS_QUERY = /* GraphQL */ `
  query Approvals($workspaceId: ID!) {
    contentApprovals(workspaceId: $workspaceId, state: "pending") { id content_item_id state }
  }`
export const CALENDAR_QUERY = /* GraphQL */ `
  query Calendar($workspaceId: ID!) {
    content(workspaceId: $workspaceId) { items { id slug status scheduled_publish_at scheduled_unpublish_at } nextCursor }
  }`
export const INBOX_QUERY = /* GraphQL */ `
  query Inbox($workspaceId: ID!, $tab: String!) { inbox(workspaceId: $workspaceId, tab: $tab) { kind entity_type entity_id ref_id created_at } }`
// --- mutations (server-side POST actions) ---
export const UPDATE_CONTENT_MUTATION = /* GraphQL */ `mutation($id: ID!, $data: String!) { updateContent(id: $id, data: $data) { id status } }`
export const RUN_SEO_AUDIT_MUTATION = /* GraphQL */ `mutation($itemId: ID!) { runSeoAudit(itemId: $itemId) { score checklist } }`
export const SUBMIT_MUTATION = /* GraphQL */ `mutation($itemId: ID!) { submitForApproval(itemId: $itemId) { id status } }`
export const DECIDE_MUTATION = /* GraphQL */ `mutation($approvalId: ID!, $vote: String!) { decideApproval(approvalId: $approvalId, vote: $vote) { id state } }`
export const PUBLISH_MUTATION = /* GraphQL */ `mutation($itemId: ID!) { publishContent(itemId: $itemId) { id status published_revision_id } }`
export const UNPUBLISH_MUTATION = /* GraphQL */ `mutation($itemId: ID!) { unpublishContent(itemId: $itemId) { id status } }`
export const SCHEDULE_MUTATION = /* GraphQL */ `mutation($itemId: ID!, $action: String!, $revisionId: ID!, $runAt: String!) { scheduleContent(itemId: $itemId, action: $action, revisionId: $revisionId, runAt: $runAt) { id state } }`
export const ISSUE_ASSET_UPLOAD_MUTATION = /* GraphQL */ `mutation($workspaceId: ID!, $filename: String!, $mime: String!, $sizeBytes: Int!) { issueAssetUpload(workspaceId: $workspaceId, filename: $filename, mime: $mime, sizeBytes: $sizeBytes) { uploadUrl assetId r2Key } }`
export const FINALIZE_ASSET_MUTATION = /* GraphQL */ `mutation($assetId: ID!, $checksum: String!, $sizeBytes: Int!, $width: Int, $height: Int) { finalizeAsset(assetId: $assetId, checksum: $checksum, sizeBytes: $sizeBytes, width: $width, height: $height) { id r2_key } }`
```

- [ ] **Step 2: Failing Playwright/axe test** — `tests/content.spec.ts` mirroring the notes/tasks spec. In setup (a `beforeAll`/global-setup using the owner session token + GraphQL, like the tasks spec), seed: one **content type** whose `field_schema` has ≥ 2 field descriptors including one asset-type field (e.g. `{ fields: [ { key: "headline", type: "text" }, { key: "body", type: "richtext" }, { key: "hero", type: "asset" } ] }`); one **content item** of that type with `data`; a **second revision** (create → rev1, then `updateContent` with new data → rev2, so `contentRevisions` has ≥ 2 with parent lineage); one **comment** via `addComment` on `entityType:"content_item"`, `entityId` = the seeded item. Record the seeded item id for the detail assertions. Cases:
  - `/content` with no cookie → renders the `AuthFailure` view.
  - `/content` with a seeded session → lists the item; shows the type filter, status filter, and a search box.
  - `/content/<seededId>` (editor) → renders the item's `slug` (the display label — content_item has no title column); renders **one form control per field descriptor** in `field_schema` (assert the count matches, and the asset field renders a file input + upload affordance); renders the **discussion thread** (≥ 1 comment); renders the **revision timeline** (≥ 2 revisions) with the diff affordance and the frozen-marker on the revision whose id equals `approved_revision_id`/`published_revision_id` (none frozen yet is acceptable — assert the timeline lists the 2 revisions).
  - The **SEO panel**: click the "Run SEO audit" submit button (POST intent `seo`), wait, then assert the panel shows a numeric score and ≥ 1 checklist item.
  - `/content/approvals` → renders the queue (the in_review list or an `EmptyState`).
  - `/content/calendar` → renders the calendar page (scheduled items and/or the inbox-derived content events; `EmptyState` acceptable).
  - Axe smoke over `/content`, `/content/<seededId>`, `/content/approvals`, and `/content/calendar` — zero serious/critical violations.
Run: `pnpm --filter @movp/frontend-astro exec playwright test content` → Expected: FAIL (routes 404 — pages not created).

- [ ] **Step 3: Implement the pages** — each Astro page mirrors `src/pages/index.astro`: read `token = getSessionToken(Astro.cookies)`; if `!token` render `AuthFailure`; else `const { graphqlEndpoint, workspaceId } = readServerEnv()`, `try { const r = await gqlRequest(...) } catch { render ErrorRetry }`, render `EmptyState` when empty. Keyboard-focusable nav + `aria-current` on the active tab/filter.
  - **`content/index.astro`** — `CONTENT_LIST_QUERY` (filter by type via `contentTypeId`, by status via `status`, both from `Astro.url.searchParams`). Load `CONTENT_TYPES_QUERY` for the type-filter `<select>`. A search box: when `?q=` is present, run `CONTENT_SEARCH_QUERY` and render hits where `collection === 'content_item'` (this is the FTS + semantic path over `search_text`/`search_body`).
  - **`content/[id].astro`** (the editor) — GET: `CONTENT_ITEM_QUERY` (item + `data` + nested `content_type.field_schema`); build the form by iterating `JSON.parse(content_type.field_schema).fields` and rendering an input per descriptor `type` (`text`→`<input>`, `richtext`/`longtext`→`<textarea>`, `boolean`→checkbox, `number`→number input, `select`→`<select>` from the descriptor options, `asset`→file input + "Upload" control), pre-filled from `JSON.parse(item.data)`. Also GET: `CONTENT_COMMENTS_QUERY` (discussion), `CONTENT_REVISIONS_QUERY` (timeline; diff two `data` snapshots along the `parent_id` lineage; mark the revision whose id equals `approved_revision_id` or `published_revision_id` as frozen). The SEO panel and all writes are **POST intents** on this page:
    - `intent=save` → `UPDATE_CONTENT_MUTATION` with `data = JSON.stringify(collectedFields)`.
    - `intent=seo` → `RUN_SEO_AUDIT_MUTATION`; render `score` + `JSON.parse(checklist)` in the panel.
    - `intent=submit|publish|unpublish` → the matching mutation.
    - `intent=asset` → `ISSUE_ASSET_UPLOAD_MUTATION` (server) with `{ workspaceId, filename, mime, sizeBytes }` (mime = the uploaded file's type, sizeBytes = its byte length) returns `{ uploadUrl, assetId, r2Key }`; the server then streams the uploaded file (from the multipart form) to `uploadUrl` via `fetch(uploadUrl, { method: 'PUT', body })`, then calls `FINALIZE_ASSET_MUTATION` with `{ assetId, checksum, sizeBytes }` (the server-computed parity values — `finalizeAsset` re-HEADs R2 for the authoritative size/checksum), and stores the returned `r2_key` into the item's `data` for that field. (The presigned PUT does not use the app token, so routing it server-side is safe; keeping it server-side avoids exposing the token to the browser.)
    > **Gotcha — the SEO panel must not run on GET.** Render the panel container + a "Run SEO audit" submit button on GET; only the `intent=seo` POST calls `runSeoAudit` (which writes). Never call a mutation during GET/SSR.
  - **`content/approvals.astro`** — `APPROVALS_QUERY` (pending `contentApprovals`). Each row is a decide form whose `intent` maps to `DECIDE_MUTATION` (`{ approvalId, vote }`, `vote` ∈ approve/reject); the `approvalId` is each `contentApprovals` row's `id` (Part B's `listApprovals` → Part D's `contentApprovals` query, added in Task 1/2/3 — this closes the earlier gap where only content **item** ids were reachable). To show the item's human label alongside each approval, resolve `content_item_id` via the list/`contentItem` query (`slug`). The service/RLS still gates the decision by capability, so a caller without the approve cap gets an error → render `ErrorRetry`/inline error. Multi-approver progress: if the approval exposes approver counts, show them; otherwise show the pending state (documented follow-up if progress fields are absent).
  - **`content/calendar.astro`** — `CALENDAR_QUERY` grouped by `scheduled_publish_at`/`scheduled_unpublish_at` (if those fields are null because Part C stored schedules elsewhere — see the Task 1 reconcile note — fall back to `INBOX_QUERY` content-scheduling events). Also render `INBOX_QUERY` (`tab=all`) content mentions. `EmptyState` when nothing is scheduled.
Run: `pnpm --filter @movp/frontend-astro exec playwright test content` → Expected: PASS (incl. axe).

- [ ] **Step 4: Boundary + build gate**
Run:
```bash
bash scripts/check-boundary.sh && pnpm --filter @movp/frontend-astro build
```
Expected: boundary grep clean (no `@movp/auth`/`@movp/domain`/service-role import under `templates/`); Astro build succeeds.

- [ ] **Step 5: Commit**
```bash
git add templates/frontend-astro/src/lib/content-queries.ts templates/frontend-astro/src/pages/content templates/frontend-astro/tests/content.spec.ts
git commit -m "feat(frontend): CMS list/editor/revision-diff/approval-queue/calendar + a11y smoke"
```

---

### Task 5: End-to-end CMS slice (`scripts/slice-e2e.sh`)

Append a `[content]` section to `scripts/slice-e2e.sh` implementing the roadmap's full CMS verification against the running stack via the GraphQL surface (Task 1) + direct `psql` assertions on events/immutability.

**Files:**
- Modify: `scripts/slice-e2e.sh` (insert the `[content]` section immediately BEFORE the `== [8] internal not exposed via PostgREST API ==` block / the final `slice-e2e: PASS`).

**Interfaces (use the committed slice helpers/vars EXACTLY — do NOT invent `$WS_ID`/`$MEMBER2_ID`):**
- `post_graphql "<body>"` — POSTs to the GraphQL endpoint as the owner (`$TOKEN`).
- `post_graphql_as "<token>" "<body>"` — the collab-slice helper that POSTs as an arbitrary token; if the precondition confirmed it is not defined before this section, define it inline as the `[collab]` block does.
- `json_get <path>` — extracts a JSON scalar; `psql "$DB_URL" -tAc "…"` — direct SQL (superuser, RLS-bypassing).
- Provisioned vars: `$WS` (workspace id), `$USER2_ID` / `$TOKEN2` (a second member), `$API_URL`, `$ANON_KEY`, `$SERVICE_ROLE_KEY`, `$DB_URL`.
- Also consumes the content GraphQL surface (Task 1), Parts A/B/C triggers, and Part B/C's signed publish webhook.

> **Table-name reconciliation.** The `psql` assertions below reference `public.content_revision`, the events table `movp_internal.movp_events`, `public.content_publish_event` (for immutability), and the committed `public.register_webhook(...)` RPC / `movp_internal.webhooks` (there is NO `public.publish_event` or `public.webhook_subscription` table). Confirm these exact names against the CMS migrations (precondition greps) before running; adjust if Parts A–C named them differently.

- [ ] **Step 1: Serve the flows function, then add the `[content]` section** (mirror the `[collab]`/`[task]` blocks):

First, edit the existing edge-function startup in `scripts/slice-e2e.sh` so the signed webhook worker is actually invocable during the slice:
```diff
-supabase_local functions serve graphql mcp index-embeddings --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
+supabase_local functions serve graphql mcp index-embeddings flows --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
```

Then append this `[content]` section:
```bash
echo "== [content] helper + a non-member (USER3) for the authz checks =="
type post_graphql_as >/dev/null 2>&1 || post_graphql_as() {
  curl -sS "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $1" -H "apikey: $ANON_KEY" -H "content-type: application/json" -d "$2"
}
curl -sS "$API_URL/auth/v1/admin/users" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" -d '{"email":"e2e-content3@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN3="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-content3@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$TOKEN3" ] || { echo "failed to mint USER3 token"; exit 1; }

echo "== [content] create type — a MALFORMED field schema is rejected =="
BAD="$(post_graphql "{\"query\":\"mutation{createContentType(workspaceId:\\\"$WS\\\", key:\\\"bad\\\", fieldSchema:\\\"{\\\\\\\"fields\\\\\\\":\\\\\\\"nope\\\\\\\"}\\\"){id}}\"}")"
echo "$BAD" | grep -q '"errors"' || { echo "malformed field schema was NOT rejected: $BAD"; exit 1; }

echo "== [content] create a valid type + an item (content.created + revision #1) =="
CT="$(post_graphql "{\"query\":\"mutation{createContentType(workspaceId:\\\"$WS\\\", key:\\\"article\\\", fieldSchema:\\\"{\\\\\\\"fields\\\\\\\":[{\\\\\\\"key\\\\\\\":\\\\\\\"headline\\\\\\\",\\\\\\\"type\\\\\\\":\\\\\\\"text\\\\\\\"}]}\\\"){id}}\"}")"
CT_ID="$(echo "$CT" | json_get data.createContentType.id)"
[ -n "$CT_ID" ] || { echo "createContentType failed: $CT"; exit 1; }
ITEM="$(post_graphql "{\"query\":\"mutation{createContent(workspaceId:\\\"$WS\\\", contentTypeId:\\\"$CT_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v1\\\\\\\"}\\\"){id status}}\"}")"
ITEM_ID="$(echo "$ITEM" | json_get data.createContent.id)"
[ -n "$ITEM_ID" ] || { echo "createContent failed: $ITEM"; exit 1; }
REVS1="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS1" = "1" ] || { echo "expected 1 revision at create, got $REVS1"; exit 1; }
CREATED_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.created' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$CREATED_EVT" -ge 1 ] || { echo "no content.created event"; exit 1; }

echo "== [content] no-op re-save dedups (still 1 revision) =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v1\\\\\\\"}\\\"){id}}\"}" >/dev/null
REVS_DEDUP="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS_DEDUP" = "1" ] || { echo "identical re-save added a revision (dedupe broken), got $REVS_DEDUP"; exit 1; }

echo "== [content] a real edit adds revision #2 =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v2\\\\\\\"}\\\"){id}}\"}" >/dev/null
REVS2="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS2" = "2" ] || { echo "expected 2 revisions after a real edit, got $REVS2"; exit 1; }

echo "== [content] submit for approval (content.submitted_for_approval) =="
post_graphql "{\"query\":\"mutation{submitForApproval(itemId:\\\"$ITEM_ID\\\"){id status}}\"}" | grep -q 'in_review' || { echo "submitForApproval did not move to in_review"; exit 1; }
SUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.submitted_for_approval' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$SUB_EVT" -ge 1 ] || { echo "no content.submitted_for_approval event"; exit 1; }

echo "== [content] decide approval (approve) — content.approved + approved_revision_id frozen =="
# decideApproval takes an approvalId (NOT itemId). Prefer the contentApprovals surface (Part D,
# backed by Part B's listApprovals); the RLS-bypassing psql read is the fallback if json_get can't
# index the list.
APPROVAL_ID="$(post_graphql "{\"query\":\"query{contentApprovals(workspaceId:\\\"$WS\\\", itemId:\\\"$ITEM_ID\\\", state:\\\"pending\\\"){id}}\"}" | json_get data.contentApprovals.0.id)"
[ -n "$APPROVAL_ID" ] || APPROVAL_ID="$(psql "$DB_URL" -tAc "select id from public.content_approval where content_item_id='$ITEM_ID' and state='pending' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$APPROVAL_ID" ] || { echo "no pending content_approval row to decide"; exit 1; }
post_graphql "{\"query\":\"mutation{decideApproval(approvalId:\\\"$APPROVAL_ID\\\", vote:\\\"approve\\\"){id state approved_revision_id}}\"}" | grep -q 'approved' || { echo "decideApproval(approve) failed"; exit 1; }
APPROVED_REV="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){approved_revision_id current_revision_id}}\"}" | json_get data.contentItem.approved_revision_id)"
[ -n "$APPROVED_REV" ] || { echo "approved_revision_id not set after approval"; exit 1; }
APP_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.approved' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$APP_EVT" -ge 1 ] || { echo "no content.approved event"; exit 1; }

echo "== [content] editing after approval supersedes it (status in_review; approved rev retained/frozen) =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v3-draft\\\\\\\"}\\\"){id}}\"}" >/dev/null
AFTER="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){status approved_revision_id current_revision_id}}\"}")"
echo "$AFTER" | grep -q 'in_review' || { echo "post-approval edit did not return to in_review: $AFTER"; exit 1; }
STILL_APPROVED="$(echo "$AFTER" | json_get data.contentItem.approved_revision_id)"
CURRENT_REV="$(echo "$AFTER" | json_get data.contentItem.current_revision_id)"
[ "$STILL_APPROVED" = "$APPROVED_REV" ] || { echo "approved revision not frozen after edit (was $APPROVED_REV, now $STILL_APPROVED)"; exit 1; }
[ "$CURRENT_REV" != "$APPROVED_REV" ] || { echo "current revision should differ from the frozen approved one"; exit 1; }
# Part B's publish_content prefers approved_revision_id over current_revision_id, so publishing
# after this edit still publishes the frozen approved revision, not the newer draft.
```

**Publish + the SIGNED webhook (verify the HMAC against the RAW body).** Stand up a one-shot local HTTP capture, point a workspace webhook subscription at it with a known secret, publish, run the flows worker to deliver, then recompute the HMAC over the **exact captured bytes** and compare to the delivered `x-movp-signature`.

> The signed webhook is delivered by the committed `flows` edge function (`supabase/functions/flows/index.ts` → `runFlowsWorker`). The webhook is registered through `public.register_webhook(ws, event_type, url, secret)` (which writes `movp_internal.webhooks`) — there is NO `public.webhook_subscription` table. The capture host (`http://host.docker.internal:8899`) assumes the worker delivers from inside the Supabase stack.

```bash
echo "== [content] publish -> content.published + a SIGNED webhook (HMAC over the raw body) =="
CAP_DIR="$(mktemp -d)"; WH_SECRET="e2e-webhook-secret-$(date +%s)"
node -e 'const http=require("http"),fs=require("fs"),d=process.argv[1];http.createServer((q,r)=>{const b=[];q.on("data",c=>b.push(c));q.on("end",()=>{fs.writeFileSync(d+"/body",Buffer.concat(b));fs.writeFileSync(d+"/sig",String(q.headers["x-movp-signature"]||""));r.writeHead(200);r.end("ok")})}).listen(8899,()=>console.error("cap up"))' "$CAP_DIR" &
CAP_PID=$!; sleep 1
# Register the webhook via the committed RPC: register_webhook(ws, event_type, url, secret) -> movp_internal.webhooks.
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.register_webhook('$WS', 'content.published', 'http://host.docker.internal:8899', '$WH_SECRET');"
post_graphql "{\"query\":\"mutation{publishContent(itemId:\\\"$ITEM_ID\\\"){id status published_revision_id}}\"}" | grep -q 'published' || { echo "publishContent failed"; exit 1; }
PUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.published' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$PUB_EVT" -ge 1 ] || { echo "no content.published event"; exit 1; }
# Run the served flows edge function once to deliver the webhook job. NO `|| true` —
# a runner failure must fail the slice loudly.
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/content-flows.json
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/content-flows.json","utf8")); if ((j.processed||0) < 1 || (j.failed||0) > 0) { console.error("flows worker did not deliver cleanly:", j); process.exit(1) }'
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CAP_DIR/body" ] && break; sleep 1; done
[ -s "$CAP_DIR/body" ] || { echo "no webhook body captured"; kill "$CAP_PID" 2>/dev/null; exit 1; }
SIG="$(cat "$CAP_DIR/sig")"; SIG="${SIG#sha256=}"
# HMAC over the EXACT raw bytes on the wire (the file) — never a re-serialized parse, which
# would reorder keys/whitespace and never match. This is the load-bearing signature check.
EXP="$(openssl dgst -sha256 -hmac "$WH_SECRET" < "$CAP_DIR/body" | awk '{print $NF}')"
kill "$CAP_PID" 2>/dev/null || true
[ -n "$SIG" ] && [ "$SIG" = "$EXP" ] || { echo "webhook x-movp-signature HMAC mismatch (sig=$SIG exp=$EXP)"; exit 1; }

echo "== [content] getPublished returns the frozen snapshot while a newer draft exists =="
PUBLISHED_HEADLINE="$(post_graphql "{\"query\":\"query{publishedContent(id:\\\"$ITEM_ID\\\"){ item{id slug status} revision{id data content_hash} }}\"}" | json_get data.publishedContent.revision.data)"
echo "$PUBLISHED_HEADLINE" | grep -q 'v2' || { echo "getPublished did not return the frozen (approved v2) snapshot: $PUBLISHED_HEADLINE"; exit 1; }
DRAFT_HEADLINE="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){data}}\"}" | json_get data.contentItem.data)"
echo "$DRAFT_HEADLINE" | grep -q 'v3-draft' || { echo "current draft is not the newer v3-draft: $DRAFT_HEADLINE"; exit 1; }

echo "== [content] curation published-only + runSeoAudit writes a score/checklist =="
post_graphql "{\"query\":\"query{content(workspaceId:\\\"$WS\\\", status:\\\"published\\\"){items{id}}}\"}" | grep -q "$ITEM_ID" || { echo "published-only curation did not include the item"; exit 1; }
SEO="$(post_graphql "{\"query\":\"mutation{runSeoAudit(itemId:\\\"$ITEM_ID\\\"){score checklist}}\"}")"
echo "$SEO" | grep -q '"score"' || { echo "runSeoAudit returned no score: $SEO"; exit 1; }
echo "$SEO" | json_get data.runSeoAudit.checklist | grep -q '.' || { echo "runSeoAudit returned an empty checklist: $SEO"; exit 1; }

echo "== [content] unpublish (content.unpublished; dropped from published curation) =="
post_graphql "{\"query\":\"mutation{unpublishContent(itemId:\\\"$ITEM_ID\\\"){id status}}\"}" >/dev/null
UNPUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.unpublished' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$UNPUB_EVT" -ge 1 ] || { echo "no content.unpublished event"; exit 1; }

echo "== [content] schedule + run the content scheduler (claim -> run the PINNED revision) =="
CUR_REV="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){current_revision_id}}\"}" | json_get data.contentItem.current_revision_id)"
[ -n "$CUR_REV" ] || { echo "could not read current_revision_id for scheduling"; exit 1; }
post_graphql "{\"query\":\"mutation{scheduleContent(itemId:\\\"$ITEM_ID\\\", action:\\\"publish\\\", revisionId:\\\"$CUR_REV\\\", runAt:\\\"2000-01-01T00:00:00Z\\\"){id state}}\"}" >/dev/null
# A past runAt is due. The committed scheduler path is claim_due_schedules (scheduled -> fired,
# crash-safe under SKIP LOCKED) then run_scheduled_publish per FIRED row — there is NO
# public.run_content_scheduler(). NOTE: after the claim the due rows are 'fired' (not 'scheduled'),
# and run_scheduled_publish only acts on 'fired' rows, so the run filter is state='fired'. No
# `|| true` on these two runner commands: a runner failure fails the slice loudly.
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.claim_due_schedules(100);" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.run_scheduled_publish(id) from public.content_schedule where state='fired' and run_at <= now();" >/dev/null
SCHED_ROW="$(psql "$DB_URL" -tAc "select count(*) from public.content_schedule where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$SCHED_ROW" -ge 1 ] || { echo "no content_schedule row for the item"; exit 1; }

echo "== [content] authz — a capability-less member cannot decide/publish via the API [42501] =="
post_graphql "{\"query\":\"mutation{submitForApproval(itemId:\\\"$ITEM_ID\\\"){id}}\"}" >/dev/null
DENY_APPROVAL_ID="$(psql "$DB_URL" -tAc "select id from public.content_approval where content_item_id='$ITEM_ID' and state='pending' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$DENY_APPROVAL_ID" ] || { echo "no pending approval to test the deny path"; exit 1; }
DENY_DECIDE="$(post_graphql_as "$TOKEN2" "{\"query\":\"mutation{decideApproval(approvalId:\\\"$DENY_APPROVAL_ID\\\", vote:\\\"approve\\\"){id}}\"}")"
echo "$DENY_DECIDE" | grep -q '"errors"' || { echo "USER2 (no approve cap) was allowed to decide: $DENY_DECIDE"; exit 1; }
DENY_PUB="$(post_graphql_as "$TOKEN2" "{\"query\":\"mutation{publishContent(itemId:\\\"$ITEM_ID\\\"){id}}\"}")"
echo "$DENY_PUB" | grep -q '"errors"' || { echo "USER2 (no publish cap) was allowed to publish: $DENY_PUB"; exit 1; }

echo "== [content] authz — a non-member (USER3) sees 0 rows =="
NM="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{content(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
echo "$NM" | grep -q "$ITEM_ID" && { echo "non-member saw content rows: $NM"; exit 1; } || true

echo "== [content] immutability — content_revision + content_publish_event rows cannot be UPDATEd =="
REV_ID="$(psql "$DB_URL" -tAc "select id from public.content_revision where content_item_id='$ITEM_ID' order by created_at limit 1;" | tr -d '[:space:]')"
BEFORE_HASH="$(psql "$DB_URL" -tAc "select content_hash from public.content_revision where id='$REV_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER2_ID\"}'; update public.content_revision set content_hash='tampered' where id='$REV_ID'; rollback;" >/dev/null 2>&1 || true
AFTER_HASH="$(psql "$DB_URL" -tAc "select content_hash from public.content_revision where id='$REV_ID';" | tr -d '[:space:]')"
[ "$BEFORE_HASH" = "$AFTER_HASH" ] || { echo "content_revision was mutated (immutability broken)"; exit 1; }
PE_BEFORE="$(psql "$DB_URL" -tAc "select count(*) from public.content_publish_event where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER2_ID\"}'; update public.content_publish_event set content_item_id='00000000-0000-0000-0000-000000000000' where content_item_id='$ITEM_ID'; rollback;" >/dev/null 2>&1 || true
PE_AFTER="$(psql "$DB_URL" -tAc "select count(*) from public.content_publish_event where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$PE_BEFORE" = "$PE_AFTER" ] || { echo "content_publish_event was mutated (immutability broken)"; exit 1; }

echo "== [content] observability — each transition emits ONE trace-correlated, ids-only event =="
for T in content.created content.submitted_for_approval content.approved content.published content.unpublished; do
  N="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
  [ "$N" -ge 1 ] || { echo "missing event $T"; exit 1; }
  TRACED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID' and trace_id is not null;" | tr -d '[:space:]')"
  [ "$TRACED" = "$N" ] || { echo "event $T is not trace-correlated"; exit 1; }
done
# Redaction: no event payload for this item may carry the human title/body text (ids only).
LEAK="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where payload->>'id'='$ITEM_ID' and (payload::text ilike '%E2E article%' or payload::text ilike '%v3-draft%');" | tr -d '[:space:]')"
[ "$LEAK" = "0" ] || { echo "event payload leaked content title/body text (redaction broken)"; exit 1; }
```

- [ ] **Step 2: Gate**

Ensure `supabase start` has run and the GraphQL edge function + flows worker deps are available, then:
```bash
bash -n scripts/slice-e2e.sh && bash scripts/slice-e2e.sh && bash scripts/check-boundary.sh
```
Expected: `bash -n` clean (no syntax error); the slice prints each `== [content] …` step and ends `slice-e2e: PASS` with every `[content]` assertion passing; boundary prints its clean line. A failure prints the offending step's diagnostic and exits non-zero.

- [ ] **Step 3: Commit**
```bash
git add scripts/slice-e2e.sh
git commit -m "test(e2e): CMS content slice — create/approve/publish(+signed webhook)/getPublished/unpublish/schedule/authz/immutability/redaction"
```

---

## Self-Review (eight-dimension pass)

- **Correctness (clean):** Every op name matches the A/B/C `ContentService` contract exactly (`createType`/`create`/`update`/`get`/`list`/`listRevisions`/`submitForApproval`/`decideApproval`/`publish`/`unpublish`/`getPublished`/`schedule`/`runSeoAudit`/`issueAssetUpload`/`finalizeAsset`/`createCollection`/`addToCollection`). No new collection, no migration — surfaces only. Resolver/tool/command/e2e argument shapes were RECONCILED to the `ContentService` (not left as guesses): `decideApproval({approvalId,vote})→ContentApprovalRow`, `schedule({itemId,action,revisionId,runAt})→ContentScheduleRow`, `issueAssetUpload({...,mime,sizeBytes})`, `finalizeAsset({assetId,checksum,sizeBytes,width?,height?})`; and the last two names are reconciled against Part A — `create` takes `{workspaceId,contentTypeId,slug,data}` (there is NO `content_item.title` column; the display title is a field inside `data`), and `createType` uses `label` (not `name`). Pinned by the `[content]` e2e (the running-service check). SDL/tool/CLI tests assert internal collections get NO generic CRUD while note/tag stay surfaced.
- **Safety (clean):** CMS is `internal` so no generic CRUD bypasses the service; authoritative capability/RLS checks live in the DB/service, and the e2e proves a capability-less member is denied decide/publish (`errors`/42501) and a non-member sees 0 rows. The frontend honors the boundary (GraphQL-over-HTTP only; `check-boundary.sh`), and the token stays server-side (POST form actions), never in client JS. Immutability of `content_revision`/`content_publish_event` is asserted by before/after value comparison (robust to error-vs-0-rows).
- **Reliability (clean):** Dedupe (identical re-save → no new revision) and the frozen approved/published revision are asserted; the webhook check invokes the served `flows` function, asserts it processed cleanly, waits/polls for delivery, and fails loudly on no capture. Scheduler runners and table names are concrete (`claim_due_schedules` + `run_scheduled_publish`, `content_revision`/`content_publish_event`/`content_schedule`).
- **Observability (clean):** The e2e asserts each transition emits exactly-present, trace-correlated events AND that payloads carry no title/body text (redaction). Surfaces add no row-value logging.
- **Efficiency (LOW):** The `content_type` nested resolver is detail-only and kept off list selections (N+1 avoided, noted at the trigger site). The editor re-fetches types/revisions per detail render — acceptable for SSR pages; no duplicate client+server fetch.
- **Performance (clean):** List/board use the existing keyset pagination + complexity multipliers; JSON fields are strings (no deep object graphs); no new hot-path round-trips beyond the detail nested type.
- **Simplicity (LOW):** JSON exposed as `String`-carrying-JSON (matching the collab precedent) instead of introducing a builder-wide scalar — the least-invasive choice; the swap-to-`JSON`-scalar path is documented if one already exists. Aux result types are minimal.
- **Usability (clean):** Every page states its empty/loading/error+retry/auth-failure states and keyboard/`aria-current` behaviour; the a11y smoke runs axe over `/content`, the seeded `/content/<id>`, `/content/approvals`, and `/content/calendar`. The SEO panel is a POST action (GET stays safe), avoiding a mutation-on-render usability/safety trap.

**Deferred (stated, not silently dropped):** multi-approver progress display (if the item lacks progress fields); the calendar's dedicated `content_schedule` read (falls back to `inbox` if schedules aren't columns on `content_item`); richer asset-field previews. Each is a documented follow-up, not a gate.

## Final reconciliation checklist

- [ ] Every resolver/tool/command `content.*` argument object matches `packages/domain/src/content.ts`'s A/B/C signatures (the `[content]` e2e is green — the real check).
- [ ] Surface tests run against a `content` **mock** (Tasks 1–3) OR the real `createDomain` where they assert wiring; the `[content]` e2e (Task 5) runs against the real service.
- [ ] `templates/` imports only the generated client/types over HTTP — no `@movp/{auth,domain}` / service-role. `bash scripts/check-boundary.sh` green.
- [ ] The webhook HMAC is computed over the **raw captured bytes** (the file), compared to the delivered `x-movp-signature` — not a re-serialized parse.
- [ ] The e2e uses the REAL committed slice vars/helpers (`$WS` not `$WS_ID`; `$USER2_ID` not `$MEMBER2_ID`; `post_graphql`/`post_graphql_as`/`json_get`/`psql "$DB_URL"`).
- [ ] Reconcile points resolved before running: `data`/`field_schema` use String-JSON at the GraphQL/MCP/CLI boundary; webhook registration is the committed `public.register_webhook` RPC → `movp_internal.webhooks`; webhook delivery invokes the served `flows` function; the scheduler path is `claim_due_schedules` + `run_scheduled_publish` (no `run_content_scheduler`); table names are `content_revision`/`content_publish_event`/`content_schedule`; and post-approval edits retain the frozen approved revision.
- [ ] Full suite: `pnpm test` (turbo) + `bash scripts/slice-e2e.sh` green; all code fences balanced; each task has an exact path + command + expected output + a machine-checkable gate.
