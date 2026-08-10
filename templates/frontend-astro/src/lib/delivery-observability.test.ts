import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createDeliveryRequestContext,
  deliveryFailureStatus,
  hashWorkspaceId,
  recordDeliveryEvent,
  type DeliveryLogRecord,
} from './delivery-observability.ts'

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_HASH = 'f6222a1106eefe4f6b25302a9d963cfaba14bedfefacc2c311967e41c61cffe4'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('delivery observability', () => {
  it('matches the shared SHA-256 workspace known vector', async () => {
    await expect(hashWorkspaceId(WORKSPACE_ID)).resolves.toBe(WORKSPACE_HASH)
  })

  it('maps only bounded upstream timeouts to 503', () => {
    expect(deliveryFailureStatus('delivery_upstream_timeout')).toBe(503)
    expect(deliveryFailureStatus('delivery_shards_timeout')).toBe(503)
    expect(deliveryFailureStatus('delivery_internal_error')).toBe(500)
  })

  it('emits exactly one content-disciplined public-read event per outcome', async () => {
    const cases = [
      {
        outcome: 'found' as const,
        experimentActive: false,
        experimentVariantServed: false,
      },
      {
        outcome: 'not_found' as const,
        experimentActive: false,
        experimentVariantServed: false,
      },
      {
        outcome: 'found' as const,
        experimentActive: true,
        experimentVariantServed: true,
      },
      {
        outcome: 'found' as const,
        experimentActive: true,
        experimentVariantServed: false,
        experimentAssignmentErrorCode: 'delivery_experiment_assignment_persist_failed' as const,
      },
      {
        outcome: 'found' as const,
        experimentActive: true,
        experimentVariantServed: true,
        experimentAssignmentErrorCode: 'delivery_experiment_assignment_unsigned' as const,
      },
      {
        outcome: 'error' as const,
        errorCode: 'delivery_upstream_timeout' as const,
        experimentActive: false,
        experimentVariantServed: false,
      },
      {
        outcome: 'error' as const,
        errorCode: 'delivery_render_invalid_document' as const,
        experimentActive: false,
        experimentVariantServed: false,
      },
    ]

    for (const outcome of cases) {
      const records: DeliveryLogRecord[] = []
      await recordDeliveryEvent({
        event: 'delivery.public_read',
        routeKind: 'page',
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        startedAt: 100,
        ...outcome,
      }, {
        now: () => 125,
        write: (record) => records.push(record),
        reportFailure: vi.fn(),
      })

      expect(records).toHaveLength(1)
      expect(records[0]).toEqual({
        event: 'delivery.public_read',
        surface: 'delivery',
        route_kind: 'page',
        workspace_id_hash: WORKSPACE_HASH,
        request_id: REQUEST_ID,
        outcome: outcome.outcome,
        ...(outcome.outcome === 'error' ? { error_code: outcome.errorCode } : {}),
        experiment_active: outcome.experimentActive,
        experiment_variant_served: outcome.experimentVariantServed,
        ...('experimentAssignmentErrorCode' in outcome
          ? { experiment_assignment_error_code: outcome.experimentAssignmentErrorCode }
          : {}),
        latency_ms: 25,
        redaction_version: 1,
      })
      expect(JSON.stringify(records[0])).not.toMatch(
        /slug|path|url|content|schema|token|cookie|email|payload/i,
      )
    }
  })

  it('emits exactly one artifact event for generated and bounded-error outcomes', async () => {
    const records: DeliveryLogRecord[] = []
    for (const input of [
      { routeKind: 'sitemap_index' as const, outcome: 'generated' as const },
      {
        routeKind: 'sitemap_child' as const,
        outcome: 'error' as const,
        errorCode: 'delivery_sitemap_url_limit' as const,
      },
      { routeKind: 'sitemap_child' as const, outcome: 'not_found' as const },
      { routeKind: 'robots' as const, outcome: 'generated' as const },
      { routeKind: 'llms' as const, outcome: 'generated' as const },
    ]) {
      await recordDeliveryEvent({
        event: 'delivery.artifact',
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        startedAt: 10,
        ...input,
      }, {
        now: () => 12,
        write: (record) => records.push(record),
        reportFailure: vi.fn(),
      })
    }

    expect(records).toHaveLength(5)
    expect(records.map((record) => [record.event, record.route_kind, record.outcome])).toEqual([
      ['delivery.artifact', 'sitemap_index', 'generated'],
      ['delivery.artifact', 'sitemap_child', 'error'],
      ['delivery.artifact', 'sitemap_child', 'not_found'],
      ['delivery.artifact', 'robots', 'generated'],
      ['delivery.artifact', 'llms', 'generated'],
    ])
    expect(records[2]).not.toHaveProperty('error_code')
    expect(records.every((record) => (
      record.surface === 'delivery' && record.redaction_version === 1
    ))).toBe(true)
  })

  it('uses generated request correlation and surfaces recorder failures without rejecting', async () => {
    const reportFailure = vi.fn()
    let uuidCallCount = 0
    const context = createDeliveryRequestContext({
      now: () => 40,
      randomUUID: () => {
        uuidCallCount += 1
        return uuidCallCount === 1 ? 'malformed' : REQUEST_ID
      },
    })
    expect(context).toEqual({ requestId: REQUEST_ID, startedAt: 40 })

    await expect(recordDeliveryEvent({
      event: 'delivery.artifact',
      routeKind: 'robots',
      outcome: 'generated',
      workspaceId: WORKSPACE_ID,
      requestId: context.requestId,
      startedAt: context.startedAt,
    }, {
      now: () => 50,
      write: () => {
        throw new Error('writer unavailable')
      },
      reportFailure,
    })).resolves.toBeUndefined()

    expect(reportFailure).toHaveBeenCalledOnce()
    expect(reportFailure).toHaveBeenCalledWith({
      event: 'delivery.observability_failure',
      surface: 'delivery',
      request_id: REQUEST_ID,
      error_code: 'delivery_observability_write_failed',
      redaction_version: 1,
    })
  })

  it('replaces an invalid runtime error classifier with the safe internal code', async () => {
    const records: DeliveryLogRecord[] = []
    await recordDeliveryEvent({
      event: 'delivery.public_read',
      routeKind: 'page',
      outcome: 'error',
      errorCode: 'not-a-delivery-code',
      experimentActive: false,
      experimentVariantServed: false,
      requestId: REQUEST_ID,
      startedAt: 1,
    } as unknown as Parameters<typeof recordDeliveryEvent>[0], {
      now: () => 2,
      write: (record) => records.push(record),
      reportFailure: vi.fn(),
    })
    expect(records[0]?.error_code).toBe('delivery_internal_error')
  })

  it('routes every public response through its single observation owner', async () => {
    const page = await readFile(`${ROOT}/src/pages/[contentType]/[slug].astro`, 'utf8')
    const deliveryPage = await readFile(`${ROOT}/src/lib/delivery-page.ts`, 'utf8')
    expect(page.match(/recordDeliveryEvent\(observation\)/g)).toHaveLength(1)
    expect(page).not.toContain('catch {')
    expect(deliveryPage).toContain('deliveryFailureStatus(result.code)')
    expect(`${page}\n${deliveryPage}`).not.toContain("result.code === 'delivery_upstream_timeout' ? 503 : 500")

    for (const route of [
      'sitemap.xml.ts',
      'sitemap-[boundary].xml.ts',
      'robots.txt.ts',
      'llms.txt.ts',
    ]) {
      const source = await readFile(`${ROOT}/src/pages/${route}`, 'utf8')
      expect(source, route).toContain('finishDeliveryArtifact')
      expect(source, route).not.toContain('return new Response')
      expect(source, route).not.toContain('catch {')
      expect(source, route).not.toContain('status: 502')
    }
    const owner = await readFile(`${ROOT}/src/lib/delivery-observability.ts`, 'utf8')
    expect(owner).not.toContain("if (observation.outcome === 'generated')")
  })
})
