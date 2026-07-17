import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MAX_WORKFLOW_BYTES } from '../lib/guarded-read.mjs'
import { REQUIRED_JOBS, checkCiWiring } from '../check-ci-wiring.mjs'

const SEED_REQUIREMENT = {
  'publishable-versions': REQUIRED_JOBS['publishable-versions'],
}

// Synthetic fixtures under $TMPDIR only. NO writes under the real repository (INTERFACES round-5 F1);
// the checker takes the workflow path as an argument so the hostile cases point at a temp file.
let work = ''
before(() => { work = mkdtempSync(join(tmpdir(), 'movp-ci-wiring-')) })
after(() => rmSync(work, { recursive: true, force: true }))

/** Write a fixture workflow and return its path. @param {string} name @param {string} yaml */
const fixture = (name, yaml) => {
  const path = join(work, `${name}.yml`)
  writeFileSync(path, yaml)
  return path
}

const ARMED_JOB = `
  publishable-versions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:version-gate
      - run: pnpm check:publishable-versions
      - run: pnpm check:ci-wiring
`

/** The real ci.yml shape: a top-level `jobs:`, a neighbouring job, and a job literally NAMED `jobs`. */
const GOOD = `name: ci
on:
  push:
    branches: [main]

jobs:
  package-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: pnpm check:packages
${ARMED_JOB}
  jobs:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:jobs
`

describe('checkCiWiring — the intended workflow', () => {
  it('PASSES: the job exists under jobs: and invokes every required command', () => {
    assert.deepEqual(checkCiWiring(fixture('good', GOOD), SEED_REQUIREMENT), [])
  })

  // The real ci.yml contains a job literally NAMED `jobs:` (ci.yml:173). Matching the trimmed text
  // alone would anchor on it and scan the wrong block.
  it('anchors on the TOP-LEVEL jobs: mapping, not a job named "jobs"', () => {
    const noTopLevel = GOOD.replace(/^jobs:$/m, 'not-jobs:')
    const problems = checkCiWiring(fixture('no-jobs', noTopLevel), SEED_REQUIREMENT)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_jobs_block_missing/)
  })
})

