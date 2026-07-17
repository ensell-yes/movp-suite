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

  it('preserves partial data and field errors only when explicitly enabled', async () => {
    const response = {
      data: { healthy: [{ count: 2 }], failed: null },
      errors: [{
        message: 'Could not load this report.',
        path: ['failed'],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      }],
    }
    const strict = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(200, response) },
      'query Partial { healthy failed }',
      {},
    )
    expect(strict).toEqual({
      ok: false,
      code: 'graphql_error',
      message: 'Could not load this report.',
      errorCode: 'INTERNAL_SERVER_ERROR',
    })

    const partial = await gqlRequest(
      { endpoint: 'https://x', token: 't', fetchImpl: mockFetch(200, response) },
      'query Partial { healthy failed }',
      {},
      { allowPartial: true },
    )
    expect(partial).toEqual({
      ok: true,
      data: response.data,
      errors: [{
        message: 'Could not load this report.',
        path: ['failed'],
        code: 'INTERNAL_SERVER_ERROR',
      }],
    })
  })

  it('maps admin GraphQL error extensions to friendly copy', async () => {
    const r = await gqlRequest(
      {
        endpoint: 'https://x',
        token: 't',
        fetchImpl: mockFetch(200, {
          errors: [{
            message: 'domain.admin.setMemberRole failed [P0001]: last_owner_guard',
            extensions: { code: 'CONFLICT', pgCode: 'P0001', reason: 'last_owner_guard' },
          }],
        }),
      },
      NOTES_QUERY,
      { workspaceId: 'w', first: 20 },
    )
    expect(r).toEqual({
      ok: false,
      code: 'graphql_error',
      message: 'At least one workspace owner must remain.',
      errorCode: 'CONFLICT',
    })
  })

  it('maps PAT reason codes to member-facing copy (reason wins over generic code)', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['42501', 'FORBIDDEN', 'not_workspace_member', "You're not a member of this workspace."],
      ['22023', 'BAD_USER_INPUT', 'pat_name_required', 'Enter a name for the access token.'],
      ['P0001', 'NOT_FOUND', 'pat_not_found', 'That access token could not be found or is already revoked.'],
    ]
    for (const [pgCode, code, reason, copy] of cases) {
      const r = await gqlRequest(
        {
          endpoint: 'https://x',
          token: 't',
          fetchImpl: mockFetch(200, {
            errors: [{ message: `domain.pat failed [${pgCode}]: ${reason}`, extensions: { code, pgCode, reason } }],
          }),
        },
        NOTES_QUERY,
        { workspaceId: 'w', first: 20 },
      )
      expect(r).toEqual({ ok: false, code: 'graphql_error', message: copy, errorCode: code })
    }
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
