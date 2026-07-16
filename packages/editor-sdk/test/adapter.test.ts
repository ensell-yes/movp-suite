import { describe, expect, it } from 'vitest'
import { INNER_CANONICAL_VERSION, tipTapAdapter } from '../src/adapter.ts'

const seedDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
}

describe('tipTapAdapter', () => {
  it('pins the canonical version', () => {
    expect(INNER_CANONICAL_VERSION).toBe(1)
  })
  it('decode("") yields an empty doc', () => {
    expect(tipTapAdapter.decode('')).toEqual({ type: 'doc', content: [] })
  })
  it('decode rejects malformed JSON with a stable code and no source echo', () => {
    expect(() => tipTapAdapter.decode('{not json')).toThrow('invalid_richtext_document')
    try {
      tipTapAdapter.decode('{not json SECRET')
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET')
    }
  })
  it('decode rejects a non-doc object (missing type, wrong type, non-array content)', () => {
    expect(() => tipTapAdapter.decode('{}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('{"type":"paragraph"}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('{"type":"doc"}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('42')).toThrow('invalid_richtext_document')
  })
  it('decode accepts a well-formed doc', () => {
    expect(tipTapAdapter.decode('{"type":"doc","content":[]}')).toEqual({ type: 'doc', content: [] })
  })
  it('encode(decode(x)) is byte-stable (zero-edit idempotency)', () => {
    const body = tipTapAdapter.encode(seedDoc)
    expect(tipTapAdapter.encode(tipTapAdapter.decode(body))).toBe(body)
  })
  it('encode is insensitive to inner key order', () => {
    const a = tipTapAdapter.encode({ type: 'doc', content: [], attrs: { b: 1, a: 2 } })
    const b = tipTapAdapter.encode({ attrs: { a: 2, b: 1 }, content: [], type: 'doc' })
    expect(a).toBe(b)
  })
})
