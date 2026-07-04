import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

// ── harness helpers (cloned VERBATIM from collab.integration.test.ts) ──────────
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
  const email = `campaign-${crypto.randomUUID()}@example.test`
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

// ── campaign-specific setup ────────────────────────────────────────────────────
let ws: string        // the acting user IS a member here
let otherWs: string   // the acting user is NOT a member here (RLS must hide its rows)
let db: ReturnType<typeof userClient>          // caller-RLS client for the acting user
let domain: ReturnType<typeof createDomain>    // createDomain({ db, userId }) — RLS-bound
let OTHER_USER_ID: string
const wsOwner: Record<string, string> = {}     // ws -> the user id that owns campaigns seeded in it

beforeAll(async () => {
  const user = await makeUser()                 // primary actor
  const other = await makeUser()                // 2nd user: observer target + owner of otherWs
  OTHER_USER_ID = other.id
  ws = await makeWorkspace('Campaign WS')        // insert fires 000008 seed -> default task options
  await addMember(ws, user.id)
  await addMember(ws, other.id)                  // OTHER_USER_ID is a MEMBER of ws — a valid observer target (addObserver member-gates)
  otherWs = await makeWorkspace('Other WS')      // user deliberately NOT added -> RLS hides it
  wsOwner[ws] = user.id
  wsOwner[otherWs] = other.id                    // otherWs campaigns owned by `other`, not the actor
  db = userClient(user.token)                    // user JWT -> caller RLS
  domain = createDomain({ db, userId: user.id }) // production-shaped user ctx (NO service role)
})

// ── seed helpers (service-role inserts; return the ids the assertions use) ──────
async function defaultTaskOptions(wsId: string): Promise<{ statusId: string; priorityId: string }> {
  const svc = serviceClient()
  const { data: st } = await svc.from('task_status_option').select('id')
    .eq('workspace_id', wsId).eq('is_default', true).limit(1).single()
  const { data: pr } = await svc.from('task_priority_option').select('id')
    .eq('workspace_id', wsId).eq('is_default', true).limit(1).single()
  return { statusId: (st as { id: string }).id, priorityId: (pr as { id: string }).id }
}

