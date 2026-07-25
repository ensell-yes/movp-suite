import { describe, expect, it, vi } from 'vitest'
import { makeContentService } from '../src/content.ts'

const item = {
  id: 'item-1',
  workspace_id: 'workspace-1',
  content_type_id: 'type-1',
  slug: 'hello',
  status: 'draft',
  current_revision_id: 'revision-1',
  approved_revision_id: null,
  published_revision_id: null,
  scheduled_for: null,
  created_at: '2026-07-24T00:00:00Z',
  updated_at: '2026-07-24T00:00:00Z',
}

const type = {
  id: 'type-1',
  workspace_id: 'workspace-1',
  key: 'article',
  label: 'Article',
  field_schema: [
    { name: 'headline', type: 'text' },
    { name: 'body', type: 'richtext' },
    { name: 'metadata', type: 'json' },
  ],
  moderation_policy: 'none',
  approval_policy: 'none',
  created_at: '2026-07-24T00:00:00Z',
  updated_at: '2026-07-24T00:00:00Z',
}

const revision = {
  id: 'revision-1',
  workspace_id: 'workspace-1',
  content_item_id: 'item-1',
  revision_number: 1,
  parent_id: null,
  data: {
    headline: 'Keep me',
    body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Old"}]}]}',
    metadata: { nested: ['unchanged'] },
  },
  content_hash: 'hash-1',
  search_text: 'Keep me',
  search_body: 'Old',
  author_id: 'user-1',
  created_at: '2026-07-24T00:00:00Z',
}

function detailDb(overrides?: {
  item?: typeof item | null
  type?: typeof type | null
  revision?: typeof revision | null
}) {
  const row = overrides?.item === null
    ? null
    : {
        ...(overrides?.item ?? item),
        type: overrides?.type === null ? null : (overrides?.type ?? type),
        current_revision: overrides?.revision === null ? null : (overrides?.revision ?? revision),
      }
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from, select }
}

describe('content.updateRichTextField', () => {
  it('returns stable missing-item, missing-field, and wrong-field-type codes', async () => {
    const missingItem = makeContentService({
      db: detailDb({ item: null }) as never,
      userId: 'user-1',
    })
    expect(await missingItem.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: '{}',
      expectedRevisionId: 'revision-1',
    })).toEqual({ status: 'error', code: 'content_item_not_found' })

    const service = makeContentService({ db: detailDb() as never, userId: 'user-1' })
    expect(await service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'missing',
      body: '{}',
      expectedRevisionId: 'revision-1',
    })).toEqual({ status: 'error', code: 'content_field_not_found' })
    expect(await service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'headline',
      body: '{}',
      expectedRevisionId: 'revision-1',
    })).toEqual({ status: 'error', code: 'content_field_not_richtext' })
  })

  it('merges only the named field and delegates exactly once to ContentService.update', async () => {
    const db = detailDb()
    const service = makeContentService({ db: db as never, userId: 'user-1' })
    const update = vi.spyOn(service, 'update').mockResolvedValue({
      ...item,
      current_revision_id: 'revision-2',
    } as never)
    const nextBody = '{"type":"doc","content":[{"type":"paragraph"}]}'

    await expect(service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: nextBody,
      expectedRevisionId: 'revision-1',
    })).resolves.toEqual({ status: 'saved', revisionId: 'revision-2' })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      itemId: 'item-1',
      data: {
        headline: 'Keep me',
        body: nextBody,
        metadata: { nested: ['unchanged'] },
      },
      expectedRevisionId: 'revision-1',
    })
    expect(db.from).toHaveBeenCalledTimes(1)
    expect(db.from).not.toHaveBeenCalledWith('content_revision')
  })

  it('flows through the existing canonical hash-first update path', async () => {
    const rpc = vi.fn(async () => ({
      data: { ...item, current_revision_id: 'revision-2' },
      error: null,
    }))
    const from = vi.fn((table: string) => ({
      select: (selection: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'content_item' && selection.includes('current_revision:')) {
              return { data: { ...item, type, current_revision: revision }, error: null }
            }
            if (table === 'content_item' && selection === 'content_type_id') {
              return { data: { content_type_id: 'type-1' }, error: null }
            }
            if (table === 'content_type' && selection === 'field_schema') {
              return { data: { field_schema: type.field_schema }, error: null }
            }
            return { data: null, error: { code: 'unexpected_read' } }
          },
        }),
      }),
    }))
    const service = makeContentService({ db: { from, rpc } as never, userId: 'user-1' })

    await expect(service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: '<p>Hello</p>',
      expectedRevisionId: 'revision-1',
    })).resolves.toEqual({ status: 'saved', revisionId: 'revision-2' })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('update_content', expect.objectContaining({
      p_item_id: 'item-1',
      p_expected_revision_id: 'revision-1',
      p_data: {
        headline: 'Keep me',
        body: '{"content":[{"content":[{"text":"<p>Hello</p>","type":"text"}],"type":"paragraph"}],"type":"doc"}',
        metadata: { nested: ['unchanged'] },
      },
    }))
    expect(from).not.toHaveBeenCalledWith('content_revision')
  })

  it('preserves idempotent stale no-op success and classifies a real stale conflict', async () => {
    const service = makeContentService({ db: detailDb() as never, userId: 'user-1' })
    vi.spyOn(service, 'update')
      .mockResolvedValueOnce({ ...item, current_revision_id: 'revision-current' } as never)
      .mockRejectedValueOnce(new Error('domain.content.update failed [content_update_conflict]'))

    await expect(service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: revision.data.body,
      expectedRevisionId: 'revision-stale',
    })).resolves.toEqual({ status: 'saved', revisionId: 'revision-current' })
    await expect(service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: '{"type":"doc","content":[]}',
      expectedRevisionId: 'revision-stale',
    })).resolves.toEqual({ status: 'conflict' })
  })

  it('never exposes operational or database messages as result codes', async () => {
    const service = makeContentService({ db: detailDb() as never, userId: 'user-1' })
    vi.spyOn(service, 'update').mockRejectedValue(
      new Error('private database host failed [XX000]: body=secret'),
    )

    const result = await service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: '{"type":"doc","content":[]}',
      expectedRevisionId: 'revision-1',
    })
    expect(result).toEqual({ status: 'error', code: 'content_save_failed' })
    expect(JSON.stringify(result)).not.toContain('private database')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('classifies an RLS denial without exposing the database message', async () => {
    const service = makeContentService({ db: detailDb() as never, userId: 'user-1' })
    vi.spyOn(service, 'update').mockRejectedValue(
      new Error('domain.content.update failed [42501]: private policy detail'),
    )

    const result = await service.updateRichTextField({
      itemId: 'item-1',
      fieldKey: 'body',
      body: '{"type":"doc","content":[]}',
      expectedRevisionId: 'revision-1',
    })
    expect(result).toEqual({ status: 'error', code: 'content_edit_forbidden' })
    expect(JSON.stringify(result)).not.toContain('private policy')
  })
})
