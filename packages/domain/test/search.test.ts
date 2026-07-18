import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { runSearch } from '../src/search.ts'
import type { DomainCtx, EmbeddingProvider } from '../src/types.ts'

const chunks = [
  {
    source_table: 'task_revision',
    source_id: 'revision-current',
    content: 'Current task body',
    distance: 0.1,
  },
  {
    source_table: 'task_revision',
    source_id: 'revision-old',
    content: 'Stale task body',
    distance: 0.05,
  },
  {
    source_table: 'campaign',
    source_id: 'campaign-1',
    content: 'Campaign semantic brief',
    distance: 0.2,
  },
]

const tableRows: Record<string, Array<Record<string, unknown>>> = {
  task_revision: [
    { id: 'revision-current', task_id: 'task-1' },
    { id: 'revision-old', task_id: 'task-1' },
  ],
  task: [{ id: 'task-1', title: 'Current task title', current_revision_id: 'revision-current' }],
  campaign: [{ id: 'campaign-1', name: 'Campaign name' }],
}

function fakeCtx() {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const selectCalls: Array<{ table: string; columns: string; filterColumn: string; ids: string[] }> = []
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'match_chunks') {
        const filter = args.source_table_filter
        return {
          data: filter == null ? chunks : chunks.filter((chunk) => chunk.source_table === filter),
          error: null,
        }
      }
      if (fn === 'search_fts') {
        if (!['note', 'tag', 'content_item'].includes(String(args.src_table))) {
          return { data: null, error: { code: 'P0001' } }
        }
        return { data: [], error: null }
      }
      return { data: null, error: null }
    }),
    from: vi.fn((table: string) => ({
      select: (columns: string) => ({
        in: async (filterColumn: string, ids: string[]) => {
          selectCalls.push({ table, columns, filterColumn, ids })
          if (columns.split(',').map((column) => column.trim()).includes('title') && table !== 'task') {
            return { data: null, error: { code: '42703' } }
          }
          return {
            data: (tableRows[table] ?? []).filter((row) => ids.includes(String(row[filterColumn]))),
            error: null,
          }
        },
      }),
    })),
  }
  const ctx: DomainCtx = {
    db: db as unknown as SupabaseClient,
    userId: 'user-1',
  }
  return { ctx, rpcCalls, selectCalls }
}

const embedder: EmbeddingProvider = {
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}

describe('semantic source normalization', () => {
  it('maps scoped task search to the current task revision', async () => {
    const { ctx, rpcCalls } = fakeCtx()

    const hits = await runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'task body',
      mode: 'semantic',
      collection: 'task',
    })

    expect(rpcCalls).toContainEqual(expect.objectContaining({
      fn: 'match_chunks',
      args: expect.objectContaining({ source_table_filter: 'task_revision' }),
    }))
    expect(hits).toEqual([
      expect.objectContaining({
        collection: 'task',
        id: 'task-1',
        title: 'Current task title',
        snippet: 'Current task body',
      }),
    ])
    expect(hits.some((hit) => hit.snippet === 'Stale task body')).toBe(false)
  })

  it('uses semantic-only fallback for task hybrid search', async () => {
    const { ctx, rpcCalls } = fakeCtx()

    const hits = await runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'task body',
      mode: 'hybrid',
      collection: 'task',
    })

    expect(hits).toEqual([expect.objectContaining({ collection: 'task', id: 'task-1' })])
    expect(rpcCalls.some(({ fn }) => fn === 'search_fts')).toBe(false)
  })

  it('uses campaign names and semantic-only fallback for campaign hybrid search', async () => {
    const { ctx, rpcCalls } = fakeCtx()

    const hits = await runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'campaign brief',
      mode: 'hybrid',
      collection: 'campaign',
    })

    expect(hits).toEqual([
      expect.objectContaining({ collection: 'campaign', id: 'campaign-1', title: 'Campaign name' }),
    ])
    expect(rpcCalls.some(({ fn }) => fn === 'search_fts')).toBe(false)
  })

  it('hydrates unscoped semantic results without stale task revisions', async () => {
    const { ctx } = fakeCtx()

    const hits = await runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'everything',
      mode: 'semantic',
    })

    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'task', id: 'task-1', title: 'Current task title' }),
      expect.objectContaining({ collection: 'campaign', id: 'campaign-1', title: 'Campaign name' }),
    ]))
    expect(hits).toHaveLength(2)
  })

  it('keeps unscoped hybrid search safe when revision and campaign chunks exist', async () => {
    const { ctx } = fakeCtx()

    await expect(runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'everything',
      mode: 'hybrid',
    })).resolves.toHaveLength(2)
  })

  it('rejects explicit FTS for unsupported collections with a stable error', async () => {
    const { ctx } = fakeCtx()

    await expect(runSearch(ctx, embedder, {
      workspaceId: 'workspace-1',
      query: 'task title',
      mode: 'fts',
      collection: 'task',
    })).rejects.toThrow("domain.search.fts unsupported collection 'task'")
  })
})
