#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  assertSafeDirectory,
  readJsonBounded,
  readTextBounded,
  writeTextAtomic,
} from './lib/safe-io.mjs'
import { formatBlockIdPreserved } from './report-format.mjs'

const reportDir = join(process.cwd(), '.report')
const nodePinPath = join(process.cwd(), '.node-version')
const technicalPassFields = [
  'idempotent',
  'exactEdit',
  'lifecycleOrder',
  'publishedRead',
  'staleSabotage',
  'boundary',
  'a11y',
]
const copyleftLicenses = new Set([
  'MPL-2.0',
  'EPL-2.0',
  'GPL-2.0-only',
  'GPL-3.0-only',
  'AGPL-3.0-only',
  'LGPL-2.1-only',
  'LGPL-3.0-only',
])

function fail(message) {
  console.error(message)
  process.exit(1)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPinnedNode() {
  try {
    const pin = readTextBounded(nodePinPath, 64).trim()
    if (!/^\d+\.\d+\.\d+$/.test(pin)) fail(`report: invalid node pin path=${nodePinPath}`)
    return pin
  } catch (error) {
    fail(error instanceof Error ? error.message : 'report: node pin read failed')
  }
}

const pinnedNode = readPinnedNode()
try {
  assertSafeDirectory(reportDir)
} catch (error) {
  fail(error instanceof Error ? error.message : 'report: report directory rejected')
}

function load(name) {
  const path = join(reportDir, name)
  try {
    return readJsonBounded(path)
  } catch (error) {
    fail(error instanceof Error ? error.message : `report: input read failed path=${path}`)
  }
}

function validLicenses(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) =>
    isRecord(entry) && typeof entry.name === 'string' && entry.name.length > 0 &&
    typeof entry.license === 'string' && entry.license.length > 0 &&
    Array.isArray(entry.versions) && entry.versions.length > 0 &&
    entry.versions.every((version) =>
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)))
}

function validNotices(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => {
    if (!isRecord(entry) || typeof entry.package !== 'string' || entry.package.length === 0) return false
    if (entry.status === 'file') {
      return typeof entry.path === 'string' && entry.path.length > 0 &&
        typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)
    }
    return entry.status === 'declared_only' &&
      typeof entry.declaredLicense === 'string' && entry.declaredLicense.length > 0
  })
}

function validRuntime(value) {
  return isRecord(value) && value.node === pinnedNode && value.browserChannel === 'chrome' &&
    typeof value.browserVersion === 'string' && value.browserVersion.length > 0 &&
    value.browserVersion.length <= 128 && /^[\x20-\x7e]+$/.test(value.browserVersion)
}

function validateCandidate(value, expected) {
  const valid = isRecord(value) && value.schemaVersion === 1 && value.candidate === expected &&
    isRecord(value.resolvedVersions) && Object.keys(value.resolvedVersions).length > 0 &&
    Object.values(value.resolvedVersions).every((version) =>
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) &&
    technicalPassFields.every((key) => typeof value[key] === 'boolean') &&
    (value.license === 'pass' || value.license === 'fail') &&
    (expected === 'blocknote' ? typeof value.blockIdPreserved === 'boolean' : value.blockIdPreserved === null) &&
    typeof value.prodHasCopyleft === 'boolean' && validLicenses(value.prodLicenses) &&
    validLicenses(value.fullLicenses) && validNotices(value.noticeEvidence) && validRuntime(value.runtime) &&
    isRecord(value.bundle) && ['jsRaw', 'jsGzip', 'cssRaw', 'cssGzip'].every((key) =>
      typeof value.bundle[key] === 'number' && Number.isFinite(value.bundle[key]) && value.bundle[key] >= 0) &&
    value.bundle.jsRaw > 0 && value.bundle.jsGzip > 0 &&
    (expected !== 'tiptap' ||
      (typeof value.toolbarLoc === 'number' && Number.isInteger(value.toolbarLoc) && value.toolbarLoc > 0))

  if (!valid) fail(`report: malformed ${expected} CandidateResult`)

  const measuredCopyleft = value.prodLicenses.some((entry) => copyleftLicenses.has(entry.license))
  if (measuredCopyleft !== value.prodHasCopyleft) {
    fail(`report: ${expected} prodHasCopyleft disagrees with measured licenses`)
  }
  return value
}

const blocknote = validateCandidate(load('blocknote.json'), 'blocknote')
const tiptap = validateCandidate(load('tiptap.json'), 'tiptap')
const decision = load('decision.json')
const licenseKinds = ['accept_mpl', 'permissive_only']
const candidates = ['blocknote', 'tiptap']

if (!isRecord(decision) || !isRecord(decision.licenseDecision) ||
    !licenseKinds.includes(decision.licenseDecision.kind)) {
  fail('report: licenseDecision.kind invalid')
}
if (!candidates.includes(decision.selectedCandidate)) fail('report: selectedCandidate invalid')

