import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeContentDigest, formatBlockIdPreserved } from '../report-format.mjs'
import { EXPECTED_COMMANDS } from '../run-contract.mjs'

const reportScript = fileURLToPath(new URL('../report.mjs', import.meta.url))
const LICENSE = [{ name: 'editor', versions: ['1.0.0'], license: 'MIT' }]
const MPL_LICENSE = [{ name: 'editor', versions: ['1.0.0'], license: 'MPL-2.0' }]
const NOTICE = [{ package: 'editor', status: 'file', path: 'editor/LICENSE', sha256: 'a'.repeat(64) }]
const DECLARED_NOTICE = [{ package: 'editor', status: 'declared_only', declaredLicense: 'MIT' }]
const PASS = {
  schemaVersion: 1,
  resolvedVersions: { editor: '1.0.0' },
  idempotent: true,
  exactEdit: true,
  lifecycleOrder: true,
  publishedRead: true,
  staleSabotage: true,
  boundary: true,
  a11y: true,
  license: 'pass',
  prodHasCopyleft: false,
  prodLicenses: LICENSE,
  fullLicenses: LICENSE,
  noticeEvidence: NOTICE,
  runtime: { node: '22.23.0', browserChannel: 'chrome', browserVersion: '150.0.0.0' },
  blockIdPreserved: true,
  bundle: { jsRaw: 1, jsGzip: 1, cssRaw: 0, cssGzip: 0 },
}
const DECISION = { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'tiptap' }

function validRun() {
  return {
    schemaVersion: 1,
    runtime: { node: '22.23.0' },
    commands: EXPECTED_COMMANDS.map(({ id, rendered }) => ({
      id,
      command: rendered,
      exitCode: 0,
      outputSummary: [`observed:${id}`],
    })),
  }
}

function writeEvidence(root, {
  decision = DECISION,
  blocknote = {},
  tiptap = {},
  run = validRun(),
} = {}) {
  const evidenceDir = join(root, 'evidence')
  mkdirSync(evidenceDir)
  writeFileSync(join(root, '.node-version'), '22.23.0\n')
  writeFileSync(join(evidenceDir, 'blocknote.json'), JSON.stringify({ ...PASS, candidate: 'blocknote', ...blocknote }))
  writeFileSync(join(evidenceDir, 'tiptap.json'), JSON.stringify({
    ...PASS,
    candidate: 'tiptap',
    blockIdPreserved: null,
    toolbarLoc: 19,
    ...tiptap,
  }))
  if (decision !== null) writeFileSync(join(evidenceDir, 'decision.json'), JSON.stringify(decision))
  if (run !== null) writeFileSync(join(evidenceDir, 'run.json'), JSON.stringify(run))
}

function scenario(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
  writeEvidence(root, overrides)
  try {
    execFileSync('node', [reportScript, '--validate-only'], { cwd: root })
    return 0
  } catch (error) {
    return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 1
  }
}

