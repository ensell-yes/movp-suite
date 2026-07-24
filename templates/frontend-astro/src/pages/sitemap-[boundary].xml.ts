import { generateSitemap, type DeliveryRoute } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDelivery, listPublishedDeliveryShards } from '../lib/delivery.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async ({ params }) => {
  try {
    const { publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey } = readServerEnv()
    const env = { workspaceId, supabaseUrl, supabaseAnonKey }
    const boundary = params.boundary ?? ''
    const shardResult = await listPublishedDeliveryShards(env)
    if (shardResult.status !== 'found') {
      return new Response('sitemap_unavailable\n', {
        status: shardResult.status === 'error' && shardResult.code === 'delivery_shards_timeout' ? 503 : 502,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
    const shard = shardResult.value.find((candidate) => candidate.until === boundary)
    if (!shard) {
      return new Response('not_found\n', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    const routes: DeliveryRoute[] = []
    const seen = new Set<string>()
    let after = shard.after
    for (let requestCount = 0; requestCount < 4; requestCount += 1) {
      const page = await listPublishedDelivery(env, { after, until: shard.until, limit: 1_000 })
      if (page.status !== 'found') {
        return new Response('sitemap_unavailable\n', {
          status: 502,
          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      for (const item of page.value.items) {
        if (seen.has(item.itemId) || routes.length >= 4_000) {
          return new Response('sitemap_bounds_invalid\n', {
            status: 502,
            headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
          })
        }
        seen.add(item.itemId)
        routes.push({
          contentType: item.contentType,
          slug: item.slug,
          publishedAt: item.publishedAt,
        })
      }
      if (page.value.nextCursor === null) {
        return new Response(generateSitemap(routes, publicSiteUrl), {
          headers: {
            'Cache-Control': 'public, s-maxage=60',
            'Content-Type': 'application/xml; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      if (page.value.nextCursor === after) break
      after = page.value.nextCursor
    }
    return new Response('sitemap_bounds_invalid\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch {
    return new Response('sitemap_unavailable\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
