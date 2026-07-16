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
  it('walks resolved registry children beneath an unresolved workspace graph node', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-'))
    const { paths } = tiptapLicenseFixture(d, 'MIT')
    const names = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
    const childPath = join(d, 'nested-child'); mkdirSync(childPath)
    writeFileSync(join(childPath, 'package.json'), JSON.stringify({ name: 'nested-registry-child', version: '2.0.0', license: 'MIT' }))
    const dependencies = Object.fromEntries(names.map((name, index) => [name, {
      version: '1.0.0', resolved: `https://registry.npmjs.org/${name}`, path: paths[index],
    }]))
    dependencies['@spike/workspace-parent'] = {
      version: '0.0.0',
      dependencies: {
        'nested-registry-child': {
          version: '2.0.0', resolved: 'https://registry.npmjs.org/nested-registry-child', path: childPath,
        },
      },
    }
    const graph = join(d, 'graph.json'); writeFileSync(graph, JSON.stringify([{ dependencies }]))
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'prod', 'tiptap', '--graph-input', graph], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).entries).toContainEqual({ name: 'nested-registry-child', versions: ['2.0.0'], license: 'MIT' })
  })
  it.each(['SECRET_PAYLOAD', 'GPL-3.0-only'])('rejects %s on a registry child beneath an unresolved workspace node', (license) => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-'))
    const { paths } = tiptapLicenseFixture(d, 'MIT')
    const names = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit']
    const childPath = join(d, 'nested-child'); mkdirSync(childPath)
    writeFileSync(join(childPath, 'package.json'), JSON.stringify({ name: 'nested-registry-child', version: '2.0.0', license }))
    const dependencies = Object.fromEntries(names.map((name, index) => [name, {
      version: '1.0.0', resolved: `https://registry.npmjs.org/${name}`, path: paths[index],
    }]))
    dependencies['@spike/workspace-parent'] = {
      version: '0.0.0',
      optionalDependencies: {
        'nested-registry-child': {
          version: '2.0.0', resolved: 'https://registry.npmjs.org/nested-registry-child', path: childPath,
        },
      },
    }
    const graph = join(d, 'graph.json'); writeFileSync(graph, JSON.stringify([{ dependencies }]))
    expect(run('license-gate.mjs', d, 'prod', 'tiptap', '--graph-input', graph)).toBe(1)
  })
  it('retains guarded notice evidence for a full-graph attribution license', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'MIT')
    const attributionPath = join(d, 'caniuse-lite'); mkdirSync(attributionPath)
    writeFileSync(join(attributionPath, 'package.json'), JSON.stringify({ name: 'caniuse-lite', version: '1.0.0', license: 'CC-BY-4.0' }))
    writeFileSync(join(attributionPath, 'LICENSE'), 'CC-BY-4.0\n')
    const report = JSON.parse(readFileSync(file, 'utf8'))
    report['CC-BY-4.0'] = [{ name: 'caniuse-lite', versions: ['1.0.0'], paths: [attributionPath] }]
    writeFileSync(file, JSON.stringify(report))
    const raw = execFileSync('node', [join('scripts', 'license-gate.mjs'), d, 'full', 'tiptap', '--input', file], { cwd: workspace, encoding: 'utf8' })
    expect(JSON.parse(raw).noticeEvidence).toContainEqual(expect.objectContaining({
      package: 'caniuse-lite', status: 'file', path: 'caniuse-lite/LICENSE',
    }))
  })
  it('fails a full attribution license package without guarded notice evidence', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-tiptap-')); const { file } = tiptapLicenseFixture(d, 'MIT')
    const attributionPath = join(d, 'caniuse-lite'); mkdirSync(attributionPath)
    writeFileSync(join(attributionPath, 'package.json'), JSON.stringify({ name: 'caniuse-lite', version: '1.0.0', license: 'CC-BY-4.0' }))
    const report = JSON.parse(readFileSync(file, 'utf8'))
    report['CC-BY-4.0'] = [{ name: 'caniuse-lite', versions: ['1.0.0'], paths: [attributionPath] }]
    writeFileSync(file, JSON.stringify(report))
    expect(run('license-gate.mjs', d, 'full', 'tiptap', '--input', file)).toBe(1)
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
  it('runtime preflight parser accepts only the exact pinned Node and signed Chrome channel', async () => {
    const { validateRuntime } = await import('../runtime-preflight.mjs')
    expect(validateRuntime('22.23.0', '22.23.0', 'chrome', 'Google Chrome 138.0.0.0')).toEqual({
      node: '22.23.0', browserChannel: 'chrome', browserVersion: 'Google Chrome 138.0.0.0',
    })
    for (const node of ['22.23.1', '21.7.0', '23.0.0']) {
      expect(() => validateRuntime('22.23.0', node, 'chrome', 'Google Chrome 138.0.0.0')).toThrow('runtime-preflight:E_NODE_MISMATCH')
    }
  })
  it('runtime preflight parser rejects unsupported or malformed browser evidence without launching', async () => {
    const { validateRuntime } = await import('../runtime-preflight.mjs')
    expect(() => validateRuntime('22.23.0', '22.23.0', 'chromium', '138.0.0.0')).toThrow('runtime-preflight:E_BROWSER_CHANNEL')
    expect(() => validateRuntime('22.23.0', '22.23.0', 'chrome', '')).toThrow('runtime-preflight:E_BROWSER_VERSION')
    expect(() => validateRuntime('22.23.0', '22.23.0', 'chrome', 'x'.repeat(129))).toThrow('runtime-preflight:E_BROWSER_VERSION')
  })
  it('guardedly treats .node-version as authoritative without leaking malformed content', () => {
    const d = mkdtempSync(join(tmpdir(), 'spk-runtime-')); const pin = join(d, '.node-version')
    writeFileSync(pin, '22.23.0\n')
    expect(run('runtime-preflight.mjs', '--check-node-only', '--pin', pin)).toBe(0)
    writeFileSync(pin, 'SECRET_PAYLOAD\n')
    const malformed = failure('runtime-preflight.mjs', '--check-node-only', '--pin', pin)
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('runtime-preflight:E_PIN_SHAPE')
    expect(malformed.stderr).not.toContain('SECRET_PAYLOAD')
    const victim = join(d, 'victim'); const symlink = join(d, 'pin-link')
    writeFileSync(victim, '22.23.0\n'); symlinkSync(victim, symlink)
    const linked = failure('runtime-preflight.mjs', '--check-node-only', '--pin', symlink)
    expect(linked.status).toBe(1)
    expect(linked.stderr).toContain('safe-io:E_SYMLINK')
    expect(linked.stderr).not.toContain('22.23.0')
  })
})
