export const SESSION_COOKIE = 'sb-access-token'

export type AuthEnv = {
  supabaseUrl: string
  anonKey: string
  fetchImpl?: typeof fetch
}

export type VerifiedSession = { accessToken: string }

export async function verifyAccessToken(env: AuthEnv, token: string): Promise<boolean> {
  if (!token || token.length < 20) return false
  const doFetch = env.fetchImpl ?? fetch
  const res = await doFetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  return res.ok
}

export async function verifyMagicLink(env: AuthEnv, tokenHash: string, type = 'email'): Promise<VerifiedSession | null> {
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
  const json = (await res.json()) as { access_token?: string; session?: { access_token?: string } }
  const accessToken = json.session?.access_token ?? json.access_token
  return accessToken ? { accessToken } : null
}
