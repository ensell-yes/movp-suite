import {
  createYoga,
  sha256Hex,
  type ContentCapabilityFailureEvent,
  type ContentSaveOperationalEvent,
  type ReportingFailureEvent,
} from '@movp/graphql'
import { schema } from '@movp/core-schema'
import { decideAgentAccess, resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION, type ObsEvent } from '@movp/obs'
import { GteSmallProvider } from '@movp/search/gte-small'

const yoga = createYoga({ schema })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

Deno.serve(async (req: Request): Promise<Response> => {
  const incomingRequestId = req.headers.get('x-request-id') ?? ''
  const requestId = UUID.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID()
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
  const reportContentSave = ({
    requestId: saveRequestId,
    actorId,
    itemId,
    fieldKey,
    outcome,
    code,
    latencyMs,
  }: ContentSaveOperationalEvent): void => {
    const event = {
      trace_id: traceId,
      request_id: saveRequestId,
      actor_id: actorId,
      item_id: itemId,
      field_key: fieldKey,
      surface: 'graphql',
      operation: 'content.richtext_save_resolver',
      error_code: code ?? outcome,
      latency_ms: latencyMs,
      redaction_version: REDACTION_VERSION,
    } satisfies ObsEvent & { item_id: string; field_key: string }
    emit(event)
  }
  const reportContentCapabilityFailure = ({
    requestId: capabilityRequestId,
    actorId,
    itemId,
    code,
  }: ContentCapabilityFailureEvent): void => {
    const event = {
      trace_id: traceId,
      request_id: capabilityRequestId,
      actor_id: actorId,
      item_id: itemId,
      surface: 'graphql',
      operation: 'content.edit_capability',
      error_code: code,
      redaction_version: REDACTION_VERSION,
    } satisfies ObsEvent & { item_id: string }
    emit(event)
  }
  return yoga.handleRequest(yogaReq, {
    db: principal.db,
    userId: principal.userId,
    embedder: new GteSmallProvider(),
    accessToken: principal.accessToken,
    assetsFnUrl: `${env.SUPABASE_URL}/functions/v1/content-assets`,
    requestId,
    reportReportingFailure,
    reportContentSave,
    reportContentCapabilityFailure,
  })
})
