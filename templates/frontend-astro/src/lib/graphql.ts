export type NoteStatus = 'draft' | 'published' | 'archived'

export type NoteRow = {
  id: string
  title: string
  body: string | null
  status: NoteStatus
  created_at: string
  updated_at: string
}

export type NotePage = { items: NoteRow[]; nextCursor: string | null }

export type SearchHit = {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

export type GqlErrorCode = 'http_error' | 'auth_error' | 'graphql_error' | 'network_error'
export type GqlResult<T> = { ok: true; data: T } | { ok: false; code: GqlErrorCode }

export type GqlClientOpts = {
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
}

export const NOTES_PAGE_DEFAULT = 20
export const NOTES_PAGE_MAX = 100

export const NOTES_QUERY = /* GraphQL */ `
  query Notes($workspaceId: ID!, $first: Int!, $after: String) {
    notes(workspaceId: $workspaceId, first: $first, after: $after) {
      items { id title status updated_at }
      nextCursor
    }
  }
`

export const NOTE_QUERY = /* GraphQL */ `
  query Note($id: ID!) {
    note(id: $id) { id title body status created_at updated_at }
  }
`

export const SEARCH_QUERY = /* GraphQL */ `
  query Search($workspaceId: ID!, $query: String!, $mode: String) {
    search(workspaceId: $workspaceId, query: $query, mode: $mode) { collection id title snippet score }
  }
`

export async function gqlRequest<T>(
  opts: GqlClientOpts,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    return { ok: false, code: 'network_error' }
  }

  if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth_error' }
  if (!res.ok) return { ok: false, code: 'http_error' }

  let json: { data?: T; errors?: unknown[] }
  try {
    json = (await res.json()) as { data?: T; errors?: unknown[] }
  } catch {
    return { ok: false, code: 'graphql_error' }
  }
  if (json.errors && json.errors.length > 0) return { ok: false, code: 'graphql_error' }
  if (json.data === undefined) return { ok: false, code: 'graphql_error' }
  return { ok: true, data: json.data }
}

export function clampFirst(first: number | undefined): number {
  if (first === undefined || Number.isNaN(first)) return NOTES_PAGE_DEFAULT
  return Math.min(Math.max(Math.trunc(first), 1), NOTES_PAGE_MAX)
}
