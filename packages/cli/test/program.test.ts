import { describe, expect, it, vi } from 'vitest'
import { buildProgram } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const noteCreate = vi.fn(async () => created)
const noteList = vi.fn(async () => ({ items: [created], nextCursor: null }))
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])
const commentCreate = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    note: {
      create: noteCreate,
      get: vi.fn(async () => created),
      list: noteList,
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
    graph: { link: vi.fn(), traverse: vi.fn() },
    collab: {
      comment: { create: commentCreate, listByEntity: vi.fn() },
      react: vi.fn(),
      unreact: vi.fn(),
      save: vi.fn(),
      unsave: vi.fn(),
      createShareLink: vi.fn(),
      inbox,
    },
  }),
}))

function program(opts: Partial<Parameters<typeof buildProgram>[0]> = {}) {
  const out: string[] = []
  const cmd = buildProgram({
    resolveCtx: () => ({ db: {} as never, userId: 'u' }),
    out: (line) => out.push(line),
    ...opts,
  })
  cmd.exitOverride()
  return { cmd, out }
}

describe('movp CLI', () => {
  it('creates a note through the generated collection command', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'note', 'create', '--workspace', 'w', '--title', 'Hello'])
    expect(noteCreate).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'w', title: 'Hello' }))
    expect(out[0]).toContain('Hello')
  })

  it('search uses fts mode in the direct Node CLI', async () => {
    const { cmd } = program()
    await cmd.parseAsync(['node', 'movp', 'search', 'Hello', '--workspace', 'w'])
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w', query: 'Hello', mode: 'fts' }))
  })

  it('search rejects semantic and hybrid modes in the direct Node CLI', async () => {
    const { cmd } = program()
    await expect(
      cmd.parseAsync(['node', 'movp', 'search', 'Hello', '--workspace', 'w', '--mode', 'semantic']),
    ).rejects.toThrow(/CLI search supports fts only/)
  })

  it('jobs replay forwards to the injected handler', async () => {
    const replay = vi.fn(async () => undefined)
    const { cmd } = program({ jobs: { replay, reindex: vi.fn(async () => undefined) } })
    await cmd.parseAsync(['node', 'movp', 'jobs', 'replay', '--dead'])
    expect(replay).toHaveBeenCalledWith({ dead: true, kind: undefined })
  })

  it('inbox prints the feed for a workspace/tab', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'inbox', '--workspace', 'w', '--tab', 'mentions'])
    expect(inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: undefined })
    expect(out[0]).toContain('user.mentioned')
  })

  it('comment add routes to collab.comment.create with mentions', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync([
      'node',
      'movp',
      'comment',
      'add',
      '--entity-type',
      'note',
      '--entity-id',
      'n1',
      '--body',
      'hi',
      '--mention',
      'u2',
    ])
    expect(commentCreate).toHaveBeenCalledWith({
      entityType: 'note',
      entityId: 'n1',
      body: 'hi',
      parentId: undefined,
      mentions: ['u2'],
    })
    expect(out[0]).toContain('c1')
  })

  it('does not surface generic CRUD commands for the internal collab collections', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    expect(top).not.toContain('mention')
    expect(top).not.toContain('reaction')
    expect(top).not.toContain('saved_item')
    expect(top).not.toContain('share_link')
    expect(top).toEqual(expect.arrayContaining(['note', 'tag', 'inbox', 'comment']))
    const comment = cmd.commands.find((c) => c.name() === 'comment')
    expect(comment?.commands.map((s) => s.name())).toEqual(['add'])
  })
})
