import { lstat, readFile } from 'node:fs/promises'
import type { SchemaManifest } from '@movp/codegen'

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const SAFE_NAME = /^[a-z][a-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

export function assertSchemaManifest(value: unknown): asserts value is SchemaManifest {
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
    if (typeof collection.internal !== 'boolean') {
      throw new Error('invalid_manifest: collection internal must be boolean')
    }
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
      if (typeof field.searchable !== 'boolean') {
        throw new Error('invalid_manifest: field searchable must be boolean')
      }
      if (typeof field.embeddable !== 'boolean') {
        throw new Error('invalid_manifest: field embeddable must be boolean')
      }
    }
  }
}

export async function readSchemaManifest(path: string): Promise<SchemaManifest> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`invalid_manifest: ${path} is a symlink`)
  if (!info.isFile()) throw new Error(`invalid_manifest: ${path} is not a regular file`)
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`invalid_manifest: ${path} exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`invalid_manifest: ${path} is not valid JSON`)
  }
  assertSchemaManifest(parsed)
  return parsed
}
