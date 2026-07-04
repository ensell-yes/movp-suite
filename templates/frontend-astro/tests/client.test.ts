import { describe, expect, it } from 'vitest'
import { gqlRequest, NOTES_QUERY } from '../src/lib/graphql.ts'

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('gqlRequest', () => {
  it('sends the Bearer token and POSTs the query, returning data', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ data: { notes: { items: [], nextCursor: null } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const r = await gqlRequest(
      { endpoint: 'https://x/functions/v1/graphql', token: 'jwt-abc', fetchImpl },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r.ok).toBe(true)
    expect(seen?.init.method).toBe('POST')
    expect((seen?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-abc')
    expect((seen?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(seen?.init.body as string).variables).toEqual({ workspaceId: 'w', first: 20 })
  })

  it('maps a non-2xx response to an error result', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(500, {}) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'http_error' })
  })

  it('maps a GraphQL errors array to an error result', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(200, { errors: [{ message: 'nope' }] }) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'graphql_error', message: 'nope' })
  })

  it('maps a 401 or 403 to auth_error', async () => {
    const r = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(401, {}) },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({ ok: false, code: 'auth_error' })
  })
})
