import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { schema } from '@movp/core-schema'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'
import type { ContentService } from '../src/types.ts'

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

async function makeUser(prefix: string): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${crypto.randomUUID()}@example.test`
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

async function addMember(ws: string, userId: string, role: 'owner' | 'member'): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ workspace_id: ws, user_id: userId, role }),
    }),
    'add member',
  )
}

describe('CMS approval + publish workflow integration', () => {
  let ws: string
  let ct: string
  let ownerA: { id: string; token: string }
  let ownerB: { id: string; token: string }
  let member: { id: string; token: string }

  const svc = (user: { id: string; token: string }): ContentService =>
    createDomain({ db: userClient(user.token), userId: user.id }, { schema }).content

  const latestApprovalId = async (itemId: string): Promise<string> => {
    const { data, error } = await serviceClient()
      .from('content_approval')
      .select('id')
      .eq('content_item_id', itemId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error) throw error
    return (data as { id: string }).id
  }

  beforeAll(async () => {
    ws = await makeWorkspace('CMS workflow WS')
    ownerA = await makeUser('cms-owner-a')
    ownerB = await makeUser('cms-owner-b')
    member = await makeUser('cms-member')
    await addMember(ws, ownerA.id, 'owner')
    await addMember(ws, ownerB.id, 'owner')
    await addMember(ws, member.id, 'member')
    const ctRow = await svc(ownerA).createType({
      workspaceId: ws,
      key: `article_${crypto.randomUUID().replaceAll('-', '_')}`,
      label: 'Article',
      fieldSchema: [{ name: 't', type: 'text', required: true }],
    })
    ct = ctRow.id
  })

  it('single-policy: one approve decides and freezes the revision + hash', async () => {
    const item = await svc(ownerA).create({ workspaceId: ws, contentTypeId: ct, slug: `single-${crypto.randomUUID()}`, data: { t: 'v1' } })
    const submitted = await svc(ownerA).submitForApproval({ itemId: item.id })
    expect(submitted.status).toBe('in_review')
    const decided = await svc(ownerA).decideApproval({ approvalId: await latestApprovalId(item.id), vote: 'approve' })
    expect(decided.state).toBe('approved')
    expect(decided.approved_revision_id).toBe(item.current_revision_id)
    expect(decided.approved_content_hash).toBeTruthy()
  })

  it('multi-policy: flips only when distinct approvers reach the threshold', async () => {
    const item = await svc(ownerA).create({ workspaceId: ws, contentTypeId: ct, slug: `multi-${crypto.randomUUID()}`, data: { t: 'm' } })
    await svc(ownerA).submitForApproval({ itemId: item.id, policy: 'multi', approvalsRequired: 2 })
    const approvalId = await latestApprovalId(item.id)
    const first = await svc(ownerA).decideApproval({ approvalId, vote: 'approve' })
    expect(first.state).toBe('pending')
    const second = await svc(ownerB).decideApproval({ approvalId, vote: 'approve' })
    expect(second.state).toBe('approved')
  })

  it('rejects a duplicate vote from the same voter', async () => {
    const item = await svc(ownerA).create({ workspaceId: ws, contentTypeId: ct, slug: `dupe-${crypto.randomUUID()}`, data: { t: 'd' } })
    await svc(ownerA).submitForApproval({ itemId: item.id, policy: 'multi', approvalsRequired: 2 })
    const approvalId = await latestApprovalId(item.id)
    await svc(ownerA).decideApproval({ approvalId, vote: 'approve' })
    await expect(svc(ownerA).decideApproval({ approvalId, vote: 'approve' })).rejects.toThrow()
  })

  it('publish freezes the snapshot; getPublished returns it while a newer draft exists', async () => {
    const item = await svc(ownerA).create({ workspaceId: ws, contentTypeId: ct, slug: `publish-${crypto.randomUUID()}`, data: { t: 'p1' } })
    await svc(ownerA).submitForApproval({ itemId: item.id })
    const decided = await svc(ownerA).decideApproval({ approvalId: await latestApprovalId(item.id), vote: 'approve' })
    const approvedRev = decided.approved_revision_id
    expect(approvedRev).toBe(item.current_revision_id)

    await svc(ownerA).update({ itemId: item.id, data: { t: 'p2' } })
    const published = await svc(ownerA).publish({ itemId: item.id })
    expect(published.status).toBe('published')
    expect(published.published_revision_id).toBe(approvedRev)
    const got = await svc(ownerA).getPublished(item.id)
    expect(got).not.toBeNull()
    expect(got?.revision.id).toBe(approvedRev)
    expect(got?.revision.data).toEqual({ t: 'p1' })
  })

  it('denies decide/publish to a member without the capability', async () => {
    const item = await svc(ownerA).create({ workspaceId: ws, contentTypeId: ct, slug: `deny-${crypto.randomUUID()}`, data: { t: 'x' } })
    await svc(ownerA).submitForApproval({ itemId: item.id })
    const approvalId = await latestApprovalId(item.id)
    await expect(svc(member).decideApproval({ approvalId, vote: 'approve' })).rejects.toThrow()
    await expect(svc(member).publish({ itemId: item.id })).rejects.toThrow()
  })
})
