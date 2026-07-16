import { describe, expect, it } from 'vitest'
import type { CandidateResult } from '../src/index.ts'

describe('CandidateResult informational block IDs', () => {
  it('represents not-applicable editors as null', () => {
    const value: CandidateResult['blockIdPreserved'] = null
    expect(value).toBeNull()
  })
})
