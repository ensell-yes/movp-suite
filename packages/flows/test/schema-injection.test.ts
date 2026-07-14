import { readFileSync, lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAX_SOURCE_BYTES = 256 * 1024

function guardedSource(relative: string): string {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SOURCE_BYTES) {
    throw new Error(`invalid source fixture: ${relative}`)
  }
  return readFileSync(path, 'utf8')
}

describe('flows schema injection boundary', () => {
  it('does not capture the platform schema inside the runtime package', () => {
    const sources = [
      guardedSource('../src/actions.ts'),
      guardedSource('../src/automation.ts'),
      guardedSource('../src/flows-worker.ts'),
    ].join('\n')
    expect(sources).not.toMatch(/import\s*\{[^}]*\bschema\b[^}]*\}\s*from\s*['"]@movp\/core-schema['"]/) 
  })
})
