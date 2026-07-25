import { canonicalUrl, normalizeDeliveryOrigin } from './meta.ts'
import {
  DeliveryArtifactError,
  type DeliveryArtifactErrorCode,
  type DeliveryRoute,
} from './types.ts'

export const MAX_SITEMAP_URLS = 4_000
export const MAX_SITEMAP_BYTES = 52_428_800
export const MAX_SITEMAP_INDEX_ENTRIES = 50_000
export const MAX_LLMS_ENTRIES = 1_000
export const MAX_LLMS_BYTES = 1024 * 1024

const MAX_SITEMAP_LOCATION_LENGTH = 2_048
const MAX_SHARD_BYTES = 256
const MAX_LLMS_TITLE_BYTES = 512
const SHARD_PATTERN = /^[A-Za-z0-9_-]+$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const encoder = new TextEncoder()

function fail(code: DeliveryArtifactErrorCode): never {
  throw new DeliveryArtifactError(code)
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function assertFitsSitemap(outputBytes: number, token: string): number {
  const nextBytes = outputBytes + encoder.encode(token).byteLength
  if (nextBytes >= MAX_SITEMAP_BYTES) fail('delivery_sitemap_byte_limit')
  return nextBytes
}

function validPublishedAt(value: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf())
}

export function generateSitemap(
  entries: readonly DeliveryRoute[],
  origin: string,
): string {
  if (!Array.isArray(entries)) fail('delivery_sitemap_url_invalid')
  if (entries.length > MAX_SITEMAP_URLS) fail('delivery_sitemap_url_limit')

  const prefix = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  const suffix = '</urlset>'
  const chunks: string[] = [prefix]
  let bytes = encoder.encode(prefix).byteLength
  const seen = new Set<string>()

  for (const entry of entries) {
    const location = canonicalUrl(origin, entry)
    if (location.length >= MAX_SITEMAP_LOCATION_LENGTH) {
      fail('delivery_sitemap_url_invalid')
    }
    if (seen.has(location)) fail('delivery_sitemap_duplicate')
    seen.add(location)

    let body = `<loc>${xmlEscape(location)}</loc>`
    if (entry.publishedAt !== undefined) {
      if (typeof entry.publishedAt !== 'string' || !validPublishedAt(entry.publishedAt)) {
        fail('delivery_sitemap_url_invalid')
      }
      body += `<lastmod>${xmlEscape(entry.publishedAt)}</lastmod>`
    }
    const token = `<url>${body}</url>`
    bytes = assertFitsSitemap(bytes, token)
    chunks.push(token)
  }

  assertFitsSitemap(bytes, suffix)
  chunks.push(suffix)
  return chunks.join('')
}

function sitemapChildUrl(origin: string, shard: string): string {
  const normalizedOrigin = normalizeDeliveryOrigin(origin)
  if (
    typeof shard !== 'string'
    || encoder.encode(shard).byteLength < 1
    || encoder.encode(shard).byteLength > MAX_SHARD_BYTES
    || !SHARD_PATTERN.test(shard)
  ) {
    fail('delivery_shard_invalid')
  }
  return `${normalizedOrigin}/sitemap-${encodeURIComponent(shard)}.xml`
}

export function generateSitemapIndex(
  origin: string,
  shards: readonly string[],
): string {
  if (!Array.isArray(shards) || shards.length > MAX_SITEMAP_INDEX_ENTRIES) {
    fail('delivery_sitemap_index_limit')
  }

  const prefix = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  const suffix = '</sitemapindex>'
  const chunks: string[] = [prefix]
  let bytes = encoder.encode(prefix).byteLength
  const seen = new Set<string>()

  for (const shard of shards) {
    const location = sitemapChildUrl(origin, shard)
    if (seen.has(location)) fail('delivery_shard_invalid')
    seen.add(location)
    const token = `<sitemap><loc>${xmlEscape(location)}</loc></sitemap>`
    bytes = assertFitsSitemap(bytes, token)
    chunks.push(token)
  }

  assertFitsSitemap(bytes, suffix)
  chunks.push(suffix)
  return chunks.join('')
}

export function generateRobots(origin: string): string {
  const normalizedOrigin = normalizeDeliveryOrigin(origin)
  return `User-agent: *\nAllow: /\nSitemap: ${normalizedOrigin}/sitemap.xml\n`
}

function truncateUtf8(value: string, limit: number): string {
  let bytes = 0
  let output = ''
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > limit) break
    bytes += characterBytes
    output += character
  }
  return output
}

function markdownTitle(route: DeliveryRoute): string {
  if (route.title !== undefined && typeof route.title !== 'string') {
    fail('delivery_llms_invalid')
  }
  const raw = route.title ?? route.slug
  const filtered = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const bounded = truncateUtf8(filtered || route.slug, MAX_LLMS_TITLE_BYTES)
  return bounded
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
}

export function generateLlmsTxt(
  entries: readonly DeliveryRoute[],
  origin: string,
): string {
  if (!Array.isArray(entries)) fail('delivery_llms_invalid')
  const normalizedOrigin = normalizeDeliveryOrigin(origin)
  const header = '# Published content\n\n'
  const pointer = `- [More published content](${normalizedOrigin}/sitemap.xml)\n`
  const chunks: string[] = [header]
  let bytes = encoder.encode(header).byteLength
  let truncated = entries.length > MAX_LLMS_ENTRIES
  const count = Math.min(entries.length, MAX_LLMS_ENTRIES)

  for (let index = 0; index < count; index += 1) {
    const entry = entries[index]
    const line = `- [${markdownTitle(entry)}](${canonicalUrl(normalizedOrigin, entry)})\n`
    const lineBytes = encoder.encode(line).byteLength
    const pointerBytes = encoder.encode(pointer).byteLength
    if (bytes + lineBytes + pointerBytes > MAX_LLMS_BYTES) {
      truncated = true
      break
    }
    chunks.push(line)
    bytes += lineBytes
  }

  if (truncated) {
    if (bytes + encoder.encode(pointer).byteLength > MAX_LLMS_BYTES) {
      fail('delivery_llms_invalid')
    }
    chunks.push(pointer)
  }
  return chunks.join('')
}
