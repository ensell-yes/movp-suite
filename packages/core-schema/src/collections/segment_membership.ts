import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// The 000019 migration adds `unique(segment_id, subject_ref)` (one live membership per
// subject per segment) — codegen cannot express a composite unique.
export const segmentMembership = defineCollection({
  name: 'segment_membership',
  label: 'Segment Membership',
  labelPlural: 'Segment Memberships',
  workspaceScoped: true,
  fields: {
    // Required relation -> `segment_id uuid not null references public.segment(id) on delete cascade`.
    segment: f.relation('segment', { label: 'Segment', cardinality: 'many-to-one', required: true }),
    subject_type: f.text({ label: 'Subject Type', reporting: { role: 'dimension' } }),
    // REQUIRED (F8): a null subject cannot participate in `unique(segment_id, subject_ref)` — two
    // null-subject rows would both be allowed (NULLs are distinct under a unique), defeating the
    // one-membership-per-subject invariant. `required: true` -> `not null` in the generated table.
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    // Optional relation -> `matched_rule_id uuid references public.segment_rule(id) on delete set null`.
    matched_rule: f.relation('segment_rule', { label: 'Matched Rule', cardinality: 'many-to-one' }),
    first_matched_at: f.datetime({ label: 'First Matched At' }),
    evaluated_at: f.datetime({ label: 'Evaluated At' }),
    evidence: f.json({ label: 'Evidence' }),
  },
})
