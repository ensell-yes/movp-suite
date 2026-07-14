import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => {
  const eventType = {
    id: 'evt1',
    key: 'task.completed',
    domain: 'task',
    payload_schema: {},
    version: 1,
    active: true,
    created_at: 't',
    updated_at: 't',
  }
  const rule = {
    id: 'rule1',
    workspace_id: 'w',
    trigger_event_type_id: 'evt1',
    condition: {},
    action_type: 'notify',
    action_config: { recipient_user_id: 'u' },
    enabled: true,
    priority: 10,
    created_at: 't',
    updated_at: 't',
  }
  const subscription = {
    id: 'sub1',
    workspace_id: 'w',
    event_type_id: 'evt1',
    url: 'https://hooks.example.test/workflows',
    filter: null,
    active: true,
    secret_set: true,
    secret_last_rotated_at: 't',
    internal_webhook_id: 'wh1',
    created_at: 't',
    updated_at: 't',
  }
  return {
    listEventTypes: vi.fn(async (args: unknown) => ({ items: [eventType], nextCursor: null, args })),
    listRules: vi.fn(async (args: unknown) => ({ items: [rule], nextCursor: null, args })),
    upsertRule: vi.fn(async (input: unknown) => ({ ...rule, ...(input as Record<string, unknown>) })),
    getEvent: vi.fn(async () => ({
      id: 'ev1',
      type: 'task.completed',
      workspace_id: 'w',
      payload: { task_id: 'task1', email: 'member@example.test', body: 'Secret body should not render' },
      trace_id: 'trace-1',
      created_at: 't',
    })),
    registerWebhook: vi.fn(async () => ({ subscriptionId: 'sub1', secret: 's'.repeat(64) })),
    rotateWebhook: vi.fn(async () => ({ subscriptionId: 'sub1', secret: 'r'.repeat(64) })),
    setWebhookActive: vi.fn(async () => ({ ...subscription, active: false })),
    setWebhookFilter: vi.fn(async () => ({ ...subscription, filter: { field: 'event', op: 'eq', value: 'task.completed' } })),
    webhookList: vi.fn(async () => ({ items: [subscription], nextCursor: null })),
  }
})

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    workflows: {
      listEventTypes: mocks.listEventTypes,
      listRules: mocks.listRules,
      upsertRule: mocks.upsertRule,
      getEvent: mocks.getEvent,
      registerWebhook: mocks.registerWebhook,
      rotateWebhook: mocks.rotateWebhook,
      setWebhookActive: mocks.setWebhookActive,
      setWebhookFilter: mocks.setWebhookFilter,
    },
    webhook_subscription: {
      create: vi.fn(),
      get: vi.fn(),
      list: mocks.webhookList,
      update: vi.fn(),
      delete: vi.fn(),
    },
    collection: (name: string) => {
      if (name !== 'webhook_subscription') throw new Error(`unexpected collection: ${name}`)
      return {
        create: vi.fn(),
        get: vi.fn(),
        list: mocks.webhookList,
        update: vi.fn(),
        delete: vi.fn(),
      }
    },
  }),
}))

const rpc = vi.fn(async () => ({ data: 3, error: null }))
const ctx = { db: { rpc } as never, userId: 'u' }
const run = (source: string) => graphql({ schema: buildSchema(movpSchema), source, contextValue: ctx })

