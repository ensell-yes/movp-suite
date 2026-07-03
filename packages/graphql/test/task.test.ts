import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    workspace_id: 'w',
    title: 'Ship it',
    status_id: 's1',
    priority_id: 'p1',
    parent_id: null,
    current_revision_id: 'r1',
    start_date: null,
    due_date: null,
    completed_at: null,
    dependency_blocked: false,
    due_soon_notified_at: null,
    created_at: 't',
    updated_at: 't',
    ...over,
  })
  return {
    row,
    create: vi.fn(async (i: any) => row({ title: i.title, status_id: i.statusId ?? 's1', priority_id: i.priorityId ?? 'p1' })),
    get: vi.fn(async () => row()),
    list: vi.fn(async () => ({ items: [row()], nextCursor: null })),
    board: vi.fn(async () => [{
      status: { id: 's1', workspace_id: 'w', label: 'Todo', category: 'backlog', is_default: true, is_active: true, sort_order: 0, color: null, created_at: 't', updated_at: 't' },
      tasks: [row()],
    }]),
    assign: vi.fn(async () => undefined),
    transition: vi.fn(async (i: any) => row({ id: i.taskId, status_id: i.statusId, completed_at: 't' })),
    addDependency: vi.fn(async () => undefined),
    updateDescription: vi.fn(async (id: string) => row({ id })),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    task: {
      create: mocks.create,
      get: mocks.get,
      list: mocks.list,
      board: mocks.board,
      assign: mocks.assign,
      unassign: vi.fn(),
      addObserver: vi.fn(),
      removeObserver: vi.fn(),
      transition: mocks.transition,
      addDependency: mocks.addDependency,
      removeDependency: vi.fn(),
      updateDescription: mocks.updateDescription,
      attach: vi.fn(),
    },
    collab: {
      comment: {
        listByEntity: vi.fn(async () => ({
          items: [{ id: 'c1', workspace_id: 'w', entity_type: 'task', entity_id: 't1', body: 'hi', author_id: 'u2', parent_id: null, created_at: 't', updated_at: 't' }],
          nextCursor: null,
        })),
      },
    },
  }),
}))

const ctx = { db: {} as never, userId: 'u' }

describe('task GraphQL surface', () => {
  it('createTask routes to task.create with default passthrough', async () => {
    const res = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { createTask(workspaceId: "w", title: "Ship it") { id title status_id } }', contextValue: ctx })
    expect(res.errors).toBeUndefined()
    expect(mocks.create).toHaveBeenCalledWith({ workspaceId: 'w', title: 'Ship it', description: undefined, statusId: undefined, priorityId: undefined, parentId: undefined, startDate: undefined, dueDate: undefined })
    expect((res.data as { createTask: { id: string } }).createTask.id).toBe('t1')
  })

  it('tasks returns a page; taskBoard returns columns grouped by status', async () => {
    const p = await graphql({ schema: buildSchema(movpSchema), source: 'query { tasks(workspaceId: "w") { items { id } nextCursor } }', contextValue: ctx })
    expect(p.errors).toBeUndefined()
    expect((p.data as { tasks: { items: Array<{ id: string }> } }).tasks.items[0].id).toBe('t1')
    const b = await graphql({ schema: buildSchema(movpSchema), source: 'query { taskBoard(workspaceId: "w") { status { id } tasks { id } } }', contextValue: ctx })
    expect(b.errors).toBeUndefined()
    const col = (b.data as { taskBoard: Array<{ status: { id: string }; tasks: Array<{ id: string }> }> }).taskBoard[0]
    expect(col.status.id).toBe('s1')
    expect(col.tasks[0].id).toBe('t1')
  })

  it('transitionTask + updateTaskDescription + assignTask + addTaskDependency route correctly', async () => {
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { transitionTask(taskId: "t1", statusId: "s2") { id status_id completed_at } }', contextValue: ctx })
    expect(mocks.transition).toHaveBeenCalledWith({ taskId: 't1', statusId: 's2' })
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { updateTaskDescription(taskId: "t1", body: "new") { id } }', contextValue: ctx })
    expect(mocks.updateDescription).toHaveBeenCalledWith('t1', 'new')
    const a = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { assignTask(taskId: "t1", userId: "u2") }', contextValue: ctx })
    expect(mocks.assign).toHaveBeenCalledWith({ taskId: 't1', userId: 'u2' })
    expect((a.data as { assignTask: boolean }).assignTask).toBe(true)
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { addTaskDependency(taskId: "t1", blockerId: "t2") }', contextValue: ctx })
    expect(mocks.addDependency).toHaveBeenCalledWith({ taskId: 't1', blockerId: 't2' })
  })

  it('comments query returns the entity thread via collab.comment.listByEntity', async () => {
    const res = await graphql({ schema: buildSchema(movpSchema), source: 'query { comments(workspaceId: "w", entityType: "task", entityId: "t1") { id body } }', contextValue: ctx })
    expect(res.errors).toBeUndefined()
    expect((res.data as { comments: Array<{ id: string; body: string }> }).comments[0].id).toBe('c1')
  })

  it('surfaces custom task ops + generic option CRUD, but NO generic CRUD for internal task/task_revision', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/\bcreateTask\(/)
    expect(sdl).toMatch(/\btaskBoard\(/)
    expect(sdl).toMatch(/\btransitionTask\(/)
    expect(sdl).toMatch(/type Task\b/)
    expect(sdl).not.toMatch(/type TaskRevision\b/)
    expect(sdl).not.toMatch(/\bcreateTaskRevision\(/)
    expect(sdl).toMatch(/type TaskStatusOption\b/)
    expect(sdl).toMatch(/\bcreateTaskStatusOption\(/)
    expect(sdl).toMatch(/type TaskPriorityOption\b/)
    expect(sdl).toContain('createNote(')
  })
})
