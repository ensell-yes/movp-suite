#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_AUDIT_BYTES = 2_000_000

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAllowedAdvisory() {
  return false
}

export function unexpectedAdvisories(report) {
  if (!isRecord(report) || !isRecord(report.advisories)) throw new Error('audit_report_shape_invalid')
  const advisories = Object.values(report.advisories)
  if (!advisories.every(isRecord)) throw new Error('audit_advisory_shape_invalid')
  return advisories.filter((advisory) => !isAllowedAdvisory(advisory))
}

export function runAuditGate() {
  const result = spawnSync('pnpm', ['audit', '--audit-level', 'high', '--json'], {
    encoding: 'utf8',
    maxBuffer: MAX_AUDIT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`audit_command_failed:${result.error.message}`)
  if (result.status !== 0 && result.status !== 1) throw new Error(`audit_command_failed:exit=${result.status ?? 'signal'}`)

  let report
  try {
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_AUDIT_BYTES) throw new Error('audit_report_too_large')
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`audit_report_invalid:${error instanceof Error ? error.message : String(error)}`)
  }

  const unexpected = unexpectedAdvisories(report)
  if (unexpected.length > 0) {
    for (const advisory of unexpected) {
      const moduleName = typeof advisory.module_name === 'string' ? advisory.module_name : 'unknown-module'
      const severity = typeof advisory.severity === 'string' ? advisory.severity : 'unknown-severity'
      const id = typeof advisory.github_advisory_id === 'string' ? advisory.github_advisory_id : 'unknown-advisory'
      console.error(`dependency audit: ${severity} ${moduleName} (${id})`)
    }
    return 1
  }

  const count = isRecord(report.advisories) ? Object.keys(report.advisories).length : 0
  console.log(`dependency audit: passed (${count} advisories)`)
  return 0
}

const entryPoint = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entryPoint) {
  try {
    process.exitCode = runAuditGate()
  } catch (error) {
    console.error(`dependency audit: operational failure (${error instanceof Error ? error.message : String(error)})`)
    process.exitCode = 2
  }
}
