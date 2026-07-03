import type { DomainCtx, EmbeddingProvider, SearchArgs, SearchHit } from './types.ts'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const COLLECTIONS = ['note', 'tag', 'content_item'] as const

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

interface FtsRow {
  id: string
  title: string
  snippet: string
  score: number
}

interface ChunkRow {
  source_table: string
  source_id: string
  content: string
  distance: number
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

async function ftsSearch(ctx: DomainCtx, args: SearchArgs, limit: number): Promise<SearchHit[]> {
  const collections = args.collection ? [args.collection] : [...COLLECTIONS]
  const batches = await Promise.all(
    collections.map(async (collection) => {
      const { data, error } = await ctx.db.rpc('search_fts', {
        ws: args.workspaceId,
        src_table: collection,
        q: args.query,
        lim: limit,
      })
      if (error) throw new Error(`domain.search.fts failed [${error.code ?? 'unknown'}]`)
      return ((data ?? []) as FtsRow[]).map((row) => ({
        collection,
        id: row.id,
        title: row.title,
        snippet: row.snippet,
        score: Number(row.score),
      }))
    }),
  )
  return batches.flat().sort((a, b) => b.score - a.score).slice(0, limit)
}

async function hydrateTitles(
  ctx: DomainCtx,
  hits: Map<string, { collection: string; id: string; snippet: string; score: number }>,
) {
  const byCollection = new Map<string, string[]>()
  for (const hit of hits.values()) byCollection.set(hit.collection, [...(byCollection.get(hit.collection) ?? []), hit.id])

  const titles = new Map<string, string>()
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      const titleColumn = collection === 'tag' ? 'name' : collection === 'content_item' ? 'search_text' : 'title'
      const { data, error } = await ctx.db.from(collection).select(`id, ${titleColumn}`).in('id', ids)
      if (error) throw new Error(`domain.search.hydrate failed [${error.code ?? 'unknown'}]`)
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        titles.set(`${collection}:${String(row.id)}`, String(row[titleColumn] ?? ''))
      }
    }),
  )
  return titles
}

async function semanticSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider,
  args: SearchArgs,
  limit: number,
): Promise<SearchHit[]> {
  const { data, error } = await ctx.db.rpc('match_chunks', {
    query_embedding: vectorLiteral(await embedder.embed(args.query)),
    ws: args.workspaceId,
    source_table_filter: args.collection ?? null,
    match_count: limit,
  })
  if (error) throw new Error(`domain.search.semantic failed [${error.code ?? 'unknown'}]`)

  const best = new Map<string, { collection: string; id: string; snippet: string; score: number }>()
  for (const chunk of (data ?? []) as ChunkRow[]) {
    const key = `${chunk.source_table}:${chunk.source_id}`
    const score = 1 - Number(chunk.distance)
    const current = best.get(key)
    if (!current || score > current.score) {
      best.set(key, { collection: chunk.source_table, id: chunk.source_id, snippet: chunk.content, score })
    }
  }

  const titles = await hydrateTitles(ctx, best)
  return [...best.entries()]
    .map(([key, hit]) => ({ ...hit, title: titles.get(key) ?? '' }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function hybridSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider,
  args: SearchArgs,
  limit: number,
): Promise<SearchHit[]> {
  const [fts, sem] = await Promise.all([ftsSearch(ctx, args, limit), semanticSearch(ctx, embedder, args, limit)])
  const merged = new Map<string, SearchHit>()
  for (const hit of [...fts, ...sem]) {
    const key = `${hit.collection}:${hit.id}`
    const current = merged.get(key)
    if (!current) merged.set(key, hit)
    else merged.set(key, { ...current, snippet: hit.snippet || current.snippet, score: current.score + hit.score })
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function runSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider | undefined,
  args: SearchArgs,
): Promise<SearchHit[]> {
  const limit = clamp(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
  const mode = args.mode ?? 'fts'
  if (mode === 'fts') return ftsSearch(ctx, args, limit)
  if (!embedder) throw new Error(`domain.search: mode '${mode}' requires opts.embedder`)
  if (mode === 'semantic') return semanticSearch(ctx, embedder, args, limit)
  return hybridSearch(ctx, embedder, args, limit)
}
