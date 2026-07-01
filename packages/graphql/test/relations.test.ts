import { describe, expect, it } from 'vitest'
import { loadEdgeTargets } from '../src/relations.ts'

function fakeDb(edges: { src_id: string; dst_id: string }[], rows: Record<string, unknown>[]) {
  const calls: string[] = []
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => Promise.resolve({ data: table === 'edges' ? edges : rows }),
    }
    return b
  }
  return {
    calls,
    from(table: string) {
      calls.push(table)
      return builder(table)
    },
  }
}

describe('loadEdgeTargets', () => {
  it('returns [] for empty input without touching the db', async () => {
    const db = fakeDb([], [])
    const out = await loadEdgeTargets(db as any, { srcType: 'note', rel: 'tags', dstType: 'tag', srcIds: [] })
    expect(out).toEqual([])
    expect(db.calls).toEqual([])
  })

  it('issues exactly 2 statements for any number of source ids', async () => {
    const srcIds = Array.from({ length: 50 }, (_v, i) => `n${i}`)
    const edges = [
      { src_id: 'n0', dst_id: 't1' },
      { src_id: 'n0', dst_id: 't2' },
      { src_id: 'n1', dst_id: 't1' },
    ]
    const rows = [
      { id: 't1', workspace_id: 'w', created_at: 'c', updated_at: 'u', name: 'a' },
      { id: 't2', workspace_id: 'w', created_at: 'c', updated_at: 'u', name: 'b' },
    ]
    const db = fakeDb(edges, rows)
    const out = await loadEdgeTargets(db as any, { srcType: 'note', rel: 'tags', dstType: 'tag', srcIds })
    expect(db.calls).toEqual(['edges', 'tag'])
    expect(out).toHaveLength(50)
    expect((out[0] as any[]).map((t) => t.id)).toEqual(['t1', 't2'])
    expect((out[1] as any[]).map((t) => t.id)).toEqual(['t1'])
    expect(out[2]).toEqual([])
  })
})
