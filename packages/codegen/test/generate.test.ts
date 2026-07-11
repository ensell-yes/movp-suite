import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generate } from '../src/generate.ts'

const BASELINE = '20260701000002_movp_generated.sql'

async function freshRoot(): Promise<{ root: string; migrationsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'movp-codegen-'))
  const migrationsDir = join(root, 'supabase', 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  return { root, migrationsDir }
}

describe('generate() generated-delta strategy (C4a.1)', () => {
  it('bootstraps the baseline and is byte-stable across two runs', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ root })
    const first = await readFile(join(migrationsDir, BASELINE), 'utf8')
    await generate({ root })
    expect(await readFile(join(migrationsDir, BASELINE), 'utf8')).toBe(first)
  })

  it('throws on baseline drift instead of rewriting the frozen file', async () => {
    const { root, migrationsDir } = await freshRoot()
    await generate({ root })
    const path = join(migrationsDir, BASELINE)
    const tampered = (await readFile(path, 'utf8')) + '\n-- drift'
    await writeFile(path, tampered)
    await expect(generate({ root })).rejects.toThrow(/generated baseline drift/)
    expect(await readFile(path, 'utf8')).toBe(tampered)
  })

  it('writes registered deltas and re-writes them idempotently', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = { file: '20990101000001_movp_generated_reporting.sql', emit: () => '-- delta body' }
    const res = await generate({ root, deltas: [delta] })
    expect(res.deltaPaths).toHaveLength(1)
    expect(res.deltaPaths[0].endsWith(delta.file)).toBe(true)
    await generate({ root, deltas: [delta] })
    expect(await readFile(join(migrationsDir, delta.file), 'utf8')).toBe('-- delta body')
  })

  it('cleanup removes a stale renamed baseline but never a registered delta', async () => {
    const { root, migrationsDir } = await freshRoot()
    await writeFile(join(migrationsDir, '20250101000000_movp_generated.sql'), '-- stale')
    const delta = { file: '20990101000001_movp_generated.sql', emit: () => '-- kept' }
    await generate({ root, deltas: [delta] })
    const files = await readdir(migrationsDir)
    expect(files).not.toContain('20250101000000_movp_generated.sql')
    expect(files).toContain('20990101000001_movp_generated.sql')
    expect(await readFile(join(migrationsDir, '20990101000001_movp_generated.sql'), 'utf8')).toBe('-- kept')
  })
})
