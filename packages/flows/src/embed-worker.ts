import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmbeddingProvider } from '@movp/domain'
import { chunkText } from '@movp/search'
import { claimDueJobs, completeJob, deadJob, replaceSearchChunks } from './jobs.ts'

interface EmbedPayload {
  source_table: string
  source_id: string
  field: string
  content_hash: string
}

class PermanentEmbedJobError extends Error {}

const EMBEDDABLE_FIELDS: Record<string, readonly string[]> = {
  note: ['body'],
}

function assertEmbeddablePayload(p: EmbedPayload): void {
  if (!EMBEDDABLE_FIELDS[p.source_table]?.includes(p.field)) {
    throw new PermanentEmbedJobError('embed_payload_not_allowed')
  }
}

export async function runEmbedWorker(
  db: SupabaseClient,
  embedder: EmbeddingProvider,
  limit = 10,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const job of await claimDueJobs(db, 'embed', limit)) {
    try {
      const p = job.payload as unknown as EmbedPayload
      assertEmbeddablePayload(p)
      const { data: row, error: readErr } = await db.from(p.source_table).select(p.field).eq('id', p.source_id).maybeSingle()
      if (readErr) throw new Error(`read:${readErr.code ?? 'err'}`)
      const text = ((row as Record<string, unknown> | null)?.[p.field] as string | null) ?? ''
      const chunks = chunkText(text)
      const rows: { chunk_index: number; content: string; embedding: string }[] = []
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embedder.embed(chunks[i]!)
        rows.push({ chunk_index: i, content: chunks[i]!, embedding: JSON.stringify(vec) })
      }
      await replaceSearchChunks(db, {
        sourceTable: p.source_table,
        sourceId: p.source_id,
        field: p.field,
        workspaceId: job.workspace_id!,
        contentHash: p.content_hash,
        chunks: rows,
      })
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      if (e instanceof PermanentEmbedJobError) {
        await deadJob(db, job.id, e.message)
      } else {
        await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      }
      failed++
    }
  }
  return { processed, failed }
}
