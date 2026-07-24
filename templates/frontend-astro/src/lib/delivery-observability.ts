import {
  DeliveryArtifactError,
  DeliveryRenderError,
  type DeliveryArtifactErrorCode,
  type DeliveryRenderErrorCode,
} from '@movp/delivery'
import { REDACTION_VERSION } from '@movp/obs'
import type { DeliveryErrorCode } from './delivery.ts'

type DeliveryRouteKind = 'page' | 'sitemap_index' | 'sitemap_child' | 'robots' | 'llms'
type DeliveryArtifactRouteKind = Exclude<DeliveryRouteKind, 'page'>
export type DeliverySafeErrorCode =
  | DeliveryArtifactErrorCode
  | DeliveryErrorCode
  | DeliveryRenderErrorCode
  | 'delivery_artifact_bounds_invalid'
  | 'delivery_internal_error'
  | 'delivery_observability_write_failed'

type DeliveryEventBase = Readonly<{
  workspaceId?: string
  requestId: string
  startedAt: number
}>

export type DeliveryArtifactObservationInput =
  | (DeliveryEventBase & Readonly<{
      routeKind: DeliveryArtifactRouteKind
      outcome: 'generated' | 'not_found'
    }>)
  | (DeliveryEventBase & Readonly<{
      routeKind: DeliveryArtifactRouteKind
      outcome: 'error'
      errorCode: DeliverySafeErrorCode
    }>)

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
  | (DeliveryArtifactObservationInput & Readonly<{ event: 'delivery.artifact' }>)

export type DeliveryLogRecord = Readonly<{
  event: 'delivery.public_read' | 'delivery.artifact'
  surface: 'delivery'
  route_kind: DeliveryRouteKind
  workspace_id_hash?: string
  request_id: string
  outcome: 'found' | 'not_found' | 'generated' | 'error'
  error_code?: DeliverySafeErrorCode
  latency_ms: number
  redaction_version: number
}>

type ObservabilityFailureRecord = Readonly<{
  event: 'delivery.observability_failure'
  surface: 'delivery'
  request_id: string
  error_code: 'delivery_observability_write_failed'
  redaction_version: number
}>

type DeliveryObservationDeps = Readonly<{
  now: () => number
  write: (record: DeliveryLogRecord) => void
  reportFailure: (record: ObservabilityFailureRecord) => void
  randomUUID?: () => string
}>

type DeliveryContextDeps = Readonly<{
  now: () => number
  randomUUID: () => string
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_LATENCY_MS = 24 * 60 * 60 * 1_000
const DELIVERY_SAFE_ERROR_CODES: Readonly<Record<DeliverySafeErrorCode, true>> = {
  delivery_artifact_bounds_invalid: true,
  delivery_internal_error: true,
  delivery_jsonld_invalid: true,
  delivery_jsonld_too_large: true,
  delivery_llms_invalid: true,
  delivery_observability_write_failed: true,
  delivery_origin_invalid: true,
  delivery_render_binding_invalid: true,
  delivery_render_depth_exceeded: true,
  delivery_render_invalid_document: true,
  delivery_render_invalid_nesting: true,
  delivery_render_node_limit_exceeded: true,
  delivery_render_text_limit_exceeded: true,
  delivery_render_unknown_attribute: true,
  delivery_render_unknown_mark: true,
  delivery_render_unknown_node: true,
  delivery_request_invalid: true,
  delivery_richtext_field_key_unsupported: true,
  delivery_route_invalid: true,
  delivery_shard_invalid: true,
  delivery_shards_timeout: true,
  delivery_sitemap_byte_limit: true,
  delivery_sitemap_duplicate: true,
  delivery_sitemap_index_limit: true,
  delivery_sitemap_url_invalid: true,
  delivery_sitemap_url_limit: true,
  delivery_upstream_aborted: true,
  delivery_upstream_content_type: true,
  delivery_upstream_invalid: true,
  delivery_upstream_status: true,
  delivery_upstream_timeout: true,
  delivery_upstream_too_large: true,
}

const defaultObservationDeps: DeliveryObservationDeps = {
  now: () => Date.now(),
  write: (record) => console.log(JSON.stringify(record)),
  reportFailure: (record) => console.error(JSON.stringify(record)),
}

const defaultContextDeps: DeliveryContextDeps = {
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
}

function safeRequestId(value: string, randomUUID: () => string): string {
  return UUID_PATTERN.test(value) ? value : randomUUID()
}

function safeErrorCode(value: unknown): DeliverySafeErrorCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(DELIVERY_SAFE_ERROR_CODES, value)
    ? value as DeliverySafeErrorCode
    : 'delivery_internal_error'
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
    requestId: safeRequestId(deps.randomUUID(), deps.randomUUID),
    startedAt: deps.now(),
  }
}

export async function recordDeliveryEvent(
  input: DeliveryObservation,
  deps: DeliveryObservationDeps = defaultObservationDeps,
): Promise<void> {
  const requestId = safeRequestId(
    input.requestId,
    deps.randomUUID ?? defaultContextDeps.randomUUID,
  )
  try {
    const record: DeliveryLogRecord = {
      event: input.event,
      surface: 'delivery',
      route_kind: input.routeKind,
      ...(input.workspaceId === undefined
        ? {}
        : { workspace_id_hash: await hashWorkspaceId(input.workspaceId) }),
      request_id: requestId,
      outcome: input.outcome,
      ...('errorCode' in input ? { error_code: safeErrorCode(input.errorCode) } : {}),
      latency_ms: latency(input.startedAt, deps.now()),
      redaction_version: REDACTION_VERSION,
    }
    deps.write(record)
  } catch {
    const failure: ObservabilityFailureRecord = {
      event: 'delivery.observability_failure',
      surface: 'delivery',
      request_id: requestId,
      error_code: 'delivery_observability_write_failed',
      redaction_version: REDACTION_VERSION,
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

export function deliveryFailureStatus(code: DeliverySafeErrorCode): 500 | 503 {
  return code === 'delivery_shards_timeout' || code === 'delivery_upstream_timeout'
    ? 503
    : 500
}

export async function finishDeliveryArtifact(
  response: Response,
  observation: DeliveryArtifactObservationInput,
): Promise<Response> {
  await recordDeliveryEvent({ event: 'delivery.artifact', ...observation })
  return response
}
