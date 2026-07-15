import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from '../src/dsl-reference/safe-write.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'movp-docs-safe-write-'))
  roots.push(root)
  return root
}

describe('atomicWriteFile', () => {
  it('writes generated outputs atomically with owner-only permissions', async () => {
    const target = join(await tempRoot(), 'generated.txt')
    await atomicWriteFile(target, 'generated\n')
    expect(await readFile(target, 'utf8')).toBe('generated\n')
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
  })

  it('refuses a symlinked output without changing its target', async () => {
    const root = await tempRoot()
    const victim = join(root, 'victim.txt')
    const output = join(root, 'generated.txt')
    await writeFile(victim, 'unchanged\n')
    await symlink(victim, output)

    await expect(atomicWriteFile(output, 'overwrite\n')).rejects.toThrow(/safe_write_refused: .*refusing to overwrite a symlink/)
    expect(await readFile(victim, 'utf8')).toBe('unchanged\n')
  })
})
