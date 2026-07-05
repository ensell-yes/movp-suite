import type { SupabaseClient } from '@supabase/supabase-js' // MATCH jobs.ts's client type import
import { claimDueJobs, completeJob } from './jobs.ts'

interface RecomputePayload { segment_id: string; mode: string; trace_id?: string | null }

// Mirror flows-worker.ts's claim -> try -> complete loop. No `any`: payload is narrowed via a cast
// from the jobs.ts Job payload type (jsonb) to RecomputePayload.
export async function drainSegmentRecompute(
  db: SupabaseClient,
  limit = 20,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const job of await claimDueJobs(db, 'segment_recompute', limit)) {
    const p = job.payload as unknown as RecomputePayload
    try {
      // F4: supabase-js RESOLVES { data, error } — it does NOT throw on a Postgres `raise`. Check {error}
      // explicitly (mirrors packages/flows/src/jobs.ts's `if (error) throw` idiom) BEFORE completing the
      // job, or a failed RPC (e.g. a missing segment) would complete as `done` and never retry.
      const { error } = await db.rpc('recompute_segment', {
        seg_id: p.segment_id, mode: p.mode, trace: p.trace_id ?? null,
      })
      if (error) throw new Error(error.code ?? 'recompute_failed')
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }
  return { processed, failed }
}
