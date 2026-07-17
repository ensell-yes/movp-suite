import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Writable now — stores targeting INTENT (a user can record primary/lookalike/exclusion
// targeting immediately). The campaign→segment edge resolves to zero rows until Phase 6's
// `segment` collection lands, per the roadmap's forward-compatible-seam design. Segment
// RESOLUTION activates in Phase 6; do NOT defer this collection.
export const campaignSegment = defineCollection({
  name: 'campaign_segment',
  label: 'Campaign Segment',
  labelPlural: 'Campaign Segments',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    targeting_role: f.enum(['primary', 'lookalike', 'exclusion'], {
      label: 'Targeting Role',
      default: 'primary',
      reporting: { role: 'dimension' },
    }),
    weight: f.number({ label: 'Weight' }),
  },
})
