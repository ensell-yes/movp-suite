// Emits docs-site/movp.schema.json from the live @movp/core-schema `schema`.
// Run: pnpm docs:manifest. CI regenerates and runs `git diff --exit-code`.
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { schema } from '@movp/core-schema'
import { emitManifest, serializeManifest } from '@movp/codegen'

const CODEGEN_PKG = new URL('../packages/codegen/package.json', import.meta.url)
const MANIFEST_PATH = new URL('../docs-site/movp.schema.json', import.meta.url)
// Same bound as the other two manifest readers in this plan — keep the three values identical.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

async function generatorVersion(): Promise<string> {
  // Guard EVERY read path, not just the manifest (INTERFACES round-9 F1). A symlinked
  // `packages/codegen/package.json` is followed by `readFile`, and `JSON.parse`'s error message embeds
  // a snippet of the input — so a symlink to a credential file leaks bytes into the docs build log.
  const info = await lstat(CODEGEN_PKG)
  if (info.isSymbolicLink()) throw new Error(`invalid_manifest: ${CODEGEN_PKG} is a symlink`)
  if (!info.isFile()) throw new Error(`invalid_manifest: ${CODEGEN_PKG} is not a regular file`)
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`invalid_manifest: ${CODEGEN_PKG} exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  const raw = await readFile(CODEGEN_PKG, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Bare catch: NEVER interpolate the parse error — its message carries the file's content.
    throw new Error(`invalid_manifest: ${CODEGEN_PKG} is not valid JSON`)
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof (parsed as { version: unknown }).version === 'string'
  ) {
    return (parsed as { version: string }).version
  }
  throw new Error('cannot resolve @movp/codegen version for the docs manifest')
}

const manifest = emitManifest(schema, { generatorVersion: await generatorVersion() })
await writeFile(MANIFEST_PATH, serializeManifest(manifest))
console.log(`wrote docs-site/movp.schema.json (${manifest.collections.length} collections)`)
