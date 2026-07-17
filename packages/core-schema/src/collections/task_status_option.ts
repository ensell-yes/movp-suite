import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskStatusOption = defineCollection({
  name: 'task_status_option',
  label: 'Task Status Option',
  labelPlural: 'Task Status Options',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    label: f.text({ label: 'Label', required: true }),
    category: f.enum(['backlog', 'active', 'blocked', 'done'], {
      label: 'Category',
      required: true,
      reporting: { role: 'dimension' },
    }),
    color: f.text({ label: 'Color' }),
    sort_order: f.number({ label: 'Sort Order' }),
    is_default: f.boolean({ label: 'Is Default' }),
    is_active: f.boolean({ label: 'Is Active' }),
  },
})
