import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchWorkflowAction } from '../src/actions.ts'
import { runAutomationWorker, type WorkflowActionDispatcher } from '../src/automation.ts'

type Row = Record<string, unknown>

class Query {
  private filters: Array<[string, unknown]> = []
  private orders: Array<{ column: string; ascending: boolean }> = []
  private maxRows: number | null = null
  private op: 'select' | 'insert' | 'update' = 'select'
  private insertRow: Row | null = null
  private updatePatch: Row | null = null

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(): this {
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value])
    return this
  }

  order(column: string, opts: { ascending: boolean }): this {
    this.orders.push({ column, ascending: opts.ascending })
    return this
  }

  limit(n: number): this {
    this.maxRows = n
    return this
  }

  insert(row: Row): this {
    this.op = 'insert'
    this.insertRow = row
    return this
  }

  update(patch: Row): this {
    this.op = 'update'
    this.updatePatch = patch
    return this
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null }
  }

  async single(): Promise<{ data: Row | null; error: { code: string } | null }> {
    if (this.op === 'insert') return this.execInsert()
    return { data: this.rows()[0] ?? null, error: null }
  }

  then<TResult1 = { data: Row[] | null; error: { code: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { code: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected)
  }

  private async exec(): Promise<{ data: Row[] | null; error: { code: string } | null }> {
    if (this.op === 'update') return this.execUpdate()
    return { data: this.rows(), error: null }
  }

  private async execInsert(): Promise<{ data: Row | null; error: { code: string } | null }> {
    if (!this.insertRow) return { data: null, error: { code: 'insert_missing' } }
    const runs = this.db.tables.workflow_run
    if (
      this.table === 'workflow_run'
      && runs.some((r) => r.source_event_id === this.insertRow?.source_event_id && r.automation_rule_id === this.insertRow?.automation_rule_id)
    ) {
      return { data: null, error: { code: '23505' } }
    }
    const row = { id: `${this.table}-${this.db.nextId++}`, ...this.insertRow }
    this.db.tables[this.table].push(row)
    return { data: row, error: null }
  }

  private async execUpdate(): Promise<{ data: Row[] | null; error: { code: string } | null }> {
    if (this.table === 'workflow_run' && this.db.failNextRunUpdate) {
      this.db.failNextRunUpdate = false
      return { data: null, error: { code: 'crash_after_dispatch' } }
    }
    for (const row of this.rows()) Object.assign(row, this.updatePatch)
    return { data: [], error: null }
  }

  private rows(): Row[] {
    let rows = [...this.db.tables[this.table]]
    for (const [column, value] of this.filters) rows = rows.filter((r) => r[column] === value)
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows.sort((a, b) => {
        const av = a[column]
        const bv = b[column]
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''))
        return ascending ? cmp : -cmp
      })
    }
    return this.maxRows == null ? rows : rows.slice(0, this.maxRows)
  }
}

class FakeDb {
  nextId = 1
  failNextRunUpdate = false
  completed: Row[] = []
  enqueued: Row[] = []
  taskCreates: Row[] = []
  emitted: Row[] = []
  jobs: Row[] = []
  tables: Record<string, Row[]> = {
    movp_events: [],
    webhooks: [],
    event_type: [],
    automation_rule: [],
    workflow_run: [],
    webhook_subscription: [],
    segment: [],
    campaign_deliverable: [],
    task_status_option: [],
    task_priority_option: [],
  }

