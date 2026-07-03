import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentApproval = defineCollection({
  name: 'content_approval',
  label: 'Content Approval',
  labelPlural: 'Content Approvals',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    state: f.enum(['pending', 'approved', 'rejected', 'superseded'], {
      label: 'State',
      default: 'pending',
      reporting: { role: 'dimension' },
    }),
    policy: f.enum(['single', 'multi', 'moderation'], {
      label: 'Policy',
      required: true,
      reporting: { role: 'dimension' },
    }),
    approvals_required: f.number({ label: 'Approvals Required', default: 1 }),
    approved_revision: f.relation('content_revision', { label: 'Approved Revision', cardinality: 'many-to-one' }),
    approved_content_hash: f.text({ label: 'Approved Content Hash' }),
    decided_at: f.datetime({ label: 'Decided At' }),
    decided_by: f.uuid({ label: 'Decided By' }),
  },
})
