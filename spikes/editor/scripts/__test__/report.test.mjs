import { execFileSync } from 'node:child_process'
import {
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
import { formatBlockIdPreserved } from '../report-format.mjs'

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

function writeScenario(root, decision, blocknote = {}, tiptap = {}) {
  const reportDir = join(root, '.report')
  mkdirSync(reportDir)
  writeFileSync(join(root, '.node-version'), '22.23.0\n')
  writeFileSync(join(reportDir, 'blocknote.json'), JSON.stringify({
    ...PASS,
    candidate: 'blocknote',
    ...blocknote,
  }))
  writeFileSync(join(reportDir, 'tiptap.json'), JSON.stringify({
    ...PASS,
    candidate: 'tiptap',
    blockIdPreserved: null,
    toolbarLoc: 19,
    ...tiptap,
  }))
  if (decision !== null) writeFileSync(join(reportDir, 'decision.json'), JSON.stringify(decision))
}

function scenario(decision, blocknote = {}, tiptap = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
  writeScenario(root, decision, blocknote, tiptap)
  try {
    execFileSync('node', [reportScript, '--validate-only'], { cwd: root })
    return 0
  } catch (error) {
    return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 1
  }
}

describe('report validation (§12.1/§12.2)', () => {
  it('fails before reading a symlinked report root', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
    const victim = join(root, 'victim')
    mkdirSync(victim)
    symlinkSync(victim, join(root, '.report'))
    expect(() => execFileSync('node', [reportScript, '--validate-only'], { cwd: root })).toThrow()
  })

  it('fails before following a symlinked node pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-rep-'))
    mkdirSync(join(root, '.report'))
    const victim = join(root, 'victim')
    writeFileSync(victim, '22.23.0\n')
    symlinkSync(victim, join(root, '.node-version'))
    expect(() => execFileSync('node', [reportScript, '--validate-only'], { cwd: root })).toThrow()
  })

  it('fails when decision is missing', () => {
    expect(scenario(null)).toBe(1)
  })

  it('fails when the selected candidate has a false technical field', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { idempotent: false },
    )).toBe(1)
  })

  it('allows informational BlockNote block-ID loss', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { blockIdPreserved: false },
    )).toBe(0)
  })

  it('allows TipTap null block IDs as non-gating N/A', () => {
    expect(scenario(
      { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'tiptap' },
    )).toBe(0)
  })

  it('rejects malformed TipTap block-ID evidence', () => {
    expect(scenario(
      { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'tiptap' },
      {},
      { blockIdPreserved: 'unknown' },
    )).toBe(1)
  })

  it('renders true, false, and null block-ID results', () => {
    expect(formatBlockIdPreserved(null)).toBe('N/A')
    expect(formatBlockIdPreserved(true)).toBe('true')
    expect(formatBlockIdPreserved(false)).toBe('false')
  })

  it('fails malformed license evidence', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { prodLicenses: [{ name: 'x' }] },
    )).toBe(1)
  })

  it('fails missing or unsupported runtime evidence', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { runtime: { node: '23.0.0', browserChannel: 'chromium', browserVersion: '' } },
    )).toBe(1)
  })

  it('fails runtime evidence one patch above the authoritative pin', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { runtime: { ...PASS.runtime, node: '22.23.1' } },
    )).toBe(1)
  })

  it('allows a structurally recorded declared-only notice gap', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { noticeEvidence: DECLARED_NOTICE },
    )).toBe(0)
  })

  it('fails a candidate-name/file mismatch', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { candidate: 'tiptap' },
    )).toBe(1)
  })

  it('fails inconsistent measured-copyleft evidence', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { prodHasCopyleft: true },
    )).toBe(1)
  })

  it('fails permissive_only with a measured-copyleft selection', () => {
    expect(scenario(
      { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'blocknote' },
      { prodHasCopyleft: true, prodLicenses: MPL_LICENSE },
    )).toBe(1)
  })

  it('passes accept_mpl with a fully passing BlockNote result', () => {
    expect(scenario(
      { licenseDecision: { kind: 'accept_mpl' }, selectedCandidate: 'blocknote' },
      { prodHasCopyleft: true, prodLicenses: MPL_LICENSE },
    )).toBe(0)
  })

  it('passes permissive_only with a fully passing TipTap result', () => {
    expect(scenario(
      { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'tiptap' },
    )).toBe(0)
  })

  it('replaces a stale durable report instead of preserving it', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'spk-repo-'))
    const spikeRoot = join(repoRoot, 'spikes/editor')
    const reportPath = join(repoRoot, 'docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md')
    mkdirSync(join(repoRoot, 'docs/superpowers/specs'), { recursive: true })
    mkdirSync(spikeRoot, { recursive: true })
    writeScenario(
      spikeRoot,
      { licenseDecision: { kind: 'permissive_only' }, selectedCandidate: 'tiptap' },
    )
    writeFileSync(join(spikeRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    writeFileSync(reportPath, 'STALE REPORT\n')
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
    execFileSync('git', ['-c', 'user.name=Spike', '-c', 'user.email=spike@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], { cwd: repoRoot })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    writeFileSync(join(spikeRoot, '.spike-base-sha'), `${base}\n`)

    execFileSync('node', [reportScript], { cwd: spikeRoot })

    const report = readFileSync(reportPath, 'utf8')
    expect(report).not.toContain('STALE REPORT')
    expect(report).toContain('Selected candidate: **tiptap**')
    expect(report).toContain('License decision: **permissive_only**')
  })
})
