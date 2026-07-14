import { describe, expect, it, vi } from 'vitest'
import { makeContentService } from '../src/content.ts'

describe('content service', () => {
  it('loads content detail in one query and preserves the public response shape', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        id: 'item-1',
        workspace_id: 'workspace-1',
        content_type_id: 'type-1',
        slug: 'hello',
        status: 'draft',
        current_revision_id: 'revision-1',
        approved_revision_id: null,
        published_revision_id: null,
        scheduled_for: null,
        created_at: '2026-07-13T00:00:00Z',
        updated_at: '2026-07-13T00:00:00Z',
        type: { id: 'type-1', key: 'article' },
        current_revision: { id: 'revision-1', data: { title: 'Hello' } },
      },
      error: null,
    }))
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    const service = makeContentService({ db: { from } as never, userId: 'user-1' })

    const getDetail = service.getDetail
    const detail = await getDetail('item-1')

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('content_item')
    expect(select).toHaveBeenCalledWith(expect.stringContaining('content_item_content_type_id_fkey'))
    expect(select).toHaveBeenCalledWith(expect.stringContaining('content_item_current_revision_fk'))
    expect(detail?.type?.key).toBe('article')
    expect(detail?.currentRevision?.data).toEqual({ title: 'Hello' })
    expect(detail?.item).not.toHaveProperty('type')
    expect(detail?.item).not.toHaveProperty('current_revision')
  })
})
