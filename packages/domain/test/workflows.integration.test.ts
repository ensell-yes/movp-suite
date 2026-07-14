import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { schema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

function serviceClient(): SupabaseClient {
  return createClient(env.url, env.serviceRole, { auth: { persistSession: false } })
}

function userClient(token: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function assertOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
  return res
}

async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `workflow-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const created = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    }),
    'create user',
  )).json()
  const signedIn = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    'sign in',
  )).json()
  return { id: created.id as string, token: signedIn.access_token as string }
}

async function makeWorkspace(name: string): Promise<string> {
  const rows = await (await assertOk(
    await fetch(`${env.url}/rest/v1/workspace`, {
      method: 'POST',
      headers: { ...admin, Prefer: 'return=representation' },
      body: JSON.stringify({ name }),
    }),
    'create workspace',
  )).json()
  return rows[0].id as string
}

async function addMember(ws: string, userId: string): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ workspace_id: ws, user_id: userId, role: 'member' }),
    }),
    'add member',
  )
}

describe('workflow domain integration', () => {
  it('lists catalog, upserts rules, keeps webhook secrets one-time, and scopes event reads', async () => {
    const ws = await makeWorkspace('Workflow WS')
    const otherWs = await makeWorkspace('Other Workflow WS')
    const user = await makeUser()
    await addMember(ws, user.id)
    await addMember(otherWs, user.id)

    const domain = createDomain({ db: userClient(user.token), userId: user.id }, { schema })
    const adminDb = serviceClient()

    const catalog = await domain.workflows.listEventTypes({ first: 100 })
    const taskCompleted = catalog.items.find((e) => e.key === 'task.completed')
    expect(taskCompleted).toBeTruthy()

    const rule = await domain.workflows.upsertRule({
      workspaceId: ws,
      triggerEventTypeId: taskCompleted!.id,
      condition: {},
      actionType: 'notify',
      actionConfig: { recipient_user_id: user.id },
      enabled: true,
      priority: 42,
    })
    expect(rule.workspace_id).toBe(ws)
    expect(rule.action_type).toBe('notify')

    const listed = await domain.workflows.listRules({ workspaceId: ws, first: 20 })
    expect(listed.items.some((r) => r.id === rule.id)).toBe(true)

    const registered = await domain.workflows.registerWebhook({
      workspaceId: ws,
      eventKey: 'task.completed',
      url: `https://hooks-${crypto.randomUUID()}.example.test/workflows`,
      filter: { field: 'event', op: 'eq', value: 'task.completed' },
    })
    expect(registered.subscriptionId).toBeTruthy()
    expect(registered.secret).toMatch(/^[a-f0-9]{64}$/)

    const publicRow = await adminDb
      .from('webhook_subscription')
      .select('*')
      .eq('id', registered.subscriptionId)
      .single()
    expect(JSON.stringify(publicRow.data)).not.toContain(registered.secret)

    const rotated = await domain.workflows.rotateWebhook({ workspaceId: ws, subscriptionId: registered.subscriptionId })
    expect(rotated.subscriptionId).toBe(registered.subscriptionId)
    expect(rotated.secret).toMatch(/^[a-f0-9]{64}$/)
    expect(rotated.secret).not.toBe(registered.secret)

    const deactivated = await domain.workflows.setWebhookActive({
      workspaceId: ws,
      subscriptionId: registered.subscriptionId,
      active: false,
    })
    expect(deactivated.active).toBe(false)

    const filtered = await domain.workflows.setWebhookFilter({
      workspaceId: ws,
      subscriptionId: registered.subscriptionId,
      filter: { field: 'event', op: 'eq', value: 'content.published' },
    })
    expect(filtered.filter).toEqual({ field: 'event', op: 'eq', value: 'content.published' })

    await expect(domain.workflows.getEvent({ workspaceId: otherWs, eventId: crypto.randomUUID() }))
      .resolves.toBeNull()
  })
})
