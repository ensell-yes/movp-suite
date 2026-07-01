import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const note = defineCollection({
  name: 'note',
  label: 'Note',
  labelPlural: 'Notes',
  workspaceScoped: true,
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    body: f.richText({ label: 'Body', searchable: true, embeddable: true }),
    status: f.enum(['draft', 'published', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
    tags: f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true }),
  },
})
