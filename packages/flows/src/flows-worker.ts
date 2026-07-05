import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationProvider } from '@movp/notifications'
import { escapeHtml } from '@movp/notifications'
import { claimDueJobs, completeJob } from './jobs.ts'
import { runAutomationWorker } from './automation.ts'

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function buildWebhookRequest(
  payload: Record<string, unknown>,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const url = stringField(payload.url)
  if (!url) throw new Error('webhook_missing_url')
  const secret = stringField(payload.secret)
  const sent: Record<string, unknown> = { ...payload }
  delete sent.secret
  const body = JSON.stringify(sent)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) headers['x-movp-signature'] = `sha256=${await hmacHex(secret, body)}`
  return { url, headers, body }
}

async function emailForUser(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) return null
  const email = data.user?.email
  return typeof email === 'string' && email.length > 0 ? email : null
}

export async function runFlowsWorker(
  db: SupabaseClient,
  notifier: NotificationProvider,
  limit = 10,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0

  for (const job of await claimDueJobs(db, 'notify', limit)) {
    try {
      const payload = job.payload
      const event = stringField(payload.event) ?? 'event'
      const title = escapeHtml(stringField(payload.title) ?? event)
      const recipientUserId = stringField(payload.recipient_user_id)
      let to: string | null
      if (recipientUserId) {
        to = await emailForUser(db, recipientUserId)
        if (!to) throw new Error('notify_recipient_no_email')
      } else {
        to = stringField(payload.email)
        if (!to) throw new Error('notify_missing_email')
      }
      await notifier.send({ to, subject: `MOVP ${event}`, html: `<p>${title}</p>` })
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }

  const automate = await runAutomationWorker(db, limit)
  processed += automate.processed
  failed += automate.failed

  for (const job of await claimDueJobs(db, 'webhook', limit)) {
    try {
      const { url, headers, body } = await buildWebhookRequest(job.payload as Record<string, unknown>)
      const res = await fetch(url, { method: 'POST', headers, body })
      if (!res.ok) throw new Error(`webhook:${res.status}`)
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }

  return { processed, failed }
}
