#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  assertSafeDirectory,
  readJsonBounded,
  readTextBounded,
  writeTextAtomic,
} from './lib/safe-io.mjs'
import {
  candidateSnapshotPath,
  writeDecisionTransient,
  writeRunTransient,
} from './clean-run-lib.mjs'
import { EXPECTED_COMMANDS } from './run-contract.mjs'

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_REMOVED_ENTRIES = 20_000
const spikeRoot = process.cwd()
const repoRoot = resolve(spikeRoot, '../..')
const transientRoot = join(spikeRoot, '.report')
const evidenceRoot = join(spikeRoot, 'evidence')
const decision = {
  licenseDecision: { kind: 'permissive_only' },
  selectedCandidate: 'tiptap',
}
let removedEntries = 0

function fail(message) {
  console.error(message)
  process.exit(1)
}

function removeTreeGuarded(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`clean-run:E_SYMLINK path=${path}`)
  if (stat.isFile()) {
    unlinkSync(path)
    removedEntries += 1
    return
  }
  if (!stat.isDirectory()) throw new Error(`clean-run:E_UNSUPPORTED_ENTRY path=${path}`)
  for (const name of readdirSync(path)) {
    removedEntries += 1
    if (removedEntries > MAX_REMOVED_ENTRIES) throw new Error(`clean-run:E_REMOVE_CAP path=${path}`)
    removeTreeGuarded(join(path, name))
  }
  rmdirSync(path)
}

function ensureDirectory(path, mode) {
  try {
    assertSafeDirectory(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      mkdirSync(path, { mode })
    } else {
      throw error
    }
  }
  chmodSync(path, mode)
}

function assertMode(path, expected) {
  const mode = lstatSync(path).mode & 0o777
  if (mode !== expected) throw new Error(`clean-run:E_MODE path=${path} mode=${mode.toString(8)}`)
}

function parseRuntime(output) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('{"node":')) continue
    try {
      const value = JSON.parse(line)
      if (typeof value === 'object' && value !== null &&
          value.node === '22.23.0' && value.browserChannel === 'chrome' &&
          typeof value.browserVersion === 'string' && /^[\x20-\x7e]{1,128}$/.test(value.browserVersion)) {
        return `runtime node=${value.node} channel=${value.browserChannel} browser=${value.browserVersion}`
      }
    } catch {
      return null
    }
  }
  return null
}

function requireMatch(output, pattern, summary) {
  if (!pattern.test(output)) throw new Error('clean-run:E_OUTPUT_CONTRACT')
  return summary
}

function summarize(id, output) {
  switch (id) {
    case 'root_install':
    case 'spike_install':
      return [requireMatch(output, /Lockfile is up to date, resolution step is skipped/u, 'lockfile frozen and up to date')]
    case 'typecheck': {
      for (const name of ['fixture', 'oracle', 'blocknote', 'tiptap']) {
        requireMatch(output, new RegExp(`${name} typecheck: Done`, 'u'), `typecheck ${name}=done`)
      }
      return ['typecheck blocknote=done fixture=done oracle=done tiptap=done']
    }
    case 'fixture_test':
      return [
        requireMatch(output, /Test Files\s+3 passed \(3\)/u, 'vitest files=3/3'),
        requireMatch(output, /Tests\s+13 passed \(13\)/u, 'vitest tests=13/13'),
      ]
    case 'oracle_test':
      return [
        requireMatch(output, /Test Files\s+1 passed \(1\)/u, 'vitest files=1/1'),
        requireMatch(output, /Tests\s+12 passed \(12\)/u, 'vitest tests=12/12'),
      ]
    case 'shared_tests':
      return [
        requireMatch(output, /Test Files\s+3 passed \(3\)/u, 'vitest files=3/3'),
        requireMatch(output, /Tests\s+61 passed \(61\)/u, 'vitest tests=61/61'),
      ]
    case 'blocknote_test': {
      const runtime = parseRuntime(output)
      if (runtime === null) throw new Error('clean-run:E_RUNTIME_OUTPUT')
      return [
        runtime,
        requireMatch(output, /Test Files\s+1 passed \(1\)/u, 'vitest files=1/1 tests=1/1'),
        requireMatch(output, /2 passed \([^\n]+\)/u, 'playwright passed=2'),
      ]
    }
    case 'tiptap_test': {
      const runtime = parseRuntime(output)
      if (runtime === null) throw new Error('clean-run:E_RUNTIME_OUTPUT')
      return [
        runtime,
        requireMatch(output, /Test Files\s+2 passed \(2\)/u, 'vitest files=2/2 tests=3/3'),
        requireMatch(output, /2 passed \([^\n]+\)/u, 'playwright passed=2'),
      ]
    }
    case 'blocknote_report':
    case 'tiptap_report': {
      const runtime = parseRuntime(output)
      if (runtime === null) throw new Error('clean-run:E_RUNTIME_OUTPUT')
      const candidate = id === 'blocknote_report' ? 'blocknote' : 'tiptap'
      return [runtime, requireMatch(output, new RegExp(`wrote \\.report/${candidate}\\.json`, 'u'), `candidate report=${candidate}`)]
    }
    case 'aggregate_report':
      return [
        requireMatch(output, /report: ok — selected tiptap under permissive_only/u, 'report selected=tiptap license=permissive_only'),
        requireMatch(output, /report: (?:wrote|unchanged) /u, 'report artifact=generated'),
      ]
    default:
      throw new Error(`clean-run:E_UNKNOWN_COMMAND id=${id}`)
  }
}

