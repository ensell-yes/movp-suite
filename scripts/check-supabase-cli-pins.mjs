#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_VERSION = '2.109.1'
const MAX_WORKFLOW_BYTES = 512 * 1024

function indentation(line) {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function workflowSteps(source) {
  const lines = source.split(/\r?\n/)
  const steps = []

  for (let index = 0; index < lines.length; index++) {
    const stepsMatch = lines[index].match(/^(\s*)steps:\s*$/)
    if (!stepsMatch) continue

    const blockIndent = stepsMatch[1].length
    const stepIndent = blockIndent + 2
    const starts = []
    let end = index + 1
    for (; end < lines.length; end++) {
      const line = lines[end]
      if (line.trim() && !line.trimStart().startsWith('#') && indentation(line) <= blockIndent) break
      if (indentation(line) === stepIndent && line.slice(stepIndent).startsWith('- ')) starts.push(end)
    }

    for (let offset = 0; offset < starts.length; offset++) {
      const start = starts[offset]
      const stop = starts[offset + 1] ?? end
      const normalized = lines.slice(start, stop)
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line, lineIndex) => {
          const trimmed = line.trim()
          return lineIndex === 0 ? trimmed.replace(/^-\s*/, '') : trimmed
        })
      steps.push({ line: start + 1, lines: normalized })
    }
    index = end - 1
  }

  return steps
}

function inlineVersion(line) {
  const match = line.match(/^with:\s*\{\s*version:\s*(?:"([^"]+)"|'([^']+)'|([^\s,}]+))\s*\}\s*$/)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

export function checkSupabaseCliPins(source) {
  const setupSteps = workflowSteps(source).filter((step) =>
    step.lines.some((line) => /^uses:\s*supabase\/setup-cli@\S+$/.test(line)),
  )
  if (setupSteps.length === 0) return ['supabase_cli_step_missing']

  return setupSteps
    .filter((step) => !step.lines.some((line) => inlineVersion(line) === EXPECTED_VERSION))
    .map((step) => `supabase_cli_pin_missing: line ${step.line} must pin version ${EXPECTED_VERSION}`)
}

function readWorkflowGuarded(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_WORKFLOW_BYTES) {
    throw new Error(`supabase_cli_workflow_invalid: ${path}`)
  }
  return readFileSync(path, 'utf8')
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workflowPath = resolve(root, '.github', 'workflows', 'ci.yml')
  let source
  try {
    source = readWorkflowGuarded(workflowPath)
  } catch {
    console.error(`supabase_cli_workflow_unreadable: ${workflowPath}`)
    process.exit(1)
  }

  const problems = checkSupabaseCliPins(source)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log('supabase-cli pins: ok')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
