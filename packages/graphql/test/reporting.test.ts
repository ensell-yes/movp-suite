import { graphql } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'
import { createYoga } from '../src/yoga.ts'

const mocks = vi.hoisted(() => ({
  createDomain: vi.fn(),
  reporting: {
    taskThroughput: vi.fn(async () => ({
      avg_cycle_hours: 24,
      open_count: 1,
      series: [{ day: '2026-07-10', count: 2 }],
    })),
    contentFunnel: vi.fn(async () => [{ status: 'draft', count: 3 }]),
    campaignMetrics: vi.fn(async () => [{ metric_key: 'clicks', total: 100 }]),
    segmentGrowth: vi.fn(async () => [
      { segment_id: 's-1', name: 'Seg', points: [{ taken_at: '2026-07-09', member_count: 5 }] },
    ]),
    workflowHealth: vi.fn(async () => [{ day: '2026-07-10', outcome: 'succeeded', count: 1 }]),
    ingestVolume: vi.fn(async () => [{ day: '2026-07-10', source: 'internal', count: 2 }]),
    eventDailyCounts: vi.fn(async () => [{ day: '2026-07-10', type: 'task.completed', count: 3 }]),
    jobDailyCounts: vi.fn(async () => [{ day: '2026-07-10', kind: 'embed', status: 'done', count: 2 }]),
  },
}))

vi.mock('@movp/domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDomain: mocks.createDomain,
}))

mocks.createDomain.mockImplementation(() => ({ reporting: mocks.reporting }))
const schema = buildSchema(movpSchema)
const yoga = createYoga({ schema: movpSchema })
const reportReportingFailure = vi.fn()
const contextValue = { db: {} as never, userId: 'u-1', reportReportingFailure }

async function yogaQuery(source: string): Promise<{
  data?: Record<string, unknown> | null
  errors?: Array<{ message: string; path?: Array<string | number>; extensions?: Record<string, unknown> }>
}> {
  const response = await yoga.handleRequest(new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: source }),
  }), contextValue)
  return await response.json() as {
    data?: Record<string, unknown> | null
    errors?: Array<{ message: string; path?: Array<string | number>; extensions?: Record<string, unknown> }>
  }
}

describe('reporting GraphQL resolvers', () => {
  it('maps task throughput fields and does not emit on success', async () => {
    reportReportingFailure.mockClear()
    const result = await graphql({
      schema,
      source: `query {
        reportingTaskThroughput(workspaceId: "w-1", days: 7) {
          avgCycleHours
          openCount
          series { day count }
        }
      }`,
      contextValue,
    })
    expect(result.errors).toBeUndefined()
    expect(result.data?.reportingTaskThroughput).toEqual({
      avgCycleHours: 24,
      openCount: 1,
      series: [{ day: '2026-07-10', count: 2 }],
    })
    expect(mocks.reporting.taskThroughput).toHaveBeenCalledWith({ workspaceId: 'w-1', days: 7 })
    expect(reportReportingFailure).not.toHaveBeenCalled()
  })

  it('returns all list shapes and does not emit on success', async () => {
    reportReportingFailure.mockClear()
    const result = await graphql({
      schema,
      source: `query {
        reportingContentFunnel(workspaceId: "w-1") { status count }
        reportingCampaignMetrics(workspaceId: "w-1") { metricKey total }
        reportingSegmentGrowth(workspaceId: "w-1") { segmentId name points { takenAt memberCount } }
        reportingWorkflowHealth(workspaceId: "w-1") { day outcome count }
        reportingIngestVolume(workspaceId: "w-1") { day source count }
        reportingEventDailyCounts(workspaceId: "w-1") { day type count }
        reportingJobDailyCounts(workspaceId: "w-1") { day kind status count }
      }`,
      contextValue,
    })
    expect(result.errors).toBeUndefined()
    expect(result.data?.reportingContentFunnel).toEqual([{ status: 'draft', count: 3 }])
    expect(result.data?.reportingCampaignMetrics).toEqual([{ metricKey: 'clicks', total: 100 }])
    expect(result.data?.reportingSegmentGrowth).toEqual([
      { segmentId: 's-1', name: 'Seg', points: [{ takenAt: '2026-07-09', memberCount: 5 }] },
    ])
    expect(mocks.reporting.contentFunnel).toHaveBeenCalledWith({ workspaceId: 'w-1' })
    expect(reportReportingFailure).not.toHaveBeenCalled()
  })

  it('returns a safe structured denial through Yoga and emits exactly once', async () => {
    reportReportingFailure.mockClear()
    mocks.reporting.contentFunnel.mockRejectedValueOnce(
      new Error('domain.reporting.contentFunnel failed [42501]'),
    )
    const result = await yogaQuery(
      'query { reportingContentFunnel(workspaceId: "w-other") { status count } }',
    )
    expect(result.errors?.[0]).toMatchObject({
      message: 'You do not have access to these reports.',
      path: ['reportingContentFunnel'],
      extensions: { code: 'FORBIDDEN' },
    })
    expect(JSON.stringify(result)).not.toContain('domain.reporting')
    expect(JSON.stringify(result)).not.toContain('42501')
    expect(reportReportingFailure).toHaveBeenCalledTimes(1)
    expect(reportReportingFailure).toHaveBeenCalledWith({
      operation: 'reportingContentFunnel',
      errorCode: 'reporting_denied',
      workspaceId: 'w-other',
    })
  })

  it('preserves healthy root fields when one reporting read fails', async () => {
    mocks.reporting.contentFunnel.mockRejectedValueOnce(new Error('rpc unavailable [57014]'))
    const result = await yogaQuery(`query {
      reportingContentFunnel(workspaceId: "w-1") { status count }
      reportingCampaignMetrics(workspaceId: "w-1") { metricKey total }
    }`)
    expect(result.data).toEqual({
      reportingContentFunnel: null,
      reportingCampaignMetrics: [{ metricKey: 'clicks', total: 100 }],
    })
    expect(result.errors?.[0]).toMatchObject({
      message: 'Could not load this report.',
      path: ['reportingContentFunnel'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
  })

  it('creates one request-bound domain for a multi-field query', async () => {
    mocks.createDomain.mockClear()
    const result = await graphql({
      schema,
      source: `query {
        reportingContentFunnel(workspaceId: "w-1") { status count }
        reportingCampaignMetrics(workspaceId: "w-1") { metricKey total }
      }`,
      contextValue: { db: {} as never, userId: 'u-1' },
    })
    expect(result.errors).toBeUndefined()
    expect(mocks.createDomain).toHaveBeenCalledTimes(1)
  })

  it('continues to mask errors outside the reporting allow-list', async () => {
    const result = await yogaQuery(
      'query { notes(workspaceId: "w-1", first: 1) { items { id } } }',
    )
    expect(result.errors?.[0]).toMatchObject({
      message: 'Unexpected error.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(JSON.stringify(result)).not.toContain('no domain service')
  })
})
