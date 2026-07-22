import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const MAX_SOURCE_BYTES = 256 * 1024
const productionRoot = resolve(import.meta.dirname, '../../../supabase/functions')
const expected = new Map([
  ['auth-exchange/index.ts', ['resolvePatToken']],
  ['graphql/index.ts', ['resolvePrincipal']],
  ['ingest/index.ts', ['resolvePrincipal']],
  ['mcp/index.ts', ['resolvePrincipal']],
])
const temporaryRoots: string[] = []

async function indexFiles(root: string): Promise<string[]> {
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`unsafe seam root: ${root}`)
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const directoryInfo = await lstat(directory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`unsafe seam directory: ${directory}`)
    }
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`symlink rejected before seam read: ${path}`)
      if (info.isDirectory()) {
        await walk(path)
      } else if (info.isFile() && entry === 'index.ts') {
        if (info.size > MAX_SOURCE_BYTES) throw new Error(`seam source exceeds size bound: ${path}`)
        files.push(path)
      }
    }
  }

  await walk(root)
  return files.sort()
}

async function inventory(root: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  for (const path of await indexFiles(root)) {
    const source = (await readFile(path)).toString('utf8')
    const calls = [
      ...(source.match(/\bresolvePrincipal\s*\(/g) ?? []).map(() => 'resolvePrincipal'),
      ...(source.match(/\bresolvePatToken\s*\(/g) ?? []).map(() => 'resolvePatToken'),
    ].sort()
    if (calls.length > 0) found.set(relative(root, path), calls)
  }
  return found
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'movp-auth-seam-'))
  temporaryRoots.push(root)
  const directory = join(root, 'rogue')
  await mkdir(directory)
  await writeFile(join(directory, 'index.ts'), source, { mode: 0o600 })
  return root
}

describe('production auth surface inventory', () => {
  it('pins every resolvePrincipal and direct resolvePatToken entrypoint', async () => {
    expect(await inventory(productionRoot)).toEqual(expected)
  })

  it('fails when an unregistered resolvePrincipal callsite appears', async () => {
    const root = await fixture('export const handler = () => resolvePrincipal(request, env)')
    await expect(inventory(root)).resolves.not.toEqual(expected)
  })

  it('fails when an unregistered direct resolvePatToken callsite appears', async () => {
    const root = await fixture('export const handler = () => resolvePatToken(token, env, admin)')
    await expect(inventory(root)).resolves.not.toEqual(expected)
  })

  it('rejects a symlinked source before reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'movp-auth-seam-'))
    temporaryRoots.push(root)
    await mkdir(join(root, 'linked'))
    await symlink(import.meta.filename, join(root, 'linked', 'index.ts'))

    await expect(inventory(root)).rejects.toThrow('symlink rejected before seam read')
  })
})
