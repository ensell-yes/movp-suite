import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const task = defineCollection({
  name: 'task',
  label: 'Task',
  labelPlural: 'Tasks',
  workspaceScoped: true,
  internal: true,
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    status: f.relation('task_status_option', { label: 'Status', cardinality: 'many-to-one', required: true }),
    priority: f.relation('task_priority_option', { label: 'Priority', cardinality: 'many-to-one', required: true }),
    parent: f.relation('task', { label: 'Parent Task', cardinality: 'many-to-one' }),
    start_date: f.date({ label: 'Start Date' }),
    due_date: f.date({ label: 'Due Date' }),
    current_revision_id: f.uuid({ label: 'Current Revision' }),
    dependency_blocked: f.boolean({ label: 'Dependency Blocked' }),
    completed_at: f.datetime({ label: 'Completed At' }),
    due_soon_notified_at: f.datetime({ label: 'Due Soon Notified At' }),
  },
})
