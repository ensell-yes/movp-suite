import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

// Every read/write under test hits ctx.db (+ ctx.db.rpc) directly; the frontend harness is MOCK-based
// (it cannot exercise the real rollup/diff/version logic), so this resolver-level test is THE gate for
// the BFF surface. The precedent for a resolver reading ctx.db is `resolveShareLink`
// (`packages/graphql/src/schema.ts:343`). No resolver under test calls a domain service, so a trivial
// @movp/domain stub suffices (the deferred campaignAudience was the only graph.traverse consumer).
vi.mock('@movp/domain', () => ({ createDomain: () => ({}) }))

// Chainable stub for ctx.db: `.from(table)` returns a thenable whose await yields { data: rows },
// `.maybeSingle()` yields { data: rows[0] ?? null }, and `.rpc(name)` yields { data: rpc[name] }.
// Filter/range args are ignored — the per-table seed is what the resolver reads (real RLS/filter
// is covered by the e2e slice, Task 6).
type DbChain = {
  select: () => DbChain; eq: () => DbChain; order: () => DbChain; in: () => DbChain
  range: () => DbChain; limit: () => DbChain
  maybeSingle: () => Promise<{ data: unknown }>
  then: (resolve: (v: { data: unknown[] }) => unknown) => unknown
}
function makeDb(tables: Record<string, unknown[]>, rpc: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const chain: DbChain = {
        select: () => chain, eq: () => chain, order: () => chain, in: () => chain,
        range: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        then: (resolve) => resolve({ data: rows }),
      }
      return chain
    },
    rpc: async (name: string) => ({ data: rpc[name] ?? null }),
  }
}

