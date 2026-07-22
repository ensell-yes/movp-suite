import { readBoundedJson } from './user-account.ts'

export const SESSION_COOKIE = 'sb-access-token'
export const PASSWORD_RECOVERY_COOKIE = 'movp-password-recovery'

export type MagicLinkType = 'email' | 'magiclink' | 'recovery'

export type AuthEnv = {
  supabaseUrl: string
  anonKey: string
  fetchImpl?: typeof fetch
}

export type VerifiedSession = { accessToken: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function verifyMagicLink(env: AuthEnv, tokenHash: string, type: MagicLinkType = 'email'): Promise<VerifiedSession | null> {
  if (!tokenHash) return null
  const doFetch = env.fetchImpl ?? fetch
  const res = await doFetch(`${env.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type, token_hash: tokenHash }),
  })
  if (!res.ok) return null
  let json: unknown
  try {
    json = await readBoundedJson(res)
  } catch {
    return null
  }
  if (!isRecord(json)) return null
  const session = isRecord(json.session) ? json.session : null
  const accessToken = typeof session?.access_token === 'string'
    ? session.access_token
    : typeof json.access_token === 'string'
      ? json.access_token
      : null
  return accessToken ? { accessToken } : null
}
