import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDeltaRegistry, saveDeltaRegistry } from '../src/deltas-registry.ts'
import { emitProjectDeltaSql } from '../src/emit-sql.ts'
import { generate } from '../src/generate.ts'
import { newDelta } from '../src/new-delta.ts'
import { projectCollection as col, projectEvent, projectSchema } from './project-schema-fixture.ts'

const BASELINE = '20260712120000_movp_generated.sql'
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

  it('rejects project collection removal with an actionable stable code', async () => {
    const context = await scaffold()
    await generate({
      schema: projectSchema([col('deal')]), migrationsDir: context.migrationsDir,
      migrationName: BASELINE, deltasRegistryPath: context.registryPath,
    })
    await expect(newDelta({
      schema: projectSchema([]), name: 'remove_deal', registryPath: context.registryPath,
      migrationsDir: context.migrationsDir, timestamp: '20260712145000',
    })).rejects.toThrow(/project_schema_removal_unsupported.*deal.*additive-only/)
  })

  it('allocates an unowned project event without re-emitting platform events', async () => {
    const context = await scaffold()
    await generate({
      schema: projectSchema([col('deal')], [projectEvent('deal.created')]),
      migrationsDir: context.migrationsDir,
      migrationName: BASELINE,
      deltasRegistryPath: context.registryPath,
    })
    const schema = projectSchema(
      [col('deal')],
      [projectEvent('deal.created'), projectEvent('deal.won')],
    )
    const created = await newDelta({
      schema,
      name: 'deal_won',
      registryPath: context.registryPath,
      migrationsDir: context.migrationsDir,
      timestamp: '20260712150000',
    })
    expect(created).toEqual({
      file: '20260712150000_movp_generated_deal_won.sql',
      collections: [],
      events: ['deal.won'],
    })
    const sql = await readFile(join(context.migrationsDir, created.file), 'utf8')
    expect(sql).toContain("'deal.won'")
    expect(sql).not.toContain("'deal.created'")
    expect(sql).not.toContain("'note.created'")
    await generate({
      schema,
      migrationsDir: context.migrationsDir,
      migrationName: BASELINE,
      deltasRegistryPath: context.registryPath,
    })
  })

  it('rejects a symlinked migrations root before reading its target', async () => {
    const context = await scaffold()
    const outside = await mkdtemp(join(tmpdir(), 'movp-newdelta-outside-'))
    const linked = join(await mkdtemp(join(tmpdir(), 'movp-newdelta-link-')), 'migrations')
    await symlink(outside, linked)
    await expect(newDelta({
      schema: projectSchema([col('deal')]),
      name: 'deal',
      registryPath: context.registryPath,
      migrationsDir: linked,
      timestamp: '20260712160000',
    })).rejects.toThrow(/migrations_dir_symlink_rejected/)
  })

  it('preflights the output path before updating the registry', async () => {
    const context = await scaffold()
    const file = '20260712170000_movp_generated_company.sql'
    await writeFile(join(context.migrationsDir, file), '-- foreign file\n')
    await expect(newDelta({
      schema: projectSchema([col('company')]),
      name: 'company',
      registryPath: context.registryPath,
      migrationsDir: context.migrationsDir,
      timestamp: '20260712170000',
    })).rejects.toThrow(/delta_file_exists/)
    expect(await loadDeltaRegistry(context.registryPath)).toEqual({ deltas: [] })
    expect(await readFile(join(context.migrationsDir, file), 'utf8')).toBe('-- foreign file\n')
  })

  it('reconciles an intact generated migration left by a failed registry update', async () => {
    const context = await scaffold()
    const schema = projectSchema([col('company')])
    const file = '20260712180000_movp_generated_company.sql'
    await writeFile(
      join(context.migrationsDir, file),
      emitProjectDeltaSql(schema, { collections: ['company'], events: [] }),
      { mode: 0o600 },
    )

    await expect(newDelta({
      schema,
      name: 'company',
      registryPath: context.registryPath,
      migrationsDir: context.migrationsDir,
      timestamp: '20260712180000',
    })).resolves.toEqual({ file, collections: ['company'], events: [] })
    expect(await loadDeltaRegistry(context.registryPath)).toEqual({
      deltas: [{ file, collections: ['company'], events: [] }],
    })
    expect((await readdir(context.migrationsDir)).filter((name) => name === file)).toHaveLength(1)
  })

  it('leaves a registry-write failure recoverable by the exact rerun', async () => {
    const context = await scaffold()
    const schema = projectSchema([col('company')])
    const root = join(context.registryPath, '..')
    const file = '20260712190000_movp_generated_company.sql'
    await chmod(root, 0o555)
    try {
      await expect(newDelta({
        schema,
        name: 'company',
        registryPath: context.registryPath,
        migrationsDir: context.migrationsDir,
        timestamp: '20260712190000',
      })).rejects.toThrow(/delta_registry_update_failed.*rerun "movp new-delta company"/)
    } finally {
      await chmod(root, 0o755)
    }

    expect(await loadDeltaRegistry(context.registryPath)).toEqual({ deltas: [] })
    expect(await readFile(join(context.migrationsDir, file), 'utf8')).toContain('public.company')
    await expect(newDelta({
      schema,
      name: 'company',
      registryPath: context.registryPath,
      migrationsDir: context.migrationsDir,
      timestamp: '20260712190000',
    })).resolves.toEqual({ file, collections: ['company'], events: [] })
    expect((await readdir(context.migrationsDir)).filter((name) => name === file)).toHaveLength(1)
  })
})
