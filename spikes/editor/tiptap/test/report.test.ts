import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readTextBounded } from '../../scripts/lib/safe-io.mjs'
import { physicalLineCount } from '../scripts/report-lib.ts'

describe('TipTap report measurements', () => {
  it('does not count a trailing newline as a physical toolbar line', () => {
    expect(physicalLineCount('first\nsecond\n')).toBe(2)
    expect(physicalLineCount('first\nsecond')).toBe(2)
    expect(physicalLineCount('')).toBe(0)
  })
  it('pins the current parity toolbar to 19 physical lines', () => {
    const toolbar = fileURLToPath(new URL('../src/toolbar.tsx', import.meta.url))
    expect(physicalLineCount(readTextBounded(toolbar))).toBe(19)
  })
})
