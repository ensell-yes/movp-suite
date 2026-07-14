import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineCollection, defineSchema, schema } from '@movp/core-schema'
import { createDomain } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../cli/src/program.ts'
import { buildSchema } from '../../graphql/src/schema.ts'
import { buildMcpServer } from '../src/server.ts'

function pascal(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

const db = {} as SupabaseClient
const surfaceSchema = defineSchema({
  extends: schema,
  collections: [
    defineCollection({
      name: 'surface_widget',
      label: 'Surface widget',
      labelPlural: 'Surface widgets',
      workspaceScoped: true,
      fields: { title: { type: 'text', label: 'Title', required: true } },
    }),
    defineCollection({
      name: 'surface_secret',
      label: 'Surface secret',
      labelPlural: 'Surface secrets',
      workspaceScoped: true,
      internal: true,
      fields: {},
    }),
  ],
})
const publicCollections = surfaceSchema.collections.filter((collection) => collection.internal !== true)
const internalCollections = surfaceSchema.collections.filter((collection) => collection.internal === true)

describe('real-schema generic surface wiring', () => {
  it('resolves every public collection through the real domain registry', () => {
    const domain = createDomain({ db, userId: 'user-1' }, { schema: surfaceSchema })
    for (const collection of publicCollections) {
      expect(() => domain.collection(collection.name)).not.toThrow()
    }
    for (const collection of internalCollections) {
      expect(() => domain.collection(collection.name)).toThrow(/no domain service for collection/)
    }
    expect(domain.collection('campaign')).toBe(domain.campaign)
  })

  it('exposes every public collection through MCP without a mocked domain', async () => {
    const client = new Client({ name: 'surface-wiring', version: '0.0.0' })
    const server = buildMcpServer(surfaceSchema, { db, userId: 'user-1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name))

    for (const collection of publicCollections) {
      expect(names.has(`${collection.name}.create`), collection.name).toBe(true)
      expect(names.has(`${collection.name}.list`), collection.name).toBe(true)
    }
    expect(names.has('surface_secret.create')).toBe(false)
  })

  it('exposes every public collection through GraphQL and CLI', () => {
    const graphql = buildSchema(surfaceSchema)
    const queries = graphql.getQueryType()?.getFields() ?? {}
    const mutations = graphql.getMutationType()?.getFields() ?? {}
    const cliCommands = new Set(buildProgram(surfaceSchema).commands.map((command) => command.name()))

    for (const collection of publicCollections) {
      expect(queries[collection.name], collection.name).toBeDefined()
      expect(queries[`${collection.name}s`], collection.name).toBeDefined()
      expect(mutations[`create${pascal(collection.name)}`], collection.name).toBeDefined()
      expect(cliCommands.has(collection.name), collection.name).toBe(true)
    }
    expect(queries.surface_secret).toBeUndefined()
    expect(cliCommands.has('surface_secret')).toBe(false)
  })
})
