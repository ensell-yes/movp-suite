#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const maxSourceBytes = 2 * 1024 * 1024

function safeRead(root, path) {
  const absolute = resolve(root, path)
  const withinRoot = relative(root, absolute)
  if (withinRoot.startsWith('..') || withinRoot === '') throw new Error(`invalid contract path: ${path}`)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error(`contract input must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`contract input must be a regular file: ${path}`)
  if (stat.size > maxSourceBytes) throw new Error(`contract input exceeds ${maxSourceBytes} bytes: ${path}`)
  return readFileSync(absolute, 'utf8')
}

function tableRows(source, heading, nextHeading) {
  const start = source.indexOf(heading)
  if (start < 0) throw new Error(`interface contract heading not found: ${heading}`)
  const end = source.indexOf(nextHeading, start + heading.length)
  if (end < 0) throw new Error(`interface contract heading not found: ${nextHeading}`)
  return source.slice(start + heading.length, end).split('\n').filter((line) => line.startsWith('|')).join('\n')
}

export function documentedMcpTools(source) {
  const tables = [
    tableRows(source, '## Existing Task surface', '## Existing CMS surface'),
    tableRows(source, '## Existing CMS surface', '## Pagination and retry rules'),
  ].join('\n')
  return new Set([...tables.matchAll(/`((?:task|content)\.[a-z][\w.]*)`/g)].map((match) => match[1]))
}

export function registeredMcpTools(source) {
  return new Set(
    [...source.matchAll(/registerTool\(\s*'([a-z][\w.]*)'/g)]
      .map((match) => match[1])
      .filter((name) => name.startsWith('task.') || name.startsWith('content.')),
  )
}

export function documentedCliCommands(source) {
  const tables = [
    tableRows(source, '## Existing Task surface', '## Existing CMS surface'),
    tableRows(source, '## Existing CMS surface', '## Pagination and retry rules'),
  ].join('\n')
  return new Set([...tables.matchAll(/`(movp (?:task|content) [a-z][\w-]*)`/g)].map((match) => match[1]))
}

function commandBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) return ''
  return source.slice(start + startMarker.length, end)
}

export function registeredCliCommands(source) {
  const groups = [
    ['task', commandBlock(source, "const taskCmd = program.command('task')", "const contentCmd = program.command('content')")],
    ['content', commandBlock(source, "const contentCmd = program.command('content')", "const workflowsCmd = program.command('workflows')")],
  ]
  const commands = []
  for (const [group, block] of groups) {
    for (const match of block.matchAll(/\.command\('([a-z][\w-]*)'\)/g)) commands.push(`movp ${group} ${match[1]}`)
  }
  return new Set(commands)
}

function compareSets(label, documented, registered, failures) {
  for (const name of registered) {
    if (!documented.has(name)) failures.push(`${label}: registered but undocumented: ${name}`)
  }
  for (const name of documented) {
    if (!registered.has(name)) failures.push(`${label}: documented but unregistered: ${name}`)
  }
}

export function checkTaskCmsContracts(root = defaultRoot) {
  const failures = []
  const read = (path) => {
    try {
      return safeRead(root, path)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `failed to read ${path}`)
      return ''
    }
  }
  const requireText = (path, values) => {
    const source = read(path)
    for (const value of values) {
      if (!source.includes(value)) failures.push(`${path}: missing contract term ${JSON.stringify(value)}`)
    }
  }

  const dataContract = 'docs/agents/task-cms-data-contract.md'
  const interfaceContract = 'docs/agents/task-cms-interface-contract.md'
  const scaffoldingGuide = 'docs/agents/task-cms-scaffolding.md'

  requireText(dataContract, [
    'workspace_id',
    'task_status_option.category',
    'dependency_blocked',
    'expectedRevisionId',
    'current_revision_id',
    'approved_revision_id',
    'published_revision_id',
    'editorial_task',
  ])
  requireText(interfaceContract, ['nextCursor'])
  requireText(scaffoldingGuide, ['tools/list', 'task_status_option', 'content.create_type'])
  requireText('llms.txt', [dataContract, interfaceContract, scaffoldingGuide])
  requireText('docs/agents/AGENTS.template.md', [dataContract, interfaceContract, scaffoldingGuide])
  requireText('packages/core-schema/src/collections/task_status_option.ts', [
    "f.enum(['backlog', 'active', 'blocked', 'done']",
  ])
  requireText('packages/core-schema/src/collections/content_item.ts', [
    "f.enum(['draft', 'in_review', 'approved', 'published', 'archived']",
  ])
  requireText('packages/domain/src/content.ts', [
    "'text', 'richtext', 'number', 'bool', 'date', 'enum', 'asset', 'reference', 'json'",
    'content_update_conflict',
  ])

  const interfaceSource = read(interfaceContract)
  try {
    compareSets(
      'MCP contract',
      documentedMcpTools(interfaceSource),
      registeredMcpTools(read('packages/mcp/src/server.ts')),
      failures,
    )
    compareSets(
      'CLI contract',
      documentedCliCommands(interfaceSource),
      registeredCliCommands(read('packages/cli/src/program.ts')),
      failures,
    )
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'failed to parse interface contract headings')
  }

  return failures
}

function main() {
  const failures = checkTaskCmsContracts()
  if (failures.length > 0) {
    console.error('task-cms contract check: FAIL')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('task-cms contract check: ok')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
