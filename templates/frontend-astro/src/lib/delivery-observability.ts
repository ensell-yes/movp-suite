import {
  DeliveryArtifactError,
  DeliveryRenderError,
  type DeliveryArtifactErrorCode,
  type DeliveryRenderErrorCode,
} from '@movp/delivery'
import type { DeliveryErrorCode } from './delivery.ts'

type DeliveryRouteKind = 'page' | 'sitemap_index' | 'sitemap_child' | 'robots' | 'llms'
export type DeliverySafeErrorCode =
  | DeliveryArtifactErrorCode
  | DeliveryErrorCode
  | DeliveryRenderErrorCode
  | 'delivery_artifact_bounds_invalid'
  | 'delivery_artifact_not_found'
  | 'delivery_internal_error'
  | 'delivery_observability_write_failed'

type DeliveryEventBase = Readonly<{
  workspaceId?: string
  requestId: string
  startedAt: number
}>

export type DeliveryObservation =
  | (DeliveryEventBase & Readonly<{
      event: 'delivery.public_read'
      routeKind: 'page'
      outcome: 'found' | 'not_found'
    }>)
  | (DeliveryEventBase & Readonly<{
      event: 'delivery.public_read'
      routeKind: 'page'
      outcome: 'error'
      errorCode: DeliverySafeErrorCode
    }>)
  | (DeliveryEventBase & Readonly<{
      event: 'delivery.artifact'
      routeKind: Exclude<DeliveryRouteKind, 'page'>
      outcome: 'generated'
    }>)
  | (DeliveryEventBase & Readonly<{
      event: 'delivery.artifact'
      routeKind: Exclude<DeliveryRouteKind, 'page'>
      outcome: 'error'
      errorCode: DeliverySafeErrorCode
    }>)

export type DeliveryArtifactObservation = Extract<
  DeliveryObservation,
  Readonly<{ event: 'delivery.artifact' }>
>
export type DeliveryArtifactObservationInput =
  DeliveryArtifactObservation extends infer Observation
    ? Observation extends DeliveryArtifactObservation
      ? Omit<Observation, 'event'>
      : never
    : never

export type DeliveryLogRecord = Readonly<{
  event: 'delivery.public_read' | 'delivery.artifact'
  route_kind: DeliveryRouteKind
  workspace_id_hash?: string
  request_id: string
  outcome: 'found' | 'not_found' | 'generated' | 'error'
  error_code?: DeliverySafeErrorCode
  latency_ms: number
}>

type ObservabilityFailureRecord = Readonly<{
  event: 'delivery.observability_failure'
  request_id: string
  error_code: 'delivery_observability_write_failed'
}>

type DeliveryObservationDeps = Readonly<{
  now: () => number
  write: (record: DeliveryLogRecord) => void
  reportFailure: (record: ObservabilityFailureRecord) => void
}>

type DeliveryContextDeps = Readonly<{
  now: () => number
  randomUUID: () => string
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_LATENCY_MS = 24 * 60 * 60 * 1_000

const defaultObservationDeps: DeliveryObservationDeps = {
  now: () => Date.now(),
  write: (record) => console.log(JSON.stringify(record)),
  reportFailure: (record) => console.error(JSON.stringify(record)),
}

const defaultContextDeps: DeliveryContextDeps = {
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
}

function safeRequestId(value: string): string {
  return UUID_PATTERN.test(value) ? value : crypto.randomUUID()
}

function latency(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0
  return Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(now - startedAt)))
}

export async function hashWorkspaceId(workspaceId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(workspaceId))
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function createDeliveryRequestContext(
  deps: DeliveryContextDeps = defaultContextDeps,
): Readonly<{ requestId: string; startedAt: number }> {
  return {
    requestId: safeRequestId(deps.randomUUID()),
    startedAt: deps.now(),
  }
}

export async function recordDeliveryEvent(
  input: DeliveryObservation,
  deps: DeliveryObservationDeps = defaultObservationDeps,
): Promise<void> {
  const requestId = safeRequestId(input.requestId)
  try {
    const record: DeliveryLogRecord = {
      event: input.event,
      route_kind: input.routeKind,
      ...(input.workspaceId === undefined
        ? {}
        : { workspace_id_hash: await hashWorkspaceId(input.workspaceId) }),
      request_id: requestId,
      outcome: input.outcome,
      ...('errorCode' in input ? { error_code: input.errorCode } : {}),
      latency_ms: latency(input.startedAt, deps.now()),
    }
    deps.write(record)
  } catch {
    const failure: ObservabilityFailureRecord = {
      event: 'delivery.observability_failure',
      request_id: requestId,
      error_code: 'delivery_observability_write_failed',
    }
    try {
      deps.reportFailure(failure)
    } catch {
      console.error(JSON.stringify(failure))
    }
  }
}

export function deliveryFailureCode(error: unknown): DeliverySafeErrorCode {
  if (error instanceof DeliveryArtifactError || error instanceof DeliveryRenderError) {
    return error.code
  }
  return 'delivery_internal_error'
}

export async function finishDeliveryArtifact(
  response: Response,
  observation: DeliveryArtifactObservationInput,
): Promise<Response> {
  if (observation.outcome === 'generated') {
    await recordDeliveryEvent({ event: 'delivery.artifact', ...observation })
  } else {
    await recordDeliveryEvent({ event: 'delivery.artifact', ...observation })
  }
  return response
}
