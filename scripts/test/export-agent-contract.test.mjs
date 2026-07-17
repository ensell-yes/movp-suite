import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function runExport(outDir) {
  execFileSync('pnpm', ['exec', 'tsx', 'packages/mcp/scripts/export-agent-contract.ts', '--out-dir', outDir], {
    cwd: new URL('../..', import.meta.url),
    stdio: 'pipe',
  })
}

describe('agent contract export', () => {
  it('is deterministic and reflects write capabilities', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'movp-agent-contract-'))
    try {
      runExport(outDir)
      const first = ['schema.json', 'mcp-tools.json', 'schema-reference.md']
        .map((name) => readFileSync(join(outDir, name), 'utf8'))
      runExport(outDir)
      const second = ['schema.json', 'mcp-tools.json', 'schema-reference.md']
        .map((name) => readFileSync(join(outDir, name), 'utf8'))
      assert.deepEqual(second, first)

      const schema = JSON.parse(first[0])
      const tools = JSON.parse(first[1])
      assert.equal(schema.collections.length, 46)
      assert.equal(schema.events.length, 35)
      assert.equal(tools.toolCount, 176)
      assert.equal(tools.runtimeFingerprint, schema.runtimeFingerprint)
      assert.ok(tools.tools.some((tool) => tool.name === 'campaign.update'))
      assert.ok(tools.tools.some((tool) => tool.name === 'campaign_metric.create'))
      assert.ok(!tools.tools.some((tool) => tool.name === 'campaign_metric.update'))
      assert.ok(!tools.tools.some((tool) => tool.name === 'segment_snapshot.create'))
      assert.equal(lstatSync(join(outDir, 'schema.json')).mode & 0o777, 0o644)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
