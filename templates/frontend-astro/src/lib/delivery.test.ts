import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createDeliveryAssignmentKey,
  getPublishedBySlug,
  isDeliveryAssignmentKey,
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
      experiment_active: false,
      experiment_assignment_error_code: null,
    }))

    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      { assignmentKey: null, persistAssignment: false },
      fetcher,
    )

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
        experimentActive: false,
        experimentAssignmentErrorCode: null,
        experiment: null,
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
      p_assignment_key: null,
      p_persist_assignment: false,
    })
  })

  it('passes a bounded assignment key and validates experiment metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      item_id: ITEM_ID,
      content_type_key: 'article',
      slug: 'safe-page',
      published_revision_id: REVISION_ID,
      published_at: '2026-07-23T12:00:00Z',
      data: { title: 'Variant' },
      richtext_field_keys: [],
      richtext_field_keys_supported: true,
      meta: null,
      jsonld: null,
      experiment_active: true,
      experiment_assignment_error_code: null,
      experiment: {
        experiment_id: '44444444-4444-4444-8444-444444444444',
        experiment_key: 'safe-page-test',
        variant_id: '55555555-5555-4555-8555-555555555555',
        variant_key: 'variant-b',
      },
    }))

    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      {
        assignmentKey: `visitor_0000000001.${'a'.repeat(43)}`,
        persistAssignment: true,
      },
      fetcher,
    )

    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({
        experiment: {
          experimentId: '44444444-4444-4444-8444-444444444444',
          experimentKey: 'safe-page-test',
          variantId: '55555555-5555-4555-8555-555555555555',
          variantKey: 'variant-b',
        },
      }),
    })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      ws: env.workspaceId,
      p_content_type_key: 'article',
      p_slug: 'safe-page',
      p_assignment_key: `visitor_0000000001.${'a'.repeat(43)}`,
      p_persist_assignment: true,
    })
    await expect(getPublishedBySlug(
      env,
      'article',
      'safe-page',
      { assignmentKey: 'bad', persistAssignment: true },
      fetcher,
    )).resolves.toEqual({ status: 'error', code: 'delivery_request_invalid' })
  })

  it('mints only a workspace-bound signed assignment token shape', async () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )
    try {
      const assignmentKey = await createDeliveryAssignmentKey(
        env.workspaceId,
        'test-delivery-assignment-signing-key-000000000000000000000001',
      )

      expect(assignmentKey).toBe(
        '11111111-1111-4111-8111-111111111111.FQbrcE1eHCnJ3DnPuoi8mR_n4mpeL7mRmbxPIPf4nG0',
      )
      await expect(createDeliveryAssignmentKey(
        env.workspaceId.toUpperCase(),
        'test-delivery-assignment-signing-key-000000000000000000000001',
      )).resolves.toBe(assignmentKey)
      expect(isDeliveryAssignmentKey(assignmentKey)).toBe(true)
      expect(isDeliveryAssignmentKey('visitor_0000000001')).toBe(false)
    } finally {
      randomUuid.mockRestore()
    }
  })

  it('accepts the bounded unsigned assignment observation code', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      { assignmentKey: `visitor_0000000001.${'a'.repeat(43)}`, persistAssignment: false },
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        item_id: ITEM_ID,
        content_type_key: 'article',
        slug: 'safe-page',
        published_revision_id: REVISION_ID,
        published_at: '2026-07-23T12:00:00Z',
        data: { title: 'Variant' },
        richtext_field_keys: [],
        richtext_field_keys_supported: true,
        meta: null,
        jsonld: null,
        experiment_active: true,
        experiment_assignment_error_code: 'delivery_experiment_assignment_unsigned',
        experiment: {
          experiment_id: '44444444-4444-4444-8444-444444444444',
          experiment_key: 'safe-page-test',
          variant_id: '55555555-5555-4555-8555-555555555555',
          variant_key: 'variant-b',
        },
      })),
    )

    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({
        experimentAssignmentErrorCode: 'delivery_experiment_assignment_unsigned',
      }),
    })
  })

  it('returns indistinguishable not-found for a null published read', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'missing',
      { assignmentKey: null, persistAssignment: false },
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(null)),
    )
    expect(result).toEqual({ status: 'not_found' })
  })

  it('fails loudly when the RPC reports an unsupported rich-text field key', async () => {
    const result = await getPublishedBySlug(
      env,
      'article',
      'safe-page',
      { assignmentKey: null, persistAssignment: false },
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
      { assignmentKey: null, persistAssignment: false },
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
      { assignmentKey: null, persistAssignment: false },
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
      { assignmentKey: null, persistAssignment: false },
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
    expect(page).not.toContain("Astro.response.headers.set('Vary', 'Cookie')")
    expect(page).toContain('Astro.cookies.set(DELIVERY_ASSIGNMENT_COOKIE')
    expect(page).toContain('const persistAssignment = cookieAssignmentKey !== null')
    expect(page.indexOf('const result = await getPublishedBySlug')).toBeLessThan(
      page.indexOf('const signingKey = readDeliveryAssignmentSigningKey()'),
    )
    expect(page).toContain('if (experimentActive && shouldStoreAssignmentCookie)')
    expect(page).toContain("experimentAssignmentErrorCode = 'delivery_experiment_assignment_unsigned'")
    expect(page).toContain("state === 'found' && !experimentActive ? CACHE_SUCCESS : CACHE_FAILURE")
  })
})
