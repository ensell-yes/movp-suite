import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { loadDeltaRegistry, saveDeltaRegistry } from '../src/deltas-registry.ts'
import { generate } from '../src/generate.ts'
import { newDelta } from '../src/new-delta.ts'

const BASELINE = '20260712120000_movp_generated.sql'
const col = (name: string): CollectionDef => ({
  name, label: name, labelPlural: `${name}s`, workspaceScoped: true, layer: 'project',
  fields: { title: { type: 'text', label: 'Title' } },
})
const projectSchema = (collections: CollectionDef[]): MovpSchema => ({
  collections, events: [], projectCollections: collections, platformCollections: [],
})

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'movp-newdelta-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const registryPath = join(root, 'movp.deltas.json')
  await saveDeltaRegistry(registryPath, { deltas: [] })
  return { migrationsDir, registryPath }
}

describe('newDelta', () => {
  it('allocates unowned collections in exactly one additive migration', async () => {
    const context = await scaffold()
    await generate({
      schema: projectSchema([col('deal')]), migrationsDir: context.migrationsDir,
      migrationName: BASELINE, deltasRegistryPath: context.registryPath,
    })
    const before = (await readdir(context.migrationsDir)).sort()
    const schema = projectSchema([col('deal'), col('company')])
    const created = await newDelta({
      schema, name: 'company', registryPath: context.registryPath,
      migrationsDir: context.migrationsDir, timestamp: '20260712130000',
    })
    expect(created).toEqual({
      file: '20260712130000_movp_generated_company.sql', collections: ['company'], events: [],
    })
    const after = (await readdir(context.migrationsDir)).sort()
    expect(after.filter((file) => !before.includes(file))).toEqual([created.file])
    expect(await readFile(join(context.migrationsDir, created.file), 'utf8')).toContain('public.company')
    expect((await loadDeltaRegistry(context.registryPath)).deltas).toHaveLength(1)
    await generate({
      schema, migrationsDir: context.migrationsDir, migrationName: BASELINE,
      deltasRegistryPath: context.registryPath,
    })
    expect((await readdir(context.migrationsDir)).sort()).toEqual(after)
  })

  it('rejects a schema with nothing unowned', async () => {
    const context = await scaffold()
    const schema = projectSchema([col('deal')])
    await generate({
      schema, migrationsDir: context.migrationsDir, migrationName: BASELINE,
      deltasRegistryPath: context.registryPath,
    })
    await expect(newDelta({
      schema, name: 'noop', registryPath: context.registryPath,
      migrationsDir: context.migrationsDir, timestamp: '20260712140000',
    })).rejects.toThrow(/nothing_to_allocate/)
  })
})
