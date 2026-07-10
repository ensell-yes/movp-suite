import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const PAT_PREFIX = 'movp_pat_'

export type PatExchange =
  | { ok: true; userId: string; defaultWorkspaceId: string; accessToken: string; expiresAt: number }
  | { ok: false; code: 'invalid_token' | 'expired_token' }

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function resolvePatToken(
  token: string,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY: string },
  // Deno edge gotcha: `admin` MUST be resolved by the caller PER REQUEST (never captured at
  // module init) — see resolvePrincipal / auth-exchange call sites.
  admin: SupabaseClient,
): Promise<PatExchange> {
  const tokenHash = await sha256hex(token)
  const { data, error } = await admin.rpc('resolve_pat', { p_token_hash: tokenHash })
  if (error) return { ok: false, code: 'invalid_token' }
  const row = (data ?? {}) as { status?: string; user_id?: string; default_workspace_id?: string }
  if (row.status === 'expired') return { ok: false, code: 'expired_token' }
  // revoked | not_found | anything non-ok collapse to invalid_token (agents re-auth, not retry).
  if (row.status !== 'ok' || !row.user_id || !row.default_workspace_id) return { ok: false, code: 'invalid_token' }

  const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(row.user_id)
  const email = userRes?.user?.email
  if (userErr || !email) return { ok: false, code: 'invalid_token' }

  const { data: linkRes, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const hashedToken = linkRes?.properties?.hashed_token
  if (linkErr || !hashedToken) return { ok: false, code: 'invalid_token' }

  // verify with an ANON client. type MUST be 'email' — PINNED by C3a.1's spike and by the
  // committed magic-link path (supabase/templates/magic_link.html `&type=email`,
  // auth/callback.astro default 'email'). No email is sent; verifyOtp consumes the token server-side.
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: 'email', token_hash: hashedToken })
  const session = otp?.session
  if (otpErr || !session?.access_token) return { ok: false, code: 'invalid_token' }

  return {
    ok: true,
    userId: row.user_id,
    defaultWorkspaceId: row.default_workspace_id,
    accessToken: session.access_token,
    expiresAt: session.expires_at ?? 0,
  }
}
