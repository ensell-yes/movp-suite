import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentSnapshot = defineCollection({
  name: 'segment_snapshot',
  label: 'Segment Snapshot',
  labelPlural: 'Segment Snapshots',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    taken_at: f.datetime({ label: 'Taken At' }),
    reason: f.enum(['on_demand', 'scheduled', 'campaign_launch'], { label: 'Reason', reporting: { role: 'dimension' } }),
    rule_version_set: f.json({ label: 'Rule Version Set' }),
    member_count: f.number({ label: 'Member Count', reporting: { role: 'measure' } }),
  },
})
