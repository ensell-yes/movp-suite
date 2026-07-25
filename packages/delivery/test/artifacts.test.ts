import { describe, expect, it } from 'vitest'
import {
  DeliveryArtifactError,
  generateLlmsTxt,
  generateRobots,
  generateSitemap,
  generateSitemapIndex,
  MAX_LLMS_BYTES,
  MAX_LLMS_ENTRIES,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_URLS,
} from '../src/index.ts'
import type { DeliveryRoute } from '../src/index.ts'

const encoder = new TextEncoder()

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

function route(index: number): DeliveryRoute {
  return {
    contentType: 'blog',
    slug: `post-${String(index).padStart(5, '0')}`,
    title: `Post ${index}`,
    publishedAt: '2026-07-23T12:00:00.000Z',
  }
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
}

describe('delivery artifact generators', () => {
  it('emits deterministic robots and a valid empty sitemap', () => {
    expect(generateRobots('https://example.test')).toBe(
      'User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n',
    )
    expect(generateSitemap([], 'https://example.test')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    )
  })

  it('builds a bounded sitemap index from opaque shard descriptors', () => {
    const xml = generateSitemapIndex(
      'https://example.test',
      ['cursor_A', 'cursor_B'],
    )
    expect(locs(xml)).toEqual([
      'https://example.test/sitemap-cursor_A.xml',
      'https://example.test/sitemap-cursor_B.xml',
    ])
    expectArtifactCode(
      () => generateSitemapIndex('https://example.test', ['bad/cursor']),
      'delivery_shard_invalid',
    )
  })

  it('enforces sitemap row and escaped-byte protocol bounds', () => {
    expect(MAX_SITEMAP_URLS).toBe(4_000)
    expect(MAX_SITEMAP_BYTES).toBe(52_428_800)
    const full = generateSitemap(
      Array.from({ length: MAX_SITEMAP_URLS }, (_, index) => route(index)),
      'https://example.test',
    )
    expect(locs(full)).toHaveLength(MAX_SITEMAP_URLS)
    expect(encoder.encode(full).byteLength).toBeLessThan(MAX_SITEMAP_BYTES)
    expect(locs(full).every((url) => url.length < 2_048)).toBe(true)
    expectArtifactCode(
      () => generateSitemap(
        Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, index) => route(index)),
        'https://example.test',
      ),
      'delivery_sitemap_url_limit',
    )
  })

  it('partitions more than 50k snapshot URLs into valid, exact-once children', () => {
    const snapshot = Array.from({ length: 50_001 }, (_, index) => route(index))
    const children: DeliveryRoute[][] = []
    for (let index = 0; index < snapshot.length; index += MAX_SITEMAP_URLS) {
      children.push(snapshot.slice(index, index + MAX_SITEMAP_URLS))
    }
    const descriptors = children.map((_, index) => `snapshot_${index}`)
    const indexXml = generateSitemapIndex('https://example.test', descriptors)
    const childXml = children.map((entries) => generateSitemap(entries, 'https://example.test'))
    const allLocations = childXml.flatMap(locs)

    expect(descriptors).toHaveLength(13)
    expect(locs(indexXml)).toHaveLength(13)
    expect(childXml.every((xml) => locs(xml).length <= MAX_SITEMAP_URLS)).toBe(true)
    expect(childXml.every((xml) => encoder.encode(xml).byteLength < MAX_SITEMAP_BYTES)).toBe(true)
    expect(new Set(allLocations).size).toBe(snapshot.length)
    expect(allLocations).toHaveLength(snapshot.length)
  })

  it('keeps an old shard snapshot stable when a later item is published', () => {
    const snapshot = [route(1), route(2)]
    const oldChild = generateSitemap(snapshot, 'https://example.test')
    const afterPublish = [...snapshot, route(3)]
    expect(generateSitemap(snapshot, 'https://example.test')).toBe(oldChild)
    expect(locs(oldChild)).not.toContain('https://example.test/blog/post-00003')
    expect(locs(generateSitemap(afterPublish, 'https://example.test'))).toContain(
      'https://example.test/blog/post-00003',
    )
  })

  it('control-filters Markdown titles and caps llms.txt by entries and bytes', () => {
    expect(MAX_LLMS_ENTRIES).toBe(1_000)
    expect(MAX_LLMS_BYTES).toBe(1024 * 1024)
    const entries = Array.from({ length: MAX_LLMS_ENTRIES + 1 }, (_, index) => ({
      ...route(index),
      title: index === 0 ? '[Unsafe](javascript:alert(1))\nTitle' : `Post ${index}`,
    }))
    const output = generateLlmsTxt(entries, 'https://example.test')
    expect(output).toContain(
      '- [\\[Unsafe\\]\\(javascript:alert\\(1\\)\\) Title](https://example.test/blog/post-00000)',
    )
    expect(output).toContain(
      '- [More published content](https://example.test/sitemap.xml)',
    )
    expect(output).not.toContain('\nTitle]')
    expect(encoder.encode(output).byteLength).toBeLessThanOrEqual(MAX_LLMS_BYTES)
    expect(output.match(/^- \[/gm)?.length).toBe(MAX_LLMS_ENTRIES + 1)
  })
})
