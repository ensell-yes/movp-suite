import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schema } from '@movp/core-schema'
import { buildProgram } from '../src/index.ts'

// Mocked so the PLATFORM generator can never run for real: `generate({ schema })` resolves its root
// from the codegen module's own location (`defaultRoot()`), NOT from cwd — an unmocked call would
// write into the real monorepo. `generate` not being called is also the point of test 1.
const generate = vi.fn(async () => ({ migrationPath: '', typesPath: '', deltaPaths: [] }))
vi.mock('@movp/codegen', () => ({ generate }))

const BASELINE = '20260715000000_movp_generated.sql'
const BASELINE_SQL = '-- project baseline: contact/company/deal\ncreate table public.contact ();\n'

let work = ''
let cwd = ''

beforeEach(() => {
  cwd = process.cwd()
  work = mkdtempSync(join(tmpdir(), 'movp-codegen-refusal-'))
  generate.mockClear()
})
afterEach(() => {
  process.chdir(cwd)
  rmSync(work, { recursive: true, force: true })
})

describe('movp codegen inside a scaffolded project', () => {
  it('refuses with project_codegen_use_project_bin and leaves the project baseline byte-unchanged', async () => {
    const migrations = join(work, 'supabase', 'migrations')
    mkdirSync(migrations, { recursive: true })
    writeFileSync(join(work, 'movp.deltas.json'), JSON.stringify({ deltas: [] }) + '\n')
    writeFileSync(join(migrations, BASELINE), BASELINE_SQL)
    process.chdir(work)

    const cmd = buildProgram(schema) // NO opts — the production wiring the scaffold's bin/movp.mjs uses
    await expect(cmd.parseAsync(['node', 'movp', 'codegen'])).rejects.toThrow(
      /project_codegen_use_project_bin/,
    )
    // The data-loss regression assertion: the project's generated baseline is byte-for-byte intact.
    expect(readFileSync(join(migrations, BASELINE), 'utf8')).toBe(BASELINE_SQL)
    // …and PLATFORM codegen was never reached, so no rm loop ran anywhere.
    expect(generate).not.toHaveBeenCalled()
  })

  it('still runs PLATFORM codegen when there is no movp.deltas.json (no regression)', async () => {
    process.chdir(work)
    const cmd = buildProgram(schema)
    await cmd.parseAsync(['node', 'movp', 'codegen'])
    expect(generate).toHaveBeenCalledWith({ schema })
  })
})
