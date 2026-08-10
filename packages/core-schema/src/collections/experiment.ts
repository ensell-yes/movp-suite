import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const experiment = defineCollection({
  name: 'experiment',
  label: 'Experiment',
  labelPlural: 'Experiments',
  workspaceScoped: true,
  internal: true,
  fields: {
    key: f.text({ label: 'Key', required: true, reporting: { role: 'dimension' } }),
    name: f.text({ label: 'Name', required: true }),
    target_content_item: f.relation('content_item', { label: 'Target Content Item', cardinality: 'many-to-one', required: true }),
    status: f.enum(['draft', 'running', 'paused', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
    starts_at: f.datetime({ label: 'Starts At' }),
    ends_at: f.datetime({ label: 'Ends At' }),
  },
})
