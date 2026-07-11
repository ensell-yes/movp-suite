import { graphql } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
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
  createDomain: () => ({ reporting: mocks.reporting }),
}))

const schema = buildSchema(movpSchema)
const reportReportingFailure = vi.fn()
const contextValue = { db: {} as never, userId: 'u-1', reportReportingFailure }

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

  it('emits exactly once and preserves a denied domain error', async () => {
    reportReportingFailure.mockClear()
    mocks.reporting.contentFunnel.mockRejectedValueOnce(
      new Error('domain.reporting.contentFunnel failed [42501]'),
    )
    const result = await graphql({
      schema,
      source: 'query { reportingContentFunnel(workspaceId: "w-other") { status count } }',
      contextValue,
    })
    expect(result.errors?.[0]?.message).toMatch(/\[42501\]/)
    expect(reportReportingFailure).toHaveBeenCalledTimes(1)
    expect(reportReportingFailure).toHaveBeenCalledWith({
      operation: 'reportingContentFunnel',
      errorCode: 'reporting_denied',
    })
  })
})
