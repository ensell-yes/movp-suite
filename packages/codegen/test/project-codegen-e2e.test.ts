import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metadataProjection, type MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { saveDeltaRegistry } from '../src/deltas-registry.ts'
import { generate } from '../src/generate.ts'
import { checkMetadataConsistency, type MetadataDbState } from '../src/metadata-consistency.ts'
import { newDelta } from '../src/new-delta.ts'
import { projectCollection as col, projectSchema as schema } from './project-schema-fixture.ts'

const BASELINE = '20260712120000_movp_generated.sql'
function dbFrom(input: MovpSchema): MetadataDbState {
  const projection = metadataProjection(input)
  return {
    collections: projection.collections.map((collection) => ({ ...collection })),
    fields: projection.fields.map((field) => ({ ...field })),
  }
}

describe('C6c project-codegen acceptance', () => {
  it('rejects unowned drift, then adds one delta without changing the baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'movp-e2e-'))
    const migrationsDir = join(root, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    const registryPath = join(root, 'movp.deltas.json')
    const manifestPath = join(root, 'movp.schema.json')
    await saveDeltaRegistry(registryPath, { deltas: [] })
    const options = (input: MovpSchema) => ({
      schema: input, migrationsDir, migrationName: BASELINE, deltasRegistryPath: registryPath,
      manifestPath, generatorVersion: '0.1.0',
    })

    const firstSchema = schema([col('deal')])
    await generate(options(firstSchema))
    const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
    checkMetadataConsistency(firstSchema, dbFrom(firstSchema))

    const secondSchema = schema([col('deal'), col('company')])
    const before = (await readdir(migrationsDir)).sort()
    await expect(generate(options(secondSchema))).rejects.toThrow(/new_generated_delta_required/)
    expect((await readdir(migrationsDir)).sort()).toEqual(before)

    await newDelta({
      schema: secondSchema, name: 'company', registryPath, migrationsDir,
      timestamp: '20260712130000',
    })
    await generate(options(secondSchema))
    expect(await readFile(join(migrationsDir, BASELINE), 'utf8')).toBe(baseline)
    const after = (await readdir(migrationsDir)).sort()
    expect(after.filter((file) => !before.includes(file))).toEqual([
      '20260712130000_movp_generated_company.sql',
    ])
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      collections: Array<{ name: string; layer: string }>
    }
    expect(manifest.collections
      .filter((collection) => collection.layer === 'project')
      .map((collection) => collection.name)).toEqual(['company', 'deal'])
    checkMetadataConsistency(secondSchema, dbFrom(secondSchema))
  })
})
