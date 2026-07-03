import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskAssignment = defineCollection({
  name: 'task_assignment',
  label: 'Task Assignment',
  labelPlural: 'Task Assignments',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    assignee_user_id: f.uuid({ label: 'Assignee', required: true }),
    role: f.enum(['owner'], { label: 'Role', default: 'owner' }),
  },
})
