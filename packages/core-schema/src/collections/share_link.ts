import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const shareLink = defineCollection({
  name: 'share_link',
  label: 'Share Link',
  labelPlural: 'Share Links',
  workspaceScoped: true,
  internal: true,
  fields: {
    entity_type: f.text({ label: 'Entity Type', required: true }),
    entity_id: f.uuid({ label: 'Entity', required: true }),
    token_hash: f.text({ label: 'Token Hash', required: true }),
    scope: f.enum(['view'], { label: 'Scope', default: 'view' }),
    created_by: f.uuid({ label: 'Created By', required: true }),
    expires_at: f.datetime({ label: 'Expires At' }),
  },
})
