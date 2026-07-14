import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyRuntimeAsset } from '../scripts/copy-runtime-assets.mjs'

const root = await mkdtemp(join(tmpdir(), 'movp-runtime-assets-'))
try {
  const source = join(root, 'source.ts')
  const outDir = join(root, 'dist')
  const output = join(outDir, 'runtime.ts')
  await mkdir(outDir)
  await writeFile(source, 'export const ok = true\n')
  await copyRuntimeAsset(source, output)
  if (await readFile(output, 'utf8') !== 'export const ok = true\n') {
    throw new Error('runtime_asset_copy_mismatch')
  }

  const secret = join(root, 'secret')
  const linked = join(root, 'linked.ts')
  await writeFile(secret, 'SUPERSECRET\n')
  await symlink(secret, linked)
  let error = ''
  try {
    await copyRuntimeAsset(linked, join(outDir, 'linked.ts'))
  } catch (caught) {
    error = String(caught)
  }
  if (!error.includes('runtime_asset_source_symlink_rejected')) {
    throw new Error('runtime_asset_symlink_was_not_rejected')
  }
  if (/SUPERSECRET/.test(error)) throw new Error('runtime_asset_error_leaked_content')

  console.log('runtime asset copy gate: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
