#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaffold } from './scaffold.ts'
import {
  DEFAULT_WORKSPACE_ID,
  MAX_CREATE_INPUT_BYTES,
  parseCreateCliArgs,
  parseCreateInput,
  TEMPLATES,
  type TemplateName,
  validateWorkspaceId,
} from './cli-args.ts'

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

async function readPipedInput(): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_CREATE_INPUT_BYTES) {
      throw new Error(`create_input_too_large: max ${MAX_CREATE_INPUT_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const parsed = parseCreateCliArgs(process.argv.slice(2))
  let template: TemplateName = parsed.template
  let projectName = parsed.projectName
  let workspaceId = parsed.workspaceId

  if (projectName === undefined) {
    if (!process.stdin.isTTY) {
      const piped = parseCreateInput(await readPipedInput())
      template = piped.template
      projectName = piped.projectName
      workspaceId = piped.workspaceId
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = (await rl.question(`Template (${TEMPLATES.join(', ')}) [crm-lite]: `)).trim()
        if (answer !== '' && !TEMPLATES.includes(answer as TemplateName)) {
          throw new Error(`unknown_template: ${answer}`)
        }
        template = answer === '' ? 'crm-lite' : answer as TemplateName
        projectName = (await rl.question('Project name: ')).trim()
        workspaceId =
          (await rl.question(`Workspace UUID [${DEFAULT_WORKSPACE_ID}]: `)).trim() ||
          DEFAULT_WORKSPACE_ID
      } finally {
        rl.close()
      }
    }
  }
  if (projectName === undefined) throw new Error('missing_project_name')
  workspaceId = validateWorkspaceId(workspaceId)

  const { targetDir, bootstrap } = await scaffold({
    templateDir: bundledTemplateDir(template),
    parentDir: process.cwd(),
    projectName,
    workspaceId,
    platformArtifactDir: bundledPlatformDir(),
  })
  console.log(`\nScaffolded ${projectName} at ${targetDir}\n\nNext steps:`)
  for (const step of bootstrap) console.log(`  ${step}`)
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
