import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.26.0/server/webStandardStreamableHttp.js'
import { buildMcpServer } from '@movp/mcp'
// The scaffold exposes its composed project schema.\nimport { schema } from '../_shared/schema.ts'
import { resolvePrincipal } from '@movp/auth'
import { emit, REDACTION_VERSION } from '@movp/obs'
import { GteSmallProvider } from '@movp/search/gte-small'

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
      surface: 'mcp',
      operation: 'authenticate',
      error_code: principal.code,
      redaction_version: REDACTION_VERSION,
    })
    return new Response(JSON.stringify({ error: principal.code }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const server = buildMcpServer(schema, {
    db: principal.db,
    userId: principal.userId,
    embedder: new GteSmallProvider(),
    accessToken: req.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
    assetsFnUrl: `${env.SUPABASE_URL}/functions/v1/content-assets`,
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return await transport.handleRequest(req)
})
