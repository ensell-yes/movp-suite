import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src https: data:; script-src 'self'; connect-src 'self'; style-src 'self'"

describe('published delivery headers', () => {
  it('pins the complete strict CSP source literal', () => {
    const path = join(process.cwd(), 'src/pages/[contentType]/[slug].astro')
    const info = lstatSync(path)
    expect(info.isSymbolicLink()).toBe(false)
    expect(info.isFile()).toBe(true)
    expect(info.size).toBeLessThanOrEqual(512 * 1024)
    const source = readFileSync(path, 'utf8')
    expect(source).toContain(`Astro.response.headers.set('Content-Security-Policy', ${JSON.stringify(CSP)})`)
    expect(source).not.toContain('style-src-attr')
  })
})
