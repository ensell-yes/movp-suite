export type UserAccount = {
  id: string
  email: string
  firstName: string
  lastName: string
  displayName: string
  pendingEmail: string | null
}

export type AuthApiEnv = {
  supabaseUrl: string
  anonKey: string
  fetchImpl?: typeof fetch
}

export class UserAccountError extends Error {
  constructor(readonly code: 'auth_error' | 'invalid_response' | 'request_failed' | 'response_too_large') {
    super(code)
  }
}

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new UserAccountError('response_too_large')
  }
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_AUTH_RESPONSE_BYTES) {
      await reader.cancel()
      throw new UserAccountError('response_too_large')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new UserAccountError('invalid_response')
  }
}

function accountFrom(value: unknown): UserAccount {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.email !== 'string') {
    throw new UserAccountError('invalid_response')
  }
  const metadata = isRecord(value.user_metadata) ? value.user_metadata : {}
  return {
    id: value.id,
    email: value.email,
    firstName: text(metadata.first_name),
    lastName: text(metadata.last_name),
    displayName: text(metadata.display_name),
    pendingEmail: typeof value.new_email === 'string' ? value.new_email : null,
  }
}

async function authRequest(
  env: AuthApiEnv,
  path: string,
  init: RequestInit,
  token?: string,
): Promise<Response> {
  const doFetch = env.fetchImpl ?? fetch
  const headers = new Headers(init.headers)
  headers.set('apikey', env.anonKey)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let response: Response
  try {
    response = await doFetch(`${env.supabaseUrl}/auth/v1${path}`, { ...init, headers })
  } catch {
    throw new UserAccountError('request_failed')
  }
  if (response.status === 401 || response.status === 403) throw new UserAccountError('auth_error')
  if (!response.ok) throw new UserAccountError('request_failed')
  return response
}

export async function getCurrentUser(env: AuthApiEnv, token: string): Promise<UserAccount> {
  const response = await authRequest(env, '/user', { method: 'GET' }, token)
  return accountFrom(await readBoundedJson(response))
}

export async function updateCurrentUser(
  env: AuthApiEnv,
  token: string,
  input: { email: string; firstName: string; lastName: string; displayName: string },
): Promise<UserAccount> {
  const response = await authRequest(env, '/user', {
    method: 'PUT',
    body: JSON.stringify({
      email: input.email,
      data: {
        first_name: input.firstName,
        last_name: input.lastName,
        display_name: input.displayName,
      },
    }),
  }, token)
  const body = await readBoundedJson(response)
  if (isRecord(body) && isRecord(body.user)) return accountFrom(body.user)
  return accountFrom(body)
}

export async function requestPasswordRecovery(env: AuthApiEnv, email: string, redirectTo: string): Promise<void> {
  const query = new URLSearchParams({ redirect_to: redirectTo })
  await authRequest(env, `/recover?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function updatePassword(env: AuthApiEnv, token: string, password: string): Promise<void> {
  await authRequest(env, '/user', { method: 'PUT', body: JSON.stringify({ password }) }, token)
}

export async function signOut(env: AuthApiEnv, token: string): Promise<void> {
  await authRequest(env, '/logout', { method: 'POST', body: '{}' }, token)
}
