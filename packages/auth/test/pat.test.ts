import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAT_PREFIX, resolvePatToken, sha256hex } from '../src/pat.ts'

const { verifyOtp } = vi.hoisted(() => ({ verifyOtp: vi.fn() }))

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
  return {
    ...actual,
    createClient: vi.fn(() => ({ auth: { verifyOtp } })),
  }
})

const env = { SUPABASE_URL: 'http://127.0.0.1:64321', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }

beforeEach(() => {
  verifyOtp.mockReset()
})

function adminReturningStatus(status: string): SupabaseClient {
  return { rpc: vi.fn(async () => ({ data: { status }, error: null })) } as unknown as SupabaseClient
}

function exchangeAdmin(statuses: string[] = ['ok']): SupabaseClient {
  let call = 0
  return {
    rpc: vi.fn(async () => ({
      data: {
        status: statuses[Math.min(call++, statuses.length - 1)],
        user_id: 'user-1',
        default_workspace_id: 'workspace-1',
      },
      error: null,
    })),
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email: 'user@example.test' } }, error: null })),
        generateLink: vi.fn(async () => ({ data: { properties: { hashed_token: 'otp-hash' } }, error: null })),
      },
    },
  } as unknown as SupabaseClient
}

describe('pat exchange (pure + reject paths — no GoTrue)', () => {
  it('exports the movp_pat_ prefix', () => {
    expect(PAT_PREFIX).toBe('movp_pat_')
  })

  it('sha256hex matches the known "abc" vector', async () => {
    expect(await sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('maps resolve_pat not_found -> invalid_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('not_found')))
      .toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps resolve_pat revoked -> invalid_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('revoked')))
      .toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps resolve_pat expired -> expired_token', async () => {
    expect(await resolvePatToken('movp_pat_x', env, adminReturningStatus('expired')))
      .toEqual({ ok: false, code: 'expired_token' })
  })

  it('maps an rpc error -> invalid_token', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) } as unknown as SupabaseClient
    expect(await resolvePatToken('movp_pat_x', env, admin)).toEqual({ ok: false, code: 'invalid_token' })
  })
})

describe('PAT session mint cache', () => {
  it('revalidates resolve_pat on every request but reuses the minted session', async () => {
    const admin = exchangeAdmin()
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'session-1', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    })

    const first = await resolvePatToken('movp_pat_cache_reuse', env, admin)
    const second = await resolvePatToken('movp_pat_cache_reuse', env, admin)

    expect(first).toEqual(second)
    expect(admin.rpc).toHaveBeenCalledTimes(2)
    expect(admin.auth.admin.getUserById).toHaveBeenCalledOnce()
    expect(admin.auth.admin.generateLink).toHaveBeenCalledOnce()
    expect(verifyOtp).toHaveBeenCalledOnce()
  })

  it('rejects a revoked PAT before consulting its warm session cache', async () => {
    const admin = exchangeAdmin(['ok', 'revoked'])
    verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'session-revoked', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    })

    expect((await resolvePatToken('movp_pat_cache_revoke', env, admin)).ok).toBe(true)
    expect(await resolvePatToken('movp_pat_cache_revoke', env, admin))
      .toEqual({ ok: false, code: 'invalid_token' })
    expect(admin.rpc).toHaveBeenCalledTimes(2)
    expect(admin.auth.admin.generateLink).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent session mints after both requests revalidate', async () => {
    const admin = exchangeAdmin()
    let release: (() => void) | undefined
    verifyOtp.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return {
        data: { session: { access_token: 'session-concurrent', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
        error: null,
      }
    })

    const first = resolvePatToken('movp_pat_cache_concurrent', env, admin)
    const second = resolvePatToken('movp_pat_cache_concurrent', env, admin)
    await vi.waitFor(() => expect(verifyOtp).toHaveBeenCalledOnce())
    release?.()

    expect(await first).toEqual(await second)
    expect(admin.rpc).toHaveBeenCalledTimes(2)
    expect(admin.auth.admin.generateLink).toHaveBeenCalledOnce()
  })

  it('does not reuse a session inside the 60-second expiry skew', async () => {
    const admin = exchangeAdmin()
    verifyOtp
      .mockResolvedValueOnce({
        data: { session: { access_token: 'session-near-expiry', expires_at: Math.floor(Date.now() / 1000) + 30 } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: { access_token: 'session-fresh', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
        error: null,
      })

    await resolvePatToken('movp_pat_cache_expiry', env, admin)
    const second = await resolvePatToken('movp_pat_cache_expiry', env, admin)

    expect(second).toMatchObject({ ok: true, accessToken: 'session-fresh' })
    expect(admin.rpc).toHaveBeenCalledTimes(2)
    expect(admin.auth.admin.generateLink).toHaveBeenCalledTimes(2)
  })

  it('evicts the least-recently-used mint after 256 cached sessions', async () => {
    const admin = exchangeAdmin()
    verifyOtp.mockImplementation(async () => ({
      data: {
        session: {
          access_token: `session-${verifyOtp.mock.calls.length}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    }))

    for (let i = 0; i <= 256; i += 1) {
      await resolvePatToken(`movp_pat_cache_lru_${i}`, env, admin)
    }
    await resolvePatToken('movp_pat_cache_lru_0', env, admin)

    expect(admin.rpc).toHaveBeenCalledTimes(258)
    expect(admin.auth.admin.generateLink).toHaveBeenCalledTimes(258)
    expect(verifyOtp).toHaveBeenCalledTimes(258)
  })
})
