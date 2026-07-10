#!/usr/bin/env node
// MCP streamable-HTTP smoke: seed a PAT -> initialize -> tools/list -> tools/call
// (one safe read tool). Prints the exact JSON-RPC frames. Also proves a bad PAT
// is rejected 401 invalid_token.
// GOTCHA: endpoint is /functions/v1/mcp (streamable HTTP, SDK 1.26.0, STATELESS:
// each POST is independent, no Mcp-Session-Id). Responses may be raw JSON or SSE
// (event: message / data: {…}) -> parseRpc() normalises both.
import { assert, env, parseRpc, seedPat } from './lib/mcp-frames.mjs'

const API_URL = env('API_URL', 'http://127.0.0.1:64321')
const ANON_KEY = env('ANON_KEY')
const SERVICE_ROLE_KEY = env('SERVICE_ROLE_KEY')
const MCP_URL = `${API_URL}/functions/v1/mcp`

async function mcp(frame, bearer) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      apikey: ANON_KEY, // local Kong requires it; hosted (verify_jwt=false) ignores it
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(frame),
  })
  return { status: res.status, body: await res.text() }
}

async function main() {
  const { token, workspaceId } = await seedPat({ apiUrl: API_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY })

  // negative: a syntactically-valid but unregistered PAT -> 401 invalid_token
  const bogus = await mcp({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, `movp_pat_${'0'.repeat(64)}`)
  assert(bogus.status === 401, `bogus PAT should be 401, got ${bogus.status}`)
  assert(/"invalid_token"/.test(bogus.body), `bogus PAT should map to invalid_token, got ${bogus.body.slice(0, 120)}`)
  console.log('  [negative] bogus PAT -> 401 invalid_token: ok')

  // 1. initialize
  const initReq = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'movp-http-smoke', version: '0.1.0' } } }
  console.log('>>', JSON.stringify(initReq))
  const initRes = await mcp(initReq, token)
  assert(initRes.status === 200, `initialize status ${initRes.status}: ${initRes.body.slice(0, 160)}`)
  const init = parseRpc(initRes.body)
  console.log('<<', JSON.stringify(init))
  assert(init.result?.serverInfo?.name === 'movp', 'initialize did not return serverInfo.name=movp')

  // 2. tools/list
  const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  console.log('>>', JSON.stringify(listReq))
  const list = parseRpc((await mcp(listReq, token)).body)
  console.log('<< tools/list ->', (list.result?.tools ?? []).length, 'tools')
  assert((list.result?.tools ?? []).some((t) => t.name === 'task.list'), 'tools/list missing the task.list read tool')

  // 3. tools/call task.list (safe read; an empty task list is a valid pass)
  const callReq = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.list', arguments: { workspaceId } } }
  console.log('>>', JSON.stringify(callReq))
  const call = parseRpc((await mcp(callReq, token)).body)
  console.log('<<', JSON.stringify(call))
  assert(!call.error, `tools/call returned an error: ${JSON.stringify(call.error)}`)
  assert(Array.isArray(call.result?.content), 'tools/call task.list returned no content array')

  console.log('mcp-http-smoke: ok')
}

main().catch((e) => { console.error('mcp-http-smoke: FAIL', e.message); process.exit(1) })
