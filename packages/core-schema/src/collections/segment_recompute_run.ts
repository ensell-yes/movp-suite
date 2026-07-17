import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segmentRecomputeRun = defineCollection({
  name: 'segment_recompute_run',
  label: 'Segment Recompute Run',
  labelPlural: 'Segment Recompute Runs',
  workspaceScoped: true,
  genericWrite: 'none',
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    mode: f.text({ label: 'Mode', reporting: { role: 'dimension' } }),
    started_at: f.datetime({ label: 'Started At' }),
    finished_at: f.datetime({ label: 'Finished At' }),
    added_count: f.number({ label: 'Added Count', reporting: { role: 'measure' } }),
    removed_count: f.number({ label: 'Removed Count', reporting: { role: 'measure' } }),
    evaluated_count: f.number({ label: 'Evaluated Count', reporting: { role: 'measure' } }),
    idempotency_key: f.text({ label: 'Idempotency Key' }),
    outcome_code: f.text({ label: 'Outcome Code' }),
  },
})
