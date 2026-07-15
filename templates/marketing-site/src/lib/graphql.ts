export type GraphqlResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 'network_error' | 'http_error' | 'graphql_error' }

export async function postGraphql<T>(
  endpoint: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    return { ok: false, code: 'network_error' }
  }
  if (!response.ok) return { ok: false, code: 'http_error' }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, code: 'graphql_error' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'graphql_error' }
  }
  const record = body as Record<string, unknown>
  if (record.errors !== undefined || record.data === undefined) {
    return { ok: false, code: 'graphql_error' }
  }
  return { ok: true, data: record.data as T }
}

