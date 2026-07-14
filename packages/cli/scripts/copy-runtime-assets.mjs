import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_RUNTIME_ASSET_BYTES = 256 * 1024

function isMissing(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`${label}_symlink_rejected`)
  if (!info.isDirectory()) throw new Error(`${label}_not_directory`)
}

async function readSource(path) {
  const before = await lstat(path)
  if (before.isSymbolicLink()) throw new Error('runtime_asset_source_symlink_rejected')
  if (!before.isFile()) throw new Error('runtime_asset_source_not_regular_file')
  if (before.size > MAX_RUNTIME_ASSET_BYTES) throw new Error('runtime_asset_source_too_large')

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('runtime_asset_source_not_regular_file')
    if (info.size > MAX_RUNTIME_ASSET_BYTES) throw new Error('runtime_asset_source_too_large')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export async function copyRuntimeAsset(sourcePath, outputPath) {
  const bytes = await readSource(sourcePath)
  await assertRealDirectory(dirname(outputPath), 'runtime_asset_output_directory')

  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink()) throw new Error('runtime_asset_output_symlink_rejected')
    if (!existing.isFile()) throw new Error('runtime_asset_output_not_regular_file')
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const tempPath = `${outputPath}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 })
  try {
    await rename(tempPath, outputPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await copyRuntimeAsset(
    join(packageRoot, 'src', 'verify-schema-runtime.deno.ts'),
    join(packageRoot, 'dist', 'verify-schema-runtime.deno.ts'),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
