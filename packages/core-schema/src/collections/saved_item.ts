import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const savedItem = defineCollection({
  name: 'saved_item',
  label: 'Saved Item',
  labelPlural: 'Saved Items',
  workspaceScoped: true,
  internal: true,
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    user_id: f.uuid({ label: 'User', required: true }),
  },
})