describe('segmentation GraphQL surface', () => {
  it('previewMatchingCount parses the predicate and returns the capped RPC count', async () => {
    const db = makeDb({ segment: [{ id: 's1', workspace_id: 'w1' }] }, { preview_segment_predicate: 42 })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{\\"all\\":[]}") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { previewMatchingCount: { count: number } }).previewMatchingCount.count).toBe(42)
  })

  it('previewMatchingCount returns count 0 on unparseable predicate JSON', async () => {
    const db = makeDb({ segment: [{ id: 's1', workspace_id: 'w1' }] }, { preview_segment_predicate: 7 })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{not-json") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    expect((res.data as { previewMatchingCount: { count: number } }).previewMatchingCount.count).toBe(0)
  })

  it('segmentMembershipExplained returns matched rule version + evidence trail with NO raw properties', async () => {
    const db = makeDb({
      segment_membership: [{
        id: 'm1', segment_id: 's1', subject_type: 'user', subject_ref: 'user-9',
        matched_rule_id: 'r2', first_matched_at: '2026-07-01T00:00:00Z', evaluated_at: '2026-07-02T00:00:00Z',
        evidence: { event_ids: ['ev1'] },
      }],
      segment_rule: [{ id: 'r2', version: 2, description: 'v2' }],
      platform_event: [{ id: 'ev1', event_type: 'registration.completed', occurred_at: '2026-06-30T00:00:00Z',
                         subject_type: 'user', properties: { email: 'pii@example.com' } }],
    })
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { segmentMembershipExplained(segmentId: "s1", subjectRef: "user-9") {
        subjectRef matchedRuleId matchedRuleVersion firstMatchedAt evaluatedAt
        evidence { eventId eventType occurredAt } } }`,
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const e = (res.data as { segmentMembershipExplained: {
      matchedRuleVersion: number; evidence: Array<{ eventId: string; eventType: string; occurredAt: string }>
    } }).segmentMembershipExplained
    expect(e.matchedRuleVersion).toBe(2)
    expect(e.evidence).toEqual([{ eventId: 'ev1', eventType: 'registration.completed', occurredAt: '2026-06-30T00:00:00Z' }])
    // PII discipline: the serialized response must NOT carry the raw properties payload.
    expect(JSON.stringify(res.data)).not.toContain('pii@example.com')
  })

  it('snapshotDiff returns full counts while capping returned arrays', async () => {
    // Regression pin: snapshotDiff must NOT cap the DB load. It needs both full frozen
    // member sets to compute true counts, then slices only the returned arrays to CAP.
    type SnapChain = {
      select: () => SnapChain
      eq: (col: string, id: string) => SnapChain
      limit: (n: number) => SnapChain
      then: (resolve: (v: { data: unknown[] }) => unknown) => unknown
    }
    const db = {
      from: (_t: string): SnapChain => {
        const byCall: Record<string, unknown[]> = {
          A: [{ subject_ref: 'removed' }],
          B: Array.from({ length: 501 }, (_v, i) => ({ subject_ref: `u-${String(i).padStart(3, '0')}` })),
        }
        // Capture `.eq('snapshot_id', id)` to pick the frozen snapshot set. A `.limit(CAP)` call
        // would recreate the old undercount bug, so make that fail loudly.
        let picked: unknown[] = []
        const chain: SnapChain = {
          select: () => chain,
          eq: (_c, id) => { picked = byCall[id] ?? []; return chain },
          limit: () => { throw new Error('snapshotDiff must not cap the DB load') },
          then: (resolve) => resolve({ data: picked }),
        }
        return chain
      },
    }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { snapshotDiff(snapshotAId: "A", snapshotBId: "B") { added removed addedCount removedCount } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const d = (res.data as { snapshotDiff: { added: string[]; removed: string[]; addedCount: number; removedCount: number } }).snapshotDiff
    expect(d.addedCount).toBe(501); expect(d.added).toHaveLength(500)
    expect(d.removed).toEqual(['removed']); expect(d.removedCount).toBe(1)
  })

  it('previewMatchingCount THROWS (never reports 0) when the preview RPC fails', async () => {
    // F6: a failed RPC must be distinguishable from "0 matched". The db only needs .rpc here.
    const db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { previewMatchingCount(segmentId: "s1", predicate: "{\\"all\\":[]}") { count } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors?.[0]?.message).toContain('segment.read_failed')
  })

  it('createSegmentRuleVersion delegates serialized version assignment to the DB RPC', async () => {
    // The generic createSegmentRule SKIPS the segment_id relation FK; this custom write must set it.
    // Version assignment is DB-owned so concurrent saves serialize under an advisory lock.
    let rpcCall: { name: string; args: Record<string, unknown> } | null = null
    const db = {
      from(_table: string) {
        const api: any = {
          select: () => api, eq: () => api, order: () => api, limit: () => api,
          maybeSingle: async () => ({ data: null }),
          insert: () => { throw new Error('createSegmentRuleVersion must not insert directly') },
        }
        return api
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCall = { name, args }
        return { data: { id: 'r3', version: 3 }, error: null }
      },
    }
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { createSegmentRuleVersion(segmentId: "s1", predicate: "{\\"all\\":[]}") { id version } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(res.errors).toBeUndefined()
    const r = (res.data as { createSegmentRuleVersion: { id: string; version: number } }).createSegmentRuleVersion
    expect(r.version).toBe(3)
    expect(rpcCall).toEqual({
      name: 'create_segment_rule_version',
      args: { seg_id: 's1', predicate: { all: [] } },
    })
  })

  it('segmentSummaries / segmentMembers / segmentSnapshots enumerate a segment under RLS', async () => {
    const db = makeDb({
      segment: [{ id: 's1', workspace_id: 'w1', name: 'S', active: true, mode: 'dynamic', owner_ref: 'owner-1' }],
      // The stub returns the same rows for every .select() on a table, so this single row carries BOTH
      // the grouped-aggregate shape segmentSummaries reads (segment_id/member_count via SQL count()) AND
      // the raw columns segmentMembers reads — each of the three queries asserts only "no errors".
      segment_membership: [{ segment_id: 's1', member_count: 2, subject_ref: 'a', subject_type: 'user', matched_rule_id: 'r1', evaluated_at: '2026-07-02T00:00:00Z' }],
      segment_recompute_run: [{ segment_id: 's1', last_finished_at: '2026-07-02T00:00:00Z' }],
      segment_snapshot: [{ id: 'snap-1', taken_at: '2026-07-01T00:00:00Z', reason: 'on_demand', member_count: 2 }],
    })
    const summaries = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentSummaries(workspaceId: "w1") { id name memberCount lastRecomputedAt } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(summaries.errors).toBeUndefined()
    const members = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentMembers(segmentId: "s1", first: 50) { items { subjectRef } nextCursor } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(members.errors).toBeUndefined()
    const snaps = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { segmentSnapshots(segmentId: "s1") { id memberCount reason } }',
      contextValue: { db: db as never, userId: 'u' },
    })
    expect(snaps.errors).toBeUndefined()
  })

  it('surfaces the CUSTOM reads + createSegmentRuleVersion + codegen generic CRUD; NO generic segment write, NO campaignAudience', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    for (const q of ['previewMatchingCount(', 'segmentMembershipExplained(', 'snapshotDiff(',
                     'segmentSummaries(', 'segmentMembers(', 'segmentSnapshots(', 'createSegmentRuleVersion(']) {
      expect(sdl).toContain(q)
    }
    expect(sdl).toMatch(/type Segment\b/)          // codegen generic surface (create + read) — NOT authored here
    expect(sdl).toMatch(/\bcreateSegment\(/)
    expect(sdl).toMatch(/\bsegments\(/)
    expect(sdl).toMatch(/\bsegment_memberships\(/)
    expect(sdl).not.toMatch(/\bupdateSegment\(/)   // builder is create-only; Part D adds no generic write
    expect(sdl).not.toMatch(/\bdeleteSegment\(/)
    expect(sdl).not.toContain('campaignAudience')  // deferred out of Part D (no edge producer/consumer yet)
  })
})
