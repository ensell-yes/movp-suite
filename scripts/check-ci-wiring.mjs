#!/usr/bin/env node
// The CI-wiring gate: proves each gate job below EXISTS in `.github/workflows/ci.yml` and INVOKES its
// required commands. A registered-but-never-run gate is a safety net that is never armed.
//
// SCOPE LIMIT — this is NOT a YAML parser and must never grow into one. It is an indentation-aware
// LINE SCAN with exactly one job: prove that each named job key exists under the top-level `jobs:`
// mapping, that each required NORMALIZED LINE appears INSIDE that job's own block, and that each
// required STEP GROUP appears inside a SINGLE step block of it (the ownership assertion, round-11 F1).
// An indentation-scoped EXACT-LINE match, chunked by list item, is still not a YAML parser — it is
// merely not restricted to `run:` lines. GitHub remains the authoritative YAML parser (a malformed
// workflow fails there, loudly). No YAML dependency is added: none is resolvable in this repo (`yaml`
// appears in the root `package.json` only as a pnpm override) and a new dependency needs approval. If
// you find yourself adding key/value lookups, path expressions, anchors, flow scalars, or block scalars
// here, STOP — the check has outgrown its purpose.
//
// It replaces a substring scan (`y.includes('publishable-versions:') && …`), which FALSE-GREENS when
// those strings appear only inside `#` comments or under an unrelated job (INTERFACES round-9 F2).
//
// Reads the workflow through `readTextGuarded` — never a raw `readFileSync`. A committed
// `.github/workflows/ci.yml -> ~/.aws/credentials` symlink would otherwise be followed and its bytes
// scanned (INTERFACES round-9 F1).
import { pathToFileURL } from 'node:url'
import { MAX_WORKFLOW_BYTES, readTextGuarded } from './lib/guarded-read.mjs'

/**
 * @typedef {object} JobRequirement
 * @property {string[]} runs Exact `run:` commands — the FULL command string, ARGUMENTS INCLUDED (`bash
 *   fixtures/verdaccio-gallery/pack.sh ./artifacts`, not `bash`) — that must appear as a `run:` step
 *   inside the job, at EITHER position: a list item (`- run: <cmd>`) or an indented property of a
 *   MULTI-KEY step (`- env:` / `ARTIFACTS_DIR: …` / `run: <cmd>`). Both normalize to `run: <cmd>`.
 *   Matching only the list-item form is what made the round-9 checker REJECT 06e's real `template-smoke`
 *   gate step — the checker rejecting the very workflow it verifies (round-10 F1).
 * @property {string[]} [lines] OPTIONAL exact NORMALIZED lines that must appear inside the job's OWN
 *   block — for JOB-LEVEL assertions that are neither a `run:` command nor a property of any step (06e's
 *   four-template matrix line lives under `strategy:`, outside every step). Anything that BELONGS to a
 *   step goes in `steps` instead — `lines` proves existence, not ownership.
 *   This is an EXACT LINE match, NOT a substring scan. The round-9 design used a block-scoped substring
 *   (`contains`), but `template-smoke` carries `2.109.1` TWICE — the real pin AND a `grep -qF '2.109.1'`
 *   drift check — so it PASSED with `version: latest`, satisfied purely by the grep argument. Shrinking
 *   the haystack does not turn a substring search into an assertion (round-10 F2).
 * @property {string[][]} [steps] OPTIONAL. Each inner array is a set of exact NORMALIZED lines that must
 *   ALL appear WITHIN A SINGLE STEP BLOCK of the job. This is the OWNERSHIP assertion (round-11 F1):
 *   `lines` is an unordered set match over the whole job block, so it proves `uses: supabase/setup-cli@v2`
 *   and `with: { version: 2.109.1 }` each occur SOMEWHERE in `template-smoke` — not that the `with:`
 *   belongs to that action. Supabase could run on `latest` while a DECOY step owns the pinned line, and
 *   `lines` still greens (reproduced). `steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']]`
 *   closes that.
 *   DELIBERATELY STEP-SCOPED, NOT STRICT ADJACENCY — do NOT "upgrade" this to a `sequences` field. Both
 *   were verified against the real YAML: adjacency catches the decoy too, but goes falsely RED as soon as
 *   anyone adds an `id:` or a `name:` to that step — and a gate that cries wolf gets disabled, after which
 *   it protects nothing. Step-scoping expresses the actual invariant ("the `with:` belongs to this step"),
 *   tolerates any step property (a test pins that), and is still a line scan.
 *   STILL WITHIN THE SCOPE LIMIT: an indentation-scoped exact-line match, step-chunked by list item, is
 *   not a YAML parser. Do NOT grow this into key/value lookups or anchor resolution.
 */

