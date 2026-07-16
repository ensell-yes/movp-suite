#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeDirectory, readJsonBounded, readTextBounded, walkRegularFiles, writeJsonAtomic } from './lib/safe-io.mjs'

const pkgDir = process.argv[2]
const mode = process.argv[3] ?? 'prod'
const candidate = process.argv[4]
const inputAt = process.argv.indexOf('--input')
const inputFile = inputAt >= 0 ? process.argv[inputAt + 1] : undefined
const graphAt = process.argv.indexOf('--graph-input')
const graphFile = graphAt >= 0 ? process.argv[graphAt + 1] : undefined
const graphCompareAt = process.argv.indexOf('--graph-compare')
const graphCompareFile = graphCompareAt >= 0 ? process.argv[graphCompareAt + 1] : undefined
const auditAt = process.argv.indexOf('--audit-output')
const auditOutput = auditAt >= 0 ? process.argv[auditAt + 1] : undefined
if (!pkgDir || !['prod', 'full'].includes(mode) || !['blocknote', 'tiptap'].includes(candidate) ||
    (inputAt >= 0 && !inputFile) || (graphAt >= 0 && !graphFile) ||
    (graphCompareAt >= 0 && !graphCompareFile) || (graphCompareFile && !graphFile) ||
    (auditAt >= 0 && !auditOutput)) {
  console.error('license-gate:E_USAGE')
  process.exit(2)
}

const PROD_ALLOW = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0', 'Python-2.0', '(MIT OR CC0-1.0)'])
const FULL_ALLOW = new Set([...PROD_ALLOW, 'CC0-1.0', 'CC-BY-4.0', 'Unlicense'])
const ATTRIBUTION_LICENSES = new Set(['CC-BY-4.0'])
const COPYLEFT = new Set(['MPL-2.0', 'EPL-2.0', 'GPL-2.0-only', 'GPL-3.0-only', 'AGPL-3.0-only', 'LGPL-2.1-only', 'LGPL-3.0-only'])
const DENY_SUBSTR = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'UNLICENSED', 'PROPRIETARY']
const DIRECT_EDITOR = candidate === 'blocknote'
  ? ['@blocknote/core', '@blocknote/react', '@blocknote/mantine', '@mantine/core', '@mantine/hooks']
  : ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
const WORKSPACE = fileURLToPath(new URL('../', import.meta.url))
const FILTER = candidate === 'blocknote' ? '@spike/blocknote' : '@spike/tiptap'
const reportPath = inputFile ?? graphFile ?? pkgDir
const fail = (code, path = reportPath, count) => {
  console.error(`license-gate:${code} path=${path}${count === undefined ? '' : ` count=${count}`}`)
  process.exit(1)
}
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const rejected = (name, license, allow) => name.startsWith('@blocknote/xl-') ||
  DENY_SUBSTR.some((token) => license.toUpperCase().includes(token)) || !allow.has(license)

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isMissing = (error) => isRecord(error) && error.code === 'ENOENT'
const escapes = (root, target) => {
  const rel = relative(resolve(root), resolve(target))
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}
const graphToLicenseEvidence = (value) => {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) fail('E_GRAPH_SHAPE')
  const roots = [resolve(pkgDir), resolve(WORKSPACE, 'node_modules')]
  const seen = new Set()
  const manifests = new Map()
  const grouped = new Map()
  const optionalAbsent = new Set()
  const visit = (dependencies, explicitOptional = false, optionalNames = new Set()) => {
    if (!isRecord(dependencies)) return
    for (const [expectedName, node] of Object.entries(dependencies)) {
      if (!isRecord(node) || typeof node.version !== 'string') fail('E_GRAPH_NODE')
      const edgeOptional = explicitOptional || optionalNames.has(expectedName)
      let manifest
      if (typeof node.resolved === 'string') {
        if (typeof node.path !== 'string' || !roots.some((root) => !escapes(root, node.path))) fail('E_GRAPH_PATH')
        const packagePath = resolve(node.path)
        if (seen.has(packagePath)) {
          manifest = manifests.get(packagePath)
        } else {
          try { assertSafeDirectory(packagePath) } catch (error) {
            if (edgeOptional && isMissing(error)) {
              optionalAbsent.add(`${expectedName}\0${node.version}`)
              continue
            }
            fail('E_GRAPH_ROOT', packagePath)
          }
          const manifestPath = join(packagePath, 'package.json')
          try { manifest = readJsonBounded(manifestPath) } catch { fail('E_GRAPH_MANIFEST', manifestPath) }
          if (!isRecord(manifest) || manifest.name !== expectedName || manifest.version !== node.version ||
              typeof manifest.license !== 'string' || manifest.license.trim().length === 0) fail('E_GRAPH_MANIFEST_SHAPE', manifestPath)
          seen.add(packagePath)
          manifests.set(packagePath, manifest)
          const license = manifest.license
          const byName = grouped.get(license) ?? new Map()
          const prior = byName.get(expectedName) ?? { name: expectedName, versions: new Set(), paths: new Set() }
          prior.versions.add(node.version)
          prior.paths.add(packagePath)
          byName.set(expectedName, prior)
          grouped.set(license, byName)
        }
      } else if (typeof node.path === 'string' && !escapes(WORKSPACE, node.path)) {
        const packagePath = resolve(node.path)
        try { assertSafeDirectory(packagePath) } catch { fail('E_GRAPH_WORKSPACE_ROOT', packagePath) }
        const manifestPath = join(packagePath, 'package.json')
        try { manifest = readJsonBounded(manifestPath) } catch { fail('E_GRAPH_WORKSPACE_MANIFEST', manifestPath) }
        if (!isRecord(manifest) || manifest.name !== expectedName) fail('E_GRAPH_WORKSPACE_MANIFEST_SHAPE', manifestPath)
      }
      const manifestOptionalNames = isRecord(manifest?.optionalDependencies)
        ? new Set(Object.keys(manifest.optionalDependencies))
        : new Set()
      visit(node.dependencies, false, manifestOptionalNames)
      visit(node.optionalDependencies, true, manifestOptionalNames)
    }
  }
  visit(value[0].dependencies)
  visit(value[0].devDependencies)
  return {
    report: Object.fromEntries([...grouped].map(([license, byName]) => [license, [...byName.values()].map((entry) => ({
      name: entry.name, versions: [...entry.versions].sort(), paths: [...entry.paths].sort(),
    }))])),
    optionalAbsent,
  }
}

