import type { AstroCookies } from 'astro'

const COOKIE_NAME = 'sb-access-token'

export function getSessionToken(cookies: AstroCookies): string | null {
  const v = cookies.get(COOKIE_NAME)?.value
  return v && v.length > 0 ? v : null
}
