import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Append-only FACT table. INSERT is allowed to workspace members; UPDATE/DELETE are blocked
// by a 2F004 immutability trigger added in 20260701000019_segmentation.sql. Codegen emits NO
// composite indexes — the two reporting indexes are hand-added in that migration too.
export const platformEvent = defineCollection({
  name: 'platform_event',
  label: 'Platform Event',
  labelPlural: 'Platform Events',
  workspaceScoped: true,
  genericWrite: 'append-only',
  fields: {
    // NOT searchable: FTS would emit a `search_vector` column + GIN index + a BEFORE INSERT/UPDATE
    // tsvector trigger on this highest-volume append-only fact (bridge + 500-row ingest batches).
    // Equality lookups are served by the two composite indexes hand-added in 000019 — keep only
    // the reporting dimension. (F5)
    event_type: f.text({ label: 'Event Type', required: true, reporting: { role: 'dimension' } }),
    subject_type: f.text({ label: 'Subject Type', required: true, reporting: { role: 'dimension' } }),
    subject_ref: f.text({ label: 'Subject Ref', required: true }),
    actor_ref: f.text({ label: 'Actor Ref' }),
    source: f.enum(['internal', 'external'], { label: 'Source', required: true, reporting: { role: 'dimension' } }),
    properties: f.json({ label: 'Properties' }),
    occurred_at: f.datetime({ label: 'Occurred At', required: true, reporting: { role: 'dimension' } }),
    ingested_at: f.datetime({ label: 'Ingested At', required: true }),
  },
})