describe('checkCiWiring — C6 productization gates stay armed', () => {
  const workflow = `name: ci
on: [push]
jobs:
  c6-productization:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/platform test
      - run: bash fixtures/platform-consumer/gate.sh
      - run: pnpm --filter @movp/cli test:built-runtime
      - run: bash fixtures/verdaccio-crm-lite/gate.sh
  c6-surface-wiring:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/domain exec vitest run --config vitest.unit.config.ts
      - run: pnpm --filter @movp/flows exec vitest run test/schema-injection.test.ts
      - run: pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts
      - run: pnpm --filter @movp/cli exec vitest run test/codegen-refusal.test.ts
`

  it('fails when a load-bearing C6 productization invocation is removed', () => {
    assert.ok(REQUIRED_JOBS['c6-productization'])
    assert.ok(REQUIRED_JOBS['c6-surface-wiring'])
    const withoutConsumerGate = workflow.replace('      - run: bash fixtures/platform-consumer/gate.sh\n', '')
    const problems = checkCiWiring(fixture('c6-consumer-gate-missing', withoutConsumerGate), {
      'c6-productization': REQUIRED_JOBS['c6-productization'],
      'c6-surface-wiring': REQUIRED_JOBS['c6-surface-wiring'],
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .* job "c6-productization" does not invoke `bash fixtures\/platform-consumer\/gate\.sh`/)
  })
})

describe('checkCiWiring — the C7 editor SDK gate stays armed', () => {
  const workflow = `name: ci
on: [push]
jobs:
  c7-editor-sdk:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/editor-sdk test
`

  it('registers the job and fails when its package test invocation is removed', () => {
    const requirement = REQUIRED_JOBS['c7-editor-sdk']
    assert.ok(requirement)
    assert.deepEqual(checkCiWiring(fixture('c7-editor-sdk', workflow), {
      'c7-editor-sdk': requirement,
    }), [])

    const withoutPackageTests = workflow.replace(
      '      - run: pnpm --filter @movp/editor-sdk test\n',
      '',
    )
    const problems = checkCiWiring(fixture('c7-editor-sdk-missing-tests', withoutPackageTests), {
      'c7-editor-sdk': requirement,
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .*pnpm --filter @movp\/editor-sdk test/)
  })
})

describe('checkCiWiring — hostile workflows that MUST fail (each false-greened the substring scan)', () => {
  // THE reproduced defect: `y.includes('publishable-versions:')` is true for a COMMENTED-OUT job.
  it('FAILS: the job and its commands appear ONLY inside # comments', () => {
    const commented = GOOD.replace(ARMED_JOB, `${ARMED_JOB.replace(/^(.*)$/gm, '#$1')}\n`)
    const problems = checkCiWiring(fixture('comments-only', commented), SEED_REQUIREMENT)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_missing: .* has no "publishable-versions:" job/)
  })

  it('FAILS: the right commands live under a DIFFERENT job', () => {
    const wrongJob = GOOD.replace(
      ARMED_JOB,
      `
  publishable-versions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

  some-other-job:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:version-gate
      - run: pnpm check:publishable-versions
      - run: pnpm check:ci-wiring
`,
    )
    const problems = checkCiWiring(fixture('wrong-job', wrongJob), SEED_REQUIREMENT)
    assert.equal(problems.length, 3) // All commands are outside the job's block.
    assert.match(problems[0], /ci_wiring_run_missing: .* job "publishable-versions" does not invoke `pnpm test:version-gate`/)
    assert.match(problems[1], /ci_wiring_run_missing: .* does not invoke `pnpm check:publishable-versions`/)
    assert.match(problems[2], /ci_wiring_run_missing: .* does not invoke `pnpm check:ci-wiring`/)
  })

  it('FAILS: the job is present but ONE command is missing', () => {
    const oneMissing = GOOD.replace('      - run: pnpm check:publishable-versions\n', '')
    const problems = checkCiWiring(fixture('one-missing', oneMissing), SEED_REQUIREMENT)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .* does not invoke `pnpm check:publishable-versions`/)
  })

  it('FAILS: the job name is DUPLICATED (never silently pick one)', () => {
    const duplicated = GOOD.replace(ARMED_JOB, `${ARMED_JOB}${ARMED_JOB}`)
    const problems = checkCiWiring(fixture('duplicate', duplicated), SEED_REQUIREMENT)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_duplicated: .* declares the "publishable-versions:" job 2 times/)
  })

  it('reports EVERY failing table entry, not just the first', () => {
    const problems = checkCiWiring(fixture('good-multi', GOOD), {
      ...SEED_REQUIREMENT,
      'template-gallery': { runs: ['pnpm check:template-gallery'] },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_job_missing: .* has no "template-gallery:" job/)
  })
})

/** A `template-smoke` job that pins the Supabase CLI, plus a neighbour that also mentions a version.
 *  Shared by the `lines` cases below and the `steps` OWNERSHIP cases after them.
 *  @param {string} smokeBody @param {string} [neighbourBody] */
const withSmoke = (smokeBody, neighbourBody = '      - run: pnpm lint\n') => `name: ci
on:
  push:
    branches: [main]

jobs:
  template-smoke:
    runs-on: ubuntu-latest
    steps:
${smokeBody}
  neighbour:
    runs-on: ubuntu-latest
    steps:
${neighbourBody}`

