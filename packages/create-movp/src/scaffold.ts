import { lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifyPlatformArtifact } from '@movp/platform'
import { copyFileGuarded, copyTemplate, resolveTargetDir } from './copier.ts'

export interface ScaffoldOptions {
  templateDir: string
  parentDir: string
  projectName: string
  workspaceId: string
  platformArtifactDir: string
}

// `async` is retained so a thrown `verifyPlatformArtifact` surfaces as a rejected promise for the
// unit test's `.rejects.toThrow`; there is no inline `await` (codegen is deferred to bootstrap, F2).
export async function scaffold(
  opts: ScaffoldOptions,
): Promise<{ targetDir: string; bootstrap: string[] }> {
  const targetDir = resolveTargetDir(opts.parentDir, opts.projectName)

  // 1. Copy the template + substitute the two declared tokens.
  copyTemplate({
    templateDir: opts.templateDir,
    targetDir,
    tokens: {
      __PROJECT_NAME__: opts.projectName,
      __WORKSPACE_ID__: opts.workspaceId,
    },
  })

  // 2. Materialize the immutable platform bundle AHEAD of any project migration. verify FIRST
  //    (throws platform_artifact_invalid on any tamper), then COPY the .sql files (never symlink).
  //    `platformArtifactDir` is the platform package's `dist/` (contains migrations/ + manifest.json),
  //    resolved by the CLI via import.meta.resolve('@movp/platform/package.json') — see Step 4 (F1).
  verifyPlatformArtifact(opts.platformArtifactDir)
  const migrationsDir = join(targetDir, 'supabase', 'migrations')
  mkdirSync(migrationsDir, { recursive: true })
  const srcMigrations = join(opts.platformArtifactDir, 'migrations')
  for (const name of readdirSync(srcMigrations).sort()) {
    if (!name.endsWith('.sql')) continue
    const abs = join(srcMigrations, name)
    // A symlinked migration is an ARTIFACT defect → the 06a code, not a copier code (the client
    // remedy is "re-install @movp/platform", not "fix your template"). lstat BEFORE any read.
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`platform_artifact_invalid: migration is a symlink: ${name}`)
    // Never a raw `copyFileSync` (INTERFACES F1b): copyFileGuarded re-lstats and, crucially, bounds
    // the size BEFORE buffering, so an oversized artifact cannot OOM the scaffolder.
    copyFileGuarded(abs, join(migrationsDir, name))
  }

  // 3. Codegen is NOT run here (INTERFACES F2). The scaffold's `@movp/*` deps + `tsx` do not exist
  //    until `npm install` runs, so the project baseline + movp.schema.json are emitted post-install
  //    by the scaffold's own `npm run codegen` (bin/codegen.mjs, Task 4). Bootstrap prints that step.
  const bootstrap = [
    `cd ${opts.projectName}`,
    'npm install',
    'npm run codegen',
    'supabase start',
    'supabase db reset',
    'npm run verify-schema-runtime',
    'supabase functions serve --env-file supabase/.env.local',
    'npm run dev',
  ]
  return { targetDir, bootstrap }
}
