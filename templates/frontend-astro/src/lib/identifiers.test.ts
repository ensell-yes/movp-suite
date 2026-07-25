import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UUID_PATTERN, UUID_PATTERN_SOURCE } from './identifiers.ts'

const UUID_LITERAL = '\\[1-5\\]\\[0-9a-f\\]\\{3\\}-\\[89ab\\]'

describe('frontend identifier contract', () => {
  it('accepts RFC variant UUIDs and rejects the previously write-only lax shape', () => {
    expect(UUID_PATTERN_SOURCE).toContain('[1-5][0-9a-f]{3}-[89ab]')
    expect(UUID_PATTERN.test('d1000000-0000-4000-8000-000000000001')).toBe(true)
    expect(UUID_PATTERN.test('d1000000-0000-0000-0000-000000000001')).toBe(false)
  })

  it('keeps delivery overlay routes on the shared validator', () => {
    for (const relative of [
      'src/components/delivery/overlay-bootstrap.ts',
      'src/lib/content-overlay.ts',
      'src/pages/api/content/[id]/capability.ts',
      'src/pages/api/content/[id]/richtext.ts',
    ]) {
      const path = join(process.cwd(), relative)
      const info = lstatSync(path)
      expect(info.isSymbolicLink()).toBe(false)
      expect(info.isFile()).toBe(true)
      expect(info.size).toBeLessThanOrEqual(256 * 1024)
      const source = readFileSync(path, 'utf8')
      expect(source).toContain('UUID_PATTERN')
      expect(source).not.toMatch(new RegExp(UUID_LITERAL, 'i'))
    }
  })
})
