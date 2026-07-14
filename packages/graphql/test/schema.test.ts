import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { defineSchema, type CollectionDef, type FieldDef } from '@movp/core-schema'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
  noteList: vi.fn(async (_args: { first?: number }) => ({ items: [{ id: 'n1' }], nextCursor: null })),
  noteUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
}))

vi.mock('@movp/domain', () => {
  const note = {
    create: vi.fn(async (i: Record<string, unknown>) => ({ id: 'n1', ...i })),
    get: vi.fn(async () => ({ id: 'n1', title: 'Hello' })),
    list: mocks.noteList,
    update: mocks.noteUpdate,
    delete: vi.fn(),
  }
  const tag = { create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() }
  return {
    createDomain: () => ({
      collection: (name: string) => name === 'note' ? note : tag,
      search: vi.fn(async () => []),
      graph: { link: vi.fn(), traverse: vi.fn() },
    }),
  }
})

const ctx = { db: {} as never, userId: 'u' }

const recursiveNode: CollectionDef = {
  name: 'node',
  label: 'Node',
  labelPlural: 'Nodes',
  workspaceScoped: true,
  layer: 'platform',
  fields: {
    title: { type: 'text', label: 'Title' } as FieldDef,
    children: {
      type: 'relation',
      label: 'Children',
      target: 'node',
      cardinality: 'many-to-many',
      graph: true,
    } as FieldDef,
  },
}

const recursive = defineSchema({ collections: [recursiveNode] })

describe('buildSchema', () => {
  it('generates a type, queries, mutation, and search', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toContain('type Note')
    expect(sdl).toContain('type Tag')
    expect(sdl).toMatch(/note\(id: ID!\): Note/)
    expect(sdl).toMatch(/notes\(/)
    expect(sdl).toContain('createNote(')
    expect(sdl).toContain('collectionsMeta')
    expect(sdl).toContain('updateNote(')
    expect(sdl).not.toContain('updateTask(')
    expect(sdl).toContain('search(')
    expect(sdl).toContain('tags: [Tag!]!')
  })

  it('exposes the PAT surfaces (self-service, user-scoped)', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toContain('type PersonalAccessToken')
    expect(sdl).toContain('type CreatedPat')
    expect(sdl).toContain('personalAccessTokens: [PersonalAccessToken!]!')
    expect(sdl).toContain('createPersonalAccessToken(')
    expect(sdl).toContain('revokePersonalAccessToken(')
  })

  it('exposes all reporting dashboard reads', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/reportingTaskThroughput\(/)
    expect(sdl).toMatch(/reportingContentFunnel\(/)
    expect(sdl).toMatch(/reportingCampaignMetrics\(/)
    expect(sdl).toMatch(/reportingSegmentGrowth\(/)
    expect(sdl).toMatch(/reportingWorkflowHealth\(/)
    expect(sdl).toMatch(/reportingIngestVolume\(/)
    expect(sdl).toMatch(/reportingEventDailyCounts\(/)
    expect(sdl).toMatch(/reportingJobDailyCounts\(/)
    expect(sdl).toContain('type ReportingTaskThroughput')
  })

  it('strips id and workspace_id from generic update patches', async () => {
    mocks.noteUpdate.mockClear()
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { updateNote(id: "n1", input: { id: "n2", workspace_id: "w2", title: "Edited" }) { id title } }',
      contextValue: ctx,
    })
    expect(result.errors).toBeUndefined()
    expect(mocks.noteUpdate).toHaveBeenCalledWith('n1', { title: 'Edited' })
  })

  it('clamps an over-large page request to MAX_PAGE_SIZE and runs', async () => {
    mocks.noteList.mockClear()
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: 'query { notes(workspaceId: "w", first: 1000) { items { id } nextCursor } }',
      contextValue: ctx,
    })
    expect(result.errors).toBeUndefined()
    expect(mocks.noteList).toHaveBeenCalledWith({ workspaceId: 'w', first: 100, after: null })
  })

  it('rejects an over-depth query before execution', async () => {
    let sel = '{ id }'
    for (let i = 0; i < 12; i++) sel = `{ children ${sel} }`
    const result = await graphql({
      schema: buildSchema(recursive),
      source: `query { node(id: "x") ${sel} }`,
      contextValue: ctx,
    })
    expect(result.data == null || result.data.node == null).toBe(true)
    expect((result.errors ?? []).length).toBeGreaterThan(0)
    expect(JSON.stringify(result.errors)).toMatch(/depth|complexity|exceed/i)
  })

  it('rejects an over-complexity query before execution', async () => {
    const result = await graphql({
      schema: buildSchema(recursive),
      source: 'query { nodes(workspaceId: "w", first: 100) { items { id title children { id title } } } }',
      contextValue: ctx,
    })
    expect(result.data == null || result.data.nodes == null).toBe(true)
    expect((result.errors ?? []).length).toBeGreaterThan(0)
    expect(JSON.stringify(result.errors)).toMatch(/complexity|exceed/i)
  })
})
