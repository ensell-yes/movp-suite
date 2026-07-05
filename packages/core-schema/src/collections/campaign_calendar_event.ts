import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const campaignCalendarEvent = defineCollection({
  name: 'campaign_calendar_event',
  label: 'Campaign Calendar Event',
  labelPlural: 'Campaign Calendar Events',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', cardinality: 'many-to-one', required: true }),
    title: f.text({ label: 'Title', required: true, searchable: true }),
    event_date: f.date({ label: 'Event Date', required: true, reporting: { role: 'dimension' } }),
    event_type: f.enum(['milestone', 'launch', 'review', 'deadline'], {
      label: 'Event Type',
      reporting: { role: 'dimension' },
    }),
  },
})
