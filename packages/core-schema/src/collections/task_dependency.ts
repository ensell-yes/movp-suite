import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskDependency = defineCollection({
  name: 'task_dependency',
  label: 'Task Dependency',
  labelPlural: 'Task Dependencies',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    blocker: f.relation('task', { label: 'Blocker', cardinality: 'many-to-one', required: true }),
  },
})
