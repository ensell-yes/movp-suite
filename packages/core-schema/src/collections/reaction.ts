import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const reaction = defineCollection({
  name: 'reaction',
  label: 'Reaction',
  labelPlural: 'Reactions',
  workspaceScoped: true,
  internal: true,
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    user_id: f.uuid({ label: 'User', required: true }),
    kind: f.enum(['like', 'dislike'], { label: 'Kind', required: true, reporting: { role: 'dimension' } }),
  },
})
