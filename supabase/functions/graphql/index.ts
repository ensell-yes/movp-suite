import { createYoga, type ReportingFailureEvent } from '@movp/graphql'
import { schema } from '@movp/core-schema'
import { decideAgentAccess, resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'
import { GteSmallProvider } from '@movp/search/gte-small'

const yoga = createYoga({ schema })

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID()
  const traceId = crypto.randomUUID()
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    SUPABASE_JWT_ISSUER: Deno.env.get('MOVP_JWT_ISSUER') ?? Deno.env.get('SUPABASE_JWT_ISSUER') ?? undefined,
  }
  const principal = await resolvePrincipal(req, env)
  if (!principal.ok) {
    emit({
      trace_id: traceId,
      request_id: requestId,
      surface: 'graphql',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: principal.code === 'agent_session_ttl_out_of_bounds' ? 503 : 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (principal.credentialKind === 'pat') {
    const decision = decideAgentAccess(principal.agentAccess, 'cli')
    if (!decision.ok) {
      emit({
        trace_id: traceId,
        request_id: requestId,
        actor_id: principal.userId,
        surface: 'graphql',
        operation: 'authorize',
        error_code: decision.code,
        redaction_version: REDACTION_VERSION,
      })
      return new Response(JSON.stringify({ error: decision.code }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  const url = new URL(req.url)
  const yogaReq = new Request(new URL(`/graphql${url.search}`, url.origin), req)
  const reportReportingFailure = async ({ operation, errorCode, workspaceId }: ReportingFailureEvent): Promise<void> => {
    emit({
      trace_id: traceId,
      request_id: requestId,
      workspace_id_hash: await sha256Hex(workspaceId),
      actor_id: principal.userId,
      surface: 'graphql',
      operation,
      error_code: errorCode,
      redaction_version: REDACTION_VERSION,
    })
  }
  return yoga.handleRequest(yogaReq, {
    db: principal.db,
    userId: principal.userId,
    embedder: new GteSmallProvider(),
    accessToken: principal.accessToken,
    assetsFnUrl: `${env.SUPABASE_URL}/functions/v1/content-assets`,
    reportReportingFailure,
  })
})
