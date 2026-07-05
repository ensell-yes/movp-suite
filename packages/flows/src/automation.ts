import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateCondition } from './condition.ts'
import { claimDueJobs, completeJob } from './jobs.ts'
import { dispatchWorkflowAction } from './actions.ts'

type RunOutcome = 'succeeded' | 'failed' | 'skipped' | 'enqueued'

const TERMINAL = new Set<RunOutcome>(['succeeded', 'failed', 'skipped'])

export interface MovpInternalEvent {
  id: string
  type: string
  workspace_id: string
  payload: Record<string, unknown>
  trace_id: string | null
}

export interface AutomationRuleRow {
  id: string
  workspace_id: string
  condition: Record<string, unknown>
  action_type: string
  action_config: Record<string, unknown>
  enabled: boolean
  priority: number
  trigger_event_type_id: string
  created_at: string
}

export type ActionResult =
  | { ok: true; outcome: 'succeeded' | 'enqueued'; jobId?: string | null }
  | { ok: false; errorCode: string }

export type WorkflowActionDispatcher = (
  db: SupabaseClient,
  input: {
    workspaceId: string
    event: MovpInternalEvent
    rule: AutomationRuleRow
    dedupeKey: string
  },
) => Promise<ActionResult>

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function errorCode(e: unknown): string {
  return e instanceof Error && e.message ? e.message.slice(0, 40) : 'unknown'
}

async function loadInternalEvent(db: SupabaseClient, eventId: string, workspaceId: string | null): Promise<MovpInternalEvent | null> {
  if (!workspaceId) return null
  const internal = (db as unknown as { schema: (name: string) => SupabaseClient }).schema('movp_internal')
  const { data, error } = await internal
    .from('movp_events')
    .select('id,type,workspace_id,payload,trace_id')
    .eq('id', eventId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(error.code ?? 'event_load_failed')
  return data as MovpInternalEvent | null
}

async function loadEnabledRules(db: SupabaseClient, workspaceId: string, eventType: string): Promise<AutomationRuleRow[]> {
  const { data: eventTypeRow, error: eventTypeError } = await db
    .from('event_type')
    .select('id')
    .eq('key', eventType)
    .maybeSingle()
  if (eventTypeError) throw new Error(eventTypeError.code ?? 'event_type_load_failed')
  const eventTypeId = (eventTypeRow as { id?: unknown } | null)?.id
  if (typeof eventTypeId !== 'string') return []

  const { data, error } = await db
    .from('automation_rule')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('trigger_event_type_id', eventTypeId)
    .eq('enabled', true)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.code ?? 'automation_rule_load_failed')
  return (Array.isArray(data) ? data : []) as AutomationRuleRow[]
}

async function currentRun(db: SupabaseClient, eventId: string, ruleId: string): Promise<{ outcome: RunOutcome } | null> {
  const { data, error } = await db
    .from('workflow_run')
    .select('outcome')
    .eq('source_event_id', eventId)
    .eq('automation_rule_id', ruleId)
    .maybeSingle()
  if (error) throw new Error(error.code ?? 'workflow_run_load_failed')
  return data as { outcome: RunOutcome } | null
}

async function insertRunIfAbsent(
  db: SupabaseClient,
  args: { event: MovpInternalEvent; rule: AutomationRuleRow; matched: boolean; outcome: RunOutcome; errorCode?: string | null },
): Promise<boolean> {
  const { event, rule } = args
  const { error } = await db
    .from('workflow_run')
    .insert({
      workspace_id: event.workspace_id,
      source_event_id: event.id,
      event_type: event.type,
      automation_rule_id: rule.id,
      matched: args.matched,
      action_type: rule.action_type,
      outcome: args.outcome,
      error_code: args.errorCode ?? null,
      trace_id: event.trace_id,
    })
    .select('id')
    .single()
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(error.code ?? 'workflow_run_insert_failed')
}

async function finishRun(
  db: SupabaseClient,
  eventId: string,
  ruleId: string,
  patch: { outcome: RunOutcome; errorCode?: string | null; jobId?: string | null },
): Promise<void> {
  const { error } = await db
    .from('workflow_run')
    .update({
      outcome: patch.outcome,
      error_code: patch.errorCode ?? null,
      job_id: patch.jobId ?? null,
    })
    .eq('source_event_id', eventId)
    .eq('automation_rule_id', ruleId)
  if (error) throw new Error(error.code ?? 'workflow_run_update_failed')
}

async function processRule(
  db: SupabaseClient,
  event: MovpInternalEvent,
  rule: AutomationRuleRow,
  dispatch: WorkflowActionDispatcher,
): Promise<void> {
  const dedupeKey = `${event.id}:${rule.id}`
  const condition = evaluateCondition(rule.condition, { event_type: event.type, ...event.payload })
  if (!condition.ok) {
    await insertRunIfAbsent(db, { event, rule, matched: false, outcome: 'skipped', errorCode: condition.errorCode })
    await finishRun(db, event.id, rule.id, { outcome: 'skipped', errorCode: condition.errorCode })
    return
  }

  const inserted = await insertRunIfAbsent(db, { event, rule, matched: condition.matched, outcome: 'enqueued' })
  if (!inserted) {
    const existing = await currentRun(db, event.id, rule.id)
    if (existing && TERMINAL.has(existing.outcome)) return
  }

  if (!condition.matched) {
    await finishRun(db, event.id, rule.id, { outcome: 'skipped' })
    return
  }

  if (typeof rule.action_config.workspaceId === 'string' && rule.action_config.workspaceId !== event.workspace_id) {
    await finishRun(db, event.id, rule.id, { outcome: 'skipped', errorCode: 'cross_workspace_target' })
    return
  }

  const result = await dispatch(db, {
    workspaceId: event.workspace_id,
    event,
    rule,
    dedupeKey,
  })
  await finishRun(db, event.id, rule.id, result.ok
    ? { outcome: result.outcome, jobId: result.jobId ?? null }
    : { outcome: 'failed', errorCode: result.errorCode })
}

export async function runAutomationWorker(
  db: SupabaseClient,
  limit = 10,
  opts: { dispatch?: WorkflowActionDispatcher } = {},
): Promise<{ processed: number; failed: number }> {
  const dispatch = opts.dispatch ?? dispatchWorkflowAction
  let processed = 0
  let failed = 0

  for (const job of await claimDueJobs(db, 'automate', limit)) {
    try {
      const eventId = stringField(job.payload.event_id)
      if (!eventId) throw new Error('event_not_found')
      const event = await loadInternalEvent(db, eventId, job.workspace_id)
      if (!event) throw new Error('event_not_found')
      const rules = await loadEnabledRules(db, event.workspace_id, event.type)
      for (const rule of rules) {
        await processRule(db, event, rule, dispatch)
      }
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, errorCode(e))
      failed++
    }
  }

  return { processed, failed }
}
