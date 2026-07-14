#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaffold } from './scaffold.ts'

const TEMPLATES = ['crm-lite'] as const
type TemplateName = (typeof TEMPLATES)[number]

function bundledTemplateDir(name: TemplateName): string {
  // Templates ship INSIDE the create-movp tarball (package.json "files": ["dist","templates"]).
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'templates', name)
}

function bundledPlatformDir(): string {
  // @movp/platform is a runtime dependency of create-movp. Resolve it via the package.json export
  // (INTERFACES F1: `exports` includes "./package.json"; NEVER "./src/*"), then derive the artifact
  // dir dist/ (which holds migrations/ + manifest.json — see @movp/platform publishConfig). Use
  // import.meta.resolve, not createRequire — the bin is native ESM.
  const pkgJsonPath = fileURLToPath(import.meta.resolve('@movp/platform/package.json'))
  return join(dirname(pkgJsonPath), 'dist')
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const template = (await rl.question(`Template (${TEMPLATES.join(', ')}) [crm-lite]: `)).trim() || 'crm-lite'
    if (!TEMPLATES.includes(template as TemplateName)) throw new Error(`unknown template: ${template}`)
    const projectName = (await rl.question('Project name: ')).trim()
    const workspaceId =
      (await rl.question('Workspace UUID [33333333-3333-3333-3333-333333333333]: ')).trim() ||
      '33333333-3333-3333-3333-333333333333'

    const { targetDir, bootstrap } = await scaffold({
      templateDir: bundledTemplateDir(template as TemplateName),
      parentDir: process.cwd(),
      projectName,
      workspaceId,
      platformArtifactDir: bundledPlatformDir(),
    })
    console.log(`\nScaffolded ${projectName} at ${targetDir}\n\nNext steps:`)
    for (const step of bootstrap) console.log(`  ${step}`)
  } finally {
    rl.close()
  }
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
