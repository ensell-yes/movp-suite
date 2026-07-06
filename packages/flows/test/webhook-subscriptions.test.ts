import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationProvider } from '@movp/notifications'
import type { Job } from '../src/jobs.ts'
import { runFlowsWorker } from '../src/flows-worker.ts'

const baseWebhookJob: Job = {
  id: 'job-webhook-1',
  kind: 'webhook',
  idempotency_key: 'task.completed:t1:webhook-1',
  payload: {
    id: 'task-1',
    event: 'task.completed',
    url: 'https://hooks.example.test/workflows',
    secret: 'super-secret',
  },
  attempts: 1,
  max_attempts: 8,
  status: 'running',
  workspace_id: '11111111-1111-1111-1111-111111111111',
}

function fakeNotifier(): NotificationProvider {
  return {
    send: vi.fn(async () => ({ id: 'email-1' })),
  }
}

function fakeDb(opts: { webhookJobs: Job[]; subscription: unknown; subscriptionError?: { code?: string } }) {
  const completed: Array<Record<string, unknown>> = []
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'claim_jobs') {
        return { data: args.job_kind === 'webhook' ? opts.webhookJobs : [], error: null }
      }
      if (fn === 'complete_job') {
        completed.push(args)
        return { data: null, error: null }
      }
      if (fn === 'webhook_subscription_for_delivery') {
        return opts.subscriptionError
          ? { data: null, error: opts.subscriptionError }
          : { data: opts.subscription, error: null }
      }
      return { data: null, error: null }
    }),
    auth: { admin: { getUserById: vi.fn() } },
  }
  return { db: db as unknown as SupabaseClient, completed }
}

describe('runFlowsWorker webhook subscription filters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers unmanaged Core webhooks when no subscription lookup row exists', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({ webhookJobs: [baseWebhookJob], subscription: null })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(completed).toContainEqual(expect.objectContaining({ job_id: 'job-webhook-1', ok: true }))
    expect(result).toEqual({ processed: 1, failed: 0 })
  })

  it('delivers managed webhooks when the subscription filter matches', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({
      webhookJobs: [baseWebhookJob],
      subscription: { status: 'deliver', filter: { field: 'event', op: 'eq', value: 'task.completed' } },
    })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = fetch.mock.calls[0]
    expect((init?.headers as Record<string, string>)['x-movp-signature']).toMatch(/^sha256=/)
    expect(init?.body).not.toContain('super-secret')
    expect(completed).toContainEqual(expect.objectContaining({ job_id: 'job-webhook-1', ok: true }))
    expect(result).toEqual({ processed: 1, failed: 0 })
  })

  it('delivers managed webhooks with no filter', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({
      webhookJobs: [baseWebhookJob],
      subscription: { status: 'deliver', filter: null },
    })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(completed).toContainEqual(expect.objectContaining({ job_id: 'job-webhook-1', ok: true }))
    expect(result).toEqual({ processed: 1, failed: 0 })
  })

  it('completes unmatched subscription filters without fetching or retrying', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({
      webhookJobs: [baseWebhookJob],
      subscription: { status: 'deliver', filter: { field: 'event', op: 'eq', value: 'content.published' } },
    })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).not.toHaveBeenCalled()
    expect(completed).toContainEqual(expect.objectContaining({ job_id: 'job-webhook-1', ok: true }))
    expect(result).toEqual({ processed: 1, failed: 0 })
  })

  it('completes stale or deactivated managed webhook jobs without fetching', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({
      webhookJobs: [baseWebhookJob],
      subscription: { status: 'skip' },
    })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).not.toHaveBeenCalled()
    expect(completed).toContainEqual(expect.objectContaining({ job_id: 'job-webhook-1', ok: true }))
    expect(result).toEqual({ processed: 1, failed: 0 })
  })

  it('fails corrupt subscription filters with a bounded condition code', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    const { db, completed } = fakeDb({
      webhookJobs: [baseWebhookJob],
      subscription: { status: 'deliver', filter: 'not-a-filter-object' },
    })

    const result = await runFlowsWorker(db, fakeNotifier(), 10)

    expect(fetch).not.toHaveBeenCalled()
    expect(completed).toContainEqual(expect.objectContaining({
      job_id: 'job-webhook-1',
      ok: false,
      err_code: 'condition_invalid',
    }))
    expect(JSON.stringify(completed)).not.toContain('task-1')
    expect(result).toEqual({ processed: 0, failed: 1 })
  })
})
