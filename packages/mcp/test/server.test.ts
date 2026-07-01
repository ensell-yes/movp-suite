import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { schema } from '@movp/core-schema'
import { buildMcpServer } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    note: {
      create: vi.fn(async () => created),
      get: vi.fn(async () => created),
      list: vi.fn(async () => ({ items: [created], nextCursor: null })),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tag: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    search,
    graph: { link: vi.fn(async () => undefined), traverse: vi.fn() },
  }),
}))

describe('buildMcpServer', () => {
  it('lists generated tools and calls note create/search', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['note.create', 'note.search', 'tag.create']))

    const createRes = await client.callTool({
      name: 'note.create',
      arguments: { workspace_id: 'w', title: 'Hello' },
    })
    expect(JSON.stringify(createRes.content)).toContain('Hello')

    const searchRes = await client.callTool({
      name: 'note.search',
      arguments: { workspaceId: 'w', query: 'Hello' },
    })
    expect(JSON.stringify(searchRes.content)).toContain('n1')
  })
})