// `lines` is a JOB-scoped exact match against a NORMALIZED line, NOT a substring scan. That distinction
// is the entire point of round-10 F2: `template-smoke` carries the literal `2.109.1` TWICE (the real pin
// AND a `grep -qF '2.109.1'` drift check), so the round-9 `contains: ['2.109.1']` substring scan PASSED
// even with `version: latest` — satisfied purely by the grep argument. These four cases pin the
// exact-line semantics that make `lines` a real assertion; they exercise the MECHANISM with the pin
// strings as a convenient payload. (06e's REAL table pins the CLI through `steps`, not `lines`, because
// job-scoped existence is not OWNERSHIP — see the `steps` describe block below. `lines` keeps a real
// consumer: 06e's four-template matrix line, which sits under `strategy:` and belongs to no step.)
describe('checkCiWiring — `lines` is an EXACT normalized-line match inside the job BLOCK', () => {
  const TABLE = {
    'template-smoke': {
      runs: ["supabase --version | grep -qF '2.109.1'"],
      lines: ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
    },
  }

  it('PASSES when the exact pinned lines are in the block (normalizing whitespace + a trailing comment)', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: {  version:  2.109.1  }   # pin — matches integration-smoke
      - run: supabase --version | grep -qF '2.109.1'   # fail loud if the CLI drifts
`,
    )
    assert.deepEqual(checkCiWiring(fixture('lines-ok', yaml), TABLE), [])
  })

  // THE round-10 F2 REGRESSION TEST. Under the round-9 `contains: ['2.109.1']` this workflow PASSED: the
  // substring IS present — in the `grep -qF '2.109.1'` run line — so a job pinned to `latest` false-greened
  // (reproduced). The exact line `with: { version: 2.109.1 }` is absent, so `lines` FAILS it, correctly.
  it('FAILS when the pin says `version: latest` even though a run line still greps for 2.109.1', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    const problems = checkCiWiring(fixture('lines-latest', yaml), TABLE)
    assert.equal(problems.length, 1) // the `runs` grep entry still matches — ONLY the pin is missing
    assert.match(problems[0], /ci_wiring_line_missing: .* job "template-smoke" has no line `with: \{ version: 2\.109\.1 \}`/)
  })

  it('FAILS when the required line appears only in a COMMENT inside the job', () => {
    const yaml = withSmoke(
      `      # TODO — pin it: with: { version: 2.109.1 }
      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    const problems = checkCiWiring(fixture('lines-comment', yaml), TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_line_missing: .* has no line `with: \{ version: 2\.109\.1 \}`/)
  })

  it('FAILS when the required line appears only in a DIFFERENT job', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: supabase --version | grep -qF '2.109.1'
`,
      `      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
`, // the pin is on the NEIGHBOUR — a file-wide includes() would green here
    )
    const problems = checkCiWiring(fixture('lines-wrong-job', yaml), TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_line_missing: .* job "template-smoke" has no line `with: \{ version: 2\.109\.1 \}`/)
  })
})

// ROUND-11 F1. `lines` proves EXISTENCE; `steps` proves OWNERSHIP. `lines` is an unordered set match over
// the WHOLE job block, so it proves `uses: supabase/setup-cli@v2` and `with: { version: 2.109.1 }` each
// occur SOMEWHERE in `template-smoke` — NOT that the `with:` belongs to that action. A DECOY step can own
// the pinned line while Supabase itself runs on `latest`, and `lines` still greens (the second test below
// reproduces exactly that). `steps` requires every line of a group inside ONE step block.
describe('checkCiWiring — `steps` proves the pin is OWNED by the setup-cli step (round-11 F1)', () => {
  /** What 06e actually ships: the pin must live in the SAME step as the action. */
  const STEP_TABLE = {
    'template-smoke': {
      runs: [],
      steps: [['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }']],
    },
  }

  /** The round-10 shape, kept ONLY to prove it would have missed the decoy below. */
  const LINES_ONLY_TABLE = {
    'template-smoke': {
      runs: [],
      lines: ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
    },
  }

  /** setup-cli on `latest`; a DECOY action owns the pinned line. BOTH required lines exist in the job —
   *  which is precisely why a job-scoped set match is not enough. */
  const DECOY = withSmoke(
    `      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - uses: some/other-action@v1
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
  )

  it('FAILS the decoy: no SINGLE step owns both the action and the pin', () => {
    const problems = checkCiWiring(fixture('steps-decoy', DECOY), STEP_TABLE)
    assert.equal(problems.length, 1)
    assert.match(
      problems[0],
      /ci_wiring_step_missing: .* job "template-smoke" has no single step containing all of/,
    )
    assert.match(problems[0], /with: \{ version: 2\.109\.1 \}/) // the message NAMES the required lines
  })

  // THE REGRESSION PROOF. The round-10 `lines`-only requirement PASSES this same hostile fixture: both
  // literals are present in the block, just not in the same step. That gap — existence, not ownership —
  // is exactly what `steps` closes. If this test ever goes RED, `lines` has silently become step-scoped
  // and the two mechanisms have been conflated; fix the code, not the test.
  it('the round-10 `lines`-only requirement PASSES that same decoy — the gap `steps` closes', () => {
    assert.deepEqual(checkCiWiring(fixture('steps-decoy-lines', DECOY), LINES_ONLY_TABLE), [])
  })

  // WHY NOT ADJACENCY: a strict `uses:`-then-`with:` sequence catches the decoy too, but goes falsely RED
  // the moment anyone adds an `id:` or a `name:` to that step — and a gate that cries wolf gets disabled,
  // after which it protects nothing. Step-scoping tolerates ANY step property. This test PINS that
  // tolerance so nobody "upgrades" the checker to adjacency later.
  it('PASSES when the setup-cli step also carries `id:` and `name:` (why adjacency was rejected)', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        id: setup-supabase
        name: Pin the Supabase CLI
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
    )
    assert.deepEqual(checkCiWiring(fixture('steps-id-name', yaml), STEP_TABLE), [])
  })

  // A block-style matrix is an ordinary equivalent spelling of the flow-style matrix 06e currently
  // ships. It creates list items before `steps:` at a different indent; step extraction must anchor on
  // the `steps:` key rather than treating the first list item in the whole job as a step.
  it('PASSES when a block-style matrix list appears before `steps:`', () => {
    const yaml = withSmoke(
      `      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
      - run: supabase --version | grep -qF '2.109.1'
`,
    ).replace(
      '    runs-on: ubuntu-latest\n    steps:',
      `    runs-on: ubuntu-latest
    strategy:
      matrix:
        template:
          - crm-lite
          - support-desk
    steps:`,
    )
    assert.deepEqual(checkCiWiring(fixture('steps-block-matrix', yaml), STEP_TABLE), [])
  })
})

