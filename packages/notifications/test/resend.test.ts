import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResendAdapter, escapeHtml } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe('escapeHtml', () => {
  it('escapes html-sensitive characters', () => {
    expect(escapeHtml(`<b x="1">'&</b>`)).toBe('&lt;b x=&quot;1&quot;&gt;&#39;&amp;&lt;/b&gt;')
  })
})

describe('ResendAdapter', () => {
  it('POSTs to Resend and returns the id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const r = await new ResendAdapter('re_test_key').send({
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
    })
    expect(r.id).toBe('email_1')
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }))
  })

  it('throws a bounded error on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(new ResendAdapter('k').send({ to: 'a@example.com', subject: 's', html: 'h' })).rejects.toThrow(
      'resend_send_failed:500',
    )
  })

  it('requires an API key', () => {
    expect(() => new ResendAdapter('')).toThrow('resend_missing_api_key')
  })
})
