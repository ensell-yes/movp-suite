import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeTextAtomic } from '../lib/safe-io.mjs'

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
  return { file, packages, paths: packages.map((pkg) => pkg.paths[0]) }
}

describe('gates fail red on sabotage', () => {
  it('source-boundary catches a forbidden client import', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    writeFileSync(join(d, 'bad.ts'), "import { hashOnce } from '@spike/oracle'\n")
    expect(run('source-boundary.mjs', d, d, join(d, 'bad.ts'))).toBe(1)
  })
  it('source-boundary catches a relative import escaping the browser root', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'src'); mkdirSync(client)
    writeFileSync(join(d, 'server.ts'), 'export const secret = 1\n')
    writeFileSync(join(client, 'bad.ts'), "import { secret } from '../server.ts'\n")
    expect(run('source-boundary.mjs', client, d, join(client, 'bad.ts'))).toBe(1)
  })
  it('source-boundary catches a dynamic literal import escaping the browser root', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'src'); mkdirSync(client)
    writeFileSync(join(d, 'server.ts'), 'export const secret = 1\n')
    writeFileSync(join(client, 'main.ts'), "void import('../server.ts')\n")
    expect(run('source-boundary.mjs', client, d, join(client, 'main.ts'))).toBe(1)
  })
  it('source-boundary rejects a symlinked source file (untrusted-io)', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    writeFileSync(join(d, 'main.ts'), 'export {}\n')
    symlinkSync('/etc/hosts', join(d, 'evil.ts'))
    expect(run('source-boundary.mjs', d, d, join(d, 'main.ts'))).toBe(1)
  })
  it('source-boundary rejects every AST any keyword across authored extensions', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'client'); mkdirSync(client)
    writeFileSync(join(client, 'main.ts'), 'export {}\n')
    writeFileSync(join(d, 'node-test.mts'), 'type Unsafe = any[]\n')
    expect(run('source-boundary.mjs', client, d, join(client, 'main.ts'))).toBe(1)
  })
  it('source-boundary rejects a symlinked source root before enumeration', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-'))
    const root = join(d, 'root'); symlinkSync('/etc', root)
    expect(run('source-boundary.mjs', root, root, join(root, 'main.ts'))).toBe(1)
  })
  it('source-boundary rejects a Vite entry outside the client root', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const client = join(d, 'src'); mkdirSync(client)
    writeFileSync(join(client, 'main.ts'), 'export {}\n')
    writeFileSync(join(d, 'outside.ts'), 'export {}\n')
    expect(run('source-boundary.mjs', client, d, join(d, 'outside.ts'))).toBe(1)
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
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'MPL-2.0')
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--input', file], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).prodHasCopyleft).toBe(true)
  })
  it.each(['Python-2.0', '(MIT OR CC0-1.0)'])('accepts reviewed permissive SPDX value %s', (license) => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, license)
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--input', file], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).entries.every((entry) => entry.license === license)).toBe(true)
  })
  it('accepts reviewed CC-BY-4.0 browser data in the full development graph only', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'CC-BY-4.0')
    expect(run('license-gate.mjs', d, 'prod', 'tiptap', '--input', file)).toBe(1)
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'full', 'tiptap', '--input', file], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).entries.every((entry) => entry.license === 'CC-BY-4.0')).toBe(true)
  })
  it('full license graph fails closed on an unknown SPDX value', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'SECRET_PAYLOAD')
    const audit = join(d, 'audit.json')
    const result = failure('license-gate.mjs', d, 'full', 'tiptap', '--input', file, '--audit-output', audit)
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('SECRET_PAYLOAD')
    const evidence = JSON.parse(readFileSync(audit, 'utf8'))
    expect(evidence.rejectedEntries).toEqual([
      { name: '@tiptap/core', versions: ['1.0.0'], license: 'SECRET_PAYLOAD' },
      { name: '@tiptap/pm', versions: ['1.0.0'], license: 'SECRET_PAYLOAD' },
      { name: '@tiptap/react', versions: ['1.0.0'], license: 'SECRET_PAYLOAD' },
      { name: '@tiptap/starter-kit', versions: ['1.0.0'], license: 'SECRET_PAYLOAD' },
    ])
    expect(statSync(audit).mode & 0o777).toBe(0o600)
  })
  it('records a declared-only notice gap without rejecting the candidate', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'MIT', 0)
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--input', file], { cwd: workspace, encoding: 'utf8' })
    const evidence = JSON.parse(raw).noticeEvidence
    expect(evidence).toContainEqual({ package: '@tiptap/core', status: 'declared_only', declaredLicense: 'MIT' })
  })
  it('derives guarded license evidence from a pnpm dependency graph fallback', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-'))
    const { paths } = tiptapLicenseFixture(d, 'MIT')
    const names = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
    const dependencies = Object.fromEntries(names.map((name, index) => [name, {
      version: '1.0.0', resolved: `https://registry.npmjs.org/${name}`, path: paths[index],
    }]))
    const graph = join(d, 'graph.json')
    writeFileSync(graph, JSON.stringify([{ dependencies }]))
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--graph-input', graph], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).entries.map((entry) => entry.name).sort()).toEqual(names.sort())
  })
  it('rejects a denied declared license hidden under an allowed bucket', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file, paths } = tiptapLicenseFixture(d, 'MIT', 0)
    writeFileSync(join(paths[0], 'package.json'), JSON.stringify({ name: '@tiptap/core', version: '1.0.0', license: 'GPL-3.0-only' }))
    expect(run('license-gate.mjs', d, 'prod', 'tiptap', '--input', file)).toBe(1)
  })
  it('rejects direct manifests whose name or version disagrees with measured evidence', () => {
    for (const mismatch of [{ name: 'wrong-name', version: '1.0.0' }, { name: '@tiptap/core', version: '9.9.9' }]) {
      const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file, paths } = tiptapLicenseFixture(d, 'MIT')
      writeFileSync(join(paths[0], 'package.json'), JSON.stringify({ ...mismatch, license: 'MIT' }))
      expect(run('license-gate.mjs', d, 'prod', 'tiptap', '--input', file)).toBe(1)
    }
  })
  it('rejects empty normalized package names, versions, and paths', () => {
    for (const field of ['name', 'versions', 'paths']) {
      const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file, packages } = tiptapLicenseFixture(d, 'MIT')
      const replacement = field === 'name' ? '' : []
      packages[0] = { ...packages[0], [field]: replacement }
      writeFileSync(file, JSON.stringify({ MIT: packages }))
      expect(run('license-gate.mjs', d, 'prod', 'tiptap', '--input', file)).toBe(1)
    }
  })
  it('module-graph gate fails when artifact missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); mkdirSync(join(d, 'dist'), { recursive: true })
    expect(run('module-graph-gate.mjs', join(d, 'dist'))).toBe(1)
  })
  it('module-graph gate fails on a forbidden module id', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); mkdirSync(join(d, 'dist'), { recursive: true })
    writeFileSync(join(d, 'dist', 'module-ids.json'), JSON.stringify(['/SECRET_PAYLOAD/@spike/oracle']))
    const result = failure('module-graph-gate.mjs', join(d, 'dist'))
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('SECRET_PAYLOAD')
  })
  it('atomic writes produce the requested final modes', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const privateFile = join(d, 'private.json'); const publicFile = join(d, 'public.md')
    writeTextAtomic(privateFile, '{}\n')
    writeTextAtomic(publicFile, '# report\n', 0o644)
    expect(statSync(privateFile).mode & 0o777).toBe(0o600)
    expect(statSync(publicFile).mode & 0o777).toBe(0o644)
  })
  it('atomic writes reject a symlink target', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const victim = join(d, 'victim'); const target = join(d, 'target')
    writeFileSync(victim, 'safe\n'); symlinkSync(victim, target)
    expect(() => writeTextAtomic(target, 'unsafe\n')).toThrow()
    expect(readFileSync(victim, 'utf8')).toBe('safe\n')
  })
  it('atomic write failure leaves no temporary file', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-')); const target = join(d, 'target')
    expect(() => writeTextAtomic(target, 'owner-only\n', -1)).toThrow()
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(d).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