  rpc = vi.fn(async (fn: string, args: Row) => {
    if (fn === 'claim_jobs') return { data: args.job_kind === 'automate' ? this.jobs : [], error: null }
    if (fn === 'get_event') {
      const row = this.tables.movp_events.find((event) => event.id === args.ev_id && event.workspace_id === args.ws)
      return { data: row ?? null, error: null }
    }
    if (fn === 'enqueue_job') {
      this.enqueued.push(args)
      return { data: null, error: null }
    }
    if (fn === 'create_workflow_task_with_revision') {
      this.taskCreates.push(args)
      return { data: { id: `task-${this.taskCreates.length}`, workspace_id: args.ws, title: args.p_title }, error: null }
    }
    if (fn === 'workflow_emit_event') {
      this.emitted.push(args)
      return { data: null, error: null }
    }
    if (fn === 'workflow_webhook_for_action') {
      const sub = this.tables.webhook_subscription.find((row) => row.id === args.sub_id && row.workspace_id === args.ws && row.active !== false)
      if (!sub) return { data: null, error: null }
      const webhook = this.tables.webhooks.find((row) => row.id === sub.internal_webhook_id && row.workspace_id === args.ws && row.active !== false)
      return { data: webhook ? { url: webhook.url, secret: webhook.secret } : null, error: null }
    }
    if (fn === 'complete_job') {
      this.completed.push(args)
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })

  schema(name: string): { from: (table: string) => Query } {
    throw new Error(`schema_not_exposed:${name}`)
  }

  from(table: string): Query {
    return new Query(this, table)
  }
}

function baseDb(): FakeDb {
  const db = new FakeDb()
  db.tables.event_type.push({ id: 'et-task-completed', key: 'task.completed' })
  db.tables.movp_events.push({
    id: 'event-1',
    type: 'task.completed',
    workspace_id: 'ws-1',
    payload: { entity_type: 'task', score: 4 },
    trace_id: 'trace-1',
  })
  db.jobs.push({
    id: 'job-1',
    kind: 'automate',
    idempotency_key: 'event-1',
    payload: { event_id: 'event-1', event_type: 'task.completed', depth: 0 },
    workspace_id: 'ws-1',
    attempts: 1,
    max_attempts: 8,
    status: 'running',
  })
  return db
}

function baseEvent() {
  return {
    id: 'event-1',
    type: 'task.completed',
    workspace_id: 'ws-1',
    payload: { actor_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', depth: 0 },
    trace_id: 'trace-1',
  }
}

function baseRule(actionType: string, actionConfig: Record<string, unknown>): Row {
  return {
    id: 'rule-1',
    workspace_id: 'ws-1',
    trigger_event_type_id: 'et-task-completed',
    condition: {},
    action_type: actionType,
    action_config: actionConfig,
    enabled: true,
    priority: 1,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function addRule(db: FakeDb, row: Partial<Row>): void {
  db.tables.automation_rule.push({
    id: `rule-${db.tables.automation_rule.length + 1}`,
    workspace_id: 'ws-1',
    trigger_event_type_id: 'et-task-completed',
    condition: {},
    action_type: 'notify',
    action_config: {},
    enabled: true,
    priority: 10,
    created_at: '2026-01-01T00:00:00Z',
    ...row,
  })
}

describe('runAutomationWorker', () => {
  it('creates one run per matching rule ordered by priority', async () => {
    const db = baseDb()
    addRule(db, { id: 'later', priority: 20, created_at: '2026-01-02T00:00:00Z' })
    addRule(db, { id: 'earlier', priority: 1, created_at: '2026-01-01T00:00:00Z' })
    const dispatched: string[] = []
    const dispatch: WorkflowActionDispatcher = vi.fn(async (_db, input) => {
      dispatched.push(input.rule.id)
      return { ok: true as const, outcome: 'succeeded' as const }
    })

    const res = await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })

    expect(res).toEqual({ processed: 1, failed: 0 })
    expect(dispatched).toEqual(['earlier', 'later'])
    expect(db.tables.workflow_run.map((r) => [r.automation_rule_id, r.outcome])).toEqual([
      ['earlier', 'succeeded'],
      ['later', 'succeeded'],
    ])
  })

  it('skips non-matching and invalid conditions without dispatching', async () => {
    const db = baseDb()
    addRule(db, { id: 'no-match', condition: { field: 'score', op: 'gt', value: 10 } })
    addRule(db, { id: 'invalid', condition: { field: 'score', op: 'around', value: 4 } })
    const dispatch: WorkflowActionDispatcher = vi.fn(async () => ({ ok: true as const, outcome: 'succeeded' as const }))

    await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })

    expect(dispatch).not.toHaveBeenCalled()
    expect(db.tables.workflow_run.map((r) => [r.automation_rule_id, r.outcome, r.error_code ?? null])).toEqual([
      ['no-match', 'skipped', null],
      ['invalid', 'skipped', 'condition_unknown_operator'],
    ])
  })

  it('does not redispatch terminal runs on retry', async () => {
    const db = baseDb()
    addRule(db, { id: 'done-rule' })
    db.tables.workflow_run.push({
      id: 'existing',
      workspace_id: 'ws-1',
      source_event_id: 'event-1',
      event_type: 'task.completed',
      automation_rule_id: 'done-rule',
      matched: true,
      action_type: 'notify',
      outcome: 'succeeded',
      trace_id: 'trace-1',
    })
    const dispatch: WorkflowActionDispatcher = vi.fn(async () => ({ ok: true as const, outcome: 'succeeded' as const }))

    await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('retries in-flight runs with the same dedupe key so non-idempotent actions can dedupe', async () => {
    const db = baseDb()
    addRule(db, { id: 'create-task', action_type: 'create_task' })
    db.failNextRunUpdate = true
    const createdTasks = new Set<string>()
    const dedupeKeys: string[] = []
    const dispatch: WorkflowActionDispatcher = vi.fn(async (_db, input) => {
      dedupeKeys.push(input.dedupeKey)
      createdTasks.add(input.dedupeKey)
      return { ok: true as const, outcome: 'succeeded' as const }
    })

    expect(await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })).toEqual({ processed: 0, failed: 1 })
    expect(await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })).toEqual({ processed: 1, failed: 0 })

    expect(dedupeKeys).toEqual(['event-1:create-task', 'event-1:create-task'])
    expect(createdTasks.size).toBe(1)
    expect(db.tables.workflow_run[0]).toMatchObject({ outcome: 'succeeded' })
  })

  it('skips config that targets a foreign workspace before dispatch', async () => {
    const db = baseDb()
    addRule(db, { id: 'foreign', action_config: { workspaceId: 'ws-2' } })
    const dispatch: WorkflowActionDispatcher = vi.fn(async () => ({ ok: true as const, outcome: 'succeeded' as const }))

    await runAutomationWorker(db as unknown as SupabaseClient, 10, { dispatch })

    expect(dispatch).not.toHaveBeenCalled()
    expect(db.tables.workflow_run[0]).toMatchObject({ outcome: 'skipped', error_code: 'cross_workspace_target' })
  })

  it('resolves seeded $event placeholders before dispatching an enabled template rule', async () => {
    const db = baseDb()
    db.tables.event_type.push({ id: 'et-segment-membership', key: 'segment.membership_changed' })
    db.tables.movp_events[0] = {
      id: 'event-1',
      type: 'segment.membership_changed',
      workspace_id: 'ws-1',
      payload: { entity_id: '11111111-1111-1111-1111-111111111111' },
      trace_id: 'trace-1',
    }
    db.tables.segment.push({ id: '11111111-1111-1111-1111-111111111111', workspace_id: 'ws-1' })
    addRule(db, {
      id: 'seed-recompute',
      trigger_event_type_id: 'et-segment-membership',
      action_type: 'recompute_segment',
      action_config: { segmentId: '$event.entity_id' },
    })

    await runAutomationWorker(db as unknown as SupabaseClient)

    expect(db.enqueued[0]).toMatchObject({
      job_kind: 'segment_recompute',
      idem_key: 'event-1:seed-recompute',
      ws: 'ws-1',
      payload: { segment_id: '11111111-1111-1111-1111-111111111111' },
    })
    expect(db.tables.workflow_run[0]).toMatchObject({ automation_rule_id: 'seed-recompute', outcome: 'enqueued' })
  })
})

