import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

let upstream: Server | undefined
let bridge: ChildProcessWithoutNullStreams | undefined

afterEach(async () => {
  bridge?.kill()
  bridge = undefined
  if (upstream) await new Promise<void>((resolve, reject) => upstream?.close((error) => (error ? reject(error) : resolve())))
  upstream = undefined
})

function responseFor(frame: { id?: unknown; method?: unknown }) {
  if (frame.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-movp', version: '0.1.0' },
      },
    }
  }
  if (frame.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: frame.id,
      result: { tools: [{ name: 'task.list', description: 'List tasks', inputSchema: { type: 'object' } }] },
    }
  }
  return { jsonrpc: '2.0', id: frame.id, result: {} }
}

function waitForLine(child: ChildProcessWithoutNullStreams, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for bridge response ${id}`)), 10_000)
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) {
          const parsed: unknown = JSON.parse(line)
          if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && parsed.id === id) {
            clearTimeout(timeout)
            child.stdout.off('data', onData)
            resolve(parsed as Record<string, unknown>)
            return
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`bridge exited ${code}: ${child.stderr.read()?.toString() ?? ''}`))
    })
  })
}

describe('movp-mcp-bridge', () => {
  it('forwards tools/list from stdio to streamable HTTP', async () => {
    const seenHeaders: Array<{ authorization: string | undefined; apikey: string | undefined }> = []
    upstream = createServer((request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(202).end()
        return
      }
      seenHeaders.push({
        authorization: request.headers.authorization,
        apikey: typeof request.headers.apikey === 'string' ? request.headers.apikey : undefined,
      })
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { raw += chunk })
      request.on('end', () => {
        const frame = JSON.parse(raw) as { id?: unknown; method?: unknown }
        if (frame.method === 'notifications/initialized') {
          response.writeHead(202).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(responseFor(frame)))
      })
    })
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('stub server did not bind a TCP port')

    const packageRoot = join(import.meta.dirname, '..')
    const tsx = join(packageRoot, '..', '..', 'node_modules', '.bin', 'tsx')
    bridge = spawn(tsx, ['src/index.ts'], {
      cwd: packageRoot,
      env: {
        HOME: process.env.HOME ?? '',
        MOVP_MCP_URL: `http://127.0.0.1:${address.port}`,
        MOVP_MCP_APIKEY: 'anon-test-key',
        MOVP_PAT: 'movp_pat_test',
        PATH: process.env.PATH ?? '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.1.0' } } })}\n`)
    await waitForLine(bridge, 1)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const listed = await waitForLine(bridge, 2)

    expect(listed).toMatchObject({ result: { tools: [{ name: 'task.list' }] } })
    expect(seenHeaders.length).toBeGreaterThan(0)
    expect(seenHeaders).toEqual(seenHeaders.map(() => ({
      authorization: 'Bearer movp_pat_test',
      apikey: 'anon-test-key',
    })))
  })
})
