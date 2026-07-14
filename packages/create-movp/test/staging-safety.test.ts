import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'

// packages/create-movp/test/ → three levels up is the repo root. NOTHING in this suite ever WRITES
// under it (INTERFACES F1): staging runs against a SYNTHETIC tree in $TMPDIR, and the afterAll guard
// below proves the real worktree is byte-unchanged. There is no `git checkout --` anywhere, because
// there is nothing to restore.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const stageScript = join(repoRoot, 'fixtures', 'verdaccio-crm-lite', 'stage-create-movp.mjs')
const builtCopier = join(repoRoot, 'packages', 'create-movp', 'dist', 'index.js')

const WIP_README = '# crm-lite\n\n<!-- a developer\'s uncommitted WIP edit -->\n'

let work = ''
let synth = ''
let realBefore = ''

beforeAll(async () => {
  // stage-create-movp.mjs imports the BUILT guards. Do NOT build here: a test must not write anywhere
  // under the real repo (F1). The gate command builds first — fail loudly with the command if it did not.
  if (!existsSync(builtCopier)) {
    throw new Error(`missing ${builtCopier} — run: pnpm --filter create-movp build`)
  }
  realBefore = await snapshotTree(repoRoot)
}, 60_000)

// F1 ACCEPTANCE: the real worktree is byte-UNCHANGED by this suite. A developer running it with a
// dirty `templates/crm-lite/README.md` has that WIP edit inside BOTH manifests, so this assertion is
// exactly the promise "the suite never touched your files".
afterAll(async () => {
  expect(await snapshotTree(repoRoot)).toBe(realBefore)
}, 60_000)

// The SYNTHETIC repo staging runs against: the exact layout stage-create-movp.mjs reads
// (<root>/packages/create-movp/{package.json,dist/} + <root>/templates/crm-lite/), seeded with the two
// things the old gate got wrong — a pre-existing UNTRACKED file under packages/create-movp/templates/,
// and a dirty (WIP-edited) tracked template file.
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'movp-staging-safety-'))
  synth = join(work, 'repo')
  const pkg = join(synth, 'packages', 'create-movp')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  mkdirSync(join(pkg, 'templates'), { recursive: true })
  mkdirSync(join(synth, 'templates', 'crm-lite', 'supabase'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), '{"name":"create-movp","version":"0.1.0"}\n')
  writeFileSync(join(pkg, 'dist', 'index.js'), 'export const stub = true\n')
  writeFileSync(join(pkg, 'templates', 'preserve.txt'), 'do not delete me\n')
  writeFileSync(join(synth, 'templates', 'crm-lite', 'README.md'), WIP_README)
  writeFileSync(join(synth, 'templates', 'crm-lite', 'supabase', 'config.toml'), 'project_id = "acme"\n')
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('pack staging (INTERFACES F1/F2 — "staging changed nothing", not "the tree is pristine")', () => {
  it('preserves an untracked file + a WIP edit in the SOURCE tree, and the snapshot gate PASSES', async () => {
    const before = await snapshotTree(synth)
    execFileSync('node', [stageScript, synth, join(work, 'stage')], { stdio: 'pipe' })
    const after = await snapshotTree(synth)

    // The gate's actual assertion: byte-identical manifests → staging MUTATED nothing.
    expect(after).toBe(before)
    // Both the untracked file and the WIP edit survive byte-identical.
    expect(readFileSync(join(synth, 'packages', 'create-movp', 'templates', 'preserve.txt'), 'utf8'))
      .toBe('do not delete me\n')
    expect(readFileSync(join(synth, 'templates', 'crm-lite', 'README.md'), 'utf8')).toBe(WIP_README)
    // …and staging really produced the publish tree — in the TEMP dir ONLY.
    expect(existsSync(join(work, 'stage', 'package.json'))).toBe(true)
    expect(existsSync(join(work, 'stage', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(work, 'stage', 'templates', 'crm-lite', 'README.md'))).toBe(true)
  })

  it('FAILS the pack on a symlinked template file instead of packing its target (F1a)', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    execFileSync('ln', ['-s', join(work, 'secret'), join(synth, 'templates', 'crm-lite', 'notes.ts')])
    let stderr = ''
    expect(() => {
      try {
        execFileSync('node', [stageScript, synth, join(work, 'stage')], { stdio: 'pipe' })
      } catch (err: unknown) {
        stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err)
        throw err
      }
    }).toThrow()
    expect(stderr).toContain('template_symlink_rejected')
    expect(stderr).not.toContain('ssh-key') // path + reason only — never the target's bytes
  })
})
