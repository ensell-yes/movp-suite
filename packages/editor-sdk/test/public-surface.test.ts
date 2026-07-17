import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.ts'

describe('public surface', () => {
  it('exports the documented editor SDK surface', () => {
    expect(typeof sdk.MovpEditor).toBe('function')
    expect(typeof sdk.Toolbar).toBe('function')
    expect(typeof sdk.ConflictSurface).toBe('function')
    expect(typeof sdk.canonicalizeInnerJson).toBe('function')
    expect(typeof sdk.classifySaveOutcome).toBe('function')
    expect(sdk.INNER_CANONICAL_VERSION).toBe(1)
    expect(typeof sdk.tipTapAdapter.encode).toBe('function')
    expect(typeof sdk.tipTapAdapter.decode).toBe('function')
  })
})
