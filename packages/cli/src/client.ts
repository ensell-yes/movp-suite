import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadCliConfig } from './config.ts'
import { selectSecureStore } from './secure-store.ts'

export interface CliCtx {
  db: SupabaseClient
  userId: string
  accessToken?: string
  assetsFnUrl?: string
}

export interface ExchangeResult {
  access_token: string
  expires_at: number
  default_workspace_id: string
  user_id: string
}

export function decodeSub(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed JWT in MOVP_ACCESS_TOKEN')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('JWT missing sub')
  return payload.sub
}

// POST the PAT to the C3a auth-exchange endpoint. Consumes C3a's frozen I/O:
//   200 → { access_token, expires_at, default_workspace_id, user_id }
//   4xx → { error: 'invalid_token' | 'expired_token' }
// NEVER log the pat or the returned tokens — the thrown Error carries only the stable code.
// GOTCHA: send `apikey: <anonKey>` too — the Supabase Functions gateway requires it even
// though the fn is verify_jwt=false (the Bearer is a movp_pat_, not a JWT).
export async function exchangePat(
  pat: string,
  apiUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const res = await fetchImpl(`${apiUrl}/functions/v1/auth-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${pat}` },
  })
  if (!res.ok) {
    let code = 'invalid_token'
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') code = body.error
    } catch {
      /* keep the default code */
    }
    throw new Error(code)
  }
  return (await res.json()) as ExchangeResult
}

function expiresAtMs(expiresAt: number): number {
  // GoTrue session.expires_at is unix SECONDS; tolerate a millisecond value defensively.
  return expiresAt > 1e12 ? expiresAt : expiresAt * 1000
}

// PAT → session access_token, cached in the SAME secure store; re-exchange only when expired.
async function resolvePatSession(
  pat: string,
  apiUrl: string,
  anonKey: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const store = selectSecureStore(apiUrl, env)
  const creds = store.load()
  const cached = creds.session
  if (cached && expiresAtMs(cached.expires_at) > Date.now() + 60_000) return cached.access_token
  const ex = await exchangePat(pat, apiUrl, anonKey)
  // Preserve an already-stored PAT; update only the cached session.
  store.save({ ...creds, session: { access_token: ex.access_token, expires_at: ex.expires_at } })
  return ex.access_token
}

export async function resolveCliCtx(env: Record<string, string | undefined> = process.env): Promise<CliCtx> {
  const cfg = loadCliConfig(env)
  const url = env.SUPABASE_URL ?? cfg?.apiUrl
  if (!url) throw new Error('SUPABASE_URL is required (run `movp init` or set SUPABASE_URL)')
  const anonKey = env.SUPABASE_ANON_KEY ?? cfg?.anonKey
  const assetsFnUrl = `${url}/functions/v1/content-assets`

  // 1. MOVP_ACCESS_TOKEN (raw JWT) — UNCHANGED, byte-identical client construction.
  const accessToken = env.MOVP_ACCESS_TOKEN
  if (accessToken) {
    if (!anonKey) throw new Error('SUPABASE_ANON_KEY is required alongside MOVP_ACCESS_TOKEN')
    const db = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(accessToken), accessToken, assetsFnUrl }
  }

  // 2. PAT mode: MOVP_PAT env or stored PAT → exchange → session access_token.
  const pat = env.MOVP_PAT ?? selectSecureStore(url, env).load().pat
  if (pat) {
    if (!anonKey) throw new Error('anon key required for PAT mode (run `movp init` or set SUPABASE_ANON_KEY)')
    const sessionToken = await resolvePatSession(pat, url, anonKey, env)
    const db = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${sessionToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(sessionToken), accessToken: sessionToken, assetsFnUrl }
  }

  // 3. MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID — UNCHANGED.
  const serviceRole = env.MOVP_SERVICE_ROLE_KEY
  if (serviceRole) {
    const userId = env.MOVP_USER_ID
    if (!userId) throw new Error('MOVP_USER_ID is required in service-role mode')
    console.error('[movp] WARNING: service-role mode: RLS is BYPASSED. Local admin only.')
    const db = createClient(url, serviceRole, { auth: { persistSession: false } })
    return { db, userId, assetsFnUrl }
  }

  throw new Error(
    'No credential: set MOVP_ACCESS_TOKEN (preferred), MOVP_PAT / `movp login` (PAT), or MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID (local admin).',
  )
}