async function seedCampaign(wsId: string): Promise<string> {
  const { data, error } = await serviceClient().from('campaign')
    // name is a required (NOT NULL) column on public.campaign (Part A) — must be supplied.
    .insert({ workspace_id: wsId, owner_id: wsOwner[wsId], name: 'Seed Campaign', start_date: '2026-01-01', end_date: '2026-12-31', status: 'active' })
    .select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

// deliverable + backing task, but NO implemented_by edge — the edge is written by the tests that
// need it (via domain.campaign.linkTask), so the "no backing task" + isolation cases stay valid.
async function seedDeliverableAndTask(
  wsId: string,
  opts: { dueDate?: string } = {},
): Promise<{ campaignId: string; deliverableId: string; taskId: string }> {
  const svc = serviceClient()
  const campaignId = await seedCampaign(wsId)
  const { data: deliv, error: dErr } = await svc.from('campaign_deliverable')
    .insert({ workspace_id: wsId, campaign_id: campaignId, name: 'Launch Email', deliverable_type: 'email' })
    .select('id').single()
  if (dErr) throw dErr
  const { statusId, priorityId } = await defaultTaskOptions(wsId)
  const { data: task, error: tErr } = await svc.from('task')
    .insert({ workspace_id: wsId, title: 'Backing Task', status_id: statusId, priority_id: priorityId, due_date: opts.dueDate ?? null })
    .select('id').single()
  if (tErr) throw tErr
  return { campaignId, deliverableId: (deliv as { id: string }).id, taskId: (task as { id: string }).id }
}

// content_item is a CMS-phase table; edges.dst_id is an opaque typed-uuid (heterogeneous dst_types
// -> NO FK), so a produces-edge test needs only an id, not a real content_item row.
async function seedContentItem(_wsId: string): Promise<string> {
  return crypto.randomUUID()
}

describe('campaign domain service', () => {
  it('linkTask writes an implemented_by edge deliverable -> task', async () => {
    const { deliverableId, taskId } = await seedDeliverableAndTask(ws)
    await domain.campaign.linkTask({ deliverableId, taskId })
    const { data } = await db.from('edges').select('rel, dst_id')
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId)
      .eq('rel', 'implemented_by').eq('dst_type', 'task').maybeSingle()
    expect(data?.dst_id).toBe(taskId)
  })

  it('linkContent writes a produces edge deliverable -> content_item', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws)
    const contentItemId = await seedContentItem(ws)
    await domain.campaign.linkContent({ deliverableId, contentItemId })
    const { data } = await db.from('edges').select('dst_id')
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId)
      .eq('rel', 'produces').eq('dst_type', 'content_item').maybeSingle()
    expect(data?.dst_id).toBe(contentItemId)
  })

  it('addObserver writes a campaign -> user observer edge', async () => {
    const campaignId = await seedCampaign(ws)
    await domain.campaign.addObserver({ campaignId, userId: OTHER_USER_ID })
    const { data } = await db.from('edges').select('dst_id')
      .eq('src_type', 'campaign').eq('src_id', campaignId)
      .eq('rel', 'observer').eq('dst_type', 'user').maybeSingle()
    expect(data?.dst_id).toBe(OTHER_USER_ID)
  })

  it('linkTask rejects a missing/cross-workspace task and writes NO dangling edge', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws) // deliverable in ws; do NOT link
    await expect(domain.campaign.linkTask({ deliverableId, taskId: crypto.randomUUID() }))
      .rejects.toThrow(/domain\.campaign\.linkTask failed \[task_not_found\]/)
    const { count } = await db.from('edges').select('*', { count: 'exact', head: true })
      .eq('src_type', 'campaign_deliverable').eq('src_id', deliverableId).eq('rel', 'implemented_by')
    expect(count).toBe(0) // no dangling backing-task edge persisted
  })

  it('addObserver rejects a NON-member target and writes NO observer edge (no email to outsiders)', async () => {
    const campaignId = await seedCampaign(ws)
    const outsider = crypto.randomUUID() // not in workspace_membership for ws
    await expect(domain.campaign.addObserver({ campaignId, userId: outsider }))
      .rejects.toThrow(/domain\.campaign\.addObserver failed \[user_not_member\]/)
    const { count } = await db.from('edges').select('*', { count: 'exact', head: true })
      .eq('src_type', 'campaign').eq('src_id', campaignId).eq('rel', 'observer')
    expect(count).toBe(0) // the non-member never enters the notification fan-out
  })

  it('deliverableSchedule returns the backing task dates', async () => {
    const { deliverableId, taskId } = await seedDeliverableAndTask(ws, { dueDate: '2026-08-01' })
    await domain.campaign.linkTask({ deliverableId, taskId })
    const sched = await domain.campaign.deliverableSchedule(deliverableId)
    expect(sched).toEqual({ taskId, startDate: null, dueDate: '2026-08-01' })
  })

  it('deliverableSchedules resolves two deliverables in ONE batched call (no N+1)', async () => {
    const a = await seedDeliverableAndTask(ws, { dueDate: '2026-08-01' })
    const b = await seedDeliverableAndTask(ws, { dueDate: '2026-09-01' })
    await domain.campaign.linkTask({ deliverableId: a.deliverableId, taskId: a.taskId })
    await domain.campaign.linkTask({ deliverableId: b.deliverableId, taskId: b.taskId })
    const rows = await domain.campaign.deliverableSchedules([a.deliverableId, b.deliverableId])
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      { deliverableId: a.deliverableId, taskId: a.taskId, startDate: null, dueDate: '2026-08-01' },
      { deliverableId: b.deliverableId, taskId: b.taskId, startDate: null, dueDate: '2026-09-01' },
    ]))
  })

  it('deliverableSchedule returns null when the deliverable has no backing task', async () => {
    const { deliverableId } = await seedDeliverableAndTask(ws) // no linkTask
    expect(await domain.campaign.deliverableSchedule(deliverableId)).toBeNull()
  })

  it('is workspace-isolated: a deliverable in another workspace is invisible under RLS', async () => {
    const other = await seedDeliverableAndTask(otherWs) // seeded in a workspace the signed-in user is NOT a member of
    await expect(domain.campaign.deliverableSchedule(other.deliverableId)).resolves.toBeNull()
    await expect(domain.campaign.linkTask({ deliverableId: other.deliverableId, taskId: other.taskId }))
      .rejects.toThrow(/domain\.campaign\.linkTask failed \[deliverable_not_found\]/)
  })
})
