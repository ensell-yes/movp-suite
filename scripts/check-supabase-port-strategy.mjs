import { readFileSync } from 'node:fs'

const configPath = process.argv[2] ?? 'supabase/config.toml'
const text = readFileSync(configPath, 'utf8')

const expected = new Map([
  ['api.port', '64321'],
  ['db.port', '64322'],
  ['db.shadow_port', '64320'],
  ['studio.port', '64323'],
  ['local_smtp.port', '64324'],
  ['analytics.port', '64327'],
  ['db.pooler.port', '64329'],
])

function sectionValue(section, key) {
  const sectionPattern = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?:\\n\\[|$)`)
  const sectionMatch = text.match(sectionPattern)
  const body = sectionMatch?.[1] ?? ''
  return body.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'))?.[1]
}

const actual = new Map([
  ['api.port', sectionValue('api', 'port')],
  ['db.port', sectionValue('db', 'port')],
  ['db.shadow_port', sectionValue('db', 'shadow_port')],
  ['studio.port', sectionValue('studio', 'port')],
  ['local_smtp.port', sectionValue('local_smtp', 'port')],
  ['analytics.port', sectionValue('analytics', 'port')],
  ['db.pooler.port', sectionValue('db.pooler', 'port')],
])

const mismatches = [...expected].filter(([key, value]) => actual.get(key) !== value)
if (mismatches.length > 0) {
  console.error(`supabase port strategy changed without proven override: ${mismatches.map(([k]) => k).join(', ')}`)
  process.exit(1)
}
