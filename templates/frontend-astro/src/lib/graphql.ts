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
export type GqlFieldError = {
  message?: string
  path?: Array<string | number>
  code?: string
}
export type GqlResult<T> =
  | { ok: true; data: T; errors?: GqlFieldError[] }
  | { ok: false; code: GqlErrorCode; message?: string }

export type GqlClientOpts = {
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
}

type GqlErrorPayload = {
  message?: unknown
  path?: unknown
  extensions?: {
    code?: unknown
    pgCode?: unknown
    reason?: unknown
  }
}

export type GqlRequestOptions = {
  allowPartial?: boolean
}

function friendlyAdminMessage(error: GqlErrorPayload): string | null {
  const reason = typeof error.extensions?.reason === 'string' ? error.extensions.reason : ''
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code : ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (!reason && !message.startsWith('domain.admin.')) return null

  if (reason === 'not_workspace_member') return "You're not a member of this workspace."
  if (reason === 'pat_name_required') return 'Enter a name for the access token.'
  if (reason === 'pat_not_found') return 'That access token could not be found or is already revoked.'
  if (code === 'FORBIDDEN' || reason === 'not_workspace_admin') return "You're not an admin of this workspace."
  if (reason === 'last_owner_guard') return 'At least one workspace owner must remain.'
  if (reason === 'invite_email_mismatch') return 'This invite is for a different email address.'
  if (reason === 'invite_expired') return 'This invite has expired. Ask an admin to send a new one.'
  if (reason === 'invite_not_found') return 'This invite is no longer valid.'
  if (reason === 'ingest_key_not_found') return 'That ingest key could not be found or is no longer active.'
  if (reason === 'workspace_name_required') return 'Enter a workspace name.'
  if (reason === 'invite_email_invalid') return 'Enter a valid email address.'
  if (reason === 'invite_role_invalid' || reason === 'member_role_invalid') return 'Choose a valid role.'
  if (reason === 'ingest_key_label_required') return 'Enter a label for the ingest key.'
  if (code === 'BAD_USER_INPUT') return 'Check the form values and try again.'
  if (code === 'NOT_FOUND') return 'The requested admin resource could not be found.'
  if (code === 'CONFLICT') return 'The admin action conflicts with the current workspace state.'
  return 'Could not complete the admin action.'
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
  requestOptions: GqlRequestOptions = {},
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
  if (json.errors && json.errors.length > 0) {
    const errors: GqlFieldError[] = []
    for (const error of json.errors) {
      if (!error || typeof error !== 'object') continue
      const payload = error as GqlErrorPayload
      const message = friendlyAdminMessage(payload)
        ?? ('message' in payload ? String(payload.message) : '')
      const path = Array.isArray(payload.path)
        ? payload.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
        : undefined
      const code = typeof payload.extensions?.code === 'string' ? payload.extensions.code : undefined
      errors.push({ message: message || undefined, path, code })
    }
    if (requestOptions.allowPartial && json.data !== undefined) {
      return { ok: true, data: json.data, errors }
    }
    const message = errors.map((error) => error.message).filter(Boolean).join('; ')
    return { ok: false, code: 'graphql_error', message: message || undefined }
  }
  if (json.data === undefined) return { ok: false, code: 'graphql_error' }
  return { ok: true, data: json.data }
}

export function clampFirst(first: number | undefined): number {
  if (first === undefined || Number.isNaN(first)) return NOTES_PAGE_DEFAULT
  return Math.min(Math.max(Math.trunc(first), 1), NOTES_PAGE_MAX)
}
