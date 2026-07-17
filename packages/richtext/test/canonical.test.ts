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
    expect(() => canonicalizeInnerJson({ x: -Infinity })).toThrow(/canonical/)
  })
  it('rejects non-plain objects (Date, Map, class instances)', () => {
    class CustomValue { value = 1 }
    const customPrototype: unknown = Object.create({ inherited: true })
    expect(() => canonicalizeInnerJson({ x: new Date() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: new Map() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: new CustomValue() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: customPrototype })).toThrow(/canonical/)
  })
  it('accepts finite numbers, strings, booleans, null, nested arrays/objects', () => {
    expect(canonicalizeInnerJson({ n: 0, s: 'x', b: true, z: null, arr: [{ k: 1 }] }))
      .toBe('{"arr":[{"k":1}],"b":true,"n":0,"s":"x","z":null}')
  })
  it('rejects sparse arrays instead of silently converting holes', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => canonicalizeInnerJson(sparse)).toThrow(/canonical: undefined/)
  })
  it('rejects direct and indirect object and array cycles', () => {
    const directObject: Record<string, unknown> = {}
    directObject.self = directObject
    const directArray: unknown[] = []
    directArray.push(directArray)
    const indirectObject: Record<string, unknown> = {}
    const indirectArray: unknown[] = [indirectObject]
    indirectObject.array = indirectArray
    expect(() => canonicalizeInnerJson(directObject)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(directArray)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(indirectObject)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(indirectArray)).toThrow(/canonical: cycle/)
  })
  it('allows shared acyclic references', () => {
    const shared = { z: 1 }
    expect(canonicalizeInnerJson({ a: shared, b: shared })).toBe('{"a":{"z":1},"b":{"z":1}}')
  })
  it('accepts null-prototype objects', () => {
    const value = Object.create(null) as Record<string, unknown>
    value.b = 2
    value.a = 1
    expect(canonicalizeInnerJson(value)).toBe('{"a":1,"b":2}')
  })
  it('rejects top-level functions and symbols', () => {
    expect(() => canonicalizeInnerJson(() => true)).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson(Symbol('value'))).toThrow(/canonical/)
  })
})
