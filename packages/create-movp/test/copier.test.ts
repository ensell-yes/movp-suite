import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotTree } from '../../../scripts/tree-snapshot.mjs'
import {
  copyFileGuarded, copyTemplate, copyTreeGuarded, readFileGuarded, resolveTargetDir,
} from '../src/copier.ts'

let work: string
let templateDir: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'create-movp-'))
  templateDir = join(work, 'template')
  mkdirSync(templateDir, { recursive: true })
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

const tokens = { __PROJECT_NAME__: 'acme-crm', __WORKSPACE_ID__: '33333333-3333-3333-3333-333333333333' }

describe('resolveTargetDir', () => {
  it('resolves an absent dir under the parent', () => {
    expect(resolveTargetDir(work, 'acme-crm')).toBe(join(work, 'acme-crm'))
  })
  it('rejects a name with path traversal', () => {
    expect(() => resolveTargetDir(work, '../evil')).toThrow(/invalid_project_name/)
    expect(() => resolveTargetDir(work, 'a/b')).toThrow(/invalid_project_name/)
  })
  it('rejects an invalid charset', () => {
    expect(() => resolveTargetDir(work, 'Acme_CRM')).toThrow(/invalid_project_name/)
    expect(() => resolveTargetDir(work, '9lives')).toThrow(/invalid_project_name/)
  })
  it('rejects an existing target', () => {
    mkdirSync(join(work, 'taken'))
    expect(() => resolveTargetDir(work, 'taken')).toThrow(/target_exists/)
  })
})

describe('copyTemplate', () => {
  it('copies allowlisted text files and substitutes declared tokens', () => {
    writeFileSync(join(templateDir, 'README.md'), '# __PROJECT_NAME__\nws=__WORKSPACE_ID__\n')
    mkdirSync(join(templateDir, 'src'))
    writeFileSync(join(templateDir, 'src', 'app.ts'), 'export const name = "__PROJECT_NAME__"\n')
    const target = join(work, 'out')
    const res = copyTemplate({ templateDir, targetDir: target, tokens })
    expect(res.filesWritten).toBe(2)
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# acme-crm\nws=33333333-3333-3333-3333-333333333333\n')
    expect(readFileSync(join(target, 'src', 'app.ts'), 'utf8')).toContain('"acme-crm"')
  })

  it('excludes build/cache dirs (node_modules, dist, .astro, .git)', () => {
    writeFileSync(join(templateDir, 'keep.ts'), 'ok\n')
    for (const d of ['node_modules', 'dist', '.astro', '.git']) {
      mkdirSync(join(templateDir, d))
      writeFileSync(join(templateDir, d, 'junk.ts'), 'junk\n')
    }
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    for (const d of ['node_modules', 'dist', '.astro', '.git']) {
      expect(() => readFileSync(join(target, d, 'junk.ts'))).toThrow()
    }
    expect(readFileSync(join(target, 'keep.ts'), 'utf8')).toBe('ok\n')
  })

  it('rejects a symlink in the template tree WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    symlinkSync(join(work, 'secret'), join(templateDir, 'notes.ts'))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_symlink_rejected/)
  })

  // INTERFACES F1(a): the ROOT itself. `readdirSync` FOLLOWS a symlink, so a symlinked template root
  // would be walked and an external tree read+copied. The root must be lstat'd BEFORE the readdir.
  it('rejects a symlinked template ROOT WITHOUT reading through it', () => {
    const external = join(work, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'secret.ts'), 'ssh-key\n')
    const rootLink = join(work, 'linked-template') // templates/crm-lite -> /external/dir
    symlinkSync(external, rootLink)
    const target = join(work, 'out-root')
    expect(() => copyTemplate({ templateDir: rootLink, targetDir: target, tokens }))
      .toThrow(/template_symlink_rejected/)
    // Nothing was read through the link and nothing was created.
    expect(existsSync(target)).toBe(false)
  })

  it('rejects an oversized file before buffering it', () => {
    writeFileSync(join(templateDir, 'big.sql'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_file_too_large/)
  })

  it('rejects when the running total exceeds the cap', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(templateDir, `f${i}.sql`), 'y'.repeat(4 * 1024 * 1024))
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/template_total_too_large/)
  })

  it('copies a binary allowlisted file byte-for-byte WITHOUT substitution', () => {
    // A PNG-ish buffer with a NUL and a token-shaped sequence that must NOT be substituted.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from('__PROJECT_NAME__')])
    writeFileSync(join(templateDir, 'logo.png'), bytes)
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    expect(readFileSync(join(target, 'logo.png'))).toEqual(bytes)
  })

  it('rejects an unknown token key in the map', () => {
    writeFileSync(join(templateDir, 'a.ts'), 'x\n')
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens: { PROJECT_NAME: 'x' } }))
      .toThrow(/unknown_token/)
  })

  it('rejects an unresolved token left in a text file', () => {
    writeFileSync(join(templateDir, 'b.ts'), 'const x = "__NOT_DECLARED__"\n')
    expect(() => copyTemplate({ templateDir, targetDir: join(work, 'out'), tokens }))
      .toThrow(/unresolved_token/)
  })

  it('renames a .template file and strips the suffix for the allowlist', () => {
    writeFileSync(join(templateDir, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    const target = join(work, 'out')
    copyTemplate({ templateDir, targetDir: target, tokens })
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('{"name":"acme-crm"}\n')
    expect(() => readFileSync(join(target, 'package.json.template'))).toThrow()
  })
})

