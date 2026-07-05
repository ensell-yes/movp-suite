import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentRule = defineCollection({
  name: 'segment_rule',
  label: 'Segment Rule',
  labelPlural: 'Segment Rules',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    predicate: f.json({ label: 'Predicate' }),
    version: f.number({ label: 'Version' }),
    active: f.boolean({ label: 'Active', reporting: { role: 'dimension' } }),
    description: f.text({ label: 'Description' }),
  },
})
