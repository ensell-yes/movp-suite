export interface E2eEnv {
  url: string
  anon: string
  serviceRole: string
}

export async function provision(env: E2eEnv): Promise<{ accessToken: string; workspaceId: string; userId: string }> {
  const email = `e2e+${crypto.randomUUID()}@example.test`
  const password = 'e2e-Password-123!'
  const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

  const cu = await fetch(`${env.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (!cu.ok) throw new Error(`admin create user failed: ${cu.status} ${await cu.text()}`)
  const userId = (await cu.json()).id as string

  const ws = await fetch(`${env.url}/rest/v1/workspace`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'return=representation' },
    body: JSON.stringify({ name: 'E2E WS' }),
  })
  if (!ws.ok) throw new Error(`create workspace failed: ${ws.status} ${await ws.text()}`)
  const workspaceId = (await ws.json())[0].id as string

  const mem = await fetch(`${env.url}/rest/v1/workspace_membership`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ workspace_id: workspaceId, user_id: userId, role: 'owner' }),
  })
  if (!mem.ok) throw new Error(`create membership failed: ${mem.status} ${await mem.text()}`)

  const si = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!si.ok) throw new Error(`sign-in failed: ${si.status} ${await si.text()}`)
  return { accessToken: (await si.json()).access_token as string, workspaceId, userId }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
