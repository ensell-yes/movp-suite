import type { TaskRow, TaskStatusOptionRow } from './generated/types.ts'
import type { DomainCtx, Page, TaskBoardColumn, TaskService } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)

export function makeTaskService(ctx: DomainCtx): TaskService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.task.${op} failed [${code ?? 'unknown'}]`)
  }

  async function defaultOption(table: 'task_status_option' | 'task_priority_option', ws: string): Promise<string | null> {
    const base = ctx.db
      .from(table)
      .select('id')
      .eq('workspace_id', ws)
      .eq('is_default', true)
      .eq('is_active', true)
    const query = table === 'task_status_option'
      ? base.order('sort_order', { ascending: true })
      : base.order('rank', { ascending: true })
    const { data, error } = await query.limit(1).maybeSingle()
    if (error) fail('defaultOption', error.code)
    return (data as { id?: string } | null)?.id ?? null
  }

  async function taskWorkspace(taskId: string): Promise<string> {
    const { data, error } = await ctx.db.from('task').select('workspace_id').eq('id', taskId).maybeSingle()
    if (error) fail('resolveTask', error.code)
    const ws = (data as { workspace_id?: string } | null)?.workspace_id
    if (!ws) throw new Error('domain.task: task not found or inaccessible')
    return ws
  }

  return {
    async create(i) {
      const statusId = i.statusId ?? (await defaultOption('task_status_option', i.workspaceId))
      const priorityId = i.priorityId ?? (await defaultOption('task_priority_option', i.workspaceId))
      const { data, error } = await ctx.db.rpc('create_task_with_revision', {
        ws: i.workspaceId,
        p_title: i.title,
        p_status_id: statusId,
        p_priority_id: priorityId,
        p_parent_id: i.parentId ?? null,
        p_start_date: i.startDate ?? null,
        p_due_date: i.dueDate ?? null,
        p_body: i.description ?? null,
      })
      if (error) fail('create', error.code)
      return data as TaskRow
    },

    async get(id) {
      const { data, error } = await ctx.db.from('task').select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as TaskRow | null) ?? null
    },

    async list(a) {
      const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db.from('task').select('*').eq('workspace_id', a.workspaceId)
      if (a.statusId) q = q.eq('status_id', a.statusId)
      if (a.parentId === null) q = q.is('parent_id', null)
      else if (a.parentId != null) q = q.eq('parent_id', a.parentId)
      if (a.assigneeId) {
        const { data: asg, error: asgErr } = await ctx.db
          .from('task_assignment')
          .select('task_id')
          .eq('assignee_user_id', a.assigneeId)
        if (asgErr) fail('list.assignee', asgErr.code)
        const ids = (asg ?? []).map((r: { task_id: string }) => r.task_id)
        if (ids.length === 0) return { items: [], nextCursor: null }
        q = q.in('id', ids)
      }
      q = q.order('id', { ascending: true }).limit(first + 1)
      if (a.after) q = q.gt('id', decodeCursor(a.after))
      const { data, error } = await q
      if (error) fail('list', error.code)
      const rows = (data ?? []) as TaskRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async board(a) {
      const { data: statusData, error: statusErr } = await ctx.db
        .from('task_status_option')
        .select('*')
        .eq('workspace_id', a.workspaceId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      if (statusErr) fail('board.status', statusErr.code)
      const statuses = (statusData ?? []) as TaskStatusOptionRow[]
      const { data: taskData, error: taskErr } = await ctx.db
        .from('task')
        .select('*')
        .eq('workspace_id', a.workspaceId)
        .order('id', { ascending: true })
      if (taskErr) fail('board.tasks', taskErr.code)
      const tasks = (taskData ?? []) as TaskRow[]
      return statuses.map((status) => ({ status, tasks: tasks.filter((t) => t.status_id === status.id) }))
    },

    async updateDescription(id, body) {
      const { data, error } = await ctx.db.rpc('update_task_description', { p_task_id: id, p_body: body })
      if (error) fail('updateDescription', error.code)
      return data as TaskRow
    },

    async assign(i) {
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_assignment').upsert(
        { workspace_id: ws, task_id: i.taskId, assignee_user_id: i.userId, role: 'owner' },
        { onConflict: 'task_id,assignee_user_id', ignoreDuplicates: true },
      )
      if (error) fail('assign', error.code)
    },

    async unassign(i) {
      const { error } = await ctx.db.from('task_assignment').delete()
        .eq('task_id', i.taskId)
        .eq('assignee_user_id', i.userId)
      if (error) fail('unassign', error.code)
    },

    async addObserver(i) {
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_observer').upsert(
        { workspace_id: ws, task_id: i.taskId, observer_user_id: i.userId },
        { onConflict: 'task_id,observer_user_id', ignoreDuplicates: true },
      )
      if (error) fail('addObserver', error.code)
    },

    async removeObserver(i) {
      const { error } = await ctx.db.from('task_observer').delete()
        .eq('task_id', i.taskId)
        .eq('observer_user_id', i.userId)
      if (error) fail('removeObserver', error.code)
    },

    async transition(i) {
      const { data, error } = await ctx.db.from('task').update({ status_id: i.statusId })
        .eq('id', i.taskId)
        .select('*')
        .maybeSingle()
      if (error) fail('transition', error.code)
      if (!data) throw new Error('domain.task.transition: task not found or inaccessible')
      const refreshed = await this.get(i.taskId)
      if (!refreshed) throw new Error('domain.task.transition: task not found or inaccessible')
      return refreshed
    },

    async addDependency(i) {
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_dependency').upsert(
        { workspace_id: ws, task_id: i.taskId, blocker_id: i.blockerId },
        { onConflict: 'task_id,blocker_id', ignoreDuplicates: true },
      )
      if (error) fail('addDependency', error.code)
    },

    async removeDependency(i) {
      const { error } = await ctx.db.from('task_dependency').delete()
        .eq('task_id', i.taskId)
        .eq('blocker_id', i.blockerId)
      if (error) fail('removeDependency', error.code)
    },

    async attach(i) {
      const ws = await taskWorkspace(i.taskId)
      const { error } = await ctx.db.from('task_attachment').insert({
        workspace_id: ws,
        task_id: i.taskId,
        r2_key: i.r2Key,
        filename: i.filename,
        content_type: i.contentType ?? null,
        bytes: i.bytes ?? null,
        uploaded_by: ctx.userId,
      })
      if (error) fail('attach', error.code)
    },
  }
}
