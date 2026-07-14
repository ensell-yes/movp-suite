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
  const email = `task-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const cu = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    }),
    'create user',
  )).json()
  const si = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    'sign in',
  )).json()
  return { id: cu.id as string, token: si.access_token as string }
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

async function seedTaskConfig(ws: string): Promise<{ openStatus: string; doneStatus: string; priority: string }> {
  const db = serviceClient()
  const openS = await db.from('task_status_option').select('id')
    .eq('workspace_id', ws).eq('is_default', true).eq('is_active', true).single()
  const doneS = await db.from('task_status_option').select('id')
    .eq('workspace_id', ws).eq('category', 'done').eq('is_active', true).limit(1).single()
  const priP = await db.from('task_priority_option').select('id')
    .eq('workspace_id', ws).eq('is_default', true).eq('is_active', true).single()
  return {
    openStatus: (openS.data as { id: string }).id,
    doneStatus: (doneS.data as { id: string }).id,
    priority: (priP.data as { id: string }).id,
  }
}

describe('task integration', () => {
  it('create defaults, assign->assigned inbox, dependency blocks, transition completes, dedupe, comment, cross-ws', async () => {
    const ws1 = await makeWorkspace('Task WS')
    const ws2 = await makeWorkspace('Other WS')
    const owner = await makeUser()
    const assignee = await makeUser()
    await addMember(ws1, owner.id)
    await addMember(ws1, assignee.id)
    const cfg = await seedTaskConfig(ws1)

    const ownerDomain = createDomain({ db: userClient(owner.token), userId: owner.id }, { schema })
    const assigneeDomain = createDomain({ db: userClient(assignee.token), userId: assignee.id }, { schema })
    const adminDb = serviceClient()

    const task = await ownerDomain.task.create({ workspaceId: ws1, title: 'Ship it', description: 'first body' })
    expect(task.status_id).toBe(cfg.openStatus)
    expect(task.priority_id).toBe(cfg.priority)
    expect(task.current_revision_id).toBeTruthy()

    const rev1 = await adminDb.from('task_revision').select('id').eq('task_id', task.id)
    expect((rev1.data ?? []).length).toBe(1)

    await ownerDomain.task.assign({ taskId: task.id, userId: assignee.id })
    const assignedInbox = await assigneeDomain.collab.inbox({ workspaceId: ws1, tab: 'assigned' })
    expect(assignedInbox.some((i) => i.entity_id === task.id)).toBe(true)
    await ownerDomain.task.assign({ taskId: task.id, userId: assignee.id })
    const asg = await adminDb.from('task_assignment').select('task_id').eq('task_id', task.id).eq('assignee_user_id', assignee.id)
    expect((asg.data ?? []).length).toBe(1)

    const blocker = await ownerDomain.task.create({ workspaceId: ws1, title: 'Blocker' })
    await ownerDomain.task.addDependency({ taskId: task.id, blockerId: blocker.id })
    const blocked = await ownerDomain.task.get(task.id)
    expect(blocked?.dependency_blocked).toBe(true)

    const transition = ownerDomain.task.transition
    const done = await transition({ taskId: task.id, statusId: cfg.doneStatus })
    expect(done.status_id).toBe(cfg.doneStatus)
    expect(done.completed_at).toBeTruthy()

    await ownerDomain.task.updateDescription(task.id, 'second body')
    await ownerDomain.task.updateDescription(task.id, 'second body')
    const revs = await adminDb.from('task_revision').select('id').eq('task_id', task.id)
    expect((revs.data ?? []).length).toBe(2)

    const getDetail = ownerDomain.task.getDetail
    const detail = await getDetail(task.id)
    expect(detail?.description).toBe('second body')
    expect(detail?.assignments.map((row) => row.assignee_user_id)).toEqual([assignee.id])
    expect(detail?.dependencies.map((row) => row.blocker_id)).toEqual([blocker.id])
    expect(detail?.observers).toEqual([])
    expect(detail?.attachments).toEqual([])

    const comment = await ownerDomain.collab.comment.create({ entityType: 'task', entityId: task.id, body: 'nice' })
    expect(comment.entity_id).toBe(task.id)

    const fStatus = await adminDb.from('task_status_option').select('id')
      .eq('workspace_id', ws2).eq('is_default', true).single()
    const fPriority = await adminDb.from('task_priority_option').select('id')
      .eq('workspace_id', ws2).eq('is_default', true).single()
    const foreign = await adminDb.from('task').insert({
      workspace_id: ws2,
      title: 'Foreign',
      status_id: (fStatus.data as { id: string }).id,
      priority_id: (fPriority.data as { id: string }).id,
    }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    expect(await ownerDomain.task.get(foreignId)).toBeNull()
    expect(await ownerDomain.task.getDetail(foreignId)).toBeNull()
    await expect(ownerDomain.task.transition({ taskId: foreignId, statusId: cfg.doneStatus }))
      .rejects.toThrow(/not found or inaccessible/)
  })
})
