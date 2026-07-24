import { generateSitemapIndex } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDeliveryShards } from '../lib/delivery.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async () => {
  try {
    const { publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey } = readServerEnv()
    const result = await listPublishedDeliveryShards({ workspaceId, supabaseUrl, supabaseAnonKey })
    if (result.status !== 'found') {
      return new Response('sitemap_unavailable\n', {
        status: result.status === 'error' && result.code === 'delivery_shards_timeout' ? 503 : 502,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
    return new Response(generateSitemapIndex(
      publicSiteUrl,
      result.value.map((shard) => shard.until),
    ), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('sitemap_unavailable\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
