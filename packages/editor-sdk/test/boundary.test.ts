import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const MAX_FILE_BYTES = 512 * 1024

// A forbidden module specifier in any import form is a quoted string; this also catches subpaths.
const FORBIDDEN =
  /['"](@movp\/(auth|domain|graphql)(\/[^'"]*)?|@supabase[^'"]*|packages\/domain[^'"]*)['"]|service_role|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/

function walkRegularFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) throw new Error(`boundary: refusing to scan a symlink: ${p}`)
    if (st.isDirectory()) out.push(...walkRegularFiles(p))
    else if (st.isFile() && /\.(ts|tsx)$/.test(name)) {
      if (st.size > MAX_FILE_BYTES) throw new Error(`boundary: ${p} exceeds size bound`)
      out.push(p)
    }
  }
  return out
}

describe('client boundary', () => {
  it('no src file imports server-only modules or references service-role tokens', () => {
    const offenders = walkRegularFiles(SRC).filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