describe('dispatchWorkflowAction', () => {
  it('rejects action_config.workspaceId instead of using it as authority', async () => {
    const db = baseDb()
    const result = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('notify', { workspaceId: 'ws-2', email: 'a@example.test' }) as any,
      dedupeKey: 'event-1:rule-1',
    })

    expect(result).toEqual({ ok: false, errorCode: 'cross_workspace_target' })
    expect(db.enqueued).toHaveLength(0)
  })

  it('enqueues notify jobs using the event workspace and dedupe key', async () => {
    const db = baseDb()
    const result = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('notify', { recipient_user_id: 'user-1', title: 'Heads up' }) as any,
      dedupeKey: 'event-1:rule-1',
    })

    expect(result).toEqual({ ok: true, outcome: 'enqueued' })
    expect(db.enqueued[0]).toMatchObject({
      job_kind: 'notify',
      idem_key: 'event-1:rule-1',
      ws: 'ws-1',
    })
  })

  it('passes idempotency and actor context into create_task', async () => {
    const db = baseDb()
    db.tables.task_status_option.push({ id: 'status-1', workspace_id: 'ws-1', is_default: true, is_active: true, sort_order: 1 })
    db.tables.task_priority_option.push({ id: 'priority-1', workspace_id: 'ws-1', is_default: true, is_active: true, rank: 1 })

    const result = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('create_task', { title: 'Follow up' }) as any,
      dedupeKey: 'event-1:rule-1',
    })

    expect(result).toEqual({ ok: true, outcome: 'succeeded' })
    expect(db.taskCreates[0]).toMatchObject({
      ws: 'ws-1',
      p_title: 'Follow up',
      p_status_id: 'status-1',
      p_priority_id: 'priority-1',
      p_idempotency_key: 'event-1:rule-1',
      p_actor_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    })
  })

  it('proves segment ownership before enqueuing recompute', async () => {
    const db = baseDb()
    db.tables.segment.push({ id: '11111111-1111-1111-1111-111111111111', workspace_id: 'ws-1' })

    const ok = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('recompute_segment', { segmentId: '11111111-1111-1111-1111-111111111111' }) as any,
      dedupeKey: 'event-1:rule-1',
    })
    const cross = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('recompute_segment', { segmentId: '22222222-2222-2222-2222-222222222222' }) as any,
      dedupeKey: 'event-1:rule-2',
    })

    expect(ok).toEqual({ ok: true, outcome: 'enqueued' })
    expect(cross).toEqual({ ok: false, errorCode: 'cross_workspace_target' })
    expect(db.enqueued[0]).toMatchObject({
      job_kind: 'segment_recompute',
      idem_key: 'event-1:rule-1',
      ws: 'ws-1',
    })
  })

  it('resolves managed webhooks through a public RPC instead of direct internal schema reads', async () => {
    const db = baseDb()
    db.tables.webhook_subscription.push({ id: 'sub-1', workspace_id: 'ws-1', internal_webhook_id: 'wh-1', active: true })
    db.tables.webhooks.push({ id: 'wh-1', workspace_id: 'ws-1', url: 'https://example.test/hook', secret: 'secret', active: true })

    const result = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('deliver_webhook', { subscriptionId: 'sub-1' }) as any,
      dedupeKey: 'event-1:rule-1',
    })

    expect(result).toEqual({ ok: true, outcome: 'enqueued' })
    expect(db.enqueued[0]).toMatchObject({
      job_kind: 'webhook',
      idem_key: 'event-1:rule-1',
      ws: 'ws-1',
      payload: {
        event: 'task.completed',
        subscription_id: 'sub-1',
        webhook_id: 'wh-1',
        url: 'https://example.test/hook',
        secret: 'secret',
      },
    })
  })

  it('enforces the emit_event loop depth cap', async () => {
    const db = baseDb()
    const atCap = { ...baseEvent(), payload: { depth: 5 } }
    const skipped = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: atCap,
      rule: baseRule('emit_event', { eventType: 'task.due_soon' }) as any,
      dedupeKey: 'event-1:rule-1',
    })
    const emitted = await dispatchWorkflowAction(db as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      event: baseEvent(),
      rule: baseRule('emit_event', { eventType: 'task.due_soon', payload: { id: 'next' } }) as any,
      dedupeKey: 'event-1:rule-2',
    })

    expect(skipped).toEqual({ ok: false, errorCode: 'loop_depth_exceeded' })
    expect(emitted).toEqual({ ok: true, outcome: 'succeeded' })
    expect(db.emitted[0]).toMatchObject({
      ev_type: 'task.due_soon',
      ws: 'ws-1',
      payload: { id: 'next', depth: 1 },
      trace: 'trace-1',
      dedupe_key: 'event-1:rule-2',
    })
  })
})
