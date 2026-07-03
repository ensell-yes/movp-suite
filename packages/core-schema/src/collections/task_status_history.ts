import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskStatusHistory = defineCollection({
  name: 'task_status_history',
  label: 'Task Status History',
  labelPlural: 'Task Status History',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    from_status_id: f.uuid({ label: 'From Status' }),
    to_status_id: f.uuid({ label: 'To Status', required: true }),
    changed_by: f.uuid({ label: 'Changed By', required: true }),
  },
})
