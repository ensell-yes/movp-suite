import type { APIRoute } from 'astro'
import { readServerEnv } from '../../lib/env.ts'
import { getSessionToken } from '../../lib/session.ts'
import { gqlRequest, SEARCH_QUERY, type SearchHit } from '../../lib/graphql.ts'

export const GET: APIRoute = async ({ url, cookies }) => {
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) return Response.json({ code: 'bad_request' }, { status: 400 })

  const token = getSessionToken(cookies)
  if (!token) return Response.json({ code: 'auth_error' }, { status: 401 })

  const { graphqlEndpoint, workspaceId } = readServerEnv()
  const r = await gqlRequest<{ search: SearchHit[] }>(
    { endpoint: graphqlEndpoint, token },
    SEARCH_QUERY,
    { workspaceId, query: q, mode: 'hybrid' },
  )
  if (!r.ok) {
    const status = r.code === 'auth_error' ? 401 : 502
    return Response.json({ code: r.code }, { status })
  }
  return Response.json({ hits: r.data.search }, { status: 200 })
}
