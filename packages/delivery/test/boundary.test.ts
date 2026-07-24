import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const MAX_SOURCE_BYTES = 64 * 1024
const temporaryRoots: string[] = []

async function scanSourceTree(root: string): Promise<string> {
  const chunks: string[] = []

  async function walk(path: string): Promise<void> {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('delivery_boundary_symlink')
    if (metadata.isDirectory()) {
      const names = await readdir(path)
      for (const name of names.sort()) await walk(join(path, name))
      return
    }
    if (!metadata.isFile()) throw new Error('delivery_boundary_not_regular')
    if (metadata.size > MAX_SOURCE_BYTES) throw new Error('delivery_boundary_file_too_large')
    chunks.push(await readFile(path, 'utf8'))
  }

  await walk(root)
  return chunks.join('\n')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
})

describe('@movp/delivery client/server boundary', () => {
  it('contains no server, database, editor, React, or Node runtime imports', async () => {
    const source = await scanSourceTree(SOURCE_ROOT)
    expect(source).not.toMatch(/@movp\/(?:domain|auth|graphql)/)
    expect(source).not.toMatch(/@supabase\//)
    expect(source).not.toContain('cloudflare:workers')
    expect(source).not.toMatch(/(?:from|import)\s+['"]node:/)
    expect(source).not.toContain('process.env')
    expect(source).not.toMatch(/readServerEnv|ServerEnv/)
    expect(source).not.toMatch(/service[_-]?role/i)
    expect(source).not.toMatch(/@tiptap|@movp\/editor-sdk/)
    expect(source).not.toMatch(/(?:from|import)\s+['"]react/)
  })

  it('rejects a symlink before reading its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'movp-delivery-boundary-'))
    temporaryRoots.push(root)
    const outside = join(root, 'outside.ts')
    const source = join(root, 'src')
    await writeFile(outside, 'secret-value', { mode: 0o600 })
    await symlink(outside, source)
    await expect(scanSourceTree(source)).rejects.toThrow('delivery_boundary_symlink')
  })

  it('rejects an oversized file before reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'movp-delivery-boundary-'))
    temporaryRoots.push(root)
    const source = join(root, 'oversized.ts')
    await writeFile(source, 'x'.repeat(MAX_SOURCE_BYTES + 1), { mode: 0o600 })
    await expect(scanSourceTree(source)).rejects.toThrow('delivery_boundary_file_too_large')
  })
})
