import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const mention = defineCollection({
  name: 'mention',
  label: 'Mention',
  labelPlural: 'Mentions',
  workspaceScoped: true,
  internal: true,
  fields: {
    comment: f.relation('comment', { label: 'Comment', cardinality: 'many-to-one', required: true }),
    mentioned_user_id: f.uuid({ label: 'Mentioned User', required: true }),
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
  },
})
