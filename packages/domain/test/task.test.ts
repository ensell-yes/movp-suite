import { describe, expect, it, vi } from 'vitest'
import { makeTaskService } from '../src/task.ts'

describe('task service', () => {
  it('loads task detail in one query and preserves the public response shape', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        title: 'Ship it',
        start_date: null,
        due_date: null,
        current_revision_id: 'revision-1',
        dependency_blocked: false,
        completed_at: null,
        due_soon_notified_at: null,
        status_id: 'status-1',
        priority_id: 'priority-1',
        parent_id: null,
        created_at: '2026-07-13T00:00:00Z',
        updated_at: '2026-07-13T00:00:00Z',
        current_revision: { body: 'Task body' },
        assignments: [{ id: 'assignment-b' }, { id: 'assignment-a' }],
        observers: [],
        dependencies: [],
        attachments: [],
      },
      error: null,
    }))
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    const service = makeTaskService({ db: { from } as never, userId: 'user-1' })

    const getDetail = service.getDetail
    const detail = await getDetail('task-1')

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('task')
    expect(select).toHaveBeenCalledWith(expect.stringContaining('task_current_revision_fk'))
    expect(select).toHaveBeenCalledWith(expect.stringContaining('task_dependency_task_id_fkey'))
    expect(detail?.description).toBe('Task body')
    expect(detail?.assignments.map((row) => row.id)).toEqual(['assignment-a', 'assignment-b'])
    expect(detail?.task).not.toHaveProperty('current_revision')
    expect(detail?.task).not.toHaveProperty('assignments')
  })
})
