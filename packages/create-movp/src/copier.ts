import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024
export const TOKEN_PATTERN = /__[A-Z0-9_]+__/g

const PROJECT_NAME = /^[a-z][a-z0-9-]*$/

// Directories that are build/cache output and must never be copied into a fresh scaffold.
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', '.turbo', '.wrangler'])

// Extension allowlist for SUBSTITUTABLE text files. Anything else that is allowlisted-binary is
// copied byte-for-byte; anything not allowlisted at all is skipped.
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro', '.json', '.jsonc', '.sql',
  '.md', '.css', '.html', '.txt', '.toml', '.yaml', '.yml',
])
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2'])
// Exact filenames (no extension) that are still text and allowlisted.
const TEXT_NAMES = new Set(['.gitignore', '.npmrc', '.assetsignore', '.nvmrc'])

export interface CopyOptions {
  templateDir: string
  targetDir: string
  tokens: Record<string, string>
}

class CopierError extends Error {
  constructor(code: string, detail: string) {
    // NEVER include file CONTENTS — path + reason only (untrusted-io content discipline).
    super(`${code}: ${detail}`)
    this.name = 'CopierError'
  }
}

export function resolveTargetDir(parentDir: string, projectName: string): string {
  if (!PROJECT_NAME.test(projectName) || projectName.includes('..')) {
    throw new CopierError('invalid_project_name', `"${projectName}" must match ${PROJECT_NAME}`)
  }
  const target = resolve(parentDir, projectName)
  // Defence in depth: the resolved path must stay a direct child of the parent.
  if (target !== join(parentDir, projectName) || !target.startsWith(resolve(parentDir) + sep)) {
    throw new CopierError('invalid_project_name', `"${projectName}" escapes the parent directory`)
  }
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing) throw new CopierError('target_exists', target)
  return target
}

// GOTCHA (INTERFACES F1a) — `readdirSync` FOLLOWS symlinks. Calling it on an unvalidated directory
// walks straight through a symlinked ROOT (`templates/crm-lite -> /external/dir`) and reads a tree
// outside the project. So EVERY directory is lstat'd BEFORE it is readdir'd — the initial root AND
// every recursed subdirectory. `lstatSync` throws ENOENT for a missing dir (loud, same as readdir).
// The rejection carries the PATH only — never the target's contents.
function assertRealDir(absDir: string, rel: string): void {
  const info = lstatSync(absDir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CopierError('template_symlink_rejected', rel)
  }
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function isBinaryBuffer(buf: Buffer): boolean {
  // A NUL byte in the first 8KB marks the file as binary (skip substitution).
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true
  return false
}

function substitute(text: string, tokens: Record<string, string>, relPath: string): string {
  const out = text.replace(TOKEN_PATTERN, (match) => {
    const value = tokens[match]
    if (value === undefined) throw new CopierError('unresolved_token', `${relPath} contains ${match}`)
    return value
  })
  // Belt-and-suspenders: no token-shaped residue may survive (a token that wasn't declared).
  const residue = out.match(TOKEN_PATTERN)
  if (residue) throw new CopierError('unresolved_token', `${relPath} still contains ${residue[0]}`)
  return out
}

export function copyTemplate(opts: CopyOptions): { filesWritten: number; bytesWritten: number } {
  for (const key of Object.keys(opts.tokens)) {
    if (!/^__[A-Z0-9_]+__$/.test(key)) throw new CopierError('unknown_token', `token key "${key}" is not __NAME__ shaped`)
  }

  let filesWritten = 0
  let bytesWritten = 0

  const walk = (relDir: string): void => {
    const absDir = join(opts.templateDir, relDir)
    // lstat BEFORE readdir — the ROOT (relDir === '') and every recursed subdirectory (F1a).
    assertRealDir(absDir, relDir || '.')
    for (const entry of readdirSync(absDir).sort()) {
      const rel = relDir ? join(relDir, entry) : entry
      const abs = join(absDir, entry)
      // lstat BEFORE any stat/read: a symlink in the template could point at ~/.ssh/id_rsa.
      const info = lstatSync(abs)
      if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', rel)
      if (info.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue
        walk(rel)
        continue
      }
      if (!info.isFile()) continue

      const ext = extname(entry)
      const isText = TEXT_EXTS.has(ext) || TEXT_NAMES.has(entry)
      const isBinary = BINARY_EXTS.has(ext)
      if (!isText && !isBinary) continue // not allowlisted → skip (fonts, unknown blobs)

      // Bound BEFORE buffering: reject an oversized file without reading it into memory.
      if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', rel)
      if (bytesWritten + info.size > MAX_TOTAL_BYTES) throw new CopierError('template_total_too_large', rel)

      const buf = readFileSync(abs)
      mkdirSync(join(opts.targetDir, relDir), { recursive: true })
      const outPath = join(opts.targetDir, rel)
      if (isBinary || isBinaryBuffer(buf)) {
        writeFileSync(outPath, buf) // byte-for-byte; NEVER substitute a binary
      } else {
        writeFileSync(outPath, substitute(buf.toString('utf8'), opts.tokens, rel))
      }
      filesWritten += 1
      bytesWritten += info.size
    }
  }

  // walk() validates the ROOT before its readdir, so a rejected root creates NOTHING. The trailing
  // mkdir only guarantees the (possibly empty) target exists once the source is known-good.
  walk('')
  mkdirSync(opts.targetDir, { recursive: true })
  return { filesWritten, bytesWritten }
}

// VERBATIM guarded tree copy — the SAME untrusted-io guards as `copyTemplate` (lstat-before-read
// symlink rejection, excluded-dir skip, per-file + running-total size bounds, path+reason-only
// errors) but NO token substitution and NO extension allowlist: it copies every regular file
// byte-for-byte. Used by the PACK harness (INTERFACES F1) to materialize `templates/` into a TEMP
// staging tree so the published tarball ships the template source intact (a `package.json.template`
// stays verbatim; the runtime `copyTemplate` above renames + substitutes at `npm create movp` time)
// AND a symlinked template file makes the pack FAIL loudly instead of being packed. Reusing this one
// function keeps the guards shared — the pack script never reimplements them in bash.
export function copyTreeGuarded(srcDir: string, destDir: string): { filesCopied: number; bytesCopied: number } {
  let filesCopied = 0
  let bytesCopied = 0

  const walk = (relDir: string): void => {
    const absDir = join(srcDir, relDir)
    // lstat BEFORE readdir — the ROOT (relDir === '') and every recursed subdirectory (F1a). The pack
    // harness passes `templates/crm-lite` in from a shell script; a symlinked root must FAIL the pack,
    // not silently pack an external tree.
    assertRealDir(absDir, relDir || '.')
    for (const entry of readdirSync(absDir).sort()) {
      const rel = relDir ? join(relDir, entry) : entry
      const abs = join(absDir, entry)
      // lstat BEFORE any stat/read: a symlink in the tree could point at ~/.ssh/id_rsa. The throw
      // fires on the lstat result — the target is NEVER opened or read.
      const info = lstatSync(abs)
      if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', rel)
      if (info.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry)) continue
        walk(rel)
        continue
      }
      if (!info.isFile()) continue
      // Bound BEFORE buffering.
      if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', rel)
      if (bytesCopied + info.size > MAX_TOTAL_BYTES) throw new CopierError('template_total_too_large', rel)

      const buf = readFileSync(abs)
      mkdirSync(join(destDir, relDir), { recursive: true })
      writeFileSync(join(destDir, rel), buf) // byte-for-byte; NO substitution, NO `.template` rename
      filesCopied += 1
      bytesCopied += info.size
    }
  }

  // walk() validates the ROOT before its readdir, so a rejected root creates NOTHING in destDir.
  walk('')
  mkdirSync(destDir, { recursive: true })
  return { filesCopied, bytesCopied }
}

