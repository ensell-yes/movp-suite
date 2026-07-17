import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskPriorityOption = defineCollection({
  name: 'task_priority_option',
  label: 'Task Priority Option',
  labelPlural: 'Task Priority Options',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    label: f.text({ label: 'Label', required: true }),
    rank: f.number({ label: 'Rank', required: true }),
    color: f.text({ label: 'Color' }),
    is_default: f.boolean({ label: 'Is Default' }),
    is_active: f.boolean({ label: 'Is Active' }),
  },
})