/**
 * THE shared CI-wiring table: job name → what that job MUST contain.
 * 06d OWNS this script and seeds the table; **later parts only APPEND an entry** (06e appends
 * `pack-artifacts` + `template-gallery` + `template-smoke`). Do NOT write a second CI-wiring checker —
 * one script, one table.
 * @type {Record<string, JobRequirement>}
 */
export const REQUIRED_JOBS = {
  'publishable-versions': {
    runs: ['pnpm test:version-gate', 'pnpm check:publishable-versions', 'pnpm check:ci-wiring'],
  },
  'c6-productization': {
    runs: [
      'pnpm --filter @movp/platform test',
      'bash fixtures/platform-consumer/gate.sh',
      'pnpm --filter @movp/cli test:built-runtime',
      'bash fixtures/verdaccio-crm-lite/gate.sh',
    ],
  },
  'c6-surface-wiring': {
    runs: [
      'pnpm --filter @movp/domain exec vitest run --config vitest.unit.config.ts',
      'pnpm --filter @movp/flows exec vitest run test/schema-injection.test.ts',
      'pnpm --filter @movp/flows exec vitest run test/embed-worker.test.ts test/embed-allowlist-drift.test.ts',
      'pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts',
      'pnpm --filter @movp/cli exec vitest run test/codegen-refusal.test.ts',
    ],
  },
  'c7-editor-sdk': {
    runs: ['pnpm --filter @movp/editor-sdk test', 'pnpm --filter @movp/richtext test'],
  },
  'pack-artifacts': {
    runs: ['bash fixtures/verdaccio-gallery/pack.sh ./artifacts'],
  },
  'template-gallery': {
    runs: [
      'pnpm --filter create-movp build',
      'pnpm exec tsx scripts/check-template-gallery.ts',
      'bash scripts/check-template-gallery-guards.sh',
    ],
  },
  'template-smoke': {
    runs: [
      "supabase --version | grep -qF '2.109.1'",
      "deno --version | head -n 1 | grep -qF 'deno 2.9.2'",
      'bash fixtures/verdaccio-gallery/gate.sh ${{ matrix.template }}',
    ],
    lines: ['template: [crm-lite, marketing-site, support-desk, knowledge-base]'],
    steps: [
      ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
      ['uses: denoland/setup-deno@v2', 'with: { deno-version: v2.9.2 }'],
      ['uses: actions/download-artifact@v5', 'with: { name: movp-tarballs, path: ./artifacts }'],
    ],
  },
}

export const DEFAULT_WORKFLOW = '.github/workflows/ci.yml'

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length

/**
 * Strip a trailing `#` comment, QUOTE-AWARE: a `#` inside `'…'` or `"…"` is a literal, not a comment, so
 * `- run: supabase --version | grep -qF '2.109.1'   # fail loud` keeps its quoted `'2.109.1'` INTACT.
 * (A naive `line.split('#')[0]` would truncate that run command and break the `runs` match.) Per YAML, a
 * comment `#` starts a comment only at line start or after whitespace — `a#b` is not a comment.
 * @param {string} line
 */
