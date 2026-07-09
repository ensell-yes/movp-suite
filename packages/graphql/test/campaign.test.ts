import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
  deliverableSchedule: vi.fn(async () => ({ taskId: 'task-1', startDate: '2026-07-01', dueDate: '2026-07-10' })),
  deliverableSchedules: vi.fn(async () => [{ deliverableId: 'd1', taskId: 'task-1', startDate: '2026-07-01', dueDate: '2026-07-10' }]),
  traverse: vi.fn(async () => [] as Array<{ type: string; id: string }>),
}))

// deliverableSchedule/deliverableSchedules route to the mocked domain. campaignDetail reads
// ctx.db directly; the frontend harness is MOCK-based (it cannot exercise the real rollup/edge-
// batch logic), so campaignDetail's BFF logic is proven HERE against a stubbed ctx.db — this is
// THE gate for the BFF read. The real precedent for a resolver reading ctx.db is `resolveShareLink`.
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    campaign: { deliverableSchedule: mocks.deliverableSchedule, deliverableSchedules: mocks.deliverableSchedules },
    graph: { traverse: mocks.traverse },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }

// Chainable stub for ctx.db: `.from(table)` returns a thenable whose await yields { data: rows },
// and `.maybeSingle()` yields { data: rows[0] ?? null }. Filter args are ignored — the per-table
// seed is what the resolver reads (real RLS/filtering is covered by the e2e slice, Task 6).
type DbChain = {
  select: () => DbChain; eq: () => DbChain; order: () => DbChain; in: () => DbChain
  maybeSingle: () => Promise<{ data: unknown; error?: unknown }>
  then: (resolve: (v: { data: unknown[]; error?: unknown }) => unknown) => unknown
}
function makeDb(tables: Record<string, unknown[]>, errorFor: Set<string> = new Set()): { from: (t: string) => DbChain } {
  return {
    from(table) {
      const rows = tables[table] ?? []
      const err = errorFor.has(table) ? { code: 'PGRST_TEST' } : undefined
      const chain: DbChain = {
        select: () => chain, eq: () => chain, order: () => chain, in: () => chain,
        maybeSingle: async () => ({ data: err ? null : (rows[0] ?? null), error: err }),
        then: (resolve) => resolve({ data: err ? [] : rows, error: err }),
      }
      return chain
    },
  }
}

describe('campaign GraphQL surface', () => {
  it('deliverableSchedule routes to campaign.deliverableSchedule', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedule(deliverableId: "d1") { taskId startDate dueDate } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.deliverableSchedule).toHaveBeenCalledWith('d1')
    expect((res.data as { deliverableSchedule: { taskId: string } }).deliverableSchedule.taskId).toBe('task-1')
  })

  it('deliverableSchedule returns null for an unlinked deliverable', async () => {
    mocks.deliverableSchedule.mockResolvedValueOnce(null as never)
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedule(deliverableId: "d2") { taskId } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { deliverableSchedule: unknown }).deliverableSchedule).toBeNull()
  })

  it('deliverableSchedules routes to campaign.deliverableSchedules (ONE batched call)', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { deliverableSchedules(deliverableIds: ["d1","d2"]) { deliverableId taskId startDate dueDate } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.deliverableSchedules).toHaveBeenCalledTimes(1)
    expect(mocks.deliverableSchedules).toHaveBeenCalledWith(['d1', 'd2'])
    const rows = (res.data as { deliverableSchedules: Array<{ deliverableId: string }> }).deliverableSchedules
    expect(rows[0].deliverableId).toBe('d1')
  })

  it('campaignDetail parses goal targets, rolls up actuals by metric_key, batches taskIds, resolves stakeholders', async () => {
    mocks.traverse.mockResolvedValueOnce([{ type: 'user', id: 'user-obs' }, { type: 'task', id: 'task-x' }])
    const db = makeDb({
      campaign: [{
        id: 'c1', workspace_id: 'w1', name: 'C', brief: 'B', status: 'active',
        priority: 'high', rank: 3, start_date: '2026-07-01', end_date: '2026-07-31',
        owner_id: 'owner-1', marketing_plan_id: 'mp1',
        goal_metrics: [{ metric_key: 'clicks', target_value: 100, unit: 'count' }],
      }],
      campaign_deliverable: [{ id: 'd1', name: 'D1' }],
      edges: [{ src_id: 'd1', dst_id: 'task-1' }],
      campaign_channel: [{ id: 'ch1', channel_type: 'email', name: 'Email' }],
      campaign_metric: [{ metric_key: 'clicks', value: 30 }, { metric_key: 'clicks', value: 70 }],
    })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { campaignDetail(campaignId: "c1") {
        id goalMetrics { metricKey targetValue unit } actuals { metricKey total }
        deliverables { id taskId } channels { id channelType }
        stakeholders { ownerId observerIds } } }`,
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const d = (res.data as { campaignDetail: {
      goalMetrics: unknown; actuals: unknown; deliverables: unknown; channels: unknown; stakeholders: unknown
    } }).campaignDetail
    expect(d.goalMetrics).toEqual([{ metricKey: 'clicks', targetValue: '100', unit: 'count' }])
    expect(d.actuals).toEqual([{ metricKey: 'clicks', total: 100 }])            // 30 + 70 rolled up by metric_key
    expect(d.deliverables).toEqual([{ id: 'd1', taskId: 'task-1' }])            // backing taskId batched from edges
    expect(d.channels).toEqual([{ id: 'ch1', channelType: 'email' }])
    expect(d.stakeholders).toEqual({ ownerId: 'owner-1', observerIds: ['user-obs'] }) // owner FK + observer edge
  })

  it('deliverableSchedules rejects an oversized id array (F4 bound)', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `d${i}`)
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query($ids: [ID!]!) { deliverableSchedules(deliverableIds: $ids) { deliverableId } }',
      variableValues: { ids },
      contextValue: ctx,
    })
    expect(res.errors?.[0]?.message).toMatch(/deliverable_schedules_too_many_ids/)
  })

  it('campaignDetail fails loud (bounded code) on a child-read DB error (F3)', async () => {
    const db = makeDb({ campaign: [{ id: 'c1', workspace_id: 'w1' }] }, new Set(['campaign_metric']))
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { campaignDetail(campaignId: "c1") { id actuals { metricKey total } } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors?.[0]?.message).toMatch(/campaign_detail_metrics_failed/)
  })

  it('surfaces custom reads plus generated campaign create/read/update but no delete', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    // Part C's custom reads present
    expect(sdl).toMatch(/\bdeliverableSchedule\(/)
    expect(sdl).toMatch(/type DeliverableSchedule\b/)
    expect(sdl).toMatch(/\bdeliverableSchedules\(/)
    expect(sdl).toMatch(/type DeliverableScheduleEntry\b/)
    expect(sdl).toMatch(/\bcampaignDetail\(/)
    expect(sdl).toMatch(/type CampaignDetail\b/)
    // Generic campaign surface is present; Stage C2 adds update for public collections.
    expect(sdl).toMatch(/type Campaign\b/)
    expect(sdl).toMatch(/\bcreateCampaign\(/)
    expect(sdl).toMatch(/\bcampaigns\(/)
    expect(sdl).toMatch(/\bcampaign_deliverables\(/)
    expect(sdl).toMatch(/\bupdateCampaign\(/)
    expect(sdl).not.toMatch(/\bdeleteCampaign\(/)
  })
})
