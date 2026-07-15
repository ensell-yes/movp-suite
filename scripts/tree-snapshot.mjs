#!/usr/bin/env node
// THE shared staging-safety snapshot (INTERFACES F2). C6d OWNS it; C6d's `gate.sh` + copier tests and
// C6e's template fixtures all consume THIS file — do not fork a second snapshot implementation.
//
// It emits a deterministic, path-sorted content-hash manifest of the SOURCE subtrees a pack/stage step
// reads, so a caller can diff a BEFORE against an AFTER and assert "staging MUTATED nothing" — never
// "the worktree is pristine" (a developer's unrelated WIP edits and untracked files are legitimate,
// appear in BOTH manifests, and must survive).
//
// Invariants, each closing a real failure mode:
//   * BOUNDED memory — every file is hashed by STREAMING it in 64 KiB chunks (`createReadStream` +
//     `createHash`). NEVER `readFileSync`: a large untracked file (a stray pg_dump under templates/)
//     would OOM the very gate that exists to tolerate a dirty worktree.
//   * `lstat`, NEVER `stat` — a symlink is recorded by its target STRING and never followed or read,
//     so the snapshot cannot become the exfiltration path the copier's guards close.
//   * Content is NEVER printed — a line carries a path + a sha256 only; the diff goes to CI logs.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The subtrees a `create-movp` pack/stage step reads. Everything else is out of scope. */
export const DEFAULT_ROOTS = ['packages/create-movp', 'templates']
/** Volatile, and never written by staging: hashing them is slow and flaky, not safer. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo'])
/** Hash chunk size. Peak memory is bounded by THIS, not by the file's size. */
const CHUNK_BYTES = 64 * 1024

/** @param {string} abs @returns {Promise<string>} sha256 — streamed, never buffers the whole file. */
async function hashFile(abs) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs, { highWaterMark: CHUNK_BYTES })) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * @param {string} root absolute path of the tree to snapshot (the real repo, or a synthetic one)
 * @param {string[]} [roots] subtrees of `root` to include (`['.']` = the whole tree)
 * @returns {Promise<string>} sorted `<kind> <sha256|target|-> <relpath>` lines, newline-terminated
 */
export async function snapshotTree(root, roots = DEFAULT_ROOTS) {
  /** @type {string[]} */
  const lines = []
  /** @param {string} rel */
  const walk = async (rel) => {
    for (const entry of (await readdir(join(root, rel))).sort()) {
      const childRel = join(rel, entry)
      const abs = join(root, childRel)
      const info = await lstat(abs) // lstat, never stat — see header
      if (info.isSymbolicLink()) {
        lines.push(`symlink ${await readlink(abs)} ${childRel}`)
        continue
      }
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        lines.push(`dir - ${childRel}`)
        await walk(childRel)
        continue
      }
      if (!info.isFile()) {
        lines.push(`other - ${childRel}`)
        continue
      }
      lines.push(`file ${await hashFile(abs)} ${childRel}`)
    }
  }
  for (const rel of roots) {
    const abs = join(root, rel)
    const info = await lstat(abs).catch(() => null)
    if (!info) {
      lines.push(`absent - ${rel}`) // an absent root is a legal, STABLE state, not an error
      continue
    }
    if (info.isSymbolicLink()) {
      lines.push(`symlink ${await readlink(abs)} ${rel}`)
      continue
    }
    lines.push(`dir - ${rel}`)
    await walk(rel)
  }
  return `${lines.join('\n')}\n`
}

// CLI: `<root> [outFile]` (INTERFACES round-6 F1). `outFile` is OPTIONAL — 06d's `gate.sh` passes one
// (`... "$REPO_ROOT" "$WORK/snapshot-before.txt"`); 06e's six call sites pass `<root>` only and
// redirect stdout. Both forms have real consumers and BOTH must emit byte-identical bytes.
// GOTCHA: use `process.stdout.write`, NEVER `console.log` — console.log appends a trailing newline
// that the file form does not write, so the two forms would differ by one byte and the diff-based
// gates that compare a piped manifest against a written one would fail spuriously.
//
// GOTCHA: `process.argv[1]` is `undefined` when this module is IMPORTED from an eval context
// (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE` — turning a
// library import into a crash. 06e imports `snapshotTree` from this file, so the guard is load-bearing.
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  const [root, outFile] = process.argv.slice(2)
  if (!root) {
    console.error('usage: tree-snapshot.mjs <root> [outFile]')
    process.exit(2)
  }
  const manifest = await snapshotTree(root)
  if (outFile) await writeFile(outFile, manifest)
  else process.stdout.write(manifest)
}
