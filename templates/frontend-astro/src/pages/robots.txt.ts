import { generateRobots } from '@movp/delivery'
import type { APIRoute } from 'astro'
import {
  createDeliveryRequestContext,
  deliveryFailureCode,
  finishDeliveryArtifact,
} from '../lib/delivery-observability.ts'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async () => {
  const context = createDeliveryRequestContext()
  let observationWorkspaceId: string | undefined
  try {
    const { publicSiteUrl, workspaceId } = readServerEnv()
    observationWorkspaceId = workspaceId
    return finishDeliveryArtifact(new Response(generateRobots(publicSiteUrl), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    }), {
      routeKind: 'robots',
      outcome: 'generated',
      workspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  } catch (error: unknown) {
    return finishDeliveryArtifact(new Response('robots_unavailable\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    }), {
      routeKind: 'robots',
      outcome: 'error',
      errorCode: deliveryFailureCode(error),
      workspaceId: observationWorkspaceId,
      requestId: context.requestId,
      startedAt: context.startedAt,
    })
  }
}