// Guarded EXPLICIT single-file copy. The tree walks above are not the only read path: the pack
// harness also copies individual files (`packages/create-movp/package.json`) one at a time. A raw
// `copyFileSync`/`readFileSync` there FOLLOWS a symlink — a symlinked `package.json` would be read
// and packed into the published tarball. Every explicit one-off copy in a staging script goes
// through THIS function (INTERFACES F1b): lstat first, reject symlink/non-regular-file, bound the
// size BEFORE the read, then write. Path + reason only in every error — never the source bytes.
export function copyFileGuarded(src: string, dest: string): { bytesCopied: number } {
  // lstat BEFORE any stat/read — the throw fires on the lstat RESULT, so the target of a symlinked
  // `src` is NEVER opened. `lstatSync` throws ENOENT if `src` is absent (loud, not silent).
  const info = lstatSync(src)
  if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', src)
  if (!info.isFile()) throw new CopierError('template_not_regular_file', src)
  // Bound BEFORE buffering: an oversized file is rejected without being read into memory.
  if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', src)

  const buf = readFileSync(src)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf) // byte-for-byte; NO substitution
  return { bytesCopied: buf.length }
}

// Guarded EXPLICIT single-file READ — the read-only half of `copyFileGuarded` (INTERFACES round-6 F2).
// Copying is not the only read path: 06e's `scripts/check-template-gallery.ts` READS real template
// sources (`seed.sql`, every Astro page) to validate them. A raw `readFileSync` there FOLLOWS a
// symlink — a symlinked `seed.sql -> ~/.ssh/id_rsa` would be read (and its bytes surfaced in a
// validation error) by the very tool that is supposed to police the templates. A guard on the copy
// path but not the read path is not a guard. Every explicit one-off read of a template source goes
// through THIS function; callers do `.toString('utf8')`.
export function readFileGuarded(src: string): Buffer {
  // lstat BEFORE any stat/read — the throw fires on the lstat RESULT, so the target of a symlinked
  // `src` is NEVER opened. `lstatSync` throws ENOENT if `src` is absent (loud, not silent).
  const info = lstatSync(src)
  if (info.isSymbolicLink()) throw new CopierError('template_symlink_rejected', src)
  if (!info.isFile()) throw new CopierError('template_not_regular_file', src)
  // Bound BEFORE buffering: an oversized file is rejected without being read into memory.
  if (info.size > MAX_FILE_BYTES) throw new CopierError('template_file_too_large', src)

  return readFileSync(src) // path + reason in every error above — never these bytes
}
