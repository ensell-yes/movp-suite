import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'ci1',
    workspace_id: 'w',
    content_type_id: 'ct1',
    slug: 'hello',
    status: 'draft',
    search_text: 'Hello',
    current_revision_id: 'r2',
    approved_revision_id: null,
    published_revision_id: null,
    created_at: 't',
    updated_at: 't',
    ...over,
  })
  const revision = (over: Record<string, unknown> = {}) => ({
    id: 'r2',
    workspace_id: 'w',
    content_item_id: 'ci1',
    parent_id: 'r1',
    revision_number: 2,
    data: { headline: 'Hi' },
    content_hash: 'h2',
    author_id: 'u',
    created_at: 't',
    ...over,
  })
  return {
    item,
    revision,
    createType: vi.fn(async () => ({
      id: 'ct1',
      workspace_id: 'w',
      key: 'article',
      label: 'Article',
      field_schema: [{ name: 'headline', type: 'text' }],
      created_at: 't',
      updated_at: 't',
    })),
    listTypes: vi.fn(async () => ({
      items: [{
        id: 'ct1',
        workspace_id: 'w',
        key: 'article',
        label: 'Article',
        field_schema: [{ name: 'headline', type: 'text' }],
        created_at: 't',
        updated_at: 't',
      }],
      nextCursor: null,
    })),
    create: vi.fn(async (i: any) => item({ content_type_id: i.contentTypeId, slug: i.slug })),
    update: vi.fn(async (i: any) => item({ id: i.itemId })),
    get: vi.fn(async () => item({ data: { headline: 'Hi' } })),
    list: vi.fn(async () => ({ items: [item()], nextCursor: null })),
    listRevisions: vi.fn(async () => ({ items: [revision()], nextCursor: null })),
    submitForApproval: vi.fn(async () => item({ status: 'in_review' })),
    decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
    publish: vi.fn(async () => item({ status: 'published', published_revision_id: 'r2' })),
    unpublish: vi.fn(async () => item({ status: 'draft' })),
    getPublished: vi.fn(async () => ({ item: item({ status: 'published', published_revision_id: 'r2' }), revision: revision() })),
    listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1', content_item_id: 'ci1', state: 'pending', approved_revision_id: null }], nextCursor: null })),
    schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', action: 'publish', revision_id: 'r2', run_at: '2026-07-02T00:00:00Z', state: 'scheduled' })),
    runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [{ rule: 'title_length', pass: true }] })),
    issueAssetUpload: vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' })),
    finalizeAsset: vi.fn(async () => ({ id: 'a1', workspace_id: 'w', r2_key: 'w/a1', filename: 'x.png', mime: 'image/png', size_bytes: 10, created_at: 't' })),
    createCollection: vi.fn(async () => ({ id: 'col1', workspace_id: 'w', key: 'featured', label: 'Featured', description: null, created_at: 't' })),
    addToCollection: vi.fn(async () => undefined),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    content: {
      createType: mocks.createType,
      listTypes: mocks.listTypes,
      create: mocks.create,
      update: mocks.update,
      get: mocks.get,
      list: mocks.list,
      listRevisions: mocks.listRevisions,
      submitForApproval: mocks.submitForApproval,
      decideApproval: mocks.decideApproval,
      publish: mocks.publish,
      unpublish: mocks.unpublish,
      getPublished: mocks.getPublished,
      listApprovals: mocks.listApprovals,
      schedule: mocks.schedule,
      runSeoAudit: mocks.runSeoAudit,
      issueAssetUpload: mocks.issueAssetUpload,
      finalizeAsset: mocks.finalizeAsset,
      createCollection: mocks.createCollection,
      addToCollection: mocks.addToCollection,
      reorderCollection: vi.fn(),
      linkAsset: vi.fn(),
      linkItem: vi.fn(),
      linkEditorialTask: vi.fn(),
    },
  }),
}))

const ctx = { db: {} as never, userId: 'u', accessToken: 'test', assetsFnUrl: 'http://localhost/assets' }
const run = (source: string) => graphql({ schema: buildSchema(movpSchema), source, contextValue: ctx })

