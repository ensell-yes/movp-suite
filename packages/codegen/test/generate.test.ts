import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { generate } from '../src/generate.ts'

const BASELINE = '20260701000002_movp_generated.sql'

if (false) {
  // @ts-expect-error C6b requires callers to inject a schema.
  void generate({ root: '/tmp/never-runs' })
}

async function freshRoot(): Promise<{ root: string; migrationsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'movp-codegen-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  return { root, migrationsDir }
}

describe('generate() generated-delta strategy (C4a.1)', () => {
  it('bootstraps the baseline and is byte-stable across two runs', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ schema, root })
    const first = await readFile(join(migrationsDir, BASELINE), 'utf8')
    await generate({ schema, root })
    expect(await readFile(join(migrationsDir, BASELINE), 'utf8')).toBe(first)
  })

  it('throws on baseline drift instead of rewriting the frozen file', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ schema, root })
    const path = join(migrationsDir, BASELINE)
    const tampered = (await readFile(path, 'utf8')) + '\n-- drift'
    await writeFile(path, tampered)
    await expect(generate({ schema, root })).rejects.toThrow(/generated baseline drift/)
    expect(await readFile(path, 'utf8')).toBe(tampered)
  })

  it('writes registered deltas and re-writes them idempotently', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = { file: '20990101000001_movp_generated_reporting.sql', emit: () => '-- delta body' }
    const res = await generate({ schema, root, deltas: [delta] })
    expect(res.deltaPaths).toHaveLength(1)
    expect(res.deltaPaths[0].endsWith(delta.file)).toBe(true)
    await generate({ schema, root, deltas: [delta] })
    expect(await readFile(join(migrationsDir, delta.file), 'utf8')).toBe('-- delta body')
  })

  it('a delta that owns a collection excludes it from the baseline emit', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = {
      file: '20990101000001_movp_generated_owned.sql',
      emit: () => '-- owned',
      collections: ['note'],
    }
    await generate({ schema, root, deltas: [delta] })
    const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
    expect(baseline).not.toContain('create table if not exists public.note (')

    const fresh = await freshRoot()
    await generate({ schema, root: fresh.root })
    expect(await readFile(join(fresh.migrationsDir, BASELINE), 'utf8'))
      .toContain('create table if not exists public.note (')
  })

  it('a delta that owns an event excludes it from the baseline seed', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = {
      file: '20990101000001_movp_generated_owned.sql',
      emit: () => '-- owned',
      events: ['note.created'],
    }
    await generate({ schema, root, deltas: [delta] })
    const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
    expect(baseline).not.toContain("('note.created', 'lifecycle'")

    const fresh = await freshRoot()
    await generate({ schema, root: fresh.root })
    expect(await readFile(join(fresh.migrationsDir, BASELINE), 'utf8'))
      .toContain("('note.created', 'lifecycle'")
  })

  it('cleanup removes a stale renamed baseline but never a registered delta', async () => {
    const { root, migrationsDir } = await freshRoot()
    await writeFile(join(migrationsDir, '20250101000000_movp_generated.sql'), '-- stale')
    const delta = { file: '20990101000001_movp_generated.sql', emit: () => '-- kept' }
    await generate({ schema, root, deltas: [delta] })
    const files = await readdir(migrationsDir)
    expect(files).not.toContain('20250101000000_movp_generated.sql')
    expect(files).toContain('20990101000001_movp_generated.sql')
    expect(await readFile(join(migrationsDir, '20990101000001_movp_generated.sql'), 'utf8')).toBe('-- kept')
  })

  it('rejects delta filenames that could escape the migrations directory', async () => {
    const { root } = await freshRoot()
    const delta = { file: '../escape.sql', emit: () => '-- must not be written' }
    await expect(generate({ schema, root, deltas: [delta] })).rejects.toThrow(/invalid generated delta filename/)
  })

  it('rejects a delta symlink without overwriting its target', async () => {
    const { root, migrationsDir } = await freshRoot()
    const target = join(root, 'outside.sql')
    const file = '20990101000001_movp_generated_reporting.sql'
    await writeFile(target, '-- outside')
    await symlink(target, join(migrationsDir, file))
    await expect(generate({ schema, root, deltas: [{ file, emit: () => '-- overwritten' }] })).rejects.toThrow(/symlink/)
    expect(await readFile(target, 'utf8')).toBe('-- outside')
  })

  it('emits from the injected schema, not a static import (C6b.2)', async () => {
    const { root, migrationsDir } = await freshRoot()
    const res = await generate({ schema, root })
    const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
    expect(baseline).toContain('create table if not exists public.note')
    expect(res.typesPath.endsWith('types.ts')).toBe(true)
  })
})
