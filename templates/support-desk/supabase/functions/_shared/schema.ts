import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

const slaPolicy = defineCollection({
  name: 'sla_policy',
  label: 'SLA Policy',
  labelPlural: 'SLA Policies',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    first_response_minutes: f.number({ label: 'First response (min)', required: true, reporting: { role: 'measure' } }),
    resolution_minutes: f.number({ label: 'Resolution (min)', required: true, reporting: { role: 'measure' } }),
  },
})

const supportTicket = defineCollection({
  name: 'support_ticket',
  label: 'Support Ticket',
  labelPlural: 'Support Tickets',
  workspaceScoped: true,
  fields: {
    subject: f.text({ label: 'Subject', required: true, searchable: true }),
    requester_email: f.text({ label: 'Requester email', required: true }),
    channel: f.enum(['email', 'web', 'chat'], {
      label: 'Channel',
      default: 'web',
      reporting: { role: 'dimension' },
    }),
    sla_due_at: f.datetime({ label: 'SLA due at' }),
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    policy: f.relation('sla_policy', { label: 'SLA policy', cardinality: 'many-to-one' }),
  },
})

export const schema = defineSchema({
  extends: platformSchema,
  collections: [slaPolicy, supportTicket],
})

export default schema
