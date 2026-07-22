import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AgentAccessPreferences } from './agent-access.ts'

export const PAT_PREFIX = 'movp_pat_'
export const MAX_AGENT_SESSION_TTL_SECONDS = 3600

export type PatExchange =
  | {
      ok: true
      userId: string
      defaultWorkspaceId: string
      accessToken: string
      expiresAt: number
      agentAccess: AgentAccessPreferences
    }
  | { ok: false; code: 'invalid_token' | 'expired_token' | 'agent_session_ttl_out_of_bounds' }

type MintedSession = { accessToken: string; expiresAt: number }

const SESSION_EXPIRY_SKEW_SECONDS = 60
const MAX_SESSION_CACHE_ENTRIES = 256
const sessionCache = new Map<string, Promise<MintedSession | null>>()

class AgentSessionTtlOutOfBoundsError extends Error {
  constructor() {
    super('agent_session_ttl_out_of_bounds')
    this.name = 'AgentSessionTtlOutOfBoundsError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function cacheKey(supabaseUrl: string, tokenHash: string): string {
  return `${supabaseUrl}\u0000${tokenHash}`
}

function reusable(session: MintedSession | null): session is MintedSession {
  return session !== null && session.expiresAt > Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SKEW_SECONDS
}

function setCached(key: string, pending: Promise<MintedSession | null>): void {
  sessionCache.set(key, pending)
  while (sessionCache.size > MAX_SESSION_CACHE_ENTRIES) {
    const oldest = sessionCache.keys().next().value
    if (typeof oldest !== 'string') break
    sessionCache.delete(oldest)
  }
}

async function mintSession(
  userId: string,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string },
  admin: SupabaseClient,
): Promise<MintedSession | null> {
  const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(userId)
  const email = userRes?.user?.email
  if (userErr || !email) return null

  const { data: linkRes, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const hashedToken = linkRes?.properties?.hashed_token
  if (linkErr || !hashedToken) return null

  // verify with an ANON client. type MUST be 'email' — PINNED by C3a.1's spike and by the
  // committed magic-link path (supabase/templates/magic_link.html `&type=email`,
  // auth/callback.astro default 'email'). No email is sent; verifyOtp consumes the token server-side.
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: 'email', token_hash: hashedToken })
  const session = otp?.session
  if (otpErr || !session?.access_token) return null
  const minted = { accessToken: session.access_token, expiresAt: session.expires_at ?? 0 }
  if (minted.expiresAt - Math.floor(Date.now() / 1000) > MAX_AGENT_SESSION_TTL_SECONDS) {
    throw new AgentSessionTtlOutOfBoundsError()
  }
  return minted
}

async function cachedOrMintedSession(
  key: string,
  mint: () => Promise<MintedSession | null>,
): Promise<MintedSession | null> {
  const cached = sessionCache.get(key)
  if (cached) {
    try {
      const session = await cached
      if (reusable(session)) {
        sessionCache.delete(key)
        sessionCache.set(key, cached)
        return session
      }
    } catch (error) {
      if (sessionCache.get(key) === cached) sessionCache.delete(key)
      throw error
    }
    if (sessionCache.get(key) === cached) sessionCache.delete(key)
  }

  const pending = mint()
  setCached(key, pending)
  try {
    const session = await pending
    if (!reusable(session) && sessionCache.get(key) === pending) sessionCache.delete(key)
    return session
  } catch (error) {
    if (sessionCache.get(key) === pending) sessionCache.delete(key)
    throw error
  }
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
  if (!isRecord(data)) return { ok: false, code: 'invalid_token' }
  if (data.status === 'expired') return { ok: false, code: 'expired_token' }
  // revoked | not_found | anything non-ok collapse to invalid_token (agents re-auth, not retry).
  if (
    data.status !== 'ok'
    || typeof data.user_id !== 'string'
    || typeof data.default_workspace_id !== 'string'
    || typeof data.mcp_enabled !== 'boolean'
    || typeof data.cli_enabled !== 'boolean'
  ) return { ok: false, code: 'invalid_token' }

  const userId = data.user_id
  const defaultWorkspaceId = data.default_workspace_id
  const agentAccess = { mcpEnabled: data.mcp_enabled, cliEnabled: data.cli_enabled }

  // Revocation stays immediate: resolve_pat runs above on every request. Only the expensive
  // GoTrue mint is reused after that gate has returned ok.
  let session: MintedSession | null
  try {
    session = await cachedOrMintedSession(
      cacheKey(env.SUPABASE_URL, tokenHash),
      () => mintSession(userId, env, admin),
    )
  } catch (caught) {
    if (caught instanceof AgentSessionTtlOutOfBoundsError) {
      return { ok: false, code: 'agent_session_ttl_out_of_bounds' }
    }
    throw caught
  }
  if (!session) return { ok: false, code: 'invalid_token' }

  return {
    ok: true,
    userId,
    defaultWorkspaceId,
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    agentAccess,
  }
}
