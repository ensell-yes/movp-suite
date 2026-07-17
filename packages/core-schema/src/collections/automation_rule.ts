import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const automationRule = defineCollection({
  name: 'automation_rule',
  label: 'Automation Rule',
  labelPlural: 'Automation Rules',
  workspaceScoped: true,
  genericWrite: 'none',
  fields: {
    trigger_event_type: f.relation('event_type', { label: 'Trigger Event Type', cardinality: 'many-to-one', required: true }),
    condition: f.json({ label: 'Condition', required: true }),
    action_type: f.enum(['notify', 'deliver_webhook', 'create_task', 'advance_deliverable', 'recompute_segment', 'emit_event'], {
      label: 'Action Type',
      required: true,
      reporting: { role: 'dimension' },
    }),
    action_config: f.json({ label: 'Action Config', required: true }),
    enabled: f.boolean({ label: 'Enabled', required: true, default: true }),
    priority: f.number({ label: 'Priority', required: true, default: 100 }),
  },
})
