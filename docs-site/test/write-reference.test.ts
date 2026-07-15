import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SchemaManifest } from '@movp/codegen'
import { writeDslReference } from '../src/dsl-reference/write-reference.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'movp-docs-reference-'))
  roots.push(root)
  return root
}

function manifest(names: string[]): SchemaManifest {
  return {
    manifestVersion: 1,
    generatorVersion: '0.1.0',
    schemaFingerprint: 'fixture',
    collections: names.map((name) => ({
      name,
      internal: false,
      label: name[0].toUpperCase() + name.slice(1),
      workspaceScoped: true,
      layer: 'project',
      fields: [],
    })),
  }
}

describe('writeDslReference', () => {
  it('prunes a generated page when its collection leaves the manifest', async () => {
    const docsRoot = await tempRoot()
    const dealPage = join(docsRoot, 'reference', 'deal.md')
    await writeDslReference(docsRoot, manifest(['company', 'deal']))
    expect((await lstat(dealPage)).isFile()).toBe(true)

    await writeDslReference(docsRoot, manifest(['company']))
    await expect(lstat(dealPage)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
