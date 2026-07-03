import { describe, expect, it } from 'vitest'
import { auditSeo } from '../src/seo-audit'

describe('auditSeo', () => {
  it('passes every rule for a well-formed item', () => {
    const result = auditSeo({
      data: {
        title: 'A Perfectly Reasonable Title',
        answer: 'Yes, here is the direct answer.',
        faqs: [{ q: 'Q?', a: 'A.' }],
      },
      meta: { description: 'x'.repeat(120), canonical: 'https://example.com/a' },
      jsonld: { '@context': 'https://schema.org', '@type': 'Article' },
      referencedAssets: [{ alt_text: 'a chart' }],
    })

    expect(result.score).toBe(100)
    expect(result.checklist.every((check) => check.pass)).toBe(true)
  })

  it('fails checks and lowers the score for a bare item', () => {
    const result = auditSeo({ data: {}, meta: null, jsonld: null, referencedAssets: [{ alt_text: null }] })

    expect(result.score).toBeLessThan(100)
    expect(result.checklist.find((check) => check.rule === 'canonical_present')?.pass).toBe(false)
    expect(result.checklist.find((check) => check.rule === 'alt_text_coverage')?.pass).toBe(false)
  })
})
