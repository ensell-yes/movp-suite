import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const adminHeaders = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

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
  const email = `content-cms-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const created = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
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
      headers: { ...adminHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ name }),
    }),
    'create workspace',
  )).json()
  return rows[0].id as string
}

async function addMember(ws: string, userId: string, role = 'owner'): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ workspace_id: ws, user_id: userId, role }),
    }),
    'add member',
  )
}

describe('content CMS integration', () => {
  it('schedules, curates published content, audits SEO, and writes graph edges', async () => {
    const workspaceId = await makeWorkspace('Content CMS WS')
    const owner = await makeUser()
    await addMember(workspaceId, owner.id)
    const db = userClient(owner.token)
    const domain = createDomain({ db, userId: owner.id, accessToken: owner.token, assetsFnUrl: 'http://localhost/assets' })
    const adminDb = serviceClient()

    const type = await domain.content.createType({
      workspaceId,
      key: 'article',
      label: 'Article',
      fieldSchema: [
        { name: 'title', type: 'text', required: true },
        { name: 'answer', type: 'text' },
        { name: 'faqs', type: 'json' },
      ],
    })
    const published = await domain.content.create({
      workspaceId,
      contentTypeId: type.id,
      slug: 'published',
      data: {
        title: 'A Perfectly Reasonable Title',
        answer: 'Yes, here is the direct answer.',
        faqs: [{ q: 'Q?', a: 'A.' }],
      },
    })
    const draft = await domain.content.create({
      workspaceId,
      contentTypeId: type.id,
      slug: 'draft',
      data: { title: 'Draft Content' },
    })
    const publishedItem = await domain.content.publish({ itemId: published.id })
    expect(publishedItem.status).toBe('published')

    const scheduled = await domain.content.schedule({
      itemId: published.id,
      action: 'publish',
      revisionId: published.current_revision_id!,
      runAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(scheduled.revision_id).toBe(published.current_revision_id)

    const hits = await domain.search({ workspaceId, query: 'Perfectly Reasonable', collection: 'content_item', mode: 'fts' })
    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'content_item', id: published.id }),
    ]))

    const collection = await domain.content.createCollection({ workspaceId, key: 'featured', label: 'Featured' })
    await expect(domain.content.addToCollection({ collectionId: collection.id, itemId: published.id })).resolves.toBeUndefined()
    await expect(domain.content.addToCollection({ collectionId: collection.id, itemId: draft.id })).rejects.toThrow()
    await expect(domain.content.reorderCollection({ collectionId: collection.id, orderedItemIds: [published.id] })).resolves.toBeUndefined()

    const assetId = crypto.randomUUID()
    const asset = await adminDb.from('asset').insert({
      id: assetId,
      workspace_id: workspaceId,
      filename: 'chart.png',
      mime: 'image/png',
      r2_key: `${workspaceId}/${assetId}`,
      size_bytes: 10,
      alt_text: 'a chart',
      uploaded_by: owner.id,
    }).select('id').single()
    expect(asset.error).toBeNull()

    await domain.content.linkAsset({ itemId: published.id, assetId })
    const taskId = crypto.randomUUID()
    await domain.content.linkEditorialTask({ itemId: published.id, taskId })

    const seo = await domain.content.runSeoAudit({ itemId: published.id })
    expect(typeof seo.score).toBe('number')
    expect(Array.isArray(seo.checklist)).toBe(true)

    const edges = await adminDb.from('edges').select('rel, dst_type').eq('src_id', published.id)
    expect(edges.error).toBeNull()
    expect(edges.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ rel: 'references', dst_type: 'asset' }),
      expect.objectContaining({ rel: 'editorial_task', dst_type: 'task' }),
    ]))
  })
})
