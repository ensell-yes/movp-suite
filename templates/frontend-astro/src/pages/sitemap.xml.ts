import { generateSitemapIndex } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDeliveryShards } from '../lib/delivery.ts'
import {
  createDeliveryRequestContext,
  deliveryFailureCode,
  deliveryFailureStatus,
  finishDeliveryArtifact,
} from '../lib/delivery-observability.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async () => {
  const context = createDeliveryRequestContext()
  let observationWorkspaceId: string | undefined
  try {
    const { publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey } = readServerEnv()
    observationWorkspaceId = workspaceId
    const result = await listPublishedDeliveryShards({ workspaceId, supabaseUrl, supabaseAnonKey })
    if (result.status !== 'found') {
      return finishDeliveryArtifact(new Response('sitemap_unavailable\n', {
        status: deliveryFailureStatus(
          result.status === 'error' ? result.code : 'delivery_internal_error',
        ),
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      }), {
        routeKind: 'sitemap_index',
        outcome: 'error',
        errorCode: result.status === 'error' ? result.code : 'delivery_internal_error',
        workspaceId,
        requestId: context.requestId,
        startedAt: context.startedAt,
      })
    }
    return finishDeliveryArtifact(new Response(generateSitemapIndex(
      publicSiteUrl,
      result.value.map((shard) => shard.until),
    ), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    }), {
      routeKind: 'sitemap_index',
      outcome: 'generated',
      workspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  } catch (error: unknown) {
    return finishDeliveryArtifact(new Response('sitemap_unavailable\n', {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }), {
      routeKind: 'sitemap_index',
      outcome: 'error',
      errorCode: deliveryFailureCode(error),
      workspaceId: observationWorkspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  }
}
