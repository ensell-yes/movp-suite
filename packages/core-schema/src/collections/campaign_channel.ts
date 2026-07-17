import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignChannel = defineCollection({
  name: 'campaign_channel',
  label: 'Campaign Channel',
  labelPlural: 'Campaign Channels',
  workspaceScoped: true,
  genericWrite: 'crud',
  fields: {
    // Required relation -> `campaign_id uuid not null references public.campaign(id) on delete cascade`.
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    channel_type: f.enum(['email', 'social', 'web', 'paid', 'event', 'sms', 'other'], {
      label: 'Channel Type',
      reporting: { role: 'dimension' },
    }),
    name: f.text({ label: 'Name' }),
  },
})
