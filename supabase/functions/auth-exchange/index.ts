import { createClient } from '@supabase/supabase-js'
import { decideAgentAccess, PAT_PREFIX, resolvePatToken } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'

Deno.serve(async (req: Request): Promise<Response> => {
  // Deno edge gotcha: resolve env + the service-role client PER REQUEST, never at module init.
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  }
  const header = req.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''

  const fail = (status: number, operation: string, code: string, actorId?: string): Response => {
    // keys-only auth event: surface + code only — NEVER the token or email value.
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      actor_id: actorId,
      surface: 'exchange',
      operation,
      error_code: code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } })
  }

  if (!token.startsWith(PAT_PREFIX)) return fail(401, 'authenticate', 'invalid_token')

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const ex = await resolvePatToken(token, env, admin)
  if (!ex.ok) {
    return fail(ex.code === 'agent_session_ttl_out_of_bounds' ? 503 : 401, 'authenticate', ex.code)
  }
  const decision = decideAgentAccess(ex.agentAccess, 'cli')
  if (!decision.ok) return fail(403, 'authorize', decision.code, ex.userId)

  return new Response(
    JSON.stringify({
      access_token: ex.accessToken,
      expires_at: ex.expiresAt,
      default_workspace_id: ex.defaultWorkspaceId,
      user_id: ex.userId,
    }),
    { headers: { 'content-type': 'application/json' } },
  )
})
