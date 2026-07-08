import { execFileSync } from 'node:child_process'

function readSupabaseEnv() {
  try {
    const out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const cleanValue = (value) => value.replace(/^"|"$/g, '')
    return Object.fromEntries(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('='))
        .map((line) => {
          const eq = line.indexOf('=')
          return [line.slice(0, eq), cleanValue(line.slice(eq + 1))]
        }),
    )
  } catch {
    return {}
  }
}

const statusEnv = readSupabaseEnv()
const dbUrl = process.env.DB_URL ?? statusEnv.DB_URL
if (!dbUrl) {
  console.error('demo seed check failed: missing DB_URL')
  process.exit(1)
}

function scalar(sql) {
  return execFileSync('psql', [dbUrl, '-tAc', sql], { encoding: 'utf8' }).trim()
}

const checks = new Map([
  ['workspace', "select count(*) from public.workspace where id = '33333333-3333-3333-3333-333333333333' and name = 'MOVP Demo'"],
  ['memberships', "select count(*) from public.workspace_membership where workspace_id = '33333333-3333-3333-3333-333333333333'"],
  ['note', "select count(*) from public.note where id = '10000000-0000-0000-0000-000000000001'"],
  ['task', "select count(*) from public.task where id = '20000000-0000-0000-0000-000000000001'"],
  ['content', "select count(*) from public.content_item where id = '30000000-0000-0000-0000-000000000002' and current_revision_id = '30000000-0000-0000-0000-000000000003'"],
  ['campaign', "select count(*) from public.campaign where id = '40000000-0000-0000-0000-000000000002'"],
  ['segment', "select count(*) from public.segment where id = '50000000-0000-0000-0000-000000000001'"],
  ['automation_rule', "select count(*) from public.automation_rule where id = '70000000-0000-0000-0000-000000000001'"],
  ['webhook_subscription', "select count(*) from public.webhook_subscription where id = '60000000-0000-0000-0000-000000000002' and active = false"],
  ['workflow_event', "select count(*) from movp_internal.movp_events where trace_id = 'demo-seed'"],
  ['workflow_run', "select count(*) from public.workflow_run where id = '70000000-0000-0000-0000-000000000002'"],
])

const failures = []
for (const [name, sql] of checks) {
  const value = scalar(sql)
  const expected = name === 'memberships' ? '2' : '1'
  if (value !== expected) failures.push(`${name}: expected ${expected}, got ${value || '<empty>'}`)
}

if (failures.length > 0) {
  console.error(`demo seed check failed:\n${failures.join('\n')}`)
  process.exit(1)
}

console.log('demo seed check ok')
