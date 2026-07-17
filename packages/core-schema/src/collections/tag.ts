import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const tag = defineCollection({
  name: 'tag',
  label: 'Tag',
  labelPlural: 'Tags',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
  },
})
