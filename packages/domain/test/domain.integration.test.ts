import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain, type EmbeddingProvider } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}

class FakeEmbedder implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(384).fill(0)
    for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i)
    const norm = Math.sqrt(v.reduce((sum, n) => sum + n * n, 0)) || 1
    return v.map((n) => n / norm)
  }
}

function serviceClient(): SupabaseClient {
  return createClient(env.url, env.serviceRole, { auth: { persistSession: false } })
}

function userClient(accessToken: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

async function assertOk(res: Response, label: string): Promise<void> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
}

async function provision(): Promise<{ accessToken: string; userId: string; workspaceId: string; otherWorkspaceId: string }> {
  const admin = {
    apikey: env.serviceRole,
    Authorization: `Bearer ${env.serviceRole}`,
    'content-type': 'application/json',
  }
  const email = `domain-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'

  const userRes = await fetch(`${env.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  await assertOk(userRes, 'create user')
  const userId = (await userRes.json()).id as string

  const workspaceRes = await fetch(`${env.url}/rest/v1/workspace`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'return=representation' },
    body: JSON.stringify([{ name: 'Domain Test' }, { name: 'Other Workspace' }]),
  })
  await assertOk(workspaceRes, 'create workspace')
  const workspaces = (await workspaceRes.json()) as Array<{ id: string }>
  const workspaceId = workspaces[0]!.id
  const otherWorkspaceId = workspaces[1]!.id

  const membershipRes = await fetch(`${env.url}/rest/v1/workspace_membership`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ workspace_id: workspaceId, user_id: userId, role: 'owner' }),
  })
  await assertOk(membershipRes, 'create membership')

  const tokenRes = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  await assertOk(tokenRes, 'sign in')
  const accessToken = (await tokenRes.json()).access_token as string

  return { accessToken, userId, workspaceId, otherWorkspaceId }
}

describe('domain integration', () => {
  it('enforces RLS while exercising CRUD, pagination, search, and graph traversal', async () => {
    const { accessToken, userId, workspaceId, otherWorkspaceId } = await provision()
    const db = userClient(accessToken)
    const adminDb = serviceClient()
    const embedder = new FakeEmbedder()
    const domain = createDomain({ db, userId }, { embedder })

    const note = await domain.note.create({
      workspace_id: workspaceId,
      title: 'E2E note',
      body: 'semantic lighthouse phrase for domain verification',
    })
    expect(note.workspace_id).toBe(workspaceId)
    expect((await domain.note.get(note.id))?.title).toBe('E2E note')

    const externalRecord = await domain.external_record.create({
      workspace_id: workspaceId,
      source: 'hubspot',
      external_id: 'domain-contact-1',
      payload: { stage: 'lead' },
    })
    expect((await domain.external_record.get(externalRecord.id))?.payload).toEqual({ stage: 'lead' })

    const updated = await domain.note.update(note.id, { status: 'published' })
    expect(updated.status).toBe('published')

    const second = await domain.note.create({ workspace_id: workspaceId, title: 'Second note', body: 'ordinary text' })
    const firstPage = await domain.note.list({ workspaceId: workspaceId, first: 1 })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    const secondPage = await domain.note.list({ workspaceId: workspaceId, first: 2, after: firstPage.nextCursor })
    const listedIds = [...firstPage.items, ...secondPage.items].map((row) => row.id)
    expect(listedIds).toEqual(expect.arrayContaining([note.id, second.id]))

    await expect(domain.note.create({ workspace_id: otherWorkspaceId, title: 'Denied by RLS' })).rejects.toThrow(
      /domain\.note\.create failed/,
    )
    await expect(domain.note.list({ workspaceId: otherWorkspaceId, first: 5 })).resolves.toMatchObject({ items: [] })

    const fts = await domain.search({ workspaceId, query: 'lighthouse', mode: 'fts', collection: 'note' })
    expect(fts.some((hit) => hit.id === note.id)).toBe(true)

    const vector = await embedder.embed('semantic lighthouse')
    const { error: chunkError } = await adminDb.rpc('replace_search_chunks', {
      src_table: 'note',
      src_id: note.id,
      src_field: 'body',
      ws: workspaceId,
      hash: 'domain-test-hash',
      chunks: [
        {
          chunk_index: 0,
          content: 'semantic lighthouse phrase for domain verification',
          embedding: JSON.stringify(vector),
        },
      ],
    })
    expect(chunkError).toBeNull()
    const semantic = await domain.search({ workspaceId, query: 'semantic lighthouse', mode: 'semantic', collection: 'note' })
    expect(semantic[0]).toMatchObject({ id: note.id, title: 'E2E note' })

    const tag = await domain.tag.create({ workspace_id: workspaceId, name: 'Important' })
    await domain.graph.link({
      workspaceId,
      srcType: 'note',
      srcId: note.id,
      rel: 'tags',
      dstType: 'tag',
      dstId: tag.id,
    })
    const traversal = await domain.graph.traverse({ workspaceId, srcType: 'note', srcId: note.id, rel: 'tags', depth: 2 })
    expect(traversal).toContainEqual(expect.objectContaining({ type: 'tag', id: tag.id, depth: 1 }))

    await domain.note.delete(note.id)
    expect(await domain.note.get(note.id)).toBeNull()
  })
})
