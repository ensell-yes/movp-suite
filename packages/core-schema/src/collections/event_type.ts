import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const eventType = defineCollection({
  name: 'event_type',
  label: 'Event Type',
  labelPlural: 'Event Types',
  workspaceScoped: false,
  fields: {
    key: f.text({ label: 'Key', required: true, reporting: { role: 'dimension' } }),
    domain: f.enum(['collaboration', 'task', 'cms', 'campaign', 'segmentation', 'lifecycle', 'workflow'], {
      label: 'Domain',
      required: true,
      reporting: { role: 'dimension' },
    }),
    label: f.text({ label: 'Label', required: true }),
    payload_schema: f.json({ label: 'Payload Schema', required: true }),
    schema_version: f.number({ label: 'Schema Version', required: true, default: 1 }),
    active: f.boolean({ label: 'Active', required: true, default: true }),
    description: f.text({ label: 'Description', searchable: true }),
  },
})
