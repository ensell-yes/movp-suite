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

function camel(name: string): string {
  const value = pascal(name)
  return value.charAt(0).toLowerCase() + value.slice(1)
}

function graphqlCollectionCandidates(name: string): Set<string> {
  return new Set([
    name,
    `${name}s`,
    camel(name),
    `${camel(name)}s`,
    `create${pascal(name)}`,
    `update${pascal(name)}`,
  ])
}

function internalMcpTools(names: ReadonlySet<string>, collection: string): string[] {
  return [...names].filter((name) => name.startsWith(`${collection}.`)).sort()
}

function internalGraphqlFields(names: ReadonlySet<string>, collection: string): string[] {
  const candidates = graphqlCollectionCandidates(collection)
  return [...names].filter((name) => candidates.has(name)).sort()
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
const realInternalCollections = schema.collections.filter((collection) => collection.internal === true)
const allowedInternalMcpTools: Readonly<Record<string, readonly string[]>> = {
  comment: ['comment.add'],
  reaction: ['reaction.toggle'],
  task: [
    'task.add_dependency',
    'task.add_observer',
    'task.assign',
    'task.attach',
    'task.board',
    'task.create',
    'task.get',
    'task.get_detail',
    'task.list',
    'task.remove_dependency',
    'task.remove_observer',
    'task.transition',
    'task.unassign',
    'task.update_description',
  ],
}
const allowedInternalGraphqlFields: Readonly<Record<string, readonly string[]>> = {
  comment: ['comments'],
  content_approval: ['contentApprovals'],
  content_collection: ['createContentCollection'],
  content_item: ['contentItem'],
  content_revision: ['contentRevisions'],
  content_type: ['contentTypes', 'createContentType'],
  share_link: ['createShareLink'],
  task: ['createTask', 'task', 'tasks'],
}
const allowedInternalCliCommands = new Set(['comment', 'task'])

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
    for (const collection of realInternalCollections) {
      expect(internalMcpTools(names, collection.name), collection.name)
        .toEqual(allowedInternalMcpTools[collection.name] ?? [])
    }
    expect(internalMcpTools(names, 'surface_secret')).toEqual([])
  })

  it('exposes every public collection through GraphQL and CLI', () => {
    const graphql = buildSchema(surfaceSchema)
    const queries = graphql.getQueryType()?.getFields() ?? {}
    const mutations = graphql.getMutationType()?.getFields() ?? {}
    const graphqlFields = new Set([...Object.keys(queries), ...Object.keys(mutations)])
    const cliProgram = buildProgram(surfaceSchema)
    const cliCommandNames = cliProgram.commands.map((command) => command.name())
    const cliCommands = new Set(cliCommandNames)

    for (const collection of publicCollections) {
      expect(queries[collection.name], collection.name).toBeDefined()
      expect(queries[`${collection.name}s`], collection.name).toBeDefined()
      expect(mutations[`create${pascal(collection.name)}`], collection.name).toBeDefined()
      expect(cliCommands.has(collection.name), collection.name).toBe(true)
    }
    for (const collection of realInternalCollections) {
      expect(internalGraphqlFields(graphqlFields, collection.name), collection.name)
        .toEqual(allowedInternalGraphqlFields[collection.name] ?? [])
      const expectedCustomCommands = allowedInternalCliCommands.has(collection.name) ? 1 : 0
      expect(
        cliCommandNames.filter((name) => name === collection.name),
        collection.name,
      ).toHaveLength(expectedCustomCommands)
    }
    expect(internalGraphqlFields(graphqlFields, 'surface_secret')).toEqual([])
    expect(cliCommands.has('surface_secret')).toBe(false)
  })

  it('detects bespoke internal registrations outside the generic loops', () => {
    expect(internalMcpTools(new Set(['asset.get']), 'asset')).toEqual(['asset.get'])
    expect(internalGraphqlFields(new Set(['asset']), 'asset')).toEqual(['asset'])
  })
})
