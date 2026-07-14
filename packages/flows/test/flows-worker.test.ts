import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationProvider } from '@movp/notifications'
import { schema } from '@movp/core-schema'
import { runFlowsWorker } from '../src/flows-worker.ts'

function fakeDb(notifyJobs: Array<Record<string, unknown>>) {
  const getUserById = vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@example.test` } }, error: null }))
  const completed: Array<Record<string, unknown>> = []
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'claim_jobs') return { data: args.job_kind === 'notify' ? notifyJobs : [], error: null }
      if (fn === 'complete_job') {
        completed.push(args)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }),
    auth: { admin: { getUserById } },
  }
  return { db: db as unknown as SupabaseClient, completed, getUserById }
}

function fakeNotifier() {
  const sent: Array<{ to: string; subject: string; html: string }> = []
  const notifier: NotificationProvider = {
    send: vi.fn(async (m) => {
      sent.push({ to: m.to, subject: m.subject, html: m.html })
      return { id: 'e1' }
    }),
  }
  return { notifier, sent }
}

const baseJob = { kind: 'notify', attempts: 1, max_attempts: 8, status: 'running', workspace_id: 'w' }

describe('runFlowsWorker notify recipient resolution', () => {
  it('resolves recipient_user_id -> email for a user.mentioned job', async () => {
    const { db, completed, getUserById } = fakeDb([
      {
        ...baseJob,
        id: 'j1',
        idempotency_key: 'user.mentioned:c1',
        payload: { event: 'user.mentioned', recipient_user_id: 'u2', title: 'You were mentioned' },
      },
    ])
    const { notifier, sent } = fakeNotifier()
    const res = await runFlowsWorker(db, notifier, 10, { schema })
    expect(getUserById).toHaveBeenCalledWith('u2')
    expect(getUserById).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('u2@example.test')
    expect(res.processed).toBe(1)
    expect(completed[0]).toMatchObject({ ok: true })
  })

  it('still sends to payload.email for a note.created job', async () => {
    const { db } = fakeDb([
      {
        ...baseJob,
        id: 'j2',
        idempotency_key: 'note.created:n1',
        payload: { event: 'note.created', email: 'owner@example.test', title: 'Hi' },
      },
    ])
    const { notifier, sent } = fakeNotifier()
    await runFlowsWorker(db, notifier, 10, { schema })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('owner@example.test')
  })
})
