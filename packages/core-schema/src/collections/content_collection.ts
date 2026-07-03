import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentCollection = defineCollection({
  name: 'content_collection',
  label: 'Content Collection',
  labelPlural: 'Content Collections',
  workspaceScoped: true,
  internal: true,
  fields: {
    key: f.text({ label: 'Key', required: true }),
    label: f.text({ label: 'Label', required: true }),
    description: f.text({ label: 'Description' }),
  },
})