describe('copyTreeGuarded (pack-harness staging — INTERFACES F1)', () => {
  // (a) An external-symlink template file makes the pack FAIL without reading the symlink target.
  it('rejects an external symlink WITHOUT reading its target and copies nothing for it', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    symlinkSync(join(work, 'secret'), join(templateDir, 'notes.ts')) // absolute → outside the tree
    writeFileSync(join(templateDir, 'real.ts'), 'ok\n')
    const dest = join(work, 'staged')
    let msg = ''
    expect(() => {
      try { copyTreeGuarded(templateDir, dest) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    // Path + reason only — the rejected entry name, NEVER the target's secret bytes.
    expect(msg).toContain('notes.ts')
    expect(msg).not.toContain('ssh-key')
    // The symlink target was never read → no dest file carries the secret content.
    expect(existsSync(join(dest, 'notes.ts'))).toBe(false)
  })

  it('copies every regular file byte-for-byte with NO substitution or `.template` rename', () => {
    writeFileSync(join(templateDir, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    mkdirSync(join(templateDir, 'src'))
    writeFileSync(join(templateDir, 'src', 'app.ts'), 'const n = "__PROJECT_NAME__"\n')
    const dest = join(work, 'staged')
    const res = copyTreeGuarded(templateDir, dest)
    expect(res.filesCopied).toBe(2)
    // Verbatim: tokens survive untouched (runtime copyTemplate substitutes later) and NO rename.
    expect(readFileSync(join(dest, 'package.json.template'), 'utf8')).toBe('{"name":"__PROJECT_NAME__"}\n')
    expect(existsSync(join(dest, 'package.json'))).toBe(false)
    expect(readFileSync(join(dest, 'src', 'app.ts'), 'utf8')).toBe('const n = "__PROJECT_NAME__"\n')
  })

  it('rejects an oversized file before buffering it', () => {
    writeFileSync(join(templateDir, 'big.bin'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyTreeGuarded(templateDir, join(work, 'staged')))
      .toThrow(/template_file_too_large/)
  })

  // INTERFACES F1(a): a symlinked staging ROOT is rejected before any readdir — same guard as the
  // runtime copier, because the pack harness points this at `templates/crm-lite` from a shell script.
  it('rejects a symlinked source ROOT WITHOUT reading through it', () => {
    const external = join(work, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'secret.ts'), 'ssh-key\n')
    const rootLink = join(work, 'linked-src')
    symlinkSync(external, rootLink)
    const dest = join(work, 'staged-root')
    expect(() => copyTreeGuarded(rootLink, dest)).toThrow(/template_symlink_rejected/)
    expect(existsSync(dest)).toBe(false)
  })

  // (b) A staging pass writes ONLY into its TEMP destDir — the SOURCE tree is byte-unchanged.
  // Hermetic: a SYNTHETIC source tree under $TMPDIR, snapshotted with the shared `snapshotTree`
  // (`['.']` = the whole tree). Nothing here reads or writes the real repo, and no `git status` /
  // `git checkout` is involved, so a developer's unrelated WIP can never fail it — or be destroyed
  // by it (INTERFACES F1). Task 6's staging-safety test makes the same assertion for the full
  // pack-staging script, also against a synthetic tree.
  it('leaves the SOURCE tree byte-unchanged (writes only into the TEMP destDir)', async () => {
    const src = join(work, 'src-tree')
    mkdirSync(join(src, 'supabase'), { recursive: true })
    writeFileSync(join(src, 'package.json.template'), '{"name":"__PROJECT_NAME__"}\n')
    writeFileSync(join(src, 'supabase', 'config.toml'), 'x\n')
    const before = await snapshotTree(src, ['.'])
    copyTreeGuarded(src, join(work, 'staged', 'crm-lite'))
    expect(existsSync(join(work, 'staged', 'crm-lite', 'package.json.template'))).toBe(true)
    expect(await snapshotTree(src, ['.'])).toBe(before)
  })
})

describe('copyFileGuarded (explicit single-file copy — INTERFACES F1(b))', () => {
  it('copies a regular file byte-for-byte and creates the dest parent', () => {
    writeFileSync(join(templateDir, 'package.json'), '{"name":"create-movp"}\n')
    const dest = join(work, 'staged', 'package.json') // parent does not exist yet
    const res = copyFileGuarded(join(templateDir, 'package.json'), dest)
    expect(res.bytesCopied).toBe(23) // '{"name":"create-movp"}\n' — 22 chars + newline
    expect(readFileSync(dest, 'utf8')).toBe('{"name":"create-movp"}\n')
  })

  it('rejects a symlinked SOURCE WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    const src = join(templateDir, 'package.json')
    symlinkSync(join(work, 'secret'), src) // a symlinked package.json in the staged package
    const dest = join(work, 'staged', 'package.json')
    let msg = ''
    expect(() => {
      try { copyFileGuarded(src, dest) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    expect(msg).not.toContain('ssh-key') // path + reason only — never the target's bytes
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects an oversized source before buffering it', () => {
    writeFileSync(join(templateDir, 'big.json'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => copyFileGuarded(join(templateDir, 'big.json'), join(work, 'staged', 'big.json')))
      .toThrow(/template_file_too_large/)
  })

  it('rejects a non-regular-file source (a directory)', () => {
    expect(() => copyFileGuarded(templateDir, join(work, 'staged', 'nope')))
      .toThrow(/template_not_regular_file/)
  })
})

// INTERFACES round-6 F2: the READ path needs the same guards as the COPY path. 06e's gallery
// validator reads REAL template sources (`seed.sql`, pages) — a raw `readFileSync` there would
// follow a symlinked `seed.sql` straight to ~/.ssh/id_rsa and print/validate its bytes.
describe('readFileGuarded (explicit single-file read — INTERFACES round-6 F2)', () => {
  it('returns the exact bytes of a regular file', () => {
    const bytes = Buffer.from('insert into company (name) values (\'Acme Corp\');\n')
    writeFileSync(join(templateDir, 'seed.sql'), bytes)
    const out = readFileGuarded(join(templateDir, 'seed.sql'))
    expect(out).toEqual(bytes)
    expect(out.toString('utf8')).toContain('Acme Corp')
  })

  it('rejects a symlinked source WITHOUT reading its target', () => {
    writeFileSync(join(work, 'secret'), 'ssh-key\n')
    const src = join(templateDir, 'seed.sql')
    symlinkSync(join(work, 'secret'), src) // a symlinked seed.sql in the template tree
    let msg = ''
    expect(() => {
      try { readFileGuarded(src) } catch (e) { msg = String(e); throw e }
    }).toThrow(/template_symlink_rejected/)
    // The throw fired on the lstat RESULT — the target was never opened, and the error carries the
    // path + reason only, never the target's bytes.
    expect(msg).toContain('seed.sql')
    expect(msg).not.toContain('ssh-key')
  })

  it('rejects a non-regular-file source (a directory)', () => {
    expect(() => readFileGuarded(templateDir)).toThrow(/template_not_regular_file/)
  })

  it('rejects an oversized source before buffering it', () => {
    writeFileSync(join(templateDir, 'big.sql'), 'x'.repeat(6 * 1024 * 1024))
    expect(() => readFileGuarded(join(templateDir, 'big.sql'))).toThrow(/template_file_too_large/)
  })
})
