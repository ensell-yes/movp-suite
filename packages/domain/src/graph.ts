import type { DomainCtx, GraphService } from './types.ts'

export function makeGraphService(ctx: DomainCtx): GraphService {
  return {
    async link(args) {
      const { error } = await ctx.db.from('edges').upsert({
        workspace_id: args.workspaceId,
        src_type: args.srcType,
        src_id: args.srcId,
        rel: args.rel,
        dst_type: args.dstType,
        dst_id: args.dstId,
      })
      if (error) throw new Error(`domain.graph.link failed [${error.code ?? 'unknown'}]`)
    },

    async traverse(args) {
      const { data, error } = await ctx.db.rpc('traverse_edges', {
        ws: args.workspaceId,
        start_type: args.srcType,
        start_id: args.srcId,
        rel_filter: args.rel ?? null,
        max_depth: Math.min(Math.max(args.depth ?? 3, 1), 10),
      })
      if (error) throw new Error(`domain.graph.traverse failed [${error.code ?? 'unknown'}]`)
      return (data ?? []) as Array<{ type: string; id: string; depth: number }>
    },
  }
}
