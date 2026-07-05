import { describe, expect, it } from 'vitest'
import { drainSegmentRecompute } from '../src/segment-recompute.ts'

// Mock the RPC seam (mirrors jobs.test.ts). recompute_segment's real correctness is proven by
// segmentation_recompute_test.sql (pgTAP, 28/28); THIS test pins the worker's claim/try/complete
// loop and — load-bearing — the F4 contract: supabase-js resolves a Postgres `raise` as {error}
// (it does NOT throw), so a failed recompute must complete the job FALSE (retryable/DLQ), never `done`.
type RpcResult = { data: unknown; error: { code: string } | null }
function mockDb(handler: (fn: string, args: unknown) => RpcResult) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      return Promise.resolve(handler(fn, args))
    },
  }
}
const job = (segment_id: string) => ({
  id: `j-${segment_id}`, kind: 'segment_recompute', idempotency_key: 'k',
  payload: { segment_id, mode: 'incremental' }, attempts: 0, max_attempts: 3,
  status: 'running', workspace_id: 'w',
})

describe('drainSegmentRecompute', () => {
  it('claims a job, calls recompute_segment, completes it done (happy path)', async () => {
    const db = mockDb((fn) =>
      fn === 'claim_jobs' ? { data: [job('seg-1')], error: null } : { data: 'run-1', error: null })
    const r = await drainSegmentRecompute(db as never, 20)
    expect(r).toEqual({ processed: 1, failed: 0 })
    expect(db.calls.find((c) => c.fn === 'recompute_segment')?.args)
      .toMatchObject({ seg_id: 'seg-1', mode: 'incremental', trace: null })
    expect(db.calls.find((c) => c.fn === 'complete_job')?.args).toMatchObject({ ok: true })
  })

  it('F4: a raised recompute resolves as {error} -> completes the job FALSE (retryable), never silent done', async () => {
    const db = mockDb((fn) => {
      if (fn === 'claim_jobs') return { data: [job('missing')], error: null }
      if (fn === 'recompute_segment') return { data: null, error: { code: 'no_data_found' } }
      return { data: null, error: null }
    })
    const r = await drainSegmentRecompute(db as never, 20)
    expect(r).toEqual({ processed: 0, failed: 1 })
    // The regression guard: a raised RPC must complete FALSE (re-enters Core retry/DLQ), NOT done.
    const complete = db.calls.find((c) => c.fn === 'complete_job')
    expect(complete?.args).toMatchObject({ ok: false, err_code: 'no_data_found' })
  })
})
