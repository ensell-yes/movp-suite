import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const experimentAssignment = defineCollection({
  name: 'experiment_assignment',
  label: 'Experiment Assignment',
  labelPlural: 'Experiment Assignments',
  workspaceScoped: true,
  internal: true,
  fields: {
    experiment: f.relation('experiment', { label: 'Experiment', cardinality: 'many-to-one', required: true }),
    variant: f.relation('experiment_variant', { label: 'Variant', cardinality: 'many-to-one', required: true }),
    assignment_key_hash: f.text({ label: 'Assignment Key Hash', required: true }),
    exposure_count: f.number({ label: 'Exposure Count', default: 1, reporting: { role: 'measure' } }),
    last_seen_at: f.datetime({ label: 'Last Seen At' }),
  },
})