function stripComment(line) {
  /** @type {string | null} */
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Normalize a line for EXACT comparison: strip a trailing comment (quote-aware) → collapse runs of
 * whitespace → trim → strip a leading list-item `- `. That last step is what lets ONE form match a step
 * property at EITHER position: `- run: X` (list item) and a multi-key step's indented `run: X` both
 * normalize to `run: X` (round-10 F1), so a single `/^run: …/` match handles both.
 * @param {string} line
 */
const normalizeLine = (line) => stripComment(line).replace(/\s+/g, ' ').trim().replace(/^- /, '')

/** Strip surrounding quotes so `run: "pnpm x"` and `run: pnpm x` compare equal. @param {string} value */
function unquote(value) {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length >= 2 && value.at(-1) === first) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Split a job's RAW block lines into STEP CHUNKS of normalized lines — the unit the `steps` OWNERSHIP
 * requirement is matched against (round-11 F1).
 *
 * First locate the job-level `steps:` key, then bound its child block. A step begins at a direct `- `
 * list item inside that block; every deeper line belongs to that step until the next direct list item.
 * Anchoring on `steps:` matters: a block-style `strategy.matrix` or `needs` list may be the first list
 * item in the job, but it is not a step and must not determine the step indent.
 *
 * Comment-only lines are already dropped by the caller, so a comment sitting between `- uses:` and
 * `with:` cannot split a step.
 *
 * SCOPE LIMIT holds: chunking by list item is still a LINE SCAN, not YAML parsing. Do NOT grow it into one.
 * @param {string[]} rawJobLines
 * @returns {string[][]} one array of normalized lines per step
 */
function stepChunks(rawJobLines) {
  if (rawJobLines.length === 0) return []
  const jobPropertyIndent = Math.min(...rawJobLines.map(indentOf))
  const stepsIndex = rawJobLines.findIndex(
    (line) => indentOf(line) === jobPropertyIndent && stripComment(line).trim() === 'steps:',
  )
  if (stepsIndex === -1) return []

  const stepsIndent = indentOf(rawJobLines[stepsIndex])
  const stepLines = []
  for (let i = stepsIndex + 1; i < rawJobLines.length; i += 1) {
    if (indentOf(rawJobLines[i]) <= stepsIndent) break
    stepLines.push(rawJobLines[i])
  }
  const firstItem = stepLines.find((line) => /^\s*- /.test(line))
  if (firstItem === undefined) return []
  const stepIndent = indentOf(firstItem)

  /** @type {string[][]} */
  const chunks = []
  /** @type {string[] | null} */
  let current = null
  for (const raw of stepLines) {
    const indent = indentOf(raw)
    if (indent === stepIndent && /^\s*- /.test(raw)) {
      current = []
      chunks.push(current)
    } else if (current !== null && indent <= stepIndent) {
      current = null // a key at same-or-shallower indent ends the step sequence
    }
    if (current === null) continue
    const normalized = normalizeLine(raw)
    if (normalized !== '') current.push(normalized)
  }
  return chunks
}

/**
 * @param {string} [workflowPath]
 * @param {Record<string, JobRequirement>} [requiredJobs]
 * @returns {string[]} human-readable problems; `[]` means the gate passes. THROWS (`workflow_*`) if the
 *   workflow cannot be safely read.
 */
export function checkCiWiring(workflowPath = DEFAULT_WORKFLOW, requiredJobs = REQUIRED_JOBS) {
  const text = readTextGuarded(workflowPath, MAX_WORKFLOW_BYTES, 'workflow')

  // Strip comment-only and blank lines BEFORE any structural analysis. THE defect this closes: a
  // workflow whose entire gate job exists only as `#` comments passed the old substring scan with
  // exit 0 — the check that proves the gate is armed was itself a false green.
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))

  // The TOP-LEVEL `jobs:` mapping, at indent 0. GOTCHA: this repo's ci.yml also contains a job literally
  // NAMED `jobs:` at indent 2 (ci.yml:173) — matching on the trimmed text alone finds the WRONG one.
  const jobsIdx = lines.findIndex((line) => indentOf(line) === 0 && line.trim() === 'jobs:')
  if (jobsIdx === -1) {
    return [`ci_wiring_jobs_block_missing: ${workflowPath} has no top-level "jobs:" mapping`]
  }

  /** Every line of the `jobs:` mapping: up to the next top-level (indent 0) key. */
  const block = []
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    if (indentOf(lines[i]) === 0) break
    block.push(lines[i])
  }
  if (block.length === 0) {
    return [`ci_wiring_jobs_block_missing: ${workflowPath} has an empty "jobs:" mapping`]
  }

  // A job KEY is a bare `name:` line at the jobs mapping's own indent — not a substring anywhere.
  const jobIndent = indentOf(block[0])
  /** @type {string[]} */
  const problems = []

  for (const [jobName, requirement] of Object.entries(requiredJobs)) {
    /** @type {number[]} */
    const starts = []
    for (let i = 0; i < block.length; i += 1) {
      if (indentOf(block[i]) !== jobIndent) continue
      const key = block[i].trim().match(/^([A-Za-z0-9_.-]+):$/)
      if (key !== null && key[1] === jobName) starts.push(i)
    }

    if (starts.length === 0) {
      problems.push(
        `ci_wiring_job_missing: ${workflowPath} has no "${jobName}:" job under "jobs:" (a job name in a comment or a substring elsewhere does NOT count)`,
      )
      continue
    }
    if (starts.length > 1) {
      // Duplicate keys are a YAML error GitHub would reject; never silently pick one and pass.
      problems.push(
        `ci_wiring_job_duplicated: ${workflowPath} declares the "${jobName}:" job ${starts.length} times`,
      )
      continue
    }

    // The job's OWN block, NORMALIZED. Bounded by the next key at the same-or-shallower indent, so a
    // `run:` (or any other line) in a NEIGHBOURING job is outside it — which is the whole point.
    // Comment-only lines were dropped above, so a commented-out line is outside it too.
    /** @type {string[]} */
    const jobRaw = []
    for (let i = starts[0] + 1; i < block.length && indentOf(block[i]) > jobIndent; i += 1) {
      jobRaw.push(block[i])
    }
    // RAW is kept alongside NORMALIZED: `stepChunks` needs the original indentation to find step
    // boundaries, and normalizing first would destroy it (`normalizeLine` trims).
    const jobLines = jobRaw.map(normalizeLine)

    // A `run:` step at EITHER position: `- run: X` (list item) and a multi-key step's indented `run: X`
    // BOTH normalize to `run: X`, so ONE match handles both (round-10 F1). The matched command is the
    // FULL string, arguments included — `bash fixtures/verdaccio-gallery/pack.sh ./artifacts`.
    /** @type {Set<string>} */
    const runs = new Set()
    for (const line of jobLines) {
      const run = line.match(/^run:\s+(.+)$/)
      if (run !== null) runs.add(unquote(run[1].trim()))
    }
    for (const command of requirement.runs) {
      if (!runs.has(command)) {
        problems.push(
          `ci_wiring_run_missing: ${workflowPath} job "${jobName}" does not invoke \`${command}\` (expected an exact \`run: ${command}\` step inside that job — as \`- run:\` or as a multi-key step's \`run:\` property)`,
        )
      }
    }

    // `lines`: an EXACT match against a NORMALIZED line of the job's block — NEVER a substring scan.
    // A substring scan is exactly what round-10 F2 removed: `template-smoke` carries `2.109.1` TWICE
    // (the real pin AND a `grep -qF '2.109.1'` drift check), so `jobText.includes('2.109.1')` passed
    // even with `version: latest`. Requiring the exact line `with: { version: 2.109.1 }` cannot be
    // satisfied by a comment, by a grep argument, or by another job.
    const jobLineSet = new Set(jobLines)
    for (const required of requirement.lines ?? []) {
      if (!jobLineSet.has(required)) {
        problems.push(
          `ci_wiring_line_missing: ${workflowPath} job "${jobName}" has no line \`${required}\` (an EXACT normalized line inside THAT job's block — a substring, a comment, a grep argument, or a match in another job does NOT count)`,
        )
      }
    }

    // `steps`: OWNERSHIP, not existence (round-11 F1). The `lines` check above is an unordered set match
    // over the WHOLE job block, so it cannot tell `with: { version: 2.109.1 }` OWNED by
    // `uses: supabase/setup-cli@v2` apart from the same line owned by a DECOY action while setup-cli runs
    // on `latest`. Every line of a `steps` group must land inside ONE step chunk.
    // NOT strict adjacency, deliberately — do NOT "upgrade" this: adjacency catches the decoy too, but
    // goes falsely RED the moment a step gains an `id:` or a `name:`, and a gate that cries wolf gets
    // disabled, after which it protects nothing. A test pins the `id:`/`name:` tolerance.
    const chunks = stepChunks(jobRaw)
    for (const required of requirement.steps ?? []) {
      const owned = chunks.some((chunk) => required.every((line) => chunk.includes(line)))
      if (!owned) {
        const wanted = required.map((line) => `\`${line}\``).join(', ')
        problems.push(
          `ci_wiring_step_missing: ${workflowPath} job "${jobName}" has no single step containing all of [${wanted}] (each line may EXIST somewhere in the job while belonging to a DIFFERENT step — that is not ownership)`,
        )
      }
    }
  }

  return problems
}

// Exit-code contract: 0 = every required job is armed · 1 = a real finding (a job, a `run:`, a required
// `lines` entry, or a required `steps` group is missing/duplicated) · 2 = OPERATIONAL failure (the
// workflow is a symlink, oversized, or unreadable). An operational failure is NEVER 0 — automation reads
// the code.
//
// GOTCHA: guard `process.argv[1]` before `pathToFileURL` — it is UNDEFINED when this module is imported
// from an eval context (`node -e`, the REPL), and `pathToFileURL(undefined)` THROWS `ERR_INVALID_ARG_TYPE`
// at import time. That turns a library import into a crash. (Hit for real while verifying this plan.)
const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  const workflowPath = process.argv[2] ?? DEFAULT_WORKFLOW
  /** @type {string[]} */
  let problems
  try {
    problems = checkCiWiring(workflowPath)
  } catch (err) {
    console.error(
      `ci-wiring gate: OPERATIONAL FAILURE — ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
  const names = Object.keys(REQUIRED_JOBS)
  console.log(`ci wiring: ${names.length} gate job(s) armed in ${workflowPath} — ${names.join(', ')}`)
}
