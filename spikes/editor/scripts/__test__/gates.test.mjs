import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const run = (script, ...args) => {
  try { execFileSync('node', [join('scripts', script), ...args], { cwd: workspace, encoding: 'utf8' }); return 0 }
  catch (e) { return e.status ?? 1 }
}
const failure = (script, ...args) => {
  const result = spawnSync('node', [join('scripts', script), ...args], { cwd: workspace, encoding: 'utf8' })
  return { status: result.status ?? 1, stderr: result.stderr }
}
const tiptapLicenseFixture = (root, license, missingNoticeAt = -1) => {
  const names = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
  const packages = names.map((name, index) => {
    const path = join(root, `pkg-${index}`); mkdirSync(path)
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }))
    if (index !== missingNoticeAt) writeFileSync(join(path, 'LICENSE'), `${license}\n`)
    return { name, versions: ['1.0.0'], paths: [path] }
  })
  const file = join(root, 'licenses.json'); writeFileSync(file, JSON.stringify({ [license]: packages }))
  return file
}

describe('gates fail red on sabotage', () => {
  it('source-boundary catches a forbidden client import', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    writeFileSync(join(d, 'bad.ts'), "import { hashOnce } from '@spike/oracle'\n")
    expect(run('source-boundary.mjs', d, d)).toBe(1)
  })
  it('source-boundary catches a relative import escaping the browser root', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'src'); mkdirSync(client)
    writeFileSync(join(d, 'server.ts'), 'export const secret = 1\n')
    writeFileSync(join(client, 'bad.ts'), "import { secret } from '../server.ts'\n")
    expect(run('source-boundary.mjs', client, d)).toBe(1)
  })
  it('source-boundary rejects a symlinked source file (untrusted-io)', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    symlinkSync('/etc/hosts', join(d, 'evil.ts'))
    expect(run('source-boundary.mjs', d, d)).toBe(1)
  })
  it('source-boundary rejects explicit any outside the browser directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'client'); mkdirSync(client)
    writeFileSync(join(d, 'node-test.ts'), 'const unsafe: any = 1\n')
    expect(run('source-boundary.mjs', client, d)).toBe(1)
  })
  it('source-boundary rejects a symlinked source root before enumeration', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    const root = join(d, 'root'); symlinkSync('/etc', root)
    expect(run('source-boundary.mjs', root, root)).toBe(1)
  })
  it('guarded JSON rejects oversized and malformed files without echoing bytes', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); mkdirSync(join(d, 'dist'))
    writeFileSync(join(d, 'dist', 'module-ids.json'), 'x'.repeat(5 * 1024 * 1024 + 1))
    expect(run('module-graph-gate.mjs', join(d, 'dist'))).toBe(1)
    writeFileSync(join(d, 'dist', 'module-ids.json'), '{SECRET_PAYLOAD')
    const result = failure('module-graph-gate.mjs', join(d, 'dist'))
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('SECRET_PAYLOAD')
  })
  it('license evidence derives copyleft from the measured graph', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const fixture = tiptapLicenseFixture(d, 'MPL-2.0')
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--input', fixture], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).prodHasCopyleft).toBe(true)
  })
  it('full license graph fails closed on an unknown SPDX value', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const fixture = tiptapLicenseFixture(d, 'Mystery-1.0')
    expect(run('license-gate.mjs', d, 'full', 'tiptap', '--input', fixture)).toBe(1)
  })
  it('records a declared-only notice gap without rejecting the candidate', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const fixture = tiptapLicenseFixture(d, 'MIT', 0)
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--input', fixture], { cwd: workspace, encoding: 'utf8' })
    const evidence = JSON.parse(raw).noticeEvidence
    expect(evidence).toContainEqual({ package: '@tiptap/core', status: 'declared_only', declaredLicense: 'MIT' })
  })
  it('module-graph gate fails when artifact missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); mkdirSync(join(d, 'dist'), { recursive: true })
    expect(run('module-graph-gate.mjs', join(d, 'dist'))).toBe(1)
  })
  it('module-graph gate fails on a forbidden module id', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); mkdirSync(join(d, 'dist'), { recursive: true })
    writeFileSync(join(d, 'dist', 'module-ids.json'), JSON.stringify(['/x/packages/domain/src/content.ts']))
    expect(run('module-graph-gate.mjs', join(d, 'dist'))).toBe(1)
  })
})
