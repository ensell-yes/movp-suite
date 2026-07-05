import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignMetric = defineCollection({
  name: 'campaign_metric',
  label: 'Campaign Metric',
  labelPlural: 'Campaign Metrics',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    // Optional relations -> `deliverable_id`/`channel_id uuid references ... on delete set null`.
    deliverable: f.relation('campaign_deliverable', { label: 'Deliverable', cardinality: 'many-to-one' }),
    channel: f.relation('campaign_channel', { label: 'Channel', cardinality: 'many-to-one' }),
    metric_key: f.text({ label: 'Metric Key', reporting: { role: 'dimension' } }),
    value: f.number({ label: 'Value', reporting: { role: 'measure' } }),
    unit: f.text({ label: 'Unit', reporting: { role: 'dimension' } }),
    measured_at: f.date({ label: 'Measured At', reporting: { role: 'dimension' } }),
  },
})
