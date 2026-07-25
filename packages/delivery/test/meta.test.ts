import { describe, expect, it } from 'vitest'
import {
  canonicalUrl,
  DeliveryArtifactError,
  generateJsonLd,
} from '../src/index.ts'

function expectArtifactCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DeliveryArtifactError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected artifact error ${code}`)
}

describe('canonical delivery metadata', () => {
  it('builds configured-origin URLs and percent-encodes each segment once', () => {
    expect(canonicalUrl('https://example.test', {
      contentType: 'blog',
      slug: 'café news',
    })).toBe('https://example.test/blog/caf%C3%A9%20news')
    expect(canonicalUrl('https://example.test/', {
      contentType: 'release-notes',
      slug: 'already%20encoded',
    })).toBe('https://example.test/release-notes/already%2520encoded')
    expect(canonicalUrl('http://127.0.0.1:4321', {
      contentType: 'blog',
      slug: 'local',
    })).toBe('http://127.0.0.1:4321/blog/local')
  })

  it('rejects insecure remote, cross-origin-shaped, credentialed, and pathful bases', () => {
    expectArtifactCode(
      () => canonicalUrl('http://example.test', { contentType: 'blog', slug: 'x' }),
      'delivery_origin_invalid',
    )
    expectArtifactCode(
      () => canonicalUrl('https://example.test/base', { contentType: 'blog', slug: 'x' }),
      'delivery_origin_invalid',
    )
    expectArtifactCode(
      () => canonicalUrl('https://user:pass@example.test', { contentType: 'blog', slug: 'x' }),
      'delivery_origin_invalid',
    )
    expectArtifactCode(
      () => canonicalUrl('https://example.test', {
        contentType: 'https://evil.test',
        slug: 'x',
      }),
      'delivery_route_invalid',
    )
  })

  it('serializes JSON-LD without a script-closing sequence or line-separator hazard', () => {
    const result = generateJsonLd({
      '@context': 'https://schema.org',
      headline: '</script><script>alert("x")</script>',
      separators: '\u2028\u2029',
    })
    expect(result).toBe(
      '{"@context":"https://schema.org","headline":"\\u003c/script>\\u003cscript>alert(\\"x\\")\\u003c/script>","separators":"\\u2028\\u2029"}',
    )
    expect(result).not.toContain('<')
    expect(result).not.toContain('\u2028')
    expect(result).not.toContain('\u2029')
  })

  it('rejects cyclic, non-JSON, non-finite, and excessive JSON-LD values', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expectArtifactCode(() => generateJsonLd(cyclic), 'delivery_jsonld_invalid')
    expectArtifactCode(() => generateJsonLd({ value: undefined }), 'delivery_jsonld_invalid')
    expectArtifactCode(() => generateJsonLd({ value: Number.POSITIVE_INFINITY }), 'delivery_jsonld_invalid')
    expectArtifactCode(() => generateJsonLd(new Date()), 'delivery_jsonld_invalid')
    expectArtifactCode(
      () => generateJsonLd({ value: 'x'.repeat(1024 * 1024) }),
      'delivery_jsonld_too_large',
    )
  })
})
