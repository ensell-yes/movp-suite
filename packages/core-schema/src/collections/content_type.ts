import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentType = defineCollection({
  name: 'content_type',
  label: 'Content Type',
  labelPlural: 'Content Types',
  workspaceScoped: true,
  internal: true,
  fields: {
    key: f.text({ label: 'Key', required: true }),
    label: f.text({ label: 'Label', required: true }),
    field_schema: f.json({ label: 'Field Schema', required: true }),
    moderation_policy: f.enum(['none', 'pre', 'post'], {
      label: 'Moderation Policy',
      default: 'none',
      reporting: { role: 'dimension' },
    }),
    approval_policy: f.enum(['none', 'single', 'multi'], {
      label: 'Approval Policy',
      default: 'none',
      reporting: { role: 'dimension' },
    }),
  },
})
