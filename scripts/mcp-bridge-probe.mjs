#!/usr/bin/env node
// C3d [agents] slice: drive @movp/mcp-bridge headlessly and assert that a
// generated tool is visible over stdio. Credentials stay out of argv and logs.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const endpoint = process.env.MCP_ENDPOINT
const pat = process.env.MCP_PAT
const apikey = process.env.MCP_APIKEY
if (!endpoint || !pat) {
  console.error('MCP_ENDPOINT and MCP_PAT are required')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const timeoutMs = Number(process.env.MCP_PROBE_TIMEOUT ?? 30000)
const child = spawn(
  join(root, 'node_modules', '.bin', 'tsx'),
  [join(root, 'packages', 'mcp-bridge', 'src', 'index.ts')],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      HOME: process.env.HOME ?? '',
      MOVP_MCP_APIKEY: apikey ?? '',
      MOVP_MCP_URL: endpoint,
      MOVP_PAT: pat,
      PATH: process.env.PATH ?? '',
    },
  },
)

let buffer = ''
let finishing = false
const send = (frame) => child.stdin.write(JSON.stringify(frame) + '\n')
const finish = (code) => {
  if (finishing) return
  finishing = true
  clearTimeout(timer)
  child.stdin.end()
  child.kill()
  process.exit(code)
}
const timer = setTimeout(() => {
  console.error(`@movp/mcp-bridge probe timed out after ${timeoutMs}ms`)
  finish(1)
}, timeoutMs)

child.on('error', (error) => {
  console.error(`failed to start @movp/mcp-bridge: ${error.message}`)
  finish(1)
})
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (!line.startsWith('{')) continue

    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id === 1 && message.result) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    } else if (message.id === 2) {
      const tools = message.result && Array.isArray(message.result.tools) ? message.result.tools : []
      if (tools.some((tool) => tool && tool.name === 'note.list')) {
        console.log('MCP_STDIO_TOOLS_OK')
        finish(0)
      } else {
        console.error(`tools/list via @movp/mcp-bridge is missing note.list: ${line}`)
        finish(1)
      }
    }
  }
})
child.on('exit', (code) => {
  if (!finishing) {
    console.error(`@movp/mcp-bridge exited before tools/list succeeded (code=${code})`)
    finish(1)
  }
})

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'movp-slice-probe', version: '0.0.0' },
  },
})
