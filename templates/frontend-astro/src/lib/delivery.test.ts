import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  getPublishedBySlug,
  listPublishedDelivery,
  listPublishedDeliveryShards,
  parseDeclaredPublishedRichText,
  parsePublishedRichText,
  type DeliveryPublicEnv,
} from './delivery.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const REVISION_ID = '22222222-2222-4222-8222-222222222222'
const env: DeliveryPublicEnv = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-key',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('published delivery adapter', () => {
  it('uses only the anonymous REST boundary and validates published content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      item_id: ITEM_ID,
      content_type_key: 'article',
      slug: 'safe-page',
      published_revision_id: REVISION_ID,
      published_at: '2026-07-23T12:00:00Z',
      data: {
        title: 'Safe page',
        body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Published"}]}]}',
        bodyHtml: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Camel"}]}]}',
      },
      richtext_field_keys: ['body', 'bodyHtml'],
      richtext_field_keys_supported: true,
      meta: { description: 'Description' },
      jsonld: { '@type': 'Article' },
    }))

    const result = await getPublishedBySlug(env, 'article', 'safe-page', fetcher)

    expect(result).toEqual({
      status: 'found',
      value: {
        itemId: ITEM_ID,
        contentType: 'article',
        slug: 'safe-page',
        publishedRevisionId: REVISION_ID,
        publishedAt: '2026-07-23T12:00:00Z',
        data: {
          title: 'Safe page',
          body: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Published"}]}]}',
          bodyHtml: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Camel"}]}]}',
        },
        richTextFieldKeys: ['body', 'bodyHtml'],
        meta: { description: 'Description' },
        jsonld: { '@type': 'Article' },
      },
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/get_published_by_slug',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'anon-key',
          authorization: 'Bearer anon-key',
        }),
      }),
    )
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      ws: env.workspaceId,
      p_content_type_key: 'article',
      p_slug: 'safe-page',
    })
  })

  it('returns indistinguishable not-found for a null published read', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'missing',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(null)),
    )
    expect(result).toEqual({ status: 'not_found' })
  })

  it('fails loudly when the RPC reports an unsupported rich-text field key', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        item_id: ITEM_ID,
        content_type_key: 'article',
        slug: 'safe-page',
        published_revision_id: REVISION_ID,
        published_at: '2026-07-23T12:00:00Z',
        data: { 'Body.Dot': '{"type":"doc","content":[]}' },
        richtext_field_keys: [],
        richtext_field_keys_supported: false,
        meta: null,
        jsonld: null,
      })),
    )
    expect(result).toEqual({
      status: 'error',
      code: 'delivery_richtext_field_key_unsupported',
    })
  })

  it('uses the unsupported-key code when the RPC support proof is absent', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        item_id: ITEM_ID,
        content_type_key: 'article',
        slug: 'safe-page',
        published_revision_id: REVISION_ID,
        published_at: '2026-07-23T12:00:00Z',
        data: { body: '{"type":"doc","content":[]}' },
        richtext_field_keys: ['body'],
        meta: null,
        jsonld: null,
      })),
    )
    expect(result).toEqual({
      status: 'error',
      code: 'delivery_richtext_field_key_unsupported',
    })
  })

  it('rejects wrong content types and oversized streamed bodies before parsing', async () => {
    const wrongType = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
        headers: { 'content-type': 'text/plain' },
      })),
    )
    expect(wrongType).toEqual({ status: 'error', code: 'delivery_upstream_content_type' })

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_300_000))
        controller.close()
      },
    })
    const tooLarge = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(oversized, {
        headers: { 'content-type': 'application/json' },
      })),
    )
    expect(tooLarge).toEqual({ status: 'error', code: 'delivery_upstream_too_large' })
  })

  it('validates list items and shard boundaries from unknown JSON', async () => {
    const listFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [{
        item_id: ITEM_ID,
        content_type_key: 'article',
        slug: 'safe-page',
        published_revision_id: REVISION_ID,
        published_at: '2026-07-23T12:00:00Z',
      }],
      next_cursor: null,
    }))
    const listed = await listPublishedDelivery(env, {
      after: null,
      until: 'djE6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx',
      limit: 1_000,
    }, listFetcher)
    expect(listed.status).toBe('found')

    const shardFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([{
      after: null,
      until: 'djE6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx',
      count: 1,
    }]))
    const shards = await listPublishedDeliveryShards(env, shardFetcher)
    expect(shards).toEqual({
      status: 'found',
      value: [{
        after: null,
        until: 'djE6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx',
        count: 1,
      }],
    })
  })

  it('recognizes only bounded canonical rich-text strings', () => {
    expect(parsePublishedRichText(
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Published"}]}]}',
    )).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Published' }] }],
    })
    expect(parsePublishedRichText('ordinary text')).toBeNull()
    expect(parsePublishedRichText(`{"type":"doc","content":[]}${' '.repeat(1_100_000)}`)).toBeNull()
  })

  it('parses doc-shaped JSON only for a declared rich-text field', () => {
    const doc = '{"type":"doc","content":[{"type":"paragraph"}]}'
    expect(parseDeclaredPublishedRichText(doc, 'body', ['body'])).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
    expect(parseDeclaredPublishedRichText(doc, 'bodyHtml', ['bodyHtml'])).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
    expect(parseDeclaredPublishedRichText(doc, 'lookalike', ['body'])).toBeNull()
  })
})

describe('published delivery route boundaries', () => {
  it('keeps request env request-scoped, has one renderer sink, and imports no editor code', async () => {
    const files = [
      'src/lib/delivery.ts',
      'src/pages/[contentType]/[slug].astro',
      'src/pages/sitemap.xml.ts',
      'src/pages/sitemap-[boundary].xml.ts',
      'src/pages/robots.txt.ts',
      'src/pages/llms.txt.ts',
    ]
    const sources = await Promise.all(files.map((path) => readFile(`${ROOT}/${path}`, 'utf8')))
    const joined = sources.join('\n')
    const page = sources[1] ?? ''

    expect(joined).not.toContain('process.env')
    expect(joined).not.toMatch(/@movp\/editor-sdk|@tiptap\//)
    expect(joined.match(/readServerEnv\(\)/g)?.length).toBeGreaterThanOrEqual(4)
    expect(page.match(/set:html=/g)).toHaveLength(1)
    expect(page).toContain('renderDocToHtml')
    expect(page).toContain("const CACHE_SUCCESS = 'public, s-maxage=60'")
    expect(page).toContain("const CACHE_FAILURE = 'no-store'")
  })
})
