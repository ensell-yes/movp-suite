import { lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SchemaManifest } from '@movp/codegen'
import { generateDslReference } from './generate.ts'
import { atomicWriteFile } from './safe-write.ts'

async function prepareReferenceDirectory(docsRoot: string): Promise<string> {
  const referenceRoot = resolve(docsRoot, 'reference')
  await mkdir(referenceRoot, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(referenceRoot)
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`safe_write_refused: ${referenceRoot}: refusing a symlinked generated directory`)
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`safe_write_refused: ${referenceRoot}: not a directory`)
  }

  const entries = await readdir(referenceRoot)
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue
    const target = resolve(referenceRoot, name)
    const info = await lstat(target)
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`safe_write_refused: ${target}: generated markdown path is not a file or symlink`)
    }
    await unlink(target)
  }
  return referenceRoot
}

export async function writeDslReference(docsRoot: string, manifest: SchemaManifest): Promise<number> {
  const pages = generateDslReference(manifest)
  const referenceRoot = await prepareReferenceDirectory(docsRoot)
  for (const page of pages) {
    const target = resolve(docsRoot, page.path)
    if (dirname(target) !== referenceRoot) {
      throw new Error(`safe_write_refused: ${page.path}: generated page escapes the reference directory`)
    }
    await atomicWriteFile(target, page.content)
  }
  return pages.length
}
