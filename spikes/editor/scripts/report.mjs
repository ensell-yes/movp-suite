#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSafeDirectory,
  readJsonBounded,
  readTextBounded,
  writeTextAtomic,
} from './lib/safe-io.mjs'
import { computeContentDigest, formatBlockIdPreserved } from './report-format.mjs'
import { EXPECTED_COMMANDS } from './run-contract.mjs'

const spikeRoot = process.cwd()
const repoRoot = resolve(spikeRoot, '../..')
const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const evidenceDir = join(spikeRoot, 'evidence')
const nodePinPath = join(spikeRoot, '.node-version')
const bootstrap = process.argv.includes('--bootstrap')
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
const candidateSourcePaths = [
  'spikes/editor/blocknote',
  'spikes/editor/tiptap',
  'spikes/editor/fixture',
  'spikes/editor/oracle',
  'spikes/editor/scripts/license-gate.mjs',
  'spikes/editor/scripts/module-graph-gate.mjs',
  'spikes/editor/scripts/runtime-preflight.mjs',
  'spikes/editor/scripts/source-boundary.mjs',
  'spikes/editor/vite-module-ids-plugin.mjs',
  'spikes/editor/pnpm-lock.yaml',
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function load(name) {
  const path = join(evidenceDir, name)
  try {
    return readJsonBounded(path)
  } catch (error) {
    fail(error instanceof Error ? error.message : `report: input read failed path=${path}`)
  }
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

function validRuntime(value, pinnedNode) {
  return isRecord(value) && value.node === pinnedNode && value.browserChannel === 'chrome' &&
    typeof value.browserVersion === 'string' && value.browserVersion.length > 0 &&
    value.browserVersion.length <= 128 && /^[\x20-\x7e]+$/.test(value.browserVersion)
}

function validateCandidate(value, expected, pinnedNode) {
  const valid = isRecord(value) && value.schemaVersion === 1 && value.candidate === expected &&
    isRecord(value.resolvedVersions) && Object.keys(value.resolvedVersions).length > 0 &&
    Object.values(value.resolvedVersions).every((version) =>
      typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) &&
    technicalPassFields.every((key) => typeof value[key] === 'boolean') &&
    (value.license === 'pass' || value.license === 'fail') &&
    (expected === 'blocknote' ? typeof value.blockIdPreserved === 'boolean' : value.blockIdPreserved === null) &&
    typeof value.prodHasCopyleft === 'boolean' && validLicenses(value.prodLicenses) &&
    validLicenses(value.fullLicenses) && validNotices(value.noticeEvidence) && validRuntime(value.runtime, pinnedNode) &&
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

function validateRun(value, pinnedNode) {
  const expected = bootstrap ? EXPECTED_COMMANDS.slice(0, -1) : EXPECTED_COMMANDS
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.runtime) ||
      value.runtime.node !== pinnedNode || !Array.isArray(value.commands) ||
      value.commands.length !== expected.length) {
    fail('report: malformed or incomplete run evidence')
  }
  for (const [index, command] of expected.entries()) {
    const measured = value.commands[index]
    if (!isRecord(measured) || measured.id !== command.id || measured.command !== command.rendered ||
        measured.exitCode !== 0 || !Array.isArray(measured.outputSummary) ||
        measured.outputSummary.length === 0 || measured.outputSummary.length > 8 ||
        !measured.outputSummary.every((line) =>
          typeof line === 'string' && line.length > 0 && line.length <= 512 && /^[\x20-\x7e]+$/.test(line))) {
      fail(`report: invalid command evidence id=${command.id}`)
    }
  }
  return value
}

function validateDecision(value) {
  const kinds = ['accept_mpl', 'permissive_only']
  const candidates = ['blocknote', 'tiptap']
  if (!isRecord(value) || !isRecord(value.licenseDecision) ||
      !kinds.includes(value.licenseDecision.kind)) fail('report: licenseDecision.kind invalid')
  if (!candidates.includes(value.selectedCandidate)) fail('report: selectedCandidate invalid')
  return value
}

function candidateEvidenceSourceSha() {
  try {
    const value = execFileSync('git', ['log', '-1', '--format=%H', '--', ...candidateSourcePaths], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    if (!/^[0-9a-f]{40}$/.test(value)) fail('report: candidate evidence source commit unavailable')
    return value
  } catch {
    fail('report: candidate evidence source commit unavailable')
  }
}

function inputEntries() {
  return [
    { label: 'generator/clean-run-lib.mjs', path: join(scriptsRoot, 'clean-run-lib.mjs') },
    { label: 'generator/clean-run.mjs', path: join(scriptsRoot, 'clean-run.mjs') },
    { label: 'generator/report-format.mjs', path: join(scriptsRoot, 'report-format.mjs') },
    { label: 'generator/report.mjs', path: join(scriptsRoot, 'report.mjs') },
    { label: 'generator/run-contract.mjs', path: join(scriptsRoot, 'run-contract.mjs') },
    { label: 'generator/safe-io.mjs', path: join(scriptsRoot, 'lib/safe-io.mjs') },
    { label: 'input/.node-version', path: nodePinPath },
    { label: 'input/.spike-base-sha', path: join(spikeRoot, '.spike-base-sha') },
    { label: 'input/evidence/blocknote.json', path: join(evidenceDir, 'blocknote.json') },
    { label: 'input/evidence/decision.json', path: join(evidenceDir, 'decision.json') },
    { label: 'input/evidence/run.json', path: join(evidenceDir, 'run.json') },
    { label: 'input/evidence/tiptap.json', path: join(evidenceDir, 'tiptap.json') },
    { label: 'input/package.json', path: join(spikeRoot, 'package.json') },
    { label: 'input/pnpm-lock.yaml', path: join(spikeRoot, 'pnpm-lock.yaml') },
  ]
}

function escapeCell(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', '\\`')
}

function renderReport({ blocknote, tiptap, decision, run, pinnedNode, sourceSha, base, lockDigest, inputDigest }) {
  const json = (value) => JSON.stringify(value, null, 2)
  const commandRows = run.commands.map((command) =>
    `| \`${command.id}\` | ${command.outputSummary.map(escapeCell).map((line) => `\`${line}\``).join('<br>')} | ${command.exitCode} |`)
  return [
    '<!-- Generated by pnpm --dir spikes/editor run report. Do not edit by hand. -->',
    '# C7.1 Editor Dependency Spike Report',
    '',
    `- Selected candidate: **${decision.selectedCandidate}**`,
    `- License decision: **${decision.licenseDecision.kind}**`,
    `- Execution base: \`${base}\``,
    `- Candidate-evidence source commit: \`${sourceSha}\``,
    `- Report input SHA-256: \`${inputDigest}\``,
    `- Nested lockfile SHA-256: \`${lockDigest}\``,
    `- Runtime: Node \`${pinnedNode}\`; signed Chrome \`${tiptap.runtime.browserVersion}\``,
    '',
    '| Candidate | Idempotent | Exact edit | Lifecycle order | Delivery | Stale sabotage | Boundary | A11y | Block IDs preserved (informational) | Prod copyleft | JS raw/gzip | CSS raw/gzip | Toolbar LOC |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    `| BlockNote | ${blocknote.idempotent} | ${blocknote.exactEdit} | ${blocknote.lifecycleOrder} | ${blocknote.publishedRead} | ${blocknote.staleSabotage} | ${blocknote.boundary} | ${blocknote.a11y} | ${formatBlockIdPreserved(blocknote.blockIdPreserved)} | ${blocknote.prodHasCopyleft} | ${blocknote.bundle.jsRaw}/${blocknote.bundle.jsGzip} | ${blocknote.bundle.cssRaw}/${blocknote.bundle.cssGzip} | N/A |`,
    `| TipTap | ${tiptap.idempotent} | ${tiptap.exactEdit} | ${tiptap.lifecycleOrder} | ${tiptap.publishedRead} | ${tiptap.staleSabotage} | ${tiptap.boundary} | ${tiptap.a11y} | ${formatBlockIdPreserved(tiptap.blockIdPreserved)} | ${tiptap.prodHasCopyleft} | ${tiptap.bundle.jsRaw}/${tiptap.bundle.jsGzip} | ${tiptap.bundle.cssRaw}/${tiptap.bundle.cssGzip} | ${tiptap.toolbarLoc} |`,
    '',
    '## Measured clean-run commands',
    '',
    'The driver selected Node 22.23.0 and disabled the npm user configuration for every package-manager command.',
    '',
    '| Command ID | Stable actual output summary | Exit code |',
    '| --- | --- | ---: |',
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
    '## Clean-run evidence',
    '',
    '```json',
    json(run),
    '```',
    '',
  ].join('\n')
}