describe('durable report validation (§12.1/§12.2)', () => {
  it('fails before reading a symlinked evidence root', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
    const victim = join(root, 'victim')
    mkdirSync(victim)
    writeFileSync(join(root, '.node-version'), '22.23.0\n')
    symlinkSync(victim, join(root, 'evidence'))
    expect(() => execFileSync('node', [reportScript, '--validate-only'], { cwd: root })).toThrow()
  })

  it('fails before following a symlinked node pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
    mkdirSync(join(root, 'evidence'))
    const victim = join(root, 'victim')
    writeFileSync(victim, '22.23.0\n')
    symlinkSync(victim, join(root, '.node-version'))
    expect(() => execFileSync('node', [reportScript, '--validate-only'], { cwd: root })).toThrow()
  })

  it('fails when durable decision evidence is missing', () => {
    expect(scenario({ decision: null })).toBe(1)
  })

  it('fails when durable run evidence is missing', () => {
    expect(scenario({ run: null })).toBe(1)
  })

  it('fails a nonzero measured command result', () => {
    const run = validRun()
    run.commands[2].exitCode = 1
    expect(scenario({ run })).toBe(1)
  })

  it('fails a command result without actual output summary', () => {
    const run = validRun()
    run.commands[2].outputSummary = []
    expect(scenario({ run })).toBe(1)
  })

  it('fails an exact command mismatch', () => {
    const run = validRun()
    run.commands[2].command = 'pnpm run something-else'
    expect(scenario({ run })).toBe(1)
  })

  it('fails incomplete command evidence', () => {
    const run = validRun()
    run.commands.pop()
    expect(scenario({ run })).toBe(1)
  })

  it('fails when the selected candidate has a false technical field', () => {
    expect(scenario({ tiptap: { publishedRead: false } })).toBe(1)
  })

  it('allows informational BlockNote block-ID loss', () => {
    expect(scenario({ blocknote: { blockIdPreserved: false } })).toBe(0)
  })

  it('allows TipTap null block IDs as non-gating N/A', () => {
    expect(scenario()).toBe(0)
  })

  it('rejects malformed TipTap block-ID evidence', () => {
    expect(scenario({ tiptap: { blockIdPreserved: 'unknown' } })).toBe(1)
  })

  it('renders true, false, and null block-ID results', () => {
    expect(formatBlockIdPreserved(null)).toBe('N/A')
    expect(formatBlockIdPreserved(true)).toBe('true')
    expect(formatBlockIdPreserved(false)).toBe('false')
  })

  it('fails malformed license evidence', () => {
    expect(scenario({ blocknote: { prodLicenses: [{ name: 'x' }] } })).toBe(1)
  })

  it('fails runtime evidence one patch above the authoritative pin', () => {
    expect(scenario({ blocknote: { runtime: { ...PASS.runtime, node: '22.23.1' } } })).toBe(1)
  })

  it('allows a structurally recorded declared-only notice gap', () => {
    expect(scenario({ blocknote: { noticeEvidence: DECLARED_NOTICE } })).toBe(0)
  })

  it('fails inconsistent measured-copyleft evidence', () => {
    expect(scenario({ blocknote: { prodHasCopyleft: true } })).toBe(1)
  })

  it('fails permissive_only with a measured-copyleft selection', () => {
    expect(scenario({
      decision: { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'blocknote' },
      blocknote: { prodHasCopyleft: true, prodLicenses: MPL_LICENSE },
    })).toBe(1)
  })
})

describe('durable report provenance and freshness', () => {
  it('changes the explicit input digest when a source or durable input changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-digest-'))
    const source = join(root, 'source.mjs')
    const evidence = join(root, 'evidence.json')
    writeFileSync(source, 'export const value = 1\n')
    writeFileSync(evidence, '{"value":1}\n')
    const entries = [{ label: 'evidence', path: evidence }, { label: 'source', path: source }]
    const before = computeContentDigest(entries)
    writeFileSync(source, 'export const value = 2\n')
    expect(computeContentDigest(entries)).not.toBe(before)
    writeFileSync(source, 'export const value = 1\n')
    writeFileSync(evidence, '{"value":2}\n')
    expect(computeContentDigest(entries)).not.toBe(before)
  })

  it('renders actual command summaries and does not rewrite an identical report', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'spk-repo-'))
    const spikeRoot = join(repoRoot, 'spikes/editor')
    const reportPath = join(repoRoot, 'docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md')
    mkdirSync(join(repoRoot, 'docs/superpowers/specs'), { recursive: true })
    mkdirSync(join(spikeRoot, 'tiptap/src'), { recursive: true })
    writeEvidence(spikeRoot)
    writeFileSync(join(spikeRoot, 'package.json'), '{"name":"@spike/editor-root","private":true}\n')
    writeFileSync(join(spikeRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    writeFileSync(join(spikeRoot, 'tiptap/src/sentinel.ts'), 'export const sentinel = true\n')
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['add', '.'], { cwd: repoRoot })
    execFileSync('git', ['-c', 'user.name=Spike', '-c', 'user.email=spike@example.invalid', 'commit', '-qm', 'candidate evidence'], { cwd: repoRoot })
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    writeFileSync(join(spikeRoot, '.spike-base-sha'), `${sourceSha}\n`)

    execFileSync('node', [reportScript], { cwd: spikeRoot })
    const firstInode = lstatSync(reportPath).ino
    const first = readFileSync(reportPath, 'utf8')
    execFileSync('node', [reportScript], { cwd: spikeRoot })
    execFileSync('node', [reportScript, '--check'], { cwd: spikeRoot })

    expect(lstatSync(reportPath).ino).toBe(firstInode)
    expect(readFileSync(reportPath, 'utf8')).toBe(first)
    expect(first).toContain(`Candidate-evidence source commit: \`${sourceSha}\``)
    expect(first).toContain('| `typecheck` | `observed:typecheck` | 0 |')
    expect(first).toMatch(/Report input SHA-256: `[0-9a-f]{64}`/)
  })
})
