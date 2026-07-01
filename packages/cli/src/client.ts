import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface CliCtx {
  db: SupabaseClient
  userId: string
}

export function decodeSub(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed JWT in MOVP_ACCESS_TOKEN')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('JWT missing sub')
  return payload.sub
}

export function resolveCliCtx(env: Record<string, string | undefined> = process.env): CliCtx {
  const url = env.SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL is required')

  const accessToken = env.MOVP_ACCESS_TOKEN
  if (accessToken) {
    const anon = env.SUPABASE_ANON_KEY
    if (!anon) throw new Error('SUPABASE_ANON_KEY is required alongside MOVP_ACCESS_TOKEN')
    const db = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(accessToken) }
  }

  const serviceRole = env.MOVP_SERVICE_ROLE_KEY
  if (serviceRole) {
    const userId = env.MOVP_USER_ID
    if (!userId) throw new Error('MOVP_USER_ID is required in service-role mode')
    console.error('[movp] WARNING: service-role mode: RLS is BYPASSED. Local admin only.')
    const db = createClient(url, serviceRole, { auth: { persistSession: false } })
    return { db, userId }
  }

  throw new Error(
    'No credential: set MOVP_ACCESS_TOKEN (preferred) or MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID (local admin).',
  )
}
