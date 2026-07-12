import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const admin = {
  apikey: env.serviceRole,
  Authorization: `Bearer ${env.serviceRole}`,
  'content-type': 'application/json',
}

function userClient(token: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function assertOk(response: Response, label: string): Promise<Response> {
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`)
  return response
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'object' || value === null || !(field in value)) {
    throw new Error(`response missing ${field}`)
  }
  const result = value[field as keyof typeof value]
  if (typeof result !== 'string') throw new Error(`response has invalid ${field}`)
  return result
}

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `reporting-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const created: unknown = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    }),
    'create user',
  )).json()
  const signedIn: unknown = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    'sign in',
  )).json()
  return { id: stringField(created, 'id'), token: stringField(signedIn, 'access_token') }
}

async function makeWorkspace(name: string): Promise<string> {
  const rows: unknown = await (await assertOk(
    await fetch(`${env.url}/rest/v1/workspace`, {
      method: 'POST',
      headers: { ...admin, Prefer: 'return=representation' },
      body: JSON.stringify({ name }),
    }),
    'create workspace',
  )).json()
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('workspace response has invalid shape')
  return stringField(rows[0], 'id')
}

async function addMember(workspaceId: string, userId: string): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ workspace_id: workspaceId, user_id: userId, role: 'member' }),
    }),
    'add member',
  )
}

let workspaceId: string
let otherWorkspaceId: string
let domain: ReturnType<typeof createDomain>

beforeAll(async () => {
  const user = await makeUser()
  workspaceId = await makeWorkspace(`RepDomW-${crypto.randomUUID().slice(0, 8)}`)
  otherWorkspaceId = await makeWorkspace(`RepDomX-${crypto.randomUUID().slice(0, 8)}`)
  await addMember(workspaceId, user.id)
  const db = userClient(user.token)
  domain = createDomain({ db, userId: user.id })

  const { data: campaign, error: campaignError } = await db
    .from('campaign')
    .insert({ workspace_id: workspaceId, name: 'Rep A', status: 'active' })
    .select('id')
    .single()
  if (campaignError || !campaign) throw new Error(`campaign seed failed: ${campaignError?.code ?? 'no_data'}`)
  const { error: metricError } = await db.from('campaign_metric').insert([
    { workspace_id: workspaceId, campaign_id: campaign.id, metric_key: 'clicks', value: 30, measured_at: new Date().toISOString().slice(0, 10) },
    { workspace_id: workspaceId, campaign_id: campaign.id, metric_key: 'clicks', value: 70, measured_at: new Date().toISOString().slice(0, 10) },
  ])
  if (metricError) throw new Error(`metric seed failed: ${metricError.code}`)

  const { data: eventType, error: eventError } = await db
    .from('event_type')
    .select('id')
    .eq('key', 'task.completed')
    .single()
  if (eventError || !eventType) throw new Error(`event type lookup failed: ${eventError?.code ?? 'no_data'}`)
  const { data: rule, error: ruleError } = await db
    .from('automation_rule')
    .insert({
      workspace_id: workspaceId,
      trigger_event_type_id: eventType.id,
      condition: {},
      action_type: 'notify',
      action_config: {},
    })
    .select('id')
    .single()
  if (ruleError || !rule) throw new Error(`rule seed failed: ${ruleError?.code ?? 'no_data'}`)
  await assertOk(
    await fetch(`${env.url}/rest/v1/workflow_run`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify([
        {
          workspace_id: workspaceId,
          source_event_id: crypto.randomUUID(),
          event_type: 'task.completed',
          automation_rule_id: rule.id,
          matched: true,
          action_type: 'notify',
          outcome: 'succeeded',
        },
        {
          workspace_id: workspaceId,
          source_event_id: crypto.randomUUID(),
          event_type: 'task.completed',
          automation_rule_id: rule.id,
          matched: true,
          action_type: 'notify',
          outcome: 'failed',
        },
      ]),
    }),
    'workflow run seed',
  )
}, 60_000)

describe('domain.reporting (live stack)', () => {
  it('sums campaign metrics through the reporting view', async () => {
    const rows = await domain.reporting.campaignMetrics({ workspaceId })
    expect(rows.find((row) => row.metric_key === 'clicks')?.total).toBe(100)
  })

  it('groups workflow outcomes by day', async () => {
    const rows = await domain.reporting.workflowHealth({ workspaceId })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(['succeeded', 'failed']))
  })

  it('returns the full task throughput shape when empty', async () => {
    const result = await domain.reporting.taskThroughput({ workspaceId, days: 7 })
    expect(result).toEqual({ avg_cycle_hours: null, open_count: 0, series: [] })
  })

  it('returns bounded event classifiers', async () => {
    const rows = await domain.reporting.eventDailyCounts({ workspaceId, days: 7 })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['count', 'day', 'type'])
  })

  it('fails loud with 42501 for a non-member workspace', async () => {
    await expect(domain.reporting.campaignMetrics({ workspaceId: otherWorkspaceId })).rejects.toThrow(
      /domain\.reporting\.campaignMetrics failed \[42501\]/,
    )
  })
})
