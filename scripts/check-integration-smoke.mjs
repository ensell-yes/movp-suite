#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { startMockCrm } from '../examples/sync-worker/mock-crm.mjs'
import { syncRecord } from '../examples/sync-worker/worker.mjs'
import { exchangePat } from './integration-smoke-http.mjs'

const apiUrl = process.env.SUPABASE_URL ?? process.env.API_URL ?? 'http://127.0.0.1:64321'
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY
const dbUrl = process.env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:64322/postgres'

if (!anonKey || !serviceRoleKey) {
  console.error('missing ANON_KEY/SERVICE_ROLE_KEY')
  process.exit(1)
}

const workspaceId = 'c5f00000-0000-0000-0000-000000000001'
const email = `integration-smoke-${randomUUID()}@example.test`
const password = 'Passw0rd!1'

async function responseJson(response, label) {
  const body = await response.json()
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`)
  return body
}

let mock
try {
  const created = await responseJson(await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }), 'create smoke user')
  const tokenResult = await responseJson(await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }), 'mint smoke session')
  const bootstrapToken = tokenResult.access_token
  if (typeof bootstrapToken !== 'string') throw new Error('mint smoke session: missing access_token')
  const userId = created.id
  if (typeof userId !== 'string') throw new Error('create smoke user: missing id')

  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c',
    `insert into public.workspace (id, name) values ('${workspaceId}', 'Integration smoke') on conflict do nothing;`,
    '-c', `insert into public.workspace_membership (workspace_id, user_id, role) values ('${workspaceId}', '${userId}', 'member') on conflict do nothing;`],
  { stdio: 'ignore' })

  const createdPat = await responseJson(await fetch(`${apiUrl}/rest/v1/rpc/create_personal_access_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bootstrapToken}`, apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ default_ws: workspaceId, name: 'integration-smoke' }),
  }), 'create smoke PAT')
  if (!createdPat || typeof createdPat.token !== 'string') throw new Error('create smoke PAT: missing token')
  const exchanged = await responseJson(await exchangePat({
    apiUrl,
    anonKey,
    pat: createdPat.token,
  }), 'exchange smoke PAT')
  const sessionToken = exchanged.access_token
  if (typeof sessionToken !== 'string') throw new Error('exchange smoke PAT: missing access_token')

  mock = await startMockCrm()
  const options = { crmUrl: mock.url, apiUrl, anonKey, sessionToken, workspaceId, source: 'mockcrm' }
  const first = await syncRecord(options)
  const second = await syncRecord(options)
  if (first.external_id !== 'crm-1' || first.id !== second.id) {
    throw new Error('upsert response was not idempotent')
  }
  if (!first.payload || typeof first.payload !== 'object' || Array.isArray(first.payload) || first.payload.stage !== 'lead') {
    throw new Error('upsert response did not preserve the CRM payload as an object')
  }
  console.log('integration-smoke: PASS')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'integration smoke failed')
  process.exitCode = 1
} finally {
  await mock?.close()
}
