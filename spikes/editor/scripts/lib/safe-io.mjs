import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function assertRegularBounded(path, maxBytes = MAX_FILE_BYTES) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error(`safe-io:E_SYMLINK path=${path}`)
  if (!st.isFile()) throw new Error(`safe-io:E_NOT_REGULAR path=${path}`)
  if (st.size > maxBytes) throw new Error(`safe-io:E_FILE_CAP path=${path}`)
  return st
}

export function assertSafeDirectory(path) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new Error(`safe-io:E_SYMLINK path=${path}`)
  if (!st.isDirectory()) throw new Error(`safe-io:E_NOT_DIRECTORY path=${path}`)
}

export function readTextBounded(path, maxBytes = MAX_FILE_BYTES) {
  assertRegularBounded(path, maxBytes)
  return readFileSync(path, 'utf8')
}

export function readJsonBounded(path, maxBytes = MAX_FILE_BYTES) {
  const text = readTextBounded(path, maxBytes)
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`safe-io:E_INVALID_JSON path=${path}`) }
  return parsed
}

export function writeTextAtomic(path, text, mode = 0o600) {
  if (typeof text !== 'string') throw new Error(`safe-io:E_TEXT_REQUIRED path=${path}`)
  assertSafeDirectory(dirname(path))
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`safe-io:E_UNSAFE_TARGET path=${path}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
    chmodSync(path, mode)
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
      if (st.isSymbolicLink()) throw new Error(`safe-io:E_SYMLINK path=${p}`)
      if (st.isDirectory()) { visit(p); continue }
      if (!st.isFile()) throw new Error(`safe-io:E_NOT_REGULAR path=${p}`)
      total += st.size
      if (total > MAX_TOTAL_BYTES) throw new Error(`safe-io:E_TOTAL_CAP path=${dir} count=${total}`)
      out.push(p)
    }
  }
  visit(dir)
  return out
}
