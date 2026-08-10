import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const experimentVariant = defineCollection({
  name: 'experiment_variant',
  label: 'Experiment Variant',
  labelPlural: 'Experiment Variants',
  workspaceScoped: true,
  internal: true,
  fields: {
    experiment: f.relation('experiment', { label: 'Experiment', cardinality: 'many-to-one', required: true }),
    key: f.text({ label: 'Key', required: true, reporting: { role: 'dimension' } }),
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    traffic_basis_points: f.number({ label: 'Traffic Basis Points', required: true, reporting: { role: 'measure' } }),
    active: f.boolean({ label: 'Active', default: true, reporting: { role: 'dimension' } }),
    position: f.number({ label: 'Position', default: 0 }),
  },
})
