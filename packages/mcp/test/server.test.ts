import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { schema } from '@movp/core-schema'
import { buildMcpServer } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])
const commentAdd = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])
const taskCreate = vi.fn(async () => ({ id: 't1', title: 'Ship it', status_id: 's1' }))
const taskBoard = vi.fn(async () => [{ status: { id: 's1', label: 'Todo' }, tasks: [{ id: 't1' }] }])

function crud() {
  return {
    create: vi.fn(async () => created),
    get: vi.fn(async () => created),
    list: vi.fn(async () => ({ items: [created], nextCursor: null })),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    note: crud(),
    tag: crud(),
    task_status_option: crud(),
    task_priority_option: crud(),
    search,
    graph: { link: vi.fn(async () => undefined), traverse: vi.fn() },
    collab: {
      comment: { create: commentAdd, listByEntity: vi.fn() },
      react: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      unsave: vi.fn(async () => undefined),
      createShareLink: vi.fn(async () => ({ token: 'raw-token' })),
      inbox,
    },
    task: {
      create: taskCreate,
      get: vi.fn(async () => ({ id: 't1' })),
      list: vi.fn(async () => ({ items: [{ id: 't1' }], nextCursor: null })),
      board: taskBoard,
      assign: vi.fn(async () => undefined),
      unassign: vi.fn(),
      addObserver: vi.fn(),
      removeObserver: vi.fn(),
      transition: vi.fn(async () => ({ id: 't1', status_id: 's2' })),
      addDependency: vi.fn(async () => undefined),
      removeDependency: vi.fn(),
      updateDescription: vi.fn(async () => ({ id: 't1' })),
      attach: vi.fn(),
    },
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

  it('registers and calls the collab tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['inbox.list', 'comment.add', 'reaction.toggle', 'save.toggle', 'share.create']))
    expect(names).not.toContain('comment.create')
    expect(names).not.toContain('mention.create')
    expect(names).not.toContain('reaction.create')
    expect(names).not.toContain('saved_item.create')
    expect(names).not.toContain('share_link.create')

    const addRes = await client.callTool({
      name: 'comment.add',
      arguments: { entityType: 'note', entityId: 'n1', body: 'hi', mentions: ['u2'] },
    })
    expect(commentAdd).toHaveBeenCalledWith({
      entityType: 'note',
      entityId: 'n1',
      body: 'hi',
      parentId: undefined,
      mentions: ['u2'],
    })
    expect(JSON.stringify(addRes.content)).toContain('c1')

    const inboxRes = await client.callTool({ name: 'inbox.list', arguments: { workspaceId: 'w', tab: 'mentions' } })
    expect(inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: undefined })
    expect(JSON.stringify(inboxRes.content)).toContain('user.mentioned')
  })

  it('registers and calls the custom task tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'task.create',
      'task.get',
      'task.list',
      'task.board',
      'task.assign',
      'task.transition',
      'task.add_dependency',
      'task.update_description',
    ]))
    expect(names).not.toContain('task_revision.create')
    expect(names).toEqual(expect.arrayContaining(['task_status_option.create', 'task_priority_option.create']))

    const createRes = await client.callTool({ name: 'task.create', arguments: { workspaceId: 'w', title: 'Ship it' } })
    expect(taskCreate).toHaveBeenCalledWith({
      workspaceId: 'w',
      title: 'Ship it',
      description: undefined,
      statusId: undefined,
      priorityId: undefined,
      parentId: undefined,
      startDate: undefined,
      dueDate: undefined,
    })
    expect(JSON.stringify(createRes.content)).toContain('t1')

    const boardRes = await client.callTool({ name: 'task.board', arguments: { workspaceId: 'w' } })
    expect(taskBoard).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(JSON.stringify(boardRes.content)).toContain('s1')
  })
})
