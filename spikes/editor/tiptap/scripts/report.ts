import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CandidateResult, LicenseEntry, NoticeEvidence, RuntimeEvidence } from '@spike/fixture'
import {
  assertSafeDirectory,
  readJsonBounded,
  readTextBounded,
  walkRegularFiles,
  writeJsonAtomic,
} from '../../scripts/lib/safe-io.mjs'
import { physicalLineCount } from './report-lib.ts'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const candidateDir = join(workspace, 'tiptap')
const nodePinPath = join(workspace, '.node-version')
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function bundle(dir: string) {
  let jsRaw = 0
  let cssRaw = 0
  let jsGzip = 0
  let cssGzip = 0
  for (const path of walkRegularFiles(dir)) {
    if (path.endsWith('.js')) {
      const bytes = Buffer.from(readTextBounded(path))
      jsRaw += bytes.length
      jsGzip += gzipSync(bytes).length
    }
    if (path.endsWith('.css')) {
      const bytes = Buffer.from(readTextBounded(path))
      cssRaw += bytes.length
      cssGzip += gzipSync(bytes).length
    }
  }
  if (jsRaw === 0 || jsGzip === 0) throw new Error('report: bundle JS measurement missing')
  return { jsRaw, cssRaw, jsGzip, cssGzip }
}

function reqBool(value: unknown, key: string): boolean {
  if (!isRecord(value) || typeof value[key] !== 'boolean') throw new Error(`report: ${key} missing`)
  return value[key]
}

function reqNullableBool(value: unknown, key: string): boolean | null {
  if (!isRecord(value) || (typeof value[key] !== 'boolean' && value[key] !== null)) {
    throw new Error(`report: ${key} missing`)
  }
  return value[key]
}

function licenseEvidence(raw: string): {
  entries: LicenseEntry[]
  prodHasCopyleft: boolean
  noticeEvidence: NoticeEvidence[]
} {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('report: malformed license JSON')
  }
  if (!isRecord(value) || typeof value.prodHasCopyleft !== 'boolean' ||
      !Array.isArray(value.entries) || value.entries.length === 0 ||
      !Array.isArray(value.noticeEvidence) || value.noticeEvidence.length === 0) {
    throw new Error('report: malformed license evidence')
  }
  const entries: LicenseEntry[] = value.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.license !== 'string' ||
        !Array.isArray(entry.versions) || !entry.versions.every((version) => typeof version === 'string')) {
      throw new Error('report: malformed license entry')
    }
    return { name: entry.name, license: entry.license, versions: entry.versions }
  })
  const noticeEvidence = value.noticeEvidence.map<NoticeEvidence>((entry) => {
    if (!isRecord(entry) || typeof entry.package !== 'string') {
      throw new Error('report: malformed notice evidence')
    }
    if (entry.status === 'file' && typeof entry.path === 'string' &&
        typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) {
      return { package: entry.package, status: 'file', path: entry.path, sha256: entry.sha256 }
    }
    if (entry.status === 'declared_only' && typeof entry.declaredLicense === 'string') {
      return { package: entry.package, status: 'declared_only', declaredLicense: entry.declaredLicense }
    }
    throw new Error('report: malformed notice evidence')
  })
  return { entries, prodHasCopyleft: value.prodHasCopyleft, noticeEvidence }
}

function pinnedNodeVersion(): string {
  const pin = readTextBounded(nodePinPath, 64).trim()
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error(`report: invalid node pin path=${nodePinPath}`)
  return pin
}

function runtimeEvidence(value: unknown, pin: string): RuntimeEvidence {
  if (!isRecord(value) || !isRecord(value.runtime) || value.runtime.node !== pin ||
      value.runtime.browserChannel !== 'chrome' ||
      typeof value.runtime.browserVersion !== 'string' || value.runtime.browserVersion.length === 0 ||
      value.runtime.browserVersion.length > 128 || !/^[\x20-\x7e]+$/.test(value.runtime.browserVersion)) {
    throw new Error('report: malformed runtime evidence')
  }
  return {
    node: value.runtime.node,
    browserChannel: value.runtime.browserChannel,
    browserVersion: value.runtime.browserVersion,
  }
}

function mergeNoticeEvidence(...groups: NoticeEvidence[][]): NoticeEvidence[] {
  const notices = new Map<string, NoticeEvidence>()
  for (const item of groups.flat()) {
    const key = item.status === 'file'
      ? `${item.package}\0file\0${item.path}\0${item.sha256}`
      : `${item.package}\0declared_only\0${item.declaredLicense}`
    notices.set(key, item)
  }
  return [...notices.values()].sort((left, right) =>
    left.package.localeCompare(right.package) || JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function resolvedVersions(): Record<string, string> {
  const pkg = readJsonBounded(join(candidateDir, 'package.json'))
  if (!isRecord(pkg) || !isRecord(pkg.dependencies)) throw new Error('report: malformed package.json')
  const dependencies = pkg.dependencies
  const names = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
  return Object.fromEntries(names.map((name) => {
    const version = dependencies[name]
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`report: non-exact dependency ${name}`)
    }
    return [name, version]
  }))
}

execFileSync('pnpm', ['--filter', '@spike/tiptap', 'build'], { cwd: workspace, stdio: 'inherit' })
const candidateReportDir = join(candidateDir, '.report')
assertSafeDirectory(candidateReportDir)
const life = readJsonBounded(join(candidateReportDir, 'tiptap.lifecycle.json'))
const a11yJson = readJsonBounded(join(candidateReportDir, 'tiptap.a11y.json'))
const boundaryJson = readJsonBounded(join(candidateReportDir, 'tiptap.boundary.json'))
const prod = licenseEvidence(execFileSync(
  'node',
  ['scripts/license-gate.mjs', 'tiptap', 'prod', 'tiptap'],
  { cwd: workspace, encoding: 'utf8' },
))
const full = licenseEvidence(execFileSync(
  'node',
  ['scripts/license-gate.mjs', 'tiptap', 'full', 'tiptap'],
  { cwd: workspace, encoding: 'utf8' },
))
const toolbarLoc = physicalLineCount(readTextBounded(join(candidateDir, 'src/toolbar.tsx')))

const result: CandidateResult = {
  schemaVersion: 1,
  candidate: 'tiptap',
  resolvedVersions: resolvedVersions(),
  idempotent: reqBool(life, 'idempotent'),
  exactEdit: reqBool(life, 'exactEdit'),
  lifecycleOrder: reqBool(life, 'lifecycleOrder'),
  publishedRead: reqBool(life, 'publishedRead'),
  staleSabotage: reqBool(life, 'staleSabotage'),
  blockIdPreserved: reqNullableBool(life, 'blockIdPreserved'),
  boundary: reqBool(boundaryJson, 'boundary'),
  a11y: reqBool(a11yJson, 'a11y'),
  license: 'pass',
  prodHasCopyleft: prod.prodHasCopyleft,
  prodLicenses: prod.entries,
  fullLicenses: full.entries,
  noticeEvidence: mergeNoticeEvidence(prod.noticeEvidence, full.noticeEvidence),
  runtime: runtimeEvidence(a11yJson, pinnedNodeVersion()),
  bundle: bundle(join(candidateDir, 'dist')),
  toolbarLoc,
}

mkdirSync(join(workspace, '.report'), { recursive: true })
writeJsonAtomic(join(workspace, '.report/tiptap.json'), result)
console.log('wrote .report/tiptap.json')
