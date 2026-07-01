import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const comment = defineCollection({
  name: 'comment',
  label: 'Comment',
  labelPlural: 'Comments',
  workspaceScoped: true,
  internal: true,
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
    parent: f.relation('comment', { label: 'Parent Comment', cardinality: 'many-to-one' }),
  },
})
