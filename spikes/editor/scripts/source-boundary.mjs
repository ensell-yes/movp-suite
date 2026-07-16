#!/usr/bin/env node
import { readTextBounded, walkRegularFiles } from './lib/safe-io.mjs'
import { dirname, relative, resolve } from 'node:path'

const CLIENT_FORBIDDEN = ['@movp/domain', '@movp/auth', '@supabase', 'packages/domain', '@spike/oracle']
const TYPE_ESCAPE = ['@ts-ignore', '@ts-expect-error']
const clientDir = process.argv[2]
const allSourceRoot = process.argv[3]
if (!clientDir || !allSourceRoot) {
  console.error('usage: source-boundary.mjs <client-dir> <all-spike-source-root>')
  process.exit(2)
}

let violations = 0
let clientFiles, allFiles
try {
  clientFiles = walkRegularFiles(clientDir)
  allFiles = walkRegularFiles(allSourceRoot)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'source-boundary: unknown read failure')
  process.exit(1)
}
for (const p of clientFiles) {
  if (!/\.(ts|tsx)$/.test(p)) continue
  const text = readTextBounded(p)
  for (const pat of CLIENT_FORBIDDEN) if (text.includes(pat)) { console.error(`BOUNDARY: ${p} references "${pat}"`); violations++ }
  const imports = text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)
  for (const match of imports) {
    const target = resolve(dirname(p), match[1])
    const escaped = relative(resolve(clientDir), target)
    if (escaped === '..' || escaped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      console.error(`BOUNDARY: ${p} relative import escapes client root`); violations++
    }
  }
}
for (const p of allFiles) {
  if (!/\.(ts|tsx)$/.test(p)) continue
  const text = readTextBounded(p)
  for (const pat of TYPE_ESCAPE) if (text.includes(pat)) { console.error(`TYPE-SAFETY: ${p} references "${pat}"`); violations++ }
  if (/[^A-Za-z0-9_]any[^A-Za-z0-9_]/.test(text) && /:\s*any\b|<any>|as any/.test(text)) { console.error(`BOUNDARY: ${p} uses the any type`); violations++ }
}
if (violations) { console.error(`source-boundary: ${violations} violation(s)`); process.exit(1) }
console.log('source-boundary: clean')
