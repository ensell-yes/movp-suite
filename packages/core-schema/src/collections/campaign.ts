import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaign = defineCollection({
  name: 'campaign',
  label: 'Campaign',
  labelPlural: 'Campaigns',
  workspaceScoped: true,
  fields: {
    // Optional relation -> `marketing_plan_id uuid references public.marketing_plan(id) on delete set null`.
    marketing_plan: f.relation('marketing_plan', { label: 'Marketing Plan', cardinality: 'many-to-one' }),
    name: f.text({ label: 'Name', required: true, searchable: true }),
    brief: f.richText({ label: 'Brief', searchable: true, embeddable: true }),
    start_date: f.date({ label: 'Start Date', reporting: { role: 'dimension' } }),
    end_date: f.date({ label: 'End Date', reporting: { role: 'dimension' } }),
    owner_id: f.uuid({ label: 'Owner' }),
    goal_metrics: f.json({ label: 'Goal Metrics' }),
    priority: f.enum(['low', 'medium', 'high', 'urgent'], {
      label: 'Priority',
      default: 'medium',
      reporting: { role: 'dimension' },
    }),
    rank: f.number({ label: 'Rank', reporting: { role: 'dimension' } }),
    status: f.enum(['draft', 'scheduled', 'active', 'completed', 'cancelled'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})