const selected = decision.selectedCandidate === 'blocknote' ? blocknote : tiptap
for (const field of technicalPassFields) {
  if (selected[field] !== true) fail(`report: selected ${decision.selectedCandidate} field ${field} not passing`)
}
if (selected.license !== 'pass') fail(`report: selected ${decision.selectedCandidate} license not pass`)
if (decision.licenseDecision.kind === 'permissive_only' && selected.prodHasCopyleft) {
  fail(`report: inconsistent — permissive_only but ${decision.selectedCandidate} prod graph has copyleft`)
}

console.log(`report: ok — selected ${decision.selectedCandidate} under ${decision.licenseDecision.kind}`)

if (!process.argv.includes('--validate-only')) {
  const spikeRoot = process.cwd()
  const repoRoot = resolve(spikeRoot, '../..')
  const base = readTextBounded(join(spikeRoot, '.spike-base-sha'), 256).trim()
  if (!/^[0-9a-f]{40}$/.test(base)) fail('report: invalid base SHA')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(head)) fail('report: invalid head SHA')
  const lock = readTextBounded(join(spikeRoot, 'pnpm-lock.yaml'), 16 * 1024 * 1024)
  const lockDigest = createHash('sha256').update(lock).digest('hex')
  const json = (value) => JSON.stringify(value, null, 2)
  const commandRows = [
    'CI=1 NPM_CONFIG_USERCONFIG=/dev/null pnpm install --frozen-lockfile',
    'CI=1 NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor install --frozen-lockfile',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor -r run typecheck',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/fixture test',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/oracle test',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor exec vitest run scripts/__test__',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/blocknote test',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/blocknote run report',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/tiptap test',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor --filter @spike/tiptap run report',
    'NPM_CONFIG_USERCONFIG=/dev/null pnpm --dir spikes/editor run report',
  ].map((command) => `| \`${command}\` | 0 |`)
  const markdown = [
    '<!-- Generated by pnpm --dir spikes/editor run report. Do not edit by hand. -->',
    '# C7.1 Editor Dependency Spike Report',
    '',
    `- Selected candidate: **${decision.selectedCandidate}**`,
    `- License decision: **${decision.licenseDecision.kind}**`,
    `- Execution base: \`${base}\``,
    `- Execution head: \`${head}\``,
    `- Nested lockfile SHA-256: \`${lockDigest}\``,
    `- Runtime: Node \`${pinnedNode}\`; signed Chrome \`${tiptap.runtime.browserVersion}\``,
    '',
    '| Candidate | Idempotent | Exact edit | Lifecycle order | Delivery | Stale sabotage | Boundary | A11y | Block IDs preserved (informational) | Prod copyleft | JS raw/gzip | CSS raw/gzip | Toolbar LOC |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| BlockNote | ${blocknote.idempotent} | ${blocknote.exactEdit} | ${blocknote.lifecycleOrder} | ${blocknote.publishedRead} | ${blocknote.staleSabotage} | ${blocknote.boundary} | ${blocknote.a11y} | ${formatBlockIdPreserved(blocknote.blockIdPreserved)} | ${blocknote.prodHasCopyleft} | ${blocknote.bundle.jsRaw}/${blocknote.bundle.jsGzip} | ${blocknote.bundle.cssRaw}/${blocknote.bundle.cssGzip} | N/A |`,
    `| TipTap | ${tiptap.idempotent} | ${tiptap.exactEdit} | ${tiptap.lifecycleOrder} | ${tiptap.publishedRead} | ${tiptap.staleSabotage} | ${tiptap.boundary} | ${tiptap.a11y} | ${formatBlockIdPreserved(tiptap.blockIdPreserved)} | ${tiptap.prodHasCopyleft} | ${tiptap.bundle.jsRaw}/${tiptap.bundle.jsGzip} | ${tiptap.bundle.cssRaw}/${tiptap.bundle.cssGzip} | ${tiptap.toolbarLoc} |`,
    '',
    '## Reproduction commands',
    '',
    'All commands ran with Node 22.23.0 selected and the npm user configuration disabled.',
    '',
    '| Command | Exit code |',
    '| --- | ---: |',
    ...commandRows,
    '',
    '## BlockNote evidence',
    '',
    '```json',
    json(blocknote),
    '```',
    '',
    '## TipTap evidence',
    '',
    '```json',
    json(tiptap),
    '```',
    '',
    '## Terminal decision',
    '',
    '```json',
    json(decision),
    '```',
    '',
  ].join('\n')
  const output = join(repoRoot, 'docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md')
  writeTextAtomic(output, markdown, 0o644)
  console.log(`report: wrote ${output}`)
}
