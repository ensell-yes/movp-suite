#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_AUDIT_BYTES = 2_000_000
const ALLOWED_ADVISORY = Object.freeze({
  id: 'GHSA-ch52-4w7c-c8xp',
  module: 'http-cache-semantics',
  severity: 'high',
  patchedVersions: '<0.0.0',
  path: '. > verdaccio@6.8.0 > @verdaccio/hooks@8.0.4 > got-cjs@12.5.4 > cacheable-request@7.0.2 > http-cache-semantics@4.2.0',
})

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAllowedAdvisory(advisory) {
  if (!isRecord(advisory)) return false
  if (advisory.github_advisory_id !== ALLOWED_ADVISORY.id) return false
  if (advisory.module_name !== ALLOWED_ADVISORY.module) return false
  if (advisory.severity !== ALLOWED_ADVISORY.severity) return false
  if (advisory.patched_versions !== ALLOWED_ADVISORY.patchedVersions) return false
  if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) return false
  return advisory.findings.every((finding) => (
    isRecord(finding)
    && Array.isArray(finding.paths)
    && finding.paths.length > 0
    && finding.paths.every((path) => path === ALLOWED_ADVISORY.path)
  ))
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
  console.log(`dependency audit: passed (${count} known upstream-unfixable advisory${count === 1 ? '' : 'ies'} allowlisted)`)
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
