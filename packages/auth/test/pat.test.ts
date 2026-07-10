import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAT_PREFIX, resolvePatToken, sha256hex } from '../src/pat.ts'

const env = { SUPABASE_URL: 'http://127.0.0.1:64321', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }

function adminReturningStatus(status: string): SupabaseClient {
  return { rpc: vi.fn(async () => ({ data: { status }, error: null })) } as unknown as SupabaseClient
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