const missingIndexFailure = (error) => {
  if (!isRecord(error) || typeof error.stdout !== 'string') return false
  let value
  try { value = JSON.parse(error.stdout) } catch { return false }
  return isRecord(value) && isRecord(value.error) && value.error.code === 'ERR_PNPM_MISSING_PACKAGE_INDEX_FILE'
}
const graphEvidenceKey = (evidence) => JSON.stringify({
  report: Object.entries(evidence.report)
    .flatMap(([license, packages]) => packages.map((pkg) => ({ license, ...pkg })))
    .sort((a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license) ||
      a.versions.join(',').localeCompare(b.versions.join(','))),
  optionalAbsent: [...evidence.optionalAbsent].sort(),
})

const packageVersions = (report, code) => {
  if (!isRecord(report)) fail(code)
  const found = new Map()
  for (const [license, packages] of Object.entries(report)) {
    if (!nonEmpty(license) || !Array.isArray(packages) || packages.length === 0) fail('E_PACKAGE_LIST')
    for (const pkg of packages) {
      if (!isRecord(pkg) || !nonEmpty(pkg.name) || !Array.isArray(pkg.versions) || pkg.versions.length === 0 ||
          !pkg.versions.every(nonEmpty) || !Array.isArray(pkg.paths) || pkg.paths.length === 0 ||
          !pkg.paths.every((path) => path === null || nonEmpty(path))) fail('E_PACKAGE_ENTRY')
      for (const version of pkg.versions) {
        const key = `${pkg.name}\0${version}`
        const prior = found.get(key)
        if (prior && prior.license !== license) fail('E_REPORT_CONFLICT')
        found.set(key, { name: pkg.name, version, license, paths: pkg.paths })
      }
    }
  }
  return found
}

const mergeMeasuredReports = (base, graphEvidence) => {
  const basePackages = packageVersions(base, 'E_REPORT_SHAPE')
  const graphPackages = packageVersions(graphEvidence.report, 'E_GRAPH_SHAPE')
  for (const [key, pkg] of basePackages) {
    const measured = graphPackages.get(key)
    if (measured && measured.license !== pkg.license) fail('E_GRAPH_LICENSE_CONFLICT')
    if (!measured && !graphEvidence.optionalAbsent.has(key)) fail('E_GRAPH_DESCENDANT_MISSING')
  }
  const grouped = new Map()
  for (const pkg of graphPackages.values()) {
    const byName = grouped.get(pkg.license) ?? new Map()
    const prior = byName.get(pkg.name) ?? { name: pkg.name, versions: new Set(), paths: new Set() }
    prior.versions.add(pkg.version)
    for (const path of pkg.paths) if (typeof path === 'string') prior.paths.add(path)
    byName.set(pkg.name, prior)
    grouped.set(pkg.license, byName)
  }
  return Object.fromEntries([...grouped].map(([license, byName]) => [license, [...byName.values()].map((entry) => ({
    name: entry.name, versions: [...entry.versions].sort(), paths: [...entry.paths].sort(),
  }))]))
}

