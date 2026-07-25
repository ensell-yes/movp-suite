import { describe, expect, it } from 'vitest'
import * as delivery from '../src/index.ts'

describe('@movp/delivery public surface', () => {
  it('exports only the approved delivery runtime contract', () => {
    expect(Object.keys(delivery).sort()).toEqual([
      'DELIVERY_FIELD_KEY_PATTERN_SOURCE',
      'DELIVERY_MARK_TYPES',
      'DELIVERY_MAX_DEPTH',
      'DELIVERY_MAX_NODES',
      'DELIVERY_MAX_TEXT_BYTES',
      'DELIVERY_NODE_TYPES',
      'DeliveryArtifactError',
      'DeliveryRenderError',
      'MAX_JSON_LD_BYTES',
      'MAX_LLMS_BYTES',
      'MAX_LLMS_ENTRIES',
      'MAX_SITEMAP_BYTES',
      'MAX_SITEMAP_INDEX_ENTRIES',
      'MAX_SITEMAP_URLS',
      'canonicalUrl',
      'generateJsonLd',
      'generateLlmsTxt',
      'generateRobots',
      'generateSitemap',
      'generateSitemapIndex',
      'isDeliveryFieldKey',
      'renderDocToHtml',
    ])
  })
})
