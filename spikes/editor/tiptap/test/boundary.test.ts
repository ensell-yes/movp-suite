import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../../scripts/lib/safe-io.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))

const run = (script: string, ...args: string[]): number => {
  try {
    execFileSync('node', [`scripts/${script}`, ...args], { cwd: workspace, encoding: 'utf8' })
    return 0
  } catch (error) {
    return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 1
  }
}

describe('@spike/tiptap boundary', () => {
  it('source and built module graph are independently clean', () => {
    expect(run('source-boundary.mjs', 'tiptap/src', '.', 'tiptap/src/main.tsx')).toBe(0)
    execFileSync('pnpm', ['--filter', '@spike/tiptap', 'build'], { cwd: workspace, stdio: 'inherit' })
    expect(run('module-graph-gate.mjs', 'tiptap/dist')).toBe(0)
    const reportDir = join(workspace, 'tiptap/.report')
    mkdirSync(reportDir, { recursive: true })
    writeJsonAtomic(join(reportDir, 'tiptap.boundary.json'), { boundary: true })
  }, 20_000)
})
