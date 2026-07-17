import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const marketingPlan = defineCollection({
  name: 'marketing_plan',
  label: 'Marketing Plan',
  labelPlural: 'Marketing Plans',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    description: f.richText({ label: 'Description', searchable: true }),
    period_start: f.date({ label: 'Period Start', reporting: { role: 'dimension' } }),
    period_end: f.date({ label: 'Period End', reporting: { role: 'dimension' } }),
    goals: f.json({ label: 'Goals' }),
    // User reference is a plain uuid (no FK to auth.users).
    owner_id: f.uuid({ label: 'Owner' }),
    status: f.enum(['draft', 'active', 'archived'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})
