#!/usr/bin/env node
// MCP stdio smoke via @movp/mcp-bridge. The community mcp-remote@0.1.38 path
// was rejected because it intermittently dropped PAT auth and attempted OAuth.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, env, seedPat } from './lib/mcp-frames.mjs'

const API_URL = env('API_URL', 'http://127.0.0.1:64321')
const ANON_KEY = env('ANON_KEY')
const SERVICE_ROLE_KEY = env('SERVICE_ROLE_KEY')
const MCP_URL = `${API_URL}/functions/v1/mcp`
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function waitFor(map, id, child, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (map.has(id)) { clearInterval(iv); resolve(map.get(id)) }
      else if (child.exitCode !== null) { clearInterval(iv); reject(new Error(`mcp-remote exited ${child.exitCode} before JSON-RPC id=${id}`)) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timed out waiting for JSON-RPC id=${id} from mcp-remote`)) }
    }, 200)
  })
}

async function main() {
  const { token, workspaceId } = await seedPat({ apiUrl: API_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY })

  const child = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'packages', 'mcp-bridge', 'src', 'index.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      HOME: process.env.HOME ?? '',
      MOVP_MCP_APIKEY: ANON_KEY,
      MOVP_MCP_URL: MCP_URL,
      MOVP_PAT: token,
      PATH: process.env.PATH ?? '',
    },
  })
  child.on('error', (e) => { console.error('mcp-stdio-smoke: FAIL spawning @movp/mcp-bridge:', e.message); process.exit(1) })

  const seen = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try { const msg = JSON.parse(line); if (msg.id != null) seen.set(msg.id, msg) } catch {}
    }
  })

  try {
    const send = (f) => child.stdin.write(JSON.stringify(f) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'movp-stdio-smoke', version: '0.1.0' } } })
    await waitFor(seen, 1, child)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = await waitFor(seen, 2, child)
    assert(list?.result?.tools?.some((t) => t.name === 'task.list'), 'stdio tools/list missing task.list')
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.list', arguments: { workspaceId } } })
    const call = await waitFor(seen, 3, child)
    assert(!call?.error && Array.isArray(call?.result?.content), `stdio tools/call failed: ${JSON.stringify(call?.error ?? call?.result)}`)
  } finally {
    child.stdin.end()
    child.kill()
  }
  console.log('mcp-stdio-smoke: ok (@movp/mcp-bridge)')
}

main().catch((e) => { console.error('mcp-stdio-smoke: FAIL', e.message); process.exit(1) })