function writeTransientRun(commands) {
  const path = join(transientRoot, 'run.json')
  writeRunTransient(path, { schemaVersion: 1, runtime: { node: '22.23.0' }, commands })
  assertMode(path, 0o600)
}

function runCommand(spec, measured) {
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: '/dev/null' }
  env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`
  if (spec.id === 'root_install' || spec.id === 'spike_install') env.CI = '1'
  else delete env.CI
  const result = spawnSync(spec.executable, spec.args, {
    cwd: spec.cwd === 'repo' ? repoRoot : spikeRoot,
    encoding: 'utf8',
    env,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
  })
  const exitCode = typeof result.status === 'number' ? result.status : 1
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (Buffer.byteLength(output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    measured.push({ id: spec.id, command: spec.rendered, exitCode: 1, outputSummary: [] })
    writeTransientRun(measured)
    fail(`clean-run:E_OUTPUT_CAP id=${spec.id}`)
  }
  if (exitCode !== 0 || result.error !== undefined) {
    measured.push({ id: spec.id, command: spec.rendered, exitCode, outputSummary: [] })
    writeTransientRun(measured)
    fail(`clean-run:E_COMMAND id=${spec.id} exit=${exitCode}`)
  }
  let outputSummary
  try {
    outputSummary = summarize(spec.id, output)
  } catch {
    measured.push({ id: spec.id, command: spec.rendered, exitCode, outputSummary: [] })
    writeTransientRun(measured)
    fail(`clean-run:E_OUTPUT_CONTRACT id=${spec.id}`)
  }
  const record = { id: spec.id, command: spec.rendered, exitCode, outputSummary }
  measured.push(record)
  writeTransientRun(measured)
  console.log(`clean-run: ok id=${spec.id}`)
}

function persistJson(name, value) {
  const path = join(evidenceRoot, name)
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o644)
  assertMode(path, 0o644)
}

function publishEvidence(measured) {
  const blocknotePath = candidateSnapshotPath(spikeRoot, 'blocknote')
  const tiptapPath = candidateSnapshotPath(spikeRoot, 'tiptap')
  const decisionPath = join(transientRoot, 'decision.json')
  const runPath = join(transientRoot, 'run.json')
  for (const path of [blocknotePath, tiptapPath, decisionPath, runPath]) assertMode(path, 0o600)
  persistJson('blocknote.json', readJsonBounded(blocknotePath))
  persistJson('tiptap.json', readJsonBounded(tiptapPath))
  persistJson('decision.json', readJsonBounded(decisionPath))
  persistJson('run.json', { schemaVersion: 1, runtime: { node: '22.23.0' }, commands: measured })
}

function runReportFinalizer(args, label) {
  const result = spawnSync('pnpm', ['--dir', 'spikes/editor', 'run', 'report', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      NPM_CONFIG_USERCONFIG: '/dev/null',
    },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
  })
  if (result.status !== 0 || result.error !== undefined) fail(`clean-run:E_${label}`)
  console.log(`clean-run: ok id=${label}`)
}

const pinnedNode = readTextBounded(join(spikeRoot, '.node-version'), 64).trim()
if (pinnedNode !== '22.23.0' || process.version !== 'v22.23.0') {
  fail(`clean-run:E_NODE_PIN expected=22.23.0 actual=${process.version}`)
}

try {
  for (const path of [transientRoot, join(spikeRoot, 'blocknote/.report'), join(spikeRoot, 'tiptap/.report')]) {
    removeTreeGuarded(path)
  }
  ensureDirectory(transientRoot, 0o700)
  ensureDirectory(evidenceRoot, 0o755)
  writeDecisionTransient(join(transientRoot, 'decision.json'), decision)
  assertMode(join(transientRoot, 'decision.json'), 0o600)
} catch (error) {
  fail(error instanceof Error ? error.message : 'clean-run:E_PREPARE')
}

const measured = []
for (const spec of EXPECTED_COMMANDS.slice(0, -1)) runCommand(spec, measured)
publishEvidence(measured)
runCommand(EXPECTED_COMMANDS.at(-1), measured)
publishEvidence(measured)
runReportFinalizer([], 'FINAL_REPORT')
runReportFinalizer(['--', '--check'], 'REPORT_FRESHNESS')
console.log('clean-run: complete')
