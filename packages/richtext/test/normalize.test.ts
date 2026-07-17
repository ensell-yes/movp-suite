import { describe, expect, it } from 'vitest'
import { canonicalizeInnerJson } from '../src/canonical.ts'
import { docToPlainText, isDocShape, normalizeToCanonicalDoc } from '../src/normalize.ts'

const EMPTY = canonicalizeInnerJson({ type: 'doc', content: [] })
const para = (text: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('isDocShape', () => {
  it('accepts a doc, rejects non-docs', () => {
    expect(isDocShape({ type: 'doc', content: [] })).toBe(true)
    expect(isDocShape({ type: 'paragraph' })).toBe(false)
    expect(isDocShape('x')).toBe(false)
  })
})

describe('docToPlainText', () => {
  it('concatenates text nodes, not markup', () => {
    const doc = { type: 'doc', content: [
      { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
    ] }
    const out = docToPlainText(doc)
    expect(out).toContain('Title')
    expect(out).toContain('Hello world')
    expect(out).not.toContain('"type"')
  })
  it('separates blocks by exactly one space and concatenates adjacent inline text', () => {
    const doc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
    ] }
    expect(docToPlainText(doc)).toBe('ab c')
  })
})

describe('normalizeToCanonicalDoc', () => {
  it('empty string -> canonical empty doc', () => {
    expect(normalizeToCanonicalDoc('')).toBe(EMPTY)
  })
  it('valid doc-JSON -> canonicalized (idempotent on canonical input)', () => {
    const s = canonicalizeInnerJson(para('hi'))
    expect(normalizeToCanonicalDoc(s)).toBe(s)
  })
  it('plain text -> one escaped-text paragraph', () => {
    expect(normalizeToCanonicalDoc('hello')).toBe(canonicalizeInnerJson(para('hello')))
  })
  it('legacy HTML -> literal text paragraph (not parsed)', () => {
    expect(normalizeToCanonicalDoc('<p>x</p>')).toBe(canonicalizeInnerJson(para('<p>x</p>')))
  })
  it('non-string throws richtext_value_not_a_string', () => {
    expect(() => normalizeToCanonicalDoc(42 as unknown)).toThrow('richtext_value_not_a_string')
    expect(() => normalizeToCanonicalDoc(null as unknown)).toThrow('richtext_value_not_a_string')
  })
  it('parity: normalize is idempotent on canonicalizeInnerJson output', () => {
    const s = canonicalizeInnerJson(para('round trip'))
    expect(normalizeToCanonicalDoc(s)).toBe(s)
  })
})