describe('content GraphQL surface', () => {
  it('createContent routes to content.create with parsed JSON data', async () => {
    const res = await run('mutation { createContent(workspaceId: "w", contentTypeId: "ct1", slug: "hello", data: "{\\"headline\\":\\"Hi\\"}") { id slug status } }')
    expect(res.errors).toBeUndefined()
    expect(mocks.create).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: 'hello', data: { headline: 'Hi' } })
    expect((res.data as { createContent: { id: string } }).createContent.id).toBe('ci1')
  })

  it('lists content and content types with JSON strings', async () => {
    const page = await run('query { content(workspaceId: "w") { items { id slug status } nextCursor } }')
    expect(page.errors).toBeUndefined()
    expect((page.data as { content: { items: Array<{ id: string }> } }).content.items[0].id).toBe('ci1')

    const types = await run('query { contentTypes(workspaceId: "w") { id key label field_schema } }')
    expect(types.errors).toBeUndefined()
    expect(JSON.parse((types.data as { contentTypes: Array<{ field_schema: string }> }).contentTypes[0].field_schema)[0].name).toBe('headline')
  })

  it('reads item data and revision lineage as JSON strings', async () => {
    const item = await run('query { contentItem(id: "ci1") { id data current_revision_id approved_revision_id } }')
    expect(item.errors).toBeUndefined()
    expect(JSON.parse((item.data as { contentItem: { data: string } }).contentItem.data).headline).toBe('Hi')

    const revs = await run('query { contentRevisions(itemId: "ci1") { id parent_id data content_hash } }')
    expect(revs.errors).toBeUndefined()
    expect((revs.data as { contentRevisions: Array<{ content_hash: string }> }).contentRevisions[0].content_hash).toBe('h2')
  })

  it('approval, publish, schedule, collection, SEO, and asset mutations route correctly', async () => {
    await run('mutation { submitForApproval(itemId: "ci1") { id status } }')
    expect(mocks.submitForApproval).toHaveBeenCalledWith({ itemId: 'ci1' })
    await run('mutation { decideApproval(approvalId: "ap1", vote: "approve") { id state approved_revision_id } }')
    expect(mocks.decideApproval).toHaveBeenCalledWith({ approvalId: 'ap1', vote: 'approve' })
    await run('mutation { publishContent(itemId: "ci1") { id status published_revision_id } }')
    expect(mocks.publish).toHaveBeenCalledWith({ itemId: 'ci1' })
    await run('mutation { scheduleContent(itemId: "ci1", action: "publish", revisionId: "r2", runAt: "2026-07-02T00:00:00Z") { id state } }')
    expect(mocks.schedule).toHaveBeenCalledWith({ itemId: 'ci1', action: 'publish', revisionId: 'r2', runAt: '2026-07-02T00:00:00Z' })
    await run('mutation { createContentCollection(workspaceId: "w", key: "featured", label: "Featured") { id key label } }')
    expect(mocks.createCollection).toHaveBeenCalledWith({ workspaceId: 'w', key: 'featured', label: 'Featured', description: undefined })
    await run('mutation { addToCollection(collectionId: "col1", itemId: "ci1", position: 0) }')
    expect(mocks.addToCollection).toHaveBeenCalledWith({ collectionId: 'col1', itemId: 'ci1', position: 0 })

    const seo = await run('mutation { runSeoAudit(itemId: "ci1") { score checklist } }')
    expect(JSON.parse((seo.data as { runSeoAudit: { checklist: string } }).runSeoAudit.checklist)[0].pass).toBe(true)
    const up = await run('mutation { issueAssetUpload(workspaceId: "w", filename: "x.png", mime: "image/png", sizeBytes: 10) { uploadUrl assetId r2Key } }')
    expect((up.data as { issueAssetUpload: { assetId: string } }).issueAssetUpload.assetId).toBe('a1')
  })

  it('publishedContent and contentApprovals expose workflow reads', async () => {
    const pub = await run('query { publishedContent(id: "ci1") { item { id status } revision { id data content_hash } } }')
    expect(pub.errors).toBeUndefined()
    expect(mocks.getPublished).toHaveBeenCalledWith('ci1')
    expect((pub.data as { publishedContent: { item: { status: string } } }).publishedContent.item.status).toBe('published')

    const approvals = await run('query { contentApprovals(workspaceId: "w", state: "pending") { id content_item_id state } }')
    expect(approvals.errors).toBeUndefined()
    expect(mocks.listApprovals).toHaveBeenCalledWith({ workspaceId: 'w', itemId: undefined, state: 'pending' })
  })

  it('surfaces custom content ops but no generic CRUD for internal CMS collections', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/type ContentItem\b/)
    expect(sdl).toMatch(/type ContentType\b/)
    expect(sdl).toMatch(/type ContentRevision\b/)
    expect(sdl).toMatch(/\bcreateContent\(/)
    expect(sdl).toMatch(/\bpublishContent\(/)
    expect(sdl).not.toMatch(/\bcreateContentItem\(/)
    expect(sdl).not.toMatch(/\bcreateContentRevision\(/)
    expect(sdl).toContain('createNote(')
  })
})
