import type { APIRoute } from 'astro'
import { readServerEnv } from '../../../lib/env.ts'
import { getSessionToken } from '../../../lib/session.ts'
import { gqlRequest } from '../../../lib/graphql.ts'
import { CREATE_SEGMENT_RULE_VERSION_MUTATION } from '../../../lib/segment-queries.ts'

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = getSessionToken(cookies)
  if (!token) return Response.json({ code: 'auth_error' }, { status: 401 })
  const { segmentId, predicate } = (await request.json().catch(() => ({}))) as { segmentId?: string; predicate?: string }
  if (!segmentId || typeof predicate !== 'string') return Response.json({ code: 'bad_request' }, { status: 400 })
  const { graphqlEndpoint } = readServerEnv()
  const r = await gqlRequest<{ createSegmentRuleVersion: { id: string; version: number } | null }>(
    { endpoint: graphqlEndpoint, token }, CREATE_SEGMENT_RULE_VERSION_MUTATION, { segmentId, predicate },
  )
  if (!r.ok) return Response.json({ code: r.code }, { status: r.code === 'auth_error' ? 401 : 502 })
  return Response.json({ rule: r.data.createSegmentRuleVersion }, { status: 200 })
}
