import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { KeyLike } from 'jose'
import { resolvePrincipal } from '../src/principal.ts'

let SUPABASE_URL = ''
let ISS = ''
let env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string }
const KID = 'test-key-1'
const ES_KID = 'test-key-2'
const SUB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

let server: Server
let rsPriv: KeyLike
let rsPrivOther: KeyLike
let esPriv: KeyLike

beforeAll(async () => {
  const rs = await generateKeyPair('RS256')
  const rsOther = await generateKeyPair('RS256')
  const es = await generateKeyPair('ES256')
  rsPriv = rs.privateKey
  rsPrivOther = rsOther.privateKey
  esPriv = es.privateKey

  const jwk = await exportJWK(rs.publicKey)
  jwk.kid = KID
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  const esJwk = await exportJWK(es.publicKey)
  esJwk.kid = ES_KID
  esJwk.alg = 'ES256'
  esJwk.use = 'sig'

  server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk, esJwk] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind jwks test server')
  SUPABASE_URL = `http://127.0.0.1:${address.port}`
  ISS = `${SUPABASE_URL}/auth/v1`
  env = { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-test-key', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' }
})

afterAll(() => {
  server.close()
})

function req(token?: string): Request {
  return new Request('https://gateway/graphql', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

async function sign(
  key: KeyLike | Uint8Array,
  alg: 'RS256' | 'ES256' | 'HS256',
  claims: Record<string, unknown>,
  expSeconds?: number,
  kid = KID,
) {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT(claims)
    .setProtectedHeader({ alg, kid })
    .setIssuedAt(now)
    .setExpirationTime(expSeconds ?? now + 3600)
    .sign(key)
}

describe('resolvePrincipal', () => {
  it('accepts a valid member token', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.userId).toBe(SUB)
      expect(r.db).toBeDefined()
    }
  })

  it('accepts Supabase asymmetric ES256 member tokens', async () => {
    const token = await sign(esPriv, 'ES256', { iss: ISS, aud: 'authenticated', sub: SUB }, undefined, ES_KID)
    const r = await resolvePrincipal(req(token), env)
    expect(r.ok).toBe(true)
  })

  it('rejects a missing token', async () => {
    const r = await resolvePrincipal(req(), env)
    expect(r).toEqual({ ok: false, code: 'missing_token' })
  })

  it('rejects a bad signature', async () => {
    const token = await sign(rsPrivOther, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a wrong issuer', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: 'https://evil/auth/v1', aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a wrong audience', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'service_role', sub: SUB })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a symmetric algorithm (HS256)', async () => {
    const token = await sign(new TextEncoder().encode('super-secret-test-key'), 'HS256', {
      iss: ISS,
      aud: 'authenticated',
      sub: SUB,
    })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('rejects a missing sub', async () => {
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated' })
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'invalid_claims' })
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB }, past)
    const r = await resolvePrincipal(req(token), env)
    expect(r).toEqual({ ok: false, code: 'expired_token' })
  })
})

describe('resolvePrincipal PAT branch (production-shaped: real branch, injected exchange)', () => {
  it('routes a movp_pat_ token through the exchange and returns an RLS principal', async () => {
    const resolvePat = vi.fn(async () => ({
      ok: true as const, userId: SUB, defaultWorkspaceId: 'w1', accessToken: 'minted.jwt.token', expiresAt: 9999999999,
    }))
    const r = await resolvePrincipal(req('movp_pat_deadbeef'), env, { resolvePat })
    expect(resolvePat).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.userId).toBe(SUB)
      expect(r.db).toBeDefined()
    }
  })

  it('maps an exchange invalid_token to the principal code', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'invalid_token' as const }))
    const r = await resolvePrincipal(req('movp_pat_bad'), env, { resolvePat })
    expect(r).toEqual({ ok: false, code: 'invalid_token' })
  })

  it('maps an exchange expired_token to the principal code', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'expired_token' as const }))
    const r = await resolvePrincipal(req('movp_pat_expired'), env, { resolvePat })
    expect(r).toEqual({ ok: false, code: 'expired_token' })
  })

  it('does NOT invoke the exchange for a non-PAT JWT token (JWT path byte-identical)', async () => {
    const resolvePat = vi.fn(async () => ({ ok: false as const, code: 'invalid_token' as const }))
    const token = await sign(rsPriv, 'RS256', { iss: ISS, aud: 'authenticated', sub: SUB })
    const r = await resolvePrincipal(req(token), env, { resolvePat })
    expect(resolvePat).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })
})
