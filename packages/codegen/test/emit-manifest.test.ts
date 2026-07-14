import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { schemaFingerprint, type CollectionDef, type MovpSchema } from '@movp/core-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { emitManifest, serializeManifest } from '../src/emit-manifest.ts'
import { resolveGeneratorVersion } from '../src/generate.ts'

const deal: CollectionDef = {
  name: 'deal', label: 'Deal', labelPlural: 'Deals', workspaceScoped: true,
  layer: 'project', fields: {
    title: { type: 'text', label: 'Title', searchable: true },
    amount: { type: 'number', label: 'Amount', reporting: { role: 'measure' } },
  },
}
const schema = (collections: CollectionDef[]): MovpSchema => ({
  collections, events: [], projectCollections: collections, platformCollections: [],
})
const fixtureDirs: string[] = []
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'movp-generator-version-'))
  fixtureDirs.push(dir)
  return dir
}
async function capturedError(run: () => Promise<unknown>): Promise<string> {
  try { await run() } catch (error: unknown) { return String(error) }
  throw new Error('expected operation to reject')
}
afterEach(async () => Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

describe('manifest', () => {
  it('uses the locked shape, canonical fingerprint, and deterministic ordering', () => {
    const input = schema([deal])
    const manifest = emitManifest(input, { generatorVersion: '0.1.0' })
    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.schemaFingerprint).toBe(schemaFingerprint(input))
    expect(manifest.collections[0]?.fields.map((field) => field.name)).toEqual(['amount', 'title'])
    expect(manifest.collections[0]?.layer).toBe('project')
  })

  it('serializes deterministically with a trailing newline', () => {
    const manifest = emitManifest(schema([deal]), { generatorVersion: '0.1.0' })
    expect(serializeManifest(manifest)).toBe(serializeManifest(manifest))
    expect(serializeManifest(manifest).endsWith('}\n')).toBe(true)
  })
})

describe('resolveGeneratorVersion', () => {
  it('reads an encoded regular-file path', async () => {
    const path = join(await fixtureDir(), 'package with space.json')
    await writeFile(path, JSON.stringify({ version: '0.1.0' }))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(path))).resolves.toBe('0.1.0')
  })

  it('rejects a symlink without leaking target bytes', async () => {
    const dir = await fixtureDir()
    const target = join(dir, 'credentials')
    const path = join(dir, 'package.json')
    await writeFile(target, 'aws_secret_access_key = SUPERSECRET\n')
    await symlink(target, path)
    const error = await capturedError(() => resolveGeneratorVersion(undefined, pathToFileURL(path)))
    expect(error).toMatch(/generator_version_symlink_rejected/)
    expect(error).not.toMatch(/SUPERSECRET|aws_secret/)
  })

  it('rejects a non-regular file', async () => {
    const dir = await fixtureDir()
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(dir))).rejects.toThrow(/not_regular_file/)
  })

  it('bounds before buffering', async () => {
    const path = join(await fixtureDir(), 'package.json')
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(path))).rejects.toThrow(/too_large/)
  })

  it('does not leak malformed JSON bytes', async () => {
    const path = join(await fixtureDir(), 'package.json')
    await writeFile(path, 'aws_secret_access_key = SUPERSECRET\n')
    const error = await capturedError(() => resolveGeneratorVersion(undefined, pathToFileURL(path)))
    expect(error).toMatch(/generator_version_invalid_json/)
    expect(error).not.toMatch(/SUPERSECRET|aws_secret/)
  })

  it('validates the parsed version', async () => {
    const path = join(await fixtureDir(), 'package.json')
    await writeFile(path, JSON.stringify({ version: 123 }))
    await expect(resolveGeneratorVersion(undefined, pathToFileURL(path))).rejects.toThrow(/invalid_shape/)
  })
})
