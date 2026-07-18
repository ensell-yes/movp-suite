import type { EmbeddingProvider } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { runEmbedWorker } from '../src/embed-worker.ts'

interface EmbedJobPayload {
  source_table: string
  source_id: string
  field: string
  content_hash: string
}

function embedJob(id: string, payload: EmbedJobPayload) {
  return {
    id,
    kind: 'embed',
    idempotency_key: `${payload.source_table}:${payload.source_id}:${payload.field}:${payload.content_hash}`,
    payload,
    attempts: 1,
    max_attempts: 8,
    status: 'running',
    workspace_id: 'workspace-1',
  }
}

function fakeDb(jobs: ReturnType<typeof embedJob>[]) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const maybeSingle = vi.fn(async () => ({ data: { body: 'Task body to embed' }, error: null }))
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'claim_jobs') return { data: jobs, error: null }
      return { data: null, error: null }
    }),
    from,
  }
  return { db: db as unknown as SupabaseClient, rpcCalls, from }
}

const embedder: EmbeddingProvider = {
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}

describe('runEmbedWorker allow-list', () => {
  it('processes task revision body jobs', async () => {
    const payload = {
      source_table: 'task_revision',
      source_id: 'revision-1',
      field: 'body',
      content_hash: 'hash-1',
    }
    const { db, rpcCalls, from } = fakeDb([embedJob('job-1', payload)])

    await expect(runEmbedWorker(db, embedder)).resolves.toEqual({ processed: 1, failed: 0 })
    expect(from).toHaveBeenCalledWith('task_revision')
    expect(rpcCalls).toContainEqual(expect.objectContaining({
      fn: 'replace_search_chunks',
      args: expect.objectContaining({
        src_table: 'task_revision',
        src_id: 'revision-1',
        src_field: 'body',
        hash: 'hash-1',
      }),
    }))
    expect(rpcCalls).toContainEqual({
      fn: 'complete_job',
      args: { job_id: 'job-1', ok: true, err_code: null },
    })
    expect(rpcCalls.some(({ fn }) => fn === 'dead_job')).toBe(false)
  })

  it('dead-letters unknown source tables as terminal failures', async () => {
    const payload = {
      source_table: 'reaction',
      source_id: 'reaction-1',
      field: 'body',
      content_hash: 'hash-2',
    }
    const { db, rpcCalls, from } = fakeDb([embedJob('job-2', payload)])

    await expect(runEmbedWorker(db, embedder)).resolves.toEqual({ processed: 0, failed: 1 })
    expect(from).not.toHaveBeenCalled()
    expect(rpcCalls).toContainEqual({
      fn: 'dead_job',
      args: { job_id: 'job-2', err_code: 'embed_payload_not_allowed' },
    })
    expect(rpcCalls.some(({ fn }) => fn === 'complete_job')).toBe(false)
  })
})
