import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSchemaManifest } from '../src/dsl-reference/read-manifest.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'movp-docs-manifest-'))
  roots.push(root)
  return root
}

describe('readSchemaManifest', () => {
  it('rejects a parseable manifest whose nested field shape is invalid', async () => {
    const path = join(await tempRoot(), 'movp.schema.json')
    await writeFile(
      path,
      JSON.stringify({
        manifestVersion: 1,
        generatorVersion: '0.1.0',
        schemaFingerprint: 'fixture',
        collections: [
          {
            name: 'deal',
            internal: false,
            label: 'Deal',
            workspaceScoped: true,
            layer: 'project',
            fields: [
              {
                name: 'title',
                type: 'text',
                label: 'Title',
                cardinality: null,
                reporting_role: null,
                searchable: 'yes',
                embeddable: false,
              },
            ],
          },
        ],
      }),
    )

    await expect(readSchemaManifest(path)).rejects.toThrow('invalid_manifest: field searchable must be boolean')
  })

  it('rejects a symlink before reading its target', async () => {
    const root = await tempRoot()
    const target = join(root, 'target.json')
    const path = join(root, 'movp.schema.json')
    await writeFile(target, 'credential-like-content')
    await symlink(target, path)

    await expect(readSchemaManifest(path)).rejects.toThrow(`invalid_manifest: ${path} is a symlink`)
  })
})
