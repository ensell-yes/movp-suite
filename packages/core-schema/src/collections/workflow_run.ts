import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const workflowRun = defineCollection({
  name: 'workflow_run',
  label: 'Workflow Run',
  labelPlural: 'Workflow Runs',
  workspaceScoped: true,
  genericWrite: 'none',
  fields: {
    source_event_id: f.uuid({ label: 'Source Event ID', required: true }),
    event_type: f.text({ label: 'Event Type', required: true, reporting: { role: 'dimension' } }),
    automation_rule: f.relation('automation_rule', { label: 'Automation Rule', required: true, cardinality: 'many-to-one', reporting: { role: 'dimension' } }),
    matched: f.boolean({ label: 'Matched', required: true, default: false }),
    action_type: f.text({ label: 'Action Type', required: true, reporting: { role: 'dimension' } }),
    outcome: f.enum(['succeeded', 'failed', 'skipped', 'enqueued'], { label: 'Outcome', required: true, reporting: { role: 'dimension' } }),
    job_id: f.uuid({ label: 'Job ID' }),
    error_code: f.text({ label: 'Error Code' }),
    trace_id: f.text({ label: 'Trace ID' }),
  },
})
