import { describe, expect, it } from 'vitest'
import { buildWebhookRequest } from '../src/flows-worker.ts'

async function verify(secret: string, body: string, sigHex: string): Promise<boolean> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const sig = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(body))
}

describe('webhook HMAC signing', () => {
  it('signs the sent body and strips the secret', async () => {
    const { headers, body } = await buildWebhookRequest({
      url: 'https://example.test/hook',
      event: 'content.published',
      id: '00000003-0000-0000-0000-000000000000',
      secret: 's3cr3t',
    })
    expect(JSON.parse(body).secret).toBeUndefined()
    expect(body).not.toContain('s3cr3t')
    expect(headers['x-movp-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    const sigHex = headers['x-movp-signature'].slice('sha256='.length)
    expect(await verify('s3cr3t', body, sigHex)).toBe(true)
  })

  it('omits the signature header when no secret is present', async () => {
    const { headers, body } = await buildWebhookRequest({ url: 'https://example.test/hook', id: 'x' })
    expect(headers['x-movp-signature']).toBeUndefined()
    expect(JSON.parse(body).secret).toBeUndefined()
  })
})
