import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkTaskCmsContracts } from './check-task-cms-contracts.mjs'

function write(root, path, value) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}

function fixture({ interfaceDoc, mcpSource, cliSource }) {
  const root = mkdtempSync(join(tmpdir(), 'movp-contract-'))
  const dataPath = 'docs/agents/task-cms-data-contract.md'
  const interfacePath = 'docs/agents/task-cms-interface-contract.md'
  const scaffoldPath = 'docs/agents/task-cms-scaffolding.md'
  write(root, dataPath, 'workspace_id task_status_option.category dependency_blocked expectedRevisionId current_revision_id approved_revision_id published_revision_id editorial_task')
  write(root, interfacePath, interfaceDoc)
  write(root, scaffoldPath, 'tools/list task_status_option content.create_type')
  write(root, 'llms.txt', `${dataPath} ${interfacePath} ${scaffoldPath}`)
  write(root, 'docs/agents/AGENTS.template.md', `${dataPath} ${interfacePath} ${scaffoldPath}`)
  write(root, 'packages/core-schema/src/collections/task_status_option.ts', "f.enum(['backlog', 'active', 'blocked', 'done']")
  write(root, 'packages/core-schema/src/collections/content_item.ts', "f.enum(['draft', 'in_review', 'approved', 'published', 'archived']")
  write(root, 'packages/domain/src/content.ts', "'text', 'richtext', 'number', 'bool', 'date', 'enum', 'asset', 'reference', 'json' content_update_conflict")
  write(root, 'packages/mcp/src/server.ts', mcpSource)
  write(root, 'packages/cli/src/program.ts', cliSource)
  return root
}

const completeDoc = `
## Existing Task surface
| Capability | MCP | CLI |
|---|---|---|
| Create | \`task.create\` | \`movp task create\` |
## Existing CMS surface
| Capability | MCP | CLI |
|---|---|---|
| Create | \`content.create\` | \`movp content create\` |
## Pagination and retry rules
nextCursor
`
const completeMcp = `server.registerTool('task.create', {}, callback)\nserver.registerTool('content.create', {}, callback)`
const completeCli = `
const taskCmd = program.command('task')
taskCmd.command('create')
const contentCmd = program.command('content')
contentCmd.command('create')
const workflowsCmd = program.command('workflows')
`

test('accepts equal documented and registered inventories', () => {
  const root = fixture({ interfaceDoc: completeDoc, mcpSource: completeMcp, cliSource: completeCli })
  try {
    assert.deepEqual(checkTaskCmsContracts(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a registered MCP tool missing from the contract', () => {
  const root = fixture({
    interfaceDoc: completeDoc,
    mcpSource: `${completeMcp}\nserver.registerTool('task.purge_everything', {}, callback)`,
    cliSource: completeCli,
  })
  try {
    assert.ok(checkTaskCmsContracts(root).includes('MCP contract: registered but undocumented: task.purge_everything'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a documented MCP tool missing from the registry', () => {
  const root = fixture({
    interfaceDoc: completeDoc,
    mcpSource: "server.registerTool('task.create', {}, callback)",
    cliSource: completeCli,
  })
  try {
    assert.ok(checkTaskCmsContracts(root).includes('MCP contract: documented but unregistered: content.create'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a CLI command missing from the contract', () => {
  const root = fixture({
    interfaceDoc: completeDoc,
    mcpSource: completeMcp,
    cliSource: completeCli.replace("taskCmd.command('create')", "taskCmd.command('create')\ntaskCmd.command('purge')"),
  })
  try {
    assert.ok(checkTaskCmsContracts(root).includes('CLI contract: registered but undocumented: movp task purge'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('names a missing interface contract heading', () => {
  const root = fixture({
    interfaceDoc: completeDoc.replace('## Existing Task surface', '## Renamed Task surface'),
    mcpSource: completeMcp,
    cliSource: completeCli,
  })
  try {
    assert.deepEqual(checkTaskCmsContracts(root), [
      'interface contract heading not found: ## Existing Task surface',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
