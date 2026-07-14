import { atomicWriteFile } from './safe-write.ts'

export interface DeltaRegistryEntry {
  file: string
  collections: string[]
  events: string[]
}

export interface DeltaRegistry {
  deltas: DeltaRegistryEntry[]
}

const MAX_REGISTRY_BYTES = 1024 * 1024

function fail(reason: string): never {
  throw new Error(`invalid_deltas_registry: ${reason}`)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code: unknown }).code === 'ENOENT'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function assertRegistry(value: unknown, path: string): asserts value is DeltaRegistry {
  if (typeof value !== 'object' || value === null) fail(`${path}: not an object`)
  const deltas = (value as { deltas?: unknown }).deltas
  if (!Array.isArray(deltas)) fail(`${path}: deltas must be an array`)
  for (const [index, entry] of deltas.entries()) {
    if (typeof entry !== 'object' || entry === null) fail(`${path}: deltas[${index}] not an object`)
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.file !== 'string' || candidate.file.length === 0) {
      fail(`${path}: deltas[${index}].file must be a non-empty string`)
    }
    if (!isStringArray(candidate.collections)) {
      fail(`${path}: deltas[${index}].collections must be a string array`)
    }
    if (!isStringArray(candidate.events)) {
      fail(`${path}: deltas[${index}].events must be a string array`)
    }
  }
}

export async function loadDeltaRegistry(path: string): Promise<DeltaRegistry> {
  const fs = await import('node:fs/promises')
  let info: Awaited<ReturnType<typeof fs.lstat>>
  try {
    info = await fs.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return { deltas: [] }
    throw error
  }
  if (info.isSymbolicLink()) fail(`${path}: is a symlink`)
  if (!info.isFile()) fail(`${path}: not a regular file`)
  if (info.size > MAX_REGISTRY_BYTES) fail(`${path}: exceeds ${MAX_REGISTRY_BYTES} bytes`)

  const raw = await fs.readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${path}: not valid JSON`)
  }
  assertRegistry(parsed, path)
  return parsed
}

export async function saveDeltaRegistry(path: string, registry: DeltaRegistry): Promise<void> {
  assertRegistry(registry, path)
  await atomicWriteFile(path, `${JSON.stringify(registry, null, 2)}\n`, { onRefuse: fail })
}
