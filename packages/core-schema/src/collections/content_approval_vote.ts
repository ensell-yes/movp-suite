import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentApprovalVote = defineCollection({
  name: 'content_approval_vote',
  label: 'Content Approval Vote',
  labelPlural: 'Content Approval Votes',
  workspaceScoped: true,
  internal: true,
  fields: {
    approval: f.relation('content_approval', { label: 'Approval', cardinality: 'many-to-one', required: true }),
    voter_id: f.uuid({ label: 'Voter', required: true }),
    vote: f.enum(['approve', 'reject'], { label: 'Vote', required: true }),
  },
})
