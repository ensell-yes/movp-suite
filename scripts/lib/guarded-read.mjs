// The guarded file readers for repo-root gates. Dependency-free ESM with NO build step, on purpose:
// `check-publishable-versions.mjs` and `check-ci-wiring.mjs` run BEFORE anything is built, so they
// cannot import a package's compiled `dist/`.
//
// `readTextGuarded` is THE primitive: every repo-root gate that reads a worktree file goes through it
// (or through `readJsonGuarded`, which is built ON TOP of it). There is exactly ONE lstat/size-bound
// implementation here — a guard that sits BESIDE a raw `readFileSync` is not a guard (INTERFACES
// round-9 F1: the ci.yml shape assertion was originally added with a raw `readFileSync` one line after
// `readJsonGuarded` was built for exactly that hazard).
//
// DELIBERATELY NOT the same implementation as `create-movp`'s `readFileGuarded`
// (`packages/create-movp/src/copier.ts`, Task 2), and the two must NOT be "consolidated" (INTERFACES
// round-7 F2). `create-movp` is a PUBLISHED npm package: it cannot import repo-root `scripts/` (those
// files are not in its tarball), and a repo-root gate cannot import `create-movp`'s build output
// (nothing is built when the gate runs). Consolidating them creates an import cycle or a broken
// publish. Two module boundaries — one guard each, same semantics.
import { lstatSync, readFileSync } from 'node:fs'

/** A `package.json` is a few KiB. 256 KiB is generous and still BOUNDS the buffer. */
export const MAX_MANIFEST_BYTES = 256 * 1024
/** A workflow is a few KiB (this repo's `ci.yml` is ~7 KiB). 1 MiB is generous and still BOUNDS it. */
export const MAX_WORKFLOW_BYTES = 1024 * 1024

/** @typedef {{ name: string, version: string } & Record<string, unknown>} PackageManifest */

/**
 * Read a UTF-8 text file from an UNTRUSTED path (a worktree file anyone may have committed as a
 * symlink). Throws `<codePrefix>_*` (path + reason ONLY — never the file's bytes).
 *
 * `codePrefix` keeps each caller's error-code set closed and self-describing: `readJsonGuarded` passes
 * `'manifest'` (preserving its `manifest_*` codes), `check-ci-wiring.mjs` passes `'workflow'`, and the
 * default `'file'` reads correctly for any other repo file.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @param {string} [codePrefix]
 * @returns {string}
 */
export function readTextGuarded(path, maxBytes, codePrefix = 'file') {
  // GOTCHA: `lstat` FIRST, and throw on the lstat RESULT — `statSync` and `readFileSync` both FOLLOW
  // symlinks, so a symlinked file pointing at ~/.aws/credentials would already be OPEN by the time any
  // later check ran. A basename denylist cannot help: the symlink is named `package.json` / `ci.yml`.
  /** @type {import('node:fs').Stats} */
  let info
  try {
    info = lstatSync(path)
  } catch {
    // The `<codePrefix>_*` code set is CLOSED. A raw `ENOENT`/`EACCES` from `lstatSync` would escape it
    // — a deleted/renamed file or a CI permissions problem is a plausible real state, not a crash.
    // Bare `catch` (NO error binding), so no errno message — which can name paths outside the repo —
    // can be interpolated: the leak is unrepresentable, not merely discouraged.
    throw new Error(`${codePrefix}_unreadable: ${path} cannot be inspected`)
  }
  if (info.isSymbolicLink()) throw new Error(`${codePrefix}_symlink_rejected: ${path} is a symlink`)
  if (!info.isFile()) throw new Error(`${codePrefix}_not_regular_file: ${path} is not a regular file`)
  // Bound BEFORE buffering: a cap applied after `readFileSync` cannot prevent the OOM it exists to stop.
  if (info.size > maxBytes) {
    throw new Error(`${codePrefix}_too_large: ${path} is ${info.size} bytes (max ${maxBytes})`)
  }

  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Same closed-set discipline as the `lstat` above. This reason is DISTINCT from the JSON-parse
    // case's "is not valid JSON": conflating "cannot be read" with "is not valid JSON" destroys the
    // diagnostic — one is an I/O fault, the other a content fault, with different remedies.
    throw new Error(`${codePrefix}_unreadable: ${path} cannot be read`)
  }
}

/**
 * Read + parse a `package.json` from an UNTRUSTED path. Built ON TOP of `readTextGuarded` — the
 * lstat/symlink/size logic lives in ONE place, not two. Throws `manifest_*` (path + reason ONLY).
 * @param {string} path
 * @returns {PackageManifest}
 */
export function readJsonGuarded(path) {
  const raw = readTextGuarded(path, MAX_MANIFEST_BYTES, 'manifest')

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // GOTCHA (the entire reason this catch exists): Node's `JSON.parse` error message EMBEDS a snippet
    // of the input — `Unexpected token 'a', "aws_secret"... is not valid JSON`. Re-throwing it, or
    // interpolating `err.message`, prints the file's CONTENT into CI logs — the very leak the `lstat`
    // in `readTextGuarded` closes on the happy path. Throw the path + a reason. NEVER the bytes.
    throw new Error(`manifest_unreadable: ${path} is not valid JSON`)
  }

  // Structurally validate BEFORE any field is dereferenced — parseable is not valid, and a cast is not
  // validation. A malformed-but-parseable manifest throws here; it never reaches the version compare.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`manifest_invalid_shape: ${path} is not a JSON object`)
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof obj.name !== 'string') {
    throw new Error(`manifest_invalid_shape: ${path} has no string "name"`)
  }
  if (typeof obj.version !== 'string') {
    throw new Error(`manifest_invalid_shape: ${path} has no string "version"`)
  }
  return /** @type {PackageManifest} */ (parsed)
}
