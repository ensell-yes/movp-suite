import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffold } from '../src/scaffold.ts'

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'scaffold-')) })
afterEach(() => rmSync(work, { recursive: true, force: true }))

function fakePlatformArtifact(dir: string): void {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations, { recursive: true })
  const body = '-- platform baseline\n'
  writeFileSync(join(migrations, '20260701000001_init.sql'), body)
  const sha256 = createHash('sha256').update(Buffer.from(body)).digest('hex')
  // `metadata` is REQUIRED by the shipped verifier: a manifest without it throws
  // `platform_artifact_invalid: manifest.json metadata is missing or malformed`, and both counts must
  // be POSITIVE integers (packages/platform/src/verify.ts:66-76). Verified: omitting it fails test 1
  // for the wrong reason.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    platformVersion: '0.1.0',
    metadata: { collections: 1, fields: 2 },
    files: [{ name: '20260701000001_init.sql', sha256 }],
  }, null, 2))
}

function fakeTemplate(dir: string): void {
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# __PROJECT_NAME__ (ws __WORKSPACE_ID__)\n')
  writeFileSync(join(dir, 'movp.deltas.json'), JSON.stringify({ deltas: [] }, null, 2) + '\n')
  // movp.config.mjs is COPIED verbatim; the scaffolder never imports it (codegen is post-install, F2),
  // so this fixture only has to EXIST — its contents are inert. It is deliberately NOT a hand-built
  // `MovpSchema` object literal: a hand-built schema literal is not production-shaped, goes stale
  // whenever the real type gains a field (it just gained `projectEvents`/`platformEvents`), and is the
  // exact fixture pattern that hid the C6c event-catalog bug. Real schemas come from `defineSchema`.
  writeFileSync(join(dir, 'movp.config.mjs'),
    '// inert scaffold fixture — the scaffolder never imports this file (codegen is post-install, F2).\n')
}

describe('scaffold', () => {
  it('copies the template + materializes the platform bundle, and DEFERS codegen to bootstrap (install → codegen)', async () => {
    const templateDir = join(work, 'template')
    const platformDir = join(work, 'platform')
    fakeTemplate(templateDir)
    fakePlatformArtifact(platformDir)

    const res = await scaffold({
      templateDir,
      parentDir: work,
      projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      platformArtifactDir: platformDir,
    })

    expect(res.targetDir).toBe(join(work, 'acme-crm'))
    // token substitution happened
    expect(readFileSync(join(res.targetDir, 'README.md'), 'utf8')).toContain('# acme-crm (ws 33333333')
    // platform migration materialized into the scaffold, ahead of any project migration
    expect(readFileSync(join(res.targetDir, 'supabase', 'migrations', '20260701000001_init.sql'), 'utf8'))
      .toBe('-- platform baseline\n')
    // F2: codegen did NOT run inline — no manifest and no project baseline migration were emitted.
    expect(existsSync(join(res.targetDir, 'movp.schema.json'))).toBe(false)
    expect(existsSync(join(res.targetDir, 'supabase', 'migrations', '20260715000000_movp_generated.sql'))).toBe(false)
    // bootstrap sequences install BEFORE codegen (the contract Task 6's gate follows).
    const install = res.bootstrap.indexOf('npm install')
    const codegen = res.bootstrap.indexOf('npm run codegen')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(codegen).toBeGreaterThan(install)
  })

  it('refuses a tampered platform artifact (digest mismatch → platform_artifact_invalid)', async () => {
    const templateDir = join(work, 'template')
    const platformDir = join(work, 'platform')
    fakeTemplate(templateDir)
    fakePlatformArtifact(platformDir)
    writeFileSync(join(platformDir, 'migrations', '20260701000001_init.sql'), '-- tampered\n')
    await expect(scaffold({
      templateDir, parentDir: work, projectName: 'acme-crm',
      workspaceId: '33333333-3333-3333-3333-333333333333', platformArtifactDir: platformDir,
    })).rejects.toThrow(/platform_artifact_invalid/)
  })
})
