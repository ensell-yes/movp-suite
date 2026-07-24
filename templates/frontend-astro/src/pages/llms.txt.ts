import { generateLlmsTxt, type DeliveryRoute } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDelivery } from '../lib/delivery.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async () => {
  try {
    const { publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey } = readServerEnv()
    const env = { workspaceId, supabaseUrl, supabaseAnonKey }
    const first = await listPublishedDelivery(env, { after: null, until: null, limit: 1_000 })
    if (first.status !== 'found') {
      return new Response('llms_unavailable\n', {
        status: 502,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
    const routes: DeliveryRoute[] = first.value.items.map((item) => ({
      contentType: item.contentType,
      slug: item.slug,
      publishedAt: item.publishedAt,
    }))
    if (first.value.nextCursor !== null) {
      const sentinel = await listPublishedDelivery(env, {
        after: first.value.nextCursor,
        until: null,
        limit: 1,
      })
      if (sentinel.status !== 'found' || sentinel.value.items.length < 1) {
        return new Response('llms_unavailable\n', {
          status: 502,
          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      const item = sentinel.value.items[0]
      routes.push({
        contentType: item.contentType,
        slug: item.slug,
        publishedAt: item.publishedAt,
      })
    }
    return new Response(generateLlmsTxt(routes, publicSiteUrl), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('llms_unavailable\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
