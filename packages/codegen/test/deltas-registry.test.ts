import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDeltaRegistry, saveDeltaRegistry } from '../src/deltas-registry.ts'

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'movp-deltas-'))
}

describe('delta registry', () => {
  it('returns an empty registry when absent', async () => {
    expect(await loadDeltaRegistry(join(await dir(), 'movp.deltas.json'))).toEqual({ deltas: [] })
  })

  it('round-trips a valid registry', async () => {
    const path = join(await dir(), 'movp.deltas.json')
    const registry = {
      deltas: [{ file: '20260712000001_movp_generated_crm.sql', collections: ['deal'], events: ['deal.won'] }],
    }
    await saveDeltaRegistry(path, registry)
    expect(await loadDeltaRegistry(path)).toEqual(registry)
  })

  it('rejects a symlink without reading its target', async () => {
    const d = await dir()
    const target = join(d, 'outside.json')
    await writeFile(target, JSON.stringify({ deltas: [] }))
    const path = join(d, 'movp.deltas.json')
    await symlink(target, path)
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry.*symlink/)
  })

  it('rejects invalid top-level structure', async () => {
    const path = join(await dir(), 'movp.deltas.json')
    await writeFile(path, JSON.stringify({ deltas: 'nope' }))
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry/)
  })

  it('rejects entries missing required fields', async () => {
    const path = join(await dir(), 'movp.deltas.json')
    await writeFile(path, JSON.stringify({ deltas: [{ file: 'x.sql' }] }))
    await expect(loadDeltaRegistry(path)).rejects.toThrow(/invalid_deltas_registry/)
  })

  it('refuses to overwrite a symlink target', async () => {
    const d = await dir()
    const target = join(d, 'outside.json')
    const original = JSON.stringify({ deltas: [] })
    await writeFile(target, original)
    const path = join(d, 'movp.deltas.json')
    await symlink(target, path)
    await expect(saveDeltaRegistry(path, {
      deltas: [{ file: '20260712000001_movp_generated_x.sql', collections: ['deal'], events: [] }],
    })).rejects.toThrow(/invalid_deltas_registry.*symlink/)
    expect(await readFile(target, 'utf8')).toBe(original)
  })

  it('replaces a pre-existing 0644 registry with a 0600 inode', async () => {
    const path = join(await dir(), 'movp.deltas.json')
    await writeFile(path, `${JSON.stringify({ deltas: [] })}\n`)
    await chmod(path, 0o644)
    await saveDeltaRegistry(path, { deltas: [] })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
