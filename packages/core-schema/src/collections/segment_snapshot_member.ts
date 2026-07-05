import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Append-only, but RLS-ONLY (F3): 000019 replaces the blanket `_rw` with SELECT + INSERT member
// policies and DOES NOT add a BEFORE UPDATE/DELETE 2F004 trigger. A direct user DELETE is blocked
// (no DELETE policy -> RLS no-op), while a CASCADE delete from a parent segment/segment_snapshot
// (a referential action that bypasses RLS) still cleans up — a 2F004 trigger would abort that
// permitted parent delete with a cryptic code, so this child is guarded by RLS only.
export const segmentSnapshotMember = defineCollection({
  name: 'segment_snapshot_member',
  label: 'Segment Snapshot Member',
  labelPlural: 'Segment Snapshot Members',
  workspaceScoped: true,
  fields: {
    // Required relation -> `snapshot_id uuid not null references public.segment_snapshot(id) on delete cascade`.
    snapshot: f.relation('segment_snapshot', { label: 'Snapshot', cardinality: 'many-to-one', required: true }),
    // REQUIRED (F8): a snapshot member with no subject_ref is meaningless; `required: true` -> `not null`.
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    // Optional relation -> `matched_rule_id uuid references public.segment_rule(id) on delete set null`.
    matched_rule: f.relation('segment_rule', { label: 'Matched Rule', cardinality: 'many-to-one' }),
    evidence: f.json({ label: 'Evidence' }),
  },
})