let byLicense
if (inputFile) {
  try { byLicense = readJsonBounded(inputFile) }
  catch { fail('E_INPUT_READ', inputFile) }
}
if (graphFile) {
  let graph
  try { graph = readJsonBounded(graphFile) } catch { fail('E_GRAPH_READ', graphFile) }
  const graphEvidence = graphToLicenseEvidence(graph)
  if (graphCompareFile) {
    let graphCompare
    try { graphCompare = readJsonBounded(graphCompareFile) } catch { fail('E_GRAPH_COMPARE_READ', graphCompareFile) }
    if (graphEvidenceKey(graphEvidence) !== graphEvidenceKey(graphToLicenseEvidence(graphCompare))) fail('E_PNPM_GRAPH_UNSTABLE')
  }
  byLicense = byLicense === undefined ? graphEvidence.report : mergeMeasuredReports(byLicense, graphEvidence)
} else if (!inputFile) {
  let raw
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--long', '--json', ...(mode === 'prod' ? ['--prod'] : []), '--filter', FILTER], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    })
  } catch (error) { if (!missingIndexFailure(error)) fail('E_PNPM', pkgDir) }
  let base
  if (raw !== undefined) {
    try { base = JSON.parse(raw) } catch { fail('E_PNPM_JSON', pkgDir) }
  }
  const measure = (depth) => {
    let graphRaw
    try {
      graphRaw = execFileSync('pnpm', ['list', '--json', '--depth', depth, ...(mode === 'prod' ? ['--prod'] : []), '--filter', FILTER], {
        cwd: WORKSPACE,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch { fail('E_PNPM_GRAPH', pkgDir) }
    let graph
    try { graph = JSON.parse(graphRaw) } catch { fail('E_PNPM_GRAPH_JSON', pkgDir) }
    return graphToLicenseEvidence(graph)
  }
  const depth8 = measure('8')
  const depth10 = measure('10')
  if (graphEvidenceKey(depth8) !== graphEvidenceKey(depth10)) fail('E_PNPM_GRAPH_UNSTABLE', pkgDir)
  byLicense = base === undefined ? depth10.report : mergeMeasuredReports(base, depth10)
}

if (typeof byLicense !== 'object' || byLicense === null || Array.isArray(byLicense)) {
  fail('E_REPORT_SHAPE')
}
const entries = []
const directReports = []
const packageReports = []
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
    packageReports.push({ name: pkg.name, versions: [...pkg.versions], license, roots: pkg.paths.filter(nonEmpty) })
    if (DIRECT_EDITOR.includes(pkg.name)) {
      directReports.push({ name: pkg.name, versions: [...pkg.versions], license, roots: pkg.paths.filter(nonEmpty) })
    }
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license))
const allow = mode === 'prod' ? PROD_ALLOW : FULL_ALLOW
const rejectedEntries = entries.filter((entry) => rejected(entry.name, entry.license, allow))
if (auditOutput) writeJsonAtomic(auditOutput, { entries, rejectedEntries })
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
if (mode === 'full') {
  for (const report of packageReports.filter((item) => ATTRIBUTION_LICENSES.has(item.license))) {
    if (report.roots.length === 0) fail('E_ATTRIBUTION_PATHS', reportPath)
    let evidence = []
    for (const root of report.roots) {
      try { assertSafeDirectory(root) } catch { fail('E_ATTRIBUTION_ROOT', root) }
      const manifestPath = join(root, 'package.json')
      let manifest
      try { manifest = readJsonBounded(manifestPath) } catch { fail('E_ATTRIBUTION_MANIFEST', manifestPath) }
      if (!isRecord(manifest) || manifest.name !== report.name ||
          typeof manifest.version !== 'string' || !report.versions.includes(manifest.version) ||
          manifest.license !== report.license) fail('E_ATTRIBUTION_MANIFEST_SHAPE', manifestPath)
      try {
        evidence = evidence.concat(walkRegularFiles(root)
          .filter((path) => /^(LICENSE|NOTICE)/i.test(basename(path)))
          .map((path) => ({
            package: report.name,
            status: 'file',
            path: `${report.name}/${relative(root, path)}`,
            sha256: createHash('sha256').update(readTextBounded(path)).digest('hex'),
          })))
      } catch { fail('E_ATTRIBUTION_IO', root) }
    }
    if (evidence.length === 0) fail('E_ATTRIBUTION_NOTICE', reportPath)
    for (const item of evidence) {
      if (!noticeEvidence.some((seen) => seen.package === item.package && seen.path === item.path && seen.sha256 === item.sha256)) noticeEvidence.push(item)
    }
  }
}
noticeEvidence.sort((a, b) => a.package.localeCompare(b.package) || (a.path ?? a.declaredLicense).localeCompare(b.path ?? b.declaredLicense))
console.log(JSON.stringify({ entries, prodHasCopyleft: mode === 'prod' && entries.some((entry) => COPYLEFT.has(entry.license)), noticeEvidence }))
