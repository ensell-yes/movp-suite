import type { AstroCookies } from 'astro'

const COOKIE_NAME = 'sb-access-token'
export const DISPLAY_NAME_COOKIE = 'movp-display-name'

const MAX_JWT_PAYLOAD_BYTES = 8 * 1024
const MAX_DISPLAY_NAME_CODE_POINTS = 80
const MAX_DISPLAY_NAME_BYTES = 320

export type SessionDisplay = {
  email: string | null
  firstName: string | null
  lastName: string | null
  displayName: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maxCodePoints = MAX_DISPLAY_NAME_CODE_POINTS): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || Array.from(trimmed).length > maxCodePoints) return null
  if (new TextEncoder().encode(trimmed).byteLength > MAX_DISPLAY_NAME_BYTES) return null
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return null
  return trimmed
}

function decodeBase64Url(value: string): string | null {
  if (value.length === 0 || value.length > MAX_JWT_PAYLOAD_BYTES * 2) return null
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    if (binary.length > MAX_JWT_PAYLOAD_BYTES) return null
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export function decodeSessionDisplay(token: string): SessionDisplay | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  const json = decodeBase64Url(parts[1])
  if (!json) return null
  try {
    const claims: unknown = JSON.parse(json)
    if (!isRecord(claims)) return null
    const metadata = isRecord(claims.user_metadata) ? claims.user_metadata : {}
    const email = boundedText(claims.email, 254)
    const firstName = boundedText(metadata.first_name)
    const lastName = boundedText(metadata.last_name)
    const displayName = boundedText(metadata.display_name)
    return { email, firstName, lastName, displayName }
  } catch {
    return null
  }
}

export function sanitizeDisplayName(value: unknown): string | null {
  return boundedText(value)
}

export function encodeDisplayNameCookie(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function decodeDisplayNameCookie(value: string | undefined): string | null {
  if (!value || value.length > MAX_DISPLAY_NAME_BYTES * 2 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return sanitizeDisplayName(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export function getSessionToken(cookies: AstroCookies): string | null {
  const v = cookies.get(COOKIE_NAME)?.value
  return v && v.length > 0 ? v : null
}

export function getSessionDisplay(cookies: AstroCookies): SessionDisplay | null {
  const token = getSessionToken(cookies)
  if (!token) return null
  const display = decodeSessionDisplay(token)
  const cookieDisplayName = decodeDisplayNameCookie(cookies.get(DISPLAY_NAME_COOKIE)?.value)
  if (!display) {
    return cookieDisplayName
      ? { email: null, firstName: null, lastName: null, displayName: cookieDisplayName }
      : null
  }
  return cookieDisplayName ? { ...display, displayName: cookieDisplayName } : display
}
