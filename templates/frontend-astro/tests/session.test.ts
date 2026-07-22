import { describe, expect, it } from 'vitest'
import {
  decodeDisplayNameCookie,
  decodeSessionDisplay,
  encodeDisplayNameCookie,
  sanitizeDisplayName,
} from '../src/lib/session.ts'

function token(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

describe('session display claims', () => {
  it('decodes bounded profile claims from a session JWT', () => {
    expect(decodeSessionDisplay(token({
      email: 'ada@example.test',
      user_metadata: { first_name: 'Ada', last_name: 'Lovelace', display_name: 'Ada L.' },
    }))).toEqual({ email: 'ada@example.test', firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada L.' })
  })

  it('returns null for a malformed token', () => {
    expect(decodeSessionDisplay('not-a-jwt')).toBeNull()
  })

  it('narrows malformed metadata without throwing', () => {
    expect(decodeSessionDisplay(token({ email: 42, user_metadata: ['bad'] }))).toEqual({
      email: null,
      firstName: null,
      lastName: null,
      displayName: null,
    })
  })

  it('rejects oversized JWT payloads before parsing', () => {
    expect(decodeSessionDisplay(`a.${'a'.repeat(20_000)}.b`)).toBeNull()
  })
})

describe('display-name cookie', () => {
  it('round-trips printable Unicode through cookie-safe encoding', () => {
    const encoded = encodeDisplayNameCookie('Renée & Team')
    expect(decodeDisplayNameCookie(encoded)).toBe('Renée & Team')
  })

  it('rejects control characters and overlong values', () => {
    expect(sanitizeDisplayName('line\r\nbreak')).toBeNull()
    expect(sanitizeDisplayName('x'.repeat(81))).toBeNull()
  })

  it('keeps markup as inert display text instead of treating it as HTML', () => {
    const payload = '<img src=x onerror="window.__displayNameXss=true">'
    expect(decodeDisplayNameCookie(encodeDisplayNameCookie(payload))).toBe(payload)
  })
})
