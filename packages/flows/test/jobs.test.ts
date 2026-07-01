import { describe, expect, it } from 'vitest'
import { claimDueJobs, completeJob, deadJob, enqueueJob, replayJobs, reindexCollection } from '../src/index.ts'

function rpcDb() {
  const calls: Array<{ fn: string; args: unknown }> = []
  return {
    calls,
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args })
      if (fn === 'claim_jobs') return Promise.resolve({ data: [], error: null })
      if (fn === 'replay_jobs' || fn === 'reindex_collection') return Promise.resolve({ data: 1, error: null })
      return Promise.resolve({ data: null, error: null })
    },
  }
}

describe('job rpc helpers', () => {
  it('call the public RPC seam', async () => {
    const db = rpcDb()
    await enqueueJob(db as any, { kind: 'webhook', idempotencyKey: 'k', payload: { x: 1 }, workspaceId: 'w' })
    await claimDueJobs(db as any, 'webhook', 10)
    await completeJob(db as any, 'j', true)
    await deadJob(db as any, 'j', 'bad')
    expect(await replayJobs(db as any, { kind: 'webhook', dead: true })).toBe(1)
    expect(await reindexCollection(db as any, 'note')).toBe(1)
    expect(db.calls.map((c) => c.fn)).toEqual([
      'enqueue_job',
      'claim_jobs',
      'complete_job',
      'dead_job',
      'replay_jobs',
      'reindex_collection',
    ])
  })
})
