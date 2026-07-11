#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const url = process.env.MOVP_MCP_URL
const pat = process.env.MOVP_PAT

if (!url || !pat) {
  console.error('movp-mcp-bridge: set MOVP_MCP_URL and MOVP_PAT')
  process.exit(1)
}

const headers: Record<string, string> = { Authorization: `Bearer ${pat}` }
if (process.env.MOVP_MCP_APIKEY) headers.apikey = process.env.MOVP_MCP_APIKEY

const upstream = new Client({ name: 'movp-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
await upstream.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  }),
)

const server = new Server({ name: 'movp-mcp-bridge', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools())
server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params))
await server.connect(new StdioServerTransport())
