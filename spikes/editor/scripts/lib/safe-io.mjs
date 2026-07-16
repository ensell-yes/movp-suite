import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function assertRegularBounded(path, maxBytes = MAX_FILE_BYTES) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error(`safe-io: symlink rejected: ${path}`)
  if (!st.isFile()) throw new Error(`safe-io: non-regular file rejected: ${path}`)
  if (st.size > maxBytes) throw new Error(`safe-io: file exceeds cap: ${path}`)
  return st
}

export function assertSafeDirectory(path) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error(`safe-io: symlink rejected: ${path}`)
  if (!st.isDirectory()) throw new Error(`safe-io: non-directory rejected: ${path}`)
}

export function readTextBounded(path, maxBytes = MAX_FILE_BYTES) {
  assertRegularBounded(path, maxBytes)
  return readFileSync(path, 'utf8')
}

export function readJsonBounded(path, maxBytes = MAX_FILE_BYTES) {
  const text = readTextBounded(path, maxBytes)
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`safe-io: invalid JSON: ${path}`) }
  return parsed
}

export function writeTextAtomic(path, text, mode = 0o600) {
  if (typeof text !== 'string') throw new Error(`safe-io: write requires text: ${path}`)
  assertSafeDirectory(dirname(path))
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`safe-io: unsafe write target: ${path}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temp, mode)
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best-effort cleanup; original error remains authoritative */ }
    throw error
  }
}

export function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function walkRegularFiles(dir) {
  const out = []
  let total = 0
  const visit = (d) => {
    assertSafeDirectory(d)
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`safe-io: symlink rejected: ${p}`)
      if (st.isDirectory()) { visit(p); continue }
      if (!st.isFile()) throw new Error(`safe-io: non-regular file rejected: ${p}`)
      total += st.size
      if (total > MAX_TOTAL_BYTES) throw new Error('safe-io: total byte cap exceeded')
      out.push(p)
    }
  }
  visit(dir)
  return out
}
