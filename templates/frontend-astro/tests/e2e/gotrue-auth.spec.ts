import { expect, test } from '@playwright/test'

const MAILPIT_URL = process.env.MAILPIT_URL
const LOGIN_EMAIL = 'demo-owner@example.test'

if (!MAILPIT_URL) {
  throw new Error('missing_env: MAILPIT_URL')
}

type MailpitMessageSummary = {
  ID?: string
  id?: string
  To?: Array<{ Address?: string; Mailbox?: string; Domain?: string }>
  Subject?: string
  Created?: string
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`mailpit_request_failed:${res.status}:${url}`)
  return (await res.json()) as T
}

async function clearMessages(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined)
}

function recipientMatches(message: MailpitMessageSummary): boolean {
  return (message.To ?? []).some((to) => {
    const address = to.Address ?? (to.Mailbox && to.Domain ? `${to.Mailbox}@${to.Domain}` : '')
    return address.toLowerCase() === LOGIN_EMAIL
  })
}

async function waitForMagicLink(): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const listing = await readJson<{ messages?: MailpitMessageSummary[] }>(`${MAILPIT_URL}/api/v1/messages`)
    const message = (listing.messages ?? []).find((candidate) => recipientMatches(candidate))
    const id = message?.ID ?? message?.id
    if (id) {
      const detail = await readJson<Record<string, unknown>>(`${MAILPIT_URL}/api/v1/message/${id}`)
      const body = JSON.stringify(detail)
        .replaceAll('\\u0026', '&')
        .replaceAll('&amp;', '&')
      const match = body.match(/https?:\/\/[^"'<>\s]+\/auth\/callback\?token_hash=[^"'<>\s]+&type=email/)
      if (match) return match[0]
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('magic_link_email_not_received')
}

test('real GoTrue magic-link email feeds the server callback', async ({ page, context }) => {
  await clearMessages()

  await page.goto('/login')
  await page.getByLabel('Email').fill(LOGIN_EMAIL)
  await page.getByRole('button', { name: 'Send magic link' }).click()
  await expect(page.getByTestId('login-sent')).toContainText('Check your email')

  const link = await waitForMagicLink()
  expect(new URL(link).pathname).toBe('/auth/callback')

  await page.goto(link)
  await page.waitForURL('/')
  const cookie = (await context.cookies()).find((candidate) => candidate.name === 'sb-access-token')
  expect(cookie?.value).toBeTruthy()
  expect(cookie?.httpOnly).toBe(true)
})

test('real GoTrue callback rejects an invalid token_hash', async ({ page, context }) => {
  await page.goto('/auth/callback?token_hash=invalid-token-hash&type=email')
  await page.waitForURL('/login?error=invalid_token')
  expect((await context.cookies()).find((candidate) => candidate.name === 'sb-access-token')).toBeUndefined()
  await expect(page.getByTestId('login-error')).toBeVisible()
})
