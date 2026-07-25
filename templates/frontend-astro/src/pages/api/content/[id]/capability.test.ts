import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  token: 'owner-token' as string | null,
  gql: vi.fn(),
  env: vi.fn(() => ({
    graphqlEndpoint: 'http://mock/graphql',
    workspaceId: 'workspace',
    publicSiteUrl: 'http://site',
    supabaseUrl: 'http://mock',
    supabaseAnonKey: 'anon',
  })),
}))

vi.mock('../../../../lib/env.ts', () => ({ readServerEnv: () => h.env() }))
vi.mock('../../../../lib/session.ts', () => ({ getSessionToken: () => h.token }))
vi.mock('../../../../lib/graphql.ts', () => ({ gqlRequest: h.gql }))

import { GET } from './capability.ts'

const ITEM = 'd1000000-0000-4000-8000-000000000001'

const call = () => GET({
  params: { id: ITEM },
  cookies: {},
  request: new Request(`http://site/api/content/${ITEM}/capability`),
} as unknown as Parameters<typeof GET>[0])

afterEach(() => {
  vi.restoreAllMocks()
  h.token = 'owner-token'
  h.gql.mockReset()
  h.env.mockClear()
})

describe('content edit capability route', () => {
  it('returns an exact false contract without a session and never calls upstream', async () => {
    h.token = null
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ canEdit: false })
    expect(h.gql).not.toHaveBeenCalled()
  })

  it.each([false, true])('returns caller-bound capability %s', async (canEdit) => {
    h.gql.mockResolvedValueOnce({ ok: true, data: { contentCanEdit: canEdit } })
    const response = await call()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ canEdit })
    expect(h.gql).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://mock/graphql', token: 'owner-token' }),
      expect.stringContaining('query ContentCanEdit'),
      { itemId: ITEM },
    )
  })

  it('fails an invalid session closed without an operational event', async () => {
    h.gql.mockResolvedValueOnce({ ok: false, code: 'auth_error' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await (await call()).json()).toEqual({ canEdit: false })
    expect(log).not.toHaveBeenCalled()
  })

  it('fails an upstream error closed and emits one content-disciplined event', async () => {
    h.gql.mockResolvedValueOnce({ ok: false, code: 'network_error', message: 'private host' })
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)))
    const response = await call()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ canEdit: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('content.overlay_capability')
    expect(lines[0]).not.toContain('private host')
    expect(lines[0]).not.toContain('owner-token')
  })
})
