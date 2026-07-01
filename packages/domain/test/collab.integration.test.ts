import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain, resolveShareLink } from '../src/index.ts'

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
  const email = `collab-${crypto.randomUUID()}@example.test`
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

describe('collab integration', () => {
  it('comment+mention -> inbox, react/save, share resolve, atomic rollback, cross-ws isolation', async () => {
    const ws1 = await makeWorkspace('Collab WS')
    const ws2 = await makeWorkspace('Other WS')
    const author = await makeUser()
    const mentioned = await makeUser()
    await addMember(ws1, author.id)
    await addMember(ws1, mentioned.id)

    const authorDomain = createDomain({ db: userClient(author.token), userId: author.id })
    const mentionedDomain = createDomain({ db: userClient(mentioned.token), userId: mentioned.id })
    const adminDb = serviceClient()

    const note = await authorDomain.note.create({ workspace_id: ws1, title: 'Collab note', body: 'hello' })

    const comment = await authorDomain.collab.comment.create({
      entityType: 'note',
      entityId: note.id,
      body: 'great work',
      mentions: [mentioned.id],
    })
    expect(comment.entity_id).toBe(note.id)
    expect(comment.author_id).toBe(author.id)

    const mentionRows = await adminDb
      .from('mention')
      .select('id')
      .eq('comment_id', comment.id)
      .eq('mentioned_user_id', mentioned.id)
    expect((mentionRows.data ?? []).length).toBe(1)

    const page = await authorDomain.collab.comment.listByEntity({
      workspaceId: ws1,
      entityType: 'note',
      entityId: note.id,
    })
    expect(page.items.map((c) => c.id)).toContain(comment.id)

    const inbox = await mentionedDomain.collab.inbox({ workspaceId: ws1, tab: 'mentions' })
    expect(inbox.some((i) => i.entity_id === note.id && i.kind === 'user.mentioned')).toBe(true)

    await authorDomain.collab.react({ entityType: 'note', entityId: note.id, kind: 'like' })
    await authorDomain.collab.react({ entityType: 'note', entityId: note.id, kind: 'like' })
    await authorDomain.collab.save({ entityType: 'note', entityId: note.id })
    await authorDomain.collab.save({ entityType: 'note', entityId: note.id })
    const reactions = await adminDb
      .from('reaction')
      .select('id')
      .eq('workspace_id', ws1)
      .eq('user_id', author.id)
      .eq('entity_type', 'note')
      .eq('entity_id', note.id)
      .eq('kind', 'like')
    expect((reactions.data ?? []).length).toBe(1)
    const saves = await adminDb
      .from('saved_item')
      .select('id')
      .eq('workspace_id', ws1)
      .eq('user_id', author.id)
      .eq('entity_type', 'note')
      .eq('entity_id', note.id)
    expect((saves.data ?? []).length).toBe(1)
    const saved = await authorDomain.collab.inbox({ workspaceId: ws1, tab: 'saved' })
    expect(saved.some((i) => i.entity_id === note.id)).toBe(true)
    await authorDomain.collab.unreact({ entityType: 'note', entityId: note.id, kind: 'like' })

    const { token } = await authorDomain.collab.createShareLink({ entityType: 'note', entityId: note.id })
    expect(typeof token).toBe('string')
    const resolved = await resolveShareLink({ db: userClient(author.token), userId: author.id }, token)
    expect(resolved).toMatchObject({ entity_type: 'note', entity_id: note.id, workspace_id: ws1 })

    const before = await adminDb.from('comment').select('id').eq('entity_id', note.id)
    const beforeCount = (before.data ?? []).length
    await expect(
      authorDomain.collab.comment.create({
        entityType: 'note',
        entityId: note.id,
        body: 'bad mention',
        mentions: [crypto.randomUUID()],
      }),
    ).rejects.toThrow()
    const after = await adminDb.from('comment').select('id').eq('entity_id', note.id)
    expect((after.data ?? []).length).toBe(beforeCount)

    const foreign = await adminDb.from('note').insert({ workspace_id: ws2, title: 'Foreign', body: 'x' }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    await expect(
      authorDomain.collab.comment.create({ entityType: 'note', entityId: foreignId, body: 'sneaky' }),
    ).rejects.toThrow(/entity not found or inaccessible/)
  })
})
