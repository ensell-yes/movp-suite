import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { schema } from '@movp/core-schema'
import { canonicalizeInnerJson, docToPlainText } from '@movp/richtext'
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
  const email = `content-${crypto.randomUUID()}@example.test`
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

describe('content integration', () => {
  it('createType, create/dedupe/edit revisions, validation, and cross-workspace isolation', async () => {
    const ws1 = await makeWorkspace('Content WS')
    const ws2 = await makeWorkspace('Other WS')
    const owner = await makeUser()
    await addMember(ws1, owner.id)
    const ownerDomain = createDomain({ db: userClient(owner.token), userId: owner.id }, { schema })
    const adminDb = serviceClient()

    const ct = await ownerDomain.content.createType({
      workspaceId: ws1,
      key: 'article',
      label: 'Article',
      fieldSchema: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richtext' },
        { name: 'rank', type: 'number' },
      ],
    })
    expect(ct.key).toBe('article')

    await expect(ownerDomain.content.createType({
      workspaceId: ws1,
      key: 'bad',
      label: 'Bad',
      fieldSchema: { title: 'text' },
    })).rejects.toThrow(/invalid field_schema/)

    const item = await ownerDomain.content.create({
      workspaceId: ws1,
      contentTypeId: ct.id,
      slug: 'hello',
      data: { title: 'Hello', body: '<p>Hi</p>', rank: 1 },
    })
    expect(item.slug).toBe('hello')
    expect(item.current_revision_id).toBeTruthy()
    const rev1 = await adminDb.from('content_revision').select('*').eq('content_item_id', item.id)
    const rev1Rows = (rev1.data ?? []) as Array<{ content_hash: string; revision_number: number }>
    expect(rev1Rows.length).toBe(1)
    expect(rev1Rows[0].content_hash).toBeTruthy()
    expect(rev1Rows[0].revision_number).toBe(1)

    const deduped = await ownerDomain.content.update({
      itemId: item.id,
      data: { rank: 1, title: 'Hello', body: '<p>Hi</p>' },
    })
    expect(deduped.id).toBe(item.id)
    const afterDedupe = await adminDb.from('content_revision').select('id').eq('content_item_id', item.id)
    expect((afterDedupe.data ?? []).length).toBe(1)

    await ownerDomain.content.update({ itemId: item.id, data: { title: 'Hello 2', body: '<p>Hi</p>', rank: 2 } })
    const revs = await adminDb.from('content_revision').select('*')
      .eq('content_item_id', item.id)
      .order('revision_number', { ascending: true })
    const rows = (revs.data ?? []) as Array<{ id: string; revision_number: number; parent_id: string | null }>
    expect(rows.length).toBe(2)
    expect(rows[1].revision_number).toBe(2)
    expect(rows[1].parent_id).toBe(rows[0].id)

    await expect(ownerDomain.content.update({
      itemId: item.id,
      data: { title: 'Stale write', body: '<p>Hi</p>', rank: 3 },
      expectedRevisionId: rows[0].id,
    })).rejects.toThrow(/\[40001\]|content_update_conflict/)

    const listed = await ownerDomain.content.listRevisions({ itemId: item.id })
    expect(listed.items.length).toBe(2)

    const getDetail = ownerDomain.content.getDetail
    const detail = await getDetail(item.id)
    expect(detail?.type?.key).toBe('article')
    expect(detail?.currentRevision?.id).toBe(rows[1].id)
    expect(detail?.currentRevision?.data).toEqual({
      title: 'Hello 2',
      body: '{"content":[{"content":[{"text":"<p>Hi</p>","type":"text"}],"type":"paragraph"}],"type":"doc"}',
      rank: 2,
    })

    await expect(ownerDomain.content.create({
      workspaceId: ws1,
      contentTypeId: ct.id,
      slug: 'bad-data',
      data: { body: '<p>x</p>', rank: 'not-a-number' },
    })).rejects.toThrow()

    const fType = await adminDb.from('content_type').insert({
      workspace_id: ws2,
      key: 'page',
      label: 'Page',
      field_schema: [{ name: 'title', type: 'text' }],
    }).select('id').single()
    const foreign = await adminDb.from('content_item').insert({
      workspace_id: ws2,
      content_type_id: (fType.data as { id: string }).id,
      slug: 'secret',
      status: 'draft',
    }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    expect(await ownerDomain.content.get(foreignId)).toBeNull()
    expect(await ownerDomain.content.getDetail(foreignId)).toBeNull()
  })

  it('stores richtext as canonical doc-JSON and derives human search_body', async () => {
    const ws = await makeWorkspace('RichText WS')
    const owner = await makeUser()
    await addMember(ws, owner.id)
    const domain = createDomain({ db: userClient(owner.token), userId: owner.id }, { schema })
    const adminDb = serviceClient()

    const ct = await domain.content.createType({
      workspaceId: ws, key: 'post', label: 'Post',
      fieldSchema: [{ name: 'body', type: 'richtext' }],
    })
    const created = await domain.content.create({
      workspaceId: ws, contentTypeId: ct.id, slug: 'rt', data: { body: 'hello world' },
    })

    const expectedBody = canonicalizeInnerJson({
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    })
    const detail = await domain.content.getDetail(created.id)
    const storedBody = (detail!.currentRevision!.data as Record<string, string>).body
    expect(storedBody).toBe(expectedBody)
    expect(docToPlainText(JSON.parse(storedBody))).toBe('hello world')

    const row = await adminDb.from('content_item').select('search_body').eq('id', created.id).single()
    const searchBody = (row.data as { search_body: string }).search_body
    expect(searchBody).toContain('hello world')
    expect(searchBody).not.toContain('"type"')
  })
})
