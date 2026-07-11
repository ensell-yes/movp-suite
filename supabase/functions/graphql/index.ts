import { createYoga, type ReportingFailureEvent } from '@movp/graphql'
import { schema } from '@movp/core-schema'
import { resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'
import { GteSmallProvider } from '@movp/search/gte-small'

const yoga = createYoga({ schema })

Deno.serve(async (req: Request): Promise<Response> => {
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    SUPABASE_JWT_ISSUER: Deno.env.get('MOVP_JWT_ISSUER') ?? Deno.env.get('SUPABASE_JWT_ISSUER') ?? undefined,
  }
  const principal = await resolvePrincipal(req, env)
  if (!principal.ok) {
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'graphql',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const yogaReq = new Request(new URL(`/graphql${url.search}`, url.origin), req)
  const requestId = crypto.randomUUID()
  const traceId = crypto.randomUUID()
  const reportReportingFailure = ({ operation, errorCode }: ReportingFailureEvent): void => {
    emit({
      trace_id: traceId,
      request_id: requestId,
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
    accessToken: req.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
    assetsFnUrl: `${env.SUPABASE_URL}/functions/v1/content-assets`,
    reportReportingFailure,
  })
})
