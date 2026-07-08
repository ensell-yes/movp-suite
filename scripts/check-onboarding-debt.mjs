import { existsSync, readFileSync } from 'node:fs'

const failures = []

const planReadme = readFileSync('docs/superpowers/plans/README.md', 'utf8')
for (const stale of ['uncommitted', 'held for review']) {
  if (planReadme.toLowerCase().includes(stale)) failures.push(`Stage B plan README still says "${stale}"`)
}

const campaignA = readFileSync('docs/superpowers/plans/2026-07-01-movp-app-03a-campaigns-data.md', 'utf8')
if (campaignA.includes('grep -c recipient_user_id')) {
  failures.push('03a plan still documents a recipient_user_id grep that can match comments')
}

const campaignB = readFileSync('docs/superpowers/plans/2026-07-01-movp-app-03b-campaigns-bridge-scans.md', 'utf8')
if (/^grep -c ['"]traverse_edges['"]/m.test(campaignB)) {
  failures.push('03b plan still greps traverse_edges without stripping comments')
}

if (!existsSync('docs/retention.md')) {
  failures.push('retention scheduling docs missing: docs/retention.md')
} else {
  const retention = readFileSync('docs/retention.md', 'utf8')
  for (const required of ['prune_internal_retention', 'pg_cron', 'Supabase Vault']) {
    if (!retention.includes(required)) failures.push(`retention docs missing ${required}`)
  }
}

if (failures.length > 0) {
  console.error(`onboarding debt check failed:\n${failures.join('\n')}`)
  process.exit(1)
}
