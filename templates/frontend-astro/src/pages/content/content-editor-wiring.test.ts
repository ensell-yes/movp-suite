import { lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PAGE = fileURLToPath(new URL('./[id].astro', import.meta.url))
const MAX_PAGE_BYTES = 512 * 1024
const ITEM_ID_ATTRIBUTE = /\bitemId\s*=\s*\{\s*([^}]+?)\s*\}/g

function readPage(): string {
  const stat = lstatSync(PAGE)
  if (stat.isSymbolicLink()) throw new Error(`content editor wiring: refusing to read a symlink: ${PAGE}`)
  if (!stat.isFile()) throw new Error(`content editor wiring: expected a regular file: ${PAGE}`)
  if (stat.size > MAX_PAGE_BYTES) throw new Error(`content editor wiring: ${PAGE} exceeds size bound`)
  return readFileSync(PAGE, 'utf8')
}

function itemIdAttributes(source: string): Array<{ expression: string; line: number }> {
  return Array.from(source.matchAll(ITEM_ID_ATTRIBUTE), (match) => ({
    expression: match[1]!.replace(/\s+/g, ''),
    line: source.slice(0, match.index).split('\n').length,
  }))
}

describe('content editor wiring', () => {
  it('passes the loaded canonical content ID to the rich-text island', () => {
    const attributes = itemIdAttributes(readPage())
    const found = attributes.length === 0
      ? 'none'
      : attributes.map(({ expression, line }) => `line ${line}: itemId={${expression}}`).join(', ')

    expect(
      attributes.map(({ expression }) => expression),
      `Expected exactly one JSX itemId attribute using item.id; found ${found}`,
    ).toEqual(['item.id'])
  })
})
