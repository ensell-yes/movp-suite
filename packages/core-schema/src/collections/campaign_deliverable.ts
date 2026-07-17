import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// THIN by design: no status/start_date/due_date/priority/assignee/description columns —
// those live on the linked task (Part B adds the `implemented_by` edge). A pgTAP
// no-duplication gate asserts their ABSENCE; do not add them here.
export const campaignDeliverable = defineCollection({
  name: 'campaign_deliverable',
  label: 'Campaign Deliverable',
  labelPlural: 'Campaign Deliverables',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    // Optional relation -> `channel_id uuid references public.campaign_channel(id) on delete set null`.
    channel: f.relation('campaign_channel', { label: 'Channel', cardinality: 'many-to-one' }),
    name: f.text({ label: 'Name', required: true, searchable: true }),
    deliverable_type: f.enum(['asset', 'post', 'email', 'landing_page', 'ad', 'event'], {
      label: 'Deliverable Type',
      reporting: { role: 'dimension' },
    }),
  },
})
