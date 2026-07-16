#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { assertSafeDirectory, readJsonBounded, readTextBounded, walkRegularFiles } from './lib/safe-io.mjs'

const pkgDir = process.argv[2]
const mode = process.argv[3] ?? 'prod'
const candidate = process.argv[4]
const inputAt = process.argv.indexOf('--input')
const inputFile = inputAt >= 0 ? process.argv[inputAt + 1] : undefined
if (!pkgDir || !['prod', 'full'].includes(mode) || !['blocknote', 'tiptap'].includes(candidate) || (inputAt >= 0 && !inputFile)) {
  console.error('license-gate:E_USAGE')
  process.exit(2)
}

const PROD_ALLOW = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0'])
const FULL_ALLOW = new Set([...PROD_ALLOW, 'CC0-1.0', 'Unlicense'])
const COPYLEFT = new Set(['MPL-2.0', 'EPL-2.0', 'GPL-2.0-only', 'GPL-3.0-only', 'AGPL-3.0-only', 'LGPL-2.1-only', 'LGPL-3.0-only'])
const DENY_SUBSTR = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'UNLICENSED', 'PROPRIETARY']
const DIRECT_EDITOR = candidate === 'blocknote'
  ? ['@blocknote/core', '@blocknote/react', '@blocknote/mantine', '@mantine/core', '@mantine/hooks']
  : ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
const reportPath = inputFile ?? pkgDir
const fail = (code, path = reportPath, count) => {
  console.error(`license-gate:${code} path=${path}${count === undefined ? '' : ` count=${count}`}`)
  process.exit(1)
}
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const rejected = (name, license, allow) => name.startsWith('@blocknote/xl-') ||
  DENY_SUBSTR.some((token) => license.toUpperCase().includes(token)) || !allow.has(license)

let byLicense
if (inputFile) {
  try { byLicense = readJsonBounded(inputFile) }
  catch { fail('E_INPUT_READ', inputFile) }
} else {
  let raw
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--long', '--json', ...(mode === 'prod' ? ['--prod'] : [])], {
      cwd: pkgDir,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    })
  } catch { fail('E_PNPM', pkgDir) }
  try { byLicense = JSON.parse(raw) }
  catch { fail('E_PNPM_JSON', pkgDir) }
}

if (typeof byLicense !== 'object' || byLicense === null || Array.isArray(byLicense)) {
  fail('E_REPORT_SHAPE')
}
const entries = []
const directReports = []
for (const [license, packages] of Object.entries(byLicense)) {
  if (!nonEmpty(license) || !Array.isArray(packages) || packages.length === 0) fail('E_PACKAGE_LIST')
  for (const pkg of packages) {
    if (typeof pkg !== 'object' || pkg === null || !('name' in pkg) || !nonEmpty(pkg.name) ||
        !('versions' in pkg) || !Array.isArray(pkg.versions) || pkg.versions.length === 0 || !pkg.versions.every(nonEmpty) ||
        !('paths' in pkg) || !Array.isArray(pkg.paths) || pkg.paths.length === 0 ||
        !pkg.paths.every((path) => path === null || nonEmpty(path))) {
      fail('E_PACKAGE_ENTRY')
    }
    entries.push({ name: pkg.name, versions: [...pkg.versions].sort(), license })
    if (DIRECT_EDITOR.includes(pkg.name)) {
      directReports.push({ name: pkg.name, versions: [...pkg.versions], license, roots: pkg.paths.filter(nonEmpty) })
    }
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license))
const allow = mode === 'prod' ? PROD_ALLOW : FULL_ALLOW
const rejectedEntries = entries.filter((entry) => rejected(entry.name, entry.license, allow))
if (rejectedEntries.length > 0) fail('E_LICENSE_POLICY', reportPath, rejectedEntries.length)
const missingDirect = DIRECT_EDITOR.filter((name) => !directReports.some((report) => report.name === name))
if (missingDirect.length > 0) fail('E_DIRECT_MISSING', reportPath, missingDirect.length)

const validatedRoots = new Map(DIRECT_EDITOR.map((name) => [name, []]))
for (const report of directReports) {
  if (report.roots.length === 0) fail('E_DIRECT_PATHS')
  const pathVersions = new Set()
  for (const root of report.roots) {
    try { assertSafeDirectory(root) } catch { fail('E_MANIFEST_ROOT', root) }
    const manifestPath = join(root, 'package.json')
    let manifest
    try { manifest = readJsonBounded(manifestPath) } catch { fail('E_MANIFEST_READ', manifestPath) }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest) ||
        !('name' in manifest) || !nonEmpty(manifest.name) ||
        !('version' in manifest) || !nonEmpty(manifest.version) ||
        !('license' in manifest) || !nonEmpty(manifest.license)) {
      fail('E_MANIFEST_SHAPE', manifestPath)
    }
    if (rejected(manifest.name, manifest.license, allow)) fail('E_DECLARED_LICENSE_POLICY', manifestPath)
    if (manifest.name !== report.name) fail('E_MANIFEST_NAME', manifestPath)
    if (!report.versions.includes(manifest.version)) fail('E_MANIFEST_VERSION', manifestPath)
    if (manifest.license !== report.license) fail('E_MANIFEST_LICENSE', manifestPath)
    pathVersions.add(manifest.version)
    const roots = validatedRoots.get(report.name)
    if (!roots) fail('E_DIRECT_INTERNAL')
    if (!roots.some((item) => item.root === root)) roots.push({ root, declaredLicense: manifest.license })
  }
  const missingVersions = report.versions.filter((version) => !pathVersions.has(version))
  if (missingVersions.length > 0) fail('E_VERSION_PATH', reportPath, missingVersions.length)
}

const noticeEvidence = []
for (const name of DIRECT_EDITOR) {
  const roots = validatedRoots.get(name)
  if (!roots || roots.length === 0) fail('E_DIRECT_INTERNAL')
  let evidence
  try {
    evidence = roots.flatMap(({ root }) => walkRegularFiles(root)
      .filter((path) => /^(LICENSE|NOTICE)/i.test(basename(path)))
      .map((path) => ({ package: name, status: 'file', path: `${name}/${relative(root, path)}`, sha256: createHash('sha256').update(readTextBounded(path)).digest('hex') })))
  } catch { fail('E_NOTICE_IO', roots[0].root) }
  if (evidence.length === 0) {
    const declared = new Set(roots.map((item) => item.declaredLicense))
    if (declared.size !== 1) fail('E_DECLARED_INCONSISTENT', reportPath, declared.size)
    noticeEvidence.push({ package: name, status: 'declared_only', declaredLicense: [...declared][0] })
  }
  for (const item of evidence) {
    if (!noticeEvidence.some((seen) => seen.package === item.package && seen.path === item.path && seen.sha256 === item.sha256)) noticeEvidence.push(item)
  }
}
noticeEvidence.sort((a, b) => a.package.localeCompare(b.package) || (a.path ?? a.declaredLicense).localeCompare(b.path ?? b.declaredLicense))
console.log(JSON.stringify({ entries, prodHasCopyleft: mode === 'prod' && entries.some((entry) => COPYLEFT.has(entry.license)), noticeEvidence }))
