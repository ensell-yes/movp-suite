import { generateLlmsTxt, type DeliveryRoute } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { listPublishedDelivery } from '../lib/delivery.ts'
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
    const env = { workspaceId, supabaseUrl, supabaseAnonKey }
    const first = await listPublishedDelivery(env, { after: null, until: null, limit: 1_000 })
    if (first.status !== 'found') {
      return finishDeliveryArtifact(new Response('llms_unavailable\n', {
        status: deliveryFailureStatus(
          first.status === 'error' ? first.code : 'delivery_internal_error',
        ),
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      }), {
        routeKind: 'llms',
        outcome: 'error',
        errorCode: first.status === 'error' ? first.code : 'delivery_internal_error',
        workspaceId,
        requestId: context.requestId,
        startedAt: context.startedAt,
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
        return finishDeliveryArtifact(new Response('llms_unavailable\n', {
          status: deliveryFailureStatus(
            sentinel.status === 'error' ? sentinel.code : 'delivery_artifact_bounds_invalid',
          ),
          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
        }), {
          routeKind: 'llms',
          outcome: 'error',
          errorCode: sentinel.status === 'error'
            ? sentinel.code
            : 'delivery_artifact_bounds_invalid',
          workspaceId,
          requestId: context.requestId,
          startedAt: context.startedAt,
        })
      }
      const item = sentinel.value.items[0]
      routes.push({
        contentType: item.contentType,
        slug: item.slug,
        publishedAt: item.publishedAt,
      })
    }
    return finishDeliveryArtifact(new Response(generateLlmsTxt(routes, publicSiteUrl), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    }), {
      routeKind: 'llms',
      outcome: 'generated',
      workspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  } catch (error: unknown) {
    return finishDeliveryArtifact(new Response('llms_unavailable\n', {
      status: 500,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }), {
      routeKind: 'llms',
      outcome: 'error',
      errorCode: deliveryFailureCode(error),
      workspaceId: observationWorkspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  }
}
