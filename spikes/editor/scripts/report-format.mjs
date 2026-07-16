import { createHash } from 'node:crypto'
import { readTextBounded } from './lib/safe-io.mjs'

export const formatBlockIdPreserved = (value) => value === null ? 'N/A' : String(value)

export function computeContentDigest(entries) {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) => left.label.localeCompare(right.label))) {
    const content = readTextBounded(entry.path, 16 * 1024 * 1024)
    hash.update(entry.label)
    hash.update('\0')
    hash.update(String(Buffer.byteLength(content, 'utf8')))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}
