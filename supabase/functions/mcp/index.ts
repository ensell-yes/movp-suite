import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.26.0/server/webStandardStreamableHttp.js'
import { createClient } from '@supabase/supabase-js'
import { buildMcpServer } from '@movp/mcp'
import { schema } from '@movp/core-schema'
import { decideAgentAccess, evaluateAgentAccess, resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'
import { GteSmallProvider } from '@movp/search/gte-small'

Deno.serve(async (req: Request): Promise<Response> => {
  const traceId = crypto.randomUUID()
  const requestId = crypto.randomUUID()
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
      surface: 'mcp',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: principal.code === 'agent_session_ttl_out_of_bounds' ? 503 : 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const evaluation = principal.credentialKind === 'pat'
    ? { decision: decideAgentAccess(principal.agentAccess, 'mcp'), attempt: 1 as const, latencyMs: 0 }
    : await evaluateAgentAccess(
      principal.userId,
      'mcp',
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
    )
  if (!evaluation.decision.ok) {
    const exhausted = evaluation.decision.code === 'agent_access_check_failed' && evaluation.attempt === 2
    emit({
      trace_id: traceId,
      request_id: requestId,
      actor_id: principal.userId,
      surface: 'mcp',
      operation: 'authorize',
      error_code: evaluation.decision.code,
      attempt: exhausted ? 2 : undefined,
      latency_ms: exhausted ? evaluation.latencyMs : undefined,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: evaluation.decision.code }), {
      status: evaluation.decision.code === 'agent_access_check_failed' ? 503 : 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  const server = buildMcpServer(schema, {
    db: principal.db,
    userId: principal.userId,
    embedder: new GteSmallProvider(),
    accessToken: principal.accessToken,
    assetsFnUrl: `${env.SUPABASE_URL}/functions/v1/content-assets`,
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return await transport.handleRequest(req)
})
