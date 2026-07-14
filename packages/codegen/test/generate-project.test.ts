import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { saveDeltaRegistry } from '../src/deltas-registry.ts'
import { generate } from '../src/generate.ts'

const BASELINE = '20260712120000_movp_generated.sql'

function col(name: string): CollectionDef {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    workspaceScoped: true,
    layer: 'project',
    fields: { title: { type: 'text', label: 'Title' } },
  }
}

function projectSchema(collections: CollectionDef[]): MovpSchema {
  return { collections, events: [], projectCollections: collections, platformCollections: [] }
}

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'movp-proj-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const registryPath = join(root, 'movp.deltas.json')
  await saveDeltaRegistry(registryPath, { deltas: [] })
  return { migrationsDir, registryPath }
}

function opts(schema: MovpSchema, context: Awaited<ReturnType<typeof scaffold>>) {
  return {
    schema,
    migrationsDir: context.migrationsDir,
    migrationName: BASELINE,
    deltasRegistryPath: context.registryPath,
  }
}

describe('generate project mode', () => {
  it('bootstraps a byte-stable project baseline', async () => {
    const context = await scaffold()
    const schema = projectSchema([col('deal')])
    await generate(opts(schema, context))
    const first = await readFile(join(context.migrationsDir, BASELINE), 'utf8')
    await generate(opts(schema, context))
    expect(await readFile(join(context.migrationsDir, BASELINE), 'utf8')).toBe(first)
  })

  it('never deletes foreign generated migrations', async () => {
    const context = await scaffold()
    const foreign = '20200101000000_movp_generated.sql'
    await writeFile(join(context.migrationsDir, foreign), '-- platform stream file')
    await generate(opts(projectSchema([col('deal')]), context))
    expect(await readdir(context.migrationsDir)).toContain(foreign)
  })

  it('rejects an unowned collection with zero migration writes', async () => {
    const context = await scaffold()
    await generate(opts(projectSchema([col('deal')]), context))
    const before = (await readdir(context.migrationsDir)).sort()
    await expect(generate(opts(projectSchema([col('deal'), col('company')]), context)))
      .rejects.toThrow(/new_generated_delta_required/)
    expect((await readdir(context.migrationsDir)).sort()).toEqual(before)
  })

  it('refuses to overwrite a drifted baseline', async () => {
    const context = await scaffold()
    const schema = projectSchema([col('deal')])
    await generate(opts(schema, context))
    const path = join(context.migrationsDir, BASELINE)
    const tampered = `${await readFile(path, 'utf8')}\n-- drift`
    await writeFile(path, tampered)
    await expect(generate(opts(schema, context))).rejects.toThrow(/new_generated_delta_required/)
    expect(await readFile(path, 'utf8')).toBe(tampered)
  })

  it('emits and preserves a registered delta', async () => {
    const context = await scaffold()
    const deltaFile = '20260712130000_movp_generated_company.sql'
    await saveDeltaRegistry(context.registryPath, {
      deltas: [{ file: deltaFile, collections: ['company'], events: [] }],
    })
    const schema = projectSchema([col('deal'), col('company')])
    await generate(opts(schema, context))
    const baseline = await readFile(join(context.migrationsDir, BASELINE), 'utf8')
    const delta = await readFile(join(context.migrationsDir, deltaFile), 'utf8')
    expect(baseline).toContain('public.deal')
    expect(baseline).not.toContain('public.company')
    expect(delta).toContain('public.company')
    await generate(opts(schema, context))
    expect(await readFile(join(context.migrationsDir, deltaFile), 'utf8')).toBe(delta)
  })

  it('requires schema at compile time', () => {
    const noSchemaCall = () =>
      // @ts-expect-error schema injection is mandatory.
      generate({ migrationsDir: '/tmp/movp', migrationName: BASELINE, deltasRegistryPath: '/tmp/movp.deltas.json' })
    expect(typeof noSchemaCall).toBe('function')
  })
})
