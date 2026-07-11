export interface GraphqlSearchHit {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

const SEARCH_QUERY = `query Search($workspaceId: ID!, $query: String!, $mode: String, $collection: String, $limit: Int) {
  search(workspaceId: $workspaceId, query: $query, mode: $mode, collection: $collection, limit: $limit) {
    collection id title snippet score
  }
}`

// Authenticated GraphQL client for semantic/hybrid search. Consumes the C3a-minted session
// access_token (Bearer). fts stays on the direct-PG domain path (see program.ts search action).
export async function searchViaGraphql(
  args: {
    apiUrl: string
    accessToken: string
    workspaceId: string
    query: string
    mode: 'semantic' | 'hybrid'
    collection?: string
    limit?: number
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphqlSearchHit[]> {
  const res = await fetchImpl(`${args.apiUrl}/functions/v1/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        workspaceId: args.workspaceId,
        query: args.query,
        mode: args.mode,
        collection: args.collection ?? null,
        limit: args.limit ?? null,
      },
    }),
  })
  if (res.status === 401 || res.status === 403) throw new Error('invalid_token')
  if (!res.ok) throw new Error(`graphql_http_${res.status}`)
  const json = (await res.json()) as { data?: { search?: GraphqlSearchHit[] }; errors?: Array<{ message?: unknown }> }
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join('; ') || 'graphql_error')
  }
  return json.data?.search ?? []
}
