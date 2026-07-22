import { describe, expect, it, vi } from 'vitest'
import {
  getCurrentUser,
  readBoundedJson,
  requestPasswordRecovery,
  signOut,
  updateCurrentUser,
  updatePassword,
  UserAccountError,
} from '../src/lib/user-account.ts'

const env = (fetchImpl: typeof fetch) => ({ supabaseUrl: 'http://auth.test', anonKey: 'anon', fetchImpl })

describe('user account auth boundary', () => {
  it('structurally maps a current user', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      id: 'u1', email: 'ada@example.test', user_metadata: { first_name: 'Ada', last_name: 'Lovelace', display_name: 'Ada L.' },
    }))
    await expect(getCurrentUser(env(fetchImpl), 'jwt')).resolves.toEqual({
      id: 'u1', email: 'ada@example.test', firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada L.', pendingEmail: null,
    })
  })

  it('rejects malformed-but-parseable user data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: 42, email: [] }))
    await expect(getCurrentUser(env(fetchImpl), 'jwt')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('classifies an invalid session without exposing the response body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ secret: 'do-not-surface' }, { status: 401 }))
    await expect(getCurrentUser(env(fetchImpl), 'jwt')).rejects.toEqual(new UserAccountError('auth_error'))
  })

  it('updates email and profile metadata through the authenticated user endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      id: 'u1', email: 'old@example.test', new_email: 'new@example.test', user_metadata: { first_name: 'Grace', last_name: 'Hopper', display_name: 'Amazing Grace' },
    }))
    const result = await updateCurrentUser(env(fetchImpl), 'jwt', {
      email: 'new@example.test', firstName: 'Grace', lastName: 'Hopper', displayName: 'Amazing Grace',
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({ email: 'new@example.test', data: { first_name: 'Grace', last_name: 'Hopper', display_name: 'Amazing Grace' } })
    expect(result.pendingEmail).toBe('new@example.test')
  })

  it('requests recovery with an exact callback URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}))
    await requestPasswordRecovery(env(fetchImpl), 'ada@example.test', 'https://app.test/auth/callback')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://auth.test/auth/v1/recover?redirect_to=https%3A%2F%2Fapp.test%2Fauth%2Fcallback')
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ email: 'ada@example.test' }))
  })

  it('updates a password only with the supplied recovery session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ user: { id: 'u1' } }))
    await updatePassword(env(fetchImpl), 'recovery-jwt', 'correct horse battery staple')
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer recovery-jwt')
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ password: 'correct horse battery staple' }))
  })

  it('signs out the authenticated server session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}))
    await signOut(env(fetchImpl), 'jwt')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://auth.test/auth/v1/logout')
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST')
  })

  it('rejects a response that exceeds the buffer budget', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(65 * 1024) } })
    await expect(readBoundedJson(response)).rejects.toMatchObject({ code: 'response_too_large' })
  })
})
