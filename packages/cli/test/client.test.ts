import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliCtx } from '../src/client.ts'
import { fileStore } from '../src/secure-store.ts'

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.sig`
}
const nowSec = () => Math.floor(Date.now() / 1000)

let dir: string
let base: Record<string, string | undefined>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'movp-ctx-'))
  base = {
    SUPABASE_URL: 'http://api',
    SUPABASE_ANON_KEY: 'anon',
    MOVP_SECURE_STORE: 'file',
    MOVP_CONFIG: join(dir, 'config.json'),
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCliCtx precedence', () => {
  it('MOVP_ACCESS_TOKEN takes precedence and is unchanged (no exchange)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const jwt = makeJwt('user-access')
    const ctx = await resolveCliCtx({ ...base, MOVP_ACCESS_TOKEN: jwt })
    expect(ctx.accessToken).toBe(jwt)
    expect(ctx.userId).toBe('user-access')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('MOVP_PAT env is exchanged into a session access_token', async () => {
    const minted = makeJwt('user-pat')
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: minted, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'user-pat' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.accessToken).toBe(minted)
    expect(ctx.userId).toBe('user-pat')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/functions/v1/auth-exchange')
  })

  it('re-exchanges a PAT even when the cached session is not expired', async () => {
    fileStore('http://api', base).save({ pat: 'movp_pat_abc', session: { access_token: makeJwt('cached'), expires_at: nowSec() + 3600 } })
    const fresh = makeJwt('fresh')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fresh, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'fresh' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.userId).toBe('fresh')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-exchanges a stored PAT even when its cached session is not expired', async () => {
    fileStore('http://api', base).save({ pat: 'movp_pat_stored', session: { access_token: makeJwt('cached'), expires_at: nowSec() + 3600 } })
    const fresh = makeJwt('stored-fresh')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fresh, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'stored-fresh' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const ctx = await resolveCliCtx(base)

    expect(ctx.userId).toBe('stored-fresh')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-exchanges when the cached session is expired', async () => {
    fileStore('http://api', base).save({ pat: 'movp_pat_abc', session: { access_token: makeJwt('stale'), expires_at: nowSec() - 10 } })
    const fresh = makeJwt('fresh')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fresh, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'fresh' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.accessToken).toBe(fresh)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a revoked PAT (exchange 401) throws the auth code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })))
    await expect(resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_revoked' })).rejects.toThrow(/invalid_token/)
  })

  it('does not replace the cached session when PAT access is disabled', async () => {
    const cached = { access_token: makeJwt('cached'), expires_at: nowSec() + 3600 }
    fileStore('http://api', base).save({ pat: 'movp_pat_disabled', session: cached })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'cli_access_disabled' }), { status: 403 })))

    await expect(resolveCliCtx(base)).rejects.toThrow(/cli_access_disabled/)
    expect(fileStore('http://api', base).load()).toEqual({ pat: 'movp_pat_disabled', session: cached })
  })

  it('service-role mode is unchanged', async () => {
    const ctx = await resolveCliCtx({ ...base, MOVP_SERVICE_ROLE_KEY: 'srv', MOVP_USER_ID: 'admin' })
    expect(ctx.userId).toBe('admin')
    expect(ctx.accessToken).toBeUndefined()
  })
})