// ==============================================================================================
// THE ACCEPTANCE TEST (INTERFACES round-10 F1). The round-9 checker passed hand-made fixtures and would
// have REJECTED the real 06e workflow excerpt: its parser matched only `- run: <cmd>` (list-item form), but
// `template-smoke`'s gate step is a MULTI-KEY step whose `run:` is an indented PROPERTY. A checker that
// rejects the very workflow it exists to verify makes 06e's required gate permanently RED. Verified: the
// round-9 parser emits `ci_wiring_run_missing` for the gate.sh step against the YAML below.
//
// The 06e-owned jobs remain verbatim; later required jobs are appended so the fixture exercises the current table.
//
// GOTCHA when pasting into a JS template literal, TWO characters need a backslash and NOTHING else does:
//   1. `${` opens an interpolation — GitHub's `${{ … }}` MUST be written `\${{ … }}` (yields `${{ … }}`).
//   2. a backtick closes the literal — the ` ` ` inside 06e's comment lines MUST be written `\``.
// Both are escapes, not content changes: the STRING is byte-for-byte 06e's YAML. Nothing else is edited.
// Note the FULL_TABLE entries below are ordinary '' / "" strings, so there `${{ matrix.template }}` and
// the quoted `grep -qF '2.109.1'` are written UNescaped.
//
// Bonus coverage that falls out of pasting the real thing: 06e's comment block literally contains
// `# \`with: { version: 2.109.1 }\`` — a COMMENTED copy of a required `lines` entry. If comment-stripping
// ever regressed, THIS fixture would false-green. The real file is a better hostile fixture than a
// hand-made one; that is the round-10 lesson.
// ==============================================================================================
const REAL_CI = `name: ci
on:
  push:
    branches: [main]

jobs:
${ARMED_JOB}
  c6-productization:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/platform test
      - run: bash fixtures/platform-consumer/gate.sh
      - run: pnpm --filter @movp/cli test:built-runtime
      - run: bash fixtures/verdaccio-crm-lite/gate.sh

  c6-surface-wiring:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/domain exec vitest run --config vitest.unit.config.ts
      - run: pnpm --filter @movp/flows exec vitest run test/schema-injection.test.ts
      - run: pnpm --filter @movp/mcp exec vitest run test/surface-wiring.test.ts
      - run: pnpm --filter @movp/cli exec vitest run test/codegen-refusal.test.ts

  c7-editor-sdk:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @movp/editor-sdk test

  template-gallery:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # check-template-gallery.ts imports the untrusted-io guards from the BUILT create-movp dist —
      # build before running it (INTERFACES round-6 F2). The guards gate rebuilds it itself, harmlessly.
      - run: pnpm --filter create-movp build
      - run: pnpm exec tsx scripts/check-template-gallery.ts
      - run: bash scripts/check-template-gallery-guards.sh

  pack-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: bash fixtures/verdaccio-gallery/pack.sh ./artifacts
      - uses: actions/upload-artifact@v4
        with: { name: movp-tarballs, path: ./artifacts }

  template-smoke:
    needs: [pack-artifacts]
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        template: [crm-lite, marketing-site, support-desk, knowledge-base]
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      # pin — matches integration-smoke (ci.yml:130); INTERFACES round-3 F2.
      # Keep the comment on its OWN line: \`check-ci-wiring.mjs\` asserts the EXACT normalized line
      # \`with: { version: 2.109.1 }\` (round-10 F2), so a trailing comment here is needless friction.
      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
      # fail loud if the pinned CLI drifts at runtime
      - run: supabase --version | grep -qF '2.109.1'
      - uses: denoland/setup-deno@v2
        with: { deno-version: v2.9.2 }
      - run: deno --version | head -n 1 | grep -qF 'deno 2.9.2'
      - uses: actions/download-artifact@v5
        with: { name: movp-tarballs, path: ./artifacts }
      - run: pnpm install --frozen-lockfile
      - env:
          ARTIFACTS_DIR: \${{ github.workspace }}/artifacts
        run: bash fixtures/verdaccio-gallery/gate.sh \${{ matrix.template }}
`

