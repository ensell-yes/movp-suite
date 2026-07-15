// Reads docs-site/movp.schema.json and writes the reference pages. Run: pnpm docs:reference.
// CI regenerates and runs `git diff --exit-code docs-site/src/content/docs/reference`.
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SchemaManifest } from '@movp/codegen'
import { generateDslReference } from '../src/dsl-reference/generate.ts'
import { atomicWriteFile } from '../src/dsl-reference/safe-write.ts'

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MANIFEST_PATH = fileURLToPath(new URL('../movp.schema.json', import.meta.url))
const DOCS_ROOT = fileURLToPath(new URL('../src/content/docs/', import.meta.url))
const SAFE_NAME = /^[a-z][a-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function assertManifest(value: unknown): asserts value is SchemaManifest {
  // Validate every field before the generator dereferences it. A parseable JSON
  // document is not necessarily a valid or path-safe schema manifest.
  if (!isRecord(value)) throw new Error('invalid_manifest: not an object')
  if (value.manifestVersion !== 1) throw new Error('invalid_manifest: manifestVersion must be 1')
  if (typeof value.generatorVersion !== 'string') {
    throw new Error('invalid_manifest: generatorVersion must be a string')
  }
  if (typeof value.schemaFingerprint !== 'string') {
    throw new Error('invalid_manifest: schemaFingerprint must be a string')
  }
  if (!Array.isArray(value.collections)) throw new Error('invalid_manifest: collections must be an array')

  for (const collection of value.collections) {
    if (!isRecord(collection)) throw new Error('invalid_manifest: collection must be an object')
    if (typeof collection.name !== 'string' || !SAFE_NAME.test(collection.name)) {
      throw new Error('invalid_manifest: collection name is invalid')
    }
    if (typeof collection.internal !== 'boolean') throw new Error('invalid_manifest: collection internal must be boolean')
    if (typeof collection.label !== 'string') throw new Error('invalid_manifest: collection label must be a string')
    if (typeof collection.workspaceScoped !== 'boolean') {
      throw new Error('invalid_manifest: collection workspaceScoped must be boolean')
    }
    if (collection.layer !== 'platform' && collection.layer !== 'project') {
      throw new Error('invalid_manifest: collection layer is invalid')
    }
    if (!Array.isArray(collection.fields)) throw new Error('invalid_manifest: collection fields must be an array')

    for (const field of collection.fields) {
      if (!isRecord(field)) throw new Error('invalid_manifest: field must be an object')
      if (typeof field.name !== 'string' || !SAFE_NAME.test(field.name)) {
        throw new Error('invalid_manifest: field name is invalid')
      }
      if (typeof field.type !== 'string') throw new Error('invalid_manifest: field type must be a string')
      if (typeof field.label !== 'string') throw new Error('invalid_manifest: field label must be a string')
      if (!isNullableString(field.cardinality)) {
        throw new Error('invalid_manifest: field cardinality must be a string or null')
      }
      if (!isNullableString(field.reporting_role)) {
        throw new Error('invalid_manifest: field reporting_role must be a string or null')
      }
      if (typeof field.searchable !== 'boolean') throw new Error('invalid_manifest: field searchable must be boolean')
      if (typeof field.embeddable !== 'boolean') throw new Error('invalid_manifest: field embeddable must be boolean')
    }
  }
}

async function readManifest(): Promise<SchemaManifest> {
  // lstat-before-read: a symlinked manifest could point outside the repo.
  const info = await lstat(MANIFEST_PATH)
  if (info.isSymbolicLink()) throw new Error(`invalid_manifest: ${MANIFEST_PATH} is a symlink`)
  if (!info.isFile()) throw new Error(`invalid_manifest: ${MANIFEST_PATH} is not a regular file`)
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`invalid_manifest: ${MANIFEST_PATH} exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  } catch {
    throw new Error(`invalid_manifest: ${MANIFEST_PATH} is not valid JSON`)
  }
  assertManifest(parsed)
  return parsed
}

const pages = generateDslReference(await readManifest())
for (const page of pages) {
  const target = `${DOCS_ROOT}${page.path}`
  await mkdir(dirname(target), { recursive: true })
  await atomicWriteFile(target, page.content)
}
console.log(`wrote ${pages.length} reference pages under docs-site/src/content/docs/reference/`)
