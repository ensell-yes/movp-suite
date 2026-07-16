#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { readJsonBounded, readTextBounded, walkRegularFiles } from './lib/safe-io.mjs'

const pkgDir = process.argv[2]
const mode = process.argv[3] ?? 'prod'
const candidate = process.argv[4]
const inputAt = process.argv.indexOf('--input')
const inputFile = inputAt >= 0 ? process.argv[inputAt + 1] : undefined
if (!pkgDir || !['prod', 'full'].includes(mode) || !['blocknote', 'tiptap'].includes(candidate) || (inputAt >= 0 && !inputFile)) {
  console.error('usage: license-gate.mjs <pkg-dir> <prod|full> <blocknote|tiptap> [--input fixture.json]')
  process.exit(2)
}

const PROD_ALLOW = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0'])
const FULL_ALLOW = new Set([...PROD_ALLOW, 'CC0-1.0', 'Unlicense'])
const COPYLEFT = new Set(['MPL-2.0', 'EPL-2.0', 'GPL-2.0-only', 'GPL-3.0-only', 'AGPL-3.0-only', 'LGPL-2.1-only', 'LGPL-3.0-only'])
const DENY_SUBSTR = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'UNLICENSED', 'PROPRIETARY']
const DIRECT_EDITOR = candidate === 'blocknote'
  ? ['@blocknote/core', '@blocknote/react', '@blocknote/mantine', '@mantine/core', '@mantine/hooks']
  : ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']

let byLicense
if (inputFile) {
  try { byLicense = readJsonBounded(inputFile) }
  catch { console.error('license-gate: invalid fixture'); process.exit(1) }
} else {
  let raw
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--long', '--json', ...(mode === 'prod' ? ['--prod'] : [])], { cwd: pkgDir, encoding: 'utf8' })
  } catch { console.error('license-gate: pnpm licenses failed'); process.exit(1) }
  try { byLicense = JSON.parse(raw) }
  catch { console.error('license-gate: unparseable output'); process.exit(1) }
}

if (typeof byLicense !== 'object' || byLicense === null || Array.isArray(byLicense)) {
  console.error('license-gate: malformed report'); process.exit(1)
}
const entries = []
const packageRoots = new Map()
for (const [license, packages] of Object.entries(byLicense)) {
  if (!Array.isArray(packages) || packages.length === 0) { console.error('license-gate: malformed package list'); process.exit(1) }
  for (const pkg of packages) {
    if (typeof pkg !== 'object' || pkg === null || typeof pkg.name !== 'string' ||
        !Array.isArray(pkg.versions) || !pkg.versions.every((version) => typeof version === 'string') ||
        !Array.isArray(pkg.paths) || !pkg.paths.every((path) => typeof path === 'string' || path === null)) {
      console.error('license-gate: malformed package entry'); process.exit(1)
    }
    entries.push({ name: pkg.name, versions: [...pkg.versions].sort(), license })
    if (DIRECT_EDITOR.includes(pkg.name)) packageRoots.set(pkg.name, pkg.paths.filter((path) => typeof path === 'string'))
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license))
const allow = mode === 'prod' ? PROD_ALLOW : FULL_ALLOW
for (const entry of entries) {
  if (entry.name.startsWith('@blocknote/xl-') || DENY_SUBSTR.some((token) => entry.license.toUpperCase().includes(token)) || !allow.has(entry.license)) {
    console.error(`license-gate: rejected ${entry.name} (${entry.license})`); process.exit(1)
  }
}
const noticeEvidence = []
for (const name of DIRECT_EDITOR) {
  const roots = packageRoots.get(name)
  if (!roots) { console.error(`license-gate: direct editor package missing: ${name}`); process.exit(1) }
  const evidence = roots.flatMap((root) => walkRegularFiles(root)
    .filter((path) => /^(LICENSE|NOTICE)/i.test(basename(path)))
    .map((path) => ({ package: name, status: 'file', path: `${name}/${relative(root, path)}`, sha256: createHash('sha256').update(readTextBounded(path)).digest('hex') })))
  if (evidence.length === 0) {
    const declared = new Set(roots.map((root) => {
      const manifest = readJsonBounded(join(root, 'package.json'))
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest) || !('license' in manifest) || typeof manifest.license !== 'string') {
        console.error(`license-gate: declared license missing: ${name}`); process.exit(1)
      }
      return manifest.license
    }))
    if (declared.size !== 1) { console.error(`license-gate: inconsistent declared license: ${name}`); process.exit(1) }
    noticeEvidence.push({ package: name, status: 'declared_only', declaredLicense: [...declared][0] })
  }
  for (const item of evidence) {
    if (!noticeEvidence.some((seen) => seen.package === item.package && seen.path === item.path && seen.sha256 === item.sha256)) noticeEvidence.push(item)
  }
}
noticeEvidence.sort((a, b) => a.package.localeCompare(b.package) || (a.path ?? a.declaredLicense).localeCompare(b.path ?? b.declaredLicense))
console.log(JSON.stringify({ entries, prodHasCopyleft: mode === 'prod' && entries.some((entry) => COPYLEFT.has(entry.license)), noticeEvidence }))
