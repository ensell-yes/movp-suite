import type {
  AutomationRuleRow,
  EventTypeRow,
  WebhookSubscriptionRow,
} from './generated/types.ts'
import type { DomainCtx, Page, WorkflowService } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)
type QueryBuilder = any

function fail(op: string, code: string | undefined): never {
  throw new Error(`domain.workflows.${op} failed [${code ?? 'unknown'}]`)
}

async function page<Row extends { id: string }>(
  query: QueryBuilder,
  args: { first?: number; after?: string | null },
  op: string,
): Promise<Page<Row>> {
  const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
  let q = query.order('id', { ascending: true }).limit(first + 1)
  if (args.after) q = q.gt('id', decodeCursor(args.after))
  const { data, error } = await q
  if (error) fail(op, error.code)
  const rows = (data ?? []) as Row[]
  const items = rows.length > first ? rows.slice(0, first) : rows
  const last = items.at(-1)
  return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
}

async function rpcRow<Row>(
  ctx: DomainCtx,
  name: string,
  args: Record<string, unknown>,
  op: string,
): Promise<Row> {
  const { data, error } = await ctx.db.rpc(name, args)
  if (error || !data) fail(op, error?.code ?? 'not_found')
  return data as Row
}

function parseRpcObject(data: unknown, op: string): Record<string, unknown> {
  if (!data || typeof data !== 'object') fail(op, 'invalid_rpc_response')
  return data as Record<string, unknown>
}

export function makeWorkflowService(ctx: DomainCtx): WorkflowService {
  return {
    listEventTypes(args) {
      return page<EventTypeRow>(
        ctx.db.from('event_type').select('*').eq('active', true),
        args,
        'listEventTypes',
      )
    },

    listRules(args) {
      return page<AutomationRuleRow>(
        ctx.db.from('automation_rule').select('*').eq('workspace_id', args.workspaceId),
        args,
        'listRules',
      )
    },

    async upsertRule(input) {
      const row = {
        workspace_id: input.workspaceId,
        trigger_event_type_id: input.triggerEventTypeId,
        condition: input.condition ?? {},
        action_type: input.actionType,
        action_config: input.actionConfig,
        enabled: input.enabled,
        priority: input.priority,
      }
      const q = input.id
        ? ctx.db
          .from('automation_rule')
          .update(row)
          .eq('id', input.id)
          .eq('workspace_id', input.workspaceId)
          .select('*')
          .single()
        : ctx.db.from('automation_rule').insert(row).select('*').single()
      const { data, error } = await q
      if (error || !data) fail('upsertRule', error?.code ?? 'not_found')
      return data as AutomationRuleRow
    },

    async getEvent(args) {
      const { data, error } = await ctx.db.rpc('get_event', { ev_id: args.eventId, ws: args.workspaceId })
      if (error) fail('getEvent', error.code)
      return data as Record<string, unknown> | null
    },

    async registerWebhook(input) {
      const { data, error } = await ctx.db.rpc('register_webhook_subscription', {
        ws: input.workspaceId,
        event_key: input.eventKey,
        hook_url: input.url,
        filter: input.filter ?? null,
      })
      if (error) fail('registerWebhook', error.code)
      const row = parseRpcObject(data, 'registerWebhook')
      return { subscriptionId: String(row.subscription_id), secret: String(row.secret) }
    },

    async rotateWebhook(input) {
      const { data, error } = await ctx.db.rpc('rotate_webhook_secret', {
        subscription_id: input.subscriptionId,
        ws: input.workspaceId,
      })
      if (error) fail('rotateWebhook', error.code)
      const row = parseRpcObject(data, 'rotateWebhook')
      return { subscriptionId: String(row.subscription_id), secret: String(row.secret) }
    },

    setWebhookActive(input) {
      return rpcRow<WebhookSubscriptionRow>(
        ctx,
        'set_webhook_active',
        { subscription_id: input.subscriptionId, ws: input.workspaceId, active: input.active },
        'setWebhookActive',
      )
    },

    setWebhookFilter(input) {
      return rpcRow<WebhookSubscriptionRow>(
        ctx,
        'set_webhook_filter',
        { subscription_id: input.subscriptionId, ws: input.workspaceId, filter: input.filter },
        'setWebhookFilter',
      )
    },
  }
}