/** Every currently registered job, plus explicit copies of the three 06e entries. */
const FULL_TABLE = {
  ...REQUIRED_JOBS,
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
      'bash fixtures/verdaccio-gallery/gate.sh ${{ matrix.template }}',   // multi-key `- env:` / `run:` step
    ],
    // The 4-way matrix sits under `strategy:`, NOT inside a step — so it stays a `lines` requirement.
    lines: ['template: [crm-lite, marketing-site, support-desk, knowledge-base]'],
    // OWNERSHIP: the pin must live in the SAME STEP as the setup-cli action (round-11 F1).
    steps: [
      ['uses: supabase/setup-cli@v2', 'with: { version: 2.109.1 }'],
      ['uses: denoland/setup-deno@v2', 'with: { deno-version: v2.9.2 }'],
      ['uses: actions/download-artifact@v5', 'with: { name: movp-tarballs, path: ./artifacts }'],
    ],
  },
}

describe('checkCiWiring — registered workflow excerpt (round-10 F1 acceptance)', () => {
  it('PASSES with ZERO problems against every registered job', () => {
    assert.deepEqual(checkCiWiring(fixture('real-ci', REAL_CI), FULL_TABLE), [])
  })

  // Proves the PASS above is not vacuous: the multi-key `- env:` / `run:` step is precisely the one the
  // round-9 parser could not see at all. Delete it and the gate must go RED.
  it('FAILS when the MULTI-KEY gate step is removed (the round-9 parser could not see it)', () => {
    const withoutGate = REAL_CI.replace(
      `      - env:
          ARTIFACTS_DIR: \${{ github.workspace }}/artifacts
        run: bash fixtures/verdaccio-gallery/gate.sh \${{ matrix.template }}
`,
      '',
    )
    const problems = checkCiWiring(fixture('real-no-gate', withoutGate), FULL_TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_run_missing: .* job "template-smoke" does not invoke `bash fixtures\/verdaccio-gallery\/gate\.sh \$\{\{ matrix\.template \}\}`/)
  })

  it('FAILS when template-smoke downgrades download-artifact from Node 24', () => {
    const downgraded = REAL_CI.replace('actions/download-artifact@v5', 'actions/download-artifact@v4')
    const problems = checkCiWiring(fixture('real-old-download-artifact', downgraded), FULL_TABLE)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ci_wiring_step_missing: .*actions\/download-artifact@v5/)
  })
})

describe('checkCiWiring — the workflow is read through the guard (INTERFACES round-9 F1)', () => {
  it('rejects a SYMLINKED workflow WITHOUT reading its target', () => {
    const secret = join(work, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.yml')
    symlinkSync(secret, path) // .github/workflows/ci.yml -> ~/.aws/credentials
    assert.throws(() => checkCiWiring(path), (err) => {
      assert.match(String(err), /workflow_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects an OVERSIZED workflow BEFORE buffering it', () => {
    const path = join(work, 'huge.yml')
    writeFileSync(path, `${GOOD}\n# ${'x'.repeat(MAX_WORKFLOW_BYTES)}`)
    assert.throws(() => checkCiWiring(path), /workflow_too_large/)
  })

  it('throws workflow_unreadable (not a raw ENOENT) for a missing workflow', () => {
    assert.throws(() => checkCiWiring(join(work, 'nope.yml')), (err) => {
      assert.match(String(err), /workflow_unreadable: .* cannot be inspected/)
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })
})
