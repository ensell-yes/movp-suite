import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentItem = defineCollection({
  name: 'content_item',
  label: 'Content Item',
  labelPlural: 'Content Items',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_type: f.relation('content_type', { label: 'Content Type', cardinality: 'many-to-one', required: true }),
    slug: f.text({ label: 'Slug', required: true }),
    status: f.enum(['draft', 'in_review', 'approved', 'published', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
    current_revision_id: f.uuid({ label: 'Current Revision' }),
    approved_revision_id: f.uuid({ label: 'Approved Revision' }),
    published_revision_id: f.uuid({ label: 'Published Revision' }),
    published_at: f.datetime({ label: 'Published At' }),
    search_text: f.text({ label: 'Search Text', searchable: true }),
    search_body: f.richText({ label: 'Search Body', searchable: true, embeddable: true }),
  },
})
