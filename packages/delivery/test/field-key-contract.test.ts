import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DELIVERY_FIELD_KEY_PATTERN_SOURCE } from '../src/index.ts'

const MAX_MIGRATION_BYTES = 256 * 1024
const MIGRATION = fileURLToPath(new URL(
  '../../../supabase/migrations/20260723000001_content_delivery_reads.sql',
  import.meta.url,
))

describe('delivery field-key contract', () => {
  it('pins both SQL projection predicates to the renderer pattern', async () => {
    const entry = await lstat(MIGRATION)
    expect(entry.isSymbolicLink()).toBe(false)
    expect(entry.isFile()).toBe(true)
    expect(entry.size).toBeLessThanOrEqual(MAX_MIGRATION_BYTES)

    const source = await readFile(MIGRATION, 'utf8')
    const patterns = Array.from(
      source.matchAll(/field\.value->>'name'\s*~\s*'([^']+)'/g),
      (match) => match[1],
    )
    expect(patterns).toHaveLength(2)
    expect(patterns).toEqual([
      DELIVERY_FIELD_KEY_PATTERN_SOURCE,
      DELIVERY_FIELD_KEY_PATTERN_SOURCE,
    ])
  })
})
