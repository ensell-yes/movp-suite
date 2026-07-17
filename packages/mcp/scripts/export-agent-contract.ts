import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { chmod, lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  genericWriteMode,
  runtimeFingerprint,
  schema,
  schemaFingerprint,
  type CollectionDef,
  type FieldDef,
} from '@movp/core-schema'
import { buildMcpServer } from '../src/server.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { atomicWriteFile } from '../../codegen/src/safe-write.ts'

const MAX_PACKAGE_JSON_BYTES = 64 * 1024

async function releaseVersion(): Promise<string> {
  const path = resolve('packages/core-schema/package.json')
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) {
    throw new Error('agent_contract_invalid_package_manifest')
  }
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new Error('agent_contract_invalid_package_manifest')
  }
  const version = (parsed as { version: unknown }).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('agent_contract_invalid_package_version')
  }
  return version
}

function relationSummary(field: FieldDef): string {
  if (field.type !== 'relation') return field.values?.join(', ') ?? ''
  const cardinality = field.cardinality ?? 'unspecified'
  return `${field.target ?? 'unknown'} (${cardinality}${field.graph ? ', graph' : ''})`
}

function defaultSummary(field: FieldDef): string {
  return field.default === undefined ? '' : `\`${String(field.default)}\``
}

function surfaceSummary(collection: CollectionDef): string {
  if (collection.internal) return 'bespoke/internal'
  const mode = genericWriteMode(collection)
  if (mode === 'crud') return 'generic read/create/update'
  if (mode === 'append-only') return 'generic read/create (append-only)'
  return 'generic read-only'
}

function schemaReference(release: string): string {
  const lines = [
    '# MOVP schema reference',
    '',
    `> Generated from \`@movp/core-schema\` release \`${release}\`. Do not hand-edit this file.`,
    '',
    `- Collections: **${schema.collections.length}**`,
    `- Events: **${schema.events.length}**`,
    `- Metadata fingerprint: \`${schemaFingerprint(schema)}\``,
    `- Runtime fingerprint: \`${runtimeFingerprint(schema)}\``,
    '',
    'Stored `many-to-one` and `one-to-one` relations are submitted as `<field>_id`.',
    'Graph-only and inverse relations are managed with MCP `.link` tools, not create/update fields.',
    '',
    '## Collection index',
    '',
    '| Collection | Scope | Generic write mode | Surface | Fields |',
    '| --- | --- | --- | --- | ---: |',
  ]

  for (const collection of schema.collections) {
    lines.push(
      `| \`${collection.name}\` | ${collection.workspaceScoped ? 'workspace' : 'global'} | `
      + `${collection.internal ? 'n/a' : `\`${genericWriteMode(collection)}\``} | `
      + `${surfaceSummary(collection)} | ${Object.keys(collection.fields).length} |`,
    )
  }

  lines.push('', '## Complete field reference', '')
  for (const collection of schema.collections) {
    lines.push(
      `### ${collection.label} (\`${collection.name}\`)`,
      '',
      `Scope: ${collection.workspaceScoped ? 'workspace' : 'global'} · Surface: ${surfaceSummary(collection)}`,
      '',
      '| Field | Type | Required | Default | Enum/relation | Search | Reporting |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    )
    for (const [name, field] of Object.entries(collection.fields)) {
      lines.push(
        `| \`${name}\` | \`${field.type}\` | ${field.required ? 'yes' : 'no'} | ${defaultSummary(field)} | `
        + `${relationSummary(field)} | ${field.searchable ? 'yes' : ''} | ${field.reporting?.role ?? ''} |`,
      )
    }
    lines.push('')
  }

  lines.push(
    '## Event catalog',
    '',
    '| Event | Domain | Version | Payload fields |',
    '| --- | --- | ---: | --- |',
  )
  for (const event of schema.events) {
    lines.push(
      `| \`${event.key}\` | ${event.domain} | ${event.version} | `
      + `${Object.keys(event.payloadSchema).sort().map((name) => `\`${name}\``).join(', ')} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

async function mcpTools() {
  const db = {} as SupabaseClient
  const client = new Client({ name: 'agent-contract-export', version: '0.0.0' })
  const server = buildMcpServer(schema, { db, userId: 'contract-export' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return (await client.listTools()).tools.toSorted((left, right) => left.name.localeCompare(right.name))
  } finally {
    await Promise.all([client.close(), server.close()])
  }
}

function outDirFromArgs(argv: string[]): string {
  const flag = argv.indexOf('--out-dir')
  if (flag < 0 || argv[flag + 1] === undefined || argv[flag + 1] === '') {
    throw new Error('usage: pnpm docs:agent-contract -- --out-dir <existing-directory>')
  }
  return resolve(argv[flag + 1])
}

async function writePublicArtifact(path: string, contents: string): Promise<void> {
  await atomicWriteFile(path, contents)
  await chmod(path, 0o644)
}

export async function exportAgentContract(outDir: string): Promise<void> {
  const info = await lstat(outDir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('agent_contract_invalid_output_directory')
  const release = await releaseVersion()
  const fingerprint = runtimeFingerprint(schema)
  const tools = await mcpTools()
  const schemaArtifact = {
    release,
    schemaFingerprint: schemaFingerprint(schema),
    runtimeFingerprint: fingerprint,
    collections: schema.collections,
    events: schema.events,
  }
  const toolArtifact = {
    release,
    runtimeFingerprint: fingerprint,
    generatedFrom: 'MOVP MCP registry',
    toolCount: tools.length,
    tools,
  }
  await Promise.all([
    writePublicArtifact(resolve(outDir, 'schema.json'), `${JSON.stringify(schemaArtifact, null, 2)}\n`),
    writePublicArtifact(resolve(outDir, 'mcp-tools.json'), `${JSON.stringify(toolArtifact, null, 2)}\n`),
    writePublicArtifact(resolve(outDir, 'schema-reference.md'), schemaReference(release)),
  ])
  console.log(`agent contract: ${schema.collections.length} collections, ${schema.events.length} events, ${tools.length} tools`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await exportAgentContract(outDirFromArgs(process.argv.slice(2)))
}
