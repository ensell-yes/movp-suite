#!/usr/bin/env node
// The publishable-version gate. It runs BEFORE anything is built, so it is dependency-free ESM and
// imports only `scripts/lib/` — never a package's `dist/` (see the note in `lib/guarded-read.mjs`).
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJsonGuarded } from './lib/guarded-read.mjs'

/** The set Verdaccio publishes and scaffolds pin at ^0.1.0. `mcp-bridge` is private/unpublished and
 *  intentionally excluded (it stays 0.0.0). */
export const PUBLISHABLE = [
  'auth', 'cli', 'codegen', 'core-schema', 'domain', 'flows',
  'graphql', 'mcp', 'notifications', 'obs', 'platform', 'search',
]
export const EXPECTED_VERSION = '0.1.0'
/** POSIX ERE for `git grep -E`. `workspace:*` is fine — only a literal 0.0.0 version pin is a hit. */
export const ZERO_PIN_PATTERN = '"@movp/[a-z-]+":[[:space:]]*"0\\.0\\.0"'
// GOTCHA: scope the grep to MANIFESTS. An UNSCOPED `git grep` over the worktree also matches this
// gate's OWN test fixtures and any doc/plan prose quoting the pattern — the gate would fail on itself.
// Verified against the current tree: this pathspec covers the root manifest, every
// `packages/<name>/package.json`, and every `templates/<name>/package.json[.template]` — and nothing else.
export const MANIFEST_PATHSPEC = ['*package.json', '*package.json.template']

/** @param {string} repoRoot @returns {import('node:child_process').SpawnSyncReturns<string>} */
export function runGitGrep(repoRoot) {
  // `spawnSync` (NOT `execFileSync`): it RETURNS `{ status, stdout, stderr, error }` instead of
  // throwing, which is what lets the caller tell "no match" (1) apart from "git broke" (128/ENOENT).
  return spawnSync('git', ['grep', '-nE', ZERO_PIN_PATTERN, '--', ...MANIFEST_PATHSPEC], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

/**
 * @param {string} repoRoot
 * @param {(repoRoot: string) => import('node:child_process').SpawnSyncReturns<string>} [runGit]
 * @returns {string[]} the `path:line:text` hits; `[]` when git found nothing. THROWS if git failed.
 */
export function pinnedZeroConsumers(repoRoot, runGit = runGitGrep) {
  const result = runGit(repoRoot)
  // Fail HARD and LOUD on an operational failure. A bare `catch { return [] }` here would report
  // "no 0.0.0 pins" when git is absent or the cwd is not a repo — a broken gate that PASSES.
  if (result.error) {
    throw new Error(
      `version_gate_git_failed: git grep could not run in ${repoRoot} (${result.error.code ?? result.error.message})`,
    )
  }
  if (result.status === 0) return result.stdout.trim().split('\n').filter(Boolean) // matches
  if (result.status === 1) return [] // no matches — the ONLY benign non-zero status
  throw new Error(
    `version_gate_git_failed: git grep in ${repoRoot} exited status=${result.status} signal=${result.signal ?? 'none'}`,
  )
}

/**
 * @param {string} repoRoot
 * @param {(repoRoot: string) => import('node:child_process').SpawnSyncReturns<string>} [runGit]
 * @returns {string[]} human-readable problems; `[]` means the gate passes. THROWS on an operational failure.
 */
export function checkPublishableVersions(repoRoot, runGit = runGitGrep) {
  /** @type {string[]} */
  const problems = []
  for (const name of PUBLISHABLE) {
    // readJsonGuarded, NEVER `JSON.parse(readFileSync(...))`: these twelve paths are worktree files, and
    // a symlinked one would be followed straight out of the repo — with the parse error printing its bytes.
    const pkg = readJsonGuarded(join(repoRoot, 'packages', name, 'package.json'))
    if (pkg.version !== EXPECTED_VERSION) {
      problems.push(`version check failed: ${pkg.name} is ${pkg.version}, expected ${EXPECTED_VERSION}`)
    }
  }
  for (const line of pinnedZeroConsumers(repoRoot, runGit)) {
    problems.push(`consumer pins a @movp dependency at 0.0.0: ${line}`)
  }
  return problems
}

// Exit-code contract: 0 = pass · 1 = a real finding (wrong version / a 0.0.0 pin) · 2 = OPERATIONAL
// failure (git broke, a manifest is a symlink/oversized/malformed). An operational failure is never 0.
//
// GOTCHA: `process.argv[1]` is `undefined` when this module is IMPORTED from an eval context
// (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE` — turning a
// library import into a crash. Guard it. (Hit for real while verifying this plan; all three scripts
// here — this one, `tree-snapshot.mjs`, and `check-ci-wiring.mjs` — use the identical idiom.)
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  /** @type {string[]} */
  let problems
  try {
    problems = checkPublishableVersions(process.cwd())
  } catch (err) {
    console.error(
      `publishable-version gate: OPERATIONAL FAILURE — ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  console.log(
    `publishable versions: all ${PUBLISHABLE.length} @movp publishables at ${EXPECTED_VERSION}, no 0.0.0 consumer pins`,
  )
}
