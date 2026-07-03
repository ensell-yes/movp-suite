import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskObserver = defineCollection({
  name: 'task_observer',
  label: 'Task Observer',
  labelPlural: 'Task Observers',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    observer_user_id: f.uuid({ label: 'Observer', required: true }),
  },
})
