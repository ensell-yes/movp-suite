import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'

// The helper's chunk size. Every case below CROSSES it — the bug this file pins is a whole-file
// `readFileSync`, which passes any single-chunk test.
const CHUNK_BYTES = 64 * 1024
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const snapshotScript = join(repoRoot, 'scripts', 'tree-snapshot.mjs')

let root = ''
let templates = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'movp-tree-snapshot-'))
  templates = join(root, 'templates', 'crm-lite')
  mkdirSync(templates, { recursive: true })
  mkdirSync(join(root, 'packages', 'create-movp'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('snapshotTree (the ONE shared bounded snapshot — INTERFACES F2)', () => {
  it('hashes a file MUCH larger than the chunk size correctly', async () => {
    // ~5 MiB ≫ the 64 KiB chunk, and deliberately NOT a chunk multiple (the +7 tail).
    const big = Buffer.alloc(80 * CHUNK_BYTES + 7, 0x61)
    writeFileSync(join(templates, 'big.sql'), big)
    const expected = createHash('sha256').update(big).digest('hex')
    expect(await snapshotTree(root)).toContain(
      `file ${expected} ${join('templates', 'crm-lite', 'big.sql')}`,
    )
  })

  // Boundedness is a SOURCE property — an RSS/heap probe is flaky (GC timing, Buffer pooling), so pin
  // it deterministically instead: the helper must stream. `gate.sh` greps for the same thing.
  it('is BOUNDED: streams via createReadStream and never buffers a whole file', () => {
    const src = readFileSync(snapshotScript, 'utf8')
    expect(src).toContain('createReadStream')
    expect(src).not.toMatch(/\breadFileSync\(/)
    expect(src).not.toMatch(/\breadFile\(/)
  })

  it('detects a ONE-BYTE change inside a later chunk', async () => {
    const bytes = Buffer.alloc(3 * CHUNK_BYTES, 0x61)
    writeFileSync(join(templates, 'big.sql'), bytes)
    const before = await snapshotTree(root)
    bytes[2 * CHUNK_BYTES + 11] = 0x62 // one byte, in the THIRD chunk
    writeFileSync(join(templates, 'big.sql'), bytes)
    expect(await snapshotTree(root)).not.toBe(before)
  })

  it('records a symlink by its target WITHOUT following it, and never emits file content', async () => {
    writeFileSync(join(root, 'secret'), 'ssh-key\n')
    symlinkSync(join(root, 'secret'), join(templates, 'notes.ts'))
    const manifest = await snapshotTree(root)
    expect(manifest).toContain(`symlink ${join(root, 'secret')} ${join('templates', 'crm-lite', 'notes.ts')}`)
    expect(manifest).not.toContain('ssh-key')
  })

  it('skips node_modules and is byte-stable across runs', async () => {
    mkdirSync(join(templates, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(templates, 'node_modules', 'junk', 'index.js'), 'x\n')
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    const manifest = await snapshotTree(root)
    expect(manifest).not.toContain('node_modules')
    expect(await snapshotTree(root)).toBe(manifest)
  })

  it('reports an absent root as a stable line instead of throwing', async () => {
    rmSync(join(root, 'packages'), { recursive: true, force: true })
    expect(await snapshotTree(root)).toContain('absent - packages/create-movp')
  })

  it('snapshots an arbitrary tree with roots = ["."] (the copier tests\' shape)', async () => {
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    const manifest = await snapshotTree(templates, ['.'])
    expect(manifest).toContain('file ')
    expect(manifest).toContain('README.md')
  })

  // INTERFACES round-6 F1: the CLI contract is `<root> [outFile]` and BOTH forms have real consumers
  // — 06d's gate.sh writes a file, 06e's six call sites redirect stdout. The two forms are diffed
  // against each other by those gates, so a one-byte divergence (e.g. a `console.log` trailing
  // newline on the stdout path) would break them. Pin byte-identity.
  it('CLI: the stdout form and the <outFile> form emit BYTE-IDENTICAL manifests', () => {
    writeFileSync(join(templates, 'README.md'), '# crm-lite\n')
    // The out file sits at the synthetic root — OUTSIDE the snapshotted roots (`packages/create-movp`,
    // `templates`) — so writing it cannot change what the second run hashes.
    const outFile = join(root, 'manifest.txt')

    const piped = spawnSync(process.execPath, [snapshotScript, root], { encoding: 'buffer' })
    expect(piped.status).toBe(0)
    const written = spawnSync(process.execPath, [snapshotScript, root, outFile], { encoding: 'buffer' })
    expect(written.status).toBe(0)

    expect(readFileSync(outFile)).toEqual(piped.stdout) // byte-for-byte, not merely "equivalent"
    expect(written.stdout.length).toBe(0) // the file form prints nothing to stdout
    expect(piped.stdout.toString('utf8')).toContain(join('templates', 'crm-lite', 'README.md'))
  })

  it('CLI: a missing <root> still exits 2', () => {
    const res = spawnSync(process.execPath, [snapshotScript], { encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('usage: tree-snapshot.mjs <root> [outFile]')
  })
})
