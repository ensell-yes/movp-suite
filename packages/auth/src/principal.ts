import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createRemoteJWKSet, errors as jose, jwtVerify } from 'jose'

export type Env = { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }

export type Principal =
  | { ok: true; userId: string; db: SupabaseClient }
  | { ok: false; code: 'missing_token' | 'invalid_token' | 'expired_token' | 'invalid_claims' }

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(supabaseUrl: string) {
  let jwks = jwksCache.get(supabaseUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    jwksCache.set(supabaseUrl, jwks)
  }
  return jwks
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

export async function resolvePrincipal(req: Request, env: Env): Promise<Principal> {
  const token = bearerToken(req)
  if (!token) return { ok: false, code: 'missing_token' }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    ;({ payload } = await jwtVerify(token, jwksFor(env.SUPABASE_URL), {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
      algorithms: ['RS256'],
    }))
  } catch (e) {
    if (e instanceof jose.JWTExpired) return { ok: false, code: 'expired_token' }
    return { ok: false, code: 'invalid_token' }
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, code: 'invalid_claims' }
  }

  const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })

  return { ok: true, userId: payload.sub, db }
}
