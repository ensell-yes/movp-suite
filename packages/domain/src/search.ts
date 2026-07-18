import type { DomainCtx, EmbeddingProvider, SearchArgs, SearchHit } from './types.ts'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const COLLECTIONS = ['note', 'tag', 'content_item'] as const
const FTS_COLLECTIONS = new Set<string>(COLLECTIONS)
const SEMANTIC_TITLE_COLUMNS = {
  note: 'title',
  content_item: 'search_text',
  campaign: 'name',
} as const

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
  if (args.collection && !FTS_COLLECTIONS.has(args.collection)) {
    throw new Error(`domain.search.fts unsupported collection '${args.collection}'`)
  }
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

function isDirectSemanticSource(sourceTable: string): sourceTable is keyof typeof SEMANTIC_TITLE_COLUMNS {
  return Object.prototype.hasOwnProperty.call(SEMANTIC_TITLE_COLUMNS, sourceTable)
}

function semanticSourceFilter(collection: string | undefined): string | null {
  if (collection === 'task') return 'task_revision'
  return collection ?? null
}

async function hydrateDirectSemanticHits(
  ctx: DomainCtx,
  hits: Map<string, { sourceTable: string; id: string; snippet: string; score: number }>,
): Promise<SearchHit[]> {
  const bySource = new Map<keyof typeof SEMANTIC_TITLE_COLUMNS, string[]>()
  for (const hit of hits.values()) {
    if (hit.sourceTable === 'task_revision') continue
    if (!isDirectSemanticSource(hit.sourceTable)) {
      throw new Error(`domain.search.semantic unsupported source table '${hit.sourceTable}'`)
    }
    bySource.set(hit.sourceTable, [...(bySource.get(hit.sourceTable) ?? []), hit.id])
  }

  const hydrated: SearchHit[] = []
  await Promise.all(
    [...bySource.entries()].map(async ([sourceTable, ids]) => {
      const titleColumn = SEMANTIC_TITLE_COLUMNS[sourceTable]
      const { data, error } = await ctx.db.from(sourceTable).select(`id, ${titleColumn}`).in('id', ids)
      if (error) throw new Error(`domain.search.hydrate failed [${error.code ?? 'unknown'}]`)
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const id = String(row.id)
        const hit = hits.get(`${sourceTable}:${id}`)
        if (!hit) continue
        hydrated.push({
          collection: sourceTable,
          id,
          title: String(row[titleColumn] ?? ''),
          snippet: hit.snippet,
          score: hit.score,
        })
      }
    }),
  )
  return hydrated
}

async function hydrateTaskSemanticHits(
  ctx: DomainCtx,
  hits: Map<string, { sourceTable: string; id: string; snippet: string; score: number }>,
): Promise<SearchHit[]> {
  const revisionIds = [...hits.values()]
    .filter((hit) => hit.sourceTable === 'task_revision')
    .map((hit) => hit.id)
  if (revisionIds.length === 0) return []

  const { data: revisionData, error: revisionError } = await ctx.db
    .from('task_revision')
    .select('id, task_id')
    .in('id', revisionIds)
  if (revisionError) throw new Error(`domain.search.hydrate failed [${revisionError.code ?? 'unknown'}]`)
  const revisions = (revisionData ?? []) as Array<Record<string, unknown>>
  const taskIds = [...new Set(revisions.map((row) => String(row.task_id)))]
  if (taskIds.length === 0) return []

  const { data: taskData, error: taskError } = await ctx.db
    .from('task')
    .select('id, title, current_revision_id')
    .in('id', taskIds)
  if (taskError) throw new Error(`domain.search.hydrate failed [${taskError.code ?? 'unknown'}]`)
  const currentRevisionByTask = new Map(
    ((taskData ?? []) as Array<Record<string, unknown>>).map((row) => [
      String(row.id),
      { revisionId: String(row.current_revision_id), title: String(row.title ?? '') },
    ]),
  )

  const hydrated: SearchHit[] = []
  for (const revision of revisions) {
    const revisionId = String(revision.id)
    const taskId = String(revision.task_id)
    const task = currentRevisionByTask.get(taskId)
    if (!task || task.revisionId !== revisionId) continue
    const hit = hits.get(`task_revision:${revisionId}`)
    if (!hit) continue
    hydrated.push({ collection: 'task', id: taskId, title: task.title, snippet: hit.snippet, score: hit.score })
  }
  return hydrated
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
    source_table_filter: semanticSourceFilter(args.collection),
    match_count: limit,
  })
  if (error) throw new Error(`domain.search.semantic failed [${error.code ?? 'unknown'}]`)

  const best = new Map<string, { sourceTable: string; id: string; snippet: string; score: number }>()
  for (const chunk of (data ?? []) as ChunkRow[]) {
    const key = `${chunk.source_table}:${chunk.source_id}`
    const score = 1 - Number(chunk.distance)
    const current = best.get(key)
    if (!current || score > current.score) {
      best.set(key, { sourceTable: chunk.source_table, id: chunk.source_id, snippet: chunk.content, score })
    }
  }

  const [directHits, taskHits] = await Promise.all([
    hydrateDirectSemanticHits(ctx, best),
    hydrateTaskSemanticHits(ctx, best),
  ])
  return [...directHits, ...taskHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

async function hybridSearch(
  ctx: DomainCtx,
  embedder: EmbeddingProvider,
  args: SearchArgs,
  limit: number,
): Promise<SearchHit[]> {
  const ftsPromise = !args.collection || FTS_COLLECTIONS.has(args.collection)
    ? ftsSearch(ctx, args, limit)
    : Promise.resolve([])
  const [fts, sem] = await Promise.all([ftsPromise, semanticSearch(ctx, embedder, args, limit)])
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
