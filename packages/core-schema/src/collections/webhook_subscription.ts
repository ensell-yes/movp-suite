import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const webhookSubscription = defineCollection({
  name: 'webhook_subscription',
  label: 'Webhook Subscription',
  labelPlural: 'Webhook Subscriptions',
  workspaceScoped: true,
  genericWrite: 'none',
  fields: {
    event_type: f.relation('event_type', { label: 'Event Type', cardinality: 'many-to-one', required: true }),
    url: f.text({ label: 'URL', required: true }),
    filter: f.json({ label: 'Filter' }),
    active: f.boolean({ label: 'Active', required: true, default: true }),
    secret_set: f.boolean({ label: 'Secret Set', required: true, default: false }),
    secret_last_rotated_at: f.datetime({ label: 'Secret Last Rotated At' }),
    internal_webhook_id: f.uuid({ label: 'Internal Webhook' }),
  },
})
