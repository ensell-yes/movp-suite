import { generateSitemap, type DeliveryRoute } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDelivery, listPublishedDeliveryShards } from '../lib/delivery.ts'
import {
  createDeliveryRequestContext,
  deliveryFailureCode,
  deliveryFailureStatus,
  finishDeliveryArtifact,
} from '../lib/delivery-observability.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async ({ params }) => {
  const context = createDeliveryRequestContext()
  let observationWorkspaceId: string | undefined
  try {
    const { publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey } = readServerEnv()
    observationWorkspaceId = workspaceId
    const env = { workspaceId, supabaseUrl, supabaseAnonKey }
    const boundary = params.boundary ?? ''
    const shardResult = await listPublishedDeliveryShards(env)
    if (shardResult.status !== 'found') {
      return finishDeliveryArtifact(new Response('sitemap_unavailable\n', {
        status: deliveryFailureStatus(
          shardResult.status === 'error' ? shardResult.code : 'delivery_internal_error',
        ),
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      }), {
        routeKind: 'sitemap_child',
        outcome: 'error',
        errorCode: shardResult.status === 'error'
          ? shardResult.code
          : 'delivery_internal_error',
        workspaceId,
        requestId: context.requestId,
        startedAt: context.startedAt,
      })
    }
    const shard = shardResult.value.find((candidate) => candidate.until === boundary)
    if (!shard) {
      return finishDeliveryArtifact(new Response('not_found\n', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      }), {
        routeKind: 'sitemap_child',
        outcome: 'not_found',
        workspaceId,
        requestId: context.requestId,
        startedAt: context.startedAt,
      })
    }

    const routes: DeliveryRoute[] = []
    const seen = new Set<string>()
    let after = shard.after
    for (let requestCount = 0; requestCount < 4; requestCount += 1) {
      const page = await listPublishedDelivery(env, { after, until: shard.until, limit: 1_000 })
      if (page.status !== 'found') {
        return finishDeliveryArtifact(new Response('sitemap_unavailable\n', {
          status: deliveryFailureStatus(
            page.status === 'error' ? page.code : 'delivery_internal_error',
          ),
          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
        }), {
          routeKind: 'sitemap_child',
          outcome: 'error',
          errorCode: page.status === 'error' ? page.code : 'delivery_internal_error',
          workspaceId,
          requestId: context.requestId,
          startedAt: context.startedAt,
        })
      }
      for (const item of page.value.items) {
        if (seen.has(item.itemId) || routes.length >= 4_000) {
          return finishDeliveryArtifact(new Response('sitemap_bounds_invalid\n', {
            status: 500,
            headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
          }), {
            routeKind: 'sitemap_child',
            outcome: 'error',
            errorCode: 'delivery_artifact_bounds_invalid',
            workspaceId,
            requestId: context.requestId,
            startedAt: context.startedAt,
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
        return finishDeliveryArtifact(new Response(generateSitemap(routes, publicSiteUrl), {
          headers: {
            'Cache-Control': 'public, s-maxage=60',
            'Content-Type': 'application/xml; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
          },
        }), {
          routeKind: 'sitemap_child',
          outcome: 'generated',
          workspaceId,
          requestId: context.requestId,
          startedAt: context.startedAt,
        })
      }
      if (page.value.nextCursor === after) break
      after = page.value.nextCursor
    }
    return finishDeliveryArtifact(new Response('sitemap_bounds_invalid\n', {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }), {
      routeKind: 'sitemap_child',
      outcome: 'error',
      errorCode: 'delivery_artifact_bounds_invalid',
      workspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  } catch (error: unknown) {
    return finishDeliveryArtifact(new Response('sitemap_unavailable\n', {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }), {
      routeKind: 'sitemap_child',
      outcome: 'error',
      errorCode: deliveryFailureCode(error),
      workspaceId: observationWorkspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  }
}