describe('workflow GraphQL surface', () => {
  it('lists event types and automation rules with page-size clamping', async () => {
    const events = await run('query { eventTypes(first: 1000) { items { id key domain active } nextCursor } }')
    expect(events.errors).toBeUndefined()
    expect(mocks.listEventTypes).toHaveBeenCalledWith({ first: 100, after: null })
    expect((events.data as { eventTypes: { items: Array<{ key: string }> } }).eventTypes.items[0].key).toBe('task.completed')

    const rules = await run('query { automationRules(workspaceId: "w", first: 1000) { items { id action_type priority enabled } } }')
    expect(rules.errors).toBeUndefined()
    expect(mocks.listRules).toHaveBeenCalledWith({ workspaceId: 'w', first: 100, after: null })
  })

  it('upserts rules and parses JSON condition/action config', async () => {
    const res = await run('mutation { upsertAutomationRule(workspaceId: "w", triggerEventTypeId: "evt1", condition: "{\\"field\\":\\"event\\"}", actionType: "notify", actionConfig: "{\\"recipient_user_id\\":\\"u\\"}", enabled: true, priority: 7) { id action_type priority } }')
    expect(res.errors).toBeUndefined()
    expect(mocks.upsertRule).toHaveBeenCalledWith({
      workspaceId: 'w',
      id: undefined,
      triggerEventTypeId: 'evt1',
      condition: { field: 'event' },
      actionType: 'notify',
      actionConfig: { recipient_user_id: 'u' },
      enabled: true,
      priority: 7,
    })
  })

  it('registers and rotates with one-time secret but generic subscription reads do not expose secret', async () => {
    const register = await run('mutation { registerWebhookSubscription(workspaceId: "w", eventKey: "task.completed", url: "https://hooks.example.test/workflows") { subscriptionId secret } }')
    expect(register.errors).toBeUndefined()
    expect((register.data as { registerWebhookSubscription: { secret: string } }).registerWebhookSubscription.secret).toHaveLength(64)

    const rotate = await run('mutation { rotateWebhookSecret(workspaceId: "w", subscriptionId: "sub1") { subscriptionId secret } }')
    expect(rotate.errors).toBeUndefined()
    expect((rotate.data as { rotateWebhookSecret: { secret: string } }).rotateWebhookSecret.secret).toHaveLength(64)

    const subs = await run('query { webhook_subscriptions(workspaceId: "w") { items { id url active secret_set internal_webhook_id } } }')
    expect(subs.errors).toBeUndefined()
    expect(JSON.stringify(subs.data)).not.toContain('ssss')
    expect(printSchema(buildSchema(movpSchema))).not.toMatch(/type WebhookSubscription[\s\S]*\bsecret:/)
  })

  it('routes workflowEvent with workspace id', async () => {
    const res = await run('query { workflowEvent(workspaceId: "w", eventId: "ev1") }')
    expect(res.errors).toBeUndefined()
    expect(mocks.getEvent).toHaveBeenCalledWith({ workspaceId: 'w', eventId: 'ev1' })
    const event = JSON.parse((res.data as { workflowEvent: string }).workflowEvent)
    expect(event.type).toBe('task.completed')
    expect(event.payload_keys).toEqual(['body', 'email', 'task_id'])
    expect(JSON.stringify(event)).not.toContain('member@example.test')
    expect(JSON.stringify(event)).not.toContain('Secret body should not render')
  })

  it('updates webhook active/filter and replays dead workflow jobs', async () => {
    await run('mutation { setWebhookActive(workspaceId: "w", subscriptionId: "sub1", active: false) { id active } }')
    expect(mocks.setWebhookActive).toHaveBeenCalledWith({ workspaceId: 'w', subscriptionId: 'sub1', active: false })

    await run('mutation { setWebhookFilter(workspaceId: "w", subscriptionId: "sub1", filter: "{\\"field\\":\\"event\\"}") { id filter } }')
    expect(mocks.setWebhookFilter).toHaveBeenCalledWith({ workspaceId: 'w', subscriptionId: 'sub1', filter: { field: 'event' } })

    const replay = await run('mutation { replayDeadWorkflowJobs(workspaceId: "w") { replayed } }')
    expect(replay.errors).toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('replay_workflow_jobs', { ws: 'w', only_dead: true })
    expect((replay.data as { replayDeadWorkflowJobs: { replayed: number } }).replayDeadWorkflowJobs.replayed).toBe(3)
  })
})
