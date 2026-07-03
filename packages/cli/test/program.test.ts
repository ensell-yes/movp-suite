import { describe, expect, it, vi } from 'vitest'
import { createDomain } from '@movp/domain'
import { buildProgram } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const noteCreate = vi.fn(async () => created)
const noteList = vi.fn(async () => ({ items: [created], nextCursor: null }))
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])
const commentCreate = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])
const taskCreate = vi.fn(async () => ({ id: 't1', title: 'Ship it' }))
const taskList = vi.fn(async () => ({ items: [{ id: 't1' }], nextCursor: null }))
const taskBoard = vi.fn(async () => [{ status: { id: 's1' }, tasks: [{ id: 't1' }] }])
const contentCreate = vi.fn(async () => ({ id: 'ci1', slug: 'hello' }))
const contentList = vi.fn(async () => ({ items: [{ id: 'ci1' }], nextCursor: null }))
const contentPublish = vi.fn(async () => ({ id: 'ci1', status: 'published' }))
const contentIssueAsset = vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' }))

function crud() {
  return {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

vi.mock('@movp/domain', () => ({
  createDomain: vi.fn(() => ({
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
    task_status_option: crud(),
    task_priority_option: crud(),
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
    task: {
      create: taskCreate,
      get: vi.fn(),
      list: taskList,
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
    content: {
      createType: vi.fn(async () => ({ id: 'ct1' })),
      create: contentCreate,
      update: vi.fn(async () => ({ id: 'ci1' })),
      get: vi.fn(async () => ({ id: 'ci1' })),
      list: contentList,
      listTypes: vi.fn(async () => ({ items: [{ id: 'ct1' }], nextCursor: null })),
      listRevisions: vi.fn(async () => ({ items: [{ id: 'r1' }], nextCursor: null })),
      listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1' }], nextCursor: null })),
      submitForApproval: vi.fn(async () => ({ id: 'ci1', status: 'in_review' })),
      decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
      publish: contentPublish,
      unpublish: vi.fn(async () => ({ id: 'ci1', status: 'archived' })),
      getPublished: vi.fn(async () => ({ item: { id: 'ci1' }, revision: { id: 'r2', data: { headline: 'v2' }, content_hash: 'h2' } })),
      schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', revision_id: 'r2', action: 'publish', state: 'scheduled' })),
      runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [] })),
      issueAssetUpload: contentIssueAsset,
      finalizeAsset: vi.fn(async () => ({ id: 'a1', r2_key: 'w/a1', mime: 'image/png', size_bytes: 10 })),
      createCollection: vi.fn(),
      addToCollection: vi.fn(),
      reorderCollection: vi.fn(),
      linkAsset: vi.fn(),
      linkItem: vi.fn(),
      linkEditorialTask: vi.fn(),
    },
  })),
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

  it('task create routes to task.create', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'task', 'create', '--workspace', 'w', '--title', 'Ship it'])
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
    expect(out[0]).toContain('t1')
  })

  it('task list and task board print results', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'task', 'list', '--workspace', 'w'])
    expect(taskList).toHaveBeenCalledWith({ workspaceId: 'w', statusId: undefined, assigneeId: undefined })
    expect(out[0]).toContain('t1')
    const p2 = program()
    await p2.cmd.parseAsync(['node', 'movp', 'task', 'board', '--workspace', 'w'])
    expect(taskBoard).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(p2.out[0]).toContain('s1')
  })

  it('surfaces the custom task group but no generic CRUD group for internal task/task_revision', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    expect(top).not.toContain('task_revision')
    expect(top).toEqual(expect.arrayContaining(['task', 'task_status_option', 'task_priority_option']))
    const task = cmd.commands.find((c) => c.name() === 'task')
    expect(task?.commands.map((s) => s.name())).toEqual(['create', 'list', 'board', 'assign', 'transition', 'depend', 'describe'])
  })

  it('content create routes to content.create with parsed JSON data', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync([
      'node',
      'movp',
      'content',
      'create',
      '--workspace',
      'w',
      '--type',
      'ct1',
      '--slug',
      'hello',
      '--data',
      '{"headline":"Hi"}',
    ])
    expect(contentCreate).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: 'hello', data: { headline: 'Hi' } })
    expect(out[0]).toContain('ci1')
  })

  it('content list and content publish print results', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'content', 'list', '--workspace', 'w'])
    expect(contentList).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: undefined, status: undefined })
    expect(out[0]).toContain('ci1')

    const p2 = program()
    await p2.cmd.parseAsync(['node', 'movp', 'content', 'publish', '--item', 'ci1'])
    expect(contentPublish).toHaveBeenCalledWith({ itemId: 'ci1' })
    expect(p2.out[0]).toContain('published')
  })

  it('content asset-upload routes to issueAssetUpload and forwards asset ctx', async () => {
    vi.mocked(createDomain).mockClear()
    const ctx = {
      db: {} as never,
      userId: 'u',
      accessToken: 'test',
      assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets',
    }
    const { cmd, out } = program({ resolveCtx: () => ctx })
    await cmd.parseAsync([
      'node',
      'movp',
      'content',
      'asset-upload',
      '--workspace',
      'w',
      '--filename',
      'x.png',
      '--mime',
      'image/png',
      '--size-bytes',
      '10',
    ])
    expect(contentIssueAsset).toHaveBeenCalledWith({ workspaceId: 'w', filename: 'x.png', mime: 'image/png', sizeBytes: 10 })
    expect(out[0]).toContain('r2/put')
    expect(vi.mocked(createDomain)).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'test',
      assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets',
    }))
  })

  it('surfaces the custom content group but no generic CRUD group for internal CMS collections', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    expect(top).not.toContain('content_item')
    expect(top).not.toContain('content_revision')
    expect(top).toContain('content')
    const content = cmd.commands.find((c) => c.name() === 'content')
    expect(content?.commands.map((s) => s.name())).toEqual([
      'create-type',
      'create',
      'update',
      'list',
      'approvals',
      'get',
      'submit',
      'decide',
      'publish',
      'unpublish',
      'schedule',
      'seo-audit',
      'asset-upload',
    ])
  })
})
