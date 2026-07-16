import { describe, expect, it } from 'vitest'
import { canonicalizeInnerJson } from '../src/canonical.ts'

describe('canonicalizeInnerJson (§5.2)', () => {
  it('sorts object keys recursively and preserves array order', () => {
    const a = canonicalizeInnerJson({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] })
    const b = canonicalizeInnerJson({ list: [3, 1, 2], a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1,"list":[3,1,2]}')
  })
  it('emits compact output', () => {
    expect(canonicalizeInnerJson({ x: 1 })).toBe('{"x":1}')
  })
  it('rejects undefined, bigint, non-finite numbers', () => {
    expect(() => canonicalizeInnerJson({ x: undefined })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: 10n })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: NaN })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: Infinity })).toThrow(/canonical/)
  })
  it('rejects non-plain objects (Date, Map, class instances)', () => {
    expect(() => canonicalizeInnerJson({ x: new Date() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: new Map() })).toThrow(/canonical/)
  })
  it('accepts finite numbers, strings, booleans, null, nested arrays/objects', () => {
    expect(canonicalizeInnerJson({ n: 0, s: 'x', b: true, z: null, arr: [{ k: 1 }] }))
      .toBe('{"arr":[{"k":1}],"b":true,"n":0,"s":"x","z":null}')
  })
})
