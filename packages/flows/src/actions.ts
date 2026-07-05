import type { SupabaseClient } from '@supabase/supabase-js'
import { createDomain } from '@movp/domain'
import { enqueueJob } from './jobs.ts'
import type { ActionResult, AutomationRuleRow, MovpInternalEvent } from './automation.ts'

const MAX_WORKFLOW_DEPTH = 5
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function objectField(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function intField(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function uuidField(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}

async function rowBelongsToWorkspace(
  db: SupabaseClient,
  table: string,
  id: string,
  workspaceId: string,
): Promise<'ok' | 'missing' | 'error'> {
  const { data, error } = await db
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return 'error'
  return data ? 'ok' : 'missing'
}

async function enqueueNotifyForWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  event: MovpInternalEvent,
  cfg: Record<string, unknown>,
  dedupeKey: string,
): Promise<ActionResult> {
  const recipientUserId = stringField(cfg.recipient_user_id)
  const email = stringField(cfg.email)
  if (!recipientUserId && !email) return { ok: false, errorCode: 'action_config_invalid' }
  try {
    await enqueueJob(db, {
      kind: 'notify',
      idempotencyKey: dedupeKey,
      payload: {
        event: event.type,
        recipient_user_id: recipientUserId ?? undefined,
        email: email ?? undefined,
        title: stringField(cfg.title) ?? event.type,
      },
      workspaceId,
    })
    return { ok: true, outcome: 'enqueued' }
  } catch {
    return { ok: false, errorCode: 'action_dispatch_failed' }
  }
}

async function enqueueSubscriptionWebhook(
  db: SupabaseClient,
  workspaceId: string,
  subscriptionId: unknown,
  event: MovpInternalEvent,
  dedupeKey: string,
): Promise<ActionResult> {
  if (typeof subscriptionId !== 'string') return { ok: false, errorCode: 'action_config_invalid' }
  const { data: sub, error: subErr } = await db
    .from('webhook_subscription')
    .select('id,internal_webhook_id')
    .eq('id', subscriptionId)
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .maybeSingle()
  if (subErr) return { ok: false, errorCode: 'action_dispatch_failed' }
  if (!sub) return { ok: false, errorCode: 'cross_workspace_target' }
  const internalWebhookId = stringField((sub as { internal_webhook_id?: unknown }).internal_webhook_id)
  if (!internalWebhookId) return { ok: false, errorCode: 'phase_unavailable' }

  const internal = (db as unknown as { schema: (name: string) => SupabaseClient }).schema('movp_internal')
  const { data: webhook, error: webhookErr } = await internal
    .from('webhooks')
    .select('url,secret')
    .eq('id', internalWebhookId)
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .maybeSingle()
  if (webhookErr) return { ok: false, errorCode: 'action_dispatch_failed' }
  if (!webhook) return { ok: false, errorCode: 'cross_workspace_target' }

  try {
    await enqueueJob(db, {
      kind: 'webhook',
      idempotencyKey: dedupeKey,
      payload: {
        event: event.type,
        subscription_id: subscriptionId,
        url: stringField((webhook as { url?: unknown }).url),
        secret: stringField((webhook as { secret?: unknown }).secret),
      },
      workspaceId,
    })
    return { ok: true, outcome: 'enqueued' }
  } catch {
    return { ok: false, errorCode: 'action_dispatch_failed' }
  }
}

async function createTaskForWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  event: MovpInternalEvent,
  cfg: Record<string, unknown>,
  dedupeKey: string,
): Promise<ActionResult> {
  const title = stringField(cfg.title)
  if (!title) return { ok: false, errorCode: 'action_config_invalid' }
  try {
    await createDomain({ db, userId: uuidField(cfg.actorId) ?? uuidField(event.payload.actor_id) ?? SYSTEM_ACTOR_ID }).task.create({
      workspaceId,
      title,
      description: stringField(cfg.description) ?? undefined,
      statusId: stringField(cfg.statusId) ?? undefined,
      priorityId: stringField(cfg.priorityId) ?? undefined,
      parentId: stringField(cfg.parentId) ?? undefined,
      startDate: stringField(cfg.startDate) ?? undefined,
      dueDate: stringField(cfg.dueDate) ?? undefined,
      idempotencyKey: dedupeKey,
      actorId: uuidField(cfg.actorId) ?? uuidField(event.payload.actor_id) ?? SYSTEM_ACTOR_ID,
    })
    return { ok: true, outcome: 'succeeded' }
  } catch {
    return { ok: false, errorCode: 'action_dispatch_failed' }
  }
}

