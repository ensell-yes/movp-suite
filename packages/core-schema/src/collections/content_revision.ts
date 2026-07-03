import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentRevision = defineCollection({
  name: 'content_revision',
  label: 'Content Revision',
  labelPlural: 'Content Revisions',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_item: f.relation('content_item', { label: 'Item', cardinality: 'many-to-one', required: true }),
    revision_number: f.number({ label: 'Revision Number', required: true }),
    data: f.json({ label: 'Data', required: true }),
    content_hash: f.text({ label: 'Content Hash', required: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
    parent: f.relation('content_revision', { label: 'Parent Revision', cardinality: 'many-to-one' }),
  },
})
