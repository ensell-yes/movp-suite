import type { SupabaseClient } from '@supabase/supabase-js'
import type { Row } from './types.ts'

export async function loadEdgeTargets(
  db: SupabaseClient,
  opts: { srcType: string; rel: string; dstType: string; srcIds: readonly string[] },
): Promise<Row[][]> {
  const { srcType, rel, dstType, srcIds } = opts
  if (srcIds.length === 0) return []

  const edgesRes = await db
    .from('edges')
    .select('src_id, dst_id')
    .eq('src_type', srcType)
    .eq('rel', rel)
    .eq('dst_type', dstType)
    .in('src_id', srcIds as string[])
  const edges = (edgesRes.data ?? []) as { src_id: string; dst_id: string }[]

  const dstIds = [...new Set(edges.map((e) => e.dst_id))]
  const rowsRes = dstIds.length ? await db.from(dstType).select('*').in('id', dstIds) : { data: [] as Row[] }
  const byId = new Map<string, Row>()
  for (const r of (rowsRes.data ?? []) as Row[]) byId.set(r.id, r)

  const grouped = new Map<string, Row[]>()
  for (const e of edges) {
    const target = byId.get(e.dst_id)
    if (!target) continue
    const list = grouped.get(e.src_id) ?? []
    list.push(target)
    grouped.set(e.src_id, list)
  }
  return srcIds.map((id) => grouped.get(id) ?? [])
}