async function advanceDeliverableForWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  deliverableId: unknown,
): Promise<ActionResult> {
  if (typeof deliverableId !== 'string') return { ok: false, errorCode: 'action_config_invalid' }
  const ownership = await rowBelongsToWorkspace(db, 'campaign_deliverable', deliverableId, workspaceId)
  if (ownership === 'error') return { ok: false, errorCode: 'action_dispatch_failed' }
  if (ownership === 'missing') return { ok: false, errorCode: 'cross_workspace_target' }
  return { ok: false, errorCode: 'phase_unavailable' }
}

async function enqueueSegmentRecomputeForWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  segmentId: unknown,
  event: MovpInternalEvent,
  dedupeKey: string,
): Promise<ActionResult> {
  if (typeof segmentId !== 'string') return { ok: false, errorCode: 'action_config_invalid' }
  const ownership = await rowBelongsToWorkspace(db, 'segment', segmentId, workspaceId)
  if (ownership === 'error') return { ok: false, errorCode: 'action_dispatch_failed' }
  if (ownership === 'missing') return { ok: false, errorCode: 'cross_workspace_target' }
  try {
    await enqueueJob(db, {
      kind: 'segment_recompute',
      idempotencyKey: dedupeKey,
      payload: { segment_id: segmentId, mode: stringField((event.payload as Record<string, unknown>).mode) ?? 'full', trace_id: event.trace_id },
      workspaceId,
    })
    return { ok: true, outcome: 'enqueued' }
  } catch {
    return { ok: false, errorCode: 'action_dispatch_failed' }
  }
}

async function emitChainedEvent(
  db: SupabaseClient,
  workspaceId: string,
  event: MovpInternalEvent,
  cfg: Record<string, unknown>,
): Promise<ActionResult> {
  const eventType = stringField(cfg.eventType)
  if (!eventType) return { ok: false, errorCode: 'action_config_invalid' }
  const depth = intField(event.payload.depth)
  if (depth >= MAX_WORKFLOW_DEPTH) return { ok: false, errorCode: 'loop_depth_exceeded' }
  const payload = { ...objectField(cfg.payload), depth: depth + 1 }
  const { error } = await db.rpc('emit_event', {
    ev_type: eventType,
    ws: workspaceId,
    payload,
    trace: event.trace_id,
  })
  if (error) return { ok: false, errorCode: error.code ?? 'action_dispatch_failed' }
  return { ok: true, outcome: 'succeeded' }
}

export async function dispatchWorkflowAction(
  db: SupabaseClient,
  input: {
    workspaceId: string
    event: MovpInternalEvent
    rule: AutomationRuleRow
    dedupeKey: string
  },
): Promise<ActionResult> {
  const cfg = input.rule.action_config as Record<string, unknown>
  if (typeof cfg.workspaceId === 'string' && cfg.workspaceId !== input.workspaceId) {
    return { ok: false, errorCode: 'cross_workspace_target' }
  }
  switch (input.rule.action_type) {
    case 'notify':
      return enqueueNotifyForWorkspace(db, input.workspaceId, input.event, cfg, input.dedupeKey)
    case 'deliver_webhook':
      return enqueueSubscriptionWebhook(db, input.workspaceId, cfg.subscriptionId, input.event, input.dedupeKey)
    case 'create_task':
      return createTaskForWorkspace(db, input.workspaceId, input.event, cfg, input.dedupeKey)
    case 'advance_deliverable':
      return advanceDeliverableForWorkspace(db, input.workspaceId, cfg.deliverableId)
    case 'recompute_segment':
      return enqueueSegmentRecomputeForWorkspace(db, input.workspaceId, cfg.segmentId, input.event, input.dedupeKey)
    case 'emit_event':
      return emitChainedEvent(db, input.workspaceId, input.event, cfg)
    default:
      return { ok: false, errorCode: 'action_config_invalid' }
  }
}
