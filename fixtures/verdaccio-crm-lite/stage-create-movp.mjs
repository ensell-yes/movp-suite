#!/usr/bin/env node
// C6d pack-harness staging (INTERFACES F1): assemble a create-movp publish tree in a TEMP dir. The
// `files` whitelist ships package.json + dist/ + templates/, so those are all we stage.
//
// This script READS and WRITES only paths derived from its two arguments — it never writes under the
// repo — which is exactly what lets the staging-safety test point `<repoRoot>` at a SYNTHETIC tree.
// The guards it applies are always the REAL ones: the dist import below is resolved relative to THIS
// file (fixtures/verdaccio-crm-lite/ → repo root), never relative to `<repoRoot>`.
//
// EVERY read here is guarded — the walks AND the single-file copy (F1a + F1b):
//   * `copyTreeGuarded` lstats every directory BEFORE readdir (the ROOT included, so a symlinked
//     `templates/crm-lite -> /external/dir` is REJECTED, not followed) and every entry before read.
//   * `copyFileGuarded` lstats `package.json` before reading it — a raw `copyFileSync` would follow
//     a symlinked package.json and pack whatever it points at.
// A symlinked/oversized input throws `template_symlink_rejected` / `template_file_too_large` WITHOUT
// reading the target, failing the pack. This script NEVER writes outside `stagingDir`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// The BUILT create-movp dist re-exports both guards — the exact functions `npm create movp` runs.
// This module path is fixed relative to THIS script (fixtures/verdaccio-crm-lite/ → repo root).
import { copyFileGuarded, copyTreeGuarded } from '../../packages/create-movp/dist/index.js'

const [repoRoot, stagingDir] = process.argv.slice(2)
if (!repoRoot || !stagingDir) {
  console.error('usage: stage-create-movp.mjs <repoRoot> <stagingDir>')
  process.exit(2)
}
const pkgDir = join(repoRoot, 'packages', 'create-movp')

mkdirSync(stagingDir, { recursive: true })
copyFileGuarded(join(pkgDir, 'package.json'), join(stagingDir, 'package.json'))
copyTreeGuarded(join(pkgDir, 'dist'), join(stagingDir, 'dist')) // own build output — guarded anyway
copyTreeGuarded(join(repoRoot, 'templates', 'crm-lite'), join(stagingDir, 'templates', 'crm-lite'))
console.log(`staged create-movp → ${stagingDir}`)
