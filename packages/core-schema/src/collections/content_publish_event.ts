import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentPublishEvent = defineCollection({
  name: 'content_publish_event',
  label: 'Content Publish Event',
  labelPlural: 'Content Publish Events',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    action: f.enum(['publish', 'unpublish'], {
      label: 'Action',
      required: true,
      reporting: { role: 'dimension' },
    }),
    revision: f.relation('content_revision', { label: 'Revision', cardinality: 'many-to-one', required: true }),
    content_hash: f.text({ label: 'Content Hash', required: true }),
    actor_id: f.uuid({ label: 'Actor', required: true }),
  },
})
