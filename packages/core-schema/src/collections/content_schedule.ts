import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentSchedule = defineCollection({
  name: 'content_schedule',
  label: 'Content Schedule',
  labelPlural: 'Content Schedules',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    action: f.enum(['publish', 'unpublish'], { label: 'Action', required: true }),
    revision: f.relation('content_revision', { label: 'Revision', cardinality: 'many-to-one', required: true }),
    run_at: f.datetime({ label: 'Run At', required: true }),
    scheduled_by: f.uuid({ label: 'Scheduled By', required: true }),
    state: f.enum(['scheduled', 'fired', 'canceled', 'failed'], {
      label: 'State',
      default: 'scheduled',
      reporting: { role: 'dimension' },
    }),
  },
})
