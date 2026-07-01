import { describe, expect, it } from 'vitest'
import { chunkText, FakeEmbeddingProvider } from '../src/index.ts'

describe('chunkText', () => {
  it('returns [] for empty or whitespace', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n ')).toEqual([])
  })

  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hello world. Short note.')).toEqual(['Hello world. Short note.'])
  })

  it('splits long text into bounded chunks with overlap', () => {
    const sentences = Array.from({ length: 60 }, (_v, i) => `Sentence number ${i} has some filler words here.`)
    const chunks = chunkText(sentences.join(' '), { tokens: 50, overlapPct: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.split(/\s+/).length).toBeLessThanOrEqual(50)
    const firstTail = chunks[0]!.split(/\s+/).slice(-5).join(' ')
    expect(chunks[1]).toContain(firstTail.split(/\s+/)[0])
  })

  it('keeps a phrase after the first chunk reachable', () => {
    const filler = Array.from({ length: 40 }, (_v, i) => `Filler sentence ${i}.`).join(' ')
    const chunks = chunkText(`${filler} The unique marker phrase appears here near the end.`, {
      tokens: 50,
      overlapPct: 15,
    })
    expect(chunks.some((c) => c.includes('unique marker phrase'))).toBe(true)
    expect(chunks[0]!.includes('unique marker phrase')).toBe(false)
  })
})

describe('FakeEmbeddingProvider', () => {
  it('returns a deterministic normalized 384-d vector', async () => {
    const p = new FakeEmbeddingProvider()
    const a = await p.embed('hello')
    const b = await p.embed('hello')
    expect(a).toHaveLength(384)
    expect(a).toEqual(b)
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })
})