const pinnedNode = readPinnedNode()
try {
  assertSafeDirectory(evidenceDir)
} catch (error) {
  fail(error instanceof Error ? error.message : 'report: evidence directory rejected')
}
const blocknote = validateCandidate(load('blocknote.json'), 'blocknote', pinnedNode)
const tiptap = validateCandidate(load('tiptap.json'), 'tiptap', pinnedNode)
const decision = validateDecision(load('decision.json'))
const run = validateRun(load('run.json'), pinnedNode)
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
  const base = readTextBounded(join(spikeRoot, '.spike-base-sha'), 256).trim()
  if (!/^[0-9a-f]{40}$/.test(base)) fail('report: invalid base SHA')
  const sourceSha = candidateEvidenceSourceSha()
  const lock = readTextBounded(join(spikeRoot, 'pnpm-lock.yaml'), 16 * 1024 * 1024)
  const lockDigest = createHash('sha256').update(lock).digest('hex')
  const inputDigest = computeContentDigest(inputEntries())
  const markdown = renderReport({
    blocknote,
    tiptap,
    decision,
    run,
    pinnedNode,
    sourceSha,
    base,
    lockDigest,
    inputDigest,
  })
  const output = join(repoRoot, 'docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md')
  let existing = null
  try {
    existing = readTextBounded(output, 16 * 1024 * 1024)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      fail(error instanceof Error ? error.message : 'report: output read failed')
    }
  }
  if (process.argv.includes('--check')) {
    if (existing !== markdown) fail(`report: stale generated output path=${output}`)
    console.log(`report: fresh path=${output}`)
  } else if (existing === markdown) {
    console.log(`report: unchanged path=${output}`)
  } else {
    try {
      if (existing === null) assertSafeDirectory(dirname(output))
      else lstatSync(output)
      writeTextAtomic(output, markdown, 0o644)
      console.log(`report: wrote ${output}`)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'report: output write failed')
    }
  }
}
