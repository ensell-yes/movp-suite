import type { SupabaseClient } from '@supabase/supabase-js'

export interface Job {
  id: string
  kind: string
  idempotency_key: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  status: string
  workspace_id: string | null
}

export async function enqueueJob(
  db: SupabaseClient,
  job: { kind: 'embed' | 'webhook' | 'notify' | 'automate' | 'segment_recompute'; idempotencyKey: string; payload: Record<string, unknown>; workspaceId?: string },
): Promise<void> {
  const { error } = await db.rpc('enqueue_job', {
    job_kind: job.kind,
    idem_key: job.idempotencyKey,
    payload: job.payload,
    ws: job.workspaceId ?? null,
  })
  if (error) throw new Error(`enqueue_job_failed:${error.code ?? 'unknown'}`)
}

export async function claimDueJobs(db: SupabaseClient, kind: string, limit: number): Promise<Job[]> {
  const { data, error } = await db.rpc('claim_jobs', { job_kind: kind, lim: limit })
  if (error) throw new Error(`claim_jobs_failed:${error.code ?? 'unknown'}`)
  return Array.isArray(data) ? (data as Job[]) : []
}

export async function completeJob(db: SupabaseClient, id: string, ok: boolean, errCode?: string): Promise<void> {
  const { error } = await db.rpc('complete_job', { job_id: id, ok, err_code: errCode ?? null })
  if (error) throw new Error(`complete_job_failed:${error.code ?? 'unknown'}`)
}

export async function deadJob(db: SupabaseClient, id: string, errCode: string): Promise<void> {
  const { error } = await db.rpc('dead_job', { job_id: id, err_code: errCode })
  if (error) throw new Error(`dead_job_failed:${error.code ?? 'unknown'}`)
}

export async function replayJobs(db: SupabaseClient, opts: { kind?: string; dead?: boolean }): Promise<number> {
  const { data, error } = await db.rpc('replay_jobs', { job_kind: opts.kind ?? null, only_dead: !!opts.dead })
  if (error) throw new Error(`replay_jobs_failed:${error.code ?? 'unknown'}`)
  return (data ?? 0) as number
}

export async function reindexCollection(db: SupabaseClient, collection: string): Promise<number> {
  const { data, error } = await db.rpc('reindex_collection', { coll: collection })
  if (error) throw new Error(`reindex_failed:${error.code ?? 'unknown'}`)
  return (data ?? 0) as number
}

export async function replaceSearchChunks(
  db: SupabaseClient,
  args: {
    sourceTable: string
    sourceId: string
    field: string
    workspaceId: string
    contentHash: string
    chunks: { chunk_index: number; content: string; embedding: string }[]
  },
): Promise<void> {
  const { error } = await db.rpc('replace_search_chunks', {
    src_table: args.sourceTable,
    src_id: args.sourceId,
    src_field: args.field,
    ws: args.workspaceId,
    hash: args.contentHash,
    chunks: args.chunks,
  })
  if (error) throw new Error(`replace_chunks_failed:${error.code ?? 'unknown'}`)
}
